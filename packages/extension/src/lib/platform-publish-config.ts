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

/**
 * 写入 platformPublishConfig 前归一化：题图仅保留 auto/none，避免手动 URL 污染默认缓存。
 */
export function toPersistablePublishParams(params: PublishParams): PublishParams {
  const next: PublishParams = { ...params }
  if (next.cover !== undefined && next.cover !== 'auto' && next.cover !== 'none') {
    delete next.cover
  }
  return next
}
