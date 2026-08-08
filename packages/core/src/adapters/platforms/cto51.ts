/**
 * 51CTO 适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：blogger/publish 页面探测登录 + csrf 提取 + 腾讯云 COS 图床。
 * checkAuth 重写（保留页面探测 + csrf 设置原逻辑）。
 * 提交：草稿走 blogger/draft；发布先 draft 再 blogger/publish（did + check=1）。
 *
 * 新版图片上传流程:
 * 1. getUploadSign - 获取上传签名
 * 2. getUploadConfig - 获取腾讯云 COS 上传凭证
 * 3. 上传到腾讯云 COS
 *
 * 发布配置：文章分类 / 个人分类走 API；话题从 publish 页 HTML 解析（SW fetch，不开标签）。
 */
import { PipelineAdapter, type PublishContext, type PublishRefs } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import type { PublishParams } from '../publish-params'
import { pickMarkdownOnlyContent } from '../content-origin'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cto51')

/** originalType → blog_type */
const BLOG_TYPE: Record<string, string> = {
  original: '1',
  reprint: '2',
  translate: '3',
}

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

interface CateNode {
  id: string
  name: string
  item?: CateNode[]
}

/** 从 markdown 提取首张 http(s) 图（SW 无 DOM，正则） */
function extractFirstImageUrl(markdown?: string): string | undefined {
  if (!markdown) return undefined
  const re = /!\[[^\]]*\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const url = m[1].trim().replace(/^<|>$/g, '').split(/\s+/)[0]
    if (/^https?:\/\//i.test(url)) return url
  }
  return undefined
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

  readonly publishDefaults: PublishParams = {
    mode: 'draft',
    visibility: 'public',
    originalType: 'original',
    commentsEnabled: true,
    cover: 'auto',
    extra: {
      copyCode: '1',
      pinned: false,
    },
  }

  /** 配置 Schema（声明式，UI 据此渲染） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'category', key: 'category', label: '文章分类', source: 'remote' },
      { kind: 'column', key: 'column', label: '个人分类', source: 'remote' },
      { kind: 'tags', key: 'tags', label: '标签', max: 5 },
      { kind: 'summary', key: 'summary', label: '文章摘要', maxLength: 500 },
      { kind: 'topic', key: 'topicId', label: '话题', source: 'remote', refKey: 'topics' },
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto'] },
      {
        kind: 'originalType',
        key: 'originalType',
        label: '文章类型',
        options: [
          { value: 'original', label: '原创' },
          { value: 'reprint', label: '转载' },
          { value: 'translate', label: '翻译' },
        ],
      },
      {
        kind: 'select',
        key: 'extra.copyCode',
        label: '版权声明',
        options: [
          { value: '1', label: '转载请注明出处' },
          { value: '2', label: '转载需作者授权' },
          { value: '3', label: '谢绝转载' },
        ],
      },
      {
        kind: 'visibility',
        key: 'visibility',
        label: '可见性',
        options: [
          { value: 'public', label: '公开' },
          { value: 'private', label: '私密' },
        ],
      },
      { kind: 'comments', key: 'commentsEnabled', label: '允许评论' },
      { kind: 'toggle', key: 'extra.pinned', label: '置顶' },
    ],
    groups: [
      {
        title: '基本设置',
        fields: [
          'category',
          'column',
          'tags',
          'summary',
          'topicId',
          'cover',
          'originalType',
          'extra.copyCode',
        ],
        defaultOpen: true,
      },
      {
        title: '高级选项',
        fields: ['visibility', 'commentsEnabled', 'extra.pinned'],
        defaultOpen: false,
      },
    ],
  }

  private csrf: string | null = null

  /** 博客作者 ID（用于发布后文章链接 blog.51cto.com/{authorId}/{blogId}） */
  private authorId: string | null = null

  /** 二级 cate_id → 一级 pid */
  private cateParentMap = new Map<string, string>()

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
      if (uid) this.authorId = uid

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

  // ============ 发布选项（设置/同步折叠「平台更新」）============

  async fetchPublishRefs(): Promise<PublishRefs> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const [categories, columns, topics] = await Promise.all([
        this.fetchCategories(),
        this.fetchUserCategories(),
        this.fetchTopics(),
      ])
      return { categories, columns, topics }
    })
  }

  /** 文章分类：展平叶子，标签为「一级 / 二级」；无子节点则自身为叶子 */
  private async fetchCategories(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.runtime.fetch('https://blog.51cto.com/category/get-child', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    })
    if (!response.ok) {
      throw new Error(`拉取文章分类失败: ${response.status}`)
    }
    const res = (await response.json()) as { status?: number; data?: CateNode[] }
    if (res.status !== 1 || !Array.isArray(res.data)) {
      return []
    }
    return this.flattenCategories(res.data)
  }

  private flattenCategories(nodes: CateNode[]): Array<{ id: string; name: string }> {
    const out: Array<{ id: string; name: string }> = []
    for (const parent of nodes) {
      const pid = String(parent.id)
      const children = parent.item
      if (Array.isArray(children) && children.length > 0) {
        for (const child of children) {
          const id = String(child.id)
          this.cateParentMap.set(id, pid)
          out.push({ id, name: `${parent.name} / ${child.name}` })
        }
      } else {
        this.cateParentMap.set(pid, pid)
        out.push({ id: pid, name: parent.name })
      }
    }
    return out
  }

  /** 个人分类 → columns（UI column 字段） */
  private async fetchUserCategories(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.runtime.fetch(
      'https://blog.51cto.com/blogger-ajax/get-user-cate',
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
      },
    )
    if (!response.ok) {
      throw new Error(`拉取个人分类失败: ${response.status}`)
    }
    const res = (await response.json()) as {
      status?: number
      data?: { custom?: Array<{ custom_id?: string; name?: string }> }
    }
    const list = res.data?.custom ?? []
    return list
      .map((c) => {
        if (c.custom_id == null || !c.name) return null
        return { id: String(c.custom_id), name: c.name }
      })
      .filter((x): x is { id: string; name: string } => x != null)
  }

  /** 话题：SW 拉 publish 页 HTML，解析 #dropdownSubject li[value]（无独立 list API） */
  private async fetchTopics(): Promise<Array<{ id: string; name: string }>> {
    try {
      const response = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
        credentials: 'include',
      })
      if (!response.ok) {
        logger.warn('fetchTopics: publish page', response.status)
        return []
      }
      const html = await response.text()
      const blockMatch = html.match(
        /id=["']dropdownSubject["'][\s\S]*?<ul[^>]*id=["']listItemList["'][^>]*>([\s\S]*?)<\/ul>/i,
      )
      const block = blockMatch?.[1] ?? html
      const topics: Array<{ id: string; name: string }> = []
      const seen = new Set<string>()
      const re = /<li[^>]*\bvalue=["'](\d+)["'][^>]*>\s*([^<]+?)\s*<\/li>/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(block)) !== null) {
        const id = m[1]
        const name = m[2].trim()
        if (!name.startsWith('#') || seen.has(id)) continue
        seen.add(id)
        topics.push({ id, name })
      }
      return topics
    } catch (e) {
      logger.warn('fetchTopics failed', e)
      return []
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 csrf / authorId 已获取（沿用 checkAuth 页面探测） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.csrf || !this.authorId) {
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

  /** 5. 构建草稿请求体 */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const asMarkdown = (ctx.refs.asMarkdown as boolean) ?? false
    const { params } = ctx
    const cateId = params.category ?? ''

    if (cateId && !this.cateParentMap.has(cateId)) {
      try {
        await this.withHeaderRules(this.HEADER_RULES, () => this.fetchCategories())
      } catch (e) {
        logger.warn('buildPayload: fetchCategories for pid lookup failed', e)
      }
    }
    const pid = cateId ? (this.cateParentMap.get(cateId) ?? '') : ''

    const originalType = params.originalType ?? 'original'
    const blogType = BLOG_TYPE[originalType] ?? '1'
    const isOriginal = blogType === '1'
    const copyCodeRaw = params.extra?.copyCode
    const copyCode =
      isOriginal && copyCodeRaw != null && String(copyCodeRaw) !== ''
        ? String(copyCodeRaw)
        : ''

    const pinned = Boolean(params.extra?.pinned)
    const topTime = pinned ? String(Math.floor(Date.now() / 1000)) : '0'

    const firstImg = extractFirstImageUrl(ctx.content.markdown)
    const imgUrls = firstImg ? [firstImg] : []

    ctx.payload = {
      postData: {
        title: ctx.article.title,
        content: ctx.content.markdown,
        pid,
        cate_id: cateId,
        custom_id: params.column ?? '0',
        tag: (params.tags ?? []).join(','),
        abstract: params.summary ?? '',
        banner_type: '0',
        blog_type: blogType,
        copy_code: copyCode || (isOriginal ? '1' : ''),
        is_hide: params.visibility === 'private' ? '1' : '0',
        top_time: topTime,
        is_comment: params.commentsEnabled ? '1' : '0',
        is_old: asMarkdown ? '0' : '2',
        blog_id: '',
        did: '',
        work_id: '',
        class_id: '',
        subjectId: params.topicId ?? '',
        import_type: '-1',
        invite_code: '',
        raffle: '',
        orig: '',
        _csrf: this.csrf || '',
      },
      img_urls: imgUrls,
    }
  }

  /** 组装 form-urlencoded（含 img_urls[]） */
  private buildFormBody(
    postData: Record<string, string>,
    imgUrls: string[] | undefined,
  ): string {
    const body = new URLSearchParams(postData)
    for (const url of imgUrls ?? []) {
      body.append('img_urls[]', url)
    }
    return body.toString()
  }

  /** POST blogger/draft 或 blogger/publish */
  private async postBloggerForm(
    path: 'draft' | 'publish',
    postData: Record<string, string>,
    imgUrls: string[] | undefined,
    referer: string,
  ): Promise<{ status?: number; msg?: string; data?: Record<string, unknown> }> {
    const response = await this.runtime.fetch(`https://blog.51cto.com/blogger/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Origin: 'https://blog.51cto.com',
        Referer: referer,
      },
      body: this.buildFormBody(postData, imgUrls),
    })
    return response.json()
  }

  /**
   * 6. 提交：
   * - 草稿：POST blogger/draft
   * - 发布：先 draft 拿 did，再 POST blogger/publish（did + check=1）
   */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const payload = ctx.payload as {
      postData: Record<string, string>
      img_urls?: string[]
    }
    const mode = ctx.params.mode ?? 'draft'
    const isPublish = mode === 'publish' || mode === 'schedule'

    const draftRes = await this.postBloggerForm(
      'draft',
      payload.postData,
      payload.img_urls,
      'https://blog.51cto.com/blogger/publish',
    )
    if (draftRes.status !== 1 || !draftRes.data) {
      throw new Error(draftRes.msg || '保存草稿失败')
    }
    const did = String(draftRes.data.did ?? '')
    if (!did) {
      throw new Error('保存草稿失败：未返回草稿 ID')
    }

    if (!isPublish) {
      return this.createResult(true, {
        postId: did,
        postUrl: `https://blog.51cto.com/blogger/draft/${did}`,
        draftOnly: true,
      })
    }

    // 正式发布：与官网一致，带 did + check=1；import_type 置空
    const publishData: Record<string, string> = {
      ...payload.postData,
      did,
      check: '1',
      import_type: '',
    }
    const pubRes = await this.postBloggerForm(
      'publish',
      publishData,
      payload.img_urls,
      `https://blog.51cto.com/blogger/draft/${did}`,
    )
    if (pubRes.status !== 1) {
      throw new Error(pubRes.msg || '发布失败')
    }

    const data = (pubRes.data ?? {}) as Record<string, unknown>
    const postId = String(data.blog_id ?? data.id ?? data.did ?? did)
    const authorId = this.authorId || ''
    // 正式文章页：https://blog.51cto.com/{author_id}/{id}
    let postUrl =
      authorId && postId
        ? `https://blog.51cto.com/${authorId}/${postId}`
        : `https://blog.51cto.com/blogger/draft/${did}`
    // 若接口直接返回完整文章 URL 且形态正确，优先用之
    for (const key of ['url', 'blog_url', 'article_url'] as const) {
      const v = data[key]
      if (typeof v === 'string' && /blog\.51cto\.com\/[^/]+\/\d+/.test(v)) {
        postUrl = v.startsWith('http') ? v : `https://${v.replace(/^\/\//, '')}`
        break
      }
    }

    return this.createResult(true, {
      postId,
      postUrl,
      draftOnly: false,
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
        Referer: 'https://blog.51cto.com/blogger/publish',
        Origin: 'https://blog.51cto.com',
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
    filename: string,
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
    file: File,
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
