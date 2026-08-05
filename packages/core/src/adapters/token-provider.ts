/**
 * Token Provider
 *
 * CSRF / Session Token 在 7+ 平台重复（博客园、B 站、百家号、语雀、思否、51CTO…）。
 * 抽成「发布前置准备」，管道在 submit 前 get() 一次，submit 直接用 ctx.token。
 *
 * 三种来源（按平台实际挑选）：
 *   - CookieTokenProvider：从 cookie 读（如 XSRF-TOKEN、csrftoken）
 *   - HtmlTokenProvider：从页面 HTML 提取（meta 标签 / 隐藏字段）
 *   - ApiTokenProvider：从接口响应提取
 */
import type { HeaderRule } from '../types'
import type { RuntimeInterface } from '../runtime/interface'

/** Token 提供者 */
export interface TokenProvider {
  /** 获取 token（内部可缓存，默认缓存） */
  get(): Promise<string>
}

/** 从 Cookie 读 token */
export class CookieTokenProvider implements TokenProvider {
  private cached?: string
  constructor(private readonly config: {
    runtime: RuntimeInterface
    domain: string
    name: string
    /** 是否缓存（同一适配器实例生命周期内），默认 true */
    cache?: boolean
  }) {}

  async get(): Promise<string> {
    if (this.config.cache !== false && this.cached) return this.cached
    const value = await this.getCookieValue()
    if (!value) throw new Error(`Cookie ${this.config.name} 未找到`)
    if (this.config.cache !== false) this.cached = value
    return value
  }

  private async getCookieValue(): Promise<string | null> {
    const rt = this.config.runtime
    if (rt.getCookie) {
      return rt.getCookie(this.config.domain, this.config.name)
    }
    const cookies = await rt.cookies.get(this.config.domain)
    return cookies.find(c => c.name === this.config.name)?.value ?? null
  }
}

/** 从页面 HTML 提取 token（meta 标签 / 隐藏字段） */
export class HtmlTokenProvider implements TokenProvider {
  private cached?: string
  constructor(private readonly config: {
    runtime: RuntimeInterface
    url: string
    /** 从 HTML 提取 token；返回 null 表示未找到 */
    extract: (html: string) => string | null
    cache?: boolean
    headers?: Record<string, string>
    /** 绕过 CORS 的 Header 规则 */
    headerRules?: HeaderRule[]
  }) {}

  async get(): Promise<string> {
    if (this.config.cache !== false && this.cached) return this.cached
    const token = await this.fetchToken()
    if (!token) throw new Error('未从页面提取到 token')
    if (this.config.cache !== false) this.cached = token
    return token
  }

  private async fetchToken(): Promise<string | null> {
    const rt = this.config.runtime
    const ids: string[] = []
    if (rt.headerRules && this.config.headerRules) {
      for (const rule of this.config.headerRules) {
        ids.push(await rt.headerRules.add(rule))
      }
    }
    try {
      const resp = await rt.fetch(this.config.url, {
        method: 'GET',
        credentials: 'include',
        headers: this.config.headers,
      })
      if (!resp.ok) throw new Error(`获取 token 失败: HTTP ${resp.status}`)
      const html = await resp.text()
      return this.config.extract(html)
    } finally {
      if (rt.headerRules) {
        for (const id of ids) {
          await rt.headerRules.remove(id).catch(() => {})
        }
      }
    }
  }
}

/** 从 API 响应提取 token */
export class ApiTokenProvider implements TokenProvider {
  private cached?: string
  constructor(private readonly config: {
    runtime: RuntimeInterface
    url: string
    /** 从 JSON 响应提取 token */
    extract: (json: unknown) => string | null
    method?: string
    body?: string
    headers?: Record<string, string>
    cache?: boolean
  }) {}

  async get(): Promise<string> {
    if (this.config.cache !== false && this.cached) return this.cached
    const resp = await this.config.runtime.fetch(this.config.url, {
      method: this.config.method ?? 'GET',
      credentials: 'include',
      headers: this.config.headers,
      body: this.config.body,
    })
    if (!resp.ok) throw new Error(`获取 token 失败: HTTP ${resp.status}`)
    const json = await resp.json().catch(() => null)
    const token = this.config.extract(json)
    if (!token) throw new Error('未从 API 响应提取到 token')
    if (this.config.cache !== false) this.cached = token
    return token
  }
}
