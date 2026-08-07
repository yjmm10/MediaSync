import { create } from 'zustand'
import {
  trackRetry,
  trackContentProfile,
  trackFunnel,
  trackPlatformSelection,
  trackDraftClick,
  trackChurnSignal,
  trackImplicitFeedback,
} from '../../lib/analytics'
import { checkSyncFrequency } from '../../lib/rate-limit'
import { createLogger } from '../../lib/logger'
import type { SyncHistoryItem } from '../../lib/history-doc'
import {
  PENDING_SYNC_ARTICLE_KEY,
  shouldUseStorageForPayload,
} from '../../lib/sync-message-threshold'
import type { PublishParams } from '@mediasync/core'
import {
  metaToPublishParams,
  mirrorMetaToArticleFields,
  hasArticleMeta,
  type ArticleMeta,
} from '../../lib/article-meta'
import {
  getLocalMdCacheByDocId,
  upsertLocalMdCacheFromArticle,
} from '../../lib/local-md-cache'
import {
  getSavedParams,
  stripFmDrivenFields,
} from '../../lib/platform-publish-config'
import { computeDocId } from '../../lib/history-doc'

const logger = createLogger('SyncStore')

/**
 * 追踪文章内容特征
 */
function trackArticleProfile(article: { content?: string; cover?: string }, source: string) {
  if (!article.content) return

  const content = article.content
  // 计算字数（去除 HTML 标签）
  const textContent = content.replace(/<[^>]+>/g, '')
  const wordCount = textContent.length

  // 计算图片数量
  const imageMatches = content.match(/<img[^>]+>/gi)
  const imageCount = imageMatches?.length || 0

  // 检查是否有代码块
  const hasCode = /<pre[^>]*>|<code[^>]*>/i.test(content)

  // 检查是否有视频
  const hasVideo = /<video[^>]*>|<iframe[^>]*>/i.test(content)

  trackContentProfile({
    source,
    wordCount,
    imageCount,
    hasCode,
    hasCover: !!article.cover,
    hasVideo,
  }).catch(() => {})
}

interface Platform {
  id: string
  name: string
  icon: string
  homepage: string
  isAuthenticated: boolean
  username?: string
  avatar?: string
  // 区分平台类型：dsl 为 DSL 定义的平台，cms 为自建站点
  sourceType: 'dsl' | 'cms'
  // CMS 类型（仅 cms 类型有效）
  cmsType?: 'wordpress' | 'typecho' | 'metaweblog'
}

interface Article {
  title: string
  content: string
  summary?: string
  cover?: string
  /** Markdown 原文（导入文章 / 部分提取结果携带）*/
  markdown?: string
  /** 与 content 等价的 HTML（显式字段，便于同步时区分）*/
  html?: string
  /** front matter 结构化元数据（不进入正文渲染） */
  frontmatter?: ArticleMeta
  /** 来源：import=本地导入 / edited=检测后进编辑器(锁定) / extract=网页提取(实时) */
  source?: 'import' | 'edited' | 'extract'
}

/** 从文章 frontmatter（及顶层 cover/summary）生成平台参数种子 */
function seedParamsFromArticle(
  article: Article | null | undefined,
  platformId?: string,
): PublishParams {
  if (!article) return {}
  const fromFm = metaToPublishParams(article.frontmatter, platformId)
  // 顶层镜像兜底（网页提取只有 cover/summary 时）
  if (!fromFm.cover && article.cover) fromFm.cover = article.cover
  if (!fromFm.summary && article.summary) fromFm.summary = article.summary
  return fromFm
}

function hasExplicitMode(params?: PublishParams): boolean {
  return params?.mode === 'draft' || params?.mode === 'publish' || params?.mode === 'schedule'
}

/**
 * 勾选平台时的参数快照：当前 FM + 设置页非 FM 项（mode 等）。
 * 故意不把 saved 里旧的 tags/columns/summary 带进来。
 */
function snapshotParamsOnSelect(
  article: Article | null | undefined,
  platformId: string,
  saved?: PublishParams,
): PublishParams {
  const fromFm = seedParamsFromArticle(article, platformId)
  const nonFm = stripFmDrivenFields(saved)
  // 先铺非 FM，再铺 FM；最后显式清掉「本次 FM 未给出」的驱动字段，避免残留
  const snap: PublishParams = {
    ...nonFm,
    ...fromFm,
    mode: saved?.mode ?? nonFm.mode ?? 'draft',
  }
  if (!fromFm.tags) delete snap.tags
  if (!fromFm.columns) delete snap.columns
  if (!fromFm.category) delete snap.category
  if (!fromFm.column) delete snap.column
  if (!fromFm.summary) delete snap.summary
  if (!fromFm.cover) delete snap.cover
  return snap
}

/**
 * 仅补齐 mode 等非 FM 设置；不重新套用最新 FM，不把 saved 的旧 FM 字段写回。
 */
async function fillNonFmSettings(
  platformId: string,
  existing: PublishParams,
): Promise<PublishParams> {
  let saved: PublishParams | undefined
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GET_PLATFORM_PUBLISH_CONFIG',
      payload: { platformId },
    })
    if (resp && !resp.error) {
      saved = resp.saved as PublishParams | undefined
    }
  } catch {
    saved = await getSavedParams(platformId).catch(() => undefined)
  }
  if (!saved) {
    saved = await getSavedParams(platformId).catch(() => undefined)
  }
  const nonFm = stripFmDrivenFields(saved)
  return {
    ...nonFm,
    ...existing,
    mode: existing.mode ?? saved?.mode ?? nonFm.mode ?? 'draft',
  }
}

/** 规范化文章：frontmatter 变更时镜像 cover/summary */
function normalizeArticleFields(article: Article): Article {
  if (!article.frontmatter) return article
  const mirrored = mirrorMetaToArticleFields(article.frontmatter)
  return {
    ...article,
    cover: mirrored.cover ?? article.cover,
    summary: mirrored.summary ?? article.summary,
  }
}

/** 导入/编辑稿回写本地缓存（防抖，避免编辑器逐字写入） */
let cacheUpsertTimer: ReturnType<typeof setTimeout> | null = null
function scheduleLocalMdCacheUpsert(article: Article) {
  if (article.source !== 'import' && article.source !== 'edited') return
  if (cacheUpsertTimer) clearTimeout(cacheUpsertTimer)
  cacheUpsertTimer = setTimeout(() => {
    cacheUpsertTimer = null
    void upsertLocalMdCacheFromArticle(article)
  }, 400)
}

async function flushLocalMdCacheUpsert(article: Article | null | undefined) {
  if (!article) return
  if (article.source !== 'import' && article.source !== 'edited') return
  if (cacheUpsertTimer) {
    clearTimeout(cacheUpsertTimer)
    cacheUpsertTimer = null
  }
  await upsertLocalMdCacheFromArticle(article)
}

/** 从本地 MD 缓存按 docId 补齐 frontmatter / summary / cover */
async function hydrateArticleFromLocalCache<T extends Article>(article: T): Promise<T> {
  try {
    const docId = computeDocId({
      title: article.title,
      markdown: article.markdown,
      html: article.html || article.content,
    })
    const cached = await getLocalMdCacheByDocId(docId)
    if (!cached) return article
    const next: T = { ...article }
    if (!hasArticleMeta(next.frontmatter) && cached.frontmatter) {
      next.frontmatter = cached.frontmatter
    }
    if (!next.summary && (cached.summary || cached.frontmatter?.summary)) {
      next.summary = cached.summary || cached.frontmatter?.summary
    }
    if (!next.cover && (cached.cover || cached.frontmatter?.cover)) {
      next.cover = cached.cover || cached.frontmatter?.cover
    }
    return next
  } catch {
    return article
  }
}

interface SyncResult {
  platform: string
  platformName?: string
  success: boolean
  postUrl?: string
  draftOnly?: boolean
  error?: string
}

interface ImageProgress {
  platform: string
  current: number
  total: number
}

// 同步阶段类型
type SyncStage = 'starting' | 'uploading_images' | 'saving' | 'completed' | 'failed'

// 平台同步详细进度
interface PlatformProgress {
  platform: string
  platformName: string
  stage: SyncStage
  imageProgress?: { current: number; total: number }
  error?: string
}

interface SyncState {
  // 状态
  status: 'loading' | 'idle' | 'syncing' | 'completed'
  article: Article | null
  platforms: Platform[]
  selectedPlatforms: string[]
  results: SyncResult[]
  error: string | null

  // 当前同步任务ID（用于过滤消息）
  currentSyncId: string | null

  // 图片上传进度
  imageProgress: ImageProgress | null

  // 平台详细同步进度
  platformProgress: Map<string, PlatformProgress>

  // 同步历史
  history: SyncHistoryItem[]

  // 是否已恢复状态
  recovered: boolean

  // 频率限制警告
  rateLimitWarning: string | null

  // 文章提取失败提示（如需刷新页面）
  extractError: string | null

  /** 每平台本次同步实时参数（会话态） */
  platformParams: Record<string, PublishParams>
  /** 每次勾选递增，用于配置面板强制重挂载 / 忽略过期异步 */
  platformParamsEpoch: Record<string, number>

  // Actions
  loadPlatforms: () => Promise<void>
  loadArticle: (opts?: { force?: boolean }) => Promise<void>
  loadHistory: () => Promise<void>
  recoverSyncState: () => Promise<void>
  /** 从 storage 尽早恢复勾选，避免鉴权完成前显示 0 个平台 */
  hydrateSelectedPlatforms: () => Promise<void>
  /** 为已选平台补齐设置页保存的发布参数（含 mode），供行上标签与同步使用 */
  ensurePlatformPublishParams: (platformIds?: string[]) => Promise<void>
  togglePlatform: (platformId: string) => void
  selectAll: () => void
  deselectAll: () => void
  setPlatformParams: (platformId: string, params: PublishParams) => void
  checkRateLimit: () => Promise<string | null>
  startSync: () => Promise<void>
  retryFailed: () => Promise<void>
  reset: () => void
  updateProgress: (result: SyncResult) => void
  updateImageProgress: (progress: ImageProgress | null) => void
  updateDetailProgress: (progress: PlatformProgress) => void
  clearSyncState: () => Promise<void>
  updateArticle: (updates: Partial<Article>) => void
  /** 直接设置文章（用于本地导入，source='import' 时实时检测会跳过） */
  setArticle: (article: Article, source?: 'import' | 'edited' | 'extract') => void
  /** 清空文章并回到空主页选择态（Logo 回主页） */
  clearArticle: () => void
  continueSync: () => void
  clearRateLimitWarning: () => void
  clearExtractError: () => void
  dismissError: () => void
}

// 最大历史记录数
const MAX_HISTORY_ITEMS = 25

// Storage key for selected platforms
const SELECTED_PLATFORMS_KEY = 'selectedPlatforms'

// 保存选中的平台到 storage
async function saveSelectedPlatforms(platformIds: string[]) {
  try {
    await chrome.storage.local.set({ [SELECTED_PLATFORMS_KEY]: platformIds })
  } catch (e) {
    logger.error('Failed to save selected platforms:', e)
  }
}

// 从 storage 加载选中的平台
async function loadSelectedPlatforms(): Promise<string[] | null> {
  try {
    const result = await chrome.storage.local.get(SELECTED_PLATFORMS_KEY)
    return result[SELECTED_PLATFORMS_KEY] || null
  } catch (e) {
    logger.error('Failed to load selected platforms:', e)
    return null
  }
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: 'idle',
  article: null,
  platforms: [],
  selectedPlatforms: [],
  results: [],
  error: null,
  currentSyncId: null,
  imageProgress: null,
  platformProgress: new Map(),
  history: [],
  recovered: false,
  rateLimitWarning: null,
  extractError: null,
  platformParams: {},
  platformParamsEpoch: {},

  recoverSyncState: async () => {
    // 避免重复恢复
    if (get().recovered) return

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' })
      const syncState = response?.syncState

      if (syncState) {
        logger.debug('Recovering sync state:', syncState.status, syncState.syncId)

        const current = get().article
        const locked = current?.source === 'import' || current?.source === 'edited'

        // 本地无正文时从 syncState 补回（popup 点「草稿」关窗后重开常见）；
        // 已有 import/edited 锁定则不覆盖，避免冲掉用户导入稿。
        let restoreArticle =
          !current && syncState.article
            ? {
                ...syncState.article,
                // 恢复后锁定，避免主页实时检测用草稿页把正文冲掉
                source: 'edited' as const,
              }
            : undefined

        if (restoreArticle) {
          restoreArticle = await hydrateArticleFromLocalCache(restoreArticle as Article)
        }

        if (syncState.status === 'syncing' && !locked) {
          const article =
            (restoreArticle as Article | undefined) ??
            (syncState.article
              ? await hydrateArticleFromLocalCache({
                  ...syncState.article,
                  source: 'edited' as const,
                } as Article)
              : current)
          set({
            status: 'syncing',
            article,
            selectedPlatforms: syncState.selectedPlatforms,
            results: syncState.results || [],
            currentSyncId: syncState.syncId || null,
            recovered: true,
          })
          logger.debug('Sync in progress, listening for updates...')
        } else {
          const nextStatus =
            syncState.status === 'completed' || syncState.status === 'failed'
              ? 'completed'
              : get().status
          set({
            status: nextStatus,
            ...(restoreArticle ? { article: restoreArticle as Article } : {}),
            selectedPlatforms: syncState.selectedPlatforms?.length
              ? syncState.selectedPlatforms
              : get().selectedPlatforms,
            results: syncState.results?.length ? syncState.results : get().results,
            currentSyncId: syncState.syncId || null,
            recovered: true,
          })
        }
      } else {
        set({ recovered: true })
      }
    } catch (error) {
      logger.error('Failed to recover sync state:', error)
      set({ recovered: true })
    }
  },

  clearSyncState: async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_STATE' })
    } catch (error) {
      logger.error('Failed to clear sync state:', error)
    }
  },

  hydrateSelectedPlatforms: async () => {
    // recover 已写入勾选则不覆盖
    if (get().selectedPlatforms.length > 0) {
      void get().ensurePlatformPublishParams(get().selectedPlatforms)
      return
    }
    const saved = await loadSelectedPlatforms()
    if (saved?.length) {
      set({ selectedPlatforms: saved })
      void get().ensurePlatformPublishParams(saved)
    }
  },

  ensurePlatformPublishParams: async (platformIds) => {
    const ids = platformIds?.length ? platformIds : get().selectedPlatforms
    if (ids.length === 0) return
    const { article, platformParams, platformParamsEpoch } = get()
    const next = { ...platformParams }
    const nextEpoch = { ...platformParamsEpoch }
    let changed = false
    await Promise.all(
      ids.map(async (id) => {
        const cur = next[id]
        try {
          if (!cur || Object.keys(cur).length === 0) {
            // 尚无快照（如恢复勾选）：用当前 FM 建快照
            const saved = await getSavedParams(id).catch(() => undefined)
            next[id] = snapshotParamsOnSelect(article, id, saved)
            nextEpoch[id] = (nextEpoch[id] ?? 0) + 1
            changed = true
            return
          }
          if (hasExplicitMode(cur)) return
          // 仅补 mode 等非 FM 设置，绝不把 saved 旧 FM 字段盖回
          next[id] = await fillNonFmSettings(id, cur)
          changed = true
        } catch (e) {
          logger.warn('ensurePlatformPublishParams failed:', id, e)
        }
      }),
    )
    if (changed) set({ platformParams: next, platformParamsEpoch: nextEpoch })
  },

  updateArticle: (updates) => {
    const currentArticle = get().article
    if (currentArticle) {
      const merged: Article = {
        ...currentArticle,
        ...updates,
      }
      // frontmatter 整对象替换（表单会传完整对象；避免删掉的键被浅合并加回）
      if (updates.frontmatter !== undefined) {
        merged.frontmatter = updates.frontmatter
      }
      const next = normalizeArticleFields(merged)
      set({ article: next })
      scheduleLocalMdCacheUpsert(next)
    }
  },

  setArticle: (article, source) => {
    const nextSource = source ?? article.source
    const normalized = normalizeArticleFields({ ...article, source: nextSource })
    set({
      article: normalized,
      // 换文时清空平台参数，避免旧文配置污染
      platformParams: {},
      platformParamsEpoch: {},
      // 切换文章时清空上一次的同步结果/错误
      status: 'idle',
      results: [],
      error: null,
      extractError: null,
      platformProgress: new Map(),
      currentSyncId: null,
    })
    // 导入/编辑稿立刻落缓存，供历史追加同步恢复 frontmatter
    if (nextSource === 'import' || nextSource === 'edited') {
      void flushLocalMdCacheUpsert(normalized)
      chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_STATE' }).catch(() => {})
    }
  },

  clearArticle: () => {
    set({
      article: null,
      platformParams: {},
      platformParamsEpoch: {},
      status: 'idle',
      results: [],
      error: null,
      extractError: null,
      imageProgress: null,
      platformProgress: new Map(),
      currentSyncId: null,
    })
    chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_STATE' }).catch(() => {})
  },

  // 完成态回到选择态以追加更多平台：移除已成功平台（避免重复），保留 results 供「已同步」标记
  continueSync: () => {
    const { results, selectedPlatforms, article } = get()
    const successIds = new Set(results.filter(r => r.success).map(r => r.platform))
    const nextSelected = selectedPlatforms.filter(id => !successIds.has(id))
    // 锁定正文：回主页后实时检测/切到草稿页时不得覆盖当前同步稿
    const lockedArticle =
      article && article.source !== 'import' && article.source !== 'edited'
        ? { ...article, source: 'edited' as const }
        : article
    set({
      status: 'idle',
      article: lockedArticle,
      selectedPlatforms: nextSelected,
      error: null,
      platformProgress: new Map(),
      currentSyncId: null,
    })
    saveSelectedPlatforms(nextSelected)
    if (lockedArticle) {
      void flushLocalMdCacheUpsert(lockedArticle)
    }
    // 后台改为 cancelled，避免重开 UI 时 recover 再把 status 打回 completed
    chrome.runtime
      .sendMessage({ type: 'UPDATE_SYNC_STATUS', payload: { status: 'cancelled' } })
      .catch(() => {})
  },

  loadPlatforms: async () => {
    // 如果正在同步或已完成，不覆盖状态
    const currentStatus = get().status
    const preserveStatus = currentStatus === 'syncing' || currentStatus === 'completed'

    // 不再把 status 打成 loading：会禁用「同步」按钮，鉴权稍慢时表现为点击无反应
    try {
      // CHECK_ALL_AUTH 现在返回 DSL 和 CMS 合并的列表
      const platformResponse = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH' })

      // 只保留已认证的平台
      const allPlatforms: Platform[] = (platformResponse.platforms || [])
        .filter((p: any) => p.isAuthenticated)

      // 加载保存的平台选择
      const savedSelections = await loadSelectedPlatforms()
      const authenticatedIds = allPlatforms.map(p => p.id)

      // 过滤出仍然有效的已选平台（已登录的平台）
      let selectedPlatforms: string[] = []
      if (savedSelections && savedSelections.length > 0) {
        selectedPlatforms = savedSelections.filter(id => authenticatedIds.includes(id))
        // 鉴权列表暂空时保留已 hydrate / storage 勾选，避免 UI 闪成「0 个平台」
        if (selectedPlatforms.length === 0 && authenticatedIds.length === 0) {
          const current = get().selectedPlatforms
          selectedPlatforms = current.length > 0 ? current : savedSelections
        }
      }

      // 如果正在同步或已完成，只更新平台列表，不改变状态和选择
      if (preserveStatus) {
        set({ platforms: allPlatforms })
      } else {
        set({ platforms: allPlatforms, status: 'idle', selectedPlatforms })
        if (selectedPlatforms.length > 0) {
          void get().ensurePlatformPublishParams(selectedPlatforms)
        }
      }
    } catch (error) {
      logger.error('Failed to load platforms:', error)
      if (!preserveStatus) {
        set({ status: 'idle', error: (error as Error).message })
      }
    }
  },

  loadArticle: async (opts) => {
    const force = opts?.force === true
    const { article: existingArticle, status } = get()
    // 同步进行中：绝不换文（含手动 force）
    if (status === 'syncing') {
      logger.debug('loadArticle - skipped, syncing')
      return
    }
    // 自动检测：完成态不换文；手动 force 可在 idle/completed 下重检
    if (!force && status === 'completed') {
      logger.debug('loadArticle - skipped, completed (auto)')
      return
    }
    // 导入 / 已编辑文章锁定：非 force 时不覆盖
    if (!force && (existingArticle?.source === 'import' || existingArticle?.source === 'edited')) {
      logger.debug('loadArticle - skipped, article locked:', existingArticle.source)
      return
    }

    try {
      // 首先检查是否有从页面按钮点击传来的待同步文章
      const storage = await chrome.storage.local.get('pendingArticle')
      if (storage.pendingArticle) {
        logger.debug('loadArticle - found pending article:', storage.pendingArticle.title)
        set({ article: storage.pendingArticle, extractError: null })
        trackArticleProfile(storage.pendingArticle, 'popup')
        await chrome.storage.local.remove('pendingArticle')
        return
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      logger.debug('loadArticle - current tab:', tab?.url, tab?.status)
      if (!tab?.id) return
      const tabId = tab.id

      // URL 预检：非 http/https 页面（chrome://、扩展页、about: 等）不会注入 content script，
      // 直接给友好提示，避免 sendMessage 必然抛 "Receiving end does not exist"。
      const tabUrl = (tab.url || '').toLowerCase()
      if (!tabUrl.startsWith('http://') && !tabUrl.startsWith('https://')) {
        logger.debug('loadArticle - skip non-http(s) tab:', tabUrl)
        set({ extractError: '请在普通网页（http/https）上使用，当前页面不支持检测' })
        return
      }

      // content script 未就绪/未注入时 sendMessage 会抛异常——刷新后 status=complete
      // 也常早于脚本注入，故即使 complete 也做多次退避重试（避免必须重开侧栏）。
      const tryExtract = async (): Promise<{ article?: unknown } | undefined> => {
        try {
          return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_ARTICLE' })
        } catch (e) {
          logger.debug('extract article: no content script / not ready:', e)
          return undefined
        }
      }

      const retryDelaysMs = [0, 400, 800, 1200, 2000]
      let response: { article?: unknown } | undefined
      for (const delay of retryDelaysMs) {
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay))
        }
        // 用户已切走该标签则停止
        const still = await chrome.tabs.get(tabId).catch(() => null)
        if (!still) {
          return
        }
        response = await tryExtract()
        if (response !== undefined) break
      }

      if (response === undefined) {
        set({
          extractError: '页面检测脚本尚未就绪，请稍候再点「检测当前页」，或刷新后重试',
        })
        return
      }

      logger.debug('loadArticle - response:', response)
      if (response?.article) {
        const a = response.article as {
          title?: string
          html?: string
          content?: string
          markdown?: string
          cover?: string
          summary?: string
        }
        const normalized = {
          title: a.title || '',
          content: a.html || a.content || a.markdown || '',
          html: a.html,
          markdown: a.markdown,
          cover: a.cover,
          summary: a.summary,
          source: 'extract' as const,
        }
        set({ article: normalized, extractError: null })
        trackArticleProfile(normalized, 'popup')
      } else {
        set({ extractError: '未识别到文章，请刷新页面或换一篇文章页再试' })
      }
    } catch (error) {
      logger.error('Failed to extract article:', error)
      set({ extractError: '无法检测当前页，请刷新页面后重试' })
    }
  },

  loadHistory: async () => {
    try {
      const storage = await chrome.storage.local.get('syncHistory')
      set({ history: storage.syncHistory || [] })
    } catch (error) {
      logger.error('Failed to load history:', error)
    }
  },

  togglePlatform: (platformId: string) => {
    const { selectedPlatforms, platformParams, platformParamsEpoch, article } = get()
    const isSelected = selectedPlatforms.includes(platformId)
    const newSelected = isSelected
      ? selectedPlatforms.filter(id => id !== platformId)
      : [...selectedPlatforms, platformId]

    if (isSelected) {
      // 取消勾选：清掉该平台会话参数，下次勾选重新用最新 FM
      const { [platformId]: _removed, ...rest } = platformParams
      const { [platformId]: _e, ...restEpoch } = platformParamsEpoch
      set({
        selectedPlatforms: newSelected,
        platformParams: rest,
        platformParamsEpoch: restEpoch,
      })
      saveSelectedPlatforms(newSelected)
    } else {
      // 新勾选：先用当前 FM 打快照（同步），再异步补 mode
      const epoch = (platformParamsEpoch[platformId] ?? 0) + 1
      const seeded = snapshotParamsOnSelect(article, platformId)
      set({
        selectedPlatforms: newSelected,
        platformParams: { ...platformParams, [platformId]: seeded },
        platformParamsEpoch: { ...platformParamsEpoch, [platformId]: epoch },
      })
      saveSelectedPlatforms(newSelected)
      void (async () => {
        try {
          const saved = await getSavedParams(platformId)
          const state = get()
          // 仍勾选且仍是本次勾选世代，才写入（避免取消/再勾竞态用旧结果盖回）
          if (!state.selectedPlatforms.includes(platformId)) return
          if ((state.platformParamsEpoch[platformId] ?? 0) !== epoch) return
          const snap = snapshotParamsOnSelect(state.article, platformId, saved)
          get().setPlatformParams(platformId, snap)
        } catch (e) {
          logger.warn('togglePlatform snapshot failed:', platformId, e)
        }
      })()
    }

    // 追踪平台选择行为
    trackPlatformSelection(
      isSelected ? 'deselect' : 'select',
      platformId,
      newSelected.length
    ).catch(() => {})
  },

  selectAll: () => {
    const { platforms, platformParams, platformParamsEpoch, article } = get()
    const allIds = platforms.filter(p => p.isAuthenticated).map(p => p.id)
    // 仅给尚未有会话参数的平台打当前 FM 快照；已勾选的保持原快照
    const nextParams = { ...platformParams }
    const nextEpoch = { ...platformParamsEpoch }
    for (const id of allIds) {
      if (!nextParams[id]) {
        nextParams[id] = snapshotParamsOnSelect(article, id)
        nextEpoch[id] = (nextEpoch[id] ?? 0) + 1
      }
    }
    set({ selectedPlatforms: allIds, platformParams: nextParams, platformParamsEpoch: nextEpoch })
    // 保存到 storage
    saveSelectedPlatforms(allIds)
    void get().ensurePlatformPublishParams(allIds)
    // 追踪全选
    trackPlatformSelection('select_all', 'all', allIds.length).catch(() => {})
  },

  deselectAll: () => {
    set({ selectedPlatforms: [], platformParams: {}, platformParamsEpoch: {} })
    // 保存到 storage
    saveSelectedPlatforms([])
    // 追踪取消全选
    trackPlatformSelection('deselect_all', 'all', 0).catch(() => {})
  },

  setPlatformParams: (platformId, params) => {
    set((state) => ({
      platformParams: { ...state.platformParams, [platformId]: params },
    }))
  },

  checkRateLimit: async () => {
    const { selectedPlatforms } = get()
    return checkSyncFrequency(selectedPlatforms)
  },

  startSync: async () => {
    const { article, selectedPlatforms, platforms } = get()
    logger.debug('startSync called', { article, selectedPlatforms })

    if (!article) {
      set({ error: '未检测到文章内容' })
      return
    }

    if (selectedPlatforms.length === 0) {
      set({ error: '请选择要同步的平台' })
      return
    }

    // 追踪漏斗：开始同步
    trackFunnel('sync_started', 'popup', { platform_count: selectedPlatforms.length }).catch(() => {})

    // 同步前落盘缓存（含已改 frontmatter），供历史追加恢复
    await flushLocalMdCacheUpsert(article)

    // 补齐设置页已存的 mode/参数，避免未展开折叠时仍按草稿同步/显示
    await get().ensurePlatformPublishParams(selectedPlatforms)

    // 生成 syncId（在发送消息前设置，以便立即过滤消息）
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    set({ status: 'syncing', results: [], error: null, imageProgress: null, platformProgress: new Map(), currentSyncId: syncId })

    try {
      // 只传原文；内嵌图/格式转换由 background 中间层按平台写入 platformContents，不改 UI 源文
      // 超阈值时正文走 storage，避免 sendMessage 64MiB 硬限
      const html = article.html || article.content || ''
      const markdown = article.markdown || ''
      const original = {
        title: article.title,
        content: html,
        html,
        markdown,
        cover: article.cover,
        summary: article.summary,
        tags: article.frontmatter?.tags,
        category: article.frontmatter?.category,
        frontmatter: article.frontmatter,
        source: article.source,
      }
      const perPlatform: Record<string, PublishParams> = {}
      const platformParamsReady = get().platformParams
      for (const id of selectedPlatforms) {
        if (platformParamsReady[id]) {
          perPlatform[id] = platformParamsReady[id]
        } else {
          const seeded = seedParamsFromArticle(article, id)
          if (Object.keys(seeded).length > 0) perPlatform[id] = seeded
        }
      }
      const response = await dispatchSyncArticleMessage({
        article: original,
        platforms: selectedPlatforms,
        syncId,
        perPlatform: Object.keys(perPlatform).length > 0 ? perPlatform : undefined,
      })

      const allResults: SyncResult[] = response.results || []
      const rateLimitWarning: string | null = response.rateLimitWarning || null

      // 为结果添加平台名称（如果 background 没有添加）
      const resultsWithNames = allResults.map((r: SyncResult) => ({
        ...r,
        platformName: r.platformName || platforms.find(p => p.id === r.platform)?.name || r.platform,
      }))

      // 历史记录由 background 保存，这里只刷新显示
      const storage = await chrome.storage.local.get('syncHistory')
      const newHistory: SyncHistoryItem[] = storage.syncHistory || []

      set({
        status: 'completed',
        results: resultsWithNames,
        history: newHistory,
        imageProgress: null,
        rateLimitWarning,
      })

      // 追踪流失预警：多次失败
      const failedCount = resultsWithNames.filter((r: SyncResult) => !r.success).length
      if (failedCount >= 3) {
        trackChurnSignal('multiple_failures', {
          failed_count: failedCount,
          total_count: resultsWithNames.length,
        }).catch(() => {})
      }
    } catch (error) {
      // 通道断开时后台可能仍在同步：保持 syncing，避免 UI 被误打回主页
      try {
        const stateResp = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' })
        if (stateResp?.syncState?.status === 'syncing') {
          logger.warn('startSync message failed but sync still running, keep syncing UI:', error)
          set({
            status: 'syncing',
            error: null,
            imageProgress: null,
          })
          return
        }
      } catch {
        // ignore
      }
      set({
        error: (error as Error).message,
        status: 'idle',
        imageProgress: null,
        currentSyncId: null,
      })
      // 追踪隐式反馈：同步出错后放弃
      trackImplicitFeedback('abandon_after_error', {
        error: (error as Error).message,
      }).catch(() => {})
    }
  },

  retryFailed: async () => {
    const { article, results, platforms } = get()

    if (!article) {
      set({ error: '未检测到文章内容' })
      return
    }

    // 获取失败的平台
    const failedPlatformIds = results.filter(r => !r.success).map(r => r.platform)

    if (failedPlatformIds.length === 0) {
      return
    }

    // 保留成功的结果
    const successResults = results.filter(r => r.success)

    // 追踪重试行为
    trackRetry('popup', failedPlatformIds, 2, failedPlatformIds.length).catch(() => {})

    // 生成新的 syncId
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    await flushLocalMdCacheUpsert(article)

    await get().ensurePlatformPublishParams(failedPlatformIds)
    const platformParamsReady = get().platformParams

    set({ status: 'syncing', results: successResults, error: null, imageProgress: null, platformProgress: new Map(), currentSyncId: syncId })

    try {
      // SYNC_ARTICLE 现在同时处理 DSL 和 CMS 平台
      // 不再 skipHistory：新历史模型按文档归档，retry 会 upsert+merge 到同一条
      const html = article.html || article.content || ''
      const original = {
        title: article.title,
        content: html,
        html,
        markdown: article.markdown || '',
        cover: article.cover,
        summary: article.summary,
        tags: article.frontmatter?.tags,
        category: article.frontmatter?.category,
        frontmatter: article.frontmatter,
        source: article.source,
      }
      const perPlatform: Record<string, PublishParams> = {}
      for (const id of failedPlatformIds) {
        if (platformParamsReady[id]) {
          perPlatform[id] = platformParamsReady[id]
        } else {
          const seeded = seedParamsFromArticle(article, id)
          if (Object.keys(seeded).length > 0) perPlatform[id] = seeded
        }
      }
      const response = await dispatchSyncArticleMessage({
        article: original,
        platforms: failedPlatformIds,
        syncId,
        perPlatform: Object.keys(perPlatform).length > 0 ? perPlatform : undefined,
      })

      const retryResults: SyncResult[] = response.results || []

      // 为结果添加平台名称（如果 background 没有添加）
      const retryResultsWithNames = retryResults.map((r: SyncResult) => ({
        ...r,
        platformName: r.platformName || platforms.find(p => p.id === r.platform)?.name || r.platform,
      }))

      const allResults = [...successResults, ...retryResultsWithNames]

      // 历史由 background 的 mergeHistoryItem 统一归档，这里只刷新显示
      const storage = await chrome.storage.local.get('syncHistory')
      set({ history: (storage.syncHistory as SyncHistoryItem[]) || [] })

      set({
        status: 'completed',
        results: allResults,
        imageProgress: null,
      })
    } catch (error) {
      set({
        error: (error as Error).message,
        status: 'completed',
        imageProgress: null,
      })
    }
  },

  reset: () => {
    set({
      status: 'idle',
      results: [],
      error: null,
      imageProgress: null,
      platformProgress: new Map(),
      currentSyncId: null,
    })
    // 清除持久化的同步状态
    chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_STATE' }).catch(() => {})
  },

  updateProgress: (result: SyncResult) => {
    set(state => {
      const newResults = [...state.results, result]
      // Auto-transition to completed when all platforms are done.
      // This handles the case where popup was closed during sync and
      // reopened — the startSync response handler won't fire, so we
      // detect completion here from individual SYNC_PROGRESS messages.
      const isComplete = state.status === 'syncing' &&
        newResults.length >= state.selectedPlatforms.length
      return {
        results: newResults,
        ...(isComplete ? { status: 'completed' as const, imageProgress: null } : {}),
      }
    })
  },

  updateImageProgress: (progress: ImageProgress | null) => {
    set({ imageProgress: progress })
  },

  updateDetailProgress: (progress: PlatformProgress) => {
    set(state => {
      const newMap = new Map(state.platformProgress)
      newMap.set(progress.platform, progress)
      return { platformProgress: newMap }
    })
  },

  // 追踪草稿链接点击
  onDraftClick: (platform: string) => {
    trackDraftClick(platform).catch(() => {})
  },

  // 追踪立即重试（隐式反馈）
  onImmediateRetry: () => {
    trackImplicitFeedback('immediate_retry').catch(() => {})
  },

  // 清除频率限制警告
  clearRateLimitWarning: () => {
    set({ rateLimitWarning: null })
  },

  clearExtractError: () => {
    set({ extractError: null })
  },

  dismissError: () => {
    set({ error: null })
  },
}))

/**
 * 超阈值时正文写入 storage，消息只带 fromStorage；否则单份 article 内联（不重复 uiArticle）
 */
async function dispatchSyncArticleMessage(opts: {
  article: Record<string, unknown>
  platforms: string[]
  syncId: string
  perPlatform?: Record<string, PublishParams>
}): Promise<{ results?: SyncResult[]; rateLimitWarning?: string | null }> {
  const probe = {
    article: opts.article,
    platforms: opts.platforms,
    syncId: opts.syncId,
    perPlatform: opts.perPlatform,
  }
  if (await shouldUseStorageForPayload(probe)) {
    await chrome.storage.local.set({
      [PENDING_SYNC_ARTICLE_KEY]: {
        syncId: opts.syncId,
        article: opts.article,
        ts: Date.now(),
      },
    })
    return chrome.runtime.sendMessage({
      type: 'SYNC_ARTICLE',
      payload: {
        fromStorage: true,
        platforms: opts.platforms,
        syncId: opts.syncId,
        perPlatform: opts.perPlatform,
      },
    })
  }
  return chrome.runtime.sendMessage({
    type: 'SYNC_ARTICLE',
    payload: {
      article: opts.article,
      platforms: opts.platforms,
      syncId: opts.syncId,
      perPlatform: opts.perPlatform,
    },
  })
}

/** 整页编辑关闭后回写侧栏（runtime / storage 共用） */
function applyEditedArticle(a: {
  title?: string
  content?: string
  html?: string
  markdown?: string
  cover?: string
  summary?: string
  frontmatter?: ArticleMeta
}) {
  const state = useSyncStore.getState()
  const incomingFm = a.frontmatter
  // 禁止用空 {} 擦掉侧栏已有 frontmatter（整页编辑未透传 FM 时常见）
  const keepExistingFm =
    incomingFm !== undefined &&
    !hasArticleMeta(incomingFm) &&
    hasArticleMeta(state.article?.frontmatter)

  const payload: Partial<Article> & { title: string; content: string; source: 'edited' } = {
    title: a.title || '',
    content: a.content || a.html || a.markdown || '',
    html: a.html || a.content,
    markdown: a.markdown,
    cover: a.cover,
    summary: a.summary,
    source: 'edited' as const,
  }
  if (incomingFm !== undefined && !keepExistingFm) {
    payload.frontmatter = incomingFm
  } else if (keepExistingFm && state.article?.frontmatter) {
    payload.frontmatter = state.article.frontmatter
    if (!payload.cover) payload.cover = state.article.cover ?? state.article.frontmatter.cover
    if (!payload.summary) payload.summary = state.article.summary ?? state.article.frontmatter.summary
  }
  // 已有文章时就地更新，避免 setArticle 清空 platformParams
  if (state.article) {
    state.updateArticle(payload)
  } else {
    state.setArticle(
      {
        title: payload.title,
        content: payload.content,
        html: payload.html,
        markdown: payload.markdown,
        cover: payload.cover,
        summary: payload.summary,
        frontmatter: payload.frontmatter,
        source: 'edited',
      },
      'edited',
    )
  }
  chrome.storage.local.remove('pendingEditedArticle').catch(() => {})
}

// 启动时补读一次（关编辑时侧栏若未收到 runtime 消息）
chrome.storage.local.get('pendingEditedArticle').then((r) => {
  if (r.pendingEditedArticle) {
    applyEditedArticle(r.pendingEditedArticle)
  }
}).catch(() => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pendingEditedArticle?.newValue) return
  applyEditedArticle(changes.pendingEditedArticle.newValue)
})

// 监听来自 background 的进度消息
chrome.runtime.onMessage.addListener((message) => {
  // 获取当前 syncId，只处理匹配的消息
  const { currentSyncId } = useSyncStore.getState()

  // 如果消息带有 syncId，需要匹配当前的 syncId
  if (message.syncId && currentSyncId && message.syncId !== currentSyncId) {
    logger.debug('Ignoring message with different syncId:', message.syncId, 'current:', currentSyncId)
    return
  }

  if (message.type === 'SYNC_PROGRESS') {
    const result = message.payload?.result
    if (result) {
      useSyncStore.getState().updateProgress(result)
    }
  }
  if (message.type === 'IMAGE_PROGRESS') {
    if (message.payload) {
      useSyncStore.getState().updateImageProgress(message.payload)
    }
  }
  if (message.type === 'SYNC_DETAIL_PROGRESS') {
    const progress = message.payload
    if (progress?.platform) {
      useSyncStore.getState().updateDetailProgress(progress)
    }
  }
  if (message.type === 'EDITOR_ARTICLE_SAVED' && message.article) {
    applyEditedArticle(message.article)
  }
})
