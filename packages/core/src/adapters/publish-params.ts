/**
 * 发布参数与请求类型
 *
 * PublishParams 是跨平台语义化的发布配置（标签、分类、封面、原创类型、
 * 可见性、活动、专栏、节点、定时…）。每个平台通过 publishSchema 声明
 * 自己暴露哪些字段，UI 据此渲染表单；适配器在 buildPayload 钩子里
 * 把 PublishParams 翻译成平台原生请求体字段名。
 */
import type { Article } from '../types'

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
 * 合并优先级（高 → 低）：
 *   perPlatform[id] ⊕ 用户保存的平台默认值 ⊕ publishDefaults ⊕ Schema 兜底
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
  /** 专栏/合集/文集 id */
  column?: string
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

/** 单平台发布请求 */
export interface PlatformPublishRequest {
  platformId: string
  params: PublishParams
}

/**
 * 一次同步的完整请求
 * 替代当前散落的 article + options
 */
export interface PublishRequest {
  article: Article
  /** 每平台独立参数（未列出的平台用默认值） */
  perPlatform?: Record<string, PublishParams>
  /** 对话框顶部一次性模式默认，不持久化为全局配置 */
  defaultMode?: PublishMode
}

/**
 * 合并多源 PublishParams（高优先级覆盖低优先级）
 *
 * 优先级（高 → 低）：override（本次覆盖）> saved（用户保存）> defaults（适配器声明）
 * extra 字段深合并（微信图文专属字段叠加，避免覆盖丢失）。
 *
 * undefined 值不覆盖（允许上层"未设置"下传到下层）。
 */
export function mergeParams(
  defaults?: PublishParams,
  saved?: PublishParams,
  override?: PublishParams,
): PublishParams {
  const hasExtra = defaults?.extra || saved?.extra || override?.extra
  const merged: PublishParams = {
    ...defaults,
    ...saved,
    ...override,
  }
  if (hasExtra) {
    merged.extra = {
      ...(defaults?.extra ?? {}),
      ...(saved?.extra ?? {}),
      ...(override?.extra ?? {}),
    }
  }
  return merged
}
