/**
 * 单个已选平台行内的发布参数折叠面板
 */
import { useEffect, useRef, useState } from 'react'
import type { PublishParams, PublishSchema, PublishRefs } from '@mediasync/core'
import { mergeParams } from '@mediasync/core'
import { SchemaParamsForm } from '@/components/publish/SchemaParamsForm'
import { toPersistablePublishParams } from '@/lib/platform-publish-config'

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

interface PlatformInlinePublishConfigProps {
  platformId: string
  params?: PublishParams
  onChangeParams: (params: PublishParams) => void
}

export function PlatformInlinePublishConfig({
  platformId,
  params,
  onChangeParams,
}: PlatformInlinePublishConfigProps) {
  const [cfg, setCfg] = useState<PlatformConfigState | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const loadingRef = useRef(false)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const onChangeRef = useRef(onChangeParams)
  onChangeRef.current = onChangeParams
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (cfg || loadingRef.current) return
    loadingRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'GET_PLATFORM_PUBLISH_CONFIG',
          payload: { platformId },
        })
        if (cancelled || resp?.error || !resp?.publishSchema) return
        const defaults = resp.publishDefaults as PublishParams | undefined
        const saved = resp.saved as PublishParams | undefined
        const existing = paramsRef.current
        const merged = mergeParams(defaults, saved, existing)
        setCfg({
          schema: resp.publishSchema as PublishSchema,
          params: merged,
          refs: (resp.refs as PublishRefs) || null,
          updatedAt: (resp.updatedAt as number) || null,
        })
        if (!existing) onChangeRef.current(merged)
      } finally {
        loadingRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [platformId, cfg])

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
      setCfg((prev) =>
        prev
          ? {
              ...prev,
              refs: resp.refs as PublishRefs,
              updatedAt: resp.updatedAt as number,
            }
          : prev,
      )
    } finally {
      setRefreshing(false)
    }
  }

  if (!cfg) {
    return <p className="text-[11px] text-muted-foreground px-1 py-1">加载配置…</p>
  }

  return (
    <SchemaParamsForm
      schema={cfg.schema}
      value={params ?? cfg.params}
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
