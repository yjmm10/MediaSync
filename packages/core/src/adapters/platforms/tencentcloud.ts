/**
 * 腾讯云开发者社区适配器
 * https://cloud.tencent.com/developer/article/write-new
 *
 * - 登录检测：对齐 doocs/cose — GET /developer/creator 解析 HTML
 * - 草稿：POST /developer/api/article/addArticleDraft（Markdown 用 <!--markdown--> 包裹）
 * - 外链图：POST /developer/api/tools/save-http-image（本版本支持）
 * - 本地图（data URI / COS）：本版本暂不支持，正文中会剥离
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('TencentCloud')

const BASE = 'https://cloud.tencent.com'
const API = `${BASE}/developer/api`
const WRITE_NEW_URL = `${BASE}/developer/article/write-new`
/** 任意云社区页均可复用（加速 ensurePageTab） */
const PAGE_URL_PATTERN = '*://cloud.tencent.com/*'
/** COSE 同源：用创作中心页 HTML 判定登录，而非 sync-login-status */
const CREATOR_URL = `${BASE}/developer/creator`

/** SW fetch 常丢 SameSite Cookie，需从这些 domain 收集后经 DNR 注入 */
const COOKIE_DOMAINS = ['cloud.tencent.com', 'tencent.com']
const SESSION_COOKIE = 'qcommunity_session'
/** 仅注入与登录相关的 Cookie，避免 tencent.com 全量 Cookie 撑爆 DNR */
const COOKIE_NAME_ALLOW =
  /^(qcommunity_|qcloud_|qcmain|uin|skey|tinyid|loginType|refreshSession|ewpUid|intl|lastLoginIdentity)/i
/** 页面探测须短于扩展 AUTH_CHECK_TIMEOUT，避免整次 checkAuth 被掐死 */
const PAGE_LOGIN_PROBE_MS = 8_000

const SKIP_IMAGE_HOSTS = [
  'developer.qcloudimg.com',
  'ask.qcloudimg.com',
  'qcloudimg.com',
  // 覆盖 COS 直链（含私有桶签名 GET URL），避免二次转存
  'myqcloud.com',
]

/** plain 字段截断上限（全文再塞一遍易触发网关 1MB/413） */
const PLAIN_MAX = 4000
/** 草稿 JSON 建议上限（低于常见 1MB 网关） */
const PAYLOAD_MAX = 900_000

/** 去掉残留 data: 图，避免 base64 撑爆请求体 */
export function stripDataImages(markdown: string): string {
  return (markdown || '')
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
    .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')
}

/** 去掉 Markdown 语法，生成 plain / summary */
export function buildPlainText(markdown: string): string {
  return (markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Markdown 正文写入社区草稿时的包装格式 */
export function wrapMarkdownContent(markdown: string): string {
  return `<!--markdown-->\n${markdown}\n<!--/markdown-->`
}

/**
 * 对齐 doocs/cose `detectTencentCloudUser`：
 * GET /developer/creator，用 HTML + 最终 URL 判定登录态。
 */
export function authFromCreatorHtml(
  html: string,
  finalUrl: string
): AuthResult | null {
  if (!finalUrl.includes('/creator')) return null
  if (
    html.includes('登录/注册') ||
    html.includes('"isLogin":false') ||
    html.includes('"login":false')
  ) {
    return null
  }

  const userInfoMatch =
    html.match(/"userInfo"\s*:\s*\{[^}]*"nickname"\s*:\s*"([^"]+)"[^}]*\}/) ||
    html.match(/"creatorInfo"\s*:\s*\{[^}]*"nickname"\s*:\s*"([^"]+)"[^}]*\}/) ||
    html.match(/"currentUser"\s*:\s*\{[^}]*"nickname"\s*:\s*"([^"]+)"[^}]*\}/)

  const creatorNicknameMatch =
    html.match(
      /class="creator-info[^"]*"[^>]*>[\s\S]*?<[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)</
    ) || html.match(/"isCreator"\s*:\s*true[\s\S]*?"nickname"\s*:\s*"([^"]+)"/)

  const nicknameMatch = userInfoMatch || creatorNicknameMatch
  const avatarMatch =
    html.match(/"userInfo"[\s\S]*?"avatarUrl"\s*:\s*"([^"]+)"/) ||
    html.match(/"avatar"\s*:\s*"(https?:\/\/[^"]+)"/)

  if (nicknameMatch?.[1]) {
    const uidMatch = html.match(/qct-uid="(\d+)"/)
    return {
      isAuthenticated: true,
      userId: uidMatch?.[1],
      username: nicknameMatch[1],
      avatar: avatarMatch?.[1] || undefined,
    }
  }

  if (html.includes('创作中心') || html.includes('我的文章')) {
    const uidMatch = html.match(/qct-uid="(\d+)"/)
    return {
      isAuthenticated: true,
      userId: uidMatch?.[1],
      username: uidMatch?.[1] ? `用户${uidMatch[1]}` : '',
    }
  }

  return null
}

export class TencentCloudAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'tencentcloud',
    name: '腾讯云社区',
    icon: 'https://cloud.tencent.com/favicon.ico',
    homepage: `${BASE}/developer/article/write-new`,
    capabilities: ['article', 'draft'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      { kind: 'column', key: 'column', label: '专栏', source: 'remote' },
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
      { kind: 'comments', key: 'commentsEnabled', label: '允许评论' },
      { kind: 'summary', key: 'summary', label: '摘要' },
    ],
  }

  /** 收集社区相关 Cookie，供 DNR 注入（绕过 SW 丢 SameSite 会话） */
  private async collectCookieHeader(): Promise<string> {
    const map = new Map<string, string>()
    for (const domain of COOKIE_DOMAINS) {
      try {
        const list = await this.runtime.cookies.get(domain)
        for (const c of list) {
          if (!c.name || map.has(c.name)) continue
          if (!COOKIE_NAME_ALLOW.test(c.name)) continue
          map.set(c.name, c.value)
        }
      } catch (error) {
        logger.debug(`cookies.get(${domain}) failed:`, error)
      }
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 动态注入 Cookie/Origin/Referer，resourceTypes 含 other（SW fetch） */
  private async withCommunitySession<T>(fn: () => Promise<T>): Promise<T> {
    const cookieHeader = await this.collectCookieHeader()
    const apiHeaders: Record<string, string> = {
      Origin: BASE,
      Referer: WRITE_NEW_URL,
    }
    if (cookieHeader) {
      apiHeaders.Cookie = cookieHeader
    }

    const rules = [
      {
        // 覆盖创作中心页 + API（登录探测会 GET /developer/creator）
        urlFilter: '*://cloud.tencent.com/developer/*',
        headers: apiHeaders,
        resourceTypes: ['xmlhttprequest', 'other'],
      },
      {
        urlFilter: '*://*.myqcloud.com/*',
        headers: {
          Origin: BASE,
          Referer: WRITE_NEW_URL,
        },
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    ]

    return this.withHeaderRules(rules, fn)
  }

  /** SW：带 Cookie 注入拉取创作中心 HTML（对齐 COSE） */
  private async detectAuthViaCreatorPage(): Promise<AuthResult | null> {
    return this.withCommunitySession(async () => {
      const res = await this.runtime.fetch(CREATOR_URL, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: `${BASE}/developer`,
        },
        redirect: 'follow',
      })
      const html = await res.text()
      const finalUrl = res.url || CREATOR_URL
      return authFromCreatorHtml(html, finalUrl)
    })
  }

  /** 页面上下文：同源 fetch 创作中心（第一方 Cookie） */
  private async detectAuthViaPageContext(): Promise<AuthResult | null> {
    if (!this.runtime.tabs) return null

    const probe = this.runOnPageTab(PAGE_URL_PATTERN, CREATOR_URL, async (tabId) => {
      const result = await this.runtime.tabs!.executeScript(
        tabId,
        async (url: string, timeoutMs: number) => {
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
            const response = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              signal: controller.signal,
            })
            clearTimeout(timeoutId)
            const html = await response.text()
            return { ok: true as const, html, finalUrl: response.url || url }
          } catch (error) {
            return {
              ok: false as const,
              error: (error as Error)?.message || String(error),
            }
          }
        },
        [CREATOR_URL, PAGE_LOGIN_PROBE_MS - 500]
      )
      return result
    })

    const raced = await Promise.race([
      probe,
      this.delay(PAGE_LOGIN_PROBE_MS).then(() => {
        throw new Error(`页面登录探测超时（${PAGE_LOGIN_PROBE_MS / 1000}s）`)
      }),
    ])

    if (!raced || !('ok' in raced) || !raced.ok) {
      throw new Error(
        raced && 'error' in raced ? String(raced.error) : '页面登录探测失败'
      )
    }
    return authFromCreatorHtml(raced.html, raced.finalUrl)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookieHeader = await this.collectCookieHeader()

      // 主路径：对齐 COSE tabContextFetch — 在云社区页 MAIN world 拉创作中心（SameSite Cookie 可靠）
      try {
        const fromPage = await this.detectAuthViaPageContext()
        if (fromPage) return fromPage
      } catch (error) {
        logger.debug('creator page context detect failed:', error)
      }

      // 回退：SW + DNR Cookie 注入后再拉创作中心 HTML（对齐 COSE detectTencentCloudUser）
      try {
        const fromCreator = await this.detectAuthViaCreatorPage()
        if (fromCreator) return fromCreator
      } catch (error) {
        logger.debug('creator page SW detect failed:', error)
      }

      if (cookieHeader.includes(`${SESSION_COOKIE}=`)) {
        return {
          isAuthenticated: false,
          error: '会话 Cookie 存在但创作中心未识别登录，请打开并刷新 https://cloud.tencent.com/developer/creator 后重试',
        }
      }
      return {
        isAuthenticated: false,
        error: '未登录腾讯云开发者社区，请先打开并登录 https://cloud.tencent.com/developer/creator',
      }
    } catch (error) {
      logger.debug('checkAuth failed:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (SKIP_IMAGE_HOSTS.some((h) => src.includes(h))) {
      return { url: src }
    }

    // 本版本仅支持 http(s) 外链转存；本地 data URI / blob 不处理
    if (src.startsWith('data:') || src.startsWith('blob:')) {
      throw new Error('腾讯云社区本版本暂不支持本地图片，请改用外链或同步后手工补图')
    }

    if (/^https?:\/\//i.test(src)) {
      const data = await this.postApi<{ url?: string }>('/tools/save-http-image', { url: src })
      if (!data?.url) {
        throw new Error('外链图片转存失败')
      }
      return { url: data.url }
    }

    throw new Error(`不支持的图片地址: ${src.slice(0, 80)}`)
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：页面上下文 + SW 探测（对齐原 publish 的 detectAuth 级联） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    const authed =
      (await this.detectAuthViaPageContext().catch(() => null)) ||
      (await this.detectAuthViaCreatorPage().catch(() => null))
    if (!authed) {
      throw new Error(
        '请先登录腾讯云开发者社区（打开 https://cloud.tencent.com/developer/creator）'
      )
    }
  }

  /** 2. 内容规整：确保 markdown 非空 + 剥离本地 data URI + 末尾空行（修复结尾引用第一行不生效） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    const markdown = (ctx.content.markdown || '').trim()
    if (!markdown) {
      throw new Error('文章内容为空（未得到 Markdown），请重试同步')
    }
    ctx.content.markdown = stripDataImages(markdown)
    // 结尾单独引用块会导致第一行不生效：末尾补两个换行，避免紧贴 <!--/markdown-->
    if (/(^|\n)\s*>/.test(ctx.content.markdown)) {
      ctx.content.markdown = ctx.content.markdown.replace(/\s*$/, '\n\n')
    }
  }

  /** 3. 上传图片：withCommunitySession 保护下走 SharedImageCache 去重 + processImages */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withCommunitySession(async () => {
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        try {
          const result = await this.uploadImageByUrl(src)
          ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
          return result
        } catch (error) {
          // 外链转存失败时保留原链，避免整篇失败
          logger.warn('外链转存失败，保留原 URL:', src.slice(0, 80), (error as Error).message)
          return { url: src }
        }
      }
      const opts: ImageProcessOptions = {
        skipPatterns: SKIP_IMAGE_HOSTS,
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    })
  }

  /** 5. 构建 addArticleDraft 请求体（含 plain 截断与体积检查） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const plainFull = buildPlainText(ctx.content.markdown)
    let plain = plainFull.slice(0, PLAIN_MAX)
    const body: Record<string, unknown> = {
      articleId: 0,
      title: ctx.article.title,
      content: wrapMarkdownContent(ctx.content.markdown),
      plain,
      sourceType: 0,
      classifyIds: [] as number[],
      tagIds: [] as number[],
      longtailTag: [] as string[],
      columnIds: [] as number[],
      openComment: 1,
      closeTextLink: 0,
      userSummary: '',
      pic: '',
      sourceDetail: {},
      zoneName: '',
      summary: plainFull.slice(0, 120),
    }

    let payloadLen = JSON.stringify(body).length
    if (payloadLen > PAYLOAD_MAX && plain.length > 120) {
      plain = plainFull.slice(0, 120)
      body.plain = plain
      payloadLen = JSON.stringify(body).length
    }
    if (payloadLen > PAYLOAD_MAX) {
      throw new Error(
        `草稿过大（约 ${Math.round(payloadLen / 1024)} KB），请减少正文或图片后重试`
      )
    }
    ctx.payload = body
  }

  /** 6. 提交：addArticleDraft（SW + withCommunitySession）失败再页面上下文 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    let res: { draftId?: number }
    try {
      res = await this.withCommunitySession(() =>
        this.postApi<{ draftId?: number }>('/article/addArticleDraft', ctx.payload as Record<string, unknown>)
      )
    } catch (error) {
      const msg = (error as Error).message || ''
      if (/还未登录|未登录|HTTP 401|\b401\b/.test(msg)) {
        logger.warn('addArticleDraft 鉴权失败，页面上下文重试:', msg)
      } else {
        logger.warn('addArticleDraft via SW failed, retry in page:', error)
      }
      try {
        res = await this.postDraftViaPage(ctx.payload as Record<string, unknown>)
      } catch (pageError) {
        const pageMsg = (pageError as Error).message || ''
        if (/HTTP 401|\b401\b|还未登录|未登录|登录页 HTML/.test(pageMsg)) {
          throw new Error(
            '保存草稿失败：未登录（HTTP 401）。请在同一 Chrome 打开并登录云社区后重试'
          )
        }
        throw pageError
      }
    }
    if (!res?.draftId) {
      throw new Error('保存草稿失败：未返回 draftId')
    }
    const draftId = String(res.draftId)
    return this.createResult(true, {
      postId: draftId,
      postUrl: `${WRITE_NEW_URL}?draftId=${draftId}`,
      draftOnly: true,
    })
  }

  /** Header 规则：腾讯云用 withCommunitySession 动态构建（含 Cookie 注入），此处返回空 */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return []
  }

  private async postApi<T>(path: string, data: Record<string, unknown>): Promise<T> {
    const url = path.startsWith('http') ? path : `${API}${path.startsWith('/') ? path : `/${path}`}`
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })

    const text = await response.text()
    let json: T & { msg?: string; message?: string; code?: number }
    try {
      json = JSON.parse(text) as T & { msg?: string; message?: string; code?: number }
    } catch {
      if (response.status === 413) {
        const kb = Math.round((JSON.stringify(data).length || 0) / 1024)
        throw new Error(`草稿过大（HTTP 413，约 ${kb} KB），请减少正文或图片后重试`)
      }
      throw new Error(`接口返回非 JSON: HTTP ${response.status}`)
    }

    if (!response.ok) {
      // 社区未登录时为 HTTP 401 + code:401（勿与业务码混淆）
      if (response.status === 401 || json.code === 401) {
        throw new Error(json.msg || '你还未登录，请先登录')
      }
      if (response.status === 413) {
        const kb = Math.round((JSON.stringify(data).length || 0) / 1024)
        throw new Error(`草稿过大（HTTP 413，约 ${kb} KB），请减少正文或图片后重试`)
      }
      const errMsg = json.msg || json.message || `请求失败 HTTP ${response.status}`
      if (/请求体非法/.test(errMsg) && JSON.stringify(data).length > 1000) {
        const kb = Math.round(JSON.stringify(data).length / 1024)
        throw new Error(`草稿过大（HTTP ${response.status}，约 ${kb} KB），请减少正文或图片后重试`)
      }
      throw new Error(errMsg)
    }
    if (json.msg && (json.code === 400 || json.code === 51 || json.code === 5000001)) {
      throw new Error(json.msg)
    }
    return json
  }

  /**
   * 页面上下文提交草稿：正文经 storage 中转，避免 executeScript args 大 body 413/丢参 →「请求体非法」。
   * 仅腾讯云使用（ISOLATED + chrome.storage）。调用方须在 withCommunitySession 之外执行。
   */
  private async postDraftViaPage(
    data: Record<string, unknown>
  ): Promise<{ draftId?: number }> {
    if (!this.runtime.tabs?.executeScript) {
      throw new Error('当前运行时不支持页面上下文请求')
    }

    const bodyStr = JSON.stringify(data)
    if (!bodyStr || bodyStr === '{}') {
      throw new Error('草稿正文为空，无法提交')
    }

    const key = `tencentcloud:addArticleDraft:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    const url = `${API}/article/addArticleDraft`
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
      const result = await this.runOnPageTab(PAGE_URL_PATTERN, WRITE_NEW_URL, async (tabId) => {
        return this.runtime.tabs!.executeScript(
          tabId,
          async (storageKey: string, fetchUrl: string) => {
            const chromeApi = (
              globalThis as unknown as {
                chrome?: {
                  storage: {
                    local: {
                      get: (key: string) => Promise<Record<string, unknown>>
                      remove: (key: string) => Promise<void>
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
                    Accept: 'application/json, text/plain, */*',
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

      let json: { draftId?: number; msg?: string; message?: string; code?: number }
      try {
        json = JSON.parse(result.text) as typeof json
      } catch {
        throw new Error(`页面响应非 JSON HTTP ${result.status}: ${result.text.slice(0, 120)}`)
      }

      if (!result.ok) {
        if (result.status === 401 || json.code === 401) {
          throw new Error(json.msg || '你还未登录，请先登录')
        }
        const msg = json.msg || json.message || ''
        const bodyLen = result.bodyLen ?? 0
        if (bodyLen === 0) {
          throw new Error('页面重试未带上正文（bodyLen=0）。请重试同步')
        }
        if (
          result.status === 413 ||
          /请求体非法/.test(msg) ||
          /请求体非法/.test(result.text)
        ) {
          throw new Error(
            `草稿过大（HTTP ${result.status}，约 ${Math.round(bodyLen / 1024)} KB），请减少正文或图片后重试`
          )
        }
        throw new Error(msg || `页面请求失败 HTTP ${result.status}: ${result.text.slice(0, 160)}`)
      }
      if (json.msg && (json.code === 400 || json.code === 51 || json.code === 5000001)) {
        throw new Error(json.msg)
      }
      return json
    } finally {
      try {
        await this.runtime.storage.remove(key)
      } catch {
        // ignore
      }
    }
  }
}
