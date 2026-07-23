import { HashRouter, Routes, Route } from 'react-router-dom'
import { HomeNew } from './pages/HomeNew'
import { AddCMSPage } from './pages/AddCMS'
import { HistoryPage } from './pages/History'
import { AboutPage } from './pages/About'
import { SettingsPage } from './pages/Settings'
import { ImportPage } from './pages/ImportPage'
import { EditPage } from './pages/EditPage'

export default function App() {
  return (
    <HashRouter>
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
