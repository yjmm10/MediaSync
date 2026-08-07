/**
 * 文档元数据表单（front matter 结构化字段）
 * 仅用于 Markdown 编辑界面；不参与正文渲染。默认折叠以节省空间。
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ArticleMeta } from '@/lib/article-meta'
import { hasArticleMeta } from '@/lib/article-meta'
import { cn } from '@/lib/utils'

interface ArticleMetaFormProps {
  value?: ArticleMeta | null
  onChange: (next: ArticleMeta) => void
  /** 更紧凑的侧栏编辑样式 */
  compact?: boolean
  className?: string
  /** 初始是否展开；默认收起 */
  defaultOpen?: boolean
}

function TagsInput({
  tags,
  onChange,
}: {
  tags: string[]
  onChange: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...tags]
    for (const p of parts) {
      if (!next.includes(p)) next.push(p)
    }
    onChange(next)
    setDraft('')
  }

  return (
    <div className="flex flex-wrap gap-1.5 min-h-[32px] rounded-md border border-border/60 bg-background px-2 py-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary"
        >
          {t}
          <button
            type="button"
            className="opacity-70 hover:opacity-100"
            onClick={() => onChange(tags.filter((x) => x !== t))}
            aria-label={`移除 ${t}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[6rem] bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        value={draft}
        placeholder={tags.length === 0 ? '输入后回车或逗号添加' : '继续添加…'}
        onChange={(e) => {
          const v = e.target.value
          if (/[,，]/.test(v)) {
            commit(v)
            return
          }
          setDraft(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft)
        }}
      />
    </div>
  )
}

function summaryLine(meta: ArticleMeta): string {
  const parts: string[] = []
  if (meta.cover) parts.push('封面')
  if (meta.summary) parts.push('摘要')
  if (meta.category) parts.push(`分类:${meta.category}`)
  if (meta.tags && meta.tags.length > 0) {
    parts.push(`标签:${meta.tags.slice(0, 3).join('/')}${meta.tags.length > 3 ? '…' : ''}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '未填写'
}

export function ArticleMetaForm({
  value,
  onChange,
  compact,
  className,
  defaultOpen = false,
}: ArticleMetaFormProps) {
  const meta: ArticleMeta = value ?? {}
  const [open, setOpen] = useState(defaultOpen)

  const patch = (partial: Partial<ArticleMeta>) => {
    const next: ArticleMeta = { ...meta, ...partial }
    if (partial.cover !== undefined && !partial.cover) delete next.cover
    if (partial.summary !== undefined && !partial.summary) delete next.summary
    if (partial.category !== undefined && !partial.category) delete next.category
    if (partial.tags !== undefined && partial.tags.length === 0) delete next.tags
    onChange(next)
  }

  const filled = hasArticleMeta(meta)

  return (
    <div
      className={cn(
        'border-b border-border/60 bg-muted/20',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-1.5 text-left hover:bg-muted/40 transition-colors',
          compact ? 'px-2.5 py-1.5' : 'px-4 py-2',
        )}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-[11px] font-medium text-muted-foreground tracking-wide flex-shrink-0">
          文档元数据
        </span>
        {!open && (
          <span
            className={cn(
              'text-[10px] truncate min-w-0',
              filled ? 'text-foreground/70' : 'text-muted-foreground/70',
            )}
            title={summaryLine(meta)}
          >
            {summaryLine(meta)}
          </span>
        )}
        {open && (
          <span className="text-[10px] text-muted-foreground/80 ml-auto flex-shrink-0">
            来自 front matter · 不同步进正文
          </span>
        )}
      </button>

      {open && (
        <div className={cn('space-y-2', compact ? 'px-2.5 pb-2' : 'px-4 pb-3')}>
          {/* 封面（窄）+ 摘要（宽） */}
          <div className="flex gap-2 items-start">
            <label className="flex flex-col gap-1 w-[5.5rem] flex-shrink-0">
              <span className="text-xs text-muted-foreground">封面</span>
              <div className="relative">
                {meta.cover ? (
                  <img
                    src={meta.cover}
                    alt=""
                    className="w-[5.5rem] h-[5.5rem] rounded-md object-cover ring-1 ring-black/5 bg-muted"
                  />
                ) : (
                  <div className="w-[5.5rem] h-[5.5rem] rounded-md bg-muted/60 ring-1 ring-border/50 grid place-items-center text-[10px] text-muted-foreground">
                    无封面
                  </div>
                )}
              </div>
              <input
                type="text"
                className="w-full rounded-md border border-border/60 bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary/40"
                value={meta.cover ?? ''}
                placeholder="URL"
                title={meta.cover || '封面 URL'}
                onChange={(e) => patch({ cover: e.target.value || undefined })}
              />
            </label>

            <label className="flex-1 min-w-0 flex flex-col gap-1 self-stretch">
              <span className="text-xs text-muted-foreground">摘要</span>
              <textarea
                className="flex-1 w-full min-h-[5.5rem] rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/40 resize-y"
                value={meta.summary ?? ''}
                placeholder="abstract / summary"
                onChange={(e) => patch({ summary: e.target.value || undefined })}
              />
            </label>
          </div>

          {/* 分类 | 标签 */}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2">
            <label className="block space-y-1 min-w-0">
              <span className="text-xs text-muted-foreground">分类（博客园→合集）</span>
              <input
                type="text"
                className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/40"
                value={meta.category ?? ''}
                placeholder="category → 合集"
                onChange={(e) => patch({ category: e.target.value || undefined })}
              />
            </label>

            <div className="space-y-1 min-w-0">
              <span className="text-xs text-muted-foreground">标签</span>
              <TagsInput
                tags={meta.tags ?? []}
                onChange={(tags) => patch({ tags })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
