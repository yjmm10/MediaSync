import type { PlatformCategory } from '@/lib/platform-categories'

export interface Platform {
  id: string
  name: string
  icon: string
  homepage?: string
  isAuthenticated: boolean
  username?: string
  /** UI 分组用；缺省时按 id 查映射表 */
  category?: PlatformCategory
}

export interface Article {
  title: string
  content: string
  summary?: string
  cover?: string
  /** front matter 结构化元数据 */
  frontmatter?: import('@/lib/article-meta').ArticleMeta
}

export interface SyncResult {
  platform: string
  platformName?: string
  success: boolean
  postUrl?: string
  draftOnly?: boolean
  message?: string
  error?: string
}

export type SyncStage = 'starting' | 'uploading_images' | 'saving' | 'completed' | 'failed'

export interface PlatformProgress {
  platform: string
  platformName: string
  stage: SyncStage
  imageProgress?: { current: number; total: number }
  error?: string
}

export type DialogStatus = 'loading' | 'idle' | 'syncing' | 'completed'

export interface SyncDialogProps {
  // Data
  article: Article | null
  platforms: Platform[]
  status: DialogStatus
  selectedPlatforms: string[]
  results: SyncResult[]
  platformProgress: Map<string, PlatformProgress>
  error: string | null
  /** 每平台本次同步实时参数 */
  platformParams?: Record<string, import('@mediasync/core').PublishParams>
  /** 勾选世代，配置面板用其强制刷新 FM 快照 */
  platformParamsEpoch?: Record<string, number>
  onPlatformParamsChange?: (platformId: string, params: import('@mediasync/core').PublishParams) => void

  // Actions
  onTogglePlatform: (id: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  /** 手动检测单个平台登录状态（未登录时点击 logo/名称） */
  onRecheckAuth?: (platformId: string) => void | Promise<void>
  onStartSync: () => void
  onRetryFailed: () => void
  onReset: () => void
  onCancel?: () => void

  // Optional
  onEditArticle?: () => void
  onClose?: () => void
  /** 完成态时显示「继续同步其他平台」入口 */
  onContinueSync?: () => void
  /** 关闭全局错误提示条 */
  onDismissError?: () => void
  className?: string
}
