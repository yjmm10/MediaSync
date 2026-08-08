/**
 * 博客园 (cnblogs.com) 适配器（PipelineAdapter 实现）
 *
 * 行为：XSRF-TOKEN + 图片 CORS 上传 + api/posts 创建草稿/发布。
 * 鉴权：SwHtmlAuthStrategy 拉 CurrentUserInfo。
 * 选项源：fetchPublishRefs 仅供设置/同步折叠「手动更新」调用，发布路径不自动拉列表。
 */
import { PipelineAdapter, type PublishContext, type PublishRefs } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import type { PublishParams } from '../publish-params'
import { SwHtmlAuthStrategy } from '../auth-strategy'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cnblogs')

/** 博客园访问权限 → accessPermission */
const CNBLOGS_ACCESS: Record<string, number> = {
  public: 0,
  followers: 8,
  private: 268435456,
}

/** 博客园题图/图床：仅认自家域名，外链会触发接口「无效的url链接」 */
export function isCnblogsHostedUrl(url: string): boolean {
  if (!url || !/^https?:\/\//i.test(url.trim())) return false
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    return host === 'cnblogs.com' || host.endsWith('.cnblogs.com')
  } catch {
    return /cnblogs\.com/i.test(url)
  }
}

/**
 * 从 markdown/html 提取首张博客园图床 http(s) 图（SW 无 DOM，正则）。
 * 外链不返回，避免写入 featuredImage 被接口拒绝。
 */
export function extractFirstImageUrl(markdown?: string, html?: string): string | undefined {
  const candidates: string[] = []
  // 优先 markdown（uploadImages 后已是图床 URL）；html 可能仍是外链
  if (markdown) {
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      candidates.push(m[1].trim().replace(/^<|>$/g, '').split(/\s+/)[0])
    }
  }
  if (html) {
    const re = /<img[^>]+src=["']([^"']+)["']/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) candidates.push(m[1])
  }
  return candidates.find((c) => isCnblogsHostedUrl(c))
}

export class CnblogsAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'cnblogs',
    name: '博客园',
    icon: 'https://www.cnblogs.com/favicon.ico',
    homepage: 'https://www.cnblogs.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 博客园使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  readonly publishDefaults: PublishParams = {
    mode: 'draft',
    commentsEnabled: true,
    visibility: 'public',
    cover: 'auto',
    extra: {
      displayOnHomePage: false,
      pinned: false,
      isAigc: false,
      postType: 2,
    },
  }

  /** 配置 Schema（声明式，UI 据此渲染） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签', suggestionsKey: 'tagSuggestions' },
      { kind: 'category', key: 'category', label: '个人分类', source: 'remote' },
      {
        kind: 'column',
        key: 'columns',
        label: '合集',
        source: 'remote',
        selectMode: 'multi',
      },
      { kind: 'cover', key: 'cover', label: '题图', modes: ['auto', 'none'] },
      { kind: 'summary', key: 'summary', label: '摘要' },
      {
        kind: 'visibility',
        key: 'visibility',
        label: '访问权限',
        options: [
          { value: 'public', label: '公开' },
          { value: 'followers', label: '仅登录用户' },
          { value: 'private', label: '只有我' },
        ],
      },
      { kind: 'comments', key: 'commentsEnabled', label: '允许评论' },
      { kind: 'schedule', key: 'scheduleAt', label: '定时发布', enabled: true },
      { kind: 'toggle', key: 'extra.pinned', label: '置顶' },
      { kind: 'toggle', key: 'extra.displayOnHomePage', label: '博客主页显示' },
      { kind: 'toggle', key: 'extra.isAigc', label: '内容由AI生成' },
      { kind: 'text', key: 'extra.password', label: '密码保护', placeholder: '可选' },
      { kind: 'text', key: 'extra.entryName', label: 'Slug', placeholder: '友好地址名（可选）' },
    ],
    groups: [
      {
        title: '基本设置',
        fields: ['category', 'columns', 'tags', 'summary', 'cover'],
        defaultOpen: true,
      },
      {
        title: '高级选项',
        fields: [
          'visibility',
          'commentsEnabled',
          'scheduleAt',
          'extra.pinned',
          'extra.displayOnHomePage',
          'extra.isAigc',
          'extra.password',
          'extra.entryName',
        ],
        defaultOpen: false,
      },
    ],
  }

  /** 鉴权策略：SW 拉 CurrentUserInfo 页面 HTML 正则提取登录态 */
  protected readonly authStrategies = [
    new SwHtmlAuthStrategy({
      url: 'https://home.cnblogs.com/user/CurrentUserInfo',
      extract: (html): AuthResult | null => {
        const avatarMatch = html.match(/<img[^>]+class="pfs"[^>]+src="([^"]+)"/)
        const linkMatch = html.match(/href="\/u\/([^/]+)\/"/)
        if (!linkMatch) return { isAuthenticated: false }
        const uid = linkMatch[1]
        return {
          isAuthenticated: true,
          userId: uid,
          username: uid,
          avatar: avatarMatch ? avatarMatch[1] : undefined,
        }
      },
    }),
  ]

  private xsrfToken: string | null = null
  /** 博客地址名，用于拼公开文章 URL */
  private blogApp: string | null = null

  /** 博客园 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://i.cnblogs.com/*',
      headers: {
        'Origin': 'https://i.cnblogs.com',
        'Referer': 'https://i.cnblogs.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://upload.cnblogs.com/*',
      headers: {
        'Origin': 'https://i.cnblogs.com',
        'Referer': 'https://i.cnblogs.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ 选项源（仅手动刷新）============

  /**
   * 拉取个人分类 + 合集 + 标签建议（设置/同步折叠「平台更新」按钮调用）。
   * 发布管道不自动调用。
   */
  async fetchPublishRefs(): Promise<PublishRefs> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const [categories, columns, tagSuggestions] = await Promise.all([
        this.fetchCategories(),
        this.fetchCollections(),
        this.fetchTagSuggestions(),
      ])
      return { categories, columns, tagSuggestions }
    })
  }

  private async fetchCategories(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.runtime.fetch(
      'https://i.cnblogs.com/api/v2/blog-category-types/2/categories?parent=',
      { method: 'GET', credentials: 'include' },
    )
    if (!response.ok) {
      throw new Error(`拉取个人分类失败: ${response.status}`)
    }
    const data = (await response.json()) as {
      categories?: Array<{ categoryId?: number; id?: number; title?: string }>
    }
    const list = data.categories ?? []
    return list
      .map((c) => {
        const id = c.categoryId ?? c.id
        if (id == null || !c.title) return null
        return { id: String(id), name: c.title }
      })
      .filter((x): x is { id: string; name: string } => x != null)
  }

  private async fetchCollections(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.runtime.fetch('https://i.cnblogs.com/api/collections', {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`拉取合集失败: ${response.status}`)
    }
    const data = (await response.json()) as {
      items?: Array<{ id?: number; title?: string }>
    }
    const list = data.items ?? []
    return list
      .map((c) => {
        if (c.id == null || !c.title) return null
        return { id: String(c.id), name: c.title }
      })
      .filter((x): x is { id: string; name: string } => x != null)
  }

  /** 合集参数：已是数字 id 则直用；否则按名称匹配合集列表 */
  private async resolveCollectionIds(raw: string[]): Promise<number[]> {
    if (raw.length === 0) return []
    const asNumbers = raw.map((id) => Number(id))
    if (asNumbers.every((n) => !Number.isNaN(n))) {
      return asNumbers
    }
    let cols: Array<{ id: string; name: string }> = []
    try {
      cols = await this.fetchCollections()
    } catch (e) {
      logger.warn('resolveCollectionIds: fetch collections failed', e)
      return asNumbers.filter((n) => !Number.isNaN(n))
    }
    const ids: number[] = []
    for (const item of raw) {
      const n = Number(item)
      if (!Number.isNaN(n)) {
        ids.push(n)
        continue
      }
      const lower = item.trim().toLowerCase()
      const hit = cols.find(
        (c) => c.id === item || c.name.trim().toLowerCase() === lower,
      )
      if (hit) {
        const idNum = Number(hit.id)
        if (!Number.isNaN(idNum)) ids.push(idNum)
      } else {
        logger.warn('resolveCollectionIds: no match for', item)
      }
    }
    return ids
  }

  private async fetchTagSuggestions(): Promise<string[]> {
    const response = await this.runtime.fetch(
      'https://i.cnblogs.com/api/tags/list?excludeInUsing=false&excludeUnUsing=false',
      { method: 'GET', credentials: 'include' },
    )
    if (!response.ok) {
      throw new Error(`拉取标签失败: ${response.status}`)
    }
    const data = (await response.json()) as Array<{ name?: string }>
    if (!Array.isArray(data)) return []
    const names: string[] = []
    for (const t of data) {
      if (t.name && !names.includes(t.name)) names.push(t.name)
    }
    return names
  }

  private async ensureBlogApp(): Promise<string | null> {
    if (this.blogApp) return this.blogApp
    try {
      const response = await this.runtime.fetch('https://i.cnblogs.com/api/user', {
        method: 'GET',
        credentials: 'include',
      })
      if (!response.ok) return null
      const data = (await response.json()) as { blogApp?: string; alias?: string }
      this.blogApp = data.blogApp || data.alias || null
      return this.blogApp
    } catch (error) {
      logger.warn('Failed to get blogApp:', error)
      return null
    }
  }

  // ============ 管道钩子 ============

  // authorize / normalizeContent / resolveReferences 用基类默认（resolveReferences 空：不自动拉选项）

  /**
   * 3. 上传图片：在 Header 规则保护下获取 XSRF-TOKEN + SharedImageCache 去重上传
   */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const xsrfToken = await this.getXsrfToken()
      logger.info('XSRF-TOKEN:', xsrfToken ? `${xsrfToken.substring(0, 20)}...` : 'null')
      if (!xsrfToken) {
        throw new Error('获取 XSRF-TOKEN 失败，请刷新页面后重试')
      }
      this.xsrfToken = xsrfToken

      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, {
        skipPatterns: ['cnblogs.com', 'img2024.cnblogs.com', 'img2023.cnblogs.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      })
    })
  }

  /** 5. 构建创建草稿/发布请求体 */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const { params } = ctx
    const mode = params.mode ?? 'draft'
    const isPublish = mode === 'publish' || mode === 'schedule'
    const coverMode = params.cover ?? 'auto'
    let coverUrl = ''
    if (coverMode === 'none') {
      coverUrl = ''
    } else if (coverMode === 'auto') {
      // 题图只用博客园图床：优先转存后正文首图；FM cover 仅当已是 cnblogs 域名
      // 禁止回退未转存外链（会触发「无效的url链接」）
      const fromContent =
        extractFirstImageUrl(ctx.content.markdown, ctx.content.html) || ''
      const fromCover =
        ctx.article.cover && isCnblogsHostedUrl(ctx.article.cover)
          ? ctx.article.cover.trim()
          : ''
      coverUrl = fromContent || fromCover
    } else if (coverMode !== 'auto' && coverMode !== 'none') {
      coverUrl = isCnblogsHostedUrl(coverMode) ? coverMode.trim() : ''
      if (coverMode && !coverUrl) {
        logger.warn('featuredImage ignored non-cnblogs cover URL:', coverMode.slice(0, 120))
      }
    }
    logger.info('featuredImage resolve:', {
      coverMode,
      featuredImage: coverUrl || null,
      mdLen: ctx.content.markdown?.length ?? 0,
    })
    const visibility = params.visibility ?? 'public'
    const accessPermission = CNBLOGS_ACCESS[visibility] ?? 0
    const rawCollections = params.columns?.length
      ? params.columns
      : params.column
        ? [params.column]
        : []
    // FM/UI 可能传入合集名称；数字 id 直用，名称则拉列表解析（个人分类不走 FM）
    const collectionIds = await this.resolveCollectionIds(rawCollections)

    const password =
      typeof params.extra?.password === 'string' && params.extra.password
        ? params.extra.password
        : null
    const entryName =
      typeof params.extra?.entryName === 'string' && params.extra.entryName
        ? params.extra.entryName
        : null
    const postType =
      typeof params.extra?.postType === 'number' ? params.extra.postType : 2

    ctx.payload = {
      id: null,
      postType,
      accessPermission,
      title: ctx.article.title,
      url: null,
      postBody: ctx.content.markdown,
      categoryIds: (() => {
        if (!params.category) return null
        const id = Number(params.category)
        return Number.isNaN(id) ? null : [id]
      })(),
      categories: null,
      collectionIds,
      inSiteCandidate: false,
      inSiteHome: false,
      siteCategoryId: null,
      blogTeamIds: null,
      isPublished: isPublish,
      displayOnHomePage: Boolean(params.extra?.displayOnHomePage),
      isAllowComments: params.commentsEnabled ?? true,
      includeInMainSyndication: false,
      isPinned: Boolean(params.extra?.pinned),
      showBodyWhenPinned: false,
      isOnlyForRegisterUser: false,
      isUpdateDateAdded: false,
      entryName,
      description: params.summary ?? null,
      featuredImage: coverUrl || null,
      tags: params.tags ?? null,
      password,
      publishAt: params.scheduleAt ? new Date(params.scheduleAt).toISOString() : null,
      datePublished: new Date().toISOString(),
      dateUpdated: null,
      isMarkdown: true,
      isDraft: !isPublish,
      autoDesc: null,
      changePostType: false,
      blogId: 0,
      author: null,
      removeScript: false,
      clientInfo: null,
      changeCreatedTime: false,
      canChangeCreatedTime: false,
      isContributeToImpressiveBugActivity: false,
      usingEditorId: 5,
      sourceUrl: null,
      isAigc: Boolean(params.extra?.isAigc),
    }
  }

  /** 6. 提交：创建草稿/发布，返回结果 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    if (!this.xsrfToken) {
      throw new Error('XSRF-TOKEN 未获取')
    }

    const mode = ctx.params.mode ?? 'draft'
    const isPublish = mode === 'publish' || mode === 'schedule'

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-xsrf-token': this.xsrfToken,
    }
    logger.debug('Request headers:', JSON.stringify(headers))
    logger.debug('Markdown content length:', ctx.content.markdown.length)

    const response = await this.runtime.fetch('https://i.cnblogs.com/api/posts', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(ctx.payload),
    })

    const responseText = await response.text()
    logger.debug('Create post response:', response.status, responseText.substring(0, 300))

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('未登录或登录已过期，请重新登录博客园')
      }
      throw new Error(`创建失败: ${response.status} - ${responseText}`)
    }

    let responseData: { id?: number; blogId?: number; error?: string }
    try {
      responseData = JSON.parse(responseText)
    } catch {
      throw new Error(`创建失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }

    if (!responseData.id) {
      throw new Error(responseData.error || '创建失败: 无效响应')
    }

    const postId = String(responseData.id)
    let postUrl = `https://i.cnblogs.com/articles/edit;postId=${postId}`
    if (isPublish) {
      const blogApp = await this.ensureBlogApp()
      if (blogApp) {
        postUrl = `https://www.cnblogs.com/${blogApp}/articles/${postId}`
      }
    }
    logger.debug('Post created:', postId, 'publish=', isPublish, 'url=', postUrl)

    return this.createResult(true, {
      postId,
      postUrl,
      draftOnly: !isPublish,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ XSRF-TOKEN 与图片上传 ============

  private async getXsrfToken(): Promise<string | null> {
    if (this.xsrfToken) {
      return this.xsrfToken
    }

    try {
      await this.runtime.fetch('https://i.cnblogs.com/posts/edit', {
        method: 'GET',
        credentials: 'include',
      })

      if (this.runtime.getCookie) {
        logger.debug('Trying to get XSRF-TOKEN via getCookie API...')
        const domains = ['i.cnblogs.com', '.cnblogs.com', 'cnblogs.com']
        for (const domain of domains) {
          const value = await this.runtime.getCookie(domain, 'XSRF-TOKEN')
          logger.debug(`getCookie ${domain} result:`, value ? `${value.substring(0, 30)}...` : 'null')
          if (value) {
            this.xsrfToken = value
            logger.debug('Got XSRF-TOKEN from cookies API')
            return this.xsrfToken
          }
        }
      } else {
        logger.warn('getCookie API not available')
      }

      logger.warn('Could not find XSRF-TOKEN')
      return null
    } catch (error) {
      logger.error('Failed to get XSRF-TOKEN:', error)
      return null
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.xsrfToken) {
      throw new Error('XSRF-TOKEN 未获取')
    }

    // 使用 runtime.fetch 而非全局 fetch：扩展环境会自动携带 cookie，
    // 并能绕过外链图片的防盗链/CORS 限制。全局 fetch 在 service worker
    // 中抓取跨域外链图片会失败，导致图片无法转存、发布后不显示。
    const imageResponse = await this.runtime.fetch(src, {
      credentials: 'include',
    })
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('image', imageBlob, 'image.png')
    formData.append('app', 'blog')
    formData.append('uploadType', 'Select')

    const uploadResponse = await this.runtime.fetch(
      'https://upload.cnblogs.com/v2/images/cors-upload',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-xsrf-token': this.xsrfToken,
        },
        body: formData,
      },
    )

    const responseText = await uploadResponse.text()
    logger.debug('Image upload raw response:', responseText)

    if (!uploadResponse.ok) {
      throw new Error(`图片上传失败: ${uploadResponse.status} - ${responseText}`)
    }

    let res: Record<string, unknown>
    try {
      res = JSON.parse(responseText)
    } catch {
      throw new Error(`图片上传失败: 响应不是 JSON - ${responseText.substring(0, 100)}`)
    }

    logger.debug('Image upload parsed response:', JSON.stringify(res))

    const imageUrl = res.data || res.url || res.imageUrl || res.src
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new Error(`图片上传失败: 无法获取图片 URL - ${JSON.stringify(res)}`)
    }

    logger.info('Image uploaded:', imageUrl)
    return {
      url: imageUrl,
    }
  }
}
