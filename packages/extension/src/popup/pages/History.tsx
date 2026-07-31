import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { MainHeader } from '../components/MainHeader'
import { HistoryList } from '../components/HistoryList'
import { trackPageView } from '../../lib/analytics'

/** 独立同步历史页 */
export function HistoryPage() {
  const navigate = useNavigate()

  useEffect(() => {
    trackPageView('history').catch(() => {})
  }, [])

  return (
    <div className="page-root flex flex-col h-[500px]">
      <MainHeader onLogoClick={() => navigate('/')} />
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <HistoryList />
      </div>
    </div>
  )
}
