/**
 * 阿里云开发者社区适配器
 * https://developer.aliyun.com/article/new#/
 *
 * 仅保存草稿；正文为 Markdown（Mermaid 保留为普通 fenced 代码块，平台不渲染图）。
 * 摘要不传：由用户在社区草稿箱手工补全。
 * 图片：getImageUploadUrl → OSS PUT → ucc.alicdn.com；整条链路失败则剥离图片回退纯文字。
 * 登录：优先 SW GET /developer/api/my/user/getUser，失败再页面上下文。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('AliyunDeveloper')

const BASE = 'https://developer.aliyun.com'
const WRITE_URL = `${BASE}/article/new#/`
const PAGE_URL_PATTERN = '*://developer.aliyun.com/*'
const COOKIE_DOMAINS = ['developer.aliyun.com', 'aliyun.com']
const SKIP_IMAGE_HOSTS = ['ucc.alicdn.com', 'developer.aliyun.com']

interface AliyunApiResponse<T = unknown> {
  success?: boolean
  code?: string
  message?: string | null
  data?: T
}

interface AliyunUserData {
  aliyunPK?: string
  uccId?: string
  nickname?: string
  avatar?: string
}

interface ImageUploadUrlData {
  uploadUrl?: string
  imageUrl?: string
  header?: Record<string, string>
}

interface PutDraftData {
  aid?: number | string
}

export interface AliyunPutDraftBody {
  title: string
  content: string
}

/** 从 getUser 响应解析登录态 */
export function authFromGetUser(
  payload: AliyunApiResponse<AliyunUserData> | null | undefined
): AuthResult | null {
  if (!payload?.success || !payload.data) return null
  const userId = payload.data.aliyunPK || payload.data.uccId
  if (!userId && !payload.data.nickname) return null
  return {
    isAuthenticated: true,
    userId: userId || undefined,
    username: payload.data.nickname || userId || '',
    avatar: payload.data.avatar || undefined,
  }
}

/**
 * 构建 putDraft 请求体。
 * 仅 title + content；不传 abstractContent / productTags（空 productTags 会 40000）。
 */
export function buildPutDraftBody(title: string, content: string): AliyunPutDraftBody {
  return { title, content }
}

/** 剥离 Markdown / HTML 图片，供图片链路整体失败时回退纯文字 */
export function stripMarkdownImages(markdown: string): string {
  return (markdown || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
}

export class AliyunDeveloperAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'aliyun-developer',
    name: '阿里云开发者社区',
    icon: 'https://img.alicdn.com/tfs/TB1_ZXuNcfpK1RjSZFOXXa6nFXa-32-32.ico',
    homepage: WRITE_URL,
    capabilities: ['article', 'draft'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://developer.aliyun.com/*',
      headers: {
        Origin: BASE,
        Referer: `${BASE}/`,
      },
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
    {
      urlFilter: '*://*.aliyuncs.com/*',
      headers: {
        Origin: BASE,
        Referer: `${BASE}/article/new`,
      },
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
  ]

  private async collectCookieHeader(): Promise<string> {
    const map = new Map<string, string>()
    for (const domain of COOKIE_DOMAINS) {
      try {
        const cookies = await this.runtime.cookies.get(domain)
        for (const c of cookies) {
          if (c.name) map.set(c.name, c.value)
        }
      } catch (error) {
        logger.debug('collectCookie failed for', domain, error)
      }
    }
    return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private hasLoginCookies(cookieHeader: string): boolean {
    return (
      cookieHeader.includes('login_aliyunid=') ||
      cookieHeader.includes('c_csrf=') ||
      cookieHeader.includes('login_aliyunid_pk=')
    )
  }

  private async getCsrf(): Promise<string> {
    for (const domain of COOKIE_DOMAINS) {
      try {
        if (this.runtime.getCookie) {
          const v = await this.runtime.getCookie(domain, 'c_csrf')
          if (v) return v
        }
        const list = await this.runtime.cookies.get(domain)
        const hit = list.find((c) => c.name === 'c_csrf')
        if (hit?.value) return hit.value
      } catch (error) {
        logger.debug('getCsrf failed for', domain, error)
      }
    }
    throw new Error(
      '未找到 c_csrf，请打开并刷新 https://developer.aliyun.com/article/new 后重试'
    )
  }

  private async withAliyunSession<T>(fn: () => Promise<T>): Promise<T> {
    const cookieHeader = await this.collectCookieHeader()
    const apiHeaders: Record<string, string> = {
      Origin: BASE,
      Referer: `${BASE}/`,
    }
    if (cookieHeader) {
      apiHeaders.Cookie = cookieHeader
    }
    const rules = [
      {
        urlFilter: '*://developer.aliyun.com/*',
        headers: apiHeaders,
        resourceTypes: ['xmlhttprequest', 'other'] as string[],
      },
      ...this.HEADER_RULES.filter((r) => !r.urlFilter.includes('developer.aliyun.com')),
    ]
    return this.withHeaderRules(rules, fn)
  }

  private csrfHeaders(csrf: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      h_csrf: csrf,
      'X-XSRF-TOKEN': csrf,
    }
  }

  private async detectAuthViaSw(): Promise<AuthResult | null> {
    return this.withAliyunSession(async () => {
      const response = await this.runtime.fetch(`${BASE}/developer/api/my/user/getUser`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const text = await response.text()
      let data: AliyunApiResponse<AliyunUserData>
      try {
        data = JSON.parse(text) as AliyunApiResponse<AliyunUserData>
      } catch {
        logger.debug('SW getUser non-JSON:', text.substring(0, 120))
        return null
      }
      return authFromGetUser(data)
    })
  }

  private async detectAuthViaPage(): Promise<AuthResult | null> {
    if (!this.runtime.tabs) return null
    const data = await this.pageFetchJson<AliyunApiResponse<AliyunUserData>>(
      PAGE_URL_PATTERN,
      WRITE_URL,
      `${BASE}/developer/api/my/user/getUser`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }
    )
    return authFromGetUser(data)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      try {
        const fromSw = await this.detectAuthViaSw()
        if (fromSw) return fromSw
        logger.debug('SW getUser did not recognize login')
      } catch (error) {
        logger.debug('SW login probe failed:', error)
      }

      try {
        const fromPage = await this.detectAuthViaPage()
        if (fromPage) return fromPage
      } catch (error) {
        logger.debug('page getUser login probe failed:', error)
      }

      const cookieHeader = await this.collectCookieHeader().catch(() => '')
      if (this.hasLoginCookies(cookieHeader)) {
        return {
          isAuthenticated: false,
          error:
            '会话 Cookie 存在但社区未识别，请打开并刷新 https://developer.aliyun.com/article/new 后重试',
        }
      }
      return {
        isAuthenticated: false,
        error: '未登录阿里云开发者社区，请先打开并登录 https://developer.aliyun.com/article/new',
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  private async putDraftViaSw(body: AliyunPutDraftBody): Promise<number | string> {
    return this.withAliyunSession(async () => {
      const csrf = await this.getCsrf()
      const url = `${BASE}/developer/api/articleDraft/putDraft?p_csrf=${encodeURIComponent(csrf)}`
      const response = await this.runtime.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: this.csrfHeaders(csrf),
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let data: AliyunApiResponse<PutDraftData>
      try {
        data = JSON.parse(text) as AliyunApiResponse<PutDraftData>
      } catch {
        throw new Error(`存草稿响应非 JSON: ${text.slice(0, 120)}`)
      }
      if (!data.success || data.data?.aid == null) {
        throw new Error(data.message || `存草稿失败 code=${data.code}`)
      }
      return data.data.aid
    })
  }

  private async putDraftViaPage(body: AliyunPutDraftBody): Promise<number | string> {
    if (!this.runtime.tabs) {
      throw new Error('当前运行时不支持页面回退')
    }
    const csrf = await this.getCsrf()
    const url = `${BASE}/developer/api/articleDraft/putDraft?p_csrf=${encodeURIComponent(csrf)}`
    const data = await this.pageFetchJson<AliyunApiResponse<PutDraftData>>(
      PAGE_URL_PATTERN,
      WRITE_URL,
      url,
      {
        method: 'POST',
        headers: this.csrfHeaders(csrf),
        body: JSON.stringify(body),
      }
    )
    if (!data?.success || data.data?.aid == null) {
      throw new Error(data?.message || `页面存草稿失败 code=${data?.code}`)
    }
    return data.data.aid
  }

  private async putDraft(body: AliyunPutDraftBody): Promise<number | string> {
    try {
      return await this.putDraftViaSw(body)
    } catch (error) {
      logger.debug('SW putDraft failed, fallback to page:', error)
      return this.putDraftViaPage(body)
    }
  }

  private guessImageName(src: string, blob: Blob): string {
    if (src.startsWith('data:')) {
      const mime = blob.type || 'image/png'
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('gif') ? 'gif' : 'png'
      return `local.${ext}`
    }
    try {
      const path = new URL(src).pathname
      const base = path.split('/').pop() || 'image.png'
      return base.includes('.') ? base.slice(0, 120) : `${base}.png`
    } catch {
      return 'image.png'
    }
  }

  private async resolveImageBlob(src: string): Promise<Blob> {
    if (src.startsWith('data:')) {
      const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/i)
      if (!m) throw new Error('无效 data URI')
      const mime = m[1] || 'image/png'
      const isBase64 = !!m[2]
      const data = m[3] || ''
      if (isBase64) {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return new Blob([bytes], { type: mime })
      }
      return new Blob([decodeURIComponent(data)], { type: mime })
    }

    if (!/^https?:\/\//i.test(src)) {
      throw new Error(`不支持的图片地址: ${src.slice(0, 80)}`)
    }

    const response = await this.runtime.fetch(src, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`下载图片失败 HTTP ${response.status}`)
    }
    return response.blob()
  }

  private async uploadImageBinary(blob: Blob, imageName: string): Promise<string> {
    const csrf = await this.getCsrf()
    const tokenUrl = `${BASE}/developer/api/image/getImageUploadUrl?p_csrf=${encodeURIComponent(csrf)}`
    const metaRes = await this.runtime.fetch(tokenUrl, {
      method: 'POST',
      credentials: 'include',
      headers: this.csrfHeaders(csrf),
      body: JSON.stringify({ imageName, imageSize: blob.size }),
    })
    const metaText = await metaRes.text()
    let meta: AliyunApiResponse<ImageUploadUrlData>
    try {
      meta = JSON.parse(metaText) as AliyunApiResponse<ImageUploadUrlData>
    } catch {
      throw new Error(`getImageUploadUrl 非 JSON: ${metaText.slice(0, 120)}`)
    }
    if (!meta.success || !meta.data?.uploadUrl || !meta.data.imageUrl) {
      throw new Error(meta.message || '获取上传地址失败')
    }

    let uploadUrl = meta.data.uploadUrl.replace(/^http:/i, 'https:')
    const header = meta.data.header || {}
    const putHeaders: Record<string, string> = {}
    const contentType = header['content-type'] || header['Content-Type'] || blob.type || 'application/octet-stream'
    putHeaders['Content-Type'] = contentType
    if (header['x-oss-meta-author']) {
      putHeaders['x-oss-meta-author'] = header['x-oss-meta-author']
    }

    const putRes = await this.runtime.fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: putHeaders,
      credentials: 'include',
    })
    if (!putRes.ok) {
      const putText = await putRes.text().catch(() => '')
      throw new Error(`OSS PUT 失败 HTTP ${putRes.status}: ${putText.slice(0, 120)}`)
    }
    return meta.data.imageUrl
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (SKIP_IMAGE_HOSTS.some((h) => src.includes(h))) {
      return { url: src }
    }

    return this.withAliyunSession(async () => {
      const blob = await this.resolveImageBlob(src)
      const imageName = this.guessImageName(src, blob)
      const url = await this.uploadImageBinary(blob, imageName)
      return { url }
    })
  }

  // prepareMarkdown 已移除：图片处理逻辑迁入 uploadImages 钩子（SharedImageCache 去重）

  // ============ 管道钩子 ============

  /** 1. 鉴权：SW + 页面上下文级联 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    const authed =
      (await this.detectAuthViaSw().catch(() => null)) ||
      (await this.detectAuthViaPage().catch(() => null))
    if (!authed) {
      throw new Error(
        '请先登录阿里云开发者社区（打开 https://developer.aliyun.com/article/new）'
      )
    }
  }

  /** 2. 内容规整：确保 markdown 非空 */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    if (!(ctx.content.markdown || '').trim()) {
      throw new Error('文章内容为空（未得到 Markdown），请重试同步')
    }
  }

  /** 3. 上传图片：withAliyunSession 保护下走 SharedImageCache 去重；整体失败回退纯文字 */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    try {
      await this.withAliyunSession(async () => {
        const upload = async (src: string): Promise<ImageUploadResult> => {
          const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
          if (hit) return { url: hit }
          try {
            const result = await this.uploadImageByUrl(src)
            ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
            return result
          } catch (error) {
            logger.warn('单张图片转存失败:', src.slice(0, 80), error)
            if (src.startsWith('data:') || src.startsWith('blob:')) {
              return { url: '' }
            }
            return { url: src }
          }
        }
        const opts: ImageProcessOptions = {
          skipPatterns: SKIP_IMAGE_HOSTS,
          onProgress: ctx.onImageProgress,
          concurrency: 3,
        }
        ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
      })
    } catch (error) {
      logger.warn('图片链路失败，回退纯文字:', error)
      ctx.content.markdown = stripMarkdownImages(ctx.content.markdown)
    }
    // processImages 可能留下空的 ![]()
    ctx.content.markdown = ctx.content.markdown.replace(/!\[[^\]]*\]\(\s*\)/g, '')
  }

  /** 5. 构建 putDraft 请求体 */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const title = (ctx.article.title || '').trim() || '未命名文章'
    ctx.payload = buildPutDraftBody(title, ctx.content.markdown)
  }

  /** 6. 提交：putDraft（SW 失败再页面回退） */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const aid = await this.putDraft(ctx.payload as AliyunPutDraftBody)
    return this.createResult(true, {
      postId: String(aid),
      postUrl: `${BASE}/article/new?edit=${aid}`,
      draftOnly: true,
    })
  }

  /** Header 规则：阿里云用 withAliyunSession 动态构建（含 Cookie 注入），此处返回空 */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return []
  }
}
