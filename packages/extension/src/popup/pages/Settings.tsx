import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plug, PlugZap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SubPageHeader } from '../components/SubPageHeader'
import { PlatformConfigSection } from '../components/PlatformConfigSection'
import { trackFeatureDiscovery } from '../../lib/analytics'
import {
  DEFAULT_LOCAL_MD_CACHE_LIMIT,
  MAX_LOCAL_MD_CACHE_LIMIT,
  MIN_LOCAL_MD_CACHE_LIMIT,
  clearLocalMdCache,
  formatCacheBytes,
  getLocalMdCacheBytes,
  getLocalMdCacheLimit,
  setLocalMdCacheLimit,
} from '../../lib/local-md-cache'
import {
  DEFAULT_LOCAL_MD_TITLE_SOURCE,
  type LocalMdTitleSource,
  getLocalMdTitleSource,
  setLocalMdTitleSource,
} from '../../lib/local-markdown'
import {
  DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB,
  MAX_SYNC_MESSAGE_SIZE_THRESHOLD_MB,
  MIN_SYNC_MESSAGE_SIZE_THRESHOLD_MB,
  getSyncMessageSizeThresholdMb,
  setSyncMessageSizeThresholdMb,
} from '../../lib/sync-message-threshold'

interface McpStatus {
  enabled: boolean
  connected: boolean
  token?: string
  serverUrl?: string
}

/** 统一开关滑块：避免圆点错位 */
function Toggle({
  on,
  onClick,
  disabled,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'relative h-6 w-11 flex-shrink-0 rounded-full transition-colors',
        on ? 'bg-primary' : 'bg-muted-foreground/30',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  )
}

/**
 * 设置页（路由 /settings），与其他二级页（历史/关于）保持一致的页面式布局，
 * 取代原先的右侧抽屉弹窗。
 * 历史 / 自建站点入口分别在顶栏「历史」「添加」，此处不再重复。
 */
export function SettingsPage() {
  const navigate = useNavigate()
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({ enabled: false, connected: false })
  const [loading, setLoading] = useState(false)
  const [floatingButtonEnabled, setFloatingButtonEnabled] = useState(false)
  const [realtimeDetect, setRealtimeDetect] = useState(true)
  const [localMdCacheLimit, setLocalMdCacheLimitState] = useState(DEFAULT_LOCAL_MD_CACHE_LIMIT)
  const [localMdCacheBytes, setLocalMdCacheBytes] = useState(0)
  const [cacheClearHint, setCacheClearHint] = useState<string | null>(null)
  const [localMdTitleSource, setLocalMdTitleSourceState] =
    useState<LocalMdTitleSource>(DEFAULT_LOCAL_MD_TITLE_SOURCE)
  const [syncMsgThresholdMb, setSyncMsgThresholdMbState] = useState(
    DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB,
  )
  const [serverUrlInput, setServerUrlInput] = useState('')
  const serverUrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cacheLimitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncThresholdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshLocalMdCacheBytes = () => {
    getLocalMdCacheBytes().then(setLocalMdCacheBytes)
  }

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'MCP_STATUS' }, (response) => {
      if (response && !response.error) {
        setMcpStatus({
          enabled: response.enabled ?? false,
          connected: response.connected ?? false,
          token: response.token,
          serverUrl: response.serverUrl,
        })
        setServerUrlInput(response.serverUrl || '')
      }
    })

    chrome.storage.local.get('floatingButtonEnabled', (result) => {
      setFloatingButtonEnabled(result.floatingButtonEnabled ?? false)
    })

    chrome.storage.local.get('realtimeDetect', (result) => {
      setRealtimeDetect(result.realtimeDetect ?? true)
    })

    getLocalMdCacheLimit().then(setLocalMdCacheLimitState)
    getLocalMdTitleSource().then(setLocalMdTitleSourceState)
    getSyncMessageSizeThresholdMb().then(setSyncMsgThresholdMbState)
    refreshLocalMdCacheBytes()
  }, [])

  useEffect(() => {
    if (!mcpStatus.enabled) return

    chrome.runtime.sendMessage({ type: 'MCP_WATCH_START' })

    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'MCP_STATUS' }, (response) => {
        if (response && !response.error) {
          setMcpStatus(prev => ({ ...prev, connected: response.connected ?? false }))
        }
      })
    }, 3000)

    return () => {
      clearInterval(interval)
      chrome.runtime.sendMessage({ type: 'MCP_WATCH_STOP' })
    }
  }, [mcpStatus.enabled])

  const toggleMcp = async () => {
    setLoading(true)
    const action = mcpStatus.enabled ? 'MCP_DISABLE' : 'MCP_ENABLE'

    if (!mcpStatus.enabled) {
      trackFeatureDiscovery('mcp', 'settings').catch(() => {})
    }

    chrome.runtime.sendMessage({ type: action }, (response) => {
      setLoading(false)
      if (response?.success) {
        setMcpStatus(prev => ({
          ...prev,
          enabled: !prev.enabled,
          connected: false,
          token: response.token,
        }))
      }
    })
  }

  const handleServerUrlChange = (value: string) => {
    setServerUrlInput(value)
    if (serverUrlTimer.current) {
      clearTimeout(serverUrlTimer.current)
    }
    serverUrlTimer.current = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'MCP_SET_SERVER_URL',
        payload: { url: value.trim() },
      })
      setMcpStatus(prev => ({ ...prev, serverUrl: value.trim() }))
    }, 800)
  }

  const toggleFloatingButton = () => {
    const next = !floatingButtonEnabled
    setFloatingButtonEnabled(next)
    chrome.storage.local.set({ floatingButtonEnabled: next })
  }

  const toggleRealtimeDetect = () => {
    const next = !realtimeDetect
    setRealtimeDetect(next)
    chrome.storage.local.set({ realtimeDetect: next })
  }

  const handleCacheLimitChange = (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const next = Math.min(
      MAX_LOCAL_MD_CACHE_LIMIT,
      Math.max(MIN_LOCAL_MD_CACHE_LIMIT, Math.round(parsed))
    )
    setLocalMdCacheLimitState(next)
    if (cacheLimitTimer.current) clearTimeout(cacheLimitTimer.current)
    cacheLimitTimer.current = setTimeout(() => {
      setLocalMdCacheLimit(next).then((limit) => {
        setLocalMdCacheLimitState(limit)
        refreshLocalMdCacheBytes()
      })
    }, 400)
  }

  const handleClearLocalMdCache = async () => {
    await clearLocalMdCache()
    setLocalMdCacheBytes(0)
    setCacheClearHint('已清空本地 Markdown 缓存')
    setTimeout(() => setCacheClearHint(null), 2000)
  }

  const handleTitleSourceChange = (value: string) => {
    const next = value as LocalMdTitleSource
    setLocalMdTitleSourceState(next)
    setLocalMdTitleSource(next).then(setLocalMdTitleSourceState)
  }

  const handleSyncThresholdChange = (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const next = Math.min(
      MAX_SYNC_MESSAGE_SIZE_THRESHOLD_MB,
      Math.max(MIN_SYNC_MESSAGE_SIZE_THRESHOLD_MB, Math.round(parsed)),
    )
    setSyncMsgThresholdMbState(next)
    if (syncThresholdTimer.current) clearTimeout(syncThresholdTimer.current)
    syncThresholdTimer.current = setTimeout(() => {
      setSyncMessageSizeThresholdMb(next).then(setSyncMsgThresholdMbState)
    }, 400)
  }

  return (
    <div className="page-root flex flex-col h-[500px]">
      <SubPageHeader title="设置" onBack={() => navigate('/')} />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 同步桥接设置 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground px-0.5">同步桥接</h3>

          <div className="card-soft flex items-center justify-between gap-3 p-3">
            <div className="flex items-center gap-2 min-w-0">
              {mcpStatus.connected ? (
                <PlugZap className="w-5 h-5 text-primary flex-shrink-0" />
              ) : (
                <Plug className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">CLI / MCP 连接</p>
                <p className="text-xs text-muted-foreground">
                  {mcpStatus.enabled
                    ? mcpStatus.connected
                      ? '已连接'
                      : '等待连接...'
                    : '未启用'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {mcpStatus.enabled && (
                <span
                  className={cn(
                    'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                    mcpStatus.connected
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {mcpStatus.connected ? '在线' : '离线'}
                </span>
              )}
              <Toggle on={mcpStatus.enabled} onClick={toggleMcp} disabled={loading} />
            </div>
          </div>

          {mcpStatus.enabled && (
            <div className="card-soft p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                供 CLI 和 MCP Server 通过 WebSocket 桥接同步文章
              </p>
              {mcpStatus.token && (
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Token</p>
                  <code className="block bg-muted/50 p-1.5 rounded-md text-[11px] break-all select-all border border-border/60">
                    {mcpStatus.token}
                  </code>
                </div>
              )}
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">服务器地址（留空使用本地默认）</p>
                <input
                  type="text"
                  value={serverUrlInput}
                  onChange={(e) => handleServerUrlChange(e.target.value)}
                  placeholder="ws://localhost:9527"
                  className="input-soft font-mono"
                />
              </div>
            </div>
          )}
        </section>

        {/* 网页功能 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground px-0.5">网页功能</h3>

          <div className="card-soft flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">悬浮同步按钮</p>
              <p className="text-xs text-muted-foreground">网页右下角快捷同步</p>
            </div>
            <Toggle on={floatingButtonEnabled} onClick={toggleFloatingButton} />
          </div>

          <div className="card-soft flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">实时检测文章</p>
              <p className="text-xs text-muted-foreground">
                总开关：关闭后首页不会随切页自动检测；开启后可由顶栏雷达控制当前是否检测
              </p>
            </div>
            <Toggle on={realtimeDetect} onClick={toggleRealtimeDetect} />
          </div>
        </section>

        {/* 同步传输 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground px-0.5">同步</h3>

          <div className="card-soft p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">同步消息体积阈值（MB）</p>
                <p className="text-xs text-muted-foreground">
                  超过该大小时正文经本地存储传递，避免 Chrome 消息约 64MB 上限报错；不限制文章能否同步。
                  默认 {DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB}，可调 {MIN_SYNC_MESSAGE_SIZE_THRESHOLD_MB}–
                  {MAX_SYNC_MESSAGE_SIZE_THRESHOLD_MB}。
                </p>
              </div>
              <input
                type="number"
                min={MIN_SYNC_MESSAGE_SIZE_THRESHOLD_MB}
                max={MAX_SYNC_MESSAGE_SIZE_THRESHOLD_MB}
                value={syncMsgThresholdMb}
                onChange={(e) => handleSyncThresholdChange(e.target.value)}
                className="input-soft w-16 text-center font-mono tabular-nums"
              />
            </div>
          </div>
        </section>

        {/* 本地导入缓存 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground px-0.5">本地导入</h3>

          <div className="card-soft p-3 space-y-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">标题来源</p>
              <p className="text-xs text-muted-foreground">
                默认：一级标题 → front matter → 文件名；也可指定优先来源，缺失时再兜底。
              </p>
            </div>
            <select
              value={localMdTitleSource}
              onChange={(e) => handleTitleSourceChange(e.target.value)}
              className="input-soft"
            >
              <option value="auto">自动（一级标题 → front matter → 文件名）</option>
              <option value="h1">优先一级标题</option>
              <option value="frontmatter">优先 front matter</option>
              <option value="filename">优先文件名</option>
            </select>
          </div>

          <div className="card-soft p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Markdown 缓存条数</p>
                <p className="text-xs text-muted-foreground">
                  缓存最近导入的本地 MD（含图片），历史追加同步时无需重选文件夹。默认 {DEFAULT_LOCAL_MD_CACHE_LIMIT}。
                </p>
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  当前占用：{formatCacheBytes(localMdCacheBytes)}
                </p>
              </div>
              <input
                type="number"
                min={MIN_LOCAL_MD_CACHE_LIMIT}
                max={MAX_LOCAL_MD_CACHE_LIMIT}
                value={localMdCacheLimit}
                onChange={(e) => handleCacheLimitChange(e.target.value)}
                className="input-soft w-16 text-center font-mono tabular-nums"
              />
            </div>
            <button
              type="button"
              onClick={handleClearLocalMdCache}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              清空本地 Markdown 缓存
            </button>
            {cacheClearHint && (
              <p className="text-[11px] text-primary">{cacheClearHint}</p>
            )}
          </div>
        </section>

        {/* 平台默认发布配置（P3） */}
        <PlatformConfigSection />
      </div>
    </div>
  )
}
