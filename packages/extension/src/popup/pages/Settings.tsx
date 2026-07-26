import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Plug, PlugZap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackFeatureDiscovery } from '../../lib/analytics'

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
  const [sidePanelOnActionClick, setSidePanelOnActionClick] = useState(true)
  const [realtimeDetect, setRealtimeDetect] = useState(true)
  const [serverUrlInput, setServerUrlInput] = useState('')
  const serverUrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

    chrome.storage.local.get('sidePanelOnActionClick', (result) => {
      setSidePanelOnActionClick(result.sidePanelOnActionClick ?? true)
    })

    chrome.storage.local.get('realtimeDetect', (result) => {
      setRealtimeDetect(result.realtimeDetect ?? true)
    })
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

  const toggleSidePanelOnActionClick = () => {
    const next = !sidePanelOnActionClick
    setSidePanelOnActionClick(next)
    chrome.storage.local.set({ sidePanelOnActionClick: next })
  }

  const toggleRealtimeDetect = () => {
    const next = !realtimeDetect
    setRealtimeDetect(next)
    chrome.storage.local.set({ realtimeDetect: next })
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        返回
      </button>

      <h2 className="text-sm font-medium mb-4">设置</h2>

      <div className="flex-1 overflow-y-auto space-y-6">
        {/* 同步桥接设置 */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">同步桥接</h3>

          <div className="flex items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center gap-2 min-w-0">
              {mcpStatus.connected ? (
                <PlugZap className="w-5 h-5 text-green-500 flex-shrink-0" />
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
            <Toggle on={mcpStatus.enabled} onClick={toggleMcp} disabled={loading} />
          </div>

          {mcpStatus.enabled && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                供 CLI 和 MCP Server 通过 WebSocket 桥接同步文章
              </p>
              {mcpStatus.token && (
                <div className="p-2 bg-muted/50 rounded text-xs">
                  <p className="text-muted-foreground mb-1">Token:</p>
                  <code className="block bg-background p-1.5 rounded break-all select-all">
                    {mcpStatus.token}
                  </code>
                </div>
              )}
              <div className="p-2 bg-muted/50 rounded text-xs">
                <p className="text-muted-foreground mb-1">服务器地址 (留空使用本地默认):</p>
                <input
                  type="text"
                  value={serverUrlInput}
                  onChange={(e) => handleServerUrlChange(e.target.value)}
                  placeholder="ws://localhost:9527"
                  className="w-full bg-background p-1.5 rounded border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          )}
        </div>

        {/* 网页功能 */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">网页功能</h3>

          <div className="flex items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="min-w-0">
              <p className="text-sm font-medium">悬浮同步按钮</p>
              <p className="text-xs text-muted-foreground">网页右下角快捷同步</p>
            </div>
            <Toggle on={floatingButtonEnabled} onClick={toggleFloatingButton} />
          </div>

          <div className="flex items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="min-w-0">
              <p className="text-sm font-medium">点击图标打开侧边栏</p>
              <p className="text-xs text-muted-foreground">关闭则弹出小窗口</p>
            </div>
            <Toggle on={sidePanelOnActionClick} onClick={toggleSidePanelOnActionClick} />
          </div>

          <div className="flex items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="min-w-0">
              <p className="text-sm font-medium">实时检测文章</p>
              <p className="text-xs text-muted-foreground">
                总开关：关闭后首页不会随切页自动检测；开启后可由顶栏雷达控制当前是否检测
              </p>
            </div>
            <Toggle on={realtimeDetect} onClick={toggleRealtimeDetect} />
          </div>
        </div>
      </div>
    </div>
  )
}
