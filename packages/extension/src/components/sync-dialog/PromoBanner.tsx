import { useState, useEffect } from 'react'
import { X, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getActiveBanner, dismissBanner, type RemoteBanner } from '@/lib/remote-config'

const styleMap: Record<string, string> = {
  info: 'bg-primary/[0.06] border-primary/20 text-primary',
  promo: 'bg-gradient-to-br from-primary/[0.08] to-primary/[0.02] border-primary/20 text-foreground',
  warning: 'bg-amber-50 border-amber-200/80 text-amber-800',
}

export function PromoBanner() {
  const [banner, setBanner] = useState<RemoteBanner | null>(null)

  useEffect(() => {
    getActiveBanner().then(setBanner).catch(() => {})
  }, [])

  if (!banner) return null

  const handleDismiss = () => {
    setBanner(null)
    dismissBanner(banner.id)
  }

  return (
    <div className={cn(
      'rounded-lg border p-2.5 relative',
      styleMap[banner.style || 'info'],
    )}>
      {banner.dismissible !== false && (
        <button
          onClick={handleDismiss}
          className="absolute top-1.5 right-1.5 p-0.5 rounded-sm opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      )}
      <div className="flex items-start gap-2 pr-4">
        {banner.icon && <span className="text-base leading-5 flex-shrink-0">{banner.icon}</span>}
        <div className="min-w-0">
          <p className="font-medium text-xs leading-4">{banner.title}</p>
          {banner.description && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-4">{banner.description}</p>
          )}
          {banner.action && (
            <a
              href={banner.action.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-0.5 mt-1"
            >
              {banner.action.text}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
