import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { markdownToHtml, htmlToMarkdownNative } from '@mediasync/core'
import { useSyncStore } from '../stores/sync'
import { MarkdownSplitEditor } from '@/components/MarkdownSplitEditor'
import { ArticleMetaForm } from '@/components/ArticleMetaForm'
import { SubPageHeader } from '../components/SubPageHeader'
import type { ArticleMeta } from '@/lib/article-meta'

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
    updateArticle({ source: 'edited' })
  }, [article, updateArticle])

  const handleChange = (next: string) => {
    setMdText(next)
    const html = markdownToHtml(next)
    updateArticle({ markdown: next, html, content: html })
  }

  const handleMetaChange = (frontmatter: ArticleMeta) => {
    updateArticle({
      frontmatter,
      cover: frontmatter.cover,
      summary: frontmatter.summary,
    })
  }

  if (!article) {
    return (
      <div className="page-root flex flex-col h-[500px]">
        <SubPageHeader title="编辑" onBack={() => navigate('/')} />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="rounded-lg border border-dashed border-border bg-muted/30 px-6 py-8 text-center">
            <p className="text-sm text-muted-foreground">没有可编辑的文章</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-root flex flex-col h-[500px]">
      <SubPageHeader
        title="编辑"
        onBack={() => navigate('/')}
        right={
          <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">
            左源码 · 右预览
          </span>
        }
      />
      <ArticleMetaForm
        value={article.frontmatter}
        onChange={handleMetaChange}
        compact
      />
      <MarkdownSplitEditor
        value={mdText}
        onChange={handleChange}
        compact
        className="flex-1 min-h-0"
      />
      <style>{`
        .preview-article { font-size: 13px; line-height: 1.7; color: #333; word-break: break-word; }
        .preview-article p { margin: 0.8em 0; }
        .preview-article h1,.preview-article h2,.preview-article h3 { margin: 1em 0 0.5em; font-weight: 600; }
        .preview-article img { max-width: 100%; height: auto; margin: 1em 0; display: block; }
        .preview-article pre { background: #f5f5f5; padding: 0.8em; border-radius: 6px; overflow-x: auto; font-size: 11px; }
        .preview-article code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; }
        .preview-article pre code { background: none; padding: 0; }
        .preview-article blockquote { border-left: 3px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
        .preview-article ul,.preview-article ol { padding-left: 1.5em; margin: 1em 0; }
        .preview-article a { color: #16a34a; }
        .preview-article table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .preview-article th,.preview-article td { border: 1px solid #ddd; padding: 6px 10px; }
        .preview-article .mermaid-preview,.preview-article .mermaid { margin: 1em 0; overflow-x: auto; text-align: center; }
        .preview-article .katex-display { margin: 0.8em 0; overflow-x: auto; }
      `}</style>
    </div>
  )
}
