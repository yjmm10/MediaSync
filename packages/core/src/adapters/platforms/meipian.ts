/**
 * 美篇适配器
 *
 * 编辑器：https://www.meipian.cn/editor
 * 鉴权：登录后 localStorage 存 app_token，所有 /api/* 请求需带 `token` 请求头；
 *       Service Worker 无法读 localStorage，通过 ensurePageTab 在美篇页面上下文读取一次后缓存。
 * 图片：POST /api/upload/token {file,size,private:0} → data.{key,token}
 *       → 直传 upload.qiniup.com → URL = https://ss2.meipian.me/{key}
 *       （private:1 走私有桶需签名；编辑器公开图用 private:0 + ss2 CDN）
 * 发文：POST /api/article/createOrUpdate
 *       { article, contents, censor_token, sensors_properties }
 *       contents 段落 type 一律为 1：有 img_url 为图片，否则为文字（text 可为 HTML）。
 *       默认 privacy=1（公开）；SW 调用失败时回退页面上下文重试。
 *
 * 结构已对照真实网络请求校准（含文字段落 + upload/token 响应）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Meipian')

const EDITOR_URL = 'https://www.meipian.cn/editor'
/** chrome.tabs.query match pattern；*:// 兼容 http/https */
const PAGE_PATTERN = '*://www.meipian.cn/*'
const API_BASE = 'https://www.meipian.cn'
const QINIU_UPLOAD = 'https://upload.qiniup.com/'
/** 公开图床 CDN（与编辑器 private:0 分支一致） */
const IMAGE_CDN = 'https://ss2.meipian.me/'
/** 已在美篇图床的域名，processImages 跳过 */
const MEIPIAN_CDN_SKIP = ['meipian.cn', 'meipian.me', 'ivwen.com', 'ivwen.cn']

/** 美篇段落 type：文字与图片均为 1，靠是否带 img_url 区分 */
const BLOCK_TYPE = 1

interface MeipianBlock {
  type: number
  text: string
  img_url?: string
  img_width?: number
  img_height?: number
}

interface MeipianUploadToken {
  token: string
  key: string
}

interface MeipianUserInfo {
  id?: number | string
  nickname?: string
  name?: string
  avatar?: string
  head_img?: string
  head_img_url?: string
}

interface MeipianArticleResult {
  mask_id?: string | number
  id?: string | number
  ck?: string
  migrate_code?: number
}

interface MeipianApiResponse<T = unknown> {
  code?: number | string
  msg?: string
  message?: string
  err?: boolean
  data?: T
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

function guessExtension(blob: Blob, src: string): string {
  const type = (blob.type || '').toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('png')) return 'png'
  if (type.includes('gif')) return 'gif'
  if (type.includes('webp')) return 'webp'
  if (type.includes('svg')) return 'svg'
  const m = src.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/)
  if (m) {
    const ext = m[1].toLowerCase()
    return ext === 'jpeg' ? 'jpg' : ext
  }
  return 'png'
}

function makeFileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Service Worker 无 DOM：用正则把 HTML 收成美篇段落数组。
 * - 顶层块（p/div/h1-6/li/blockquote/pre/figure）逐个处理
 * - 块内 <img> 拆成独立图片段，剩余文字作为文字段
 * - 文字段 text 保留内联标签（strong/em/a），美篇富文本可渲染
 * - 图片与文字均为 type=1
 */
function buildMeipianBlocks(html: string): MeipianBlock[] {
  const blocks: MeipianBlock[] = []

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .trim()

  if (!cleaned) {
    return [{ type: BLOCK_TYPE, text: '' }]
  }

  const blockRe = /<(p|div|h[1-6]|li|blockquote|pre|figure)([^>]*)>([\s\S]*?)<\/\1\s*>/gi
  let match: RegExpExecArray | null
  let lastIdx = 0
  let matched = false

  const appendBlocks = (fragment: string): void => {
    const trimmed = fragment.trim()
    if (!trimmed) return

    const imgRe = /<img\b[^>]*>/gi
    let m: RegExpExecArray | null
    let cursor = 0
    while ((m = imgRe.exec(trimmed)) !== null) {
      if (m.index > cursor) {
        const text = trimmed.slice(cursor, m.index).trim()
        if (text) blocks.push({ type: BLOCK_TYPE, text })
      }
      const tag = m[0]
      const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || ''
      const width = parseInt(tag.match(/\b(?:data-w|width)=["'](\d+)["']/i)?.[1] || '0', 10) || 0
      const height = parseInt(tag.match(/\b(?:data-h|height)=["'](\d+)["']/i)?.[1] || '0', 10) || 0
      if (src) {
        blocks.push({
          type: BLOCK_TYPE,
          text: '',
          img_url: src,
          img_width: width,
          img_height: height,
        })
      }
      cursor = imgRe.lastIndex
    }
    if (cursor < trimmed.length) {
      const text = trimmed.slice(cursor).trim()
      if (text) blocks.push({ type: BLOCK_TYPE, text })
    }
  }

  while ((match = blockRe.exec(cleaned)) !== null) {
    matched = true
    if (match.index > lastIdx) {
      appendBlocks(cleaned.slice(lastIdx, match.index))
    }
    appendBlocks(match[3] || '')
    lastIdx = blockRe.lastIndex
  }
  if (lastIdx < cleaned.length) {
    appendBlocks(cleaned.slice(lastIdx))
  }

  if (!matched) {
    appendBlocks(cleaned)
  }

  // 过滤纯空白文字段；图片段保留
  const filtered = blocks.filter((b) => b.img_url || (b.text && stripTags(b.text)))
  if (filtered.length === 0) {
    filtered.push({ type: BLOCK_TYPE, text: '' })
  }
  return filtered
}

export class MeipianAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'meipian',
    name: '美篇',
    icon: 'https://www.meipian.cn/favicon.ico',
    homepage: EDITOR_URL,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    processCodeBlocks: true,
    compactHtml: true,
  }

  private readonly HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: '*://www.meipian.cn/*',
      headers: {
        Origin: 'https://www.meipian.cn',
        Referer: EDITOR_URL,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 从美篇页面 localStorage 读取并缓存的 app_token */
  private appToken: string | null = null
  /** 页面 localStorage.userInfo 缓存，避免 SW getInfo 失败误判未登录 */
  private cachedUser: MeipianUserInfo | null = null
  /** appToken 缓存时间戳；TTL 内 checkAuth 只走 SW API，不建标签 */
  private appTokenCachedAt = 0
  private static readonly APP_TOKEN_TTL_MS = 5 * 60 * 1000
  /** checkAuth 单飞：激活时并发检测共用一次结果 */
  private checkAuthInflight: Promise<AuthResult> | null = null

  async checkAuth(): Promise<AuthResult> {
    if (this.checkAuthInflight) {
      return this.checkAuthInflight
    }
    this.checkAuthInflight = this.doCheckAuth().finally(() => {
      this.checkAuthInflight = null
    })
    return this.checkAuthInflight
  }

  private async doCheckAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        // 短时缓存：已有 app_token 则纯 SW 探测，避免激活插件反复 ensurePageTab
        const cacheFresh =
          !!this.appToken &&
          Date.now() - this.appTokenCachedAt < MeipianAdapter.APP_TOKEN_TTL_MS

        if (cacheFresh && this.appToken) {
          const cached = await this.checkAuthWithCachedToken(this.appToken)
          if (cached) return cached
          this.appToken = null
          this.cachedUser = null
          this.appTokenCachedAt = 0
        }

        const session = await this.readPageSession()
        if (!session.token) {
          this.appToken = null
          this.cachedUser = null
          this.appTokenCachedAt = 0
          return {
            isAuthenticated: false,
            error: '未检测到美篇登录，请先在浏览器打开 https://www.meipian.cn/editor 完成登录',
          }
        }

        this.appToken = session.token
        this.appTokenCachedAt = Date.now()

        // 本地 userInfo 足够判登录；getInfo 仅作刷新，失败不抹掉本地态
        let user = session.user
        try {
          const remote = await this.fetchUserInfo(session.token)
          if (remote) user = remote
        } catch (error) {
          logger.warn('checkAuth getInfo failed, fallback to local userInfo:', error)
        }

        // 有 token 即视为已登录：编辑器只靠 app_token；无昵称时用占位名
        if (!user?.id && !user?.nickname && !user?.name) {
          // 二次探针：upload/token 能拿到凭证也说明 token 有效
          const tokenOk = await this.probeToken(session.token)
          if (!tokenOk) {
            this.appToken = null
            this.cachedUser = null
            this.appTokenCachedAt = 0
            return {
              isAuthenticated: false,
              error: '美篇登录态失效，请重新打开 https://www.meipian.cn/editor 登录',
            }
          }
          user = { nickname: '美篇用户' }
        }

        this.cachedUser = user
        return {
          isAuthenticated: true,
          username: user.nickname || user.name || '美篇用户',
          avatar: user.avatar || user.head_img || user.head_img_url,
          userId: user.id != null ? String(user.id) : undefined,
        }
      })
    } catch (error) {
      logger.error('checkAuth error:', error)
      this.appToken = null
      this.cachedUser = null
      this.appTokenCachedAt = 0
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  /**
   * 仅用已缓存 token 走 SW（不建标签）。失败返回 null，由调用方回退读页。
   */
  private async checkAuthWithCachedToken(token: string): Promise<AuthResult | null> {
    try {
      let user = this.cachedUser
      try {
        const remote = await this.fetchUserInfoSwOnly(token)
        if (remote) user = remote
      } catch (error) {
        logger.debug('cached token getInfo failed, try probe:', error)
      }

      if (!user?.id && !user?.nickname && !user?.name) {
        const tokenOk = await this.probeToken(token)
        if (!tokenOk) return null
        user = { nickname: '美篇用户' }
      }

      this.cachedUser = user
      return {
        isAuthenticated: true,
        username: user.nickname || user.name || '美篇用户',
        avatar: user.avatar || user.head_img || user.head_img_url,
        userId: user.id != null ? String(user.id) : undefined,
      }
    } catch {
      return null
    }
  }

  /** SW getInfo，失败不回退页面（供缓存鉴权） */
  private async fetchUserInfoSwOnly(token: string): Promise<MeipianUserInfo | null> {
    const res = await this.postJson<MeipianApiResponse<MeipianUserInfo>>(
      `${API_BASE}/api/user/getInfo`,
      {},
      { Accept: 'application/json, text/plain, */*', token }
    )
    return this.parseUserInfo(res)
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：resolveToken + fetchUserInfo（确保 cachedUser 已获取） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const token = await this.resolveToken()
      const user =
        (await this.fetchUserInfo(token)) ||
        this.cachedUser ||
        (await this.readPageSession()).user
      if (!user?.id) {
        throw new Error('无法获取美篇用户信息，请重新登录')
      }
      this.cachedUser = user
    })
  }

  /** 2. 内容规整：统一单引号 src，便于 processImages 提取 */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    if (!(ctx.content.html || '').trim()) {
      throw new Error('文章内容为空')
    }
    ctx.content.html = ctx.content.html.replace(
      /<img\b([^>]*?)\bsrc\s*=\s*'([^']*)'/gi,
      '<img$1src="$2"',
    )
  }

  /** 3. 上传图片 + 封面（外链转存或正文首图） */
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
        skipPatterns: MEIPIAN_CDN_SKIP,
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)

      // 封面：外链图先转存；无封面时用正文第一张图
      let coverUrl = ctx.article.cover || ''
      if (coverUrl && !MEIPIAN_CDN_SKIP.some((p) => coverUrl.includes(p))) {
        try {
          const up = await this.uploadImageByUrl(coverUrl)
          coverUrl = up.url
        } catch (error) {
          logger.warn('cover re-upload failed, use original:', error)
        }
      }
      if (!coverUrl) {
        const contents = buildMeipianBlocks(ctx.content.html)
        coverUrl = contents.find((b) => b.img_url)?.img_url || ''
      }
      ctx.refs.coverUrl = coverUrl
    })
  }

  /** 5. 构建 createOrUpdate 请求体（buildMeipianBlocks + article + censor_token） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const contents = buildMeipianBlocks(ctx.content.html)
    const title = (ctx.article.title || '').trim() || '无标题'
    const coverUrl = (ctx.refs.coverUrl as string) ?? ''
    ctx.payload = {
      article: {
        cover_img_url: coverUrl,
        cover_crop: '',
        theme: 0,
        origin_status: 0,
        // 1=公开。美篇无独立草稿箱，privacy=3 会变成「仅作者可见/私密」，故统一公开
        privacy: 1,
        state: 0,
        has_reward: 2,
        enable_comment: 1,
        create_time: Math.floor(Date.now() / 1000),
        visit_count: 0,
        text_pos: 2,
        title,
        user_id: this.cachedUser?.id,
        music_url: '',
        music_id: 0,
        music_desc: '',
        music_source: 1,
        rich_text_title: '',
      },
      contents,
      censor_token: {
        ua_token: '',
        web_umid_token: '',
        sm_token: '',
        yd_token: '',
      },
      sensors_properties: {
        entrance: 'article_pc',
      },
    }
  }

  /** 6. 提交：createArticle（SW 失败由内部页面回退） */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const token = await this.resolveToken()
    const maskId = await this.createArticle(token, ctx.payload as Record<string, unknown>)
    return this.createResult(true, {
      postId: maskId,
      postUrl: `https://www.meipian.cn/${maskId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  /**
   * 从美篇页面 localStorage 读取登录会话。
   * 编辑器把 app_token / userInfo 存在 localStorage，SW 无法直接读。
   */
  private async readPageSession(): Promise<{
    token: string
    user: MeipianUserInfo | null
  }> {
    if (!this.runtime.tabs) {
      throw new Error('美篇登录态保存在页面 localStorage，当前运行时不支持读取')
    }

    const tabId = await this.ensurePageTab(PAGE_PATTERN, EDITOR_URL)
    const result = await this.runtime.tabs.executeScript(
      tabId,
      () => {
        try {
          const token = window.localStorage.getItem('app_token') || ''
          const raw = window.localStorage.getItem('userInfo') || ''
          let user: {
            id?: number | string
            nickname?: string
            name?: string
            avatar?: string
            head_img?: string
            head_img_url?: string
            _token?: string
          } | null = null
          if (raw) {
            try {
              user = JSON.parse(raw)
            } catch {
              user = null
            }
          }
          // userInfo._token 与 app_token 短暂不一致时仍保留资料字段（id/nickname），
          // 避免误判未登录；发文一律以 app_token 为准
          if (user && user._token && token && user._token !== token) {
            logger.warn('meipian userInfo._token mismatch app_token, keep profile fields')
          }
          return { token, user }
        } catch {
          return { token: '', user: null }
        }
      },
      [] as []
    )

    return {
      token: result?.token || '',
      user: result?.user || null,
    }
  }

  /**
   * 读取美篇 app_token：SW 无法访问页面 localStorage，
   * 在美篇页面上下文执行脚本读取一次并缓存。
   */
  private async resolveToken(): Promise<string> {
    if (
      this.appToken &&
      Date.now() - this.appTokenCachedAt < MeipianAdapter.APP_TOKEN_TTL_MS
    ) {
      return this.appToken
    }

    const session = await this.readPageSession()
    if (!session.token) {
      this.appToken = null
      this.cachedUser = null
      this.appTokenCachedAt = 0
      throw new Error('未读取到美篇登录凭证，请先在浏览器打开 https://www.meipian.cn/editor 完成登录')
    }
    this.appToken = session.token
    this.appTokenCachedAt = Date.now()
    if (session.user) this.cachedUser = session.user
    return session.token
  }

  /** getInfo：SW POST → 失败回退页面上下文 */
  private async fetchUserInfo(token: string): Promise<MeipianUserInfo | null> {
    try {
      const res = await this.postJson<MeipianApiResponse<MeipianUserInfo>>(
        `${API_BASE}/api/user/getInfo`,
        {},
        { Accept: 'application/json, text/plain, */*', token }
      )
      const user = this.parseUserInfo(res)
      if (user) return user
    } catch (error) {
      logger.warn('SW getInfo failed, fallback to page:', error)
    }

    try {
      const res = await this.pageFetchJson<MeipianApiResponse<MeipianUserInfo>>(
        PAGE_PATTERN,
        EDITOR_URL,
        `${API_BASE}/api/user/getInfo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            token,
          },
          body: '{}',
        }
      )
      return this.parseUserInfo(res)
    } catch (error) {
      logger.warn('page getInfo failed:', error)
      return null
    }
  }

  private parseUserInfo(res: MeipianApiResponse<MeipianUserInfo>): MeipianUserInfo | null {
    if (res.code != null && Number(res.code) !== 0) {
      logger.warn('meipian getInfo non-zero code:', res.code, res.msg)
      return null
    }
    const data = res.data || (res as unknown as MeipianUserInfo)
    if (!data || typeof data !== 'object') return null
    if (!data.nickname && !data.name && data.id == null) return null
    return data
  }

  /** 发文：SW JSON POST → 失败回退页面上下文（页面自带 token/cookie/Origin） */
  private async createArticle(
    token: string,
    payload: Record<string, unknown>
  ): Promise<string> {
    try {
      const res = await this.postJson<MeipianApiResponse<MeipianArticleResult>>(
        `${API_BASE}/api/article/createOrUpdate`,
        payload,
        { token }
      )
      return this.extractMaskId(res)
    } catch (error) {
      logger.warn('SW createOrUpdate failed, fallback to page context:', error)
      return this.createArticleViaPage(payload, error as Error)
    }
  }

  private async createArticleViaPage(
    payload: Record<string, unknown>,
    swError: Error
  ): Promise<string> {
    if (!this.runtime.tabs) {
      throw swError
    }

    const tabId = await this.ensurePageTab(PAGE_PATTERN, EDITOR_URL)
    const result = await this.runtime.tabs.executeScript(
      tabId,
      async (bodyJson: string, timeoutMs: number) => {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          let response: Response
          try {
            response = await fetch('/api/article/createOrUpdate', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                token: window.localStorage.getItem('app_token') || '',
              },
              body: bodyJson,
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timer)
          }
          return { ok: response.ok, status: response.status, text: await response.text() }
        } catch (e) {
          const err = e as Error
          return {
            ok: false,
            status: 0,
            text: '',
            error: err?.name === 'AbortError' ? '美篇页面请求超时' : err.message || '页面请求失败',
          }
        }
      },
      [JSON.stringify(payload), 60000] as [string, number]
    )

    if (!result || result.error) {
      throw new Error(result?.error || swError.message)
    }
    const text = (result.text || '').trim()
    if (!text) {
      throw new Error(`美篇页面发布空响应 HTTP ${result.status}`)
    }

    let data: MeipianApiResponse<MeipianArticleResult>
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`美篇页面响应非 JSON: ${text.slice(0, 160)}`)
    }
    return this.extractMaskId(data)
  }

  private extractMaskId(res: MeipianApiResponse<MeipianArticleResult>): string {
    if (res.code != null && Number(res.code) !== 0) {
      throw new Error(res.msg || res.message || `美篇发布失败 (code ${res.code})`)
    }
    const d = res.data
    const maskId =
      d && typeof d === 'object' ? String(d.mask_id || '') : typeof d === 'string' ? d : ''
    if (!maskId) {
      throw new Error('美篇发布成功但未返回文章 ID')
    }
    return maskId
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const token = await this.resolveToken()

    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const resp = await this.runtime.fetch(src, { credentials: 'include' })
      if (!resp.ok) {
        throw new Error(`下载图片失败 HTTP ${resp.status}`)
      }
      blob = await resp.blob()
    }
    if (!blob || blob.size === 0) {
      throw new Error('图片内容为空')
    }

    const { width, height } = await this.readImageSize(blob)
    const ext = guessExtension(blob, src)
    const fileId = `${makeFileId()}.${ext}`
    const fname = src.split(/[?#]/)[0]?.split('/').pop() || fileId
    const cred = await this.getUploadToken(token, fileId, blob.size)

    const formData = new FormData()
    formData.append('token', cred.token)
    formData.append('key', cred.key)
    formData.append('fname', fname)
    formData.append('file', blob, fname)

    // 七牛直传：不带 cookie，绕过 header rules
    const upResp = await this.runtime.fetch(QINIU_UPLOAD, {
      method: 'POST',
      credentials: 'omit',
      body: formData,
    })
    const upText = await upResp.text()
    let upData: { key?: string; hash?: string; error?: string } = {}
    try {
      upData = JSON.parse(upText)
    } catch {
      throw new Error(`美篇图床响应非 JSON: ${upText.slice(0, 120)}`)
    }
    if (!upResp.ok || upData.error) {
      throw new Error(`美篇图床上传失败: ${upData.error || upText.slice(0, 120)}`)
    }

    const finalKey = upData.key || cred.key
    const finalUrl = `${IMAGE_CDN}${finalKey}`

    const attrs: Record<string, string | number> = {}
    if (width > 0) attrs.width = width
    if (height > 0) attrs.height = height
    return { url: finalUrl, attrs }
  }

  /**
   * 轻量探针：用 upload/token 验证 app_token 是否仍被服务端接受。
   * getInfo 失败且本地无 userInfo 时，避免误判未登录。
   */
  private async probeToken(token: string): Promise<boolean> {
    try {
      const res = await this.postJson<MeipianApiResponse<{ token?: string; key?: string }>>(
        `${API_BASE}/api/upload/token`,
        { file: `probe-${Date.now()}.png`, size: 64, private: 0 },
        { token }
      )
      if (res.code != null && Number(res.code) !== 0) return false
      return !!(res.data?.token && res.data?.key)
    } catch (error) {
      logger.warn('probeToken failed:', error)
      return false
    }
  }

  private async getUploadToken(
    token: string,
    file: string,
    size: number
  ): Promise<MeipianUploadToken> {
    // private:0 → 公开桶 ivwen，CDN 可直接用 https://ss2.meipian.me/{key}
    const body = { file, size, private: 0 }
    let res: MeipianApiResponse<{ key?: string; token?: string }>
    try {
      res = await this.postJson<MeipianApiResponse<{ key?: string; token?: string }>>(
        `${API_BASE}/api/upload/token`,
        body,
        { token }
      )
    } catch (error) {
      logger.warn('SW upload/token failed, fallback to page:', error)
      res = await this.pageFetchJson<MeipianApiResponse<{ key?: string; token?: string }>>(
        PAGE_PATTERN,
        EDITOR_URL,
        `${API_BASE}/api/upload/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            token,
          },
          body: JSON.stringify(body),
        }
      )
    }
    if (res.code != null && Number(res.code) !== 0) {
      throw new Error(res.msg || res.message || `美篇上传凭证失败 (code ${res.code})`)
    }
    const d = res.data
    if (!d?.token || !d.key) {
      throw new Error(res.msg || res.message || '美篇上传凭证为空')
    }
    return { token: d.token, key: d.key }
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
