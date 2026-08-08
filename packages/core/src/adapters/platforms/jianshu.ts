/**
 * 简书适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：settings/basic.json 鉴权 + 七牛图床 + 创建笔记 + 写入正文全部保留。
 * checkAuth 重写（保留 withHeaderRules 包 checkAuthInner 的原逻辑，因需设置 this.account）。
 *
 * 写作台：https://www.jianshu.com/writer
 * 草稿：POST /author/notes 创建笔记，PUT /author/notes/{id} 写入 Markdown 正文
 * 图片：POST /upload_images/fetch 抓取远程图，本地/失败回退走 /upload_images/token.json + 七牛
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Jianshu')

interface JianshuNotebook {
  id: number
  name: string
}

interface JianshuAccount {
  nickname: string
  avatar: string
}

interface JianshuNoteCreated {
  id: number
  autosaveControl: number
}

export class JianshuAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'jianshu',
    name: '简书',
    icon: 'https://www.jianshu.com/favicon.ico',
    homepage: 'https://www.jianshu.com/writer',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  // 简书写作台支持 Markdown；用 MD 同步以保留代码块样式与换行
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
    processCodeBlocks: true,
  }

  private account: JianshuAccount | null = null
  private defaultNotebookId: number | null = null

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.jianshu.com/*',
      headers: {
        Origin: 'https://www.jianshu.com',
        Referer: 'https://www.jianshu.com/writer',
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
            error: '未登录简书，请先在浏览器打开并登录 https://www.jianshu.com/writer',
          }
        }
        return {
          isAuthenticated: true,
          username: this.account.nickname,
          avatar: this.account.avatar,
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
        throw new Error('请先登录简书')
      }
    }
  }

  /** 2. 内容规整：取默认内容 + 简书 Markdown 规整（公式/表格） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    const md = (ctx.content.markdown || '').trim() || (ctx.content.html || '').trim()
    ctx.content.markdown = this.normalizeMarkdownForJianshu(md)
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
        skipPatterns: ['jianshu.com', 'jianshuapi.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    })
  }

  /** 5. 构建笔记正文 payload */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      title: ctx.article.title,
      content: ctx.content.markdown,
    }
  }

  /** 6. 提交：获取默认文集 → 创建笔记 → 写入正文 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const payload = ctx.payload as { title: string; content: string }
    const notebookId = await this.getDefaultNotebookId()
    const draft = await this.createNote(notebookId, payload.title)
    // autosave_control 需递增：用创建返回值 +1 作为下一次保存的版本号
    await this.updateNoteContent(draft.id, payload.title, payload.content, draft.autosaveControl + 1)

    return this.createResult(true, {
      postId: String(draft.id),
      postUrl: `https://www.jianshu.com/writer#/notebooks/${notebookId}/notes/${draft.id}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 鉴权与笔记 API（保持原样）============

  /** 在已有 header rules 上下文中刷新账号信息，避免嵌套 withHeaderRules */
  private async checkAuthInner(): Promise<boolean> {
    const data = await this.get<{
      data?: { nickname?: string; name?: string; avatar?: string }
      nickname?: string
      name?: string
      avatar?: string
    }>('https://www.jianshu.com/settings/basic.json', {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    })

    const nickname = data.data?.nickname || data.data?.name || data.nickname || data.name
    if (!nickname) {
      return false
    }

    this.account = {
      nickname,
      avatar: data.data?.avatar || data.avatar || '',
    }
    return true
  }

  private async getNotebooks(): Promise<JianshuNotebook[]> {
    const res = await this.get<JianshuNotebook[] | { error?: string; message?: string }>(
      'https://www.jianshu.com/author/notebooks',
      {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      }
    )

    if (!Array.isArray(res)) {
      const err = res.error || res.message
      throw new Error(typeof err === 'string' ? err : '获取简书文集失败')
    }
    return res
  }

  private async getDefaultNotebookId(): Promise<number> {
    if (this.defaultNotebookId != null) {
      return this.defaultNotebookId
    }
    const notebooks = await this.getNotebooks()
    if (notebooks.length === 0) {
      throw new Error('没有可用的文集，请先在简书创建文集')
    }
    this.defaultNotebookId = notebooks[0].id
    return this.defaultNotebookId
  }

  private async createNote(
    notebookId: number,
    title: string
  ): Promise<JianshuNoteCreated> {
    const data = await this.postJson<{ id?: number; autosave_control?: number }>(
      'https://www.jianshu.com/author/notes',
      {
        at_bottom: false,
        notebook_id: notebookId,
        title,
      },
      {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      }
    )

    if (!data.id) {
      throw new Error('创建草稿失败：未返回笔记 ID')
    }
    return {
      id: data.id,
      autosaveControl: data.autosave_control ?? 0,
    }
  }

  private async updateNoteContent(
    noteId: number,
    title: string,
    content: string,
    autosaveControl: number
  ): Promise<void> {
    const response = await this.runtime.fetch(
      `https://www.jianshu.com/author/notes/${noteId}`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          id: noteId,
          title,
          content,
          autosave_control: autosaveControl,
        }),
      }
    )

    if (!response.ok) {
      throw new Error(`更新笔记失败 HTTP ${response.status}`)
    }
  }

  /**
   * 简书写作台兼容处理：
   * - turndown 会把公式里的 \ 转成 \\，需还原为一层 \
   * - 表格分隔只认 ---，不认 :-: / :-- / --: 等对齐标记
   */
  private normalizeMarkdownForJianshu(markdown: string): string {
    const codeBlocks: string[] = []
    let md = markdown.replace(/```[\s\S]*?```/g, (block) => {
      const idx = codeBlocks.length
      codeBlocks.push(block)
      return `\0CODE${idx}\0`
    })

    const unescapeFormula = (body: string) => body.replace(/\\\\/g, '\\')

    // 块级公式 $$...$$
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => `$$${unescapeFormula(body)}$$`)
    // 行内公式 $...$（排除 $$）
    md = md.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_m, body: string) => `$${unescapeFormula(body)}$`)

    // 表格对齐分隔行统一为 ---
    md = md.replace(
      /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?[ \t]*$/gm,
      (line) => line.replace(/:?-+:?/g, '---')
    )

    return md.replace(/\0CODE(\d+)\0/g, (_m, i: string) => codeBlocks[Number(i)] ?? '')
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 远程 URL：优先用简书抓图接口（最稳，绕过 SW 下七牛凭证的种种限制）
    if (/^https?:\/\//i.test(src)) {
      try {
        const data = await this.postJson<{ url?: string; error?: string }>(
          'https://www.jianshu.com/upload_images/fetch',
          { url: src },
          {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          }
        )
        if (data.url) {
          return { url: data.url }
        }
        throw new Error(data.error || '简书抓图未返回 url')
      } catch (error) {
        logger.warn('fetch image failed, fallback to binary:', src.slice(0, 80), error)
      }
    }

    // data URI / 远程抓图失败：下载后走七牛 token 上传
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const imageResponse = await this.runtime.fetch(src, { credentials: 'include' })
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败 HTTP ${imageResponse.status}`)
      }
      blob = await imageResponse.blob()
    }
    const url = await this.uploadImageBinary(blob)
    return { url }
  }

  /** 获取简书七牛上传凭证（兼容 {token,key,url} 与 {data:{...}} 两种形态） */
  private async getUploadToken(
    filename: string
  ): Promise<{ token: string; key?: string; uploadUrl: string }> {
    const endpoints = [
      `https://www.jianshu.com/upload_images/token.json?filename=${encodeURIComponent(filename)}`,
      'https://www.jianshu.com/upload_images/token.json',
    ]

    let lastDetail = ''
    for (const endpoint of endpoints) {
      try {
        const data = await this.get<{
          token?: string
          key?: string
          url?: string
          data?: { token?: string; key?: string; url?: string }
        }>(endpoint, {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        })

        const token = data.token || data.data?.token
        const key = data.key || data.data?.key
        const uploadUrl = data.url || data.data?.url || 'https://upload.qiniup.com/'
        if (token) {
          return { token, key, uploadUrl }
        }
        lastDetail = JSON.stringify(data).slice(0, 200)
      } catch (error) {
        lastDetail = (error as Error).message
        logger.warn('getUploadToken failed:', endpoint, error)
      }
    }
    throw new Error(`获取简书上传凭证失败: ${lastDetail || 'empty response'}`)
  }

  /** 二进制上传到七牛（简书图床），兼容 {url} 与仅返回 {key} 的响应 */
  private async uploadImageBinary(file: Blob): Promise<string> {
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
    const filename = `${Date.now()}.${ext}`
    const { token, key, uploadUrl } = await this.getUploadToken(filename)

    const formData = new FormData()
    formData.append('token', token)
    if (key) formData.append('key', key)
    formData.append('file', file, filename)

    // 七牛上传不强制 credentials（避免 CORS 问题），绕过 header rules 直连
    const response = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'omit',
      body: formData,
    })

    const text = await response.text()
    let data: { url?: string; key?: string; error?: string }
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`简书图床响应非 JSON: ${text.slice(0, 120)}`)
    }

    if (!response.ok || data.error) {
      throw new Error(`简书图床上传失败: ${data.error || text.slice(0, 120)}`)
    }

    if (data.url) return data.url
    const finalKey = data.key || key
    if (finalKey) {
      return `https://upload-images.jianshu.io/upload_images/${finalKey}`
    }
    throw new Error('简书图床上传成功但无 url/key')
  }
}
