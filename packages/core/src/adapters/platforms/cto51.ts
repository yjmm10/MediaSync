/**
 * 51CTO 适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：blogger/publish 页面探测登录 + csrf 提取 + 腾讯云 COS 图床 + blogger/draft 草稿全部保留。
 * checkAuth 重写（保留页面探测 + csrf 设置原逻辑）。
 *
 * 新版图片上传流程:
 * 1. getUploadSign - 获取上传签名
 * 2. getUploadConfig - 获取腾讯云 COS 上传凭证
 * 3. 上传到腾讯云 COS
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { pickMarkdownOnlyContent } from '../content-origin'

interface UploadSignResponse {
  code: number
  msg: string
  data: {
    allows: string
    sizeLimit: number
    sizeLimitMessage: string
    url: string
    sign: string
  }
}

interface UploadConfigResponse {
  code: number
  msg: string
  data: {
    url: string
    fields: {
      key: string
      policy: string
      'x-amz-algorithm': string
      'x-amz-signature': string
      'x-amz-credential': string
      'X-Amz-Date': string
    }
  }
}

export class Cto51Adapter extends PipelineAdapter {
  meta: PlatformMeta = {
    id: '51cto',
    name: '51CTO',
    icon: 'https://static1.51cto.com/www/images/favicon.ico',
    homepage: 'https://blog.51cto.com/blogger/publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 51CTO 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      {
        kind: 'visibility',
        key: 'visibility',
        label: '可见性',
        options: [
          { value: 'public', label: '公开' },
          { value: 'private', label: '仅自己可见' },
        ],
      },
      { kind: 'summary', key: 'summary', label: '摘要' },
    ],
  }

  private csrf: string | null = null

  /** 51CTO API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://blog.51cto.com/*',
      headers: {
        Origin: 'https://blog.51cto.com',
        Referer: 'https://blog.51cto.com/blogger/publish',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留页面探测 + csrf 设置原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
        credentials: 'include',
      })
      const html = await response.text()

      // 解析页面获取用户信息
      const imgMatch = html.match(/<li class="more user">\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"/)
      if (!imgMatch) {
        return { isAuthenticated: false, error: '未登录' }
      }

      const userLink = imgMatch[1]
      const avatar = imgMatch[2]
      const uid = userLink.split('/').filter(Boolean).pop() || ''

      // 获取 csrf token
      const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)
      if (csrfMatch) {
        this.csrf = csrfMatch[1]
      }

      return {
        isAuthenticated: true,
        userId: uid,
        username: uid,
        avatar: avatar,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 csrf 已获取（沿用 checkAuth 页面探测） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.csrf) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('未登录')
      }
    }
  }

  /** 2. 内容规整：用 pickMarkdownOnlyContent 取内容（仅 md 源用原文，否则派生），记录 asMarkdown */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    const { content, asMarkdown } = pickMarkdownOnlyContent(ctx.article)
    ctx.content.markdown = content
    ctx.content.html = ''
    ctx.refs.asMarkdown = asMarkdown
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
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    })
  }

  /** 5. 构建草稿请求体（P2 写死保持等价；is_old 由 asMarkdown 决定） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const asMarkdown = (ctx.refs.asMarkdown as boolean) ?? false
    ctx.payload = {
      postData: {
        title: ctx.article.title,
        content: ctx.content.markdown,
        pid: '',
        cate_id: '',
        custom_id: '0',
        tag: '',
        abstract: '',
        banner_type: '0',
        blog_type: '1',
        copy_code: '1',
        is_hide: '0',
        top_time: '0',
        is_comment: '0',
        is_old: asMarkdown ? '0' : '2',
        blog_id: '',
        did: '',
        work_id: '',
        class_id: '',
        subjectId: '',
        import_type: '-1',
        invite_code: '',
        raffle: '',
        orig: '',
        _csrf: this.csrf || '',
      },
    }
  }

  /** 6. 提交：blogger/draft */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const payload = ctx.payload as { postData: Record<string, string> }
    const response = await this.runtime.fetch('https://blog.51cto.com/blogger/draft', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      body: new URLSearchParams(payload.postData).toString(),
    })

    const res = await response.json()

    if (res.status !== 1 || !res.data) {
      throw new Error(res.msg || '发布失败')
    }

    return this.createResult(true, {
      postId: String(res.data.did),
      postUrl: `https://blog.51cto.com/blogger/draft/${res.data.did}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 图片上传（保持原样）============

  /**
   * 获取上传签名
   */
  private async getUploadSign(): Promise<UploadSignResponse['data']> {
    const response = await this.runtime.fetch('https://blog.51cto.com/getUploadSign', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://blog.51cto.com/blogger/publish',
        'Origin': 'https://blog.51cto.com',
      },
      body: 'upload_type=image',
    })

    const res: UploadSignResponse = await response.json()
    if (res.code !== 0) {
      throw new Error(res.msg || '获取上传签名失败')
    }
    return res.data
  }

  /**
   * 获取上传配置 (腾讯云 COS 凭证)
   */
  private async getUploadConfig(
    uploadSign: string,
    ext: string,
    filename: string
  ): Promise<UploadConfigResponse['data']> {
    const response = await this.runtime.fetch('https://blog.51cto.com/getUploadConfig', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        upload_type: 'image',
        upload_sign: uploadSign,
        ext: ext,
        name: filename,
      }).toString(),
    })

    const res: UploadConfigResponse = await response.json()
    if (res.code !== 0) {
      throw new Error(res.msg || '获取上传配置失败')
    }
    return res.data
  }

  /**
   * 上传图片到腾讯云 COS
   */
  private async uploadToCOS(
    cosUrl: string,
    fields: UploadConfigResponse['data']['fields'],
    file: File
  ): Promise<string> {
    const formData = new FormData()

    // 按顺序添加字段 (顺序很重要)
    formData.append('key', fields.key)
    formData.append('policy', fields.policy)
    formData.append('x-amz-algorithm', fields['x-amz-algorithm'])
    formData.append('x-amz-signature', fields['x-amz-signature'])
    formData.append('x-amz-credential', fields['x-amz-credential'])
    formData.append('X-Amz-Date', fields['X-Amz-Date'])
    formData.append('Content-Type', file.type)
    formData.append('file', file)

    const response = await this.runtime.fetch(cosUrl, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`上传到 COS 失败: ${response.status}`)
    }

    // 返回图片 URL (通过 51cto CDN)
    return `https://s2.51cto.com/${fields.key}`
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 确定文件扩展名和 MIME 类型
    const mimeType = blob.type || 'image/jpeg'
    const ext = mimeType.split('/')[1] || 'jpeg'
    const filename = `${Date.now()}.${ext}`
    const file = new File([blob], filename, { type: mimeType })

    // Step 1: 获取上传签名
    const signData = await this.getUploadSign()

    // Step 2: 获取上传配置
    const configData = await this.getUploadConfig(signData.sign, mimeType, filename)

    // Step 3: 上传到腾讯云 COS
    const imageUrl = await this.uploadToCOS(configData.url, configData.fields, file)

    return { url: imageUrl }
  }
}
