import { useState, useRef, useCallback, useEffect, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, AlertTriangle, FileText } from 'lucide-react'
import { loadMarkdownFromFiles, type ImportStats } from '../../lib/local-markdown'
import { pushLocalMdCache } from '../../lib/local-md-cache'
import { useSyncStore } from '../stores/sync'
import { SubPageHeader } from '../components/SubPageHeader'
import { createLogger } from '../../lib/logger'

const logger = createLogger('ImportPage')

/**
 * 本地 Markdown 导入入口：仅负责「选文件夹 → 解析 md 与本地图片（转 data URI）」，
 * 解析完成后把文章交给 sync store（source='import'，锁定不实时检测）并回到首页。
 */
export function ImportPage() {
  const navigate = useNavigate()
  const setArticle = useSyncStore(s => s.setArticle)

  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [lastStats, setLastStats] = useState<ImportStats | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  const handleInputChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList)
    e.target.value = ''

    setImporting(true)
    setImportError(null)
    setImportProgress({ done: 0, total: 0 })
    setLastStats(null)

    try {
      const outcome = await loadMarkdownFromFiles(files, {
        onProgress: (done, total) => setImportProgress({ done, total }),
      })
      if (!outcome) {
        setImportError('所选文件夹中未找到 Markdown 文件（.md / .markdown）')
        return
      }
      setLastStats(outcome.stats)
      logger.info(
        `导入完成: ${outcome.article.title}, 图片 ${outcome.stats.convertedImages}/${outcome.stats.totalImages}`
      )
      await pushLocalMdCache({
        title: outcome.article.title,
        markdown: outcome.article.markdown || '',
        html: outcome.article.html || '',
        cover: outcome.article.cover,
        fileName: outcome.stats.markdownFileName,
      })
      setArticle(
        {
          title: outcome.article.title,
          content: outcome.article.html,
          html: outcome.article.html,
          markdown: outcome.article.markdown,
          cover: outcome.article.cover,
        },
        'import'
      )
      navigate('/')
    } catch (err) {
      logger.error('导入失败:', err)
      setImportError('导入失败：' + (err as Error).message)
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }, [setArticle, navigate])

  const handleSelectFolder = () => inputRef.current?.click()

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.click(), 0)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="page-root flex flex-col h-[500px]">
      <SubPageHeader title="导入 Markdown" onBack={() => navigate('/')} />

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleInputChange}
        {...({ webkitdirectory: '', directory: '' } as any)}
      />

      <div className="flex-1 flex flex-col items-center justify-center p-4">
        <div className="card-soft w-full max-w-sm p-5 text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-primary/10 flex items-center justify-center">
            <FileText className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-base font-semibold tracking-tight mb-1.5">导入本地 Markdown</h2>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">
            选择 md 所在文件夹，自动读取其中的
            <code className="mx-0.5 px-1 py-0.5 bg-muted rounded text-[10px]">.md</code>
            及其本地图片。导入后在首页统一预览、编辑、同步。
          </p>

          {importing ? (
            <div className="flex items-center justify-center gap-2 text-primary">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-xs tabular-nums">
                {importProgress && importProgress.total > 0
                  ? `处理图片 ${importProgress.done}/${importProgress.total}`
                  : '读取文件...'}
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleSelectFolder}
              className="btn-brand w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium"
            >
              <FolderOpen className="w-4 h-4" />
              <span>选择 Markdown 所在文件夹</span>
            </button>
          )}

          {importError && (
            <div className="mt-3 flex items-start gap-2 text-left p-2.5 bg-destructive/[0.06] border border-destructive/20 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0 mt-px" />
              <p className="text-[11px] text-destructive">{importError}</p>
            </div>
          )}

          {lastStats && (lastStats.totalImages > 0 || lastStats.failedImages.length > 0) && (
            <div className="mt-3 text-[11px] text-muted-foreground tabular-nums">
              图片：{lastStats.convertedImages}/{lastStats.totalImages} 成功
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
