/**
 * 分类 Profile
 *
 * 每个分类的默认 Schema 字段集 + 默认 preprocessConfig + 默认 publishModes。
 * 新平台 extends PipelineAdapter 后应用 profile 默认值 + 重写差异点。
 *
 * 这是「配置对象 + mixin」，不是深继承：平台可自由组合、覆盖，
 * 避免分类基类继承树的僵化。
 */
import type { PreprocessConfig } from './types'
import { DEFAULT_PREPROCESS_CONFIG } from './types'
import type { PublishMode } from './publish-params'
import type { SchemaField } from './publish-schema'

/** 分类 profile 形状 */
export interface CategoryProfile {
  /** 默认预处理配置（与 DEFAULT_PREPROCESS_CONFIG 合并） */
  defaultPreprocess: Partial<PreprocessConfig>
  /** 默认 Schema 字段（平台可在此基础上增删） */
  defaultSchemaFields: SchemaField[]
  /** 默认支持的发布模式 */
  defaultPublishModes: PublishMode[]
}

/** Markdown 输出（技术社区 / 云厂商通用） */
const markdownOutput: Partial<PreprocessConfig> = {
  outputFormat: 'markdown',
}

/** HTML 输出（媒体号 / 图片型通用） */
const htmlOutput: Partial<PreprocessConfig> = {
  outputFormat: 'html',
}

/** 原创类型常用选项 */
const originalTypeOptions = [
  { value: 'original' as const, label: '原创' },
  { value: 'reprint' as const, label: '转载' },
  { value: 'translate' as const, label: '翻译' },
]

/**
 * 技术社区（掘金/知乎/CSDN/博客园/思否/51CTO/开源中国/InfoQ/简书/语雀）
 * Markdown 草稿 + 标签/分类/封面
 */
export const techCommunityProfile: CategoryProfile = {
  defaultPreprocess: markdownOutput,
  defaultSchemaFields: [
    { kind: 'tags', key: 'tags', label: '标签' },
    { kind: 'category', key: 'category', label: '分类', source: 'remote' },
    { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
  ],
  defaultPublishModes: ['draft'],
}

/**
 * 媒体号（百家号/搜狐/微博/微信/网易号/一点号/大鱼号/企鹅号/东方财富/imooc/woshipm/雪球）
 * HTML + 原创声明 + 封面 + 分类
 */
export const mediaAccountProfile: CategoryProfile = {
  defaultPreprocess: htmlOutput,
  defaultSchemaFields: [
    {
      kind: 'originalType',
      key: 'originalType',
      label: '原创类型',
      needsOriginalLink: true,
      options: originalTypeOptions,
    },
    { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
    { kind: 'category', key: 'category', label: '分类', source: 'remote' },
  ],
  defaultPublishModes: ['draft'],
}

/**
 * 云厂商（腾讯云/阿里云/百度开发者/火山/千帆/魔搭）
 * Markdown + 标签/分类/摘要
 */
export const cloudVendorProfile: CategoryProfile = {
  defaultPreprocess: markdownOutput,
  defaultSchemaFields: [
    { kind: 'tags', key: 'tags', label: '标签' },
    { kind: 'category', key: 'category', label: '分类', source: 'remote' },
    { kind: 'summary', key: 'summary', label: '摘要' },
  ],
  defaultPublishModes: ['draft'],
}

/**
 * 社区论坛（V2EX/虎扑/Reddit/豆瓣）
 * node 必填 + 直接发帖
 */
export const socialForumProfile: CategoryProfile = {
  defaultPreprocess: markdownOutput,
  defaultSchemaFields: [
    { kind: 'node', key: 'node', label: '节点', source: 'remote', required: true },
  ],
  defaultPublishModes: ['publish'],
}

/**
 * 图片型（美篇/小红书）
 * 封面优先 + 可见性
 */
export const imageBasedProfile: CategoryProfile = {
  defaultPreprocess: htmlOutput,
  defaultSchemaFields: [
    { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual'] },
    {
      kind: 'visibility',
      key: 'visibility',
      label: '可见性',
      options: [
        { value: 'public', label: '公开' },
        { value: 'private', label: '仅自己可见' },
      ],
    },
  ],
  defaultPublishModes: ['draft'],
}

/** 特殊（ZipDownload、私有适配器） */
export const specialProfile: CategoryProfile = {
  defaultPreprocess: { ...DEFAULT_PREPROCESS_CONFIG },
  defaultSchemaFields: [],
  defaultPublishModes: ['draft'],
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
