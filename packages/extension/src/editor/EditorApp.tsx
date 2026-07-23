import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SyncDialog } from '@/components/sync-dialog'
import type { Platform, SyncResult, PlatformProgress, Article as DialogArticle } from '@/components/sync-dialog/types'
import { markdownToHtml, htmlToMarkdownNative } from '@mediasync/core'
import { createLogger } from '../lib/logger'

const logger = createLogger('Editor')

interface EditorArticle {
  title: string
  content: string
  markdown?: string
  cover?: string
  url?: string
  extractor?: string
}

type SyncStatus = 'idle' | 'syncing' | 'completed'
type EditorMode = 'edit' | 'preview'

const SELECTED_PLATFORMS_KEY = 'selectedPlatforms'

function saveSelectedPlatforms(platformIds: string[]) {
  chrome.storage.local.set({ [SELECTED_PLATFORMS_KEY]: platformIds }).catch((e) => {
    logger.error('Failed to save selected platforms:', e)
  })
}

/** 把文章内容统一成 markdown 源码（供分屏编辑） */
function toMarkdownSource(article: EditorArticle): string {
  if (article.markdown) return article.markdown
  const content = article.content || ''
  // content 若已是 markdown（无 HTML 标签）直接用，否则从 HTML 转
  if (/<[a-z][\s\S]*>/i.test(content)) return htmlToMarkdownNative(content)
  return content
}

export function EditorApp() {
  const [article, setArticle] = useState<EditorArticle | null>(null)
  const [mode, setMode] = useState<EditorMode>('edit')
  const [mdText, setMdText] = useState('')
  const [title, setTitle] = useState('')

  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [results, setResults] = useState<SyncResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [platformProgress, setPlatformProgress] = useState<Map<string, PlatformProgress>>(new Map())
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null)
  const currentSyncIdRef = useRef<string | null>(null)
  const [showSyncDialog, setShowSyncDialog] = useState(false)

  useEffect(() => {
    currentSyncIdRef.current = currentSyncId
  }, [currentSyncId])

  // Receive messages from parent window (content script)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data

        if (data.syncId) {
          if (!currentSyncIdRef.current) {
            setCurrentSyncId(data.syncId)
          } else if (data.syncId !== currentSyncIdRef.current) {
            return
          }
        }

        if (data.type === 'ARTICLE_DATA') {
          const art = data.article as EditorArticle
          setArticle(art)
          setTitle(art.title || '')
          setMdText(toMarkdownSource(art))
          if (data.mode === 'preview') {
            setMode('preview')
          }
        } else if (data.type === 'PLATFORMS_DATA') {
          setPlatforms(data.platforms)
          if (data.selectedPlatformIds && data.selectedPlatformIds.length > 0) {
            setSelectedPlatforms(data.selectedPlatformIds)
            saveSelectedPlatforms(data.selectedPlatformIds)
          } else {
            chrome.storage.local.get(SELECTED_PLATFORMS_KEY).then((result) => {
              const stored = result[SELECTED_PLATFORMS_KEY] as string[] | undefined
              const authIds = (data.platforms as Platform[])
                .filter((p) => p.isAuthenticated).map((p) => p.id)
              const authSet = new Set(authIds)
              setSelectedPlatforms(stored ? stored.filter(id => authSet.has(id)) : [])
            }).catch(() => setSelectedPlatforms([]))
          }
        } else if (data.type === 'SYNC_PROGRESS' && data.result) {
          setResults(prev => [...prev, data.result])
        } else if (data.type === 'SYNC_DETAIL_PROGRESS') {
          const progress = data.progress
          if (progress?.platform) {
            setPlatformProgress(prev => {
              const next = new Map(prev)
              next.set(progress.platform, progress)
              return next
            })
          }
        } else if (data.type === 'SYNC_COMPLETE') {
          setStatus('completed')
          if (data.rateLimitWarning) {
            setRateLimitWarning(data.rateLimitWarning)
            setTimeout(() => setRateLimitWarning(null), 8000)
          }
        } else if (data.type === 'SYNC_ERROR') {
          setError(data.error)
          setStatus('idle')
        }
      } catch (e) {
        logger.error('Failed to parse message:', e)
      }
    }

    window.addEventListener('message', handleMessage)
    window.parent.postMessage(JSON.stringify({ type: 'EDITOR_READY' }), '*')
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Auto-detect completion
  useEffect(() => {
    if (status === 'syncing' && results.length > 0 && results.length >= selectedPlatforms.length) {
      setStatus('completed')
    }
  }, [results.length, selectedPlatforms.length, status])

  const handleClose = useCallback(() => {
    const html = markdownToHtml(mdText)
    window.parent.postMessage(JSON.stringify({
      type: 'CLOSE_EDITOR',
      article: {
        title,
        markdown: mdText,
        content: html,
        html,
        cover: article?.cover,
      },
    }), '*')
  }, [article, title, mdText])

  const renderedHtml = useMemo(() => markdownToHtml(mdText), [mdText])

  const buildEditedArticle = useCallback(() => {
    if (!article) return null
    const html = markdownToHtml(mdText)
    return {
      ...article,
      title,
      markdown: mdText,
      content: html,
    }
  }, [article, title, mdText])

  const handleTogglePlatform = (id: string) => {
    setSelectedPlatforms(prev => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      const next = Array.from(set)
      saveSelectedPlatforms(next)
      return next
    })
  }
  const handleSelectAll = () => {
    const allIds = platforms.filter(p => p.isAuthenticated).map(p => p.id)
    setSelectedPlatforms(allIds)
    saveSelectedPlatforms(allIds)
  }
  const handleDeselectAll = () => {
    setSelectedPlatforms([])
    saveSelectedPlatforms([])
  }

  const startSync = (platformsToSync: string[]) => {
    const edited = buildEditedArticle()
    if (!edited || platformsToSync.length === 0) return
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)
    setStatus('syncing')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())
    window.parent.postMessage(JSON.stringify({
      type: 'START_SYNC',
      article: edited,
      platforms: platformsToSync,
      syncId,
    }), '*')
  }

  const handleStartSync = () => startSync(selectedPlatforms)
  const handleRetryFailed = () => {
    const failed = results.filter(r => !r.success).map(r => r.platform)
    if (failed.length === 0) return
    setResults(prev => prev.filter(r => r.success))
    startSync(failed)
  }
  const handleReset = () => {
    setStatus('idle')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())
    setCurrentSyncId(null)
    setShowSyncDialog(false)
  }

  if (!article) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400 mx-auto" />
          <p className="mt-2 text-gray-500">加载中...</p>
        </div>
      </div>
    )
  }

  const dialogArticle: DialogArticle | null = article
    ? { title, content: renderedHtml, cover: article.cover }
    : null
  const authenticatedCount = platforms.filter(p => p.isAuthenticated).length

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Toolbar */}
      <header className="flex-shrink-0 bg-white border-b shadow-sm z-50">
        <div className="px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <img src={chrome.runtime.getURL('assets/icon-48.png')} alt="Logo" className="w-5 h-5" />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              readOnly={mode === 'preview'}
              className="font-medium text-gray-800 bg-transparent outline-none border-b border-transparent focus:border-blue-300 min-w-0 flex-1"
              placeholder="文章标题"
            />
            <span className="text-xs text-gray-400 flex-shrink-0">
              {mode === 'preview' ? '预览模式' : '编辑（左源码 · 右渲染）'}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {mode === 'edit' && (
              <button
                onClick={() => setShowSyncDialog(true)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                  authenticatedCount > 0
                    ? 'bg-blue-500 text-white hover:bg-blue-600'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                )}
                disabled={authenticatedCount === 0}
              >
                同步{selectedPlatforms.length > 0 ? ` (${selectedPlatforms.length})` : ''}
              </button>
            )}
            <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors" title="关闭">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>
      </header>

      {rateLimitWarning && (
        <div className="flex-shrink-0 bg-yellow-50 border-b border-yellow-200 px-4 py-2 text-sm text-yellow-800 flex items-center gap-2">
          <span>⚠️</span>
          <p className="flex-1">{rateLimitWarning}</p>
          <button onClick={() => setRateLimitWarning(null)} className="text-yellow-600 hover:text-yellow-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 分屏：左 markdown 源码，右渲染 */}
      <main className="flex-1 min-h-0 grid grid-cols-2 divide-x bg-white">
        <div className="min-h-0 flex flex-col">
          <div className="px-3 py-1 text-[11px] text-gray-400 border-b">Markdown 源码</div>
          {mode === 'edit' ? (
            <textarea
              value={mdText}
              onChange={(e) => setMdText(e.target.value)}
              spellCheck={false}
              className="flex-1 w-full p-4 text-sm font-mono resize-none outline-none"
              style={{ minHeight: 0 }}
            />
          ) : (
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-gray-600 whitespace-pre-wrap break-words">{mdText}</pre>
          )}
        </div>
        <div className="min-h-0 flex flex-col">
          <div className="px-3 py-1 text-[11px] text-gray-400 border-b">渲染预览</div>
          <div className="flex-1 overflow-auto">
            <div className="preview-article p-6" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </div>
        </div>
      </main>

      <style>{`
        .preview-article { font-size: 14px; line-height: 1.75; color: #333; word-break: break-word; max-width: 760px; margin: 0 auto; }
        .preview-article p { margin: 1em 0; }
        .preview-article h1,.preview-article h2,.preview-article h3,.preview-article h4 { margin: 1.2em 0 0.6em; font-weight: 600; line-height: 1.3; }
        .preview-article h1 { font-size: 1.6em; }
        .preview-article h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: .3em; }
        .preview-article h3 { font-size: 1.2em; }
        .preview-article img { max-width: 100%; height: auto; margin: 1.2em 0; border-radius: 4px; }
        .preview-article pre { background: #f5f5f5; padding: 1em; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 1em 0; }
        .preview-article code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: .9em; }
        .preview-article pre code { background: none; padding: 0; }
        .preview-article blockquote { border-left: 4px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
        .preview-article ul,.preview-article ol { padding-left: 1.8em; margin: 1em 0; }
        .preview-article li { margin: .4em 0; }
        .preview-article a { color: #2563eb; text-decoration: underline; }
        .preview-article table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .preview-article th,.preview-article td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
        .preview-article th { background: #f5f5f5; font-weight: 600; }
        .preview-article hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
      `}</style>

      {/* Sync Dialog overlay */}
      {showSyncDialog && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => { if (status === 'idle') setShowSyncDialog(false) }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[400px] max-h-[520px] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-gray-900">文章同步</span>
              <button onClick={() => { if (status !== 'syncing') handleReset() }} className="p-1 rounded hover:bg-gray-100 transition-colors">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <SyncDialog
              article={dialogArticle}
              platforms={platforms}
              status={status === 'idle' ? 'idle' : status === 'syncing' ? 'syncing' : 'completed'}
              selectedPlatforms={selectedPlatforms}
              results={results}
              platformProgress={platformProgress}
              error={error}
              onTogglePlatform={handleTogglePlatform}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
              onStartSync={handleStartSync}
              onRetryFailed={handleRetryFailed}
              onReset={handleReset}
              onCancel={handleReset}
              className="max-h-[460px]"
            />
          </div>
        </div>
      )}

      {error && !showSyncDialog && (
        <div className="fixed bottom-4 left-4 bg-red-50 border border-red-200 rounded-lg p-4 max-w-sm z-50">
          <p className="text-red-700 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="mt-2 text-red-500 hover:underline text-sm">关闭</button>
        </div>
      )}
    </div>
  )
}
