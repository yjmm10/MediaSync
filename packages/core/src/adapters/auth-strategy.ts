/**
 * 鉴权策略
 *
 * 把 checkAuth 拆成可组合的积木，对齐 CLAUDE.md 的三档优先级：
 *   1（首选）SW 直调 API
 *   2        SW 拉 HTML / Cookie 探测
 *   3（最后）页面上下文 / 临时标签
 *
 * 适配器通过 CompositeAuthStrategy 按声明顺序级联：
 *   - 第一个返回明确判定（isAuthenticated: true | false）的策略即停
 *   - 策略抛错或返回 null（不适用）才继续下一个
 */
import type { AuthResult, HeaderRule } from '../types'
import type { RuntimeInterface } from '../runtime/interface'
import { createLogger } from '../lib/logger'

const logger = createLogger('AuthStrategy')

/** 鉴权上下文（策略执行所需的环境） */
export interface AuthContext {
  runtime: RuntimeInterface
  /** 临时标签 id 集合；PageContextAuthStrategy 创建的 tab 登记于此，
   *  调用方（PipelineAdapter）在 finally 中 release */
  ephemeralTabIds: Set<number>
}

/**
 * 单一鉴权策略
 * 返回 null 表示此策略不适用/未决，由上层尝试下一个
 */
export interface AuthStrategy {
  /** 策略名（用于日志） */
  readonly name: string
  /** 执行鉴权检测 */
  check(ctx: AuthContext): Promise<AuthResult | null>
}

/** 未登录的便捷返回 */
const notAuthenticated = (error?: string): AuthResult => ({
  isAuthenticated: false,
  error,
})

/** 在 Header 规则保护下执行（add → fn → finally remove） */
async function withHeaderRules<T>(
  ctx: AuthContext,
  rules: HeaderRule[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const hr = ctx.runtime.headerRules
  if (!hr || !rules || rules.length === 0) return fn()
  const ids: string[] = []
  for (const rule of rules) {
    ids.push(await hr.add(rule))
  }
  try {
    return await fn()
  } finally {
    for (const id of ids) {
      await hr.remove(id).catch(() => {})
    }
  }
}

/**
 * SW 直调用户/会话 API（优先级 1，首选）
 *
 * 适用：CSDN、掘金、知乎 等有公开用户接口的平台
 */
export class SwApiAuthStrategy implements AuthStrategy {
  readonly name = 'sw-api'
  constructor(private readonly config: {
    url: string
    /** 解析响应为 AuthResult；返回 null 表示本次未决 */
    parse: (json: unknown) => AuthResult | null
    headers?: Record<string, string>
    /** 绕过 CORS 的 Header 规则（如 x-requested-with） */
    headerRules?: HeaderRule[]
  }) {}

  async check(ctx: AuthContext): Promise<AuthResult | null> {
    try {
      return await withHeaderRules(ctx, this.config.headerRules, async () => {
        const resp = await ctx.runtime.fetch(this.config.url, {
          method: 'GET',
          credentials: 'include',
          headers: this.config.headers,
        })
        if (!resp.ok) {
          logger.debug(`${this.name}: HTTP ${resp.status}`)
          return notAuthenticated(`HTTP ${resp.status}`)
        }
        const json = await resp.json().catch(() => null)
        return this.config.parse(json)
      })
    } catch (error) {
      logger.debug(`${this.name} failed:`, (error as Error).message)
      return null
    }
  }
}

/**
 * SW 拉页面 HTML 提取登录态（优先级 2）
 *
 * 适用：阿里云、百度、腾讯云 等 SW 能带 Cookie 拉页面的平台
 */
export class SwHtmlAuthStrategy implements AuthStrategy {
  readonly name = 'sw-html'
  constructor(private readonly config: {
    url: string
    /** 从 HTML 提取登录态；返回 null 表示未决 */
    extract: (html: string) => AuthResult | null
    headers?: Record<string, string>
  }) {}

  async check(ctx: AuthContext): Promise<AuthResult | null> {
    try {
      const resp = await ctx.runtime.fetch(this.config.url, {
        method: 'GET',
        credentials: 'include',
        headers: this.config.headers,
      })
      if (!resp.ok) return notAuthenticated(`HTTP ${resp.status}`)
      const html = await resp.text()
      return this.config.extract(html)
    } catch (error) {
      logger.debug(`${this.name} failed:`, (error as Error).message)
      return null
    }
  }
}

/**
 * Cookie 探测（优先级 2，弱判定）
 *
 * 仅判断关键 Cookie 是否存在，不保证会话有效
 */
export class CookieAuthStrategy implements AuthStrategy {
  readonly name = 'cookie'
  constructor(private readonly config: {
    domain: string
    /** 任一 name 存在即认为已登录 */
    names: string[]
    /** 可选：从 cookie 值解析用户名 */
    parseUsername?: (value: string) => string | undefined
  }) {}

  async check(ctx: AuthContext): Promise<AuthResult | null> {
    try {
      const cookies = await ctx.runtime.cookies.get(this.config.domain)
      for (const name of this.config.names) {
        const found = cookies.find(c => c.name === name)
        if (found?.value) {
          return {
            isAuthenticated: true,
            username: this.config.parseUsername?.(found.value),
          }
        }
      }
      return notAuthenticated('关键 Cookie 不存在')
    } catch (error) {
      logger.debug(`${this.name} failed:`, (error as Error).message)
      return null
    }
  }
}

/**
 * 页面上下文 / 临时标签（优先级 3，最后手段）
 *
 * 通过 executeScript 在页面上下文中读取登录态（如 localStorage）。
 * 内部自动查找/创建 tab 并登记到 ephemeralTabIds，由调用方 release。
 *
 * 适用：美篇、小红书、企鹅号 等登录态保存在页面 localStorage 的平台
 */
export class PageContextAuthStrategy implements AuthStrategy {
  readonly name = 'page-context'
  constructor(private readonly config: {
    pageUrl: string
    /** tab URL match pattern（用于查找已有同站 tab） */
    pattern: string
    /** 在页面上下文中执行；返回 AuthResult 或 null */
    detect: (tabId: number, runtime: RuntimeInterface) => Promise<AuthResult | null>
  }) {}

  async check(ctx: AuthContext): Promise<AuthResult | null> {
    if (!ctx.runtime.tabs) return null
    try {
      const tabId = await ensurePageTab(
        ctx.runtime,
        ctx.ephemeralTabIds,
        this.config.pageUrl,
        this.config.pattern,
      )
      return await this.config.detect(tabId, ctx.runtime)
    } catch (error) {
      logger.debug(`${this.name} failed:`, (error as Error).message)
      return null
    }
  }
}

/**
 * 组合策略：按声明顺序级联
 *
 * 第一个返回明确判定（isAuthenticated: true | false）即停；
 * 抛错或 null 才继续下一个；全部未决则返回 null（由上层兜底为未登录）。
 */
export class CompositeAuthStrategy implements AuthStrategy {
  readonly name = 'composite'
  constructor(private readonly strategies: AuthStrategy[]) {}

  async check(ctx: AuthContext): Promise<AuthResult | null> {
    for (const strategy of this.strategies) {
      try {
        const result = await strategy.check(ctx)
        if (result) {
          logger.debug(
            `composite: ${strategy.name} decided → authenticated=${result.isAuthenticated}`,
          )
          return result
        }
        logger.debug(`composite: ${strategy.name} returned null, trying next`)
      } catch (error) {
        logger.debug(
          `composite: ${strategy.name} threw, trying next:`,
          (error as Error).message,
        )
      }
    }
    return null
  }
}

/**
 * 查找/创建站点 tab（PageContextAuthStrategy 内部使用）
 *
 * 优先复用同站可用 tab（不关用户原有标签）；无则后台新建并登记到 ephemeralTabIds。
 * 注意：与 CodeAdapter.ensurePageTab 的差异 — 这里是策略内部的最小实现，
 * 复用 / 单飞等增强留待后续统一。
 */
async function ensurePageTab(
  runtime: RuntimeInterface,
  ephemeralTabIds: Set<number>,
  pageUrl: string,
  pattern: string,
): Promise<number> {
  if (!runtime.tabs) throw new Error('当前运行时不支持 Tab 操作')

  const loginRe = /sign[_-]?in|sign[_-]?up|\/login(?:\/|$|\?)|passport|\/sso\b|\/auth\b/i

  // 1. 按 pattern 查
  let tabs = await runtime.tabs.query(pattern)

  // 2. 按 hostname 兜底
  let host = ''
  try {
    host = new URL(pageUrl).hostname
  } catch {
    host = ''
  }
  if (host && !tabs.some(t => t.id && t.url && !loginRe.test(t.url))) {
    tabs = await runtime.tabs.query([`*://${host}/*`])
  }

  const reusable = tabs.find(
    t => t.id && t.url && t.url !== 'chrome-error' && !loginRe.test(t.url),
  )
  if (reusable?.id) {
    await runtime.tabs.waitForLoad(reusable.id).catch(() => {})
    return reusable.id
  }

  // 3. 后台新建
  const tab = await runtime.tabs.create(pageUrl, false)
  ephemeralTabIds.add(tab.id)
  // 创建后立刻入组，避免 waitForLoad 期间标签游离在组外
  try {
    await runtime.tabs.addToAuthGroup?.(tab.id)
  } catch {
    // 标签组可选，失败不影响鉴权
  }
  try {
    await runtime.tabs.waitForLoad(tab.id)
    // 给 SPA 一点时间初始化
    await new Promise(resolve => setTimeout(resolve, 800))
  } catch (error) {
    ephemeralTabIds.delete(tab.id)
    try {
      await runtime.tabs.remove(tab.id)
    } catch {
      // ignore
    }
    throw error
  }
  return tab.id
}
