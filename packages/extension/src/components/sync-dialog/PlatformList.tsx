import { useState, useEffect, useMemo } from 'react'
import type { DragEvent, MouseEvent } from 'react'
import { Check, X, Loader2, ExternalLink, ChevronRight, ChevronDown, LayoutGrid, List, GripVertical, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { openUrlsInTabGroup } from '@/lib/tabs'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  getPlatformCategory,
  type PlatformCategory,
} from '@/lib/platform-categories'
import type { Platform, SyncResult, PlatformProgress, DialogStatus } from './types'

const PLATFORM_ORDER_KEY = 'platformOrder'

/** 按自定义顺序排列平台；未记录在 order 中的保持相对顺序追加在后 */
function sortByOrder<T extends { id: string }>(list: T[], order: string[]): T[] {
  if (order.length === 0) return list
  const indexMap = new Map<string, number>()
  order.forEach((id, i) => indexMap.set(id, i))
  const pinned = list.filter(p => indexMap.has(p.id))
  const rest = list.filter(p => !indexMap.has(p.id))
  pinned.sort((a, b) => (indexMap.get(a.id)!) - (indexMap.get(b.id)!))
  return [...pinned, ...rest]
}

function platformCat(p: Platform): PlatformCategory {
  return p.category || getPlatformCategory(p.id)
}

function groupByCategory(list: Platform[], order: string[]): Array<{ category: PlatformCategory; platforms: Platform[] }> {
  const groups: Array<{ category: PlatformCategory; platforms: Platform[] }> = []
  for (const category of CATEGORY_ORDER) {
    const items = sortByOrder(
      list.filter(p => platformCat(p) === category),
      order,
    )
    if (items.length > 0) groups.push({ category, platforms: items })
  }
  return groups
}

interface PlatformListProps {
  platforms: Platform[]
  selected: Set<string>
  status: DialogStatus
  results: SyncResult[]
  platformProgress: Map<string, PlatformProgress>
  selectedPlatforms: string[]
  onToggle: (id: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onRecheckAuth?: (platformId: string) => void | Promise<void>
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
  onDeselectAll,
  onRecheckAuth,
}: PlatformListProps) {
  const isIdle = status === 'idle' || status === 'loading'
  const isSyncing = status === 'syncing'
  const isCompleted = status === 'completed'

  const authenticatedPlatforms = platforms.filter(p => p.isAuthenticated)
  const unauthenticatedPlatforms = platforms.filter(p => !p.isAuthenticated)
  const selectedCount = selected.size
  const selectedAuthCount = authenticatedPlatforms.filter(p => selected.has(p.id)).length
  const successCount = results.filter(r => r.success).length
  const failedCount = results.filter(r => !r.success).length
  const openableResults = results.filter(r => r.success && r.postUrl)

  const handleOpenAllDrafts = () => {
    openUrlsInTabGroup(
      openableResults.map(r => r.postUrl!),
      { title: '同步派', color: 'green' }
    )
  }

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

  const [categoryFilter, setCategoryFilter] = useState<'all' | PlatformCategory>('all')
  const [unauthCollapsed, setUnauthCollapsed] = useState(true)
  useEffect(() => {
    if (authenticatedPlatforms.length < 3) setUnauthCollapsed(false)
  }, [authenticatedPlatforms.length])

  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set())
  const handleRecheckAuth = async (platformId: string) => {
    if (!onRecheckAuth || checkingIds.has(platformId)) return
    setCheckingIds(prev => new Set(prev).add(platformId))
    try {
      await onRecheckAuth(platformId)
    } finally {
      setCheckingIds(prev => {
        const next = new Set(prev)
        next.delete(platformId)
        return next
      })
    }
  }

  const [platformOrder, setPlatformOrder] = useState<string[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  useEffect(() => {
    chrome.storage.local.get(PLATFORM_ORDER_KEY).then(r => {
      if (Array.isArray(r[PLATFORM_ORDER_KEY])) setPlatformOrder(r[PLATFORM_ORDER_KEY])
    })
  }, [])
  const persistOrder = (next: string[]) => {
    setPlatformOrder(next)
    chrome.storage.local.set({ [PLATFORM_ORDER_KEY]: next })
  }

  const handleReorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return
    const dragP = authenticatedPlatforms.find(p => p.id === dragId)
    const targetP = authenticatedPlatforms.find(p => p.id === targetId)
    if (!dragP || !targetP) return
    if (platformCat(dragP) !== platformCat(targetP)) return
    const ordered = sortByOrder(authenticatedPlatforms, platformOrder)
    const fromIdx = ordered.findIndex(p => p.id === dragId)
    const toIdx = ordered.findIndex(p => p.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...ordered]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    persistOrder(next.map(p => p.id))
  }
  const canDrag = isIdle && viewMode === 'list'

  const filteredAuth = useMemo(
    () => authenticatedPlatforms.filter(
      p => categoryFilter === 'all' || platformCat(p) === categoryFilter,
    ),
    [authenticatedPlatforms, categoryFilter],
  )
  const filteredUnauth = useMemo(
    () => unauthenticatedPlatforms.filter(
      p => categoryFilter === 'all' || platformCat(p) === categoryFilter,
    ),
    [unauthenticatedPlatforms, categoryFilter],
  )

  const authGroups = useMemo(
    () => groupByCategory(filteredAuth, platformOrder),
    [filteredAuth, platformOrder],
  )
  const unauthGroups = useMemo(
    () => groupByCategory(filteredUnauth, platformOrder),
    [filteredUnauth, platformOrder],
  )

  const availableChips = useMemo(() => {
    const present = new Set(platforms.map(platformCat))
    return CATEGORY_ORDER.filter(c => present.has(c))
  }, [platforms])

  const selectGroup = (groupPlatforms: Platform[]) => {
    for (const p of groupPlatforms) {
      if (p.isAuthenticated && !selected.has(p.id)) onToggle(p.id)
    }
  }

  const renderPlatformItem = (platform: Platform) => {
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
          isCheckingAuth={checkingIds.has(platform.id)}
          result={result || null}
          alreadySynced={isIdle && !!result?.success}
          onToggle={() => onToggle(platform.id)}
          onRecheckAuth={() => handleRecheckAuth(platform.id)}
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
        isCheckingAuth={checkingIds.has(platform.id)}
        result={result || null}
        progress={progress || null}
        alreadySynced={isIdle && !!result?.success}
        onToggle={() => onToggle(platform.id)}
        onRecheckAuth={() => handleRecheckAuth(platform.id)}
        draggable={canDrag && platform.isAuthenticated}
        isDragging={dragId === platform.id}
        isDragOver={overId === platform.id}
        onDragStart={() => { setDragId(platform.id); setOverId(null) }}
        onDragEnter={() => setOverId(platform.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => handleReorder(platform.id)}
        onDragEnd={() => { setDragId(null); setOverId(null) }}
      />
    )
  }

  const flatSelected = selectedPlatforms
    .map(id => platforms.find(p => p.id === id))
    .filter(Boolean) as Platform[]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        {isIdle && (
          <>
            <span className="text-sm font-semibold tracking-tight text-foreground">
              选择平台
              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium tabular-nums align-middle">
                {selectedCount}/{authenticatedPlatforms.length}
              </span>
            </span>
            <div className="flex items-center gap-2">
              {authenticatedPlatforms.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={onSelectAll}
                    disabled={selectedAuthCount === authenticatedPlatforms.length}
                    className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-default"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={onDeselectAll}
                    disabled={selectedAuthCount === 0}
                    className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-default"
                  >
                    取消全选
                  </button>
                </>
              )}
              {authenticatedPlatforms.length > 0 && (
                <button
                  type="button"
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
              <span className="text-sm font-semibold">同步中</span>
            </div>
            <span className="text-sm tabular-nums text-muted-foreground">
              {results.length}/{selectedPlatforms.length}
            </span>
          </>
        )}
        {isCompleted && (
          <>
            <span className="text-sm font-semibold">同步完成</span>
            <div className="flex items-center gap-2">
              {successCount > 0 && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary tabular-nums">
                  <Check className="w-3 h-3" strokeWidth={3} />{successCount}
                </span>
              )}
              {failedCount > 0 && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-destructive/10 text-destructive tabular-nums">
                  <X className="w-3 h-3" strokeWidth={3} />{failedCount}
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

      {isIdle && availableChips.length > 1 && (
        <div className="flex flex-wrap gap-1 px-0.5">
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={cn(
              'px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
              categoryFilter === 'all'
                ? 'bg-primary/15 text-primary'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted',
            )}
          >
            全部
          </button>
          {availableChips.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setCategoryFilter(c)}
              className={cn(
                'px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
                categoryFilter === c
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted',
              )}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      )}

      {isSyncing && selectedPlatforms.length > 0 && (
        <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-primary-strong transition-all duration-500 ease-out shadow-[0_0_8px_rgba(22,163,74,0.4)]"
            style={{ width: `${(results.length / selectedPlatforms.length) * 100}%` }}
          />
        </div>
      )}

      {isIdle ? (
        <div className="space-y-3">
          {authGroups.length > 0 && (
            <div className="space-y-2">
              <div className="px-1 text-[11px] font-semibold text-muted-foreground tracking-wide">
                已登录
              </div>
              {authGroups.map((group, gi) => (
                <div
                  key={group.category}
                  className="platform-group-enter space-y-0.5"
                  style={{ animationDelay: `${gi * 30}ms` }}
                >
                  <div className="flex items-center gap-2 px-1 py-0.5">
                    <span className="w-0.5 h-3 rounded-full bg-primary flex-shrink-0" />
                    <span className="text-[11px] font-semibold text-foreground">
                      {CATEGORY_LABELS[group.category]}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {group.platforms.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => selectGroup(group.platforms)}
                      className="ml-auto text-[11px] text-primary hover:underline"
                    >
                      本组全选
                    </button>
                  </div>
                  <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2' : 'space-y-0.5'}>
                    {group.platforms.map(renderPlatformItem)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {filteredUnauth.length > 0 && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setUnauthCollapsed(c => !c)}
                className="flex w-full items-center gap-1.5 px-1 py-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                {unauthCollapsed
                  ? <ChevronRight className="w-3 h-3" />
                  : <ChevronDown className="w-3 h-3" />}
                未登录
                <span className="tabular-nums font-normal">· {filteredUnauth.length}</span>
                <span className="ml-auto font-normal text-muted-foreground/80">点击检测</span>
              </button>
              {!unauthCollapsed && unauthGroups.map((group, gi) => (
                <div
                  key={group.category}
                  className="platform-group-enter space-y-0.5"
                  style={{ animationDelay: `${gi * 30}ms` }}
                >
                  <div className="flex items-center gap-2 px-1 py-0.5">
                    <span className="w-0.5 h-3 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {CATEGORY_LABELS[group.category]}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70">
                      {group.platforms.length}
                    </span>
                  </div>
                  <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2' : 'space-y-0.5'}>
                    {group.platforms.map(renderPlatformItem)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2' : 'space-y-0.5'}>
          {flatSelected.map(renderPlatformItem)}
        </div>
      )}

      {isIdle && platforms.length > 0 && authenticatedPlatforms.length === 0 && (
        <div className="text-center py-4">
          <p className="text-sm text-muted-foreground">还没有登录任何平台</p>
          <p className="text-xs text-muted-foreground mt-1">点击平台图标或名称可重新检测登录状态</p>
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
  isCheckingAuth,
  result,
  alreadySynced,
  onToggle,
  onRecheckAuth,
}: {
  platform: Platform
  isSelected: boolean
  isIdle: boolean
  isWaiting: boolean
  isInProgress: boolean
  isCheckingAuth: boolean
  result: SyncResult | null
  alreadySynced: boolean
  onToggle: () => void
  onRecheckAuth: () => void
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
    if (!isIdle || isCheckingAuth) return
    if (platform.isAuthenticated) {
      onToggle()
    } else {
      onRecheckAuth()
    }
  }

  // 悬停提示：idle 显示用户名，completed 显示草稿/错误
  let title = platform.name
  if (isCheckingAuth) {
    title = `${platform.name} · 正在检测登录…`
  } else if (alreadySynced) {
    title = isSelected ? `${platform.name} · 将重新同步` : `${platform.name} · 已同步（点击重新同步）`
  } else if (isIdle) {
    title = platform.isAuthenticated
      ? `${platform.name} · ${platform.username || '已登录'}`
      : `${platform.name} · 未登录，点击检测登录状态`
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
        // 与「添加平台」第三方平台格子一致：p-2 + 24px 图标，列数由容器宽度自适应
        'relative flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-200',
        isIdle && 'cursor-pointer hover:bg-muted/70',
        isIdle && platform.isAuthenticated && isSelected && 'bg-primary/[0.07] ring-1 ring-primary/30',
        isIdle && !platform.isAuthenticated && 'opacity-50 hover:opacity-100',
        syncedIdle && 'opacity-50',
        !syncedIdle && isDone && result?.success && 'bg-primary/[0.06] ring-1 ring-primary/20',
        !syncedIdle && isDone && result && !result.success && 'bg-destructive/[0.05] ring-1 ring-destructive/20',
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
        {isCheckingAuth && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60 rounded">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          </span>
        )}
        {/* idle 已选中（含已同步平台被用户重新勾选） */}
        {!isCheckingAuth && isIdle && platform.isAuthenticated && isSelected && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center ring-2 ring-background">
            <Check className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 已同步但未勾选（追加场景）：灰✓ */}
        {!isCheckingAuth && alreadySynced && !isSelected && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gray-400 flex items-center justify-center ring-2 ring-background">
            <Check className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 完成成功 */}
        {!isCheckingAuth && !alreadySynced && isDone && result?.success && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center ring-2 ring-background">
            <Check className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 完成失败 */}
        {!isCheckingAuth && !alreadySynced && isDone && result && !result.success && (
          <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center ring-2 ring-background">
            <X className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {/* 进行中 */}
        {!isCheckingAuth && isInProgress && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60 rounded">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          </span>
        )}
        {/* 等待中 */}
        {!isCheckingAuth && isWaiting && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/40 rounded">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/50" />
          </span>
        )}
      </div>
      {/* 名称 */}
      <span className="text-[10px] text-muted-foreground leading-tight text-center truncate w-full">{platform.name}</span>
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
  isCheckingAuth,
  result,
  progress,
  alreadySynced,
  onToggle,
  onRecheckAuth,
  draggable,
  isDragging,
  isDragOver,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  platform: Platform
  isSelected: boolean
  isIdle: boolean
  isWaiting: boolean
  isInProgress: boolean
  isCheckingAuth: boolean
  result: SyncResult | null
  progress: PlatformProgress | null
  /** 继续同步/追加场景：该平台已成功同步过，置灰且不可重复勾选 */
  alreadySynced: boolean
  onToggle: () => void
  onRecheckAuth: () => void
  draggable?: boolean
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnter?: (e: DragEvent<HTMLDivElement>) => void
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void
  onDrop?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void
}) {
  const isDone = !!result

  const handleRowClick = () => {
    if (!isIdle || isCheckingAuth) return
    if (platform.isAuthenticated) {
      onToggle()
      return
    }
    // 未登录：点击整行触发手动检测
    onRecheckAuth()
  }

  const handleRecheckClick = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (!isIdle || isCheckingAuth || platform.isAuthenticated) return
    onRecheckAuth()
  }

  // 未被用户勾选的已同步平台：浅灰（表示已同步，默认不再同步）
  const syncedIdle = alreadySynced && !isSelected

  return (
    <div
      onClick={handleRowClick}
      draggable={!!draggable && platform.isAuthenticated}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={
        isCheckingAuth
          ? `${platform.name} · 正在检测登录…`
          : !platform.isAuthenticated
            ? `${platform.name} · 点击检测登录状态`
            : draggable
              ? `${platform.name} · 可拖动排序`
              : undefined
      }
      className={cn(
        'flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-200',
        isIdle && platform.isAuthenticated && 'cursor-pointer hover:bg-muted/70',
        isIdle && !platform.isAuthenticated && 'cursor-pointer opacity-55 hover:opacity-100 hover:bg-muted/40',
        isIdle && isSelected && 'bg-primary/[0.07] ring-1 ring-inset ring-primary/25',
        syncedIdle && 'opacity-50',
        draggable && platform.isAuthenticated && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
        isDragOver && 'ring-2 ring-primary/40',
        !syncedIdle && isDone && result?.success && 'bg-primary/[0.06] ring-1 ring-inset ring-primary/20',
        !syncedIdle && isDone && result && !result.success && 'bg-destructive/[0.05] ring-1 ring-inset ring-destructive/20',
      )}
    >
      {/* 拖拽手柄（仅 idle 列表视图） */}
      {draggable && platform.isAuthenticated && (
        <GripVertical className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600 flex-shrink-0" />
      )}

      {/* Status indicator */}
      {isCheckingAuth ? (
        <Loader2 className="w-4 h-4 animate-spin text-primary flex-shrink-0" />
      ) : (
        <RowIndicator
          isIdle={isIdle}
          isSelected={isSelected}
          isAuthenticated={platform.isAuthenticated}
          isWaiting={isWaiting}
          isInProgress={isInProgress}
          result={result}
          alreadySynced={alreadySynced}
        />
      )}

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

      {/* Right side info + 手动检测（仅未登录） */}
      <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
        {isIdle && !platform.isAuthenticated && (
          <button
            type="button"
            title="重新检测登录状态"
            disabled={isCheckingAuth}
            onClick={handleRecheckClick}
            className={cn(
              'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] transition-colors',
              isCheckingAuth
                ? 'text-primary'
                : 'text-muted-foreground hover:text-primary hover:bg-muted'
            )}
          >
            <RefreshCw className={cn('w-3 h-3', isCheckingAuth && 'animate-spin')} />
            {isCheckingAuth ? '检测中' : '检测'}
          </button>
        )}
        <RowInfo
          platform={platform}
          isIdle={isIdle}
          isWaiting={isWaiting}
          isInProgress={isInProgress}
          isCheckingAuth={isCheckingAuth}
          result={result}
          progress={progress}
          alreadySynced={alreadySynced}
          isSelected={isSelected}
        />
      </div>
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
      <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
        <Check className="w-3 h-3 text-primary" strokeWidth={3} />
      </div>
    ) : (
      <div className="w-5 h-5 rounded-full bg-destructive/15 flex items-center justify-center flex-shrink-0">
        <X className="w-3 h-3 text-destructive" strokeWidth={3} />
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
  isCheckingAuth,
  result,
  progress,
  alreadySynced,
  isSelected,
}: {
  platform: Platform
  isIdle: boolean
  isWaiting: boolean
  isInProgress: boolean
  isCheckingAuth?: boolean
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
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              // 用 tabs.create，避免 <a> 在 popup 里导航导致面板内容被冲掉
              chrome.tabs.create({ url: result.postUrl! })
            }}
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

  // Idle：检测中由行内「检测」按钮展示；此处只保留去登录 / 用户名
  if (isCheckingAuth) {
    return null
  }
  if (!platform.isAuthenticated) {
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground flex items-center gap-0.5 flex-shrink-0 hover:text-primary"
        title="打开平台登录页"
        onClick={(e) => {
          e.stopPropagation()
          if (platform.homepage) chrome.tabs.create({ url: platform.homepage })
        }}
      >
        去登录 <ChevronRight className="w-3 h-3" />
      </button>
    )
  }
  return (
    <span className="text-xs text-muted-foreground truncate max-w-[80px] flex-shrink-0">
      {platform.username || '已登录'}
    </span>
  )
}
