import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { markdownToHtml, htmlToMarkdownNative } from '@mediasync/core'
import { useSyncStore } from '../stores/sync'

/**
 * 分屏 Markdown 编辑（左源码 · 右渲染）。
 * 加载 store.article，编辑实时回写 store.markdown/html，与同步流程统一。
 */
export function EditPage() {
  const navigate = useNavigate()
  const article = useSyncStore(s => s.article)
  const updateArticle = useSyncStore(s => s.updateArticle)

  const [mdText, setMdText] = useState('')
  const initedRef = useRef(false)

  useEffect(() => {
    if (initedRef.current || !article) return
    initedRef.current = true
    const initial = article.markdown
      || htmlToMarkdownNative(article.html || article.content || '')
      || article.content
      || ''
    setMdText(initial)
    // 进入编辑视为锁定，避免实时检测覆盖
    updateArticle({ source: 'edited' })
  }, [article, updateArticle])

  const renderedHtml = useMemo(() => markdownToHtml(mdText), [mdText])

  const handleChange = (next: string) => {
    setMdText(next)
    const html = markdownToHtml(next)
    updateArticle({ markdown: next, html, content: html })
  }

  if (!article) {
    return (
      <div className="p-4 h-full flex flex-col">
        <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> 返回
        </button>
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          没有可编辑的文章
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0">
        <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> 返回
        </button>
        <span className="text-xs text-muted-foreground">编辑（左源码 · 右预览）</span>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-2 divide-x">
        <textarea
          value={mdText}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full h-full p-3 text-xs font-mono resize-none outline-none bg-background border-0"
          spellCheck={false}
        />
        <div className="overflow-auto">
          <div className="preview-article p-4" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        </div>
      </div>
      <style>{`
        .preview-article { font-size: 13px; line-height: 1.7; color: #333; word-break: break-word; }
        .preview-article p { margin: 0.8em 0; }
        .preview-article h1,.preview-article h2,.preview-article h3 { margin: 1em 0 0.5em; font-weight: 600; }
        .preview-article img { max-width: 100%; height: auto; margin: 1em 0; }
        .preview-article pre { background: #f5f5f5; padding: 0.8em; border-radius: 6px; overflow-x: auto; font-size: 11px; }
        .preview-article code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; }
        .preview-article pre code { background: none; padding: 0; }
        .preview-article blockquote { border-left: 3px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
        .preview-article ul,.preview-article ol { padding-left: 1.5em; margin: 1em 0; }
        .preview-article a { color: #2563eb; }
        .preview-article table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .preview-article th,.preview-article td { border: 1px solid #ddd; padding: 6px 10px; }
      `}</style>
    </div>
  )
}
