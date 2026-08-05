/**
 * 语雀适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：yuque_ctoken + common_used 鉴权（取首个知识库）+ 创建文档 +
 * 图片上传（依赖 doc id）+ markdown→lake 转换 + 保存正文全部保留。
 *
 * 流程特殊：图片上传依赖 currentPostId，因此 create doc 在 uploadImages 钩子内完成
 * （先于图片处理），convert 也在 uploadImages 内，submit 只做最终 save content。
 *
 * checkAuth 重写（保留 getCsrfToken + common_used + 设 userInfo/bookId 原逻辑）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Yuque')

interface YuqueUserInfo {
  id: number
  name: string
  avatar_url: string
}

interface YuqueBook {
  target_id: number
  user: YuqueUserInfo
}

export class YuqueAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'yuque',
    name: '语雀',
    icon: 'https://gw.alipayobjects.com/zos/rmsportal/UTjFYEzMSYVwzxIGVhMu.png',
    homepage: 'https://www.yuque.com/dashboard',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 语雀使用 Markdown 格式 (转换为 lake) */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
    // doPreFilter + processDocCode (旧版)
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    processCodeBlocks: true,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'column', key: 'column', label: '知识库', source: 'remote' },
    ],
  }

  private userInfo: YuqueUserInfo | null = null
  private bookId: number | null = null
  private csrfToken: string = ''
  private currentPostId: number | null = null

  /** 语雀 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.yuque.com/api/*',
      headers: {
        'Origin': 'https://www.yuque.com',
        'Referer': 'https://www.yuque.com/dashboard',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留原逻辑）============

  private async getCsrfToken(): Promise<string> {
    if (this.runtime.getCookie) {
      const value = await this.runtime.getCookie('.yuque.com', 'yuque_ctoken')
      if (!value) {
        throw new Error('请先登录语雀')
      }
      return value
    }
    throw new Error('请先登录语雀')
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      this.csrfToken = await this.getCsrfToken()

      const response = await this.runtime.fetch(
        'https://www.yuque.com/api/mine/common_used',
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-csrf-token': this.csrfToken,
          },
        }
      )

      const res = await response.json() as {
        data?: {
          books?: YuqueBook[]
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.data?.books && res.data.books.length > 0) {
        const firstBook = res.data.books[0]
        this.userInfo = firstBook.user
        this.bookId = firstBook.target_id

        return {
          isAuthenticated: true,
          userId: String(firstBook.user.id),
          username: firstBook.user.name,
          avatar: firstBook.user.avatar_url,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', (error as Error).message)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 userInfo/bookId 已获取 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.userInfo || !this.bookId) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录语雀')
      }
    }
  }

  /**
   * 3. 上传图片 + 创建文档 + 转换内容
   *
   * 语雀流程特殊：图片上传依赖 doc id，所以 create doc 在本钩子最前面；
   * 随后处理图片，最后 convert markdown → lake，结果存 ctx.refs.lakeContent。
   */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      // 1. 创建文档（图片上传依赖 currentPostId）
      const createResponse = await this.runtime.fetch(
        'https://www.yuque.com/api/docs',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': this.csrfToken,
          },
          body: JSON.stringify({
            title: ctx.article.title,
            type: 'Doc',
            format: 'lake',
            book_id: this.bookId,
            status: 0,
          }),
        }
      )

      const createRes = await createResponse.json() as {
        data?: { id: number }
        message?: string
      }
      logger.debug('Create doc response:', createRes)
      if (!createRes.data?.id) {
        throw new Error(createRes.message || '创建文档失败')
      }

      const postId = createRes.data.id
      this.currentPostId = postId
      ctx.refs.postId = postId

      // 2. 处理图片上传
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      const opts: ImageProcessOptions = {
        skipPatterns: ['yuque.com', 'cdn.nlark.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)

      // 3. convert markdown → lake
      const convertResponse = await this.runtime.fetch(
        'https://www.yuque.com/api/docs/convert',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': this.csrfToken,
          },
          body: JSON.stringify({
            from: 'markdown',
            to: 'lake',
            content: ctx.content.markdown,
          }),
        }
      )

      const convertRes = await convertResponse.json() as {
        data?: { content: string }
      }
      if (!convertRes.data?.content) {
        throw new Error('内容转换失败')
      }
      ctx.refs.lakeContent = convertRes.data.content
    })
  }

  /** 5. 构建保存正文请求体 */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const lakeContent = (ctx.refs.lakeContent as string) ?? ''
    ctx.payload = {
      format: 'lake',
      body_asl: lakeContent,
      body: `<div class="lake-content" typography="traditional">${lakeContent}</div>`,
      body_html: `<div class="lake-content" typography="traditional">${lakeContent}</div>`,
      draft_version: 0,
      sync_dynamic_data: false,
      save_type: 'auto',
      edit_type: 'Lake',
    }
  }

  /** 6. 提交：保存正文 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const postId = ctx.refs.postId as number
    const saveResponse = await this.runtime.fetch(
      `https://www.yuque.com/api/docs/${postId}/content`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': this.csrfToken,
        },
        body: JSON.stringify(ctx.payload),
      }
    )

    const saveRes = await saveResponse.json()
    logger.debug('Save response:', saveRes)

    return this.createResult(true, {
      postId: String(postId),
      postUrl: `https://www.yuque.com/go/doc/${postId}/edit`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 图片上传（保持原样）============

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.currentPostId) {
      throw new Error('文档 ID 未设置')
    }

    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')

    const uploadUrl = `https://www.yuque.com/api/upload/attach?attachable_type=Doc&attachable_id=${this.currentPostId}&type=image`
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-csrf-token': this.csrfToken,
      },
      body: formData,
    })

    const res = await uploadResponse.json() as {
      data?: {
        attachment_id: string
        url: string
      }
    }

    logger.debug('Image upload response:', res)

    if (!res.data?.url) {
      throw new Error('图片上传失败')
    }

    return {
      url: res.data.url,
    }
  }
}
