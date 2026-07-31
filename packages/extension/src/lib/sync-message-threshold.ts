/**
 * 同步消息体积阈值：超过则正文改走 chrome.storage，避免 sendMessage 撑爆 64MiB。
 * 阈值可配置；不拦同步，只决定传输路径。
 */

import { createLogger } from './logger'

const logger = createLogger('SyncMessageThreshold')

export const SYNC_MESSAGE_SIZE_THRESHOLD_MB_KEY = 'syncMessageSizeThresholdMb'
export const PENDING_SYNC_ARTICLE_KEY = 'pendingSyncArticle'
export const PENDING_PREPROCESS_HTML_KEY = 'pendingPreprocessHtml'

/** 默认 8MB：较早改走 storage，降低撞 64MiB 的概率 */
export const DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB = 8
export const MIN_SYNC_MESSAGE_SIZE_THRESHOLD_MB = 1
export const MAX_SYNC_MESSAGE_SIZE_THRESHOLD_MB = 32

/** 不可配置安全网：逼近 Chrome 硬限时强制 storage */
export const HARD_FORCE_STORAGE_BYTES = 48 * 1024 * 1024

export function clampSyncMessageSizeThresholdMb(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB
  return Math.min(
    MAX_SYNC_MESSAGE_SIZE_THRESHOLD_MB,
    Math.max(MIN_SYNC_MESSAGE_SIZE_THRESHOLD_MB, Math.round(n)),
  )
}

export async function getSyncMessageSizeThresholdMb(): Promise<number> {
  try {
    const result = await chrome.storage.local.get(SYNC_MESSAGE_SIZE_THRESHOLD_MB_KEY)
    const raw = result[SYNC_MESSAGE_SIZE_THRESHOLD_MB_KEY]
    if (typeof raw === 'number') return clampSyncMessageSizeThresholdMb(raw)
    return DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB
  } catch (e) {
    logger.warn('getSyncMessageSizeThresholdMb failed:', e)
    return DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB
  }
}

export async function setSyncMessageSizeThresholdMb(n: number): Promise<number> {
  const limit = clampSyncMessageSizeThresholdMb(n)
  await chrome.storage.local.set({ [SYNC_MESSAGE_SIZE_THRESHOLD_MB_KEY]: limit })
  return limit
}

/** UTF-8 近似字节数（JSON 序列化后） */
export function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export async function shouldUseStorageForPayload(payloadLike: unknown): Promise<boolean> {
  const bytes = estimateJsonBytes(payloadLike)
  if (bytes >= HARD_FORCE_STORAGE_BYTES) return true
  const mb = await getSyncMessageSizeThresholdMb()
  return bytes >= mb * 1024 * 1024
}

export async function shouldUseStorageForRawHtml(rawHtml: string): Promise<boolean> {
  return shouldUseStorageForPayload({ rawHtml })
}

/** 组装预处理消息；超阈值时正文写入 storage */
export async function buildPreprocessMessage(
  rawHtml: string,
  platforms: string[],
  configs: Record<string, unknown>,
): Promise<{ type: 'PREPROCESS_FOR_PLATFORMS'; payload: Record<string, unknown> }> {
  if (await shouldUseStorageForRawHtml(rawHtml)) {
    await chrome.storage.local.set({
      [PENDING_PREPROCESS_HTML_KEY]: { rawHtml, ts: Date.now() },
    })
    return {
      type: 'PREPROCESS_FOR_PLATFORMS',
      payload: { fromStorage: true, platforms, configs },
    }
  }
  return {
    type: 'PREPROCESS_FOR_PLATFORMS',
    payload: { rawHtml, platforms, configs },
  }
}

/** content / preprocessor：解析预处理 payload 中的 rawHtml */
export async function resolvePreprocessRawHtml(payload: {
  rawHtml?: string
  fromStorage?: boolean
}): Promise<string> {
  if (payload.fromStorage) {
    try {
      const r = await chrome.storage.local.get(PENDING_PREPROCESS_HTML_KEY)
      const stored = r[PENDING_PREPROCESS_HTML_KEY] as { rawHtml?: string } | undefined
      await chrome.storage.local.remove(PENDING_PREPROCESS_HTML_KEY).catch(() => {})
      return stored?.rawHtml || ''
    } catch (e) {
      logger.warn('resolvePreprocessRawHtml failed:', e)
      return ''
    }
  }
  return payload.rawHtml || ''
}
