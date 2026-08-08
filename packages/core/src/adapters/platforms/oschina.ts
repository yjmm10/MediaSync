/**
 * 开源中国适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：user/myDetails 鉴权 + ai/creation 图床 + save_draft 草稿全部保留。
 * checkAuth 重写（保留 fetch JSON + 设 userId 原逻辑）。
 * https://my.oschina.net
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'

export class OschinaAdapter extends PipelineAdapter {
  meta: PlatformMeta = {
    id: 'oschina',
    name: '开源中国',
    icon: 'https://www.oschina.net/favicon.ico',
    homepage: 'https://my.oschina.net',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 开源中国使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private userId: string | null = null

  /** 开源中国 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://apiv1.oschina.net/oschinapi/*',
      headers: {
        Origin: 'https://my.oschina.net',
        Referer: 'https://my.oschina.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留 fetch JSON + 设 userId 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://apiv1.oschina.net/oschinapi/user/myDetails', {
        credentials: 'include',
      })
      const data = await response.json() as {
        success: boolean
        result?: {
          userId: number
          userVo?: {
            name: string
            portraitUrl: string
          }
        }
      }

      if (!data.success || !data.result?.userId) {
        return { isAuthenticated: false, error: '未登录' }
      }

      this.userId = String(data.result.userId)

      return {
        isAuthenticated: true,
        userId: this.userId,
        username: data.result.userVo?.name || this.userId,
        avatar: data.result.userVo?.portraitUrl,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 userId 已获取 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.userId) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('未登录')
      }
    }
  }

  /** 2. 内容规整：记录使用 markdown 还是 html（与原 publish 一致） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    ctx.refs.useMarkdown = (ctx.content.markdown || '').trim().length > 0
  }

  /** 3. 上传图片：在 Header 规则保护下走 SharedImageCache 去重上传（处理选定内容） */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const useMarkdown = (ctx.refs.useMarkdown as boolean) ?? true
      const target: 'markdown' | 'html' = useMarkdown ? 'markdown' : 'html'
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      const opts: ImageProcessOptions = {
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content[target] = await this.processImages(ctx.content[target], upload, opts)
    })
  }

  /** 5. 构建 save_draft 请求体（P2 写死保持等价） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const useMarkdown = (ctx.refs.useMarkdown as boolean) ?? true
    const content = useMarkdown ? ctx.content.markdown : ctx.content.html
    ctx.payload = {
      title: ctx.article.title,
      user: Number(this.userId),
      content,
      contentType: useMarkdown ? 1 : 2, // 1=markdown, 2=html
      catalog: 0,
      originUrl: '',
      privacy: true,
      disableComment: false,
    }
  }

  /** 6. 提交：save_draft */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const response = await this.runtime.fetch(
      'https://apiv1.oschina.net/oschinapi/api/draft/save_draft',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ctx.payload),
      }
    )

    const res = await response.json() as {
      success?: boolean
      message?: string
      result?: { id?: number }
    }

    if (!res.success || !res.result?.id) {
      throw new Error(res.message || '发布失败')
    }

    const draftId = String(res.result.id)
    return this.createResult(true, {
      postId: draftId,
      postUrl: `https://my.oschina.net/u/${this.userId}/blog/write/draft/${draftId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 图片上传（保持原样）============

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    if (!this.userId) {
      await this.checkAuth()
    }

    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()
    const filename = this.getFilenameFromUrl(url) || 'image'

    // 构建 FormData
    const formData = new FormData()
    formData.append('file', blob, filename)

    const response = await this.runtime.fetch(
      'https://apiv1.oschina.net/oschinapi/ai/creation/project/uploadDetail',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await response.json() as {
      success?: boolean
      result?: string
      message?: string
    }

    if (!res.success || !res.result) {
      throw new Error(res.message || '图片上传失败')
    }

    return { url: res.result }
  }

  private getFilenameFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname
      const name = pathname.split('/').pop()
      return name && name.trim() ? name : null
    } catch {
      return null
    }
  }
}
