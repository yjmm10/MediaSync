/**
 * 设置页：平台发布默认配置（选项源手动更新 + 缓存）
 */
import { useCallback, useEffect, useState } from 'react'
import type { PublishParams, PublishSchema, PublishRefs } from '@mediasync/core'
import { mergeParams } from '@mediasync/core'
import { SchemaParamsForm } from '@/components/publish/SchemaParamsForm'
import { toPersistablePublishParams } from '@/lib/platform-publish-config'
import { Loader2 } from 'lucide-react'

interface ConfigurablePlatform {
  id: string
  name: string
  icon?: string
  publishSchema?: PublishSchema
  publishDefaults?: PublishParams
}

export function PlatformConfigPanel() {
  const [platforms, setPlatforms] = useState<ConfigurablePlatform[]>([])
  const [platformId, setPlatformId] = useState('')
  const [schema, setSchema] = useState<PublishSchema | null>(null)
  const [defaults, setDefaults] = useState<PublishParams | undefined>()
  const [params, setParams] = useState<PublishParams>({})
  const [refs, setRefs] = useState<PublishRefs | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'LIST_CONFIGURABLE_PLATFORMS' })
        if (cancelled) return
        if (resp?.error) {
          setError(resp.error)
          return
        }
        const list = (resp?.platforms || []) as ConfigurablePlatform[]
        setPlatforms(list)
        if (list[0]) setPlatformId(list[0].id)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const loadConfig = useCallback(async (id: string) => {
    if (!id) return
    setError(null)
    setHint(null)
    const resp = await chrome.runtime.sendMessage({
      type: 'GET_PLATFORM_PUBLISH_CONFIG',
      payload: { platformId: id },
    })
    if (resp?.error) {
      setError(resp.error)
      return
    }
    const pubDefaults = resp.publishDefaults as PublishParams | undefined
    const saved = resp.saved as PublishParams | undefined
    setSchema((resp.publishSchema as PublishSchema) || null)
    setDefaults(pubDefaults)
    setParams(mergeParams(pubDefaults, saved, undefined))
    setRefs((resp.refs as PublishRefs) || null)
    setUpdatedAt((resp.updatedAt as number) || null)
  }, [])

  useEffect(() => {
    if (platformId) void loadConfig(platformId)
  }, [platformId, loadConfig])

  const handleRefresh = async () => {
    if (!platformId) return
    setRefreshing(true)
    setError(null)
    setHint(null)
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'FETCH_PLATFORM_PUBLISH_REFS',
        payload: { platformId },
      })
      if (resp?.error) {
        setError(resp.error)
        return
      }
      setRefs(resp.refs as PublishRefs)
      setUpdatedAt(resp.updatedAt as number)
      setHint('选项已更新并缓存')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  const handleSave = async () => {
    if (!platformId) return
    setSaving(true)
    setError(null)
    setHint(null)
    try {
      const persistable = toPersistablePublishParams(params)
      const resp = await chrome.runtime.sendMessage({
        type: 'SET_PLATFORM_PUBLISH_CONFIG',
        payload: { platformId, params: persistable },
      })
      if (resp?.error) {
        setError(resp.error)
        return
      }
      setParams(persistable)
      setHint('默认配置已保存')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="card-soft p-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        加载平台配置…
      </div>
    )
  }

  if (platforms.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-0.5">
        暂无可配置平台（当前已接入：博客园）
      </p>
    )
  }

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground px-0.5">发布默认配置</h3>
      <div className="card-soft p-3 space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">平台</span>
          <select
            className="input-soft w-full text-sm"
            value={platformId}
            onChange={(e) => setPlatformId(e.target.value)}
          >
            {platforms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {schema && (
          <SchemaParamsForm
            schema={schema}
            value={params}
            onChange={setParams}
            refs={refs}
            updatedAt={updatedAt}
            onRefreshRefs={handleRefresh}
            refreshing={refreshing}
            showMode
            excludeKeys={['cover']}
          />
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
        {hint && <p className="text-xs text-primary">{hint}</p>}
        <p className="text-[11px] text-muted-foreground">
          同步时修改也会自动记住；题图仅在同步侧配置。
        </p>

        <button
          type="button"
          className="btn-brand w-full text-sm"
          disabled={saving || !schema}
          onClick={() => void handleSave()}
        >
          {saving ? '保存中…' : '保存默认'}
        </button>
        {defaults && (
          <button
            type="button"
            className="btn-secondary w-full text-xs"
            onClick={() => setParams(mergeParams(defaults, undefined, undefined))}
          >
            恢复适配器默认
          </button>
        )}
      </div>
    </section>
  )
}
