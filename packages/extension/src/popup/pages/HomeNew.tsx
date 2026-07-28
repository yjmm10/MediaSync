import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Plus, Clock, X, Download, Info, PanelRight, FolderOpen, Eye, Loader2, Radar, RefreshCw } from 'lucide-react'
import { useSyncStore } from '../stores/sync'
import { SyncDialog } from '@/components/sync-dialog'
import type { Platform as DialogPlatform } from '@/components/sync-dialog'
import { cn } from '@/lib/utils'
import { trackPageView } from '../../lib/analytics'
import { createLogger } from '../../lib/logger'
import { getCachedUpdateInfo, dismissUpdate, type UpdateCheckResult } from '../../lib/version-check'
import { markdownToHtml } from '@mediasync/core'

const logger = createLogger('HomeNew')

/** 把文章渲染为 HTML：优先 html 字段；content 含标签视作 html；否则当 markdown 转换 */
function articleToHtml(article: { html?: string; content?: string; markdown?: string }): string {
  if (article.html) return article.html
  const content = article.content || ''
  if (/<[a-z][\s\S]*>/i.test(content)) return content
  return markdownToHtml(article.markdown || content)
}

export function HomeNew() {
  const navigate = useNavigate()
  const {
    status,
    article,
    platforms,
    selectedPlatforms,
    results,
    error,

    platformProgress,
    extractError,
    recovered,
    loadPlatforms,
    loadArticle,
    recoverSyncState,
    hydrateSelectedPlatforms,
    togglePlatform,
    selectAll,
    deselectAll,
    startSync,
    retryFailed,
    reset,
    checkRateLimit,
    clearExtractError,
    clearArticle,
  } = useSyncStore()

  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [allPlatforms, setAllPlatforms] = useState<DialogPlatform[]>([])

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [floatingEnabled, setFloatingEnabled] = useState(false)
  const [isFirstSync, setIsFirstSync] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewTab, setPreviewTab] = useState<'render' | 'markdown'>('render')
  /** 设置总开关：关闭时有效实时检测必关 */
  const [realtimeDetectSetting, setRealtimeDetectSetting] = useState(true)
  /** 顶栏会话态：仅在设置开启时才可能为开 */
  const [realtimeActive, setRealtimeActive] = useState(true)
  const [detecting, setDetecting] = useState(false)
  /** 有效实时检测 = 设置开 ∧ 顶栏开 */
  const realtimeEffective = realtimeDetectSetting && realtimeActive

  // Load data
  useEffect(() => {
    const init = async () => {
      await recoverSyncState()
      // 先恢复勾选，避免等鉴权（美篇/小红书）期间显示 0 个平台
      await hydrateSelectedPlatforms()
      // Render from cache first, then refresh
      try {
        const cached = await chrome.storage.local.get('platformListCache')
        if (cached.platformListCache?.length) {
          setAllPlatforms(cached.platformListCache.map((p: any) => ({
            id: p.id, name: p.name, icon: p.icon,
            isAuthenticated: p.isAuthenticated, username: p.username,
            homepage: p.homepage,
          })))
        }
      } catch {}
      loadAllPlatforms()
      // 实时关时不自动抽文；有文章或实时开时再 load（手动检测另入口）
      const rt = (await chrome.storage.local.get('realtimeDetect')).realtimeDetect ?? true
      if (rt) {
        loadArticle().catch(() => {})
      }
      chrome.storage.local.get(['floatingButtonEnabled', 'syncHistory'], (r) => {
        setFloatingEnabled(r.floatingButtonEnabled ?? false)
        setIsFirstSync(!r.syncHistory || r.syncHistory.length === 0)
      })
      // 第一次打开插件：自动打开宣传页（仅一次）
      chrome.storage.local.get('promoOpenedOnFirstUse').then(async (r) => {
        if (r.promoOpenedOnFirstUse) return
        await chrome.storage.local.set({ promoOpenedOnFirstUse: true })
        chrome.tabs.create({
          url: 'https://yjmm10.github.io/MediaSync/promo.html?utm_source=extension&utm_medium=first_open',
          active: true,
        }).catch(() => {})
      }).catch(() => {})
      const cached = await getCachedUpdateInfo()
      if (cached?.hasUpdate && cached.info) {
        setUpdateInfo(cached)
      }
    }
    init()
    // 侧边栏由 popup 触发打开时，通过 pendingRoute 指定落地路由
    chrome.storage.local.get('pendingRoute').then((r) => {
      if (r.pendingRoute) {
        navigate(r.pendingRoute as string)
        chrome.storage.local.remove('pendingRoute').catch(() => {})
      }
    }).catch(() => {})

    // 设置总开关 + 顶栏会话态：设置关则顶栏必关
    chrome.storage.local.get('realtimeDetect').then((r) => {
      const setting = r.realtimeDetect ?? true
      setRealtimeDetectSetting(setting)
      setRealtimeActive(setting)
    }).catch(() => {})

    trackPageView('home').catch(() => {})
  }, [])

  // 设置页改动时立即同步门闩（首页仍打开时也能关掉切页检测）
  useEffect(() => {
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area !== 'local' || !changes.realtimeDetect) return
      const enabled = !!(changes.realtimeDetect.newValue ?? true)
      setRealtimeDetectSetting(enabled)
      if (!enabled) {
        setRealtimeActive(false)
      } else {
        const src = useSyncStore.getState().article?.source
        if (src !== 'import' && src !== 'edited') {
          setRealtimeActive(true)
        }
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  // 导入 / 编辑锁定时：顶栏当前态自动关闭（不改全局设置）
  useEffect(() => {
    const src = article?.source
    if (src === 'import' || src === 'edited') {
      setRealtimeActive(false)
    }
  }, [article?.source])

  // 实时文章检测：设置总开关 ∧ 顶栏会话态；锁定文章不覆盖
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const trigger = () => {
      const state = useSyncStore.getState()
      // 自动切页检测：同步中/完成态不换文；实时关不检测
      if (state.status === 'syncing' || state.status === 'completed') return
      const src = state.article?.source
      if (src === 'import' || src === 'edited') return
      if (!realtimeDetectSetting || !realtimeActive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const state2 = useSyncStore.getState()
        if (state2.status === 'syncing' || state2.status === 'completed') return
        const src2 = state2.article?.source
        if (src2 === 'import' || src2 === 'edited') return
        if (!realtimeDetectSetting || !realtimeActive) return
        loadArticle().catch(() => {})
      }, 500)
    }
    const onActivated = () => trigger()
    const onUpdated = async (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      // 刷新过程中 url/status 会变；complete 时再检（loadArticle 内部会等 CS 就绪）
      if (info.status !== 'complete') return
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (active?.id === tabId) trigger()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      if (timer) clearTimeout(timer)
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [loadArticle, realtimeDetectSetting, realtimeActive])

  const loadAllPlatforms = async () => {
    try {
      // 打开 UI 可刷新 cookie 平台；美篇/小红书等 PAGE_CONTEXT 平台不会因 forceRefresh 开标签真检
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh: true } })
      const mapped: DialogPlatform[] = (response.platforms || []).map((p: any) => ({
        id: p.id, name: p.name, icon: p.icon,
        isAuthenticated: p.isAuthenticated, username: p.username,
        homepage: p.homepage,
      }))
      setAllPlatforms(mapped)
      await loadPlatforms()
    } catch (error) {
      logger.error('Failed to load platforms:', error)
    }
  }

  const showOverlayToast = (msg: string) => {
    setRateLimitWarning(msg)
    setTimeout(() => setRateLimitWarning(null), 8000)
  }

  /** 手动检测单个平台登录状态（强制实时 checkAuth） */
  const handleRecheckAuth = async (platformId: string) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_AUTH',
        payload: { platformId },
      })
      if (chrome.runtime.lastError) {
        throw new Error(chrome.runtime.lastError.message)
      }
      if (response?.error) {
        throw new Error(String(response.error))
      }
      const auth = response?.auth
      if (!auth) {
        logger.error('CHECK_AUTH empty response', platformId, response)
        return
      }
      logger.debug('recheck auth result', platformId, auth)
      setAllPlatforms(prev =>
        prev.map(p =>
          p.id === platformId
            ? {
                ...p,
                isAuthenticated: !!auth.isAuthenticated,
                username: auth.username,
              }
            : p
        )
      )
      // 登录态变化后刷新 store 中的可选平台
      await loadPlatforms()
      if (!auth.isAuthenticated) {
        const name = allPlatforms.find(p => p.id === platformId)?.name || platformId
        showOverlayToast(`${name} 仍未登录，可点「去登录」后重试检测`)
      }
    } catch (error) {
      logger.error('Failed to recheck auth:', platformId, error)
      showOverlayToast(`检测失败：${(error as Error).message || '未知错误'}`)
    }
  }

  // 整页编辑/预览 overlay：正文走 storage，消息只传轻量元数据；不新开标签页
  const openOverlay = async (mode: 'edit' | 'preview') => {
    if (!article) return
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) {
      showOverlayToast('无法获取当前标签页')
      return
    }
    const url = tab.url || ''
    if (!/^https?:/i.test(url)) {
      showOverlayToast('请在普通网页上使用整页编辑/预览')
      return
    }
    try {
      await chrome.storage.local.set({
        pendingEditorOpen: {
          mode,
          article: {
            title: article.title,
            html: articleToHtml(article),
            markdown: article.markdown || '',
            cover: article.cover,
            source: { url, platform: '' },
          },
          ts: Date.now(),
        },
      })
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'OPEN_EDITOR',
        mode,
        fromStorage: true,
        platforms: mode === 'edit' ? allPlatforms : [],
        selectedPlatforms: mode === 'edit' ? selectedPlatforms : [],
      })
      if (!response?.success) {
        showOverlayToast(response?.error || '无法打开整页，请刷新当前网页后重试')
        return
      }
      if (mode === 'edit' || mode === 'preview') {
        // 打开即视为可能改稿；关闭时 storage 会回写正文并标 edited
        useSyncStore.getState().updateArticle({ source: 'edited' })
      }
      if (!document.body.classList.contains('side-panel')) {
        window.close()
      }
    } catch (e) {
      // content script 未就绪/未注入（预期情况），降为 debug
      logger.debug('Failed to open overlay:', e)
      showOverlayToast('无法打开整页，请刷新当前网页后重试')
    }
  }

  const handleEditArticle = () => openOverlay('edit')

  // 在浏览器侧边栏打开（常驻显示，不因点击外部而关闭）
  const handleOpenSidePanel = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId })
      }
    } catch (e) {
      logger.error('Failed to open side panel:', e)
    }
    window.close()
  }

  // 导入本地 Markdown：
  // - 侧边栏中：直接进入 /import（侧边栏不会因文件选择器失焦关闭）
  // - popup 中：打开侧边栏并带 pendingRoute 标记，让侧边栏落地后导航到 /import
  const handleImportMarkdown = async () => {
    if (document.body.classList.contains('side-panel')) {
      navigate('/import')
      return
    }
    try {
      await chrome.storage.local.set({ pendingRoute: '/import' })
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId })
      }
    } catch (e) {
      logger.error('Failed to open import in side panel:', e)
    }
    window.close()
  }

  // 同步完成后追加平台：原地回到选择态（已成功平台自动排除但可重选）
  const handleContinueSync = () => {
    useSyncStore.getState().continueSync()
  }

  const handleOpenFullPreview = () => openOverlay('preview')

  /**
   * Logo：清空文章回到空主页；关闭实时会话态，避免立刻再抽文。
   * 不自动检测；同步中不打断。
   */
  const handleLogoHome = () => {
    navigate('/')
    if (status === 'syncing') return
    setRealtimeActive(false)
    clearArticle()
  }

  const handleForceDetect = async () => {
    if (status === 'syncing') return
    // 手动重检不依赖实时开关；实时开时顺带打开会话态
    if (realtimeDetectSetting) setRealtimeActive(true)
    // 完成态手动重检：清掉 sticky syncId，避免进度消息干扰
    if (status === 'completed' || useSyncStore.getState().currentSyncId) {
      useSyncStore.setState({ status: 'idle', currentSyncId: null, results: [] })
    }
    setDetecting(true)
    try {
      await loadArticle({ force: true })
    } catch {
      // loadArticle 内部已处理错误提示
    } finally {
      setDetecting(false)
    }
  }

  const handleToggleRealtime = () => {
    if (!realtimeDetectSetting) return
    setRealtimeActive((v) => !v)
  }

  // Start sync with rate-limit check
  const handleStartSync = async () => {
    const warning = await checkRateLimit()
    if (warning) {
      setRateLimitWarning(warning)
      setTimeout(() => setRateLimitWarning(null), 8000)
    }
    startSync()
  }

  const successCount = results.filter(r => r.success).length

  const realtimeLabel = realtimeEffective ? '实时检测开启' : '实时检测关闭'
  let statusLine: string
  let statusTone: 'normal' | 'warn' | 'busy' = 'normal'
  if (detecting) {
    statusLine = '正在检测当前页…'
    statusTone = 'busy'
  } else if (extractError) {
    statusLine = extractError
    statusTone = 'warn'
  } else if (!article) {
    statusLine = !realtimeDetectSetting
      ? '未检测到文章 · 实时已关，请点「检测当前页」'
      : `未检测到文章 · ${realtimeLabel}`
  } else if (article.source === 'import') {
    statusLine = '本地导入 · 实时检测已暂停'
  } else if (article.source === 'edited') {
    statusLine = '已编辑 · 实时检测已暂停'
  } else {
    statusLine = `网页检测 · ${realtimeLabel}`
  }

  return (
    <div className="page-root flex flex-col h-[500px]">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleLogoHome}
            className="flex items-center gap-2 rounded-lg hover:opacity-80 transition-opacity"
            title="返回空主页（清空当前文章）"
          >
            <img src="/assets/icon-48.png" alt="Logo" className="w-6 h-6" />
            <h1 className="font-semibold">同步派</h1>
          </button>
          {/* 顶栏：会话态；设置总开关关闭时不可打开 */}
          <button
            type="button"
            onClick={handleToggleRealtime}
            disabled={!realtimeDetectSetting}
            title={
              !realtimeDetectSetting
                ? '实时检测已在设置中关闭，请先到设置里开启'
                : realtimeEffective
                  ? '当前实时检测：开（点击关闭本会话；总开关在设置）'
                  : '当前实时检测：关（点击开启本会话；总开关在设置）'
            }
            className={cn(
              'ml-1 p-1 rounded-full transition-colors',
              realtimeEffective ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              !realtimeDetectSetting && 'opacity-50 cursor-not-allowed'
            )}
          >
            <Radar className="w-3.5 h-3.5" />
          </button>
        </div>
        <nav className="flex items-center gap-0.5">
          <button
            onClick={handleOpenSidePanel}
            title="固定到侧边栏（常驻不消失）"
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <PanelRight className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">侧栏</span>
          </button>
          <button
            onClick={handleImportMarkdown}
            title="导入本地 Markdown 文件"
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">导入</span>
          </button>
          <button
            onClick={() => navigate('/add-cms')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">添加</span>
          </button>
          <button
            onClick={() => navigate('/history')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">历史</span>
          </button>
          <button
            onClick={() => navigate('/about')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Info className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">关于</span>
          </button>
          <button
            onClick={() => navigate('/settings')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">设置</span>
          </button>
        </nav>
      </header>

      {/* 状态栏：指示来源 / 实时检测 / 错误 */}
      <div
        className={cn(
          'flex-shrink-0 flex items-center gap-1.5 px-3 py-1 border-b text-[11px] leading-4',
          statusTone === 'warn' && 'bg-amber-50 text-amber-800 border-amber-200/80',
          statusTone === 'busy' && 'bg-blue-50 text-blue-700 border-blue-200/80',
          statusTone === 'normal' && 'bg-muted/40 text-muted-foreground',
        )}
      >
        {statusTone === 'busy' && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
        <span className="truncate flex-1 min-w-0" title={statusLine}>{statusLine}</span>
        {extractError && (
          <button
            type="button"
            onClick={() => clearExtractError()}
            className="flex-shrink-0 p-0.5 rounded hover:bg-black/5"
            title="关闭提示"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Version update banner */}
      {updateInfo?.hasUpdate && updateInfo.info && (
        <div className="px-4 pt-3">
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 text-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <Download className="w-4 h-4" />
                <span>新版本 v{updateInfo.info.version} 可用</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={updateInfo.info.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  下载
                </a>
                <button
                  onClick={async () => {
                    if (updateInfo.info) {
                      await dismissUpdate(updateInfo.info.version)
                      chrome.runtime.sendMessage({ type: 'CLEAR_UPDATE_BADGE' }).catch(() => {})
                      setUpdateInfo(null)
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  title="忽略此版本"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {updateInfo.info.releaseNotes && (
              <p className="text-xs text-muted-foreground mt-1">{updateInfo.info.releaseNotes}</p>
            )}
          </div>
        </div>
      )}

      {/* 文章操作入口：手动检测始终可见（不依赖实时开关 / 是否已有文章） */}
      <div className="px-4 py-1 flex items-center justify-between">
        <button
          type="button"
          onClick={handleForceDetect}
          disabled={detecting || status === 'syncing'}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          title={
            status === 'syncing'
              ? '同步进行中，无法检测'
              : '检测当前浏览器标签页的文章（不依赖实时检测开关）'
          }
        >
          <RefreshCw className={cn('w-3.5 h-3.5', detecting && 'animate-spin')} />
          {detecting ? '检测中…' : '检测当前页'}
        </button>
        {article ? (
          <button
            type="button"
            onClick={() => setShowPreview(true)}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Eye className="w-3.5 h-3.5" />
            预览内容
          </button>
        ) : (
          <span />
        )}
      </div>

      {/* SyncDialog — the unified sync flow */}
      <SyncDialog
        article={article}
        platforms={allPlatforms}
        status={status}
        selectedPlatforms={selectedPlatforms}
        results={results}
        platformProgress={platformProgress}
        error={error}
        onTogglePlatform={togglePlatform}
        onSelectAll={selectAll}
        onDeselectAll={deselectAll}
        onRecheckAuth={handleRecheckAuth}
        onStartSync={handleStartSync}
        onRetryFailed={retryFailed}
        onReset={reset}
        onCancel={reset}
        onEditArticle={handleEditArticle}
        onContinueSync={handleContinueSync}
        className="flex-1 min-h-0"
      />

      {/* 内容预览浮层 */}
      {showPreview && article && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3"
          onClick={() => setShowPreview(false)}
        >
          <div
            className="bg-card rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <div className="flex gap-1">
                <button
                  onClick={() => setPreviewTab('render')}
                  className={`px-2.5 py-1 text-xs rounded ${previewTab === 'render' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  渲染
                </button>
                <button
                  onClick={() => setPreviewTab('markdown')}
                  className={`px-2.5 py-1 text-xs rounded ${previewTab === 'markdown' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  源码
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleOpenFullPreview}
                  title="在当前网页上整页预览（关闭后回到原页）"
                  className="flex items-center gap-0.5 px-2 py-1 text-xs text-primary hover:bg-muted rounded"
                >
                  整页
                </button>
                <button onClick={() => setShowPreview(false)} title="关闭" className="p-1 rounded hover:bg-muted">
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {previewTab === 'render' ? (
                <div className="preview-article p-4" dangerouslySetInnerHTML={{ __html: articleToHtml(article) }} />
              ) : (
                <pre className="p-3 text-[11px] whitespace-pre-wrap break-all font-mono text-muted-foreground">
                  {article.markdown || article.content || ''}
                </pre>
              )}
            </div>
          </div>
          <style>{`
            .preview-article { font-size: 13px; line-height: 1.7; color: #333; word-break: break-word; }
            .preview-article p { margin: 0.8em 0; }
            .preview-article h1, .preview-article h2, .preview-article h3 { margin: 1em 0 0.5em; font-weight: 600; }
            .preview-article img { max-width: 100%; height: auto; margin: 1em 0; }
            .preview-article pre { background: #f5f5f5; padding: 0.8em; border-radius: 6px; overflow-x: auto; font-size: 11px; }
            .preview-article code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; }
            .preview-article pre code { background: none; padding: 0; }
            .preview-article blockquote { border-left: 3px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
            .preview-article ul, .preview-article ol { padding-left: 1.5em; margin: 1em 0; }
            .preview-article a { color: #2563eb; }
            .preview-article table { border-collapse: collapse; width: 100%; margin: 1em 0; }
            .preview-article th, .preview-article td { border: 1px solid #ddd; padding: 6px 10px; }
          `}</style>
        </div>
      )}

      {/* First sync success hint */}
      {status === 'completed' && isFirstSync && successCount > 0 && (
        <div className="px-4 pb-3">
          <div className="bg-green-50 dark:bg-green-950/20 rounded-lg p-2.5 space-y-1.5">
            <p className="text-xs font-medium text-green-700 dark:text-green-400">
              首次同步成功！以后同步更方便：
            </p>
            {!floatingEnabled && (
              <button
                onClick={() => {
                  chrome.storage.local.set({ floatingButtonEnabled: true })
                  setFloatingEnabled(true)
                }}
                className="text-xs text-primary hover:underline block"
              >
                开启悬浮按钮 — 在任意文章页一键同步
              </button>
            )}
            <p className="text-xs text-green-600 dark:text-green-500">
              下次在文章页点击扩展图标即可快速同步
            </p>
          </div>
        </div>
      )}

      {/* Rate-limit toast（非 extract 错误；错误已在状态栏） */}
      {rateLimitWarning && (
        <div className="fixed top-12 left-3 right-3 z-40 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="bg-yellow-50 dark:bg-yellow-950/50 border border-yellow-200 dark:border-yellow-800 rounded-md px-2.5 py-1.5 shadow flex items-start gap-1.5">
            <span className="text-xs flex-shrink-0 leading-5">⚠️</span>
            <p className="text-[11px] leading-5 text-yellow-800 dark:text-yellow-200 flex-1">
              {rateLimitWarning}
            </p>
            <button
              onClick={() => setRateLimitWarning(null)}
              className="text-yellow-600 dark:text-yellow-400 hover:text-yellow-800 dark:hover:text-yellow-200 flex-shrink-0 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
