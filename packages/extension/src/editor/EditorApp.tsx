import { useState, useEffect, useCallback, useMemo } from 'react'
import { X, Loader2 } from 'lucide-react'
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

type EditorMode = 'edit' | 'preview'

/** 把文章内容统一成 markdown 源码（供分屏编辑） */
function toMarkdownSource(article: EditorArticle): string {
  if (article.markdown) return article.markdown
  const content = article.content || ''
  if (/<[a-z][\s\S]*>/i.test(content)) return htmlToMarkdownNative(content)
  return content
}

/**
 * 整页编辑/预览 overlay：预览与编辑均可改稿；同步在侧栏完成。
 */
export function EditorApp() {
  const [article, setArticle] = useState<EditorArticle | null>(null)
  const [mode, setMode] = useState<EditorMode>('edit')
  const [mdText, setMdText] = useState('')
  const [title, setTitle] = useState('')

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data.type === 'ARTICLE_DATA') {
          const art = data.article as EditorArticle
          setArticle(art)
          setTitle(art.title || '')
          setMdText(toMarkdownSource(art))
          if (data.mode === 'preview') {
            setMode('preview')
          } else {
            setMode('edit')
          }
        }
      } catch (e) {
        logger.error('Failed to parse message:', e)
      }
    }

    window.addEventListener('message', handleMessage)
    window.parent.postMessage(JSON.stringify({ type: 'EDITOR_READY' }), '*')
    return () => window.removeEventListener('message', handleMessage)
  }, [])

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

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="flex-shrink-0 bg-white border-b shadow-sm z-50">
        <div className="px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <img src={chrome.runtime.getURL('assets/icon-48.png')} alt="Logo" className="w-5 h-5" />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="font-medium text-gray-800 bg-transparent outline-none border-b border-transparent focus:border-blue-300 min-w-0 flex-1"
              placeholder="文章标题"
            />
            <span className="text-xs text-gray-400 flex-shrink-0">
              {mode === 'preview' ? '预览（可编辑，关闭后回写侧栏）' : '编辑（关闭后在侧栏同步）'}
            </span>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors" title="关闭并保存到侧栏">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-2 divide-x bg-white">
        <div className="min-h-0 flex flex-col">
          <div className="px-3 py-1 text-[11px] text-gray-400 border-b">Markdown 源码</div>
          <textarea
            value={mdText}
            onChange={(e) => setMdText(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full p-4 text-sm font-mono resize-none outline-none"
            style={{ minHeight: 0 }}
          />
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
    </div>
  )
}
