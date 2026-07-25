/**
 * Reddit 适配器（Cookie 鉴权）
 *
 * 接口来自登录态真实抓包（shreddit GraphQL），非旧版 /api/v1/draft 臆测：
 * - 鉴权：GET /api/me.json
 * - CSRF：cookie csrf_token → body.csrf_token
 * - 草稿：POST /svc/shreddit/graphql  operation=CreateDraft（kind=MARKDOWN）
 * - 传图：BatchCreateMediaUploadLease → S3 POST → mediaId
 *
 * 默认目标：个人 profile（me.subreddit.name = t5_... / display_name = u_...）
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Reddit')

const TITLE_MAX = 300
const HOME = 'https://www.reddit.com'
const GRAPHQL = `${HOME}/svc/shreddit/graphql`
const LOGIN_HINT = HOME

interface RedditMeData {
  id?: string
  name?: string
  icon_img?: string
  subreddit?: {
    name?: string
    display_name?: string
    icon_img?: string
  }
}

interface RedditMeResponse {
  data?: RedditMeData
  kind?: string
}

interface GraphQLEnvelope {
  data?: Record<string, unknown>
  errors?: Array<{ message?: string } | string>
  operation?: string
}

interface UploadHeader {
  name: string
  value: string
}

interface MediaLease {
  mediaId: string
  uploadUrl: string
  uploadHeaders: UploadHeader[]
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function normalizeTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim()
  if (!title) {
    throw new Error('标题不能为空')
  }
  if (title.length > TITLE_MAX) {
    return title.slice(0, TITLE_MAX)
  }
  return title
}

function mimeToRedditType(mime: string, filename: string): string {
  const lower = (mime || '').toLowerCase()
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (lower.includes('png') || ext === 'png') return 'PNG'
  if (lower.includes('gif') || ext === 'gif') return 'GIF'
  if (lower.includes('webp') || ext === 'webp') return 'WEBP'
  if (lower.includes('jpeg') || lower.includes('jpg') || ext === 'jpg' || ext === 'jpeg') return 'JPG'
  return 'JPG'
}

function guessFilename(url: string, mime: string): string {
  const pathMatch = url.split('?')[0].match(/\/([^/]+\.(png|jpe?g|gif|webp))$/i)
  if (pathMatch?.[1]) return pathMatch[1]
  const ext =
    mime.includes('png') ? 'png' :
    mime.includes('gif') ? 'gif' :
    mime.includes('webp') ? 'webp' : 'jpg'
  return `image-${Date.now()}.${ext}`
}

function formatGraphqlErrors(res: GraphQLEnvelope): string | null {
  if (res.errors && res.errors.length > 0) {
    return res.errors
      .map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e)))
      .join('; ')
  }
  return null
}

export class RedditAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'reddit',
    name: 'Reddit',
    icon: 'https://www.redditstatic.com/desktop2x/img/favicon/favicon-32x32.png',
    homepage: HOME,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private cachedMe: RedditMeData | null = null
  private cachedCsrf: string | null = null
  /** 本次 publish 成功上传的 mediaId（供 IMAGE gallery 草稿） */
  private uploadedMediaIds: string[] = []

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.reddit.com/*',
      headers: {
        Origin: HOME,
        Referer: `${HOME}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://reddit-uploaded-media.s3-accelerate.amazonaws.com/*',
      headers: {
        Origin: HOME,
        Referer: `${HOME}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const me = await this.getMe()
        if (!me?.name) {
          return {
            isAuthenticated: false,
            error: `未登录 Reddit，请先在浏览器打开并登录 ${LOGIN_HINT}`,
          }
        }
        const icon = me.icon_img || me.subreddit?.icon_img
        return {
          isAuthenticated: true,
          userId: me.id,
          username: me.name,
          avatar: icon ? decodeBasicEntities(icon).split('?')[0] : undefined,
        }
      })
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const now = Date.now()
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      this.uploadedMediaIds = []

      const me = await this.getMe()
      if (!me?.name) {
        return {
          platform: this.meta.id,
          success: false,
          error: `未登录 Reddit，请先在浏览器打开并登录 ${LOGIN_HINT}`,
          timestamp: now,
        }
      }

      const subredditId = me.subreddit?.name
      if (!subredditId) {
        return {
          platform: this.meta.id,
          success: false,
          error: '无法解析个人 profile subredditId（t5_）',
          timestamp: now,
        }
      }

      const title = normalizeTitle(article.title || '')
      let content = (article.markdown || article.html || '').trim()
      if (!content) {
        return {
          platform: this.meta.id,
          success: false,
          error: '文章内容为空',
          timestamp: now,
        }
      }

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        { onProgress: options?.onImageProgress }
      )

      // 上传成功的 mediaId 已在 markdown 中；图文帖用 gallery，正文保留 markdown
      const mediaIds = [...this.uploadedMediaIds]
      const draft = await this.createDraft({
        title,
        markdown: content,
        subredditId,
        mediaIds,
      })

      return {
        platform: this.meta.id,
        success: true,
        postId: draft.id,
        postUrl: `${HOME}/user/${me.name}/submit/?draft=${draft.id}`,
        draftOnly: true,
        timestamp: now,
      }
    }).catch((error) => ({
      platform: this.meta.id,
      success: false,
      error: (error as Error).message,
      timestamp: now,
    }))
  }

  /**
   * 本地/远程图片 → Blob → BatchCreateMediaUploadLease → S3
   * 返回的 url 为 mediaId，便于正文占位；真正展示依赖 gallery（见 createDraft）
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    const imageResponse = await this.runtime.fetch(url, { credentials: 'omit' })
    if (!imageResponse.ok) {
      throw new Error(`下载图片失败: HTTP ${imageResponse.status}`)
    }
    const blob = await imageResponse.blob()
    const mime = blob.type || 'image/jpeg'
    const filename = guessFilename(url, mime)
    const redditMime = mimeToRedditType(mime, filename)

    const lease = await this.createMediaLease(redditMime, blob.size)
    await this.uploadToS3(lease, blob, filename)

    this.uploadedMediaIds.push(lease.mediaId)
    // markdown 占位；IMAGE 草稿同时走 gallery.items[].mediaId
    return { url: lease.mediaId }
  }

  private async getMe(): Promise<RedditMeData | null> {
    if (this.cachedMe?.name) {
      return this.cachedMe
    }

    const response = await this.runtime.fetch(`${HOME}/api/me.json`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as RedditMeResponse
    if (!data?.data?.name) {
      return null
    }

    this.cachedMe = data.data
    return this.cachedMe
  }

  private async getCsrfToken(): Promise<string> {
    if (this.cachedCsrf) {
      return this.cachedCsrf
    }

    const cookies = await this.runtime.cookies.get('reddit.com')
    const csrf = cookies.find((c) => c.name === 'csrf_token')?.value
    if (!csrf) {
      throw new Error('未找到 Reddit csrf_token cookie，请刷新 reddit.com 后重试')
    }

    this.cachedCsrf = csrf
    return csrf
  }

  private async postGraphql<T = GraphQLEnvelope>(
    operation: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const csrf = await this.getCsrfToken()
    const response = await this.runtime.fetch(GRAPHQL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operation,
        variables,
        csrf_token: csrf,
      }),
    })

    const text = await response.text()
    let res: GraphQLEnvelope
    try {
      res = JSON.parse(text) as GraphQLEnvelope
    } catch {
      throw new Error(`${operation} 响应非 JSON: ${text.slice(0, 300)}`)
    }

    const err = formatGraphqlErrors(res)
    if (err) {
      throw new Error(`${operation} 失败: ${err}`)
    }
    if (!response.ok) {
      throw new Error(`${operation} HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    return res as T
  }

  private async createMediaLease(mimeType: string, totalFileSize: number): Promise<MediaLease> {
    const res = await this.postGraphql<{
      data?: {
        batchCreateMediaUploadLease?: {
          ok?: boolean
          errors?: unknown
          leases?: Array<{
            mediaId?: string
            lease?: {
              uploadUrl?: string
              uploadHeaders?: UploadHeader[]
            }
          }>
        }
      }
    }>('BatchCreateMediaUploadLease', {
      input: {
        fileInputs: [
          {
            mimeType,
            totalFileSize,
            uploadStrategy: 'ADAPTIVE',
          },
        ],
      },
    })

    const batch = res.data?.batchCreateMediaUploadLease
    if (!batch?.ok) {
      throw new Error(`申请图片上传凭证失败: ${JSON.stringify(batch?.errors || batch)}`)
    }
    const item = batch.leases?.[0]
    const mediaId = item?.mediaId
    const uploadUrl = item?.lease?.uploadUrl
    const uploadHeaders = item?.lease?.uploadHeaders
    if (!mediaId || !uploadUrl || !uploadHeaders?.length) {
      throw new Error('上传凭证缺少 mediaId / uploadUrl / uploadHeaders')
    }

    return { mediaId, uploadUrl, uploadHeaders }
  }

  private async uploadToS3(lease: MediaLease, blob: Blob, filename: string): Promise<void> {
    const formData = new FormData()
    for (const h of lease.uploadHeaders) {
      formData.append(h.name, h.value)
    }
    formData.append('file', blob, filename)

    const res = await this.runtime.fetch(lease.uploadUrl, {
      method: 'POST',
      body: formData,
    })
    if (res.status !== 201 && !res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 上传失败: HTTP ${res.status} ${text.slice(0, 200)}`)
    }
  }

  private async createDraft(params: {
    title: string
    markdown: string
    subredditId: string
    mediaIds: string[]
  }): Promise<{ id: string }> {
    // 有原生上传图时走 IMAGE + gallery（与抓包 ValidateCreatePostInput 一致）；否则纯 MARKDOWN 草稿
    const hasMedia = params.mediaIds.length > 0

    const input: Record<string, unknown> = {
      isNsfw: false,
      isSpoiler: false,
      content: { markdown: params.markdown },
      kind: hasMedia ? 'IMAGE' : 'MARKDOWN',
      title: params.title,
      subredditId: params.subredditId,
    }

    if (hasMedia) {
      input.gallery = {
        items: params.mediaIds.map((mediaId) => ({ mediaId })),
      }
    }

    const res = await this.postGraphql<{
      data?: {
        createPostDraft?: {
          ok?: boolean
          errors?: unknown
          postDraft?: { id?: string }
        }
      }
    }>('CreateDraft', { input })

    const created = res.data?.createPostDraft
    if (!created?.ok || !created.postDraft?.id) {
      // IMAGE+gallery 若不被 CreateDraft 接受，回退纯文字草稿（已验证）
      if (hasMedia) {
        logger.warn('CreateDraft IMAGE+gallery failed, fallback MARKDOWN:', created?.errors || created)
        return this.createDraft({
          ...params,
          mediaIds: [],
        })
      }
      throw new Error(`创建草稿失败: ${JSON.stringify(created?.errors || created || res)}`)
    }

    return { id: created.postDraft.id }
  }
}
