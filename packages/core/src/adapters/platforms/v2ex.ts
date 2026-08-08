/**
 * V2EX 适配器
 * https://www.v2ex.com/write
 *
 * 直接发布主题到节点 algorithm；Markdown 正文。
 * 鉴权：GET /write（SW 优先，失败再页面上下文）。
 * 图片：暂不支持中转图片链接；本地 data URI / blob 直接剥离；http(s) 图链原样保留。
 * 暂不支持公式、Mermaid 代码块（Markdown 原样发出，平台侧不渲染）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('V2EX')

const BASE = 'https://www.v2ex.com'
const WRITE_URL = `${BASE}/write`
const PAGE_URL_PATTERN = '*://www.v2ex.com/*'
const CONTENT_MAX = 20000
/** 主题节点：算法 / algorithm */
export const DEFAULT_NODE = 'algorithm'

export interface V2exPublishForm {
  title: string
  content: string
  syntax: 'markdown'
  node_name: string
  once: string
}

/** 从 /write HTML 解析登录态（可单测） */
export function parseAuthFromWriteHtml(
  html: string,
  finalUrl: string
): AuthResult | null {
  if (/signin/i.test(finalUrl) || /You need to sign in/i.test(html)) {
    return null
  }

  const memberIdMatch = html.match(/const\s+memberId\s*=\s*(\d+)/)
  const topUser =
    html.match(/href="\/member\/([^"]+)"[^>]*class="top"/)?.[1] ||
    html.match(/href="\/member\/([^"]+)"/)?.[1]

  if (!memberIdMatch && !topUser) {
    return null
  }
  if (!topUser) {
    return null
  }

  return {
    isAuthenticated: true,
    userId: memberIdMatch?.[1] || topUser,
    username: topUser,
  }
}

export function parseOnceFromWriteHtml(html: string): string | null {
  return (
    html.match(/name="once"[^>]*value="(\d+)"/)?.[1] ||
    html.match(/value="(\d+)"[^>]*name="once"/)?.[1] ||
    html.match(/id="once"[^>]*value="(\d+)"/)?.[1] ||
    null
  )
}

export function buildPublishForm(
  title: string,
  content: string,
  once: string,
  nodeName: string = DEFAULT_NODE
): V2exPublishForm {
  return {
    title: title || '',
    content: content || '',
    syntax: 'markdown',
    node_name: nodeName,
    once,
  }
}

/** 从发布结果 URL / HTML 解析主题链接 */
export function parseTopicUrlFromPublishResult(
  finalUrl: string,
  html: string
): string | null {
  const fromUrl = finalUrl.match(/\/t\/(\d+)/)
  if (fromUrl) {
    return `${BASE}/t/${fromUrl[1]}`
  }
  const fromHtml =
    html.match(/href="(\/t\/\d+)"/)?.[1] ||
    html.match(/content="0;url=(\/t\/\d+)"/i)?.[1]
  if (fromHtml) {
    return `${BASE}${fromHtml}`
  }
  return null
}

export class V2exAdapter extends PipelineAdapter {
  meta: PlatformMeta = {
    id: 'v2ex',
    name: 'V2EX',
    icon: 'https://www.v2ex.com/static/favicon.ico',
    homepage: WRITE_URL,
    capabilities: ['article'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.v2ex.com/*',
      headers: {
        Origin: BASE,
        Referer: WRITE_URL,
      },
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
  ]

  private async detectAuthViaSw(): Promise<AuthResult | null> {
    const response = await this.runtime.fetch(WRITE_URL, { credentials: 'include' })
    const html = await response.text()
    const finalUrl = response.url || WRITE_URL
    return parseAuthFromWriteHtml(html, finalUrl)
  }

  private async detectAuthViaPage(): Promise<AuthResult | null> {
    if (!this.runtime.tabs?.executeScript) return null

    const page = await this.runOnPageTab(PAGE_URL_PATTERN, WRITE_URL, async (tabId) => {
      return this.runtime.tabs!.executeScript(
        tabId,
        async () => {
          try {
            const response = await fetch('/write', { credentials: 'include' })
            const html = await response.text()
            return { ok: true as const, html, finalUrl: response.url, status: response.status }
          } catch (error) {
            return { ok: false as const, error: String((error as Error)?.message || error) }
          }
        },
        [],
        { world: 'MAIN' }
      )
    })

    if (!page || !('ok' in page) || !page.ok) {
      throw new Error(
        page && 'error' in page ? String(page.error) : '页面登录探测失败'
      )
    }

    return parseAuthFromWriteHtml(page.html, page.finalUrl)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      try {
        const fromSw = await this.detectAuthViaSw()
        if (fromSw?.isAuthenticated) {
          return fromSw
        }
        logger.debug('SW /write did not recognize login')
      } catch (error) {
        logger.debug('SW login probe failed:', error)
      }

      try {
        const fromPage = await this.detectAuthViaPage()
        if (fromPage?.isAuthenticated) {
          return fromPage
        }
      } catch (error) {
        logger.debug('page login probe failed:', error)
      }

      return {
        isAuthenticated: false,
        error: '未登录 V2EX，请先打开并登录 https://www.v2ex.com',
      }
    } catch (error) {
      logger.debug('checkAuth failed:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  private async fetchWriteHtml(): Promise<{ html: string; finalUrl: string }> {
    const response = await this.runtime.fetch(WRITE_URL, { credentials: 'include' })
    const html = await response.text()
    return { html, finalUrl: response.url || WRITE_URL }
  }

  private async publishTopic(form: V2exPublishForm): Promise<{ postId: string; postUrl: string }> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const body = new URLSearchParams({
        title: form.title,
        content: form.content,
        syntax: form.syntax,
        node_name: form.node_name,
        once: form.once,
      })

      const response = await this.runtime.fetch(WRITE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: BASE,
          Referer: WRITE_URL,
        },
        body,
        redirect: 'follow',
      })

      const html = await response.text()
      const finalUrl = response.url || ''
      const topicUrl = parseTopicUrlFromPublishResult(finalUrl, html)

      if (!topicUrl) {
        const errHint =
          html.match(/class="problem"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ||
          html.match(/class="inner"[^>]*>\s*<div[^>]*>([\s\S]{0,200}?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ||
          ''
        throw new Error(
          errHint
            ? `发布失败: ${errHint.slice(0, 200)}`
            : `发布失败: 未获得主题链接（HTTP ${response.status}，url=${finalUrl.slice(0, 120)}）`
        )
      }

      const postId = topicUrl.match(/\/t\/(\d+)/)?.[1] || ''
      return { postId, postUrl: topicUrl }
    })
  }

  /** SW 失败时：页面上下文 POST /write */
  private async publishTopicViaPage(form: V2exPublishForm): Promise<{ postId: string; postUrl: string }> {
    if (!this.runtime.tabs?.executeScript) {
      throw new Error('当前运行时不支持页面发布')
    }

    const result = await this.runOnPageTab(PAGE_URL_PATTERN, WRITE_URL, async (tabId) => {
      return this.runtime.tabs!.executeScript(
        tabId,
        async (payload: V2exPublishForm) => {
          try {
            const body = new URLSearchParams({
              title: payload.title,
              content: payload.content,
              syntax: payload.syntax,
              node_name: payload.node_name,
              once: payload.once,
            })
            const response = await fetch('/write', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body,
              redirect: 'follow',
            })
            const html = await response.text()
            return {
              ok: true as const,
              status: response.status,
              finalUrl: response.url,
              htmlHead: html.slice(0, 8000),
            }
          } catch (error) {
            return { ok: false as const, error: String((error as Error)?.message || error) }
          }
        },
        [form],
        { world: 'MAIN' }
      )
    })

    if (!result?.ok) {
      throw new Error(result && 'error' in result ? String(result.error) : '页面发布失败')
    }

    const topicUrl = parseTopicUrlFromPublishResult(result.finalUrl, result.htmlHead)
    if (!topicUrl) {
      throw new Error(`页面发布失败: 未获得主题链接（HTTP ${result.status}）`)
    }
    const postId = topicUrl.match(/\/t\/(\d+)/)?.[1] || ''
    return { postId, postUrl: topicUrl }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：沿用 checkAuth（SW + 页面探测） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    const auth = await this.checkAuth()
    if (!auth.isAuthenticated) {
      throw new Error(auth.error || '未登录 V2EX')
    }
  }

  /** 2. 内容规整：标题校验 + 剥离本地 data/blob URI + 长度检查 */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    const title = (ctx.article.title || '').trim()
    if (!title) {
      throw new Error('标题不能为空')
    }
    let markdown = ctx.content.markdown || ''
    markdown = markdown
      .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
      .replace(/!\[[^\]]*\]\(blob:[^)]+\)/gi, '')
      .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')
      .replace(/<img\b[^>]*\bsrc=["']blob:[^"']+["'][^>]*>/gi, '')
    if (markdown.length > CONTENT_MAX) {
      throw new Error(
        `正文超过 V2EX 上限（${markdown.length} > ${CONTENT_MAX} 字符），请缩短后再同步`
      )
    }
    ctx.content.markdown = markdown
  }

  /** 3. 上传图片：noop（V2EX 不中转图片链接，http(s) 原样保留） */
  protected async uploadImages(_ctx: PublishContext): Promise<void> {
    // V2EX 产品策略：不中转图片
  }

  /** 5. 构建发布表单：fetchWriteHtml 获取 once + 组装 V2exPublishForm */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const { html: writeHtml, finalUrl } = await this.fetchWriteHtml()
    if (!parseAuthFromWriteHtml(writeHtml, finalUrl)) {
      throw new Error('未登录 V2EX，请先打开并登录 https://www.v2ex.com')
    }
    const once = parseOnceFromWriteHtml(writeHtml)
    if (!once) {
      throw new Error('获取 once 失败，请刷新 https://www.v2ex.com/write 后重试')
    }
    const title = (ctx.article.title || '').trim()
    ctx.payload = buildPublishForm(title, ctx.content.markdown, once, DEFAULT_NODE)
  }

  /** 6. 提交：publishTopic（SW）失败再 publishTopicViaPage（社区型直接发帖，draftOnly=false） */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const form = ctx.payload as V2exPublishForm
    let published: { postId: string; postUrl: string }
    try {
      published = await this.publishTopic(form)
    } catch (error) {
      logger.warn('SW publish failed, fallback to page:', error)
      // once 可能已失效，重新取
      const again = await this.fetchWriteHtml()
      const once2 = parseOnceFromWriteHtml(again.html)
      if (!once2) throw error
      published = await this.publishTopicViaPage(
        buildPublishForm(form.title, form.content, once2, DEFAULT_NODE)
      )
    }
    logger.info('Published topic:', published.postUrl)
    return this.createResult(true, {
      postId: published.postId,
      postUrl: published.postUrl,
      draftOnly: false,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }
}
