/**
 * 博客园 (cnblogs.com) 适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：XSRF-TOKEN 获取 + 图片 CORS 上传 + api/posts 创建草稿全部保留。
 *
 * 鉴权策略化：SwHtmlAuthStrategy 拉 CurrentUserInfo 页面正则提取登录态。
 * Header 规则拆分：uploadImages 钩子内包一次 + submit 外层管道自动包一次。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { SwHtmlAuthStrategy } from '../auth-strategy'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cnblogs')

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

  /** 配置 Schema（声明式，UI 据此渲染；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      { kind: 'column', key: 'column', label: '合集', source: 'remote' },
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
      {
        kind: 'visibility',
        key: 'visibility',
        label: '可见性',
        options: [
          { value: 'public', label: '公开' },
          { value: 'private', label: '仅自己可见' },
          { value: 'password', label: '密码访问' },
        ],
      },
      { kind: 'comments', key: 'commentsEnabled', label: '允许评论' },
      { kind: 'activity', key: 'activityId', label: '活动', source: 'remote' },
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

  // ============ 管道钩子 ============

  // authorize / normalizeContent / resolveReferences 用基类默认

  /**
   * 3. 上传图片：在 Header 规则保护下获取 XSRF-TOKEN + SharedImageCache 去重上传
   *    博客园只用 markdown
   */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      // 1. 获取 XSRF-TOKEN（在 header rules 内，与原 publish 顺序一致）
      const xsrfToken = await this.getXsrfToken()
      logger.info('XSRF-TOKEN:', xsrfToken ? `${xsrfToken.substring(0, 20)}...` : 'null')
      if (!xsrfToken) {
        throw new Error('获取 XSRF-TOKEN 失败，请刷新页面后重试')
      }
      // 保存 xsrfToken 供 uploadImageByUrl / submit 使用
      this.xsrfToken = xsrfToken

      // 2. 处理图片上传
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

  /** 5. 构建创建草稿请求体（P2 写死保持等价；P3 读 ctx.params） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      id: null,
      postType: 2, // 2 = 文章, 1 = 随笔
      accessPermission: 0,
      title: ctx.article.title,
      url: null,
      postBody: ctx.content.markdown,
      categoryIds: null,
      categories: null,
      collectionIds: [],
      inSiteCandidate: false,
      inSiteHome: false,
      siteCategoryId: null,
      blogTeamIds: null,
      isPublished: false,
      displayOnHomePage: false,
      isAllowComments: true,
      includeInMainSyndication: false,
      isPinned: false,
      showBodyWhenPinned: false,
      isOnlyForRegisterUser: false,
      isUpdateDateAdded: false,
      entryName: null,
      description: null,
      featuredImage: null,
      tags: null,
      password: null,
      publishAt: null,
      datePublished: new Date().toISOString(),
      dateUpdated: null,
      isMarkdown: true,
      isDraft: true,
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
    }
  }

  /** 6. 提交：创建草稿，返回结果 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    if (!this.xsrfToken) {
      throw new Error('XSRF-TOKEN 未获取')
    }

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
      throw new Error(`创建草稿失败: ${response.status} - ${responseText}`)
    }

    let responseData: { id?: number; blogId?: number; error?: string }
    try {
      responseData = JSON.parse(responseText)
    } catch {
      throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }

    if (!responseData.id) {
      throw new Error(responseData.error || '创建草稿失败: 无效响应')
    }

    const postId = String(responseData.id)
    const draftUrl = `https://i.cnblogs.com/articles/edit;postId=${postId}`
    logger.debug('Draft created:', postId)

    return this.createResult(true, {
      postId,
      postUrl: draftUrl,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ XSRF-TOKEN 与图片上传（保持原样）============

  /**
   * 从 cookie 中获取 XSRF-TOKEN
   */
  private async getXsrfToken(): Promise<string | null> {
    if (this.xsrfToken) {
      return this.xsrfToken
    }

    try {
      // 先访问页面以触发 cookie 设置
      await this.runtime.fetch('https://i.cnblogs.com/posts/edit', {
        method: 'GET',
        credentials: 'include',
      })

      // 使用 cookies API 获取 XSRF-TOKEN
      if (this.runtime.getCookie) {
        logger.debug('Trying to get XSRF-TOKEN via getCookie API...')

        // 尝试不同的域名格式
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

  /**
   * 上传图片到博客园
   * 使用新版 CORS 上传接口
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.xsrfToken) {
      throw new Error('XSRF-TOKEN 未获取')
    }

    // 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    formData.append('image', imageBlob, 'image.png')
    formData.append('app', 'blog')
    formData.append('uploadType', 'Select')

    // 上传图片
    const uploadResponse = await this.runtime.fetch(
      'https://upload.cnblogs.com/v2/images/cors-upload',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-xsrf-token': this.xsrfToken,
        },
        body: formData,
      }
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

    // 尝试不同的响应格式
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
