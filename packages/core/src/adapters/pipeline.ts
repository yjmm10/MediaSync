/**
 * 发布管道
 *
 * 把 publish() 拆成有序钩子，基类提供默认实现；适配器只重写差异点。
 * 钩子顺序：
 *   authorize → normalizeContent → uploadImages → resolveReferences
 *   → buildPayload → submit
 *
 * 设计要点：
 * - 继承 CodeAdapter，复用 HTTP / Header 规则 / processImages / page tab 能力
 * - 鉴权走 authStrategies 级联（对齐 CLAUDE.md 三档优先级）
 * - 图片走 SharedImageCache 去重（方案 A：同平台去重）
 * - submit 外层自动 withHeaderRules 包装（子类重写 getHeaderRules 提供规则）
 * - publish 与 checkAuth 都在 finally 调 releaseEphemeralTabs，避免标签残留
 *
 * 子类必须实现：buildPayload + submit
 * 子类通常重写：resolveReferences（拉远程分类/标签/节点列表）
 * 子类可选重写：authorize / normalizeContent / uploadImages / getHeaderRules
 */
import type { Article, AuthResult, HeaderRule, SyncResult } from '../types'
import { CodeAdapter } from './code-adapter'
import type { ImageProcessOptions, ImageUploadResult } from './code-adapter'
import type { PublishParams } from './publish-params'
import type { PublishOptions } from './types'
import type { SharedImageCache } from './image-cache'
import { createNoopImageCache } from './image-cache'
import type { AuthStrategy, AuthContext } from './auth-strategy'
import { CompositeAuthStrategy } from './auth-strategy'
import type { TokenProvider } from './token-provider'
import { createLogger } from '../lib/logger'

const logger = createLogger('Pipeline')

/** 每平台预处理后的内容 */
export interface PlatformContent {
  html: string
  markdown: string
}

/** 管道视角的 Article（含每平台预处理产物） */
export type PipelineArticle = Article & {
  platformContents?: Record<string, PlatformContent>
}

/** 钩子间传递的中间产物（resolveReferences 填充，buildPayload/submit 消费） */
export interface PublishRefs {
  /** 标签名 → id */
  tagIds?: Record<string, string>
  /** 分类列表 */
  categories?: Array<{ id: string; name: string }>
  /** 活动列表 */
  activities?: Array<{ id: string; name: string }>
  /** 专栏列表 */
  columns?: Array<{ id: string; name: string }>
  /** 节点/分区/板块列表 */
  nodes?: Array<{ id: string; name: string }>
  /** 平台特有建议词等 */
  [key: string]: unknown
}

/** 贯穿管道的上下文 */
export interface PublishContext {
  article: PipelineArticle
  /** 合并后的最终参数（兜底 ⊕ 默认 ⊕ 本次） */
  params: PublishParams
  /** 处理后的内容（normalizeContent 填充、uploadImages 改写） */
  content: { markdown: string; html: string }
  /** 跨平台共享图片缓存 */
  imageCache: SharedImageCache
  /** 中间产物 */
  refs: PublishRefs
  /** 取消信号 */
  signal: AbortSignal
  /** 图片进度回调 */
  onImageProgress?: (current: number, total: number) => void
  /** buildPayload 填充，submit 消费 */
  payload?: unknown
  /** TokenProvider 填充（submit 前） */
  token?: string
}

/**
 * 管道适配器基类
 *
 * 新平台继承本类，声明 authStrategies / tokenProvider / profile，
 * 重写 buildPayload + submit 即可获得完整发布流程。
 *
 * 老适配器继续继承 CodeAdapter 直接实现 publish/checkAuth，零改动。
 */
export abstract class PipelineAdapter extends CodeAdapter {
  /** 鉴权策略链（按优先级声明；authorize/checkAuth 默认走 CompositeAuthStrategy 级联） */
  protected readonly authStrategies: AuthStrategy[] = []
  /** 可选的 CSRF/Session Token 提供者（submit 前自动 get） */
  protected readonly tokenProvider?: TokenProvider

  // ============ 钩子（带默认实现，按需重写）============

  /**
   * 1. 鉴权 — 默认 CompositeAuthStrategy 级联 authStrategies
   * 抛错或未登录则终止管道
   */
  protected async authorize(ctx: PublishContext): Promise<void> {
    this.assertNotAborted(ctx)
    if (this.authStrategies.length === 0) return
    const result = await this.runAuthStrategies()
    if (!result || !result.isAuthenticated) {
      throw new Error(result?.error || `请先登录 ${this.meta.name}`)
    }
  }

  /**
   * 2. 内容规整 — 默认从 article.platformContents[id] 取，回退到 article.markdown/html
   */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    const pc = ctx.article.platformContents?.[this.meta.id]
    ctx.content = {
      markdown: pc?.markdown ?? ctx.article.markdown ?? '',
      html: pc?.html ?? ctx.article.html ?? '',
    }
  }

  /**
   * 3. 上传图片 — 默认 SharedImageCache 去重 + processImages（concurrency=3）
   * 子类需重写 CodeAdapter.uploadImageByUrl 提供本平台图床实现
   */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    const upload = async (src: string): Promise<ImageUploadResult> => {
      const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
      if (hit) return { url: hit }
      const result = await this.uploadImageByUrl(src)
      ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
      return result
    }
    const opts: ImageProcessOptions = {
      onProgress: ctx.onImageProgress,
      concurrency: 3,
    }
    ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
  }

  /**
   * 4. 解析远程引用 — 默认空
   * 需拉分类/活动/标签建议词/节点列表时重写，结果填入 ctx.refs
   */
  protected async resolveReferences(_ctx: PublishContext): Promise<void> {
    // 默认无操作
  }

  /** 5. 构建平台原生请求体 — 必须重写 */
  protected abstract buildPayload(ctx: PublishContext): Promise<void>

  /** 6. 提交并返回同步结果 — 必须重写（用 ctx.payload + ctx.token） */
  protected abstract submit(ctx: PublishContext): Promise<SyncResult>

  /**
   * Header 规则（submit 外层自动 withHeaderRules 包装）
   * 默认空；子类重写以提供 Origin/Referer/x-requested-with 等规则
   */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return []
  }

  // ============ 管道入口（基类实现，子类不再写 publish）============

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const ctx: PublishContext = {
      article: article as PipelineArticle,
      params: (options?.params ?? {}) as PublishParams,
      content: { markdown: '', html: '' },
      imageCache: options?.imageCache ?? createNoopImageCache(),
      refs: {},
      signal: options?.signal ?? new AbortController().signal,
      onImageProgress: options?.onImageProgress,
    }

    try {
      await this.authorize(ctx)
      await this.normalizeContent(ctx)
      await this.uploadImages(ctx)
      this.assertNotAborted(ctx)
      await this.resolveReferences(ctx)
      await this.buildPayload(ctx)
      this.assertNotAborted(ctx)

      if (this.tokenProvider) {
        ctx.token = await this.tokenProvider.get()
      }

      return await this.withHeaderRules(this.getHeaderRules(), () => this.submit(ctx))
    } catch (error) {
      const message = (error as Error)?.message || String(error)
      logger.error(`[${this.meta.id}] publish failed:`, message)
      return this.createResult(false, { error: message })
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  // ============ checkAuth 默认实现（基于 authStrategies 级联）============

  async checkAuth(): Promise<AuthResult> {
    if (this.authStrategies.length === 0) {
      throw new Error(
        `${this.meta.name} 未声明 authStrategies，需重写 checkAuth 或声明策略链`,
      )
    }
    try {
      const result = await this.runAuthStrategies()
      if (result) return result
      return { isAuthenticated: false, error: '所有鉴权策略均未决' }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  // ============ 辅助 ============

  /** 按声明顺序级联鉴权策略 */
  private async runAuthStrategies(): Promise<AuthResult | null> {
    const authCtx: AuthContext = {
      runtime: this.runtime,
      ephemeralTabIds: this.ephemeralTabIds,
    }
    return new CompositeAuthStrategy(this.authStrategies).check(authCtx)
  }

  /** 取消信号检查 */
  private assertNotAborted(ctx: PublishContext): void {
    if (ctx.signal.aborted) {
      throw new Error('已取消')
    }
  }
}
