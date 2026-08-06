import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SubPageHeaderProps {
  title: string
  onBack: () => void
  right?: ReactNode
  className?: string
}

/** 二级页共用顶栏：返回 + 标题（与主路径视觉语言一致） */
export function SubPageHeader({ title, onBack, right, className }: SubPageHeaderProps) {
  return (
    <header
      className={cn(
        'flex-shrink-0 relative flex items-center gap-2 px-4 py-2.5',
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <button
        type="button"
        onClick={onBack}
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label="返回"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <h1 className="text-sm font-semibold tracking-tight text-foreground flex-1 min-w-0 truncate">
        {title}
      </h1>
      {right}
    </header>
  )
}
