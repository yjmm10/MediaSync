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
  onContinueSync,
  onDismissError,
  className,
}: SyncDialogProps) {
  const selectedSet = new Set(selectedPlatforms)
  const failedCount = results.filter(r => !r.success).length
  const authenticatedCount = platforms.filter(p => p.isAuthenticated).length

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
        {/* Promo banner — only when no article */}
        {isIdle && !article && <PromoBanner />}

        <ArticleCard
          article={article}
          compact={isSyncing || isCompleted}
          density={isIdle && article ? 'strip' : 'full'}
          onEdit={isIdle ? onEditArticle : undefined}
        />

        {/* Unified platform list — 仅检测/导入得到文章后展示 */}
        {platforms.length > 0 && article && (
          <>
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
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-border/70 bg-background/80 backdrop-blur-sm p-4 space-y-2">
        {error && (
          <div className="flex items-start gap-2 rounded-lg p-2.5 text-sm text-destructive bg-destructive/[0.06] border border-destructive/20">
            <span className="grid place-items-center w-4 h-4 rounded-full bg-destructive/15 flex-shrink-0 mt-0.5">
              <span className="block w-1 h-1 rounded-full bg-destructive" />
            </span>
            <p className="flex-1 min-w-0 break-words">{error}</p>
            {onDismissError && (
              <button
                type="button"
                onClick={onDismissError}
                className="flex-shrink-0 text-xs text-destructive/70 hover:text-destructive transition-colors"
                aria-label="关闭错误提示"
              >
                关闭
              </button>
            )}
          </div>
        )}
        {isIdle && article && (
          <p className="text-[11px] text-muted-foreground tabular-nums px-0.5">
            已选 {selectedPlatforms.length} · 已登录 {authenticatedCount}
          </p>
        )}
        {isCompleted ? (
          <div className="flex gap-2">
            {failedCount > 0 && (
              <button
                onClick={onRetryFailed}
                className="flex-1 py-2.5 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/15 active:translate-y-px transition-all font-medium"
              >
                重试失败项 ({failedCount})
              </button>
            )}
            {onContinueSync && (
              <button
                onClick={onContinueSync}
                className="flex-1 py-2.5 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/15 active:translate-y-px transition-all font-medium"
              >
                继续同步其他平台
              </button>
            )}
            <button
              onClick={onReset}
              className={cn(
                'py-2.5 rounded-lg font-medium transition-all active:translate-y-px',
                failedCount > 0 || onContinueSync
                  ? 'btn-brand flex-1'
                  : 'btn-brand w-full'
              )}
            >
              完成
            </button>
          </div>
        ) : isSyncing ? (
          <button
            onClick={onCancel || onReset}
            className="btn-secondary w-full py-2.5 rounded-lg font-medium"
          >
            取消
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartSync}
            disabled={!article || selectedPlatforms.length === 0}
            className={cn(
              'btn-brand w-full py-2.5 rounded-lg font-medium',
              (!article || selectedPlatforms.length === 0) && 'opacity-90'
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
