import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { ArticleCard } from './ArticleCard'
import { PlatformList } from './PlatformList'
import { PromoBanner } from './PromoBanner'
import type { SyncDialogProps } from './types'

/**
 * Unified sync dialog component.
 *
 * Single continuous view — platforms transition in-place from selection → progress → results.
 * Prop-driven — can be used in popup, editor overlay, or content script iframe.
 */
export function SyncDialog({
  article,
  platforms,
  status,
  selectedPlatforms,
  results,
  platformProgress,
  error,
  onTogglePlatform,
  onSelectAll,
  onDeselectAll,
  onRecheckAuth,
  onStartSync,
  onRetryFailed,
  onReset,
  onCancel,
  onEditArticle,
  onClose,
  onContinueSync,
  onDismissError,
  className,
}: SyncDialogProps) {
  const selectedSet = new Set(selectedPlatforms)
  const failedCount = results.filter(r => !r.success).length

  const isIdle = status === 'idle' || status === 'loading'
  const isSyncing = status === 'syncing'
  const isCompleted = status === 'completed'

  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    if (!error || !onDismissError) return
    dismissTimerRef.current = setTimeout(() => {
      onDismissError()
      dismissTimerRef.current = null
    }, 60_000)
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }
    }
  }, [error, onDismissError])

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* Scrollable content — single continuous layout */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Promo banner — idle, show before article when no article */}
        {isIdle && !article && <PromoBanner />}

        {/* Article card — compact during sync/complete */}
        <ArticleCard
          article={article}
          compact={isSyncing || isCompleted}
          onEdit={isIdle ? onEditArticle : undefined}
        />

        {/* Promo banner — idle, show after article when article exists */}
        {isIdle && article && <PromoBanner />}

        {/* Unified platform list — 仅检测/导入得到文章后展示 */}
        {platforms.length > 0 && article && (
          <PlatformList
            platforms={platforms}
            selected={selectedSet}
            status={status}
            results={results}
            platformProgress={platformProgress}
            selectedPlatforms={selectedPlatforms}
            onToggle={onTogglePlatform}
            onSelectAll={onSelectAll}
            onDeselectAll={onDeselectAll}
            onRecheckAuth={onRecheckAuth}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t p-4 space-y-2">
        {error && (
          <div className="rounded-lg p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 flex items-start gap-2">
            <p className="flex-1 min-w-0 break-words">{error}</p>
            {onDismissError && (
              <button
                type="button"
                onClick={onDismissError}
                className="flex-shrink-0 text-xs text-red-500/80 hover:text-red-700 dark:hover:text-red-300"
                aria-label="关闭错误提示"
              >
                关闭
              </button>
            )}
          </div>
        )}
        {isCompleted ? (
          <div className="flex gap-2">
            {failedCount > 0 && (
              <button
                onClick={onRetryFailed}
                className="flex-1 py-2.5 text-sm bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors"
              >
                重试失败项 ({failedCount})
              </button>
            )}
            {onContinueSync && (
              <button
                onClick={onContinueSync}
                className="flex-1 py-2.5 text-sm bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors"
              >
                继续同步其他平台
              </button>
            )}
            <button
              onClick={onReset}
              className={cn(
                'py-2.5 rounded-lg font-medium transition-colors',
                failedCount > 0 || onContinueSync
                  ? 'flex-1 bg-muted text-foreground hover:bg-muted/80'
                  : 'w-full bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              完成
            </button>
          </div>
        ) : isSyncing ? (
          <button
            onClick={onCancel || onReset}
            className="w-full py-2.5 rounded-lg font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors"
          >
            取消
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartSync}
            disabled={!article || selectedPlatforms.length === 0}
            className={cn(
              'w-full py-2.5 rounded-lg font-medium transition-colors',
              !article || selectedPlatforms.length === 0
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {!article
              ? '请先检测文章或导入 Markdown'
              : platforms.length === 0
                ? '平台列表加载中…'
                : selectedPlatforms.length === 0
                  ? '请选择同步平台'
                  : `同步到 ${selectedPlatforms.length} 个平台`
            }
          </button>
        )}
      </div>
    </div>
  )
}
