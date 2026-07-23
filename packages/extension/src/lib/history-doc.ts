/**
 * 同步历史的文档级归档支持
 *
 * 历史按「文档」归档（docId）而非按「同步操作」归档：同一篇文档多次同步
 * （含追加同步到更多平台）合并到同一条历史记录，累计所有平台结果，并保留
 * 正文快照以支持「从历史追加同步」。
 *
 * docId 基于「标题 + 去图片正文」计算——图片随图床/上传变化，剔除后同一份
 * 内容无论同步几次都得到同一 id，从而能把多次同步合并。
 */
import { createLogger } from './logger'

const logger = createLogger('History')

export interface HistorySyncResult {
  platform: string
  platformName?: string
  success: boolean
  postUrl?: string
  draftOnly?: boolean
  message?: string
  error?: string
}

export type SyncHistoryStatus = 'syncing' | 'completed' | 'failed' | 'cancelled'

export interface SyncHistoryItem {
  /** 文档标识（同篇文档多次同步合并到同一条） */
  id: string
  title: string
  cover?: string
  /** 正文快照（图片已替换为图床 URL 的版本），用于从历史追加同步 */
  markdown?: string
  html?: string
  /** 内容来源：import / extract / editor 等 */
  source?: string
  /** 累计的所有平台结果（按 platform 去重，新结果覆盖旧结果） */
  results: HistorySyncResult[]
  /** 曾同步过的全部平台 id */
  platforms: string[]
  status: SyncHistoryStatus
  /** 首次同步时间 */
  startTime: number
  /** 最近一次同步完成时间 */
  lastSyncTime?: number
  /** 同步批次数（含追加） */
  syncCount: number
  /** 兼容旧字段 */
  timestamp?: number
  endTime?: number
}

export const MAX_HISTORY_ITEMS = 25

/** 同步用文章的最小结构（标题 / 正文 / 封面 / 来源） */
export interface HistoryArticle {
  title?: string
  cover?: string
  markdown?: string
  html?: string
  content?: string
  source?: string
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

/** 去除图片引用与所有空白，用于稳定的文档指纹 */
function normalizeForFingerprint(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown 图片
    .replace(/<img[^>]*>/gi, '') // html 图片
    .replace(/\s+/g, '')
}

/**
 * 计算文档标识。同一份内容（标题 + 去图片正文）得到同一 id。
 */
export function computeDocId(article: HistoryArticle): string {
  const title = (article.title || '').trim()
  const body = normalizeForFingerprint(article.markdown || article.html || article.content || '').slice(0, 2000)
  const s = title + '\n' + body
  // djb2 哈希
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return 'doc_' + (hash >>> 0).toString(36)
}

/**
 * 合并平台结果：新结果覆盖同平台旧结果，其余保留。
 */
export function mergeResults(oldR: HistorySyncResult[], newR: HistorySyncResult[]): HistorySyncResult[] {
  const map = new Map<string, HistorySyncResult>()
  for (const r of oldR) map.set(r.platform, r)
  for (const r of newR) map.set(r.platform, r)
  return Array.from(map.values())
}

/**
 * 从正文提取第一张图片作为封面，优先 http(s) URL（体积小、可直链），
 * 其次 data URI。
 */
export function extractCover(html?: string, markdown?: string): string | undefined {
  const candidates: string[] = []
  if (html) {
    const re = /<img[^>]+src=["']([^"']+)["']/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) candidates.push(m[1])
  }
  if (markdown) {
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      candidates.push(m[1].trim().replace(/^<|>$/g, '').split(/\s+/)[0])
    }
  }
  return (
    candidates.find(c => c.startsWith('http')) ||
    candidates.find(c => c.startsWith('data:'))
  )
}

/**
 * 开始同步时按 docId upsert 历史条目：
 * - 已存在：移到顶部，syncCount+1，合并 platforms，置 syncing，保留已有 results/正文/封面/首次时间
 * - 不存在：新建条目置顶
 */
export async function upsertHistoryItem(article: HistoryArticle, platforms: string[]): Promise<void> {
  try {
    const docId = computeDocId(article)
    const storage = await chrome.storage.local.get('syncHistory')
    const existing: SyncHistoryItem[] = storage.syncHistory || []
    const idx = existing.findIndex(h => h.id === docId)

    let item: SyncHistoryItem
    let rest: SyncHistoryItem[]
    if (idx >= 0) {
      const prev = existing[idx]
      item = {
        ...prev,
        status: 'syncing',
        platforms: uniq([...(prev.platforms || []), ...platforms]),
        syncCount: (prev.syncCount || 1) + 1,
      }
      rest = existing.filter((_, i) => i !== idx)
    } else {
      item = {
        id: docId,
        title: article.title || '未知文章',
        cover: article.cover,
        platforms,
        results: [],
        status: 'syncing',
        startTime: Date.now(),
        syncCount: 1,
      }
      rest = existing
    }

    const newHistory = [item, ...rest].slice(0, MAX_HISTORY_ITEMS)
    await chrome.storage.local.set({ syncHistory: newHistory })
    logger.info('History upsert:', docId, item.title, 'syncCount=', item.syncCount)
  } catch (e) {
    logger.error('upsertHistoryItem failed:', e)
  }
}

/**
 * 同步完成时按 docId 合并结果：
 * - 本次 results 覆盖同平台旧 results，其余保留
 * - 写入正文快照（markdown/html）与封面（extractCover 兜底）
 * - 更新 platforms 并集、status、lastSyncTime
 */
export async function mergeHistoryItem(
  article: HistoryArticle,
  status: SyncHistoryStatus,
  newResults: HistorySyncResult[],
  metas: Array<{ id: string; name: string }>
): Promise<void> {
  try {
    const docId = computeDocId(article)
    const storage = await chrome.storage.local.get('syncHistory')
    const existing: SyncHistoryItem[] = storage.syncHistory || []
    const idx = existing.findIndex(h => h.id === docId)

    const named = newResults.map(r => ({
      ...r,
      platformName: r.platformName || metas.find(m => m.id === r.platform)?.name || r.platform,
    }))

    let item: SyncHistoryItem
    let newHistory: SyncHistoryItem[]
    if (idx < 0) {
      // 兜底：开始时未 upsert（如老版本数据），此处补建
      item = {
        id: docId,
        title: article.title || '未知文章',
        cover: article.cover || extractCover(article.html, article.markdown),
        markdown: article.markdown,
        html: article.html,
        source: article.source,
        platforms: named.map(r => r.platform),
        results: named,
        status,
        startTime: Date.now(),
        lastSyncTime: Date.now(),
        syncCount: 1,
      }
      newHistory = [item, ...existing].slice(0, MAX_HISTORY_ITEMS)
    } else {
      const prev = existing[idx]
      const cover = prev.cover || article.cover || extractCover(article.html, article.markdown)
      item = {
        ...prev,
        title: article.title || prev.title,
        status,
        results: mergeResults(prev.results || [], named),
        platforms: uniq([...(prev.platforms || []), ...named.map(r => r.platform)]),
        lastSyncTime: Date.now(),
        cover,
        markdown: article.markdown || prev.markdown,
        html: article.html || prev.html,
        source: article.source || prev.source,
      }
      newHistory = [...existing]
      newHistory[idx] = item
    }

    await chrome.storage.local.set({ syncHistory: newHistory })
    logger.info('History merged:', docId, status, `${item.results.length} platforms`)
  } catch (e) {
    logger.error('mergeHistoryItem failed:', e)
  }
}
