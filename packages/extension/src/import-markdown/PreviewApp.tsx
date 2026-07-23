import { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { createLogger } from '../lib/logger'

const logger = createLogger('PreviewApp')

const PREVIEW_ARTICLE_KEY = 'previewArticle'

interface PreviewData {
  title?: string
  markdown?: string
  html?: string
  cover?: string
}

/**
 * 完整页面预览：从 storage 读取由侧边栏「展开为完整页面」写入的文章，
 * 提供更大的阅读版面（长文/大图）。不在侧边栏内做导入，故本页只负责渲染。
 */
export function PreviewApp() {
  const [data, setData] = useState<PreviewData | null>(null)
  const [tab, setTab] = useState<'render' | 'markdown'>('render')

  useEffect(() => {
    chrome.storage.local
      .get(PREVIEW_ARTICLE_KEY)
      .then((r) => {
        const d = r[PREVIEW_ARTICLE_KEY] as PreviewData | undefined
        if (d && (d.html || d.markdown)) {
          setData(d)
          logger.info('载入预览:', d.title)
        }
      })
      .catch((e) => logger.error('读取预览数据失败:', e))
  }, [])

  if (!data) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-gray-500 text-sm">没有可预览的内容</p>
          <p className="text-gray-400 text-xs mt-1">请先在侧边栏导入后点「展开为完整页面」</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b shadow-sm">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => window.close()}
              className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"
              title="关闭"
            >
              <ArrowLeft className="w-4 h-4 text-gray-500" />
            </button>
            <span className="font-medium text-gray-800 truncate">{data.title || '预览'}</span>
          </div>
          <div className="flex gap-1 flex-shrink-0">
            <button
              onClick={() => setTab('render')}
              className={`px-3 py-1.5 text-sm rounded-lg ${tab === 'render' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              渲染预览
            </button>
            <button
              onClick={() => setTab('markdown')}
              className={`px-3 py-1.5 text-sm rounded-lg ${tab === 'markdown' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              Markdown 源码
            </button>
          </div>
        </div>
      </header>

      {/* 封面 */}
      {data.cover && tab === 'render' && (
        <div className="flex-shrink-0 max-w-3xl mx-auto w-full px-6 pt-6">
          <img src={data.cover} alt="" className="w-full max-h-72 object-cover rounded-lg" />
        </div>
      )}

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto w-full px-6 py-6">
          {tab === 'render' ? (
            <div className="preview-article bg-white rounded-lg shadow-sm p-8" dangerouslySetInnerHTML={{ __html: data.html || '' }} />
          ) : (
            <pre className="bg-white rounded-lg shadow-sm p-6 text-sm whitespace-pre-wrap break-all font-mono text-gray-700">
              {data.markdown}
            </pre>
          )}
        </div>
      </main>

      <style>{`
        .preview-article { font-size: 15px; line-height: 1.75; color: #333; word-break: break-word; }
        .preview-article p { margin: 1em 0; }
        .preview-article h1, .preview-article h2, .preview-article h3, .preview-article h4 { margin: 1.2em 0 0.6em; font-weight: 600; line-height: 1.3; }
        .preview-article h1 { font-size: 1.6em; }
        .preview-article h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
        .preview-article h3 { font-size: 1.2em; }
        .preview-article img { max-width: 100%; height: auto; margin: 1.2em 0; border-radius: 4px; }
        .preview-article pre { background: #f5f5f5; padding: 1em; border-radius: 6px; overflow-x: auto; font-size: 13px; margin: 1em 0; }
        .preview-article code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        .preview-article pre code { background: none; padding: 0; }
        .preview-article blockquote { border-left: 4px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
        .preview-article ul, .preview-article ol { padding-left: 1.8em; margin: 1em 0; }
        .preview-article li { margin: 0.4em 0; }
        .preview-article a { color: #2563eb; text-decoration: underline; }
        .preview-article table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .preview-article th, .preview-article td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
        .preview-article th { background: #f5f5f5; font-weight: 600; }
        .preview-article hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
      `}</style>
    </div>
  )
}
