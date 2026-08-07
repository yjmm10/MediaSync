/**
 * 每平台发布配置：用户默认参数 + 远程选项缓存（手动刷新，无 TTL 自动失效）
 */
import type { PublishParams } from '@mediasync/core'
import type { PublishRefs } from '@mediasync/core'

const SAVED_PARAMS_KEY = 'platformPublishConfig'
const REFS_CACHE_KEY = 'platformPublishRefsCache'

export interface CachedPublishRefs {
  updatedAt: number
  refs: PublishRefs
}

type SavedParamsMap = Record<string, PublishParams>
type RefsCacheMap = Record<string, CachedPublishRefs>

export async function getSavedParams(platformId: string): Promise<PublishParams | undefined> {
  const stored = await chrome.storage.local.get(SAVED_PARAMS_KEY)
  const map = (stored[SAVED_PARAMS_KEY] || {}) as SavedParamsMap
  return map[platformId]
}

export async function getAllSavedParams(): Promise<SavedParamsMap> {
  const stored = await chrome.storage.local.get(SAVED_PARAMS_KEY)
  return (stored[SAVED_PARAMS_KEY] || {}) as SavedParamsMap
}

export async function setSavedParams(
  platformId: string,
  params: PublishParams,
): Promise<void> {
  const stored = await chrome.storage.local.get(SAVED_PARAMS_KEY)
  const map = { ...((stored[SAVED_PARAMS_KEY] || {}) as SavedParamsMap) }
  map[platformId] = params
  await chrome.storage.local.set({ [SAVED_PARAMS_KEY]: map })
}

export async function getCachedRefs(platformId: string): Promise<CachedPublishRefs | null> {
  const stored = await chrome.storage.local.get(REFS_CACHE_KEY)
  const map = (stored[REFS_CACHE_KEY] || {}) as RefsCacheMap
  return map[platformId] ?? null
}

export async function setCachedRefs(platformId: string, refs: PublishRefs): Promise<CachedPublishRefs> {
  const entry: CachedPublishRefs = { updatedAt: Date.now(), refs }
  const stored = await chrome.storage.local.get(REFS_CACHE_KEY)
  const map = { ...((stored[REFS_CACHE_KEY] || {}) as RefsCacheMap) }
  map[platformId] = entry
  await chrome.storage.local.set({ [REFS_CACHE_KEY]: map })
  return entry
}

export async function clearCachedRefs(platformId: string): Promise<void> {
  const stored = await chrome.storage.local.get(REFS_CACHE_KEY)
  const map = { ...((stored[REFS_CACHE_KEY] || {}) as RefsCacheMap) }
  delete map[platformId]
  await chrome.storage.local.set({ [REFS_CACHE_KEY]: map })
}

/** 远程选项是否为空（无分类、无合集、无标签建议） */
export function isRefsEmpty(refs: PublishRefs | null | undefined): boolean {
  if (!refs) return true
  const cat = refs.categories?.length ?? 0
  const col = refs.columns?.length ?? 0
  const tags = Array.isArray(refs.tagSuggestions) ? refs.tagSuggestions.length : 0
  return cat === 0 && col === 0 && tags === 0
}

/** 由文档 FM / 勾选快照驱动的字段，不得写入设置页默认缓存，也不得在发布时用旧缓存盖回 */
export const FM_DRIVEN_PARAM_KEYS = [
  'cover',
  'summary',
  'tags',
  'category',
  'columns',
  'column',
] as const

/** 去掉 FM 驱动字段，只保留 mode / 可见性等平台设置 */
export function stripFmDrivenFields(params?: PublishParams): PublishParams {
  if (!params) return {}
  const next: PublishParams = { ...params }
  for (const k of FM_DRIVEN_PARAM_KEYS) {
    delete next[k]
  }
  return next
}

/**
 * 写入 platformPublishConfig 前归一化：
 * - 去掉 FM 驱动字段（tags/columns/summary 等），避免旧 FM 污染下次勾选/发布
 * - 题图仅保留 auto/none
 */
export function toPersistablePublishParams(params: PublishParams): PublishParams {
  const next = stripFmDrivenFields(params)
  // 题图仅保留 auto/none 作为平台默认；FM 里的 URL 不进设置缓存
  if (params.cover === 'auto' || params.cover === 'none') {
    next.cover = params.cover
  }
  return next
}
