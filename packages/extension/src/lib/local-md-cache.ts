/**
 * 本地 Markdown 导入缓存
 *
 * 缓存最近导入的正文（含 data URI 图片），用于历史「追加同步」时免重选文件夹。
 * 条数由设置 localMdCacheLimit 控制，默认 5，避免 storage 过大。
 */
import { computeDocId, type HistoryArticle } from './history-doc'
import { createLogger } from './logger'

const logger = createLogger('LocalMdCache')

export const LOCAL_MD_CACHE_KEY = 'localMdCache'
export const LOCAL_MD_CACHE_LIMIT_KEY = 'localMdCacheLimit'
export const DEFAULT_LOCAL_MD_CACHE_LIMIT = 5
export const MIN_LOCAL_MD_CACHE_LIMIT = 1
export const MAX_LOCAL_MD_CACHE_LIMIT = 20

export interface LocalMdCacheItem {
  id: string
  title: string
  markdown: string
  html: string
  cover?: string
  summary?: string
  fileName?: string
  importedAt: number
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LOCAL_MD_CACHE_LIMIT
  return Math.min(MAX_LOCAL_MD_CACHE_LIMIT, Math.max(MIN_LOCAL_MD_CACHE_LIMIT, Math.round(n)))
}

export async function getLocalMdCacheLimit(): Promise<number> {
  try {
    const result = await chrome.storage.local.get(LOCAL_MD_CACHE_LIMIT_KEY)
    const raw = result[LOCAL_MD_CACHE_LIMIT_KEY]
    if (typeof raw === 'number') return clampLimit(raw)
    return DEFAULT_LOCAL_MD_CACHE_LIMIT
  } catch (e) {
    logger.warn('getLocalMdCacheLimit failed:', e)
    return DEFAULT_LOCAL_MD_CACHE_LIMIT
  }
}

export async function setLocalMdCacheLimit(n: number): Promise<number> {
  const limit = clampLimit(n)
  await chrome.storage.local.set({ [LOCAL_MD_CACHE_LIMIT_KEY]: limit })
  // 缩容时立刻裁剪
  const list = await getLocalMdCache()
  if (list.length > limit) {
    await chrome.storage.local.set({ [LOCAL_MD_CACHE_KEY]: list.slice(0, limit) })
  }
  return limit
}

export async function getLocalMdCache(): Promise<LocalMdCacheItem[]> {
  try {
    const result = await chrome.storage.local.get(LOCAL_MD_CACHE_KEY)
    const list = result[LOCAL_MD_CACHE_KEY]
    return Array.isArray(list) ? (list as LocalMdCacheItem[]) : []
  } catch (e) {
    logger.warn('getLocalMdCache failed:', e)
    return []
  }
}

export async function getLocalMdCacheByDocId(docId: string): Promise<LocalMdCacheItem | undefined> {
  const list = await getLocalMdCache()
  return list.find(item => item.id === docId)
}

export async function pushLocalMdCache(input: {
  title: string
  markdown: string
  html: string
  cover?: string
  summary?: string
  fileName?: string
}): Promise<void> {
  const article: HistoryArticle = {
    title: input.title,
    markdown: input.markdown,
    html: input.html,
  }
  const id = computeDocId(article)
  const next: LocalMdCacheItem = {
    id,
    title: input.title,
    markdown: input.markdown,
    html: input.html,
    cover: input.cover,
    summary: input.summary,
    fileName: input.fileName,
    importedAt: Date.now(),
  }

  const limit = await getLocalMdCacheLimit()
  const prev = await getLocalMdCache()
  // 同 id 保留旧 fileName（编辑回写时可能未带）
  const existing = prev.find(item => item.id === id)
  if (existing?.fileName && !next.fileName) next.fileName = existing.fileName
  const merged = [next, ...prev.filter(item => item.id !== id)].slice(0, limit)

  try {
    await chrome.storage.local.set({ [LOCAL_MD_CACHE_KEY]: merged })
    logger.debug('Pushed local MD cache:', id, 'size=', merged.length)
  } catch (e) {
    logger.warn('pushLocalMdCache failed (quota?):', e)
  }
}

/**
 * 将当前文章快照写回本地 MD 缓存（导入/编辑后、追加同步前）。
 * 无 markdown/html 时跳过。
 */
export async function upsertLocalMdCacheFromArticle(article: {
  title: string
  markdown?: string
  html?: string
  content?: string
  cover?: string
  summary?: string
}): Promise<void> {
  const markdown = article.markdown || ''
  const html = article.html || article.content || ''
  if (!markdown && !html) return
  await pushLocalMdCache({
    title: article.title,
    markdown: markdown || html,
    html: html || markdown,
    cover: article.cover,
    summary: article.summary,
  })
}

export async function clearLocalMdCache(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_MD_CACHE_KEY)
}

/** 当前工作稿（导入/编辑）— 关 popup 后恢复主页正文 */
export const WORKING_ARTICLE_KEY = 'workingArticle'

export interface WorkingArticleSnapshot {
  title: string
  content?: string
  html?: string
  markdown?: string
  cover?: string
  summary?: string
  source: 'import' | 'edited'
  savedAt: number
}

export async function saveWorkingArticle(article: {
  title: string
  content?: string
  html?: string
  markdown?: string
  cover?: string
  summary?: string
  source?: string
}): Promise<void> {
  const source = article.source
  if (source !== 'import' && source !== 'edited') return
  const markdown = article.markdown || ''
  const html = article.html || article.content || ''
  if (!article.title?.trim() && !markdown && !html) return
  const snap: WorkingArticleSnapshot = {
    title: article.title || '',
    content: article.content,
    html: article.html,
    markdown: article.markdown,
    cover: article.cover,
    summary: article.summary,
    source,
    savedAt: Date.now(),
  }
  try {
    await chrome.storage.local.set({ [WORKING_ARTICLE_KEY]: snap })
  } catch (e) {
    logger.warn('saveWorkingArticle failed (quota?):', e)
  }
}

export async function loadWorkingArticle(): Promise<WorkingArticleSnapshot | null> {
  try {
    const result = await chrome.storage.local.get(WORKING_ARTICLE_KEY)
    const raw = result[WORKING_ARTICLE_KEY]
    if (!raw || typeof raw !== 'object') return null
    const snap = raw as WorkingArticleSnapshot
    if (snap.source !== 'import' && snap.source !== 'edited') return null
    if (!snap.title && !snap.markdown && !snap.html && !snap.content) return null
    return snap
  } catch (e) {
    logger.warn('loadWorkingArticle failed:', e)
    return null
  }
}

export async function clearWorkingArticle(): Promise<void> {
  try {
    await chrome.storage.local.remove(WORKING_ARTICLE_KEY)
  } catch (e) {
    logger.warn('clearWorkingArticle failed:', e)
  }
}

/** 本地 Markdown 缓存占用字节数（优先 storage API，否则按 JSON 估算） */
export async function getLocalMdCacheBytes(): Promise<number> {
  try {
    if (typeof chrome.storage.local.getBytesInUse === 'function') {
      return await chrome.storage.local.getBytesInUse(LOCAL_MD_CACHE_KEY)
    }
  } catch (e) {
    logger.warn('getBytesInUse failed, fallback to estimate:', e)
  }
  const list = await getLocalMdCache()
  return new TextEncoder().encode(JSON.stringify(list)).length
}

/** 将字节数格式化为可读字符串 */
export function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
