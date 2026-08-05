/**
 * 平台档案
 *
 * 聚合平台的全部静态声明：元信息、分类、预处理配置、
 * 发布模式能力、鉴权模式、配置 Schema、默认参数。
 * UI 通过 profile 一次取齐渲染所需的元数据。
 */
import type { PlatformMeta } from '../types'
import type { PreprocessConfig } from './types'
import type { PublishMode, PublishParams } from './publish-params'
import type { PublishSchema } from './publish-schema'

/**
 * 平台分类
 * - tech-community：技术社区（掘金/知乎/CSDN/博客园…）
 * - media-account：媒体号（百家号/搜狐/微博/微信…）
 * - cloud-vendor：云厂商（腾讯云/阿里云/百度开发者…）
 * - social-forum：社区论坛（V2EX/虎扑/Reddit/豆瓣）
 * - image-based：图片型（美篇/小红书）
 * - special：特殊（ZipDownload、私有适配器）
 */
export type PlatformCategory =
  | 'tech-community'
  | 'media-account'
  | 'cloud-vendor'
  | 'social-forum'
  | 'image-based'
  | 'special'

/**
 * 鉴权模式（取代手工维护的 PAGE_CONTEXT_AUTH_IDS）
 * - sw：Service Worker 直调 API / 拉 HTML，不开标签
 * - page-context：依赖临时标签 executeScript
 * - hybrid：SW 优先，失败回退页面上下文
 */
export type AuthMode = 'sw' | 'page-context' | 'hybrid'

/** 平台档案 */
export interface PlatformProfile {
  /** 平台元信息 */
  meta: PlatformMeta
  /** 平台分类 */
  category: PlatformCategory
  /** 内容预处理配置（Content Script 据此清洗 DOM） */
  preprocessConfig: PreprocessConfig
  /** 支持的发布模式（约束 mode 选项，取代 draftOnly） */
  publishModes: PublishMode[]
  /** 鉴权模式（调度层据此决定批量刷新是否跳过，避免误开标签） */
  authMode: AuthMode
  /** 配置 Schema（未声明 = 该平台无用户可配项） */
  publishSchema?: PublishSchema
  /** 这些字段的默认值 */
  publishDefaults?: PublishParams
}
