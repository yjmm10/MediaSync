/**
 * 依赖打开标签做登录检测的平台（后台 SW 无法可靠真检）。
 * 仅这些平台在 UI 上提供「重检」；其余走 SW 批量鉴权。
 */
export const TAB_AUTH_PLATFORM_ID_LIST = [
  'meipian',
  'xiaohongshu',
  'qiehao',
  'volcengine',
  'baidu-developer',
  'tencentcloud',
  'aliyun-developer',
  'modelscope',
  'v2ex',
] as const

const TAB_AUTH_PLATFORM_ID_SET = new Set<string>(TAB_AUTH_PLATFORM_ID_LIST)

export function isTabAuthPlatform(platformId: string): boolean {
  return TAB_AUTH_PLATFORM_ID_SET.has(platformId)
}

export function getTabAuthPlatformIds(): string[] {
  return [...TAB_AUTH_PLATFORM_ID_LIST]
}
