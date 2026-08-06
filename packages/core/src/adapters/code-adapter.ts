/**
 * 代码适配器基类
 *
 * 架构说明:
 * - Content Script (有 DOM): 负责所有 HTML/DOM 处理
 *   - 代码块处理 (使用 innerText)
 *   - 懒加载图片处理
 *   - HTML 转 Markdown
 * - Service Worker (无 DOM): 只负责 API 调用
 *   - 接收已处理好的 html 和 markdown
 *   - 图片上传 (URL 替换，不需要 DOM)
 *   - 调用平台 API
 *
 * 适配器接收的 Article 对象:
 * - article.html: 已预处理的 HTML (代码块已简化，图片已处理)
 * - article.markdown: 已转换的 Markdown
 *
 * 适配器只需:
 * 1. 选择使用 html 还是 markdown
 * 2. 处理图片上传 (如果平台需要)
 * 3. 调用平台 API
 */
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../types'
import type { RuntimeInterface } from '../runtime/interface'
import type { PlatformAdapter, PublishOptions } from './types'
import { createLogger } from '../lib/logger'
import { parseMarkdownImages } from '../lib/markdown-images'

const logger = createLogger('CodeAdapter')

/**
 * 图片上传结果
 */
export interface ImageUploadResult {
  /** 新的图片 URL */
  url: string
  /** 额外的 img 属性 */
  attrs?: Record<string, string | number>
}

/**
 * 图片处理选项
 */
export interface ImageProcessOptions {
  /** 跳过匹配这些模式的图片 */
  skipPatterns?: string[]
  /** 进度回调 */
  onProgress?: (current: number, total: number) => void
  /** 并发上传数（默认 1，串行）。外链图多、单图偏慢时可设 3~5 */
  concurrency?: number
}

/**
 * 代码适配器基类
 */
export abstract class CodeAdapter implements PlatformAdapter {
  abstract readonly meta: PlatformMeta
  protected runtime!: RuntimeInterface

  /** Header 规则 ID 列表（用于请求拦截） */
  protected headerRuleIds: string[] = []

  /** 本次操作为页面请求临时创建的 tab（不含用户原有标签） */
  protected ephemeralTabIds = new Set<number>()

  /**
   * ensurePageTab 单飞：同一 host 并发共用一次 query/create，避免激活时狂开标签
   * key = hostname（或 pageUrl 回退）
   */
  private pageTabInflight = new Map<string, Promise<number>>()

  async init(runtime: RuntimeInterface): Promise<void> {
    this.runtime = runtime
  }

  // ============ 抽象方法，子类必须实现 ============

  abstract checkAuth(): Promise<AuthResult>
  abstract publish(article: Article, options?: PublishOptions): Promise<SyncResult>

  // ============ Header 规则管理 ============

  /**
   * 添加 Header 规则
   * @param rule 规则配置
   * @returns 规则 ID
   */
  protected async addHeaderRule(rule: Omit<HeaderRule, 'id'>): Promise<string | null> {
    if (!this.runtime.headerRules) return null

    const ruleId = await this.runtime.headerRules.add(rule)
    this.headerRuleIds.push(ruleId)
    return ruleId
  }

  /**
   * 批量添加 Header 规则
   * @param rules 规则配置列表
   */
  protected async addHeaderRules(rules: Array<Omit<HeaderRule, 'id'>>): Promise<void> {
    for (const rule of rules) {
      await this.addHeaderRule(rule)
    }
    if (this.headerRuleIds.length > 0) {
      logger.debug(`[${this.meta.id}] Header rules added:`, this.headerRuleIds)
    }
  }

  /**
   * 清除所有已添加的 Header 规则
   */
  protected async clearHeaderRules(): Promise<void> {
    if (!this.runtime.headerRules || this.headerRuleIds.length === 0) return

    for (const ruleId of this.headerRuleIds) {
      await this.runtime.headerRules.remove(ruleId)
    }
    logger.debug(`[${this.meta.id}] Header rules cleared:`, this.headerRuleIds)
    this.headerRuleIds = []
  }

  /**
   * 在 Header 规则保护下执行操作
   * 自动设置规则，执行完成后自动清除
   * @param rules 规则配置列表
   * @param fn 要执行的操作
   */
  protected async withHeaderRules<T>(
    rules: Array<Omit<HeaderRule, 'id'>>,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.addHeaderRules(rules)
    try {
      return await fn()
    } finally {
      await this.clearHeaderRules()
    }
  }

  // ============ HTTP 请求能力 ============

  /**
   * GET 请求
   */
  protected async get<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers,
    })
    return this.parseResponse<T>(response)
  }

  /**
   * POST 请求 (JSON)
   */
  protected async postJson<T = unknown>(
    url: string,
    data: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(data),
    })
    return this.parseResponse<T>(response)
  }

  /**
   * POST 请求 (Form)
   */
  protected async postForm<T = unknown>(
    url: string,
    data: Record<string, string>,
    headers?: Record<string, string>
  ): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(data),
    })
    return this.parseResponse<T>(response)
  }

  /**
   * POST 请求 (Multipart)
   */
  protected async postMultipart<T = unknown>(
    url: string,
    formData: FormData,
    headers?: Record<string, string>
  ): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: formData,
    })
    return this.parseResponse<T>(response)
  }

  /**
   * 解析响应
   */
  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const text = await response.text()

    // 尝试解析 JSON
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  // ============ 图片处理能力 ============

  /**
   * 处理文章图片 (使用正则提取 URL，兼容 Service Worker)
   * 同时支持 HTML 和 Markdown 格式
   * - HTML: <img src="url" alt="text">
   * - Markdown: ![text](url)
   *
   * 注意: 这个方法只做 URL 提取和替换，不涉及 DOM 解析
   */
  protected async processImages(
    content: string,
    uploadFn: (src: string) => Promise<ImageUploadResult>,
    options?: ImageProcessOptions
  ): Promise<string> {
    const { skipPatterns = [], onProgress, concurrency = 1 } = options || {}

    // 提取所有图片（HTML + Markdown）
    const matches: { full: string; src: string; alt?: string; type: 'html' | 'markdown' }[] = []

    // 1. HTML 格式: <img ... src="url" ...>
    const htmlImgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi
    let match
    while ((match = htmlImgRegex.exec(content)) !== null) {
      matches.push({ full: match[0], src: match[1], type: 'html' })
    }

    // 2. Markdown 格式: ![alt](url)
    for (const mdMatch of parseMarkdownImages(content)) {
      matches.push({ full: mdMatch.full, src: mdMatch.src, alt: mdMatch.alt, type: 'markdown' })
    }

    if (matches.length === 0) {
      return content
    }

    logger.debug(`Found ${matches.length} images to process (HTML + Markdown)`)

    const total = matches.length
    const uploadedMap = new Map<string, ImageUploadResult>()
    const replaced: Array<{ full: string; replacement: string }> = []
    let processed = 0

    const processOne = async (task: {
      full: string
      src: string
      alt?: string
      type: 'html' | 'markdown'
    }) => {
      const { full, src, alt, type } = task
      // 跳过空 src
      if (!src) return

      // 跳过匹配的模式（但不跳过 data URI）
      if (!src.startsWith('data:')) {
        const shouldSkip = skipPatterns.some(pattern => src.includes(pattern))
        if (shouldSkip) {
          logger.debug(`Skipping matched pattern: ${src}`)
          return
        }
      }

      processed++
      onProgress?.(processed, total)

      try {
        // 检查是否已上传过
        let uploadResult = uploadedMap.get(src)

        if (!uploadResult) {
          logger.debug(`Uploading image ${processed}/${total}: ${src.startsWith('data:') ? 'data URI' : src}`)
          // uploadFn 应该能处理 URL 和 data URI（通过 fetch）
          uploadResult = await uploadFn(src)
          uploadedMap.set(src, uploadResult)
        }

        // 根据格式构建替换内容
        let replacement: string
        if (type === 'html') {
          // HTML 格式
          replacement = `<img src="${uploadResult.url}"`
          if (uploadResult.attrs) {
            for (const [key, value] of Object.entries(uploadResult.attrs)) {
              replacement += ` ${key}="${value}"`
            }
          }
          replacement += ' />'
        } else {
          // Markdown 格式
          replacement = `![${alt || ''}](${uploadResult.url})`
        }

        replaced.push({ full, replacement })
        logger.debug(`Image uploaded: ${uploadResult.url}`)
      } catch (error) {
        logger.error(`Failed to upload image: ${src}`, error)
        // 继续处理其他图片
      }

      // 避免请求过快
      await this.delay(300)
    }

    // 并发池：concurrency=1 时退化为串行（其他适配器行为不变）
    const queue = [...matches]
    const size = Math.max(1, Math.min(concurrency, queue.length))
    const runWorker = async () => {
      while (queue.length > 0) {
        const task = queue.shift()
        if (!task) break
        await processOne(task)
      }
    }
    await Promise.all(Array.from({ length: size }, () => runWorker()))

    // 串行替换，避免并发改写同一字符串
    let result = content
    for (const { full, replacement } of replaced) {
      result = result.replace(full, replacement)
    }
    return result
  }

  /**
   * 上传图片（子类实现）
   * 默认实现抛出错误
   */
  protected async uploadImageByUrl(_src: string): Promise<ImageUploadResult> {
    throw new Error('uploadImageByUrl not implemented')
  }

  /**
   * 通过 Blob 上传图片（公开方法，实现 PlatformAdapter 接口）
   * 默认实现：转为 data URI，调用 uploadImageByUrl
   * 子类可以覆盖以提供更优的实现
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    const dataUri = await this.blobToDataUri(file)
    const result = await this.uploadImageByUrl(dataUri)
    return result.url
  }

  /**
   * Blob 转 data URI
   */
  protected async blobToDataUri(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result === 'string') {
          resolve(result)
        } else {
          reject(new Error('Failed to read blob as data URI'))
        }
      }
      reader.onerror = () => reject(new Error('FileReader error'))
      reader.readAsDataURL(blob)
    })
  }

  /**
   * data URI 转 Blob
   */
  protected async dataUriToBlob(dataUri: string): Promise<Blob> {
    const response = await fetch(dataUri)
    return response.blob()
  }

  // ============ 工具方法 ============

  /**
   * 延迟
   */
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 关闭本次操作为页面请求临时创建的标签（不影响用户原有标签）
   */
  protected async releaseEphemeralTabs(): Promise<void> {
    // 等 ensurePageTab 单飞结束，避免并发调用仍在用时被关掉
    if (this.pageTabInflight.size > 0) {
      await Promise.allSettled([...this.pageTabInflight.values()])
    }

    const remove = this.runtime.tabs?.remove
    if (!remove || this.ephemeralTabIds.size === 0) {
      this.ephemeralTabIds.clear()
      return
    }

    for (const id of this.ephemeralTabIds) {
      try {
        await remove(id)
      } catch {
        // 标签可能已被用户关闭
      }
    }
    this.ephemeralTabIds.clear()
  }

  /**
   * 选取可用站点标签：优先 pageUrl 路径，否则任意同站可用标签；都没有则后台新建并登记为临时标签。
   * 同一 host 并发调用单飞，只 create 一次。
   */
  protected async ensurePageTab(urlPattern: string, pageUrl: string): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('当前运行时不支持 Tab 操作')
    }

    let host = ''
    try {
      host = new URL(pageUrl).hostname
    } catch {
      host = ''
    }
    const inflightKey = host || pageUrl

    const existing = this.pageTabInflight.get(inflightKey)
    if (existing) {
      return existing
    }

    const task = this.ensurePageTabOnce(urlPattern, pageUrl).finally(() => {
      if (this.pageTabInflight.get(inflightKey) === task) {
        this.pageTabInflight.delete(inflightKey)
      }
    })
    this.pageTabInflight.set(inflightKey, task)
    return task
  }

  /** ensurePageTab 实际查询/创建（由单飞包装） */
  private async ensurePageTabOnce(urlPattern: string, pageUrl: string): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('当前运行时不支持 Tab 操作')
    }

    // 仅过滤明确登录页路径；勿把 SPA hash（如 #/Login）以外的正常页误杀
    const loginRe = /sign[_-]?in|sign[_-]?up|\/login(?:\/|$|\?)|passport|\/sso\b|\/auth\b/i
    let preferredPath = ''
    let host = ''
    try {
      const u = new URL(pageUrl)
      preferredPath = u.pathname.replace(/\/$/, '') || ''
      host = u.hostname
    } catch {
      preferredPath = ''
    }

    // 已有 URL：排除登录页 / chrome-error；加载中尚无 url 的同站 tab 也可复用
    const isReusable = (t: { id?: number; url?: string }) => {
      if (!t.id) return false
      if (!t.url) return true
      if (t.url.includes('chrome-error')) return false
      if (loginRe.test(t.url)) return false
      return true
    }

    // 1) 按传入 pattern 查
    let tabs = await this.runtime.tabs.query(urlPattern)

    // 2) SPA / 无尾斜杠时 match pattern 常漏匹配，按 hostname 再查一次
    if (!tabs.some(isReusable) && host) {
      const byHost = await this.runtime.tabs.query([`*://${host}/*`, `*://${host}/`])
      if (byHost.length > 0) {
        tabs = byHost
      } else {
        // 3) 最终兜底：扫全部标签按 hostname 过滤
        const all = await this.runtime.tabs.query()
        tabs = all.filter((t) => {
          if (!t.url) return false
          try {
            return new URL(t.url).hostname === host
          } catch {
            return false
          }
        })
      }
    }

    const usable = tabs.filter(isReusable)

    const preferred = preferredPath
      ? usable.find((t) => t.url?.includes(preferredPath))
      : undefined

    // 优先匹配路径；否则复用任意同站可用标签（页面内仅做 fetch，不依赖特定 DOM）
    const pick = preferred || usable[0]

    if (pick?.id) {
      // 再确认一次仍存在（并发关闭 / 刚被其它适配器当 ephemeral 关掉）
      const still = await this.runtime.tabs.query()
      if (still.some((t) => t.id === pick.id)) {
        // 加载中的标签等到 complete，避免 executeScript 过早失败再误开新页
        try {
          await this.runtime.tabs.waitForLoad(pick.id)
        } catch {
          // 已有标签加载失败则继续尝试新建
          logger.warn('reuse tab waitForLoad failed, will create:', pick.id)
        }
        const stillAfter = await this.runtime.tabs.query()
        if (stillAfter.some((t) => t.id === pick.id)) {
          const url = stillAfter.find((t) => t.id === pick.id)?.url
          if (!url || isReusable({ id: pick.id, url })) {
            return pick.id
          }
        }
      }
    }

    const tab = await this.runtime.tabs.create(pageUrl, false)
    this.ephemeralTabIds.add(tab.id)
    // 创建后立刻入组，避免 waitForLoad 期间标签游离在组外
    try {
      await this.runtime.tabs.addToAuthGroup?.(tab.id)
    } catch {
      // 标签组可选，失败不影响鉴权
    }
    try {
      await this.runtime.tabs.waitForLoad(tab.id)
      await this.delay(800)
    } catch (error) {
      // 加载失败或中途被关：清掉坏 id，抛出让上层重试
      this.ephemeralTabIds.delete(tab.id)
      try {
        await this.runtime.tabs.remove(tab.id)
      } catch {
        // ignore
      }
      throw error
    }
    return tab.id
  }

  /**
   * 在站点页面执行操作；遇「no tab with id」自动重建标签重试一次。
   */
  protected async runOnPageTab<T>(
    urlPattern: string,
    pageUrl: string,
    runner: (tabId: number) => Promise<T>
  ): Promise<T> {
    const attempt = async (): Promise<T> => {
      const tabId = await this.ensurePageTab(urlPattern, pageUrl)
      return runner(tabId)
    }
    try {
      return await attempt()
    } catch (error) {
      const msg = String((error as Error)?.message || error)
      if (!/no tab with id/i.test(msg)) {
        throw error
      }
      // 丢掉已失效的 ephemeral id，避免 release 时无意义报错；再开新 tab
      this.ephemeralTabIds.clear()
      return attempt()
    }
  }

  /**
   * 在目标站点页面上下文执行 fetch；失败时导航已有标签到 pageUrl 后重试一次（不新建第二个标签）
   */
  protected async pageFetchJson<T = unknown>(
    urlPattern: string,
    pageUrl: string,
    fetchUrl: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: string
    } = {}
  ): Promise<T> {
    if (!this.runtime.tabs) {
      throw new Error('当前运行时不支持 Tab 操作')
    }

    const executeFetch = async (tabId: number): Promise<{
      ok: boolean
      status: number
      text: string
      error?: string
    }> => {
      try {
        const result = await this.runtime.tabs!.executeScript(
          tabId,
          async (
            url: string,
            method: string,
            headers: Record<string, string>,
            body: string,
            timeoutMs: number
          ) => {
            try {
              const controller = new AbortController()
              const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
              const reqInit: RequestInit = {
                method,
                headers,
                credentials: 'include',
                signal: controller.signal,
              }
              if (body && method !== 'GET' && method !== 'HEAD') {
                reqInit.body = body
              }
              let response: Response
              try {
                response = await fetch(url, reqInit)
              } finally {
                clearTimeout(timeoutId)
              }
              const text = await response.text()
              return {
                ok: response.ok,
                status: response.status,
                text,
              }
            } catch (error) {
              const err = error as Error
              const msg =
                err?.name === 'AbortError'
                  ? `页面请求超时（${Math.round(timeoutMs / 1000)}秒）`
                  : err.message
              return {
                ok: false,
                status: 0,
                text: '',
                error: msg,
              }
            }
          },
          [
            fetchUrl,
            init.method || 'GET',
            init.headers || {},
            init.body ?? '',
            30000,
          ] as [string, string, Record<string, string>, string, number]
        )
        return result || { ok: false, status: 0, text: '', error: '页面请求失败' }
      } catch (error) {
        return {
          ok: false,
          status: 0,
          text: '',
          error: (error as Error).message || 'executeScript 失败',
        }
      }
    }

    const tabId = await this.ensurePageTab(urlPattern, pageUrl)
    let result = await executeFetch(tabId)
    const shouldRetry =
      !!result.error ||
      !result.text.trim() ||
      result.status === 0
    if (shouldRetry) {
      logger.warn(
        'pageFetchJson first attempt failed, retry after navigating tab:',
        result.error || `HTTP ${result.status}`
      )
      if (!this.runtime.tabs.update) {
        throw new Error(result.error || '页面请求失败')
      }
      await this.runtime.tabs.update(tabId, pageUrl)
      await this.runtime.tabs.waitForLoad(tabId)
      await this.delay(800)
      result = await executeFetch(tabId)
    }

    if (!result || result.error) {
      throw new Error(result?.error || '页面请求失败')
    }
    if (!result.text.trim()) {
      throw new Error(`页面请求空响应 HTTP ${result.status}`)
    }

    const trimmed = result.text.trim()
    // 未登录常被重定向到 HTML 登录页
    if (trimmed.startsWith('<') || /<!DOCTYPE|<html/i.test(trimmed.slice(0, 80))) {
      throw new Error('未登录或会话已失效（页面返回了登录页 HTML）')
    }

    let data: T
    try {
      data = JSON.parse(result.text) as T
    } catch {
      throw new Error(`页面响应非 JSON HTTP ${result.status}: ${result.text.slice(0, 120)}`)
    }

    if (!result.ok) {
      throw new Error(`页面请求失败 HTTP ${result.status}: ${result.text.slice(0, 160)}`)
    }

    return data
  }

  /**
   * 创建同步结果
   */
  protected createResult(success: boolean, data?: Partial<SyncResult>): SyncResult {
    return {
      platform: this.meta.id,
      success,
      timestamp: Date.now(),
      ...data,
    }
  }
}
