import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PreviewApp } from './PreviewApp'
import '../popup/styles/globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>
)
