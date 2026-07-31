import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { HomeNew } from './pages/HomeNew'
import { AddCMSPage } from './pages/AddCMS'
import { HistoryPage } from './pages/History'
import { AboutPage } from './pages/About'
import { SettingsPage } from './pages/Settings'
import { ImportPage } from './pages/ImportPage'
import { EditPage } from './pages/EditPage'

const POPUP_ROUTE_KEY = 'popupLastRoute'
/** 流程页：不可被 RouteMemory 恢复，避免打断导入/编辑 */
const NO_RESTORE_ROUTES = new Set(['/import', '/edit'])

/** 记忆当前路由：popup 失焦关闭后再次打开仍回到离开时的页面 */
function RouteMemory() {
  const location = useLocation()
  const navigate = useNavigate()
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const pathAtStart = location.pathname
    Promise.all([
      chrome.storage.local.get('pendingRoute'),
      chrome.storage.session.get(POPUP_ROUTE_KEY),
    ])
      .then(async ([local, session]) => {
        // 侧栏/popup 显式 pendingRoute 优先（如打开导入页）
        if (local.pendingRoute) return
        const saved = session[POPUP_ROUTE_KEY]
        if (
          typeof saved !== 'string' ||
          !saved ||
          saved === '/' ||
          saved === pathAtStart ||
          NO_RESTORE_ROUTES.has(saved)
        ) {
          return
        }
        // 二次确认：避免 HomeNew 已消费 pendingRoute 后的竞态恢复
        const again = await chrome.storage.local.get('pendingRoute')
        if (again.pendingRoute) return
        navigate(saved, { replace: true })
      })
      .catch(() => {})
  }, [navigate, location.pathname])

  useEffect(() => {
    const path = location.pathname || '/'
    chrome.storage.session.set({ [POPUP_ROUTE_KEY]: path }).catch(() => {})
  }, [location.pathname])

  return null
}

export default function App() {
  return (
    <HashRouter>
      <RouteMemory />
      <div className="flex flex-col h-full min-h-[500px]">
        <Routes>
          <Route path="/" element={<HomeNew />} />
          <Route path="/add-cms" element={<AddCMSPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/edit" element={<EditPage />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
