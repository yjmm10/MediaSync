import { useState, useRef, useEffect, useCallback, type ChangeEvent } from 'react'
import { FolderOpen, Loader2, AlertTriangle, X, FileText, Eye } from 'lucide-react'
import { SyncDialog } from '@/components/sync-dialog'
import type {
  Platform,
  SyncResult,
  PlatformProgress,
  Article as DialogArticle,
  DialogStatus,
} from '@/components/sync-dialog/types'
import { loadMarkdownFromFiles, uploadEmbeddedImages, type ImportedArticle, type ImportStats } from '../lib/local-markdown'
import { createLogger } from '../lib/logger'

const logger = createLogger('ImportApp')

const SELECTED_PLATFORMS_KEY = 'selectedPlatforms'

async function saveSelectedPlatforms(ids: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [SELECTED_PLATFORMS_KEY]: ids })
  } catch (e) {
    logger.error('保存平台选择失败:', e)
  }
}

async function loadSelectedPlatforms(authenticatedIds: string[]): Promise<string[]> {
  try {
    const result = await chrome.storage.local.get(SELECTED_PLATFORMS_KEY)
    const stored = result[SELECTED_PLATFORMS_KEY] as string[] | undefined
    if (!stored || stored.length === 0) return []
    const authSet = new Set(authenticatedIds)
    return stored.filter(id => authSet.has(id))
  } catch (e) {
    logger.error('读取平台选择失败:', e)
    return []
  }
}

export function ImportApp() {
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [imported, setImported] = useState<ImportedArticle | null>(null)
  const [stats, setStats] = useState<ImportStats | null>(null)

  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const [status, setStatus] = useState<DialogStatus>('loading')
  const [results, setResults] = useState<SyncResult[]>([])
  const [platformProgress, setPlatformProgress] = useState<Map<string, PlatformProgress>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [previewTab, setPreviewTab] = useState<'render' | 'markdown'>('render')
  const [uploadStage, setUploadStage] = useState<{ host: string; done: number; total: number } | null>(null)
  /**
   * 「继续同步」模式：完成态后可勾选更多平台再发一轮，已有结果保留并累加。
   * 为 true 时 status 视为 idle（让 SyncDialog/PlatformList 回到可选状态）。
   */
  const [continueMode, setContinueMode] = useState(false)

  const currentSyncIdRef = useRef<string | null>(null)
  useEffect(() => {
    currentSyncIdRef.current = currentSyncId
  }, [currentSyncId])

  const inputRef = useRef<HTMLInputElement>(null)

  // ============ 初始化：加载平台列表 ============
  useEffect(() => {
    const init = async () => {
      // 检测是否有从历史「追加同步」预加载的文档
      try {
        const preload = await chrome.storage.local.get('importPreloadArticle')
        const pre = preload.importPreloadArticle as
          | { title?: string; markdown?: string; html?: string; cover?: string; excludePlatforms?: string[] }
          | undefined
        if (pre && (pre.markdown || pre.html)) {
          setImported({
            title: pre.title || '未命名文章',
            markdown: pre.markdown || '',
            html: pre.html || '',
            cover: pre.cover,
          })
          setStats(null)
          setContinueMode(true)
          logger.info('已载入历史追加同步文档:', pre.title)
        }
        if (preload.importPreloadArticle) {
          await chrome.storage.local.remove('importPreloadArticle')
        }
      } catch (e) {
        logger.warn('读取预加载文档失败:', e)
      }

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CHECK_ALL_AUTH',
          payload: { forceRefresh: false },
        })
        const all: Platform[] = (response?.platforms || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          icon: p.icon,
          homepage: p.homepage,
          isAuthenticated: p.isAuthenticated,
          username: p.username,
        }))
        setPlatforms(all)
        const authIds = all.filter(p => p.isAuthenticated).map(p => p.id)
        setSelectedPlatforms(await loadSelectedPlatforms(authIds))
      } catch (e) {
        logger.error('加载平台列表失败:', e)
        setError('加载平台列表失败：' + (e as Error).message)
      } finally {
        setStatus('idle')
      }
    }
    init()
  }, [])

  // ============ 监听同步进度（按 syncId 过滤） ============
  useEffect(() => {
    const handler = (msg: any) => {
      if (!msg) return
      if (msg.syncId && msg.syncId !== currentSyncIdRef.current) return
      const type = msg.type as string
      if (type === 'SYNC_PROGRESS' && msg.payload?.result) {
        // 增量结果（实时显示），最终以 SYNC_ARTICLE 返回为准
        setResults(prev => [...prev, msg.payload.result as SyncResult])
      } else if (type === 'SYNC_DETAIL_PROGRESS' && msg.payload?.platform) {
        setPlatformProgress(prev => {
          const next = new Map(prev)
          next.set(msg.payload.platform, msg.payload as PlatformProgress)
          return next
        })
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  // ============ 选择文件夹并导入 ============
  const handleInputChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) {
      logger.debug('文件选择为空')
      return
    }
    // 先快照：重置 value 会清空 input.files 指向的 FileList，必须在此之前复制
    const files = Array.from(fileList)
    // 允许重复选择同一目录
    e.target.value = ''

    setImporting(true)
    setImportError(null)
    setImportProgress({ done: 0, total: 0 })
    // 重置上一次的同步状态
    setStatus('idle')
    setResults([])
    setPlatformProgress(new Map())
    setError(null)
    setCurrentSyncId(null)

    try {
      const outcome = await loadMarkdownFromFiles(files, {
        onProgress: (done, total) => setImportProgress({ done, total }),
      })
      if (!outcome) {
        setImportError('所选文件夹中未找到 Markdown 文件（.md / .markdown）')
        setImportProgress(null)
        return
      }
      setImported(outcome.article)
      setStats(outcome.stats)
      logger.info(
        `导入完成: ${outcome.article.title}, 图片 ${outcome.stats.convertedImages}/${outcome.stats.totalImages}`
      )
    } catch (err) {
      logger.error('导入失败:', err)
      setImportError('导入失败：' + (err as Error).message)
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }, [])

  const handleSelectFolder = () => inputRef.current?.click()

  // ============ 同步 ============
  const startSyncWith = useCallback(
    async (
      platformsToSync: string[],
      skipHistory: boolean,
      opts?: { merge?: boolean; keepResults?: string[] }
    ) => {
      if (!imported || platformsToSync.length === 0) return

      const merge = !!opts?.merge
      // 进入同步前先结算保留结果（合并模式下保留非本轮平台的结果）
      if (merge) {
        const syncingSet = new Set(platformsToSync)
        const keep = opts?.keepResults ?? []
        const keepSet = new Set(keep)
        setResults(prev =>
          prev.filter(r => keepSet.has(r.platform) && !syncingSet.has(r.platform))
        )
      }

      const syncId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      setCurrentSyncId(syncId)
      setContinueMode(false)
      setStatus('syncing')
      setError(null)
      setPlatformProgress(new Map())

      // 先把内嵌的 base64 图片上传到图床（用第一个目标平台），替换为短 URL，
      // 避免正文因 base64 过长触发平台字数/体积限制
      let markdown = imported.markdown
      let html = imported.html
      const hasEmbedded = /data:image\/[a-zA-Z0-9.+-]+;base64,/.test(markdown)
      if (hasEmbedded) {
        const host = platformsToSync[0]
        const hostName = platforms.find(p => p.id === host)?.name || host
        setUploadStage({ host, done: 0, total: 0 })
        try {
          const uploaded = await uploadEmbeddedImages(
            markdown,
            html,
            async (dataUri) => {
              const res = await chrome.runtime.sendMessage({
                type: 'UPLOAD_IMAGE',
                payload: { src: dataUri, platform: host },
              })
              if (res?.error) throw new Error(res.error)
              return res.result.url as string
            },
            (done, total) => setUploadStage({ host, done, total })
          )
          markdown = uploaded.markdown
          html = uploaded.html
          logger.info(`图片上传到 ${hostName}: ${uploaded.uploaded} 成功, ${uploaded.failed} 失败`)
        } catch (e) {
          logger.warn('图床上传失败，降级使用 base64:', e)
        } finally {
          setUploadStage(null)
        }
      }

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'SYNC_ARTICLE',
          payload: {
            article: {
              title: imported.title,
              content: html,
              html,
              markdown,
              cover: imported.cover,
            },
            platforms: platformsToSync,
            syncId,
            source: 'import',
            skipHistory,
          },
        })

        const newResults: SyncResult[] = response?.results || []
        const platformNameOf = (id: string) =>
          platforms.find(p => p.id === id)?.name || id
        const named = newResults.map(r => ({
          ...r,
          platformName: r.platformName || platformNameOf(r.platform),
        }))

        if (merge) {
          // 合并：本轮结果覆盖同平台旧结果，其余保留
          const syncingSet = new Set(platformsToSync)
          setResults(prev => {
            const kept = prev.filter(r => !syncingSet.has(r.platform))
            return [...kept, ...named]
          })
        } else {
          setResults(named)
        }
        setStatus('completed')
      } catch (err) {
        logger.error('同步失败:', err)
        setError((err as Error).message)
        setStatus('idle')
      }
    },
    [imported, platforms]
  )

  const handleStartSync = useCallback(() => {
    startSyncWith(selectedPlatforms, false)
  }, [selectedPlatforms, startSyncWith])

  const handleRetryFailed = useCallback(() => {
    const failed = results.filter(r => !r.success).map(r => r.platform)
    if (failed.length === 0 || !imported) return
    const success = results.filter(r => r.success).map(r => r.platform)
    startSyncWith(failed, true, { merge: true, keepResults: success })
  }, [results, imported, startSyncWith])

  /**
   * 进入「继续同步」模式：回到平台选择态，已成功平台默认不勾选（避免重复），
   * 失败/未同步平台默认勾选。已有结果保留，待新一轮同步时合并。
   */
  const handleContinueSync = useCallback(() => {
    const successIds = new Set(
      results.filter(r => r.success).map(r => r.platform)
    )
    const failedIds = results.filter(r => !r.success).map(r => r.platform)
    // 默认勾选：失败项 + 尚未有结果的已登录平台
    const haveResult = new Set(results.map(r => r.platform))
    const untouched = platforms
      .filter(p => p.isAuthenticated && !haveResult.has(p.id))
      .map(p => p.id)
    const nextSelected = Array.from(new Set([...failedIds, ...untouched]))
      .filter(id => !successIds.has(id))
    setSelectedPlatforms(nextSelected)
    setContinueMode(true)
    setStatus('idle')
    setError(null)
    setPlatformProgress(new Map())
  }, [results, platforms])

  const handleStartContinueSync = useCallback(() => {
    if (selectedPlatforms.length === 0) return
    const success = results.filter(r => r.success).map(r => r.platform)
    startSyncWith(selectedPlatforms, true, {
      merge: true,
      keepResults: success,
    })
  }, [selectedPlatforms, results, startSyncWith])

  const handleReset = useCallback(() => {
    setStatus('idle')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())
    setCurrentSyncId(null)
  }, [])

  // ============ 平台选择 ============
  const handleToggle = useCallback((id: string) => {
    setSelectedPlatforms(prev => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      const next = Array.from(set)
      saveSelectedPlatforms(next)
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    // 继续同步模式下，跳过已成功同步的平台，避免重复发布
    const successIds = new Set(
      results.filter(r => r.success).map(r => r.platform)
    )
    const all = platforms
      .filter(p => p.isAuthenticated && !successIds.has(p.id))
      .map(p => p.id)
    setSelectedPlatforms(all)
    saveSelectedPlatforms(all)
  }, [platforms, results])

  const handleDeselectAll = useCallback(() => {
    setSelectedPlatforms([])
    saveSelectedPlatforms([])
  }, [])

  // 传给 SyncDialog 的 article（仅展示字段）
  const dialogArticle: DialogArticle | null = imported
    ? { title: imported.title, content: imported.html, cover: imported.cover }
    : null

  const authenticatedCount = platforms.filter(p => p.isAuthenticated).length

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* 隐藏的目录选择 input */}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleInputChange}
        {...({ webkitdirectory: '', directory: '' } as any)}
      />

      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b shadow-sm">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={chrome.runtime.getURL('assets/icon-48.png')} alt="Logo" className="w-6 h-6" />
            <span className="font-medium text-gray-700">导入本地 Markdown 同步</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSelectFolder}
              disabled={importing || status === 'syncing'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              <span>{imported ? '重新选择' : '选择文件夹'}</span>
            </button>
            <button
              onClick={() => window.close()}
              className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
              title="关闭"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {!imported ? (
          // 引导区
          <div className="h-full flex items-center justify-center p-6">
            <div className="max-w-md w-full bg-white rounded-xl shadow-sm border p-8 text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-blue-50 flex items-center justify-center">
                <FileText className="w-7 h-7 text-blue-500" />
              </div>
              <h2 className="text-lg font-semibold text-gray-800 mb-2">导入本地 Markdown 文件</h2>
              <p className="text-sm text-gray-500 leading-relaxed mb-6">
                选择 Markdown 文件所在的文件夹，扩展会自动读取其中的
                <code className="mx-1 px-1 py-0.5 bg-gray-100 rounded text-xs">.md</code>
                文件及其引用的本地图片（如
                <code className="mx-1 px-1 py-0.5 bg-gray-100 rounded text-xs">./imgs/1.png</code>
                ），图片将上传到各平台图床。
              </p>

              {importing ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2 text-blue-600">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span className="text-sm">
                      {importProgress && importProgress.total > 0
                        ? `正在处理图片 ${importProgress.done}/${importProgress.total}`
                        : '正在读取文件...'}
                    </span>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleSelectFolder}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition-colors"
                >
                  <FolderOpen className="w-5 h-5" />
                  <span>选择 Markdown 所在文件夹</span>
                </button>
              )}

              {importError && (
                <div className="mt-4 flex items-start gap-2 text-left p-3 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{importError}</p>
                </div>
              )}

              <p className="mt-6 text-xs text-gray-400">
                已登录 {authenticatedCount} 个平台，可在导入后选择目标平台
              </p>
            </div>
          </div>
        ) : (
          // 同步区
          <div className="h-full flex flex-col max-w-2xl mx-auto w-full bg-white shadow-sm">
            {/* 图片导入结果提示 */}
            {stats && (stats.totalImages > 0 || stats.failedImages.length > 0) && (
              <div
                className={
                  stats.failedImages.length > 0
                    ? 'mx-4 mt-3 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2'
                    : 'mx-4 mt-3 p-2.5 rounded-lg bg-green-50 border border-green-200 text-xs text-green-700 flex items-start gap-2'
                }
              >
                {stats.failedImages.length > 0 ? (
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" />
                ) : null}
                <div className="flex-1">
                  <span>
                    图片处理：{stats.convertedImages}/{stats.totalImages} 张成功
                  </span>
                  {stats.failedImages.length > 0 && (
                    <span className="block text-amber-700 mt-0.5">
                      未找到：{stats.failedImages.map(f => f.ref).join(', ')}
                    </span>
                  )}
                </div>
              </div>
            )}

            {uploadStage && (
              <div className="mx-4 mt-3 p-2.5 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                <span>
                  正在上传图片到「{platforms.find(p => p.id === uploadStage.host)?.name || uploadStage.host}」图床
                  {uploadStage.total > 0 ? ` ${uploadStage.done}/${uploadStage.total}` : ''}
                </span>
              </div>
            )}

            {error && (
              <div className="mx-4 mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {error}
              </div>
            )}

            <div className="mx-4 mt-3 mb-1 flex items-center justify-end">
              <button
                onClick={() => setShowPreview(true)}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                <Eye className="w-3.5 h-3.5" />
                预览内容
              </button>
            </div>

            {continueMode && (
              <div className="mx-4 mt-1 p-2.5 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700">
                继续同步模式：勾选要补充同步的平台（已成功的平台已排除），点「同步到 N 个平台」追加同步，已有结果会保留。
              </div>
            )}

            <SyncDialog
              article={dialogArticle}
              platforms={platforms}
              status={continueMode ? 'idle' : status}
              selectedPlatforms={selectedPlatforms}
              results={results}
              platformProgress={platformProgress}
              error={error}
              onTogglePlatform={handleToggle}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
              onStartSync={continueMode ? handleStartContinueSync : handleStartSync}
              onRetryFailed={handleRetryFailed}
              onReset={handleReset}
              onCancel={handleReset}
              onContinueSync={handleContinueSync}
              className="flex-1 min-h-0"
            />
          </div>
        )}
      </main>

      {/* 内容预览浮层 */}
      {showPreview && imported && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setShowPreview(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b">
              <div className="flex gap-1">
                <button
                  onClick={() => setPreviewTab('render')}
                  className={`px-3 py-1 text-xs rounded ${previewTab === 'render' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  渲染预览
                </button>
                <button
                  onClick={() => setPreviewTab('markdown')}
                  className={`px-3 py-1 text-xs rounded ${previewTab === 'markdown' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  Markdown 源码
                </button>
              </div>
              <button onClick={() => setShowPreview(false)} title="关闭" className="p-1 rounded hover:bg-gray-100">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {previewTab === 'render' ? (
                <div className="preview-article p-6" dangerouslySetInnerHTML={{ __html: imported.html }} />
              ) : (
                <pre className="p-4 text-xs whitespace-pre-wrap break-all font-mono text-gray-700">
                  {imported.markdown}
                </pre>
              )}
            </div>
          </div>
          <style>{`
            .preview-article { font-size: 14px; line-height: 1.7; color: #333; word-break: break-word; }
            .preview-article p { margin: 0.8em 0; }
            .preview-article h1, .preview-article h2, .preview-article h3 { margin: 1em 0 0.5em; font-weight: 600; }
            .preview-article h1 { font-size: 1.5em; }
            .preview-article h2 { font-size: 1.3em; }
            .preview-article h3 { font-size: 1.1em; }
            .preview-article img { max-width: 100%; height: auto; margin: 1em 0; }
            .preview-article pre { background: #f5f5f5; padding: 0.8em; border-radius: 6px; overflow-x: auto; font-size: 12px; }
            .preview-article code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
            .preview-article pre code { background: none; padding: 0; }
            .preview-article blockquote { border-left: 3px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
            .preview-article ul, .preview-article ol { padding-left: 1.5em; margin: 1em 0; }
            .preview-article a { color: #2563eb; }
            .preview-article table { border-collapse: collapse; width: 100%; margin: 1em 0; }
            .preview-article th, .preview-article td { border: 1px solid #ddd; padding: 6px 10px; }
          `}</style>
        </div>
      )}
    </div>
  )
}
