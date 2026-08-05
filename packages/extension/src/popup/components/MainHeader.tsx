import { useNavigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Settings, Plus, Info, Loader2, Radar, Home, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSyncStore } from '../stores/sync'

export interface MainHeaderProps {
  showRealtime?: boolean
  realtimeEffective?: boolean
  realtimeDetectSetting?: boolean
  onToggleRealtime?: () => void
  onLogoClick?: () => void
}

/**
 * 顶栏：主页 / 历史 与其它入口同一行图标菜单
 */
export function MainHeader({
  showRealtime,
  realtimeEffective,
  realtimeDetectSetting,
  onToggleRealtime,
  onLogoClick,
}: MainHeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const status = useSyncStore(s => s.status)
  const results = useSyncStore(s => s.results)
  const selectedPlatforms = useSyncStore(s => s.selectedPlatforms)

  const path = location.pathname || '/'
  const isSyncing = status === 'syncing'
  const doneCount = results.length
  const totalCount = selectedPlatforms.length || doneCount

  const handleLogo = () => {
    if (onLogoClick) onLogoClick()
    else navigate('/')
  }

  const item = (
    active: boolean,
    onClick: () => void,
    icon: ReactNode,
    label: string,
    title?: string,
  ) => (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className={cn(
        'group flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-all duration-150',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <span className={cn('transition-transform duration-150', !active && 'group-hover:scale-110')}>
        {icon}
      </span>
      <span className="text-[10px] leading-none font-medium">{label}</span>
    </button>
  )

  return (
    <header className="flex-shrink-0 relative flex items-center justify-between px-3 py-2 gap-1">
      {/* 底部细分割线：用伪渐变让边缘更柔和 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={handleLogo}
          className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 transition-all duration-150 hover:bg-muted flex-shrink-0"
          title={path === '/' ? '返回空主页（清空当前文章）' : '回主页'}
        >
          <span className="relative grid place-items-center w-6 h-6 rounded-md bg-gradient-to-br from-primary to-primary-strong shadow-[0_1px_3px_rgba(22,163,74,0.35)]">
            <img
              src="/assets/icon-48.png"
              alt="同步派"
              className="w-5 h-5 rounded-[5px]"
            />
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-brand-gradient leading-none select-none">
            同步派
          </span>
        </button>

        {showRealtime && (
          <button
            type="button"
            onClick={onToggleRealtime}
            disabled={!realtimeDetectSetting}
            title={
              !realtimeDetectSetting
                ? '实时检测已在设置中关闭'
                : realtimeEffective
                  ? '实时检测：开'
                  : '实时检测：关'
            }
            className={cn(
              'relative p-1 rounded-full transition-all duration-200 flex-shrink-0',
              realtimeEffective
                ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(22,163,74,0.2)]'
                : 'bg-muted text-muted-foreground',
              !realtimeDetectSetting && 'opacity-50 cursor-not-allowed',
              realtimeEffective && 'hover:bg-primary/15',
            )}
          >
            <Radar className="w-3.5 h-3.5" />
            {realtimeEffective && (
              <span className="absolute -top-0.5 -right-0.5 flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
              </span>
            )}
          </button>
        )}
      </div>

      <nav className="flex items-center gap-0.5 flex-shrink-0">
        {item(path === '/', () => navigate('/'), <Home className="w-3.5 h-3.5" />, '主页')}
        <button
          type="button"
          onClick={() => navigate('/history')}
          title={
            isSyncing
              ? `有同步进行中 ${doneCount}/${totalCount || '…'}（进度在主页）`
              : '同步历史'
          }
          className={cn(
            'group relative flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-all duration-150',
            path === '/history'
              ? 'bg-primary/10 text-primary'
              : isSyncing
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
        >
          {isSyncing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <History className={cn('w-3.5 h-3.5', path !== '/history' && 'group-hover:scale-110 transition-transform duration-150')} />
          )}
          <span className="text-[10px] leading-none font-medium">
            历史
            {isSyncing && totalCount > 0 ? ` ${doneCount}/${totalCount}` : ''}
          </span>
          {isSyncing && (
            <span className="absolute -top-0.5 right-1 flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
            </span>
          )}
        </button>
        {item(path === '/add-cms', () => navigate('/add-cms'), <Plus className="w-3.5 h-3.5" />, '添加')}
        {item(path === '/about', () => navigate('/about'), <Info className="w-3.5 h-3.5" />, '关于')}
        {item(path === '/settings', () => navigate('/settings'), <Settings className="w-3.5 h-3.5" />, '设置')}
      </nav>
    </header>
  )
}
