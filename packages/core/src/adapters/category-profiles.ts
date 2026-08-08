/**
 * 分类 Profile
 *
 * 每个分类的默认 preprocessConfig。
 * 新平台 extends PipelineAdapter 后应用 profile 默认值 + 重写差异点。
 *
 * 这是「配置对象 + mixin」，不是深继承：平台可自由组合、覆盖，
 * 避免分类基类继承树的僵化。
 */
import type { PreprocessConfig } from './types'
import { DEFAULT_PREPROCESS_CONFIG } from './types'

/** 分类 profile 形状 */
export interface CategoryProfile {
  /** 默认预处理配置（与 DEFAULT_PREPROCESS_CONFIG 合并） */
  defaultPreprocess: Partial<PreprocessConfig>
}

/** Markdown 输出（技术社区 / 云厂商通用） */
const markdownOutput: Partial<PreprocessConfig> = {
  outputFormat: 'markdown',
}

/** HTML 输出（媒体号 / 图片型通用） */
const htmlOutput: Partial<PreprocessConfig> = {
  outputFormat: 'html',
}

/**
 * 技术社区（掘金/知乎/CSDN/博客园/思否/51CTO/开源中国/InfoQ/简书/语雀）
 * Markdown 草稿
 */
export const techCommunityProfile: CategoryProfile = {
  defaultPreprocess: markdownOutput,
}

/**
 * 媒体号（百家号/搜狐/微博/微信/网易号/一点号/大鱼号/企鹅号/东方财富/imooc/woshipm/雪球）
 * HTML
 */
export const mediaAccountProfile: CategoryProfile = {
  defaultPreprocess: htmlOutput,
}

/**
 * 云厂商（腾讯云/阿里云/百度开发者/火山/千帆/魔搭）
 * Markdown
 */
export const cloudVendorProfile: CategoryProfile = {
  defaultPreprocess: markdownOutput,
}

/**
 * 社区论坛（V2EX/虎扑/Reddit/豆瓣）
 * Markdown
 */
export const socialForumProfile: CategoryProfile = {
  defaultPreprocess: markdownOutput,
}

/**
 * 图片型（美篇/小红书）
 * HTML
 */
export const imageBasedProfile: CategoryProfile = {
  defaultPreprocess: htmlOutput,
}

/** 特殊（ZipDownload、私有适配器） */
export const specialProfile: CategoryProfile = {
  defaultPreprocess: { ...DEFAULT_PREPROCESS_CONFIG },
}

/** 按分类取 profile（未知分类回退到 special） */
export function getCategoryProfile(category: string): CategoryProfile {
  switch (category) {
    case 'tech-community':
      return techCommunityProfile
    case 'media-account':
      return mediaAccountProfile
    case 'cloud-vendor':
      return cloudVendorProfile
    case 'social-forum':
      return socialForumProfile
    case 'image-based':
      return imageBasedProfile
    case 'special':
      return specialProfile
    default:
      return specialProfile
  }
}
