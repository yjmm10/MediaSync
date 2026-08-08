/**
 * 网易号适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：navinfo.do 鉴权 + picupload 图床 + 弱编辑器兼容（代码块/标题降级）+
 * publishV2.do saveDraft 草稿全部保留。
 * checkAuth 重写（保留 withHeaderRules + checkAuthInner 原逻辑）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Netease')

const NETEASE_CODE_BLOCK_STYLE =
  'margin:8px 0;padding:12px;background:#f6f8fa;border-radius:4px;' +
  'font-family:Menlo,Monaco,Consolas,monospace;font-size:13px;line-height:1.6;word-break:break-all;'

interface NeteaseAccount {
  wemediaId: string
  tname: string
  icon: string
  realUserId?: string
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTagsToText(html: string): string {
  const withoutTags = html.replace(/<[^>]+>/g, '')
  return decodeBasicEntities(withoutTags)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * 网易号编辑器特殊行为：
 * - 会把 h1-h6 抽到文首拼成目录 → 就地降级为加粗段落
 * - 不支持 pre/code → 代码块用 <br> 保留换行；行内 code 改为加粗
 */
function prepareHtmlForNetease(html: string): string {
  let result = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const text = stripTagsToText(inner).replace(/^\n+/, '').replace(/\n+$/, '')
    if (!text.trim()) {
      return ''
    }
    const lines = text.split('\n').map((line) => escapeHtmlText(line))
    return `<p style="${NETEASE_CODE_BLOCK_STYLE}">${lines.join('<br>')}</p>`
  })

  result = result.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => {
    const text = stripTagsToText(inner)
    if (!text) {
      return ''
    }
    return `<strong>${escapeHtmlText(text)}</strong>`
  })

  result = result.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, _level, inner: string) => {
    const text = stripTagsToText(inner).trim()
    if (!text) {
      return ''
    }
    return `<p><strong>${escapeHtmlText(text)}</strong></p>`
  })

  return result
}

export class NeteaseAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'netease',
    name: '网易号',
    icon: 'https://mp.163.com/favicon.ico',
    homepage: 'https://mp.163.com/subscribe_v4/index.html#/article-publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    convertTablesToText: true,
  }

  private account: NeteaseAccount | null = null

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.163.com/*',
      headers: {
        Origin: 'https://mp.163.com',
        Referer: 'https://mp.163.com/subscribe_v4/index.html',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留 withHeaderRules + checkAuthInner 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const ok = await this.checkAuthInner()
        if (!ok || !this.account) {
          return {
            isAuthenticated: false,
            error:
              '未登录网易号，请先在浏览器打开并登录 https://mp.163.com/subscribe_v4/index.html#/article-publish',
          }
        }
        return {
          isAuthenticated: true,
          userId: this.account.wemediaId,
          username: this.account.tname || this.account.wemediaId,
          avatar: this.account.icon,
        }
      })
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 account 已获取 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.account) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录网易号')
      }
    }
  }

  /** 2. 内容规整：弱编辑器兼容（标题降级、代码块转 br 段落） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    ctx.content.html = prepareHtmlForNetease(ctx.content.html || '')
  }

  /** 3. 上传图片：在 Header 规则保护下走 SharedImageCache 去重上传 */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      const opts: ImageProcessOptions = {
        skipPatterns: ['163.com', '126.net'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
  }

  /** 5. 构建草稿所需 title + content */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      title: ctx.article.title,
      content: ctx.content.html,
    }
  }

  /** 6. 提交：publishV2.do saveDraft */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    if (!this.account) {
      throw new Error('未登录')
    }
    const payload = ctx.payload as { title: string; content: string }
    const draft = await this.saveDraft(
      this.account.wemediaId,
      payload.title,
      payload.content,
      this.account.realUserId,
    )
    const postId = draft.docId
    return this.createResult(true, {
      postId,
      postUrl: `https://mp.163.com/subscribe_v4/index.html#/article-publish/${postId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 鉴权 / 草稿 / 图片上传（保持原样）============

  /** 在已有 header rules 上下文中刷新账号信息，避免嵌套 withHeaderRules */
  private async checkAuthInner(): Promise<boolean> {
    const res = await this.get<{
      code: number
      data?: {
        wemediaId?: string
        tname?: string
        icon?: string
        realUserId?: string
        email?: string
        passport?: string
        userName?: string
      }
    }>(`https://mp.163.com/wemedia/navinfo.do?_=${Date.now()}`)

    if (res.code !== 1 || !res.data?.wemediaId) {
      return false
    }

    this.account = {
      wemediaId: String(res.data.wemediaId),
      tname: res.data.tname || '',
      icon: res.data.icon || '',
      realUserId:
        res.data.realUserId ||
        res.data.email ||
        res.data.passport ||
        res.data.userName ||
        undefined,
    }
    return true
  }

  private async saveDraft(
    wemediaId: string,
    title: string,
    content: string,
    realUserId?: string
  ): Promise<{ docId: string }> {
    const qs = new URLSearchParams()
    qs.set('_', String(Date.now()))
    qs.set('wemediaId', wemediaId)
    if (realUserId) {
      qs.set('realUserId', realUserId)
    }

    const body = new URLSearchParams()
    body.set('wemediaId', wemediaId)
    body.set('articleId', '-1')
    body.set('title', title)
    body.set('content', content)
    body.set('cover', 'auto')
    body.set('picUrl', '')
    body.set('operation', 'saveDraft')
    body.set('scheduled', '0')
    body.set('original', '0')

    const response = await this.runtime.fetch(
      `https://mp.163.com/wemedia/article/status/api/publishV2.do?${qs.toString()}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      }
    )

    const text = await response.text()
    if (!text.trim()) {
      throw new Error(`网易号草稿空响应 HTTP ${response.status}`)
    }

    let res: {
      code?: number
      msg?: string
      message?: string
      data?: string | Record<string, unknown>
    }
    try {
      res = JSON.parse(text)
    } catch {
      throw new Error('网易号草稿响应非 JSON: ' + text.slice(0, 160))
    }

    logger.debug('publishV2 saveDraft response:', res)

    let docId = ''
    if (typeof res.data === 'string') {
      const q = res.data.startsWith('?') ? res.data : `?${res.data}`
      docId = new URLSearchParams(q).get('docId') || ''
    } else if (res.data && typeof res.data === 'object') {
      docId = String(res.data.docId || res.data.articleId || res.data.id || '')
    }

    if (res.code !== 1 && res.code !== 200 && !docId) {
      throw new Error(
        res.msg || res.message || '网易号草稿保存失败: ' + JSON.stringify(res).slice(0, 200)
      )
    }
    if (!docId) {
      throw new Error('网易号草稿未返回 docId')
    }

    return { docId }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.account) {
      const ok = await this.checkAuthInner()
      if (!ok) throw new Error('未登录')
    }

    const imageResponse = await this.runtime.fetch(src, { credentials: 'include' })
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const uploadUrl =
      `https://mp.163.com/api/v3/upload/picupload` +
      `?_=${Date.now()}&wemediaId=${this.account!.wemediaId}`

    const formData = new FormData()
    formData.append('file', imageBlob, 'temp')
    formData.append('from', 'neteasecode_mp')

    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      code?: number
      data?: { url?: string }
    }

    let url = res.data?.url || ''
    if (url.startsWith('http://')) {
      url = 'https://' + url.slice('http://'.length)
    }
    if (res.code !== 200 || !url) {
      throw new Error('图片上传失败')
    }

    return { url }
  }
}
