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
        'flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-colors',
        active ? 'bg-muted text-foreground' : 'hover:bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  )

  return (
    <header className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b gap-1">
      <div className="flex items-center gap-1 min-w-0">
        <button
          type="button"
          onClick={handleLogo}
          className="flex items-center gap-1.5 rounded-lg hover:opacity-80 transition-opacity flex-shrink-0 mr-0.5"
          title={path === '/' ? '返回空主页（清空当前文章）' : '回主页'}
        >
          <img src="/assets/icon-48.png" alt="Logo" className="w-6 h-6" />
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
              'p-1 rounded-full transition-colors flex-shrink-0',
              realtimeEffective ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              !realtimeDetectSetting && 'opacity-50 cursor-not-allowed',
            )}
          >
            <Radar className="w-3.5 h-3.5" />
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
            'flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-colors relative',
            path === '/history'
              ? 'bg-muted text-foreground'
              : 'hover:bg-muted text-muted-foreground hover:text-foreground',
          )}
        >
          {isSyncing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          ) : (
            <History className="w-3.5 h-3.5" />
          )}
          <span className="text-[10px] leading-none">
            历史
            {isSyncing && totalCount > 0 ? ` ${doneCount}/${totalCount}` : ''}
          </span>
        </button>
        {item(path === '/add-cms', () => navigate('/add-cms'), <Plus className="w-3.5 h-3.5" />, '添加')}
        {item(path === '/about', () => navigate('/about'), <Info className="w-3.5 h-3.5" />, '关于')}
        {item(path === '/settings', () => navigate('/settings'), <Settings className="w-3.5 h-3.5" />, '设置')}
      </nav>
    </header>
  )
}
