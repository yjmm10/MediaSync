import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive'
  size?: 'default' | 'sm' | 'lg' | 'icon'
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    return (
      <button
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50',
          // Variants
          variant === 'default' &&
            'bg-gradient-to-b from-primary to-primary-strong text-primary-foreground shadow-[0_1px_2px_rgba(20,40,30,0.10),0_4px_12px_-2px_rgba(22,163,74,0.30)] hover:shadow-[0_1px_2px_rgba(20,40,30,0.12),0_6px_16px_-2px_rgba(22,163,74,0.40)] hover:-translate-y-px active:translate-y-0',
          variant === 'outline' &&
            'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
          variant === 'ghost' &&
            'hover:bg-accent hover:text-accent-foreground',
          variant === 'destructive' &&
            'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
          // Sizes
          size === 'default' && 'h-9 px-4 py-2',
          size === 'sm' && 'h-8 rounded-md px-3 text-xs',
          size === 'lg' && 'h-11 rounded-md px-8',
          size === 'icon' && 'h-9 w-9',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button }
