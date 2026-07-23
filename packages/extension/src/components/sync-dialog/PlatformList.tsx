import { useState, useEffect } from 'react'
import { Check, X, Loader2, ExternalLink, ChevronRight, LayoutGrid, List } from 'lucide-react'
import { cn } from '@/lib/utils'
import { openUrlsInTabGroup } from '@/lib/tabs'
import type { Platform, SyncResult, PlatformProgress, DialogStatus } from './types'

interface PlatformListProps {
  platforms: Platform[]
  selected: Set<string>
  status: DialogStatus
  results: SyncResult[]
  platformProgress: Map<string, PlatformProgress>
  selectedPlatforms: string[]
  onToggle: (id: string) => void
  onSelectAll: () => void
}

export function PlatformList({
  platforms,
  selected,
  status,
  results,
  platformProgress,
  selectedPlatforms,
  onToggle,
  onSelectAll,
}: PlatformListProps) {
  const isIdle = status === 'idle' || status === 'loading'
  const isSyncing = status === 'syncing'
  const isCompleted = status === 'completed'

  const authenticatedPlatforms = platforms.filter(p => p.isAuthenticated)
  const unauthenticatedPlatforms = platforms.filter(p => !p.isAuthenticated)
  const selectedCount = selected.size
  const successCount = results.filter(r => r.success).length
  const failedCount = results.filter(r => !r.success).length
  // 成功且有可访问链接的结果（草稿/文章页），用于"打开全部"
  const openableResults = results.filter(r => r.success && r.postUrl)

  /**
   * 一键打开所有草稿/文章链接（去重、归入标签组；降级由 openUrlsInTabGroup 处理）
   */
  const handleOpenAllDrafts = () => {
    openUrlsInTabGroup(
      openableResults.map(r => r.postUrl!),
      { title: '同步派', color: 'green' }
    )
  }

  // 视图模式：列表 / 网格（持久化到 storage）
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  useEffect(() => {
    chrome.storage.local.get('platformViewMode').then(r => {
      if (r.platformViewMode === 'grid') setViewMode('grid')
    })
  }, [])
  const toggleViewMode = () => {
    const next = viewMode === 'list' ? 'grid' : 'list'
    setViewMode(next)
    chrome.storage.local.set({ platformViewMode: next })
  }

  // Idle: show all (authenticated first), syncing/completed: only selected
  const visiblePlatforms = isIdle
    ? [...authenticatedPlatforms, ...unauthenticatedPlatforms]
    : selectedPlatforms
        .map(id => platforms.find(p => p.id === id))
        .filter(Boolean) as Platform[]

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        {isIdle && (
          <>
            <span className="text-sm font-medium text-foreground">
              选择平台
              <span className="ml-1.5 text-muted-foreground font-normal">
                {selectedCount}/{authenticatedPlatforms.length}
              </span>
            </span>
            <div className="flex items-center gap-2">
              {authenticatedPlatforms.length > 0 && (
                <button
                  onClick={onSelectAll}
                  className="text-xs text-primary hover:underline"
                >
                  {selectedCount === authenticatedPlatforms.length ? '取消全选' : '全选'}
                </button>
              )}
              {authenticatedPlatforms.length > 0 && (
                <button
                  onClick={toggleViewMode}
                  title={viewMode === 'list' ? '切换到网格视图' : '切换到列表视图'}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {viewMode === 'list'
                    ? <LayoutGrid className="w-3.5 h-3.5" />
                    : <List className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
          </>
        )}
        {isSyncing && (
          <>
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              <span className="text-sm font-medium">同步中</span>
            </div>
            <span className="text-sm tabular-nums text-muted-foreground">
              {results.length}/{selectedPlatforms.length}
            </span>
          </>
        )}
        {isCompleted && (
          <>
            <span className="text-sm font-medium">同步完成</span>
            <div className="flex items-center gap-2">
              {successCount > 0 && (
                <span className="inline-flex items-center gap-0.5 text-xs text-green-600">
                  <Check className="w-3 h-3" />{successCount}
                </span>
              )}
              {failedCount > 0 && (
                <span className="inline-flex items-center gap-0.5 text-xs text-red-500">
                  <X className="w-3 h-3" />{failedCount}
                </span>
              )}
              {openableResults.length > 1 && (
                <button
                  onClick={handleOpenAllDrafts}
                  title={`在浏览器中打开 ${openableResults.length} 个草稿/文章链接`}
                  className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
                >
                  打开全部
                  <ExternalLink className="w-3 h-3" />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Progress bar (syncing only) */}
      {isSyncing && selectedPlatforms.length > 0 && (
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
            style={{ width: `${(results.length / selectedPlatforms.length) * 100}%` }}
          />
        </div>
      )}

      {/* Platform rows */}
      <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2' : 'space-y-0.5'}>
        {visiblePlatforms.map(platform => {
          const result = results.find(r => r.platform === platform.id)
          const progress = platformProgress.get(platform.id)
          const isSelected = selected.has(platform.id)
          const isWaiting = isSyncing && !result && !progress
          const isInProgress = isSyncing && !result && !!progress

          if (viewMode === 'grid') {
            return (
              <PlatformGridCell
                key={platform.id}
                platform={platform}
                isSelected={isSelected}
                isIdle={isIdle}
                isWaiting={isWaiting}
                isInProgress={isInProgress}
                result={result || null}
                alreadySynced={isIdle && !!result?.success}
                onToggle={() => onToggle(platform.id)}
              />
            )
          }

          return (
            <PlatformRow
              key={platform.id}
              platform={platform}
              isSelected={isSelected}
              isIdle={isIdle}
              isWaiting={isWaiting}
              isInProgress={isInProgress}
              result={result || null}
              progress={progress || null}
              alreadySynced={isIdle && !!result?.success}
              onToggle={() => onToggle(platform.id)}
            />
          )
        })}
      </div>

      {/* No platforms logged in */}
      {isIdle && platforms.length > 0 && authenticatedPlatforms.length === 0 && (
        <div className="text-center py-4">
          <p className="text-sm text-muted-foreground">还没有登录任何平台</p>
          <p className="text-xs text-muted-foreground mt-1">点击平台名称前往登录</p>
        </div>
      )}
    </div>
  )
}

// ── Grid cell (网格视图：图标 + 名称，悬停查看用户名/状态) ──

function PlatformGridCell({
  platform,
  isSelected,
  isIdle,
  isWaiting,
  isInProgress,
  result,
  alreadySynced,
  onToggle,
}: {
  platform: Platform
  isSelected: boolean
  isIdle: boolean
  isWaiting: boolean
  isInProgress: boolean
  result: SyncResult | null
  alreadySynced: boolean
  onToggle: () => void
}) {
  const isDone = !!result

  const handleClick = () => {
    // 已同步（追加场景）：可重新勾选以强制重新同步；未勾选时不打开链接
    if (alreadySynced) {
      if (!isIdle) return
      if (platform.isAuthenticated) onToggle()
      return
    }
    // 完成且成功：点击直接打开草稿/文章
    if (isDone && result?.success && result.postUrl) {
      chrome.tabs.create({ url: result.postUrl })
      return
    }
    if (!isIdle) return
    if (platform.isAuthenticated) {
      onToggle()
    } else if (platform.homepage) {
      chrome.tabs.create({ url: platform.homepage })
    }
  }

  // 悬停提示：idle 显示用户名，completed 显示草稿/错误
  let title = platform.name
  if (alreadySynced) {
    title = isSelected ? `${platform.name} · 将重新同步` : `${platform.name} · 已同步（点击重新同步）`
  } else if (isIdle) {
    title = platform.isAuthenticated
      ? `${platform.name} · ${platform.username || '已登录'}`
      : `${platform.name} · 未登录，点击前往登录`
  } else if (isDone && result) {
    title = result.success
      ? `${platform.name} · ${result.draftOnly ? '草稿' : '查看'}（点击打开）`
      : `${platform.name} · ${result.error || '失败'}`
  }

  const syncedIdle = alreadySynced && !isSelected

  return (
    <div
      onClick={handleClick}
      title={title}
      className={cn(
        'relative flex flex-col items-center gap-1.5 p-2 rounded-lg transition-all duration-200',
        isIdle && 'cursor-pointer hover:bg-muted/60',
        isIdle && platform.isAuthenticated && isSelected && 'bg-primary/5 ring-1 ring-primary',
        isIdle && !platform.isAuthenticated && 'opacity-50',
        syncedIdle && 'opacity-50',
        !syncedIdle && isDone && result?.success && 'bg-green-50 dark:bg-green-950/20',
        !syncedIdle && isDone && result && !result.success && 'bg-red-50 dark:bg-red-950/20',
      )}
    >
      {/* 图标 + 状态角标 */}
      <div className="relative">
        <img
          src={platform.icon}
          alt={platform.name}
          className="w-6 h-6 rounded"
          onError={(e) => { (e.target as HTMLImageElement).src = '/assets/icon-48.png' }}
        />
        {/* idle 已选中（含已同步平台被用户重新勾选） */}
        {isIdle && platform.isAuthenticated && isSelected && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center ring-2 ring-background">
            <Check className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 已同步但未勾选（追加场景）：灰✓ */}
        {alreadySynced && !isSelected && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gray-400 flex items-center justify-center ring-2 ring-background">
            <Check className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 完成成功 */}
        {!alreadySynced && isDone && result?.success && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center ring-2 ring-background">
            <Check className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 完成失败 */}
        {!alreadySynced && isDone && result && !result.success && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center ring-2 ring-background">
            <X className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 进行中 */}
        {isInProgress && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60 rounded">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          </span>
        )}
        {/* 等待中 */}
        {isWaiting && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/40 rounded">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/50" />
          </span>
        )}
      </div>
      {/* 名称 */}
      <span className="text-xs text-center truncate w-full">{platform.name}</span>
    </div>
  )
}

// ── Single platform row ──

function PlatformRow({
  platform,
  isSelected,
  isIdle,
  isWaiting,
  isInProgress,
  result,
  progress,
  alreadySynced,
  onToggle,
}: {
  platform: Platform
  isSelected: boolean
  isIdle: boolean
  isWaiting: boolean
  isInProgress: boolean
  result: SyncResult | null
  progress: PlatformProgress | null
  /** 继续同步/追加场景：该平台已成功同步过，置灰且不可重复勾选 */
  alreadySynced: boolean
  onToggle: () => void
}) {
  const isDone = !!result

  const handleClick = () => {
    if (!isIdle) return
    // alreadySynced 可点击：取消/重新勾选（重新勾选 = 强制重新同步）
    if (platform.isAuthenticated) {
      onToggle()
    } else if (platform.homepage) {
      chrome.tabs.create({ url: platform.homepage })
    }
  }

  // 未被用户勾选的已同步平台：浅灰（表示已同步，默认不再同步）
  const syncedIdle = alreadySynced && !isSelected

  return (
    <div
      onClick={handleClick}
      className={cn(
        'flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-200',
        isIdle && platform.isAuthenticated && 'cursor-pointer hover:bg-muted/60',
        isIdle && !platform.isAuthenticated && 'cursor-pointer opacity-50 hover:opacity-70',
        isIdle && isSelected && 'bg-primary/5',
        syncedIdle && 'opacity-50',
        !syncedIdle && isDone && result?.success && 'bg-green-50 dark:bg-green-950/20',
        !syncedIdle && isDone && result && !result.success && 'bg-red-50 dark:bg-red-950/20',
      )}
    >
      {/* Status indicator */}
      <RowIndicator
        isIdle={isIdle}
        isSelected={isSelected}
        isAuthenticated={platform.isAuthenticated}
        isWaiting={isWaiting}
        isInProgress={isInProgress}
        result={result}
        alreadySynced={alreadySynced}
      />

      {/* Platform icon */}
      <img
        src={platform.icon}
        alt={platform.name}
        className="w-5 h-5 rounded flex-shrink-0"
        onError={(e) => {
          (e.target as HTMLImageElement).src = '/assets/icon-48.png'
        }}
      />

      {/* Platform name */}
      <span className="text-sm flex-1 truncate">{platform.name}</span>

      {/* Right side info */}
      <RowInfo
        platform={platform}
        isIdle={isIdle}
        isWaiting={isWaiting}
        isInProgress={isInProgress}
        result={result}
        progress={progress}
        alreadySynced={alreadySynced}
        isSelected={isSelected}
      />
    </div>
  )
}

// ── Left indicator (checkbox / spinner / check / x) ──

function RowIndicator({
  isIdle,
  isSelected,
  isAuthenticated,
  isWaiting,
  isInProgress,
  result,
  alreadySynced,
}: {
  isIdle: boolean
  isSelected: boolean
  isAuthenticated: boolean
  isWaiting: boolean
  isInProgress: boolean
  result: SyncResult | null
  alreadySynced: boolean
}) {
  if (alreadySynced) {
    // 用户重新勾选的已同步平台：深色勾（将强制重新同步）；否则浅灰勾（仅提示已同步）
    if (isSelected) {
      return (
        <div className="w-[18px] h-[18px] rounded border-2 bg-primary border-primary flex items-center justify-center flex-shrink-0" title="将重新同步">
          <Check className="w-3 h-3 text-white" />
        </div>
      )
    }
    return (
      <div className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-700/40 flex items-center justify-center flex-shrink-0" title="已同步（点击可重新同步）">
        <Check className="w-3 h-3 text-gray-400 dark:text-gray-300" />
      </div>
    )
  }
  if (result) {
    return result.success ? (
      <div className="w-5 h-5 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center flex-shrink-0">
        <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
      </div>
    ) : (
      <div className="w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
        <X className="w-3 h-3 text-red-600 dark:text-red-400" />
      </div>
    )
  }
  if (isInProgress) {
    return <Loader2 className="w-4 h-4 animate-spin text-primary flex-shrink-0" />
  }
  if (isWaiting) {
    return <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" />
  }
  // Idle
  if (!isAuthenticated) {
    return <div className="w-4 h-4 rounded-full border-2 border-gray-200 dark:border-gray-700 flex-shrink-0" />
  }
  return (
    <div className={cn(
      'w-[18px] h-[18px] rounded border-2 transition-colors flex items-center justify-center flex-shrink-0',
      isSelected
        ? 'bg-primary border-primary'
        : 'border-gray-300 dark:border-gray-500'
    )}>
      {isSelected && <Check className="w-3 h-3 text-white" />}
    </div>
  )
}

// ── Right side info (username / stage / link / error) ──

function RowInfo({
  platform,
  isIdle,
  isWaiting,
  isInProgress,
  result,
  progress,
  alreadySynced,
  isSelected,
}: {
  platform: Platform
  isIdle: boolean
  isWaiting: boolean
  isInProgress: boolean
  result: SyncResult | null
  progress: PlatformProgress | null
  alreadySynced: boolean
  isSelected: boolean
}) {
  // 追加同步场景：已同步过的平台
  if (alreadySynced) {
    return (
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {isSelected ? '重新同步' : '已同步'}
      </span>
    )
  }

  // Done
  if (result) {
    if (result.success && result.postUrl) {
      return (
        <span className="flex items-center gap-1 flex-shrink-0">
          {result.message && (
            <span className="relative group">
              <span className="text-[10px] text-gray-400 truncate block" style={{ maxWidth: '140px' }}>
                {result.message}
              </span>
              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] text-white bg-gray-800 rounded-md whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                {result.message}
              </span>
            </span>
          )}
          <a
            href={result.postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline flex items-center gap-0.5 whitespace-nowrap"
            onClick={e => e.stopPropagation()}
          >
            {result.draftOnly ? '草稿' : '查看'}
            <ExternalLink className="w-3 h-3" />
          </a>
        </span>
      )
    }
    if (!result.success) {
      return (
        <span
          className="text-xs text-red-500 dark:text-red-400 truncate max-w-[120px] flex-shrink-0"
          title={result.error}
        >
          {result.error || '失败'}
        </span>
      )
    }
    return <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">完成</span>
  }

  // In progress
  if (isInProgress && progress) {
    const stageText = {
      starting: '准备中',
      uploading_images: progress.imageProgress
        ? `图片 ${progress.imageProgress.current}/${progress.imageProgress.total}`
        : '上传图片',
      saving: '保存中',
      completed: '完成',
      failed: '失败',
    }[progress.stage]

    return (
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-xs text-primary">{stageText}</span>
        {progress.stage === 'uploading_images' && progress.imageProgress && (
          <div className="w-10 h-1 bg-primary/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${(progress.imageProgress.current / progress.imageProgress.total) * 100}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  // Waiting
  if (isWaiting) {
    return <span className="text-xs text-muted-foreground flex-shrink-0">等待中</span>
  }

  // Idle
  if (!platform.isAuthenticated) {
    return (
      <span className="text-xs text-muted-foreground flex items-center gap-0.5 flex-shrink-0">
        去登录 <ChevronRight className="w-3 h-3" />
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground truncate max-w-[80px] flex-shrink-0">
      {platform.username || '已登录'}
    </span>
  )
}
