import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle, XCircle, ExternalLink, Clock, Trash2, ImageIcon, Loader2, Plus } from 'lucide-react'
import { useSyncStore } from '../stores/sync'
import { Button } from '../components/ui/Button'
import { trackPageView } from '../../lib/analytics'
import { openUrlsInTabGroup } from '@/lib/tabs'
import { createLogger } from '../../lib/logger'
import { getLocalMdCacheByDocId } from '../../lib/local-md-cache'

const logger = createLogger('HistoryPage')

export function HistoryPage() {
  const navigate = useNavigate()
  const { history, loadHistory, setArticle } = useSyncStore()

  useEffect(() => {
    loadHistory()
    // 追踪页面访问
    trackPageView('history').catch(() => {})
  }, [])

  const clearHistory = async () => {
    await chrome.storage.local.remove('syncHistory')
    loadHistory()
  }

  const deleteHistoryItem = async (id: string) => {
    const { syncHistory = [] } = await chrome.storage.local.get('syncHistory')
    const updated = (syncHistory as Array<{ id: string }>).filter(h => h.id !== id)
    await chrome.storage.local.set({ syncHistory: updated })
    loadHistory()
  }

  /**
   * 对已同步过的文档追加同步到更多平台：
   * 优先本地 MD 缓存（含 data URI），否则用历史正文快照；直接回到首页选平台，无需重选文件夹。
   */
  const continueSync = async (item: typeof history[number]) => {
    const cached = await getLocalMdCacheByDocId(item.id)
    const markdown = cached?.markdown || item.markdown
    const html = cached?.html || item.html || markdown
    if (!markdown && !html) {
      logger.warn('该历史记录没有正文快照或本地缓存，无法追加同步', item.id)
      return
    }

    const title = cached?.title || item.title
    const cover = cached?.cover || item.cover
    const body = html || markdown || ''

    setArticle(
      {
        title,
        content: body,
        html: html || undefined,
        markdown: markdown || undefined,
        cover,
      },
      'import'
    )

    const successIds = new Set(
      (item.results || []).filter(r => r.success).map(r => r.platform)
    )
    const { platforms, selectedPlatforms } = useSyncStore.getState()
    const baseSelected =
      selectedPlatforms.length > 0
        ? selectedPlatforms
        : platforms.map(p => p.id)

    useSyncStore.setState({
      status: 'idle',
      results: (item.results || []).map(r => ({
        platform: r.platform,
        platformName: r.platformName,
        success: r.success,
        postUrl: r.postUrl,
        draftOnly: r.draftOnly,
        error: r.error,
      })),
      selectedPlatforms: baseSelected.filter(id => !successIds.has(id)),
      error: null,
      platformProgress: new Map(),
      currentSyncId: null,
    })

    await chrome.storage.local.remove('importPreloadArticle')
    navigate('/')
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    // 今天
    if (diff < 24 * 60 * 60 * 1000 && date.getDate() === now.getDate()) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }

    // 昨天
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (date.getDate() === yesterday.getDate()) {
      return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }

    // 其他
    return date.toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (history.length === 0) {
    return (
      <div className="p-4 h-full flex flex-col">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          返回
        </button>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <Clock className="w-12 h-12 mb-4 opacity-50" />
          <p>暂无同步历史</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 h-full flex flex-col">
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        返回
      </button>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground">
          最近 {history.length} 条记录
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={clearHistory}
          className="text-xs text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" />
          清空
        </Button>
      </div>

      <div className="flex-1 overflow-auto space-y-3">
        {history.map((item) => {
          const results = item.results || []
          const successCount = results.filter(r => r.success).length
          const failedCount = results.filter(r => !r.success).length
          const draftUrls = results
            .filter(r => r.success && r.postUrl)
            .map(r => r.postUrl as string)

          return (
            <div
              key={item.id}
              className="p-3 rounded-lg border border-border bg-card"
            >
              <div className="flex gap-3">
                {/* 封面图 */}
                {item.cover ? (
                  <img
                    src={item.cover}
                    alt=""
                    className="w-16 h-16 rounded object-cover flex-shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <div className="w-16 h-16 rounded bg-muted flex items-center justify-center flex-shrink-0">
                    <ImageIcon className="w-6 h-6 text-muted-foreground" />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  {/* 标题和时间 */}
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-medium text-sm line-clamp-2">{item.title}</h3>
                    <div className="flex items-center gap-2 whitespace-nowrap flex-shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {formatTime(item.lastSyncTime ?? item.startTime ?? item.timestamp ?? Date.now())}
                      </span>
                      <button
                        onClick={() => deleteHistoryItem(item.id)}
                        title="删除此记录"
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* 统计 */}
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-3">
                      {item.status === 'syncing' ? (
                        <div className="flex items-center gap-1 text-blue-600">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>同步中...</span>
                        </div>
                      ) : item.status === 'cancelled' ? (
                        <div className="flex items-center gap-1 text-gray-500">
                          <XCircle className="w-3.5 h-3.5" />
                          <span>已取消</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1 text-green-600">
                            <CheckCircle className="w-3.5 h-3.5" />
                            <span>{successCount} 成功</span>
                          </div>
                          {failedCount > 0 && (
                            <div className="flex items-center gap-1 text-red-600">
                              <XCircle className="w-3.5 h-3.5" />
                              <span>{failedCount} 失败</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    {draftUrls.length > 1 && (
                      <button
                        onClick={() => openUrlsInTabGroup(draftUrls, {
                          title: item.title ? item.title.slice(0, 8) : '同步派',
                          color: 'green',
                        })}
                        title={`在标签组中打开 ${draftUrls.length} 个草稿/文章链接`}
                        className="inline-flex items-center gap-0.5 text-primary hover:underline whitespace-nowrap flex-shrink-0"
                      >
                        打开全部
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                    {(item.markdown || item.html) && (
                      <button
                        onClick={() => continueSync(item)}
                        title="用此文档追加同步到更多平台"
                        className="inline-flex items-center gap-0.5 text-primary hover:underline whitespace-nowrap flex-shrink-0"
                      >
                        追加同步
                        <Plus className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {/* 平台列表 */}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {results.map((result) => (
                      <div
                        key={result.platform}
                        className={`
                          inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs
                          ${result.success
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          }
                        `}
                        title={!result.success && result.error ? result.error : undefined}
                      >
                        <span>{result.platformName || result.platform}</span>
                        {!result.success && result.error && (
                          <span className="opacity-60 truncate max-w-[80px]">: {result.error}</span>
                        )}
                        {result.postUrl && (
                          <a
                            href={result.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:opacity-70"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
