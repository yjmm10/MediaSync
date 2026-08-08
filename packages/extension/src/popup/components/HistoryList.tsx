import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Trash2, ImageIcon, Loader2, Plus, Clock } from 'lucide-react'
import { useSyncStore } from '../stores/sync'
import { Button } from './ui/Button'
import { openUrlsInTabGroup } from '@/lib/tabs'
import { createLogger } from '../../lib/logger'
import { getLocalMdCacheByDocId } from '../../lib/local-md-cache'
import { cn } from '@/lib/utils'

const logger = createLogger('HistoryList')

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 24 * 60 * 60 * 1000 && date.getDate() === now.getDate()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth()) {
    return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface HistoryListProps {
  /** 嵌入同步页时更紧凑 */
  embedded?: boolean
  className?: string
}

/** 同步历史列表（可嵌入「同步」页下方） */
export function HistoryList({ embedded, className }: HistoryListProps) {
  const navigate = useNavigate()
  const { history, loadHistory, setArticle } = useSyncStore()

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

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

  const continueSync = async (item: (typeof history)[number]) => {
    const cached = await getLocalMdCacheByDocId(item.id)
    const markdown = cached?.markdown || item.markdown
    const html = cached?.html || item.html || markdown
    if (!markdown && !html) {
      logger.warn('该历史记录没有正文快照或本地缓存，无法追加同步', item.id)
      return
    }

    const title = cached?.title || item.title
    const cover = cached?.cover || item.cover
    const summary = cached?.summary
    const body = html || markdown || ''

    setArticle(
      {
        title,
        content: body,
        html: html || undefined,
        markdown: markdown || undefined,
        cover,
        summary,
      },
      'import',
    )

    const successIds = new Set((item.results || []).filter(r => r.success).map(r => r.platform))
    const { platforms, selectedPlatforms } = useSyncStore.getState()
    const baseSelected =
      selectedPlatforms.length > 0 ? selectedPlatforms : platforms.map(p => p.id)

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

  if (history.length === 0) {
    return (
      <div className={cn('py-8 flex flex-col items-center text-muted-foreground', className)}>
        <Clock className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">暂无同步历史</p>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col min-h-0', className)}>
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <h3 className={cn('font-medium text-foreground', embedded ? 'text-xs' : 'text-sm')}>
          最近 {history.length} 条记录
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={clearHistory}
          className="text-xs text-muted-foreground hover:text-destructive h-7 px-2"
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" />
          清空
        </Button>
      </div>

      <div className="space-y-2">
        {history.map(item => {
          const results = item.results || []
          const successCount = results.filter(r => r.success).length
          const failedCount = results.filter(r => !r.success).length
          const draftUrls = results.filter(r => r.success && r.postUrl).map(r => r.postUrl as string)

          return (
            <div key={item.id} className="card-interactive p-2.5">
              <div className="flex gap-2.5">
                {item.cover ? (
                  <img
                    src={item.cover}
                    alt=""
                    className="w-12 h-12 rounded-md object-cover flex-shrink-0 ring-1 ring-black/5"
                    onError={e => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                    <ImageIcon className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-0.5">
                    <h4 className="font-medium text-sm line-clamp-2 text-foreground">{item.title}</h4>
                    <div className="flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {formatTime(
                          item.lastSyncTime ?? item.startTime ?? item.timestamp ?? Date.now(),
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteHistoryItem(item.id)}
                        title="删除"
                        className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      {item.status === 'syncing' ? (
                        <span className="inline-flex items-center gap-1 text-primary font-medium">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          同步中
                        </span>
                      ) : (
                        <>
                          <span className="text-primary font-medium tabular-nums">{successCount} 成功</span>
                          {failedCount > 0 && (
                            <span className="text-destructive font-medium tabular-nums">{failedCount} 失败</span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {draftUrls.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            openUrlsInTabGroup(draftUrls, {
                              title: item.title ? item.title.slice(0, 8) : '同步派',
                              color: 'green',
                            })
                          }
                          className="text-primary hover:underline"
                        >
                          打开全部
                        </button>
                      )}
                      {(item.markdown || item.html) && (
                        <button
                          type="button"
                          onClick={() => continueSync(item)}
                          className="inline-flex items-center gap-0.5 text-primary hover:underline"
                        >
                          追加
                          <Plus className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {results.map(result => (
                      <div
                        key={result.platform}
                        className={cn(
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border',
                          result.success
                            ? 'bg-primary/10 text-primary border-primary/20'
                            : 'bg-destructive/10 text-destructive border-destructive/20',
                        )}
                        title={!result.success && result.error ? result.error : undefined}
                      >
                        <span>{result.platformName || result.platform}</span>
                        {!result.success && result.error && (
                          <span className="font-normal text-destructive/80 truncate max-w-[72px]">
                            : {result.error}
                          </span>
                        )}
                        {result.postUrl && (
                          <a
                            href={result.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:opacity-80"
                            onClick={e => e.stopPropagation()}
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
