/**
 * 人人都是产品经理 (woshipm.com) 适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：writing 页面提取 jltoken/uid + profile 鉴权 + upyun 图床 +
 * admin-ajax add_draft 草稿全部保留。
 * checkAuth 重写（保留页面提取 + profile API 原逻辑）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Woshipm')

export class WoshipmAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'woshipm',
    name: '人人都是产品经理',
    icon: 'https://www.woshipm.com/favicon.ico',
    homepage: 'https://www.woshipm.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 人人都是产品经理使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeEmptyLines: true,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
    ],
  }

  private jltoken: string = ''

  /** 人人都是产品经理 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://woshipm.com/wp-admin/admin-ajax.php*',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://woshipm.com/api2/*',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://woshipm.com/tensorflow/upyun/upload*',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留页面提取 + profile API 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      // 1. 先获取用户页面以获取 uid
      const pageResponse = await this.runtime.fetch('https://www.woshipm.com/writing', {
        method: 'GET',
        credentials: 'include',
      })

      const pageText = await pageResponse.text()

      // 从页面提取 jltoken: "jltoken":"xxx"
      const jltokenMatch = pageText.match(/"jltoken"\s*:\s*"([^"]+)"/)
      if (jltokenMatch) {
        this.jltoken = jltokenMatch[1]
        logger.debug('Found jltoken')
      }

      // 从页面提取 uid: var userSettings = {"url":"\/","uid":"1585",...}
      const uidMatch = pageText.match(/var\s+userSettings\s*=\s*\{[^}]*"uid"\s*:\s*"(\d+)"/)
      if (!uidMatch) {
        return { isAuthenticated: false }
      }

      const uid = uidMatch[1]

      // 2. 调用 profile API 验证登录状态
      const response = await this.runtime.fetch(
        `https://www.woshipm.com/api2/user/profile?uid=${uid}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
          },
        }
      )

      const data = (await response.json()) as {
        CODE?: number
        RESULT?: {
          userInfoVo?: {
            uid?: number
            nickName?: string
            avartar?: string  // API typo: avartar instead of avatar
          }
        }
      }

      if (data.CODE === 200 && data.RESULT?.userInfoVo?.uid) {
        return {
          isAuthenticated: true,
          userId: String(data.RESULT.userInfoVo.uid),
          username: data.RESULT.userInfoVo.nickName,
          avatar: data.RESULT.userInfoVo.avartar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：触发 checkAuth 获取 jltoken（图片上传需要） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.jltoken) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录人人都是产品经理')
      }
    }
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
        skipPatterns: ['woshipm.com', 'image.woshipm.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
  }

  /** 5. 构建 add_draft 请求体（P2 写死保持等价） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      action: 'add_draft',
      post_title: ctx.article.title,
      post_content: ctx.content.html,
    }
  }

  /** 6. 提交：admin-ajax.php add_draft */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const createResponse = await this.runtime.fetch(
      'https://www.woshipm.com/wp-admin/admin-ajax.php',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams(ctx.payload as Record<string, string>),
      }
    )

    const responseText = await createResponse.text()
    logger.debug('Create draft response:', createResponse.status, responseText.substring(0, 300))

    if (!createResponse.ok) {
      throw new Error(`创建草稿失败: ${createResponse.status} - ${responseText}`)
    }

    let createData: { post_id?: string | number; url?: string; success?: boolean; error?: string }
    try {
      createData = JSON.parse(responseText)
    } catch {
      throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }

    if (!createData.post_id) {
      throw new Error(createData.error || '创建草稿失败: 无效响应')
    }

    const draftId = String(createData.post_id)
    const draftUrl = createData.url || `https://www.woshipm.com/writing?pid=${draftId}`

    logger.debug('Draft created:', draftId)

    return this.createResult(true, {
      postId: draftId,
      postUrl: draftUrl,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 图片上传（保持原样）============

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   */
  async uploadImage(file: Blob, filename?: string): Promise<string> {
    return this.uploadImageBinaryInternal(file, filename || 'image.png')
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      // 1. 下载图片（使用 runtime.fetch 以支持跨域）
      const imageResponse = await this.runtime.fetch(src, {
        credentials: 'omit',
      })
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch image: ${imageResponse.status}`)
      }

      const blob = await imageResponse.blob()

      // 2. 上传到 woshipm
      const url = await this.uploadImageBinaryInternal(blob, this.getFilenameFromUrl(src))
      return { url }
    } catch (error) {
      logger.warn('Failed to upload image by URL:', src, error)
      return { url: src } // 失败时返回原 URL
    }
  }

  /**
   * 上传图片 (二进制方式) - 内部使用
   */
  private async uploadImageBinaryInternal(file: Blob, filename: string): Promise<string> {
    const formData = new FormData()
    formData.append('action', 'wpuf_insert_image')
    formData.append('name', filename)
    formData.append('files', file, filename)

    const headers: Record<string, string> = {
      'Origin': 'https://www.woshipm.com',
      'Referer': 'https://www.woshipm.com/writing',
    }
    if (this.jltoken) {
      headers['jlstar'] = `Bearer ${this.jltoken}`
    }

    const response = await this.runtime.fetch('https://www.woshipm.com/tensorflow/upyun/upload', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: formData,
    })

    const data = (await response.json()) as {
      data?: Array<{ url?: string }>
      error?: string
    }

    if (data.data && data.data.length > 0 && data.data[0].url) {
      logger.debug('Uploaded image:', filename, '->', data.data[0].url)
      return data.data[0].url
    }

    throw new Error(data.error || 'Failed to upload image')
  }

  /**
   * 从 URL 提取文件名
   */
  private getFilenameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname
      const filename = pathname.split('/').pop() || 'image.png'
      return filename
    } catch {
      return 'image.png'
    }
  }
}
