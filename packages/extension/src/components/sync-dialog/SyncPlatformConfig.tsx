/**
 * 单个已选平台行内的发布参数折叠面板
 */
import { useEffect, useRef, useState } from 'react'
import type { PublishParams, PublishSchema, PublishRefs } from '@mediasync/core'
import { mergeParams } from '@mediasync/core'
import { SchemaParamsForm } from '@/components/publish/SchemaParamsForm'
import {
  stripFmDrivenFields,
  toPersistablePublishParams,
} from '@/lib/platform-publish-config'
import {
  applyFrontmatterToPublishParams,
  tryResolveCategoryId,
  type ArticleMeta,
} from '@/lib/article-meta'

interface PlatformConfigState {
  schema: PublishSchema
  params: PublishParams
  refs: PublishRefs | null
  updatedAt: number | null
}

export const SYNC_CONFIGURABLE_PLATFORM_IDS = new Set(['cnblogs'])

export function isSyncConfigurablePlatform(platformId: string): boolean {
  return SYNC_CONFIGURABLE_PLATFORM_IDS.has(platformId)
}

const PERSIST_DEBOUNCE_MS = 500

type RefOption = { id?: string; name?: string; value?: string; label?: string }

/** 用远程分类/合集列表把名称解析成 id（仅保留能匹配的项） */
function applyRefNameResolve(
  params: PublishParams,
  refs: PublishRefs | null,
  schema: PublishSchema,
): PublishParams {
  if (!refs) return params
  let next = params

  if (next.category) {
    const catField = schema.fields.find((f) => f.kind === 'category')
    if (catField && catField.kind === 'category') {
      const refKey = catField.refKey ?? 'categories'
      const options = (refs[refKey] as RefOption[] | undefined) ?? catField.options
      const resolved = tryResolveCategoryId(next.category, options)
      if (resolved) {
        next = { ...next, category: resolved }
      }
    }
  }

  if (next.columns?.length) {
    const colField = schema.fields.find((f) => f.kind === 'column' && f.key === 'columns')
    if (colField && colField.kind === 'column') {
      const refKey = colField.refKey ?? 'columns'
      const options = (refs[refKey] as RefOption[] | undefined) ?? colField.options
      const resolved = next.columns
        .map((c) => tryResolveCategoryId(c, options))
        .filter((id): id is string => !!id)
      if (resolved.length > 0) {
        next = { ...next, columns: resolved }
      }
    }
  }

  return next
}

interface PlatformInlinePublishConfigProps {
  platformId: string
  params?: PublishParams
  onChangeParams: (params: PublishParams) => void
  articleMeta?: ArticleMeta | null
  /** 勾选世代：变化时强制重载，避免旧请求盖回新 FM 快照 */
  paramsEpoch?: number
}

export function PlatformInlinePublishConfig({
  platformId,
  params,
  onChangeParams,
  articleMeta,
  paramsEpoch = 0,
}: PlatformInlinePublishConfigProps) {
  const [cfg, setCfg] = useState<PlatformConfigState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const onChangeRef = useRef(onChangeParams)
  onChangeRef.current = onChangeParams
  const metaRef = useRef(articleMeta)
  metaRef.current = articleMeta
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    setCfg(null)
    setLoadError(null)

    ;(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'GET_PLATFORM_PUBLISH_CONFIG',
          payload: { platformId },
        })
        if (cancelled) return

        if (resp?.error) {
          setLoadError(String(resp.error))
          return
        }
        if (!resp?.publishSchema) {
          setLoadError('该平台暂无发布配置 schema')
          return
        }

        const defaults = resp.publishDefaults as PublishParams | undefined
        const saved = resp.saved as PublishParams | undefined
        // 异步返回后再读一次会话快照，避免用到过期闭包
        const existing = paramsRef.current
        const schema = resp.publishSchema as PublishSchema
        const refs = (resp.refs as PublishRefs) || null
        const meta = metaRef.current

        // 设置缓存去掉 FM 字段；defaults 也去掉 FM，避免 cover/tags 等盖掉勾选快照
        const base = stripFmDrivenFields(mergeParams(defaults, stripFmDrivenFields(saved)))
        let merged: PublishParams
        if (existing && Object.keys(existing).length > 0) {
          // 会话快照（勾选时的 FM）绝对优先；缺省 mode 才从设置补
          merged = {
            ...base,
            ...existing,
            mode: existing.mode ?? saved?.mode ?? defaults?.mode ?? 'draft',
          }
          // 会话未带的 FM 字段保持清空（不让 defaults 里的 cover:auto 以外的东西混入）
          if (!existing.tags) delete merged.tags
          if (!existing.columns) delete merged.columns
          if (!existing.category) delete merged.category
          if (!existing.summary) delete merged.summary
          // cover：会话没有时可用平台默认 auto/none
          if (!existing.cover) {
            if (defaults?.cover === 'auto' || defaults?.cover === 'none') {
              merged.cover = defaults.cover
            } else {
              delete merged.cover
            }
          }
        } else {
          merged = applyFrontmatterToPublishParams(base, meta, {
            platformId,
            refs,
          })
          if (!merged.mode) merged.mode = saved?.mode ?? defaults?.mode ?? 'draft'
          if (!merged.cover && (defaults?.cover === 'auto' || defaults?.cover === 'none')) {
            merged.cover = defaults.cover
          }
        }
        merged = applyRefNameResolve(merged, refs, schema)
        setCfg({
          schema,
          params: merged,
          refs,
          updatedAt: (resp.updatedAt as number) || null,
        })
        // 写回会话：带上解析后的 id，但绝不引入旧 saved FM
        onChangeRef.current(merged)
      } catch (e) {
        if (!cancelled) {
          setLoadError((e as Error).message || '加载配置失败')
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // paramsEpoch：取消再勾选必变；不依赖 articleMeta（已勾选锁定快照）
  }, [platformId, reloadToken, paramsEpoch])

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [])

  const schedulePersist = (next: PublishParams) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      const persistable = toPersistablePublishParams(next)
      void chrome.runtime
        .sendMessage({
          type: 'SET_PLATFORM_PUBLISH_CONFIG',
          payload: { platformId, params: persistable },
        })
        .catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'FETCH_PLATFORM_PUBLISH_REFS',
        payload: { platformId },
      })
      if (resp?.error) return
      const refs = resp.refs as PublishRefs
      setCfg((prev) => {
        if (!prev) return prev
        const current = paramsRef.current ?? prev.params
        // 仅解析名称→id，不重新套用最新 FM
        const next = applyRefNameResolve(current, refs, prev.schema)
        if (
          next.category !== current.category ||
          JSON.stringify(next.columns) !== JSON.stringify(current.columns)
        ) {
          onChangeRef.current(next)
        }
        return {
          ...prev,
          refs,
          params: next,
          updatedAt: resp.updatedAt as number,
        }
      })
    } finally {
      setRefreshing(false)
    }
  }

  if (loadError) {
    return (
      <div className="px-1 py-1.5 space-y-1">
        <p className="text-[11px] text-destructive">{loadError}</p>
        <button
          type="button"
          className="text-[11px] text-primary hover:underline"
          onClick={() => setReloadToken((n) => n + 1)}
        >
          重试
        </button>
      </div>
    )
  }

  if (!cfg) {
    return <p className="text-[11px] text-muted-foreground px-1 py-1">加载配置…</p>
  }

  return (
    <SchemaParamsForm
      schema={cfg.schema}
      value={cfg.params}
      onChange={(next) => {
        setCfg((prev) => (prev ? { ...prev, params: next } : prev))
        onChangeParams(next)
        schedulePersist(next)
      }}
      refs={cfg.refs}
      updatedAt={cfg.updatedAt}
      onRefreshRefs={handleRefresh}
      refreshing={refreshing}
      showMode
    />
  )
}
