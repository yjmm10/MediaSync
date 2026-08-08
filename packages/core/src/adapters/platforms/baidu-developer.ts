/**
 * 百度开发者中心适配器
 * https://developer.baidu.com/article/create.html
 *
 * 仅保存草稿；正文为原生 Markdown（mdContent）+ 简易 HTML（htmlContent）。
 * 鉴权：GET /api/bce_developer/user/current
 * （本地浏览器验证：credentials:include 才有 result；omit 仅 success 无 result）
 * 顺序：SW+安全 Cookie DNR → 已开标签 → pageFetchJson(CREATE_URL) 自动开页。
 * CSRF：优先 cookie bce-user-info，回退 bce-user-info-ct-id → header csrftoken
 * 图片：POST /api/bce_developer/upload/image（FormData 字段 name）；外链与本地均支持。
 * Mermaid 不支持（原样保留代码块）；公式行内/块级均使用 $$...$$。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('BaiduDeveloper')

const BASE = 'https://developer.baidu.com'
const API = `${BASE}/api/bce_developer`
const CREATE_URL = `${BASE}/article/create.html`
const PAGE_URL_PATTERN = '*://developer.baidu.com/*'
const USER_URL = `${API}/user/current`
const UPLOAD_URL = `${API}/upload/image`
const ARTICLE_URL = `${API}/article`

/**
 * Cookie 收集域：按站点作用域，避免 baidu.com 全量撑爆/污染 DNR。
 * 本地页实测会话键在 developer.baidu.com（bce-session / bce-user-info 等）。
 */
const COOKIE_DOMAINS = [
  'bce.baidu.com',
  'cloud.baidu.com',
  'passport.baidu.com',
  'developer.baidu.com', // 最具体，collect 时后者覆盖前者
]
/** 仅从 .baidu.com 补这些会话相关名（不全量注入） */
const BAIDU_COM_SESSION_NAMES = new Set([
  'bce-session',
  'bce-passport-stoken',
  'bce-user-info',
  'bce-user-info-ct-id',
  'loginUserId',
  'BDUSS',
  'BDUSS_BFESS',
  'STOKEN',
])
const SESSION_COOKIE = 'bce-session'
const CSRF_COOKIE = 'bce-user-info'
const CSRF_COOKIE_FALLBACK = 'bce-user-info-ct-id'
const SKIP_IMAGE_HOSTS = ['bce.bdstatic.com']
const PAGE_UPLOAD_INLINE_MAX_BYTES = 200 * 1024

interface BaiduDevApiResponse<T = unknown> {
  success?: boolean
  status?: number
  result?: T
  code?: string
  message?: string | { global?: string; detail?: unknown }
  error?: {
    code?: string
    message?: string
    detail?: { global?: string }
  }
}

interface BaiduDevUser {
  id?: number
  displayName?: string
  nickname?: string
  avatar?: string
  authorId?: number
}

interface BaiduDevArticleResult {
  id?: number
  title?: string
  status?: string
}

interface BaiduDevUploadResult {
  fileName?: string
  fileSize?: number
  fileUrl?: string
}

function stripCookieQuotes(value: string): string {
  return value.replace(/^["'](.*)["']$/, '$1')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function splitTableCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableCells(line)
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c))
}

function inlineToHtml(text: string): string {
  if (!text) return ''
  // 保护 $$公式$$ / `code` / 图片 / 链接
  const parts: string[] = []
  const protect = (html: string) => {
    const i = parts.length
    parts.push(html)
    return `\0H${i}\0`
  }
  let work = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) =>
    protect(`<span class="tex">$$${escapeHtml(body.trim())}$$</span>`)
  )
  work = work.replace(/`([^`]+)`/g, (_m, body: string) =>
    protect(`<code>${escapeHtml(body)}</code>`)
  )
  work = work.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, alt: string, src: string) =>
      protect(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}" />`)
  )
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
    protect(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
  )
  work = escapeHtml(work)
  work = work
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
  work = work.replace(/\0H(\d+)\0/g, (_m, idx: string) => parts[Number(idx)] || '')
  return work
}

/**
 * Markdown → 简易 HTML（无 DOM）。Mermaid 保留为代码块；公式保留 $$...$$。
 */
export function markdownToBaiduDeveloperHtml(markdown: string): string {
  const src = (markdown || '').replace(/\r\n/g, '\n')
  const placeholders: string[] = []
  const protect = (block: string): string => {
    const idx = placeholders.length
    placeholders.push(block)
    return `\0BLK${idx}\0`
  }

  let work = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) =>
    protect(
      JSON.stringify({
        kind: 'code',
        lang: lang || '',
        body: body.replace(/\n$/, ''),
      })
    )
  )
  // 独占一行的块级公式
  work = work.replace(/(^|\n)\$\$([\s\S]+?)\$\$(?=\n|$)/g, (_m, lead: string, body: string) =>
    `${lead}${protect(JSON.stringify({ kind: 'formula', body: body.trim() }))}`
  )

  const lines = work.split('\n')
  const parts: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const ph = line.match(/^\0BLK(\d+)\0\s*$/)
    if (ph) {
      try {
        const meta = JSON.parse(placeholders[Number(ph[1])]) as {
          kind: string
          lang?: string
          body: string
        }
        if (meta.kind === 'code') {
          const lang = escapeHtml(meta.lang || '')
          parts.push(
            `<pre${lang ? ` data-lang="${lang}"` : ''}><code>${escapeHtml(meta.body || '')}</code></pre>`
          )
        } else if (meta.kind === 'formula') {
          parts.push(`<p class="tex">$$${escapeHtml(meta.body)}$$</p>`)
        }
      } catch {
        parts.push(`<p>${inlineToHtml(line)}</p>`)
      }
      i++
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const lv = heading[1].length
      parts.push(`<h${lv}>${inlineToHtml(heading[2])}</h${lv}>`)
      i++
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      parts.push('<hr>')
      i++
      continue
    }

    if (/\|/.test(line) && /^\s*\|?.*\|.*\|?\s*$/.test(line)) {
      const tableLines: string[] = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        tableLines.push(lines[i])
        i++
      }
      const hasSep = tableLines.length >= 2 && isTableSeparatorRow(tableLines[1])
      const rows = tableLines.filter((_l, idx) => !(hasSep && idx === 1)).map(splitTableCells)
      const trs = rows
        .map((row, rowIdx) => {
          const tag = hasSep && rowIdx === 0 ? 'th' : 'td'
          return `<tr>${row.map((c) => `<${tag}>${inlineToHtml(c)}</${tag}>`).join('')}</tr>`
        })
        .join('')
      parts.push(`<table>${trs}</table>`)
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      parts.push(`<blockquote><p>${inlineToHtml(quoteLines.join(' '))}</p></blockquote>`)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inlineToHtml(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`)
        i++
      }
      parts.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineToHtml(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`)
        i++
      }
      parts.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    const paraLines: string[] = [line]
    i++
    while (i < lines.length) {
      const next = lines[i]
      if (!next.trim()) break
      if (/^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\0BLK\d+\0)/.test(next)) break
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break
      if (/\|/.test(next) && /^\s*\|?.*\|.*\|?\s*$/.test(next)) break
      paraLines.push(next)
      i++
    }
    parts.push(`<p>${inlineToHtml(paraLines.join('\n'))}</p>`)
  }

  return parts.join('\n')
}

/** 从 user/current 响应解析鉴权（可单测） */
export function authFromBaiduDevUser(
  data: BaiduDevApiResponse<BaiduDevUser> | null | undefined
): AuthResult | null {
  const user = data?.result
  if (!data?.success || !user?.id) return null
  return {
    isAuthenticated: true,
    userId: String(user.id),
    username: user.nickname || user.displayName,
    avatar: user.avatar,
  }
}

export class BaiduDeveloperAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'baidu-developer',
    name: '百度开发者中心',
    icon: 'https://developer-resource.bj.bcebos.com/images/developerLogo.ico',
    homepage: CREATE_URL,
    capabilities: ['article', 'draft'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /**
   * 按开发者中心作用域收集 Cookie（避免 baidu.com 无过滤全量）。
   * .baidu.com 仅补会话相关名。
   */
  private async collectCookieHeader(): Promise<string> {
    const map = new Map<string, string>()

    for (const domain of COOKIE_DOMAINS) {
      try {
        const list = await this.runtime.cookies.get(domain)
        for (const c of list) {
          if (!c.name || !c.value) continue
          map.set(c.name, c.value)
        }
      } catch (error) {
        logger.debug(`cookies.get(${domain}) failed:`, error)
      }
    }

    // 补 .baidu.com 上的会话名（不全量）
    try {
      const root = await this.runtime.cookies.get('baidu.com')
      for (const c of root) {
        if (!c.name || !c.value) continue
        if (BAIDU_COM_SESSION_NAMES.has(c.name)) {
          if (!map.has(c.name)) map.set(c.name, c.value)
        }
      }
    } catch (error) {
      logger.debug('cookies.get(baidu.com) filtered failed:', error)
    }

    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private hasLoginCookies(cookieHeader: string): boolean {
    if (!cookieHeader) return false
    return (
      cookieHeader.includes(`${SESSION_COOKIE}=`) ||
      cookieHeader.includes('bce-passport-stoken=') ||
      cookieHeader.includes(`${CSRF_COOKIE}=`) ||
      cookieHeader.includes(`${CSRF_COOKIE_FALLBACK}=`) ||
      cookieHeader.includes('loginUserId=') ||
      cookieHeader.includes('bce-user-info=')
    )
  }

  /**
   * 动态注入 Origin/Referer；Cookie 注入失败则降级为仅 Origin/Referer。
   * （Chromium 可能禁止 DNR 改 Cookie；本地验证成功依赖页面 credentials:include）
   */
  private async withDeveloperSession<T>(fn: () => Promise<T>): Promise<T> {
    const cookieHeader = await this.collectCookieHeader()
    const baseHeaders: Record<string, string> = {
      Origin: BASE,
      Referer: CREATE_URL,
    }
    const withCookie: Record<string, string> = { ...baseHeaders }
    if (cookieHeader) withCookie.Cookie = cookieHeader

    const makeRules = (headers: Record<string, string>) => [
      {
        urlFilter: '*://developer.baidu.com/api/bce_developer/*',
        headers,
        resourceTypes: ['xmlhttprequest', 'other'] as string[],
      },
    ]

    try {
      return await this.withHeaderRules(makeRules(withCookie), fn)
    } catch (error) {
      if (withCookie.Cookie) {
        logger.debug('DNR Cookie inject failed, retry Origin/Referer only:', error)
        return this.withHeaderRules(makeRules(baseHeaders), fn)
      }
      throw error
    }
  }

  private authFromUser(user: BaiduDevUser | null | undefined): AuthResult | null {
    if (!user?.id) return null
    return {
      isAuthenticated: true,
      userId: String(user.id),
      username: user.nickname || user.displayName,
      avatar: user.avatar,
    }
  }

  private async getCsrfToken(): Promise<string> {
    const cookieHeader = await this.collectCookieHeader()
    const names = [CSRF_COOKIE, CSRF_COOKIE_FALLBACK]
    if (cookieHeader) {
      for (const name of names) {
        const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
        const m = cookieHeader.match(re)
        if (m?.[1]) {
          let raw = m[1]
          try {
            raw = decodeURIComponent(raw)
          } catch {
            // keep raw
          }
          const token = stripCookieQuotes(raw)
          if (token) return token
        }
      }
    }

    if (this.runtime.getCookie) {
      for (const name of names) {
        for (const domain of COOKIE_DOMAINS) {
          const raw = await this.runtime.getCookie(domain, name)
          if (raw) {
            let v = raw
            try {
              v = decodeURIComponent(v)
            } catch {
              // keep
            }
            const token = stripCookieQuotes(v)
            if (token) return token
          }
        }
      }
    }

    throw new Error('请先登录百度开发者中心')
  }

  private async fetchUser(): Promise<BaiduDevUser | null> {
    const csrf = await this.getCsrfToken().catch(() => '')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (csrf) headers.csrftoken = csrf

    const response = await this.runtime.fetch(USER_URL, {
      method: 'GET',
      credentials: 'include',
      headers,
    })
    const text = await response.text()
    let data: BaiduDevApiResponse<BaiduDevUser>
    try {
      data = JSON.parse(text) as BaiduDevApiResponse<BaiduDevUser>
    } catch {
      throw new Error(`响应不是有效 JSON: ${text.substring(0, 100)}`)
    }
    if (!data.success) {
      throw new Error(this.extractError(data) || '请求失败')
    }
    return data.result ?? null
  }

  /**
   * 仅在已打开的开发者中心标签页内探测登录（不 create / 不导航）。
   * 无可用标签时返回 null。
   */
  private async fetchUserViaExistingTab(): Promise<BaiduDevUser | null> {
    if (!this.runtime.tabs?.query || !this.runtime.tabs.executeScript) return null

    const tabs = await this.runtime.tabs.query([
      '*://developer.baidu.com/article/*',
      '*://developer.baidu.com/*',
    ])
    const tabId = tabs.find((t) => t.id !== undefined)?.id
    if (tabId === undefined) return null

    const csrf = await this.getCsrfToken().catch(() => '')

    try {
      const pageResult = await this.runtime.tabs.executeScript(
        tabId,
        async (url: string, token: string) => {
          try {
            const headers: Record<string, string> = {
              Accept: 'application/json',
            }
            if (token) headers.csrftoken = token
            const res = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              headers,
            })
            const text = await res.text()
            return { ok: res.ok, status: res.status, text }
          } catch (error) {
            return {
              ok: false,
              status: 0,
              text: '',
              error: (error as Error)?.message || String(error),
            }
          }
        },
        [USER_URL, csrf]
      )

      const result = pageResult as {
        ok?: boolean
        text?: string
        error?: string
      } | null
      if (result?.error || !result?.text?.trim()) {
        logger.debug('existing-tab auth probe failed:', result?.error || 'empty')
        return null
      }
      const trimmed = result.text.trim()
      if (trimmed.startsWith('<') || /<!DOCTYPE|<html/i.test(trimmed.slice(0, 80))) {
        logger.debug('existing-tab auth probe got HTML')
        return null
      }
      let data: BaiduDevApiResponse<BaiduDevUser>
      try {
        data = JSON.parse(result.text) as BaiduDevApiResponse<BaiduDevUser>
      } catch {
        logger.debug('existing-tab auth probe non-JSON')
        return null
      }
      if (!data.success || !data.result?.id) {
        logger.debug('existing-tab auth probe rejected:', this.extractError(data))
        return null
      }
      return data.result
    } catch (error) {
      logger.debug('existing-tab auth executeScript failed:', error)
      return null
    }
  }

  /** 是否已有可复用的开发者中心标签（不 create） */
  private async hasExistingDeveloperTab(): Promise<boolean> {
    if (!this.runtime.tabs?.query) return false
    const tabs = await this.runtime.tabs.query([
      '*://developer.baidu.com/article/*',
      '*://developer.baidu.com/*',
    ])
    return tabs.some((t) => t.id !== undefined)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookieHeader = await this.collectCookieHeader()
      const hasSession = this.hasLoginCookies(cookieHeader)

      // ① SW + 安全 Cookie DNR（失败降级 Origin/Referer）
      const fromSw = await this.withDeveloperSession(async () => {
        try {
          return await this.fetchUser()
        } catch (error) {
          logger.debug('user/current via SW failed:', error)
          return null
        }
      })
      const authSw = this.authFromUser(fromSw)
      if (authSw) return authSw

      // ② 已打开开发者中心标签（页面 credentials:include，与本地浏览器验证一致）
      try {
        const pageUser = await this.fetchUserViaExistingTab()
        const fromPage = this.authFromUser(pageUser)
        if (fromPage) return fromPage
      } catch (error) {
        logger.debug('existing-tab login probe failed:', error)
      }

      // ③ 自动开 create 页再探测（无 Chrome 标签时的回退）
      try {
        const csrf = await this.getCsrfToken().catch(() => '')
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (csrf) headers.csrftoken = csrf
        const data = await this.pageFetchJson<BaiduDevApiResponse<BaiduDevUser>>(
          PAGE_URL_PATTERN,
          CREATE_URL,
          USER_URL,
          { method: 'GET', headers }
        )
        const fromAuto = this.authFromUser(data?.result)
        if (fromAuto) return fromAuto
        if (data && data.success === false) {
          return {
            isAuthenticated: false,
            error: this.extractError(data) || '登录态无效',
          }
        }
      } catch (error) {
        logger.debug('pageFetchJson login probe failed:', error)
      } finally {
        await this.releaseEphemeralTabs()
      }

      const hasTab = await this.hasExistingDeveloperTab()
      if (hasSession) {
        if (hasTab) {
          return {
            isAuthenticated: false,
            error: '会话 Cookie 存在但社区未识别，请刷新百度开发者中心页后重新检测',
          }
        }
        return {
          isAuthenticated: false,
          error: `会话 Cookie 存在但未识别；请确认已登录 ${CREATE_URL} 后重试`,
        }
      }

      return {
        isAuthenticated: false,
        error: '未登录百度开发者中心（未找到会话 Cookie）',
      }
    } catch (error) {
      logger.debug('checkAuth failed:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private imageFilenameFromMime(mime: string): string {
    const ext =
      mime.includes('png')
        ? 'png'
        : mime.includes('gif')
          ? 'gif'
          : mime.includes('webp')
            ? 'webp'
            : 'jpg'
    return `image.${ext}`
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }

  private async uploadBlob(file: Blob, filename: string): Promise<string> {
    const csrf = await this.getCsrfToken()
    const formData = new FormData()
    formData.append('name', file, filename)
    const data = await this.postMultipart<BaiduDevApiResponse<BaiduDevUploadResult>>(
      UPLOAD_URL,
      formData,
      { csrftoken: csrf }
    )
    if (data.success && data.result?.fileUrl) {
      return data.result.fileUrl
    }
    throw new Error(this.extractError(data) || '图片上传失败')
  }

  private async uploadImageViaPageTab(src: string): Promise<ImageUploadResult> {
    if (!this.runtime.tabs?.executeScript) {
      throw new Error('当前运行时不支持页面上下文上传')
    }

    const csrf = await this.getCsrfToken().catch(() => '')
    const isHttp = /^https?:\/\//i.test(src)

    type PageUploadPayload =
      | {
          mode: 'url'
          imageUrl: string
          filename: string
          csrf: string
          uploadUrl: string
        }
      | {
          mode: 'inline'
          base64: string
          mime: string
          filename: string
          csrf: string
          uploadUrl: string
        }
      | {
          mode: 'storage'
          storageKey: string
          csrf: string
          uploadUrl: string
        }

    let payload: PageUploadPayload
    let storageKey: string | null = null

    if (isHttp) {
      payload = {
        mode: 'url',
        imageUrl: src,
        filename: 'image.png',
        csrf,
        uploadUrl: UPLOAD_URL,
      }
    } else {
      const imgRes = await this.runtime.fetch(src, { credentials: 'omit' })
      if (!imgRes.ok) {
        throw new Error(`读取图片失败: ${imgRes.status}`)
      }
      const blob = await imgRes.blob()
      const mime = blob.type || 'image/png'
      const filename = this.imageFilenameFromMime(mime)
      const base64 = await this.blobToBase64(blob)
      if (blob.size <= PAGE_UPLOAD_INLINE_MAX_BYTES) {
        payload = {
          mode: 'inline',
          base64,
          mime,
          filename,
          csrf,
          uploadUrl: UPLOAD_URL,
        }
      } else {
        storageKey = `baidu-dev:upload:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
        await this.runtime.storage.set(storageKey, { base64, mime, filename })
        payload = {
          mode: 'storage',
          storageKey,
          csrf,
          uploadUrl: UPLOAD_URL,
        }
      }
    }

    const world = payload.mode === 'storage' ? ('ISOLATED' as const) : ('MAIN' as const)

    try {
      const pageResult = await this.runOnPageTab(PAGE_URL_PATTERN, CREATE_URL, (tabId) =>
        this.runtime.tabs!.executeScript(
          tabId,
          async (p: {
            mode: 'url' | 'inline' | 'storage'
            imageUrl?: string
            base64?: string
            mime?: string
            filename?: string
            storageKey?: string
            csrf: string
            uploadUrl: string
          }) => {
            try {
              let fileBlob: Blob
              let filename = p.filename || 'image.png'
              let mime = p.mime || 'image/png'

              if (p.mode === 'url') {
                const imgRes = await fetch(p.imageUrl!, { credentials: 'omit' })
                if (!imgRes.ok) {
                  return {
                    ok: false,
                    status: imgRes.status,
                    text: '',
                    error: `页面下载图片失败 HTTP ${imgRes.status}`,
                  }
                }
                fileBlob = await imgRes.blob()
                mime = fileBlob.type || mime
                if (mime.includes('png')) filename = 'image.png'
                else if (mime.includes('gif')) filename = 'image.gif'
                else if (mime.includes('webp')) filename = 'image.webp'
                else filename = 'image.jpg'
              } else if (p.mode === 'inline') {
                const raw = atob(p.base64!)
                const arr = new Uint8Array(raw.length)
                for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
                fileBlob = new Blob([arr], { type: mime })
              } else {
                const key = p.storageKey!
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
                    error: '页面上下文无 chrome.storage（需 ISOLATED）',
                  }
                }
                const bagResult = await chromeApi.storage.local.get(key)
                const bag = bagResult[key] as
                  | { base64?: string; mime?: string; filename?: string }
                  | undefined
                try {
                  await chromeApi.storage.local.remove(key)
                } catch {
                  // ignore
                }
                if (!bag?.base64) {
                  return {
                    ok: false,
                    status: 0,
                    text: '',
                    error: 'storage 中未找到图片载荷',
                  }
                }
                mime = bag.mime || mime
                filename = bag.filename || filename
                const raw = atob(bag.base64)
                const arr = new Uint8Array(raw.length)
                for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
                fileBlob = new Blob([arr], { type: mime })
              }

              const fd = new FormData()
              fd.append('name', fileBlob, filename)
              const headers: Record<string, string> = {}
              if (p.csrf) headers.csrftoken = p.csrf
              const res = await fetch(p.uploadUrl, {
                method: 'POST',
                credentials: 'include',
                headers,
                body: fd,
              })
              const text = await res.text()
              return { ok: res.ok, status: res.status, text }
            } catch (error) {
              return {
                ok: false,
                status: 0,
                text: '',
                error: (error as Error)?.message || String(error),
              }
            }
          },
          [
            {
              mode: payload.mode,
              imageUrl: payload.mode === 'url' ? payload.imageUrl : undefined,
              base64: payload.mode === 'inline' ? payload.base64 : undefined,
              mime: payload.mode === 'inline' ? payload.mime : undefined,
              filename:
                payload.mode === 'url' || payload.mode === 'inline'
                  ? payload.filename
                  : undefined,
              storageKey: payload.mode === 'storage' ? payload.storageKey : undefined,
              csrf: payload.csrf,
              uploadUrl: payload.uploadUrl,
            },
          ],
          { world }
        )
      )

      const result = pageResult as {
        ok?: boolean
        status?: number
        text?: string
        error?: string
      } | null

      if (result?.error) throw new Error(result.error)
      if (!result?.text) throw new Error('页面上传无响应')
      let data: BaiduDevApiResponse<BaiduDevUploadResult>
      try {
        data = JSON.parse(result.text) as BaiduDevApiResponse<BaiduDevUploadResult>
      } catch {
        throw new Error(`页面上传响应非 JSON: ${result.text.slice(0, 120)}`)
      }
      if (!data.success || !data.result?.fileUrl) {
        throw new Error(this.extractError(data) || `上传被拒绝 HTTP ${result.status ?? ''}`)
      }
      return { url: data.result.fileUrl }
    } finally {
      if (storageKey) {
        await this.runtime.storage.remove(storageKey).catch(() => undefined)
      }
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (SKIP_IMAGE_HOSTS.some((h) => src.includes(h))) {
      return { url: src }
    }

    try {
      const imgRes = await this.runtime.fetch(src, { credentials: 'omit' })
      if (!imgRes.ok) {
        throw new Error(`下载图片失败: ${imgRes.status}`)
      }
      const blob = await imgRes.blob()
      const filename = this.imageFilenameFromMime(blob.type || 'image/png')
      const url = await this.uploadBlob(blob, filename)
      return { url }
    } catch (swError) {
      logger.debug('SW image upload failed:', swError)
    }

    try {
      return await this.uploadImageViaPageTab(src)
    } catch (pageError) {
      const msg = (pageError as Error)?.message || String(pageError)
      throw new Error(`百度开发者中心图片上传失败：${msg}`)
    }
  }

  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withDeveloperSession(async () => {
      const filename = this.imageFilenameFromMime(file.type || 'image/png')
      try {
        return await this.uploadBlob(file, filename)
      } catch (swError) {
        logger.debug('SW binary upload failed, fallback page:', swError)
        const base64 = await this.blobToBase64(file)
        const dataUri = `data:${file.type || 'image/png'};base64,${base64}`
        const result = await this.uploadImageViaPageTab(dataUri)
        return result.url
      }
    })
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：withDeveloperSession 保护下调 fetchUser 确认登录 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    await this.withDeveloperSession(async () => {
      const user = await this.fetchUser().catch(() => null)
      if (!user?.id) {
        throw new Error('请先登录百度开发者中心')
      }
    })
  }

  /** 2. 内容规整：确保 markdown 非空 */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    if (!(ctx.content.markdown || '').trim()) {
      throw new Error('文章内容为空（未得到 Markdown），请重试同步')
    }
  }

  /** 3. 上传图片：withDeveloperSession 保护下走 SharedImageCache 去重；软失败保留原 URL */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withDeveloperSession(async () => {
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        try {
          const result = await this.uploadImageByUrl(src)
          ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
          return result
        } catch (error) {
          logger.warn('图片转存失败，保留原 URL:', src.slice(0, 80), error)
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

  /** 5. 构建草稿请求体（mdContent + htmlContent） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const htmlContent = markdownToBaiduDeveloperHtml(ctx.content.markdown)
    const title = (ctx.article.title || '').trim() || '未命名文章'
    ctx.payload = { title, id: '', mdContent: ctx.content.markdown, htmlContent }
  }

  /** 6. 提交：withDeveloperSession 保护下 POST ARTICLE_URL */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const data = await this.withDeveloperSession(async () => {
      const csrf = await this.getCsrfToken()
      const response = await this.runtime.fetch(ARTICLE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
          csrftoken: csrf,
        },
        body: JSON.stringify(ctx.payload),
      })
      const text = await response.text()
      let res: BaiduDevApiResponse<BaiduDevArticleResult>
      try {
        res = JSON.parse(text) as BaiduDevApiResponse<BaiduDevArticleResult>
      } catch {
        throw new Error(`保存草稿响应非 JSON: ${text.slice(0, 160)}`)
      }
      if (!res.success || !res.result?.id) {
        throw new Error(this.extractError(res) || '保存草稿失败：未返回 ID')
      }
      return res
    })
    const id = String(data.result!.id)
    logger.debug('Draft created:', id)
    return this.createResult(true, {
      postId: id,
      postUrl: `${CREATE_URL}?id=${id}`,
      draftOnly: true,
    })
  }

  /** Header 规则：百度开发者用 withDeveloperSession 动态构建（含 Cookie 注入），此处返回空 */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return []
  }

  private extractError(data: BaiduDevApiResponse): string {
    if (typeof data.message === 'string') return data.message
    if (data.message && typeof data.message === 'object' && data.message.global) {
      return data.message.global
    }
    if (data.error?.detail?.global) return data.error.detail.global
    if (data.error?.message) return data.error.message
    if (data.code) return String(data.code)
    return ''
  }
}
