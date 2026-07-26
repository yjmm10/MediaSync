/**
 * Reddit 适配器（Cookie 鉴权）
 *
 * 接口来自登录态真实抓包（shreddit GraphQL）：
 * - 鉴权：GET /api/me.json
 * - CSRF：cookie csrf_token → body.csrf_token
 * - 传图：BatchCreateMediaUploadLease → S3 → mediaId（见 REDDIT_IMAGES_ENABLED）
 * - 就绪：ValidateCreatePostInput(IMAGE+gallery) 轮询后再建草稿
 * - 草稿：CreateDraft kind=RICHTEXT + content.richText（document 内混插 img）
 *
 * 默认目标：个人 profile（me.subreddit.name = t5_...）
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { parseMarkdownImages } from '../../lib/markdown-images'

const logger = createLogger('Reddit')

/**
 * 临时关闭 Reddit 图片：只发纯文字 RICHTEXT，跳过 Lease/S3/混插/就绪轮询。
 * 后续验证通过后改为 true 即可恢复。
 */
const REDDIT_IMAGES_ENABLED = false

const TITLE_MAX = 300
const HOME = 'https://www.reddit.com'
const GRAPHQL = `${HOME}/svc/shreddit/graphql`
const LOGIN_HINT = HOME
const GRAPHQL_FETCH_RETRIES = 3
/** S3 后轮询 Validate，避免 RICHTEXT 引用未转码完的 mediaId */
const MEDIA_READY_ATTEMPTS = 15
const MEDIA_READY_INTERVAL_MS = 1500
/** 就绪成功后再稍等，降低编辑器仍显示 Unable to display 的概率 */
const POST_READY_BUFFER_MS = 400
const GRAPHQL_RETRY_DELAYS_MS = [800, 2000, 4000]

function isRetriableFetchError(error: unknown): boolean {
  const msg = ((error as Error)?.message || String(error)).toLowerCase()
  const name = ((error as Error)?.name || '').toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('load failed') ||
    msg.includes('fetch failed') ||
    (name === 'typeerror' && msg.includes('fetch'))
  )
}

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
  websocketUrl?: string
}

/** shreddit richText document 节点（抓包字段） */
type RichNode =
  | { e: 'h'; l: number; c: Array<{ e: 'raw'; t: string }> }
  | { e: 'par'; c: Array<{ e: 'text'; t: string }> }
  | { e: 'img'; id: string }

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
  if (url.startsWith('data:')) {
    const ext =
      mime.includes('png') ? 'png' :
      mime.includes('gif') ? 'gif' :
      mime.includes('webp') ? 'webp' : 'jpg'
    return `image-${Date.now()}.${ext}`
  }
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

/** ValidateCreatePostInput / 历史 IMAGE 草稿用的 gallery 结构 */
function galleryItems(mediaIds: string[]): { items: Array<{ mediaId: string }> } {
  return { items: mediaIds.map((mediaId) => ({ mediaId })) }
}

/** 纯文本块 → h / par 节点（列表/表格等降级为段落） */
function textBlockToRichNodes(block: string): RichNode[] {
  const nodes: RichNode[] = []
  const lines = block.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []

  const flushPara = () => {
    const t = para.join('\n').trim()
    para = []
    if (t) {
      nodes.push({ e: 'par', c: [{ e: 'text', t }] })
    }
  }

  for (const line of lines) {
    const hm = line.match(/^(#{1,6})\s+(.+)$/)
    if (hm) {
      flushPara()
      nodes.push({
        e: 'h',
        l: hm[1].length,
        c: [{ e: 'raw', t: hm[2].trim() }],
      })
      continue
    }
    if (!line.trim()) {
      flushPara()
      continue
    }
    // 去掉简单 markdown 强调标记，避免原样塞进 richtext
    para.push(
      line
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
    )
  }
  flushPara()
  return nodes
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
      const content = (article.markdown || article.html || '').trim()
      if (!content) {
        return {
          platform: this.meta.id,
          success: false,
          error: '文章内容为空',
          timestamp: now,
        }
      }

      // markdown → richText document（图按位置上传为 mediaId）
      const document = await this.buildRichTextDocument(content, options)
      const mediaIds = document
        .filter((n): n is { e: 'img'; id: string } => n.e === 'img' && !!n.id)
        .map((n) => n.id)

      if (mediaIds.length > 0) {
        await this.waitMediaReady({ title, subredditId, mediaIds })
        await this.delay(POST_READY_BUFFER_MS)
      }
      await this.prepareWriteSession()

      const draft = await this.createRichTextDraft({
        title,
        subredditId,
        document,
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
   * 本地/远程/data URI → Lease → S3 → mediaId（供 richText img.id）
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    if (!REDDIT_IMAGES_ENABLED) {
      throw new Error('Reddit 图片上传已暂时关闭')
    }

    let blob: Blob
    if (url.startsWith('data:')) {
      blob = await this.dataUriToBlob(url)
    } else {
      const imageResponse = await this.runtime.fetch(url, { credentials: 'omit' })
      if (!imageResponse.ok) {
        throw new Error(`下载图片失败: HTTP ${imageResponse.status}`)
      }
      blob = await imageResponse.blob()
    }
    const mime = blob.type || 'image/jpeg'
    const filename = guessFilename(url, mime)
    const redditMime = mimeToRedditType(mime, filename)

    const lease = await this.createMediaLease(redditMime, blob.size)
    await this.uploadToS3(lease, blob, filename)

    this.uploadedMediaIds.push(lease.mediaId)
    return { url: lease.mediaId }
  }

  /**
   * 按 markdown 中图片出现顺序切分，上传后生成 RICHTEXT document。
   * REDDIT_IMAGES_ENABLED=false 时丢弃图片，只保留文字节点。
   */
  private async buildRichTextDocument(
    content: string,
    options?: PublishOptions
  ): Promise<RichNode[]> {
    // HTML 正文：先把 <img> 转成 markdown 图语法，便于统一切分
    let md = content
    if (/<img\b/i.test(md) && !/!\[[^\]]*\]\(/.test(md)) {
      md = md.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (_m, src: string) => `![](${src})`)
      md = md.replace(/<[^>]+>/g, '')
    }

    const images = parseMarkdownImages(md)
    const segments: Array<{ type: 'text'; value: string } | { type: 'image'; src: string }> = []
    let cursor = 0
    for (const img of images) {
      const idx = md.indexOf(img.full, cursor)
      if (idx === -1) continue
      if (idx > cursor) {
        segments.push({ type: 'text', value: md.slice(cursor, idx) })
      }
      segments.push({ type: 'image', src: img.src })
      cursor = idx + img.full.length
    }
    if (cursor < md.length) {
      segments.push({ type: 'text', value: md.slice(cursor) })
    }
    if (segments.length === 0) {
      segments.push({ type: 'text', value: md })
    }

    const imageSegs = segments.filter((s) => s.type === 'image') as Array<{ type: 'image'; src: string }>
    const total = imageSegs.length
    let processed = 0
    const seen = new Map<string, string>()
    const document: RichNode[] = []

    if (!REDDIT_IMAGES_ENABLED && total > 0) {
      logger.info(`Reddit 图片已暂时关闭，跳过 ${total} 张图，仅同步文字`)
    }

    for (const seg of segments) {
      if (seg.type === 'text') {
        document.push(...textBlockToRichNodes(seg.value))
        continue
      }

      processed++
      options?.onImageProgress?.(processed, total)
      if (!REDDIT_IMAGES_ENABLED || !seg.src) continue

      try {
        let mediaId = seen.get(seg.src)
        if (!mediaId) {
          const up = await this.uploadImageByUrl(seg.src)
          mediaId = up.url
          seen.set(seg.src, mediaId)
        }
        document.push({ e: 'img', id: mediaId })
      } catch (e) {
        logger.warn('Reddit 图片上传失败，跳过该图:', seg.src.slice(0, 80), e)
      }
    }

    if (document.length === 0) {
      throw new Error('转换 RICHTEXT 后正文为空')
    }
    return document
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

  private async prepareWriteSession(): Promise<void> {
    this.cachedCsrf = null
    try {
      const response = await this.runtime.fetch(`${HOME}/api/me.json`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (response.ok) {
        const data = (await response.json()) as RedditMeResponse
        if (data?.data?.name) {
          this.cachedMe = data.data
        }
      }
    } catch (e) {
      logger.warn('写草稿前 me.json 探活失败，继续尝试 GraphQL:', e)
    }
  }

  private async postGraphql<T = GraphQLEnvelope>(
    operation: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const raw = await this.postGraphqlRaw(operation, variables)
    const envelope = raw.json
    const err = formatGraphqlErrors(envelope)
    if (err) {
      throw new Error(`${operation} 失败: ${err}`)
    }
    if (!raw.ok) {
      throw new Error(`${operation} HTTP ${raw.status}: ${raw.text.slice(0, 300)}`)
    }
    return envelope as T
  }

  private async postGraphqlRaw(
    operation: string,
    variables: Record<string, unknown>
  ): Promise<{ json: GraphQLEnvelope; ok: boolean; status: number; text: string }> {
    let lastError: unknown
    for (let attempt = 1; attempt <= GRAPHQL_FETCH_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          this.cachedCsrf = null
        }
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
        let json: GraphQLEnvelope
        try {
          json = JSON.parse(text) as GraphQLEnvelope
        } catch {
          throw new Error(
            `${operation} 响应非 JSON: HTTP ${response.status} ${text.slice(0, 120)}`
          )
        }
        return { json, ok: response.ok, status: response.status, text }
      } catch (error) {
        lastError = error
        if (!isRetriableFetchError(error) || attempt >= GRAPHQL_FETCH_RETRIES) {
          throw error
        }
        const wait = GRAPHQL_RETRY_DELAYS_MS[attempt - 1] ?? 4000
        logger.warn(
          `${operation} 网络失败，${wait}ms 后重试 (${attempt}/${GRAPHQL_FETCH_RETRIES}):`,
          (error as Error).message
        )
        await this.delay(wait)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async createMediaLease(mimeType: string, totalFileSize: number): Promise<MediaLease> {
    const res = await this.postGraphql<{
      data?: {
        batchCreateMediaUploadLease?: {
          ok?: boolean
          errors?: unknown
          leases?: Array<{
            mediaId?: string
            websocketUrl?: string
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

    return {
      mediaId,
      uploadUrl,
      uploadHeaders,
      websocketUrl: item.websocketUrl,
    }
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

  /**
   * S3 后轮询 ValidateCreatePostInput，直到 media 可被 IMAGE/gallery 接受。
   * 超时则抛错，禁止带着未就绪 mediaId 走 CreateDraft(RICHTEXT)。
   */
  private async waitMediaReady(params: {
    title: string
    subredditId: string
    mediaIds: string[]
  }): Promise<void> {
    if (params.mediaIds.length === 0) return

    const input = {
      postType: 'IMAGE',
      isNsfw: false,
      isSpoiler: false,
      content: { markdown: '.' },
      title: params.title,
      subredditId: params.subredditId,
      gallery: galleryItems(params.mediaIds),
    }

    for (let i = 1; i <= MEDIA_READY_ATTEMPTS; i++) {
      try {
        const { json, ok, status } = await this.postGraphqlRaw('ValidateCreatePostInput', {
          input,
        })
        const topErr = formatGraphqlErrors(json)
        const payload = json.data?.validateCreatePostInput as
          | { ok?: boolean; errors?: unknown }
          | undefined

        const ready =
          ok &&
          !topErr &&
          (payload?.ok === true || (payload?.ok === undefined && !payload?.errors))

        const softOk =
          ok && !topErr && status === 200 && !(payload && payload.ok === false)

        if (ready || softOk) {
          logger.debug(
            `ValidateCreatePostInput ready attempt ${i}/${MEDIA_READY_ATTEMPTS}, media=${params.mediaIds.length}`
          )
          return
        }
        logger.debug(
          `ValidateCreatePostInput not ready (${i}/${MEDIA_READY_ATTEMPTS}):`,
          payload?.errors || topErr || status
        )
      } catch (e) {
        logger.debug(`ValidateCreatePostInput attempt ${i} error:`, e)
      }
      if (i < MEDIA_READY_ATTEMPTS) {
        await this.delay(MEDIA_READY_INTERVAL_MS)
      }
    }

    throw new Error(
      `Reddit 图片处理超时（已等待约 ${Math.round((MEDIA_READY_ATTEMPTS * MEDIA_READY_INTERVAL_MS) / 1000)} 秒），请稍后重试或减少图片后同步`
    )
  }

  /** 抓包验证：kind=RICHTEXT + content.richText(document) */
  private async createRichTextDraft(params: {
    title: string
    subredditId: string
    document: RichNode[]
  }): Promise<{ id: string }> {
    const richText = JSON.stringify({ document: params.document })
    const res = await this.postGraphql<{
      data?: {
        createPostDraft?: {
          ok?: boolean
          errors?: unknown
          postDraft?: { id?: string }
        }
      }
    }>('CreateDraft', {
      input: {
        isNsfw: false,
        isSpoiler: false,
        content: { richText },
        kind: 'RICHTEXT',
        title: params.title,
        subredditId: params.subredditId,
      },
    })

    const created = res.data?.createPostDraft
    if (!created?.ok || !created.postDraft?.id) {
      throw new Error(
        `CreateDraft(RICHTEXT) 失败: ${JSON.stringify(created?.errors || created || res)}`
      )
    }
    logger.info('CreateDraft RICHTEXT ok:', created.postDraft.id)
    return { id: created.postDraft.id }
  }
}
