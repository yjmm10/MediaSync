/**
 * 火山引擎开发者社区适配器
 * https://developer.volcengine.com/articles/draft
 *
 * 仅保存草稿；正文为 Markdown（含 mermaid / 代码语言）。
 * 外链图：本版本支持经 ImageX 转存；本地 data URI 暂不支持（会剥离）。
 * ImageX：get-token → ApplyImageUpload → TOS PUT → CommitImageUpload → get-url
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { signAWS4, crc32 } from '../../lib'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Volcengine')

const APP_ID = 3569
const IMAGEX_SERVICE_ID = 'tlddhu82om'
const IMAGEX_HOST = 'https://imagex.bytedanceapi.com'
const BASE = 'https://developer.volcengine.com'
const DRAFT_URL = `${BASE}/articles/draft`
const PAGE_URL_PATTERN = '*://developer.volcengine.com/*'
/** SW fetch 可能丢 SameSite；收集后经 DNR 注入（resourceTypes 含 other） */
const COOKIE_DOMAINS = ['volcengine.com', 'developer.volcengine.com']

interface VolcUserPayload {
  data?: {
    xid?: string
    employee_id?: string
    name?: string
    volc_name?: string
    full_name?: string
    avatar?: string
  }
  err_no?: number
  err_msg?: string
}

interface ImageXToken {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  ExpiredTime: number
}

interface ImageXTokenResponse {
  data?: {
    access_key_id?: string
    secret_access_key?: string
    session_token?: string
    expired_time?: string
    current_time?: string
  }
  err_no?: number
  err_msg?: string
}

interface ImageXApplyUploadResponse {
  Result?: {
    UploadAddress?: {
      StoreInfos: Array<{
        StoreUri: string
        Auth: string
        UploadID: string
      }>
      UploadHosts: string[]
      SessionKey: string
    }
  }
}

interface ImageXCommitUploadResponse {
  Result?: {
    Results?: Array<{
      Uri: string
      UriStatus: number
    }>
  }
}

interface DraftPublishResponse {
  data?: {
    article_info?: {
      draft_id?: string
      article_id?: string
      id?: string
    }
  }
  err_no?: number
  err_msg?: string
}

export class VolcengineAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'volcengine',
    name: '火山引擎',
    icon: 'https://lf1-cdn-tos.bytegoofy.com/goofy/tech-fe/fav.png',
    homepage: BASE,
    capabilities: ['article', 'draft'],
  }

  /** 预处理配置: 火山社区完整支持 Markdown（含 mermaid / 代码语言） */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      { kind: 'summary', key: 'summary', label: '摘要' },
    ],
  }

  private cachedImageXToken: ImageXToken | null = null
  private imageXTokenExpiry = 0

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://developer.volcengine.com/*',
      headers: {
        Origin: BASE,
        Referer: `${BASE}/`,
      },
      // SW fetch 资源类型多为 other
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
    {
      urlFilter: '*://imagex.bytedanceapi.com/*',
      headers: {
        Origin: BASE,
        Referer: `${BASE}/`,
      },
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
    {
      urlFilter: '*://*.byteimg.com/*',
      headers: {
        Origin: BASE,
        Referer: `${BASE}/`,
      },
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
  ]

  private authFromUser(data: VolcUserPayload | null | undefined): AuthResult | null {
    if (!data) return null
    if (data.err_no !== undefined && data.err_no !== 0) return null
    const userId = data.data?.xid || data.data?.employee_id
    if (!userId) return null
    return {
      isAuthenticated: true,
      userId,
      username: data.data?.volc_name || data.data?.name || data.data?.full_name,
      avatar: data.data?.avatar,
    }
  }

  /** 收集火山相关 Cookie，供 DNR 注入（绕过 SW 丢 SameSite 会话） */
  private async collectCookieHeader(): Promise<string> {
    const map = new Map<string, string>()
    for (const domain of COOKIE_DOMAINS) {
      try {
        const cookies = await this.runtime.cookies.get(domain)
        for (const c of cookies) {
          // 后者覆盖前者：更具体域名优先
          map.set(c.name, c.value)
        }
      } catch (error) {
        logger.debug('collectCookie failed for', domain, error)
      }
    }
    return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private hasLoginCookies(cookieHeader: string): boolean {
    if (!cookieHeader) return false
    return (
      cookieHeader.includes('AccountID=') ||
      cookieHeader.includes('csrfToken=') ||
      cookieHeader.includes('sessionid=') ||
      cookieHeader.includes('sid_tt=') ||
      cookieHeader.includes('uid_tt=')
    )
  }

  /** SW + DNR 注入 Cookie（resourceTypes 含 other）；页面实测无 Cookie 会 err_no=1 */
  private async withVolcSession<T>(fn: () => Promise<T>): Promise<T> {
    const cookieHeader = await this.collectCookieHeader()
    const apiHeaders: Record<string, string> = {
      Origin: BASE,
      Referer: `${BASE}/`,
    }
    if (cookieHeader) {
      apiHeaders.Cookie = cookieHeader
    }
    const rules = [
      {
        urlFilter: '*://developer.volcengine.com/*',
        headers: apiHeaders,
        resourceTypes: ['xmlhttprequest', 'other'] as string[],
      },
      ...this.HEADER_RULES.filter((r) => !r.urlFilter.includes('developer.volcengine.com')),
    ]
    return this.withHeaderRules(rules, fn)
  }

  private draftIdFrom(data: DraftPublishResponse | null | undefined): string | null {
    return (
      data?.data?.article_info?.draft_id ||
      data?.data?.article_info?.article_id ||
      data?.data?.article_info?.id ||
      null
    )
  }

  /** SW + DNR：优先路径；必须用 POST（GET 返回 SPA HTML） */
  private async detectAuthViaSw(): Promise<AuthResult | null> {
    return this.withVolcSession(async () => {
      const response = await this.runtime.fetch(`${BASE}/proxy_tech_api/v1/user/get`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      })
      const text = await response.text()
      let data: VolcUserPayload
      try {
        data = JSON.parse(text) as VolcUserPayload
      } catch {
        logger.debug('SW user/get non-JSON:', text.substring(0, 120))
        return null
      }
      return this.authFromUser(data)
    })
  }

  /**
   * 保存草稿。页面实测：
   * - POST /proxy_tech_api/v1/draft/publish + article_info{title,content,en_title,en_content} 成功
   * - credentials omit → HTTP 200 + err_no=1「更新文章失败」
   * - ~195KB 成功；~488KB 服务端 413 request entity too large
   * 故 SW 先带 Cookie；失败再页面 storage 中转（禁止 pageFetchJson 大 body 进 executeScript args）。
   */
  private async saveDraft(payload: {
    article_info: {
      title: string
      content: string
      en_title: string
      en_content: string
    }
  }): Promise<DraftPublishResponse> {
    const bodyStr = JSON.stringify(payload)
    const bodyKB = Math.round(bodyStr.length / 1024)

    // 页面实测：正文约 ≥440KB 会网关 413；本地大图若仍以 data URI 嵌入必超限
    if (/data:image\/[a-zA-Z0-9.+-]+;base64,/.test(payload.article_info.content)) {
      throw new Error(
        `正文仍含未上传的本地图片（草稿约 ${bodyKB} KB）。火山草稿上限约 400KB，请确认图片已上传到图床后重试`
      )
    }
    if (bodyKB >= 400) {
      throw new Error(
        `草稿过大（约 ${bodyKB} KB），火山网关约 400KB 上限。请减少正文或确保图片已转为短链后重试`
      )
    }

    // 1) SW + Cookie 注入
    try {
      const data = await this.withVolcSession(async () => {
        const response = await this.runtime.fetch(
          `${BASE}/proxy_tech_api/v1/draft/publish`,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: bodyStr,
          }
        )
        const responseText = await response.text()
        logger.debug('SW draft/publish:', response.status, responseText.substring(0, 300))
        if (response.status === 413 || /entity too large/i.test(responseText)) {
          throw new Error(
            `草稿过大（HTTP 413，约 ${bodyKB} KB），请减少正文或图片后重试`
          )
        }
        if (!response.ok) {
          throw new Error(`保存草稿失败: ${response.status} - ${responseText}`)
        }
        return JSON.parse(responseText) as DraftPublishResponse
      })
      if ((data.err_no === undefined || data.err_no === 0) && this.draftIdFrom(data)) {
        return data
      }
      logger.debug('SW draft/publish business fail:', data.err_no, data.err_msg)
    } catch (error) {
      const msg = (error as Error).message || ''
      // 服务端体积上限：页面回退也无法突破，直接抛出
      if (/HTTP 413|草稿过大/.test(msg)) {
        throw error
      }
      logger.debug('SW draft/publish failed:', error)
    }

    // 2) 页面上下文回退：storage 中转正文，避免 executeScript args 413
    if (!this.runtime.tabs?.executeScript) {
      throw new Error('保存草稿失败: Service Worker 会话无效且当前运行时不支持页面探测')
    }
    return this.postDraftViaPage(bodyStr, bodyKB)
  }

  /**
   * 页面提交草稿：正文经 chrome.storage.local 中转（ISOLATED），
   * 避免 pageFetchJson 把大 JSON 塞进 executeScript args 触发 413。
   */
  private async postDraftViaPage(
    bodyStr: string,
    bodyKB: number
  ): Promise<DraftPublishResponse> {
    if (!bodyStr || bodyStr === '{}') {
      throw new Error('草稿正文为空，无法提交')
    }

    const key = `volcengine:draft/publish:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    const url = `${BASE}/proxy_tech_api/v1/draft/publish`
    const expectedLen = bodyStr.length

    await this.runtime.storage.set(key, bodyStr)
    const stored = await this.runtime.storage.get<string>(key)
    if (typeof stored !== 'string' || !stored) {
      throw new Error('草稿正文写入 storage 失败（读回为空）')
    }
    if (stored.length !== expectedLen) {
      throw new Error(
        `草稿正文 storage 长度不一致：期望 ${expectedLen}，实际 ${stored.length}`
      )
    }

    try {
      const result = await this.runOnPageTab(PAGE_URL_PATTERN, DRAFT_URL, async (tabId) => {
        return this.runtime.tabs!.executeScript(
          tabId,
          async (storageKey: string, fetchUrl: string) => {
            const chromeApi = (
              globalThis as unknown as {
                chrome?: {
                  storage: {
                    local: {
                      get: (k: string) => Promise<Record<string, unknown>>
                      remove: (k: string) => Promise<void>
                    }
                  }
                }
              }
            ).chrome
            if (!chromeApi?.storage?.local) {
              return {
                ok: false,
                status: 0,
                text: '',
                bodyLen: 0,
                error: '页面上下文无 chrome.storage（需 ISOLATED）',
              }
            }
            try {
              const bag = await chromeApi.storage.local.get(storageKey)
              const body = bag[storageKey]
              if (typeof body !== 'string' || !body) {
                return {
                  ok: false,
                  status: 0,
                  text: '',
                  bodyLen: 0,
                  error: '草稿正文未传到页面（storage 为空）',
                }
              }
              const bodyLen = body.length
              try {
                const response = await fetch(fetchUrl, {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                  },
                  body,
                })
                const text = await response.text()
                return {
                  ok: response.ok,
                  status: response.status,
                  text,
                  bodyLen,
                }
              } finally {
                await chromeApi.storage.local.remove(storageKey)
              }
            } catch (error) {
              try {
                await chromeApi.storage.local.remove(storageKey)
              } catch {
                // ignore
              }
              return {
                ok: false,
                status: 0,
                text: '',
                bodyLen: 0,
                error: (error as Error)?.message || String(error),
              }
            }
          },
          [key, url] as [string, string],
          { world: 'ISOLATED' }
        )
      })

      if (!result || result.error) {
        throw new Error(result?.error || '页面请求失败')
      }
      if (!result.text?.trim()) {
        throw new Error(
          `页面请求空响应 HTTP ${result.status}（bodyLen=${result.bodyLen ?? 0}）`
        )
      }

      const trimmed = result.text.trim()
      if (trimmed.startsWith('<') || /<!DOCTYPE|<html/i.test(trimmed.slice(0, 80))) {
        throw new Error('未登录或会话已失效（页面返回了登录页 HTML）')
      }

      if (result.status === 413 || /entity too large/i.test(result.text)) {
        throw new Error(
          `草稿过大（HTTP 413，约 ${Math.round((result.bodyLen || bodyKB * 1024) / 1024)} KB），请减少正文或图片后重试`
        )
      }

      let data: DraftPublishResponse
      try {
        data = JSON.parse(result.text) as DraftPublishResponse
      } catch {
        throw new Error(
          `页面响应非 JSON HTTP ${result.status}: ${result.text.slice(0, 120)}`
        )
      }

      if (!result.ok) {
        throw new Error(
          data.err_msg || `页面请求失败 HTTP ${result.status}: ${result.text.slice(0, 160)}`
        )
      }
      if (data.err_no !== undefined && data.err_no !== 0) {
        throw new Error(data.err_msg || `保存草稿失败: 错误码 ${data.err_no}`)
      }
      if (!this.draftIdFrom(data)) {
        throw new Error(data.err_msg || '保存草稿失败: 无效响应')
      }
      return data
    } finally {
      await this.runtime.storage.remove(key).catch(() => undefined)
    }
  }

  /** 页面上下文回退：第一方 Cookie 一定带上 */
  private async detectAuthViaPage(): Promise<AuthResult | null> {
    if (!this.runtime.tabs) return null
    const data = await this.pageFetchJson<VolcUserPayload>(
      PAGE_URL_PATTERN,
      DRAFT_URL,
      `${BASE}/proxy_tech_api/v1/user/get`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
      }
    )
    return this.authFromUser(data)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      // 1) 优先 SW（Cookie DNR 注入）；已打开社区页时通常足够
      try {
        const fromSw = await this.detectAuthViaSw()
        if (fromSw) return fromSw
        logger.debug('SW user/get did not recognize login')
      } catch (error) {
        logger.debug('SW login probe failed:', error)
      }

      // 2) 回退页面上下文
      try {
        const fromPage = await this.detectAuthViaPage()
        if (fromPage) return fromPage
      } catch (error) {
        logger.debug('pageFetchJson login probe failed:', error)
      }

      const cookieHeader = await this.collectCookieHeader().catch(() => '')
      if (this.hasLoginCookies(cookieHeader)) {
        return {
          isAuthenticated: false,
          error: '会话 Cookie 存在但社区未识别，请打开并刷新 https://developer.volcengine.com/articles/draft 后重试',
        }
      }
      return {
        isAuthenticated: false,
        error: '未登录火山引擎开发者社区，请先打开并登录 https://developer.volcengine.com/articles/draft',
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：SW + 页面上下文级联 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    const authed =
      (await this.detectAuthViaSw().catch(() => null)) ||
      (await this.detectAuthViaPage().catch(() => null))
    if (!authed) {
      const cookieHeader = await this.collectCookieHeader().catch(() => '')
      throw new Error(
        this.hasLoginCookies(cookieHeader)
          ? '会话 Cookie 存在但社区未识别，请打开并刷新 https://developer.volcengine.com/articles/draft 后重试'
          : '未登录火山引擎开发者社区，请先打开并登录 https://developer.volcengine.com/articles/draft'
      )
    }
  }

  /** 2. 内容规整：剥离本地 data URI（本版本暂不支持本地图片） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    ctx.content.markdown = (ctx.content.markdown || '')
      .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
      .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')
  }

  /** 3. 上传图片：withVolcSession 保护下走 SharedImageCache 去重；软失败保留原 URL */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withVolcSession(async () => {
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        try {
          const result = await this.uploadImageByUrl(src)
          ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
          return result
        } catch (error) {
          logger.warn('外链转存失败，保留原 URL:', src.slice(0, 80), error)
          return { url: src }
        }
      }
      const opts: ImageProcessOptions = {
        skipPatterns: [
          'developer.volcengine.com',
          'volc-community',
          'byteimg.com',
          'tlddhu82om',
        ],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    })
  }

  /** 5. 构建 draft/publish 请求体 */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      article_info: {
        title: ctx.article.title,
        content: ctx.content.markdown,
        en_title: '',
        en_content: '',
      },
    }
  }

  /** 6. 提交：saveDraft（SW + Cookie 注入失败再页面 storage 中转） */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const data = await this.saveDraft(
      ctx.payload as {
        article_info: { title: string; content: string; en_title: string; en_content: string }
      },
    )
    const draftId = this.draftIdFrom(data)
    if (!draftId) {
      throw new Error(data.err_msg || '保存草稿失败: 无效响应')
    }
    logger.debug('Draft created:', draftId)
    return this.createResult(true, {
      postId: draftId,
      postUrl: `${BASE}/articles/draft/${draftId}`,
      draftOnly: true,
    })
  }

  /** Header 规则：火山用 withVolcSession 动态构建（含 Cookie 注入），此处返回空 */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return []
  }

  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    // 中间层目前不对腾讯云/火山传本地图；此方法保留给后续本地图支持
    return this.withVolcSession(() => this.uploadImageBinaryInternal(file))
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 本版本仅支持 http(s) 外链转存
    if (src.startsWith('data:') || src.startsWith('blob:')) {
      throw new Error('火山引擎本版本暂不支持本地图片，请改用外链或同步后手工补图')
    }
    if (!/^https?:\/\//i.test(src)) {
      throw new Error(`不支持的图片地址: ${src.slice(0, 80)}`)
    }

    try {
      logger.debug('Downloading remote image:', src.substring(0, 80))
      const response = await this.runtime.fetch(src, {
        method: 'GET',
      })

      if (!response.ok) {
        logger.warn('Failed to download image:', response.status)
        return { url: src }
      }

      const blob = await response.blob()
      const url = await this.uploadImageBinaryInternal(blob)
      logger.debug('Uploaded image:', src.substring(0, 50), '->', url)
      return { url }
    } catch (error) {
      logger.warn('Failed to upload image by URL:', src, error)
      return { url: src }
    }
  }

  private async getImageXToken(): Promise<ImageXToken> {
    if (this.cachedImageXToken && Date.now() < this.imageXTokenExpiry - 60000) {
      return this.cachedImageXToken
    }

    const url = `${BASE}/api/fe/v1/image/get-token?app_id=${APP_ID}`
    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
    })

    const responseText = await response.text()
    logger.debug('get-token response:', responseText.substring(0, 500))

    let data: ImageXTokenResponse
    try {
      data = JSON.parse(responseText) as ImageXTokenResponse
    } catch {
      throw new Error(`Invalid JSON response from get-token: ${responseText.substring(0, 200)}`)
    }

    if (data.err_no && data.err_no !== 0) {
      throw new Error(data.err_msg || `Failed to get ImageX token: err_no=${data.err_no}`)
    }

    const tokenData = data.data
    if (!tokenData?.access_key_id || !tokenData.secret_access_key || !tokenData.session_token) {
      throw new Error(`Invalid ImageX token response: ${responseText.substring(0, 200)}`)
    }

    const expiredTime = tokenData.expired_time
      ? new Date(tokenData.expired_time).getTime()
      : Date.now() + 3600_000

    this.cachedImageXToken = {
      AccessKeyId: tokenData.access_key_id,
      SecretAccessKey: tokenData.secret_access_key,
      SessionToken: tokenData.session_token,
      ExpiredTime: expiredTime,
    }
    this.imageXTokenExpiry = expiredTime

    logger.debug('Got ImageX token, expires at:', tokenData.expired_time)
    return this.cachedImageXToken
  }

  private async applyImageUpload(
    token: ImageXToken
  ): Promise<NonNullable<NonNullable<ImageXApplyUploadResponse['Result']>['UploadAddress']>> {
    const url = `${IMAGEX_HOST}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`

    const signResult = await signAWS4({
      method: 'GET',
      url,
      accessKeyId: token.AccessKeyId,
      secretAccessKey: token.SecretAccessKey,
      securityToken: token.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(url, {
      method: 'GET',
      headers: {
        ...signResult.headers,
      },
    })

    const data = await response.json() as ImageXApplyUploadResponse

    if (!data.Result?.UploadAddress) {
      throw new Error('Failed to apply image upload')
    }

    return data.Result.UploadAddress
  }

  private async uploadToTOS(
    uploadAddress: NonNullable<NonNullable<ImageXApplyUploadResponse['Result']>['UploadAddress']>,
    file: Blob
  ): Promise<void> {
    const storeInfo = uploadAddress.StoreInfos[0]
    const uploadHost = uploadAddress.UploadHosts[0]

    if (!storeInfo || !uploadHost) {
      throw new Error('Invalid upload address')
    }

    const uploadUrl = `https://${uploadHost}/${storeInfo.StoreUri}`

    const arrayBuffer = await file.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)
    const crc32Value = crc32(uint8Array)

    logger.debug('Uploading to TOS:', uploadUrl, 'size:', file.size, 'crc32:', crc32Value)

    const response = await this.runtime.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: storeInfo.Auth,
        'Content-Type': file.type || 'application/octet-stream',
        'Content-CRC32': crc32Value,
      },
      body: file,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`TOS upload failed: ${response.status} ${text}`)
    }

    logger.debug('TOS upload success')
  }

  private async commitImageUpload(
    token: ImageXToken,
    sessionKey: string
  ): Promise<NonNullable<ImageXCommitUploadResponse['Result']>> {
    const url = `${IMAGEX_HOST}/?Action=CommitImageUpload&Version=2018-08-01&SessionKey=${encodeURIComponent(sessionKey)}&ServiceId=${IMAGEX_SERVICE_ID}`

    const signResult = await signAWS4({
      method: 'POST',
      url,
      accessKeyId: token.AccessKeyId,
      secretAccessKey: token.SecretAccessKey,
      securityToken: token.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(url, {
      method: 'POST',
      headers: {
        ...signResult.headers,
        'Content-Length': '0',
      },
    })

    const data = await response.json() as ImageXCommitUploadResponse

    if (!data.Result) {
      throw new Error('Failed to commit image upload')
    }

    return data.Result
  }

  private async getImageUrl(uri: string): Promise<string> {
    const url = `${BASE}/api/fe/v1/image/get-url?uri=${encodeURIComponent(uri)}&app_id=${APP_ID}`

    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
    })

    const data = await response.json() as {
      data?: { main_url?: string; backup_url?: string }
      err_no?: number
      err_msg?: string
    }

    if (data.err_no && data.err_no !== 0) {
      throw new Error(data.err_msg || 'Failed to get image URL')
    }

    const imageUrl = data.data?.main_url || data.data?.backup_url
    if (!imageUrl) {
      throw new Error('Invalid image URL response')
    }

    return imageUrl
  }

  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    const token = await this.getImageXToken()

    const uploadAddress = await this.applyImageUpload(token)
    logger.debug('Apply upload success, session:', uploadAddress.SessionKey.substring(0, 50) + '...')

    await this.uploadToTOS(uploadAddress, file)

    const commitResult = await this.commitImageUpload(token, uploadAddress.SessionKey)
    logger.debug('Commit upload success:', commitResult.Results?.[0]?.Uri)

    const storeUri = uploadAddress.StoreInfos[0]?.StoreUri
    if (!storeUri) {
      throw new Error('No store URI in upload address')
    }

    const imageUrl = await this.getImageUrl(storeUri)
    logger.debug('Got image URL:', imageUrl)

    return imageUrl
  }
}
