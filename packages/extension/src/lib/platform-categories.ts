/**
 * 平台 UI 分类映射（扩展侧桥接）
 *
 * 对齐 docs/refactor-architecture.md「平台分类」；
 * 适配器未统一声明 category 前，用此表驱动列表分组。
 */
import type { PlatformCategory } from '@mediasync/core'

export type { PlatformCategory }

/** 展示顺序 */
export const CATEGORY_ORDER: PlatformCategory[] = [
  'tech-community',
  'cloud-vendor',
  'media-account',
  'social-forum',
  'image-based',
  'special',
]

export const CATEGORY_LABELS: Record<PlatformCategory, string> = {
  'tech-community': '技术社区',
  'cloud-vendor': '云厂商',
  'media-account': '媒体号',
  'social-forum': '社区论坛',
  'image-based': '图片型',
  special: '其他',
}

const PLATFORM_CATEGORY_BY_ID: Record<string, PlatformCategory> = {
  // tech-community
  zhihu: 'tech-community',
  juejin: 'tech-community',
  csdn: 'tech-community',
  cnblogs: 'tech-community',
  segmentfault: 'tech-community',
  cto51: 'tech-community',
  oschina: 'tech-community',
  infoq: 'tech-community',
  jianshu: 'tech-community',
  yuque: 'tech-community',
  // cloud-vendor
  tencentcloud: 'cloud-vendor',
  'aliyun-developer': 'cloud-vendor',
  'baidu-developer': 'cloud-vendor',
  volcengine: 'cloud-vendor',
  qianfan: 'cloud-vendor',
  modelscope: 'cloud-vendor',
  // media-account
  baijiahao: 'media-account',
  sohu: 'media-account',
  weibo: 'media-account',
  weixin: 'media-account',
  netease: 'media-account',
  yidian: 'media-account',
  dayu: 'media-account',
  qiehao: 'media-account',
  eastmoney: 'media-account',
  imooc: 'media-account',
  woshipm: 'media-account',
  xueqiu: 'media-account',
  // social-forum
  v2ex: 'social-forum',
  hupu: 'social-forum',
  reddit: 'social-forum',
  douban: 'social-forum',
  // image-based
  meipian: 'image-based',
  xiaohongshu: 'image-based',
  // special
  'zip-download': 'special',
  bilibili: 'special',
}

export function getPlatformCategory(id: string): PlatformCategory {
  return PLATFORM_CATEGORY_BY_ID[id] ?? 'special'
}
