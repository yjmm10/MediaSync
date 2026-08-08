/**
 * 发布参数（管道内部用）
 *
 * 扩展侧已不再提供平台参数配置 UI；同步时仅传入 mode（draft / publish）。
 * 适配器 buildPayload 可读 ctx.params，未设置字段按平台硬编码默认处理。
 */

/** 发布模式 */
export type PublishMode = 'draft' | 'publish' | 'schedule'

/** 付费阅读配置 */
export interface PaidConfig {
  enabled: boolean
  price?: number
}

/**
 * 发布参数（语义化、跨平台通用）
 *
 * 当前产品路径：扩展只传 mode；其余字段保留类型以兼容适配器内可选读取。
 */
export interface PublishParams {
  /** 发布模式 */
  mode?: PublishMode
  /** 定时发布时间戳（ms） */
  scheduleAt?: number

  /** 标签列表（平台原生名称，resolveReferences 转 id） */
  tags?: string[]
  /** 分类 id（来自远程列表） */
  category?: string
  /** 专栏/合集/文集 id（单选） */
  column?: string
  /** 专栏/合集/文集 id 列表（多选，如博客园合集） */
  columns?: string[]
  /** 封面：URL | 'auto' | 'none' */
  cover?: string
  /** 摘要 */
  summary?: string
  /** 副标题 */
  subtitle?: string

  /** 原创类型 */
  originalType?: 'original' | 'reprint' | 'translate'
  /** 转载/翻译原文链接 */
  originalLink?: string

  /** 可见性：'public' | 'private' | 'followers' | 'password' | 平台特有值 */
  visibility?: string

  /** 节点/分区/板块/subreddit id（社区型必填） */
  node?: string

  /** 活动 id */
  activityId?: string
  /** 话题 id */
  topicId?: string

  /** 是否允许评论 */
  commentsEnabled?: boolean

  /** 开启赞赏 */
  reward?: boolean
  /** 付费阅读 */
  paid?: PaidConfig

  /** 平台特有兜底（微信图文专属字段等） */
  extra?: Record<string, unknown>
}
