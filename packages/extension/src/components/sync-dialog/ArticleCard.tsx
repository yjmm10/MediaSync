import { Check, FileText, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Article } from './types'

interface ArticleCardProps {
  article: Article | null
  onEdit?: () => void
  compact?: boolean
  /** idle 有稿：单行 strip，把垂直空间让给平台列表 */
  density?: 'full' | 'strip'
}

export function ArticleCard({ article, onEdit, compact, density = 'full' }: ArticleCardProps) {
  if (!article) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
        <div className="py-3 space-y-2">
          <div className="flex items-center justify-center text-muted-foreground">
            <FileText className="w-5 h-5 mr-2" />
            <span className="text-sm">当前页面未检测到文章</span>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            请在文章页面使用
          </p>
        </div>
      </div>
    )
  }

  if (compact || density === 'strip') {
    return (
      <div
        className={cn(
          'rounded-lg border border-border/70',
          density === 'strip'
            ? 'px-2.5 py-2 bg-gradient-to-br from-primary/[0.05] to-transparent border-primary/15'
            : 'p-3 bg-muted/30',
        )}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {article.cover && (
            <img
              src={article.cover}
              alt=""
              className={cn(
                'rounded-md object-cover flex-shrink-0',
                density === 'strip' ? 'w-10 h-10' : 'w-14 h-14',
              )}
            />
          )}
          <div className="flex-1 min-w-0">
            {density === 'strip' && (
              <div className="flex items-center gap-1 mb-0.5">
                <span className="grid place-items-center w-3 h-3 rounded-full bg-primary">
                  <Check className="w-2 h-2 text-primary-foreground" strokeWidth={3} />
                </span>
                <span className="text-[10px] font-medium text-primary">已识别</span>
              </div>
            )}
            <h2 className={cn('font-medium text-sm', density === 'strip' ? 'line-clamp-1' : 'line-clamp-2')}>
              {article.title}
            </h2>
          </div>
          {density === 'strip' && onEdit && (
            <button
              onClick={onEdit}
              className="flex-shrink-0 grid place-items-center w-7 h-7 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              title="同步前预览和调整内容"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-lg p-3 bg-gradient-to-br from-primary/[0.07] to-primary/[0.02] border border-primary/20">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="grid place-items-center w-4 h-4 rounded-full bg-primary">
          <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3} />
        </span>
        <span className="text-xs font-medium text-primary">
          已识别文章，选择平台后同步
        </span>
      </div>
      <div className="flex gap-3">
        {article.cover && (
          <img
            src={article.cover}
            alt=""
            className="w-16 h-16 rounded-md object-cover flex-shrink-0 ring-1 ring-black/5"
          />
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-medium text-sm line-clamp-2">{article.title}</h2>
          {article.summary && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
              {article.summary}
            </p>
          )}
        </div>
        {onEdit && (
          <button
            onClick={onEdit}
            className="flex-shrink-0 grid place-items-center w-7 h-7 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors self-start"
            title="同步前预览和调整内容"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
