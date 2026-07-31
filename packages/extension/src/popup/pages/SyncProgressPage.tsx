import { Navigate } from 'react-router-dom'

/**
 * 兼容旧「同步」路由：进度已回到主页 SyncDialog，历史在 /history。
 */
export function SyncProgressPage() {
  return <Navigate to="/" replace />
}
