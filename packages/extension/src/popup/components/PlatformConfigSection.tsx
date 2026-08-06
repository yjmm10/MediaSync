/**
 * 设置页：平台默认发布配置（手风琴折叠，按平台展开编辑）
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, RotateCcw, Save, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PublishSchemaForm } from '@/components/PublishSchemaForm'
import { getAllPlatformMetas, getPlatformProfile, initAdapters } from '../../adapters'
import { clearSavedParams, getSavedParams, hasSavedParams, setSavedParams } from '../../lib/platform-settings'
import type { PublishParams, SchemaField } from '@mediasync/core'

interface PlatformOption {
  id: string
  name: string
  fields: SchemaField[]
}

export function PlatformConfigSection() {
  const [platforms, setPlatforms] = useState<PlatformOption[]>([])
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [params, setParams] = useState<PublishParams>({})
  const [isCustomized, setIsCustomized] = useState(false)
  const [customizedMap, setCustomizedMap] = useState<Record<string, boolean>>({})
  const [remoteRefs, setRemoteRefs] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [hint, setHint] = useState<string | null>(null)
  const [sectionOpen, setSectionOpen] = useState(true)

  useEffect(() => {
    initAdapters().then(async () => {
      const list: PlatformOption[] = getAllPlatformMetas()
        .map(m => {
          const profile = getPlatformProfile(m.id)
          const fields = profile?.publishSchema?.fields ?? []
          return { id: m.id, name: m.name, fields }
        })
        .filter(p => p.fields.length > 0)
      setPlatforms(list)
      const flags: Record<string, boolean> = {}
      await Promise.all(
        list.map(async p => {
          flags[p.id] = await hasSavedParams(p.id)
        }),
      )
      setCustomizedMap(flags)
    })
  }, [])

  useEffect(() => {
    if (!expandedId) return
    const profile = getPlatformProfile(expandedId)
    Promise.all([getSavedParams(expandedId), hasSavedParams(expandedId)]).then(([saved, custom]) => {
      setParams({ ...(profile?.publishDefaults ?? {}), ...(saved ?? {}) })
      setIsCustomized(custom)
    })
  }, [expandedId])

  // 拉远程引用列表（活动/话题/专栏等）
  useEffect(() => {
    if (!expandedId) return
    setRemoteRefs({})
    chrome.runtime.sendMessage(
      { type: 'FETCH_REMOTE_REFS', payload: { platformId: expandedId } },
      (response: unknown) => {
        if (response && typeof response === 'object' && !('error' in (response as Record<string, unknown>))) {
          setRemoteRefs(response as Record<string, Array<{ id: string; name: string }>>)
        }
      },
    )
  }, [expandedId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return platforms
    return platforms.filter(
      p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }, [platforms, query])

  const showHint = (msg: string) => {
    setHint(msg)
    setTimeout(() => setHint(null), 1800)
  }

  const handleSave = async () => {
    if (!expandedId) return
    await setSavedParams(expandedId, params)
    setIsCustomized(true)
    setCustomizedMap(m => ({ ...m, [expandedId]: true }))
    showHint('已缓存到本地')
  }

  const handleClear = async () => {
    if (!expandedId) return
    await clearSavedParams(expandedId)
    const profile = getPlatformProfile(expandedId)
    setParams({ ...(profile?.publishDefaults ?? {}) })
    setIsCustomized(false)
    setCustomizedMap(m => ({ ...m, [expandedId]: false }))
    showHint('已还原系统默认')
  }

  const toggleExpand = (id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setSectionOpen(o => !o)}
        className="flex w-full items-center gap-1.5 px-0.5 text-left"
      >
        <h3 className="text-xs font-semibold text-muted-foreground flex-1">平台默认发布配置</h3>
        <span className="text-[10px] tabular-nums text-muted-foreground">{platforms.length}</span>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground transition-transform',
            sectionOpen && 'rotate-180',
          )}
        />
      </button>

      {sectionOpen && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground px-0.5 leading-relaxed">
            保存在浏览器本地缓存，与同步页共用；「还原系统默认」清除缓存并恢复适配器内置值。
          </p>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索平台…"
              className="input-soft h-8 pl-8 text-sm"
            />
          </div>

          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-3 text-center">无匹配平台</p>
            ) : (
              filtered.map(p => {
                const open = expandedId === p.id
                const cached = !!customizedMap[p.id]
                return (
                  <div key={p.id} className="card-soft overflow-hidden">
                    <button
                      type="button"
                      onClick={() => toggleExpand(p.id)}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/40 transition-colors"
                    >
                      <span className="text-sm font-medium truncate flex-1">{p.name}</span>
                      {cached && (
                        <span className="text-[10px] px-1 py-px rounded bg-primary/10 text-primary flex-shrink-0">
                          已缓存
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {p.fields.length} 项
                      </span>
                      <ChevronDown
                        className={cn(
                          'w-3.5 h-3.5 text-muted-foreground transition-transform flex-shrink-0',
                          open && 'rotate-180',
                        )}
                      />
                    </button>
                    {open && (
                      <div className="border-t border-border/60 px-2.5 py-2.5 space-y-2.5">
                        <PublishSchemaForm
                          fields={p.fields}
                          value={params}
                          onChange={setParams}
                          fieldKeyPrefix={`${p.id}:${isCustomized ? 'c' : 'd'}`}
                          remoteRefs={remoteRefs}
                        />
                        <div className="flex items-center gap-2 pt-1 border-t border-border/40">
                          <button
                            type="button"
                            onClick={handleSave}
                            className="btn-brand px-3 py-1.5 text-xs inline-flex items-center gap-1"
                          >
                            <Save className="w-3 h-3" /> 保存缓存
                          </button>
                          <button
                            type="button"
                            onClick={handleClear}
                            disabled={!isCustomized}
                            className={cn(
                              'text-xs inline-flex items-center gap-1 transition-colors',
                              isCustomized
                                ? 'text-muted-foreground hover:text-destructive'
                                : 'text-muted-foreground/40',
                            )}
                          >
                            <RotateCcw className="w-3 h-3" /> 还原系统默认
                          </button>
                          {hint && <span className="text-[11px] text-primary ml-auto">{hint}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </section>
  )
}
