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
    imageUploadStage,
    extractError,
    recovered,
    loadPlatforms,
    loadArticle,
    recoverSyncState,
    togglePlatform,
    selectAll,
    deselectAll,
    startSync,
    retryFailed,
    reset,
    checkRateLimit,
    clearExtractError,
  } = useSyncStore()

  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [allPlatforms, setAllPlatforms] = useState<DialogPlatform[]>([])

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [floatingEnabled, setFloatingEnabled] = useState(false)
  const [isFirstSync, setIsFirstSync] = useState(false)
  const [showShareTip, setShowShareTip] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewTab, setPreviewTab] = useState<'render' | 'markdown'>('render')
  /** 顶栏当前态：可与设置里的全局 realtimeDetect 不一致 */
  const [realtimeActive, setRealtimeActive] = useState(true)
  const [detecting, setDetecting] = useState(false)

  // Load data
  useEffect(() => {
    const init = async () => {
      await recoverSyncState()
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
      loadArticle()
      chrome.storage.local.get(['floatingButtonEnabled', 'syncHistory', 'dismissedShareTip'], (r) => {
        setFloatingEnabled(r.floatingButtonEnabled ?? false)
        setIsFirstSync(!r.syncHistory || r.syncHistory.length === 0)
        if (!r.dismissedShareTip) {
          setShowShareTip(true)
        }
      })
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

    // 顶栏当前态：仅启动时从全局偏好拷贝一次，之后互不影响
    chrome.storage.local.get('realtimeDetect').then((r) => {
      setRealtimeActive(r.realtimeDetect ?? true)
    }).catch(() => {})

    trackPageView('home').catch(() => {})
  }, [])

  // 导入 / 编辑锁定时：顶栏当前态自动关闭（不改全局设置）
  useEffect(() => {
    const src = article?.source
    if (src === 'import' || src === 'edited') {
      setRealtimeActive(false)
    }
  }, [article?.source])

  // 实时文章检测：只看顶栏当前态 realtimeActive；锁定文章不覆盖
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const trigger = () => {
      const src = useSyncStore.getState().article?.source
      if (src === 'import' || src === 'edited') return
      if (!realtimeActive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const src2 = useSyncStore.getState().article?.source
        if (src2 === 'import' || src2 === 'edited') return
        if (!realtimeActive) return
        loadArticle().catch(() => {})
      }, 500)
    }
    const onActivated = () => trigger()
    const onUpdated = async (tabId: number, info: chrome.tabs.TabChangeInfo) => {
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
  }, [loadArticle, realtimeActive])

  const loadAllPlatforms = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh: false } })
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
      logger.error('Failed to open overlay:', e)
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

  /** Logo：回主页；若当前为导入/编辑锁定，则开启当前态并强制重检 */
  const handleLogoHome = () => {
    navigate('/')
    const src = useSyncStore.getState().article?.source
    if (src === 'import' || src === 'edited') {
      setRealtimeActive(true)
      loadArticle({ force: true }).catch(() => {})
    }
  }

  const handleForceDetect = async () => {
    setRealtimeActive(true)
    setDetecting(true)
    try {
      await loadArticle({ force: true })
    } catch {
      // loadArticle 内部已处理错误提示
    } finally {
      setDetecting(false)
    }
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

  const realtimeLabel = realtimeActive ? '实时检测开启' : '实时检测关闭'
  let statusLine: string
  let statusTone: 'normal' | 'warn' | 'busy' = 'normal'
  if (detecting) {
    statusLine = '正在检测当前页…'
    statusTone = 'busy'
  } else if (extractError) {
    statusLine = extractError
    statusTone = 'warn'
  } else if (!article) {
    statusLine = `未检测到文章 · ${realtimeLabel}`
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
            title="返回主页（导入/编辑锁定时点击可切回网页检测）"
          >
            <img src="/assets/icon-48.png" alt="Logo" className="w-6 h-6" />
            <h1 className="font-semibold">同步派</h1>
          </button>
          {/* 顶栏：当前是否自动检测（可与设置全局偏好不一致） */}
          <button
            onClick={() => setRealtimeActive(v => !v)}
            title={realtimeActive ? '当前实时检测：开（点击关闭；与设置全局偏好独立）' : '当前实时检测：关（点击开启；与设置全局偏好独立）'}
            className={cn(
              'ml-1 p-1 rounded-full transition-colors',
              realtimeActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
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

      {/* Share / welcome banner (first time only) */}
      {showShareTip && (
        <div className="px-4 pt-3">
          <div className="bg-muted/50 rounded-lg p-3 text-sm relative">
            <button
              onClick={() => {
                setShowShareTip(false)
                chrome.storage.local.set({ dismissedShareTip: true })
              }}
              className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
            <p className="font-medium mb-1.5">谢谢支持！</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              如果觉得本工具不错，还请分享给你的朋友！
              <br />
              如果你是开发者，欢迎参与进来{' '}
              <a
                href="https://github.com/yjmm10/MediaSync"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                GitHub
              </a>
            </p>
            <hr className="my-2 border-border" />
            <p className="text-xs text-muted-foreground text-right">
              by{' '}
              <a
                href="https://github.com/yjmm10"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                fun
              </a>
            </p>
          </div>
        </div>
      )}

      {/* 图床上传进度（同步前把本地图片 base64 上传到图床） */}
      {imageUploadStage && (
        <div className="mx-4 mt-2 p-2 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
          <span>
            正在上传图片到「{platforms.find(p => p.id === imageUploadStage.host)?.name || imageUploadStage.host}」图床
            {imageUploadStage.total > 0 ? ` ${imageUploadStage.done}/${imageUploadStage.total}` : ''}
          </span>
        </div>
      )}

      {/* 文章操作入口：切换来源（导入/编辑 → 重新检测当前页）与预览 */}
      {article && (
        <div className="px-4 py-1 flex items-center justify-between">
          <button
            onClick={handleForceDetect}
            disabled={detecting}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
            title="放弃当前文章，重新检测当前页"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', detecting && 'animate-spin')} />
            {detecting ? '检测中…' : '检测当前页'}
          </button>
          <button
            onClick={() => setShowPreview(true)}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Eye className="w-3.5 h-3.5" />
            预览内容
          </button>
        </div>
      )}

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
