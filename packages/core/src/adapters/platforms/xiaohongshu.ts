/**
 * 小红书适配器（创作者中心 · 长文草稿）
 *
 * 写作台：https://creator.xiaohongshu.com/publish/publish?...&target=article
 *
 * 流程（对齐 OpenCLI draft-database-v1 / article-draft，抓包校准 2026-07）：
 * 1. 打开 creator 域 tab（页面上下文可调用 window._webmsxyw 生成 X-s / X-t）
 * 2. 页面签名取 permit → Service Worker PUT ros-upload → 响应头 x-ros-preview-url
 *    （大图不经 executeScript 传 base64，避免序列化失败）
 * 3. HTML → ProseMirror richJson，写入 IndexedDB draft-database-v1 / article-draft
 *
 * 默认仅草稿；正式发布需用户在创作者中心手动完成。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Xiaohongshu')

const ARTICLE_URL =
  'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=article'
const PAGE_PATTERN = 'https://creator.xiaohongshu.com/*'
/** 同步完成后打开写长文入口并带 _s，由 content script 提示去草稿箱查看 */
const POST_SUCCESS_URL = `${ARTICLE_URL}&_s=1`
const USER_INFO_URL = 'https://creator.xiaohongshu.com/api/galaxy/user/info'
const PERMIT_PATH =
  '/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web'

/** 长文标题上限（编辑器 0/64） */
const TITLE_MAX = 64
/** 正文软上限（CHANGELOG / 产品文案约 1 万字） */
const CONTENT_MAX = 10000
/** 编辑器内图片默认展示宽度 */
const IMAGE_DISPLAY_WIDTH = 410

interface XhsUserInfo {
  userId?: string
  userName?: string
  userAvatar?: string
}

interface XhsApiResponse<T = unknown> {
  code?: number
  success?: boolean
  result?: number
  msg?: string
  message?: string
  data?: T
}

interface RichTextNode {
  type: string
  text?: string
  content?: RichTextNode[]
  attrs?: Record<string, unknown>
}

interface UploadedImageMeta {
  src: string
  width: number
  height: number
}

interface PageAuthResult {
  ok: boolean
  user?: XhsUserInfo
  error?: string
}

interface PageDraftWriteResult {
  ok: boolean
  draftId?: string
  error?: string
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTags(html: string): string {
  return decodeBasicEntities(html.replace(/<[^>]+>/g, '')).trim()
}

function makeDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function guessMime(blob: Blob, src: string): string {
  const type = (blob.type || '').toLowerCase()
  if (type.startsWith('image/')) return type
  const m = src.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/)
  const ext = (m?.[1] || 'png').toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

/**
 * Service Worker 无 DOM：HTML → 小红书长文 ProseMirror richJson
 * 图片节点形状（抓包）：{ type:'image', attrs:{ imgs:[{ src, width, height, percent, desc }] } }
 */
function htmlToRichJson(html: string, imageMeta: Map<string, UploadedImageMeta>): RichTextNode {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .trim()

  const content: RichTextNode[] = []

  const pushParagraph = (raw: string): void => {
    const text = stripTags(raw).replace(/\s+/g, ' ').trim()
    if (!text) return
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })
  }

  const pushImage = (src: string, widthAttr: number, heightAttr: number): void => {
    if (!src) return
    const meta = imageMeta.get(src)
    let width = meta?.width || widthAttr || IMAGE_DISPLAY_WIDTH
    let height = meta?.height || heightAttr || IMAGE_DISPLAY_WIDTH
    if (width > 0 && height > 0 && width !== IMAGE_DISPLAY_WIDTH) {
      height = Math.max(1, Math.round((height * IMAGE_DISPLAY_WIDTH) / width))
      width = IMAGE_DISPLAY_WIDTH
    } else if (width <= 0) {
      width = IMAGE_DISPLAY_WIDTH
      height = height > 0 ? height : IMAGE_DISPLAY_WIDTH
    }
    content.push({
      type: 'image',
      attrs: {
        imgs: [
          {
            src,
            width,
            height,
            percent: 0,
            desc: '',
          },
        ],
      },
    })
  }

  const appendFragment = (fragment: string): void => {
    const trimmed = fragment.trim()
    if (!trimmed) return
    const imgRe = /<img\b[^>]*>/gi
    let m: RegExpExecArray | null
    let cursor = 0
    while ((m = imgRe.exec(trimmed)) !== null) {
      if (m.index > cursor) pushParagraph(trimmed.slice(cursor, m.index))
      const tag = m[0]
      const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || ''
      const width = parseInt(tag.match(/\b(?:data-w|width)=["']?(\d+)/i)?.[1] || '0', 10) || 0
      const height = parseInt(tag.match(/\b(?:data-h|height)=["']?(\d+)/i)?.[1] || '0', 10) || 0
      pushImage(src, width, height)
      cursor = imgRe.lastIndex
    }
    if (cursor < trimmed.length) pushParagraph(trimmed.slice(cursor))
  }

  const blockRe = /<(p|div|h[1-6]|li|blockquote|pre|figure|section)([^>]*)>([\s\S]*?)<\/\1\s*>/gi
  let match: RegExpExecArray | null
  let lastIdx = 0
  let matched = false
  while ((match = blockRe.exec(cleaned)) !== null) {
    matched = true
    if (match.index > lastIdx) appendFragment(cleaned.slice(lastIdx, match.index))
    appendFragment(match[3] || '')
    lastIdx = blockRe.lastIndex
  }
  if (lastIdx < cleaned.length) appendFragment(cleaned.slice(lastIdx))
  if (!matched) appendFragment(cleaned)

  if (content.length === 0) {
    content.push({ type: 'paragraph' })
  }
  return { type: 'doc', content }
}

function countRichTextChars(doc: RichTextNode): number {
  let n = 0
  const walk = (node: RichTextNode): void => {
    if (node.type === 'text' && node.text) n += node.text.length
    if (node.content) node.content.forEach(walk)
  }
  walk(doc)
  return n
}

/**
 * 按字数上限截断 richJson：保留靠前的段落/图片，超出部分丢弃；
 * 落在文本节点中间则对该节点 slice。
 */
function truncateRichJson(doc: RichTextNode, maxChars: number): RichTextNode {
  if (maxChars <= 0) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }
  if (countRichTextChars(doc) <= maxChars) return doc

  let remaining = maxChars
  const out: RichTextNode[] = []

  for (const block of doc.content || []) {
    if (remaining <= 0) break

    if (block.type === 'image') {
      out.push(block)
      continue
    }

    if (block.type === 'paragraph') {
      const children = block.content || []
      if (children.length === 0) {
        out.push({ type: 'paragraph' })
        continue
      }
      const kept: RichTextNode[] = []
      for (const child of children) {
        if (remaining <= 0) break
        if (child.type === 'text' && child.text) {
          if (child.text.length <= remaining) {
            kept.push(child)
            remaining -= child.text.length
          } else {
            kept.push({ type: 'text', text: child.text.slice(0, remaining) })
            remaining = 0
          }
        } else {
          kept.push(child)
        }
      }
      if (kept.length > 0) {
        out.push({ type: 'paragraph', content: kept })
      }
      continue
    }

    out.push(block)
  }

  if (out.length === 0) {
    out.push({ type: 'paragraph' })
  }
  return { type: 'doc', content: out }
}

function buildArticleDraftRow(opts: {
  draftId: string
  uid: string
  title: string
  richJson: RichTextNode
}): Record<string, unknown> {
  const now = Date.now()
  return {
    content: {
      contextStore: {
        liveContext: { time: 0, title: '' },
        previewAuditContext: {
          status: 0,
          detail: {
            hasLimit: true,
            remainingCalls: 0,
            taskId: '',
            taskType: '1',
            status: 0,
            taskResultInfo: { detectionStatus: 1, optimizationPoints: [] },
          },
          isChange: false,
        },
        coverContext: {
          coverUrl: '',
          cover: {
            width: 0,
            height: 0,
            fileid: '',
            frame: { ts: 0, isUserSelect: false, isUpload: false },
            stickers: { version: 2, neptune: [] },
            fonts: [],
            coverTemplateId: '',
            extra_info_json: '',
          },
          templateBlob: null,
          rate: 0,
          recommendCoverIdx: -1,
        },
        goodsContext: { goodsInfo: {}, goodsPreviewDetail: [] },
        bizRelationContext: { bizRelation: [] },
        recommendCovers: [],
        skillContext: { skillId: '', skillName: '' },
        appContext: { appId: '', appName: '', appSlogan: '' },
      },
      draftStore: {
        descInnerHTML: '',
        descLength: 0,
        video: {
          width: 0,
          height: 0,
          fileid: '',
          fsize: 0,
          duration: 0,
          videoId: '',
          videoMarks: [],
          timelines: [],
          frame: { ts: 0, userSelect: false },
          transcodeVideoFileId: '',
          coverInfo: {},
        },
        videoInfo: null,
        audioInfo: null,
        videoMeta: '',
        audioMeta: '',
        cover: {
          width: 0,
          height: 0,
          fileid: '',
          frame: { ts: 0, isUserSelect: false, isUpload: false },
          stickers: { neptune: [], version: 2 },
          fonts: [],
        },
        chapters: [],
        markers: [],
        needTranscode: false,
        imgList: [],
        colorGroup: null,
        audioFileId: '',
        audioId: '',
        audioDuration: 0,
        needAudioTranscode: false,
        title: '',
        desc: '',
        ats: [],
        hashTag: [],
        pkCoverList: [],
        smartChapterState: {
          status: 'idle',
          progress: 0,
          generatedChapters: [],
          generatedSummary: '',
          failReason: '',
          videoId: '',
          isAiApplied: false,
          isRegenerate: false,
        },
        summary: '',
      },
      settingStore: {
        privacyInfo: { opType: 1, type: 0, userIds: [] },
        collectionId: '',
        orderId: '',
        brandAccountId: '',
        noteSketch: { id: '', name: '' },
        original: false,
        originalDateStamp: '',
        coProduceBind: { enable: true },
        noteCopyBind: { copyable: true },
        coOrderId: '',
        interactionPermissionBind: { commentPermission: 0 },
        fileRelate: {
          fileId: '',
          docId: '',
          docName: '',
          docShowName: '',
          docType: '',
          docSize: 0,
        },
        coCreators: [],
        thumbBind: { enable: false },
        videoAdBind: { insertTime: null, bizId: '' },
        skillBind: '',
        quoteNote: null,
        appBind: '',
        activityAssociationInfo: null,
      },
      articleStore: {
        articleContent: '',
        summeryContent: '',
        orderPattern: '',
        richJson: opts.richJson,
        articleTitle: opts.title,
        articleEditorMode: 0,
        authorAndSummaryTemp: { author: '', summary: '', readingStats: '' },
        selectedThemeId: 6,
        selectedColorIndexMap: {},
        blob2Map: {},
        coverSetting: {
          styleType: 0,
          showAuthor: true,
          showReadingStats: true,
          showSummery: true,
        },
        editPageSource: 'import',
        schemaCopy: {},
        url2FileIdMap: {},
        wordCount: countRichTextChars(opts.richJson),
      },
      shortDraftStore: {
        isShort: true,
        editStatus: 0,
        textCardList: [
          {
            createTime: now,
            text: '',
            originText: '',
            length: 0,
            image: '',
            imageFileId: '',
            isManualInsert: false,
          },
        ],
        coverList: [],
        currentCoverIdx: 0,
        cacheData: {},
      },
      publishStore: {
        publishType: 1,
        imageNoteOrigin: 0,
        systemId: 'web',
        step: 0,
        uploadState: 2,
        status: 0,
        codec: 'unknown',
        pkCoverEnabled: false,
        pkCoverAutoFill: true,
        pkCoverFillAttempted: false,
      },
    },
    draftId: opts.draftId,
    uid: opts.uid,
    timeStamp: now,
  }
}

export class XiaohongshuAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'xiaohongshu',
    name: '小红书',
    icon: 'https://www.xiaohongshu.com/favicon.ico',
    homepage: ARTICLE_URL,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    processCodeBlocks: true,
    processLazyImages: true,
    removeEmptyElements: true,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual'] },
      {
        kind: 'visibility',
        key: 'visibility',
        label: '可见性',
        options: [
          { value: 'public', label: '公开' },
          { value: 'private', label: '仅自己可见' },
        ],
      },
    ],
  }

  private readonly HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: '*://creator.xiaohongshu.com/*',
      headers: {
        Origin: 'https://creator.xiaohongshu.com',
        Referer: ARTICLE_URL,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ros-upload*.xiaohongshu.com/*',
      headers: {
        Origin: 'https://creator.xiaohongshu.com',
        Referer: 'https://creator.xiaohongshu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ros-upload*.xhscdn.com/*',
      headers: {
        Origin: 'https://creator.xiaohongshu.com',
        Referer: 'https://creator.xiaohongshu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private userInfo: XhsUserInfo | null = null
  private imageMeta = new Map<string, UploadedImageMeta>()

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const user = await this.resolveUser()
        if (!user?.userId) {
          return {
            isAuthenticated: false,
            error: `未登录小红书，请先在浏览器打开并登录 ${ARTICLE_URL}`,
          }
        }
        return {
          isAuthenticated: true,
          userId: user.userId,
          username: user.userName,
          avatar: user.userAvatar,
        }
      })
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：resolveUser 确保登录 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const user = await this.resolveUser()
      if (!user?.userId) {
        throw new Error('请先登录小红书创作者中心')
      }
    })
  }

  /** 2. 内容规整：确保非空 + 标题截断 */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    if (!(ctx.content.html || '').trim()) {
      throw new Error('文章内容为空')
    }
    let title = (ctx.article.title || '').trim() || '无标题'
    if (title.length > TITLE_MAX) {
      logger.warn(`标题超长 ${title.length}/${TITLE_MAX}，已截断`)
      title = title.slice(0, TITLE_MAX)
    }
    ctx.refs.title = title
  }

  /** 3. 上传图片（清空 imageMeta 重新收集，供 htmlToRichJson 使用宽高） */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      this.imageMeta.clear()
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      const opts: ImageProcessOptions = {
        skipPatterns: ['xhscdn.com', 'xiaohongshu.com', 'ros-preview'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
  }

  /** 5. 构建 draft row（HTML → ProseMirror richJson + 截断） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const title = (ctx.refs.title as string) ?? ((ctx.article.title || '').trim() || '无标题')
    let richJson = htmlToRichJson(ctx.content.html, this.imageMeta)
    const charsBefore = countRichTextChars(richJson)
    if (charsBefore > CONTENT_MAX) {
      logger.warn(`正文超长 ${charsBefore}/${CONTENT_MAX}，已截断`)
      richJson = truncateRichJson(richJson, CONTENT_MAX)
    }
    const draftId = makeDraftId()
    const row = buildArticleDraftRow({
      draftId,
      uid: this.userInfo?.userId || '',
      title,
      richJson,
    })
    ctx.payload = { draftId, row }
  }

  /** 6. 提交：writeArticleDraft（写入 IndexedDB） */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const payload = ctx.payload as { draftId: string; row: Record<string, unknown> }
    await this.writeArticleDraft(payload.row)
    return this.createResult(true, {
      postId: payload.draftId,
      postUrl: POST_SUCCESS_URL,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  private async resolveUser(): Promise<XhsUserInfo> {
    if (this.userInfo?.userId) return this.userInfo
    if (!this.runtime.tabs) {
      throw new Error('小红书长文草稿依赖页面上下文，当前运行时不支持 Tab')
    }

    const result = await this.runOnPageTab(
      PAGE_PATTERN,
      ARTICLE_URL,
      async (tabId) => {
        await this.runtime.tabs!.waitForLoad?.(tabId).catch(() => undefined)
        return this.runtime.tabs!.executeScript(
          tabId,
          async (userInfoUrl: string): Promise<PageAuthResult> => {
            try {
              const resp = await fetch(userInfoUrl, {
                credentials: 'include',
                headers: { Accept: 'application/json, text/plain, */*' },
              })
              const text = await resp.text()
              let data: XhsApiResponse<XhsUserInfo>
              try {
                data = JSON.parse(text) as XhsApiResponse<XhsUserInfo>
              } catch {
                return { ok: false, error: `用户信息非 JSON: ${text.slice(0, 120)}` }
              }
              if (!resp.ok || data.success === false || (data.code != null && data.code !== 0)) {
                return {
                  ok: false,
                  error: data.msg || data.message || `鉴权失败 HTTP ${resp.status}`,
                }
              }
              const user = data.data
              if (!user?.userId) {
                return { ok: false, error: '未返回 userId，请确认已登录创作者中心' }
              }
              return {
                ok: true,
                user: {
                  userId: String(user.userId),
                  userName: user.userName || '',
                  userAvatar: user.userAvatar || '',
                },
              }
            } catch (e) {
              return { ok: false, error: (e as Error).message || '鉴权请求失败' }
            }
          },
          [USER_INFO_URL] as [string]
        )
      }
    )

    if (!result?.ok || !result.user?.userId) {
      throw new Error(result?.error || '未登录小红书')
    }
    this.userInfo = result.user
    return result.user
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.runtime.tabs) {
      throw new Error('小红书图片上传需要页面上下文')
    }

    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const resp = await this.runtime.fetch(src, { credentials: 'include' })
      if (!resp.ok) throw new Error(`图片下载失败 HTTP ${resp.status}`)
      blob = await resp.blob()
    }
    if (!blob || blob.size === 0) throw new Error('图片内容为空')

    const { width, height } = await this.readImageSize(blob)
    const mime = guessMime(blob, src)

    // 大图勿经 executeScript 传 base64（参数序列化易失败）；
    // 页面只取 permit，Service Worker 直传图床（扩展 fetch 可读响应头）。
    const permit = await this.fetchUploadPermit()
    const putUrl = `https://${permit.uploadAddr}/${permit.fileId}`
    const putResp = await this.runtime.fetch(putUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: {
        'Content-Type': mime || 'image/png',
        'x-cos-security-token': permit.token,
      },
      body: blob,
    })
    if (!putResp.ok) {
      const errText = await putResp.text().catch(() => '')
      throw new Error(`图床 PUT 失败 HTTP ${putResp.status} ${errText.slice(0, 120)}`)
    }
    const preview =
      putResp.headers.get('x-ros-preview-url') ||
      putResp.headers.get('X-Ros-Preview-Url') ||
      ''
    if (!preview) {
      throw new Error('上传成功但未返回 x-ros-preview-url')
    }

    this.imageMeta.set(preview, {
      src: preview,
      width: width || IMAGE_DISPLAY_WIDTH,
      height: height || IMAGE_DISPLAY_WIDTH,
    })

    const attrs: Record<string, string | number> = {}
    if (width > 0) attrs.width = width
    if (height > 0) attrs.height = height
    return { url: preview, attrs }
  }

  /** 在创作者页面用 _webmsxyw 签名，获取单次上传凭证（不含图片本体） */
  private async fetchUploadPermit(): Promise<{
    fileId: string
    token: string
    uploadAddr: string
  }> {
    const result = await this.runOnPageTab(PAGE_PATTERN, ARTICLE_URL, (tabId) =>
      this.runtime.tabs!.executeScript(
        tabId,
        async (permitPath: string): Promise<{
          ok: boolean
          fileId?: string
          token?: string
          uploadAddr?: string
          error?: string
        }> => {
          try {
            const signFn = (window as unknown as {
              _webmsxyw?: (path: string, data?: unknown) => Record<string, string | number>
            })._webmsxyw
            if (typeof signFn !== 'function') {
              return { ok: false, error: '页面缺少 _webmsxyw 签名函数，请刷新创作者中心后重试' }
            }
            const sig = signFn(permitPath) || {}
            const xs = String(sig['X-s'] ?? sig['X-S'] ?? '')
            const xt = String(sig['X-t'] ?? sig['X-T'] ?? Date.now())
            const permitResp = await fetch(`https://creator.xiaohongshu.com${permitPath}`, {
              credentials: 'include',
              headers: {
                Accept: 'application/json, text/plain, */*',
                'X-s': xs,
                'X-t': xt,
              },
            })
            const permitText = await permitResp.text()
            let permitJson: {
              code?: number
              success?: boolean
              msg?: string
              data?: {
                uploadTempPermits?: Array<{
                  uploadAddr?: string
                  token?: string
                  fileIds?: string[]
                  qos?: number
                }>
              }
            }
            try {
              permitJson = JSON.parse(permitText)
            } catch {
              return { ok: false, error: `上传凭证非 JSON: ${permitText.slice(0, 120)}` }
            }
            if (!permitResp.ok || permitJson.success === false || permitJson.code === -1) {
              return {
                ok: false,
                error: permitJson.msg || `获取上传凭证失败 HTTP ${permitResp.status}`,
              }
            }
            const permits = [...(permitJson.data?.uploadTempPermits || [])].sort(
              (a, b) => (b.qos || 0) - (a.qos || 0)
            )
            const permit = permits[0]
            const fileId = permit?.fileIds?.[0]
            const token = permit?.token
            const uploadAddr = permit?.uploadAddr
            if (!fileId || !token || !uploadAddr) {
              return { ok: false, error: '上传凭证缺少 fileId/token/uploadAddr' }
            }
            return { ok: true, fileId, token, uploadAddr }
          } catch (e) {
            return { ok: false, error: (e as Error).message || '获取上传凭证失败' }
          }
        },
        [PERMIT_PATH] as [string]
      )
    )

    if (!result?.ok || !result.fileId || !result.token || !result.uploadAddr) {
      throw new Error(result?.error || '获取小红书上传凭证失败')
    }
    return {
      fileId: result.fileId,
      token: result.token,
      uploadAddr: result.uploadAddr,
    }
  }

  private async writeArticleDraft(row: Record<string, unknown>): Promise<void> {
    if (!this.runtime.tabs) {
      throw new Error('写入长文草稿需要页面上下文')
    }
    const result = await this.runOnPageTab(PAGE_PATTERN, ARTICLE_URL, (tabId) =>
      this.runtime.tabs!.executeScript(
        tabId,
        async (draftRow: Record<string, unknown>): Promise<PageDraftWriteResult> => {
          try {
            const draftId = String(draftRow.draftId || '')
            if (!draftId) return { ok: false, error: 'draftId 为空' }

            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open('draft-database-v1')
              req.onupgradeneeded = () => {
                const database = req.result
                if (!database.objectStoreNames.contains('article-draft')) {
                  // 与小红书官方一致：inline key（keyPath=draftId）
                  database.createObjectStore('article-draft', { keyPath: 'draftId' })
                }
              }
              req.onsuccess = () => resolve(req.result)
              req.onerror = () => reject(req.error || new Error('打开 IndexedDB 失败'))
            })

            if (![...db.objectStoreNames].includes('article-draft')) {
              db.close()
              return {
                ok: false,
                error: '缺少 article-draft store，请先打开一次「写长文」页面',
              }
            }

            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction('article-draft', 'readwrite')
              const store = tx.objectStore('article-draft')
              // 官方 store 使用 inline keys（keyPath），再传第二参数 key 会报：
              // "The object store uses in-line keys and the key parameter was provided."
              // out-of-line keys 时才需要显式传 draftId
              const keyPath = store.keyPath
              if (keyPath) {
                const path = Array.isArray(keyPath) ? keyPath[0] : String(keyPath)
                if (path && draftRow[path] == null) {
                  draftRow = { ...draftRow, [path]: draftId }
                }
              }
              const req = keyPath ? store.put(draftRow) : store.put(draftRow, draftId)
              req.onsuccess = () => resolve()
              req.onerror = () => reject(req.error || new Error('写入草稿失败'))
              tx.onabort = () => reject(tx.error || new Error('写入草稿事务中止'))
            })
            db.close()
            return { ok: true, draftId }
          } catch (e) {
            return { ok: false, error: (e as Error).message || '写入 IndexedDB 失败' }
          }
        },
        [row] as [Record<string, unknown>]
      )
    )

    if (!result?.ok) {
      throw new Error(result?.error || '写入小红书长文草稿失败')
    }
    logger.info('Wrote article-draft:', result.draftId)
  }

  private async readImageSize(blob: Blob): Promise<{ width: number; height: number }> {
    try {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob)
        const size = { width: bitmap.width || 0, height: bitmap.height || 0 }
        bitmap.close()
        return size
      }
    } catch (error) {
      logger.debug('createImageBitmap failed:', error)
    }
    return { width: 0, height: 0 }
  }
}
