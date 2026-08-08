import type { ReactNode } from 'react'
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plug, PlugZap, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SubPageHeader } from '../components/SubPageHeader'
import { UserPlatformGroupsSection } from '../components/UserPlatformGroupsSection'
import { trackFeatureDiscovery } from '../../lib/analytics'
import { getAllPlatformMetas, getTabAuthPlatformIds, initAdapters } from '../../adapters'
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
import {
  getTabAuthAutoDetect,
  setTabAuthAutoDetect,
} from '../../lib/tab-auth-auto-detect'

interface McpStatus {
  enabled: boolean
  connected: boolean
  token?: string
  serverUrl?: string
}

type SettingsTab = 'general' | 'platform' | 'advanced'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'platform', label: '平台' },
  { id: 'advanced', label: '高级' },
]

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

function SettingRow({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: ReactNode
}) {
  return (
    <div className="card-soft flex items-start justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {desc && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>}
      </div>
      <div className="flex-shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

/**
 * 设置页（路由 /settings）：顶部分类切换，降低纵向堆叠噪音。
 */
export function SettingsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [groupsOpen, setGroupsOpen] = useState(true)
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({ enabled: false, connected: false })
  const [loading, setLoading] = useState(false)
  const [floatingButtonEnabled, setFloatingButtonEnabled] = useState(false)
  /** null = 尚未从 storage 读回，避免默认 true 造成「开→关」闪烁 */
  const [realtimeDetect, setRealtimeDetect] = useState<boolean | null>(null)
  const [tabAuthAutoDetect, setTabAuthAutoDetectState] = useState(false)
  const [tabAuthNames, setTabAuthNames] = useState<string[]>([])
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

    getTabAuthAutoDetect().then(setTabAuthAutoDetectState)

    initAdapters().then(() => {
      const ids = new Set(getTabAuthPlatformIds())
      const names = getAllPlatformMetas()
        .filter(m => ids.has(m.id))
        .map(m => m.name)
      setTabAuthNames(names)
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
    if (realtimeDetect === null) return
    const next = !realtimeDetect
    setRealtimeDetect(next)
    chrome.storage.local.set({ realtimeDetect: next })
  }

  const toggleTabAuthAutoDetect = () => {
    const next = !tabAuthAutoDetect
    setTabAuthAutoDetectState(next)
    setTabAuthAutoDetect(next)
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

      <div className="px-4 pt-2 pb-1">
        <div className="flex gap-1 p-0.5 rounded-lg bg-muted/70">
          {SETTINGS_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 py-1.5 rounded-md text-xs font-medium transition-colors',
                tab === t.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pt-2 space-y-3">
        {tab === 'general' && (
          <>
            <SettingRow
              title="悬浮同步按钮"
              desc="网页右下角快捷同步"
            >
              <Toggle on={floatingButtonEnabled} onClick={toggleFloatingButton} />
            </SettingRow>

            <SettingRow
              title="实时检测文章"
              desc="关闭后首页不会随切页自动检测；开启后可由顶栏雷达控制"
            >
              <Toggle
                on={realtimeDetect === true}
                onClick={toggleRealtimeDetect}
                disabled={realtimeDetect === null}
              />
            </SettingRow>

            <SettingRow
              title="开标签平台自动检测"
              desc={
                tabAuthNames.length > 0
                  ? `默认关闭。开启后全量刷新也可能为这些平台新建标签：${tabAuthNames.join('、')}`
                  : '默认关闭。开启后全量/TTL 刷新也可能为需页面鉴权的平台新建标签'
              }
            >
              <Toggle on={tabAuthAutoDetect} onClick={toggleTabAuthAutoDetect} />
            </SettingRow>

            <div className="card-soft p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">同步消息体积阈值（MB）</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    超过后正文经本地存储传递，避免消息体积上限。默认{' '}
                    {DEFAULT_SYNC_MESSAGE_SIZE_THRESHOLD_MB}。
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
          </>
        )}

        {tab === 'platform' && (
          <>
            <section className="space-y-2">
              <button
                type="button"
                onClick={() => setGroupsOpen(o => !o)}
                className="flex w-full items-center gap-1.5 px-0.5 text-left"
              >
                <h3 className="text-xs font-semibold text-muted-foreground flex-1">自定义分组</h3>
                <ChevronDown
                  className={cn(
                    'w-3.5 h-3.5 text-muted-foreground transition-transform',
                    groupsOpen && 'rotate-180',
                  )}
                />
              </button>
              {groupsOpen && <UserPlatformGroupsSection />}
            </section>
          </>
        )}

        {tab === 'advanced' && (
          <>
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

            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground px-0.5">本地导入</h3>

              <div className="card-soft p-3 space-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">标题来源</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    默认：一级标题 → 文件名
                  </p>
                </div>
                <select
                  value={localMdTitleSource}
                  onChange={(e) => handleTitleSourceChange(e.target.value)}
                  className="input-soft"
                >
                  <option value="auto">自动（一级标题 → 文件名）</option>
                  <option value="h1">优先一级标题</option>
                  <option value="filename">优先文件名</option>
                </select>
              </div>

              <div className="card-soft p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Markdown 缓存条数</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      默认 {DEFAULT_LOCAL_MD_CACHE_LIMIT}；当前占用{' '}
                      <span className="tabular-nums">{formatCacheBytes(localMdCacheBytes)}</span>
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
          </>
        )}
      </div>
    </div>
  )
}
