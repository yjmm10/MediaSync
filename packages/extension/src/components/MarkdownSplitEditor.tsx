import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  collapseDataUris,
  countCollapsedPlaceholders,
  expandDataUris,
  type DataUriStore,
} from '@/lib/md-data-uri-fold'
import { enhancePreviewDom, renderMarkdownPreviewHtml } from '@/lib/markdown-preview'
import { cn } from '@/lib/utils'
import 'katex/dist/katex.min.css'

interface MarkdownSplitEditorProps {
  value: string
  onChange: (fullMarkdown: string) => void
  previewClassName?: string
  className?: string
  compact?: boolean
}

/**
 * 左 Markdown（base64 图折叠）· 右渲染预览（mermaid / 公式 / 图片）· 同步滚动
 */
export function MarkdownSplitEditor({
  value,
  onChange,
  previewClassName,
  className,
  compact,
}: MarkdownSplitEditorProps) {
  const storeRef = useRef<DataUriStore>(new Map())
  const [display, setDisplay] = useState(() => collapseDataUris(value, storeRef.current))
  const lastFullRef = useRef(value)

  const mdRef = useRef<HTMLTextAreaElement>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const previewArticleRef = useRef<HTMLDivElement>(null)
  const syncLock = useRef(false)

  useEffect(() => {
    if (value === lastFullRef.current) return
    lastFullRef.current = value
    storeRef.current = new Map()
    setDisplay(collapseDataUris(value, storeRef.current))
  }, [value])

  const fullMd = useMemo(() => expandDataUris(display, storeRef.current), [display])
  const renderedHtml = useMemo(() => renderMarkdownPreviewHtml(fullMd), [fullMd])
  const foldedCount = useMemo(() => countCollapsedPlaceholders(display), [display])

  // 写入 HTML 后渲染 mermaid / 补强图片
  useEffect(() => {
    const el = previewArticleRef.current
    if (!el) return
    el.innerHTML = renderedHtml
    let cancelled = false
    enhancePreviewDom(el).catch(() => {})
    return () => {
      cancelled = true
      void cancelled
    }
  }, [renderedHtml])

  const handleDisplayChange = (nextDisplay: string) => {
    let full = expandDataUris(nextDisplay, storeRef.current)
    const collapsed = collapseDataUris(full, storeRef.current)
    full = expandDataUris(collapsed, storeRef.current)
    setDisplay(collapsed)
    lastFullRef.current = full
    onChange(full)
  }

  const syncScroll = useCallback((from: 'md' | 'preview') => {
    if (syncLock.current) return
    const src = from === 'md' ? mdRef.current : previewScrollRef.current
    const dst = from === 'md' ? previewScrollRef.current : mdRef.current
    if (!src || !dst) return
    const maxSrc = src.scrollHeight - src.clientHeight
    const maxDst = dst.scrollHeight - dst.clientHeight
    if (maxSrc <= 0 || maxDst <= 0) return
    syncLock.current = true
    dst.scrollTop = (src.scrollTop / maxSrc) * maxDst
    requestAnimationFrame(() => {
      syncLock.current = false
    })
  }, [])

  return (
    <div className={cn('min-h-0 grid grid-cols-2 divide-x bg-white', className)}>
      <div className="min-h-0 flex flex-col">
        <div
          className={cn(
            'flex items-center justify-between gap-2 border-b text-gray-400',
            compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-[11px]',
          )}
        >
          <span>Markdown 源码</span>
          {foldedCount > 0 && (
            <span
              className="text-amber-600/90 truncate"
              title="超长 data URI 已折叠为 ⟦img:…⟧，保存/同步仍用完整内容"
            >
              已折叠 {foldedCount} 张 base64 图
            </span>
          )}
        </div>
        <textarea
          ref={mdRef}
          value={display}
          onChange={e => handleDisplayChange(e.target.value)}
          onScroll={() => syncScroll('md')}
          spellCheck={false}
          className={cn(
            'flex-1 w-full font-mono resize-none outline-none bg-transparent',
            compact ? 'p-3 text-xs' : 'p-4 text-sm',
          )}
          style={{ minHeight: 0 }}
        />
      </div>
      <div className="min-h-0 flex flex-col">
        <div
          className={cn(
            'border-b text-gray-400',
            compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-[11px]',
          )}
        >
          渲染预览
        </div>
        <div
          ref={previewScrollRef}
          className="flex-1 overflow-auto"
          onScroll={() => syncScroll('preview')}
        >
          <div
            ref={previewArticleRef}
            className={cn('preview-article', compact ? 'p-4' : 'p-6', previewClassName)}
          />
        </div>
      </div>
    </div>
  )
}
