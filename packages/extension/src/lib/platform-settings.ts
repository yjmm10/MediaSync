/**
 * 平台默认发布参数持久化
 *
 * chrome.storage.local.platformSettings: { [platformId]: PublishParams }
 * 用户在「设置 → 平台默认」里保存的默认值；syncToPlatform 合并时取这里。
 *
 * 合并优先级（见 @mediasync/core 的 mergeParams）：
 *   本次覆盖 > 用户保存（此处）> 适配器 publishDefaults
 */
import type { PublishParams } from '@mediasync/core'

const PLATFORM_SETTINGS_KEY = 'platformSettings'

type PlatformSettingsMap = Record<string, PublishParams>

async function readAll(): Promise<PlatformSettingsMap> {
  try {
    const storage = await chrome.storage.local.get(PLATFORM_SETTINGS_KEY)
    return (storage[PLATFORM_SETTINGS_KEY] as PlatformSettingsMap | undefined) ?? {}
  } catch {
    return {}
  }
}

/** 读取某平台用户保存的默认参数（未设置返回 undefined） */
export async function getSavedParams(
  platformId: string,
): Promise<PublishParams | undefined> {
  const all = await readAll()
  return all[platformId]
}

/** 保存某平台默认参数（覆盖） */
export async function setSavedParams(
  platformId: string,
  params: PublishParams,
): Promise<void> {
  const all = await readAll()
  all[platformId] = params
  await chrome.storage.local.set({ [PLATFORM_SETTINGS_KEY]: all })
}

/** 清除某平台默认参数（恢复适配器内置默认） */
export async function clearSavedParams(platformId: string): Promise<void> {
  const all = await readAll()
  delete all[platformId]
  await chrome.storage.local.set({ [PLATFORM_SETTINGS_KEY]: all })
}

/** 读取全部平台默认（用于 UI 一次性渲染设置页） */
export async function getAllSavedParams(): Promise<PlatformSettingsMap> {
  return readAll()
}
