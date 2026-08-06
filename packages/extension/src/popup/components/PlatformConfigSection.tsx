/**
 * 平台默认发布配置（P3c 最小 demo）
 *
 * 选平台 → 按该平台 publishSchema 自动渲染表单 → 保存到
 * chrome.storage.local.platformSettings[id]（syncToPlatform 合并时读取）。
 *
 * 这是简化版 SchemaForm：支持 tags / category / column / node / activity /
 * topic / cover / summary / subtitle / originalType / visibility / comments /
 * reward / schedule / toggle。远程列表（category/activity）暂以 id 文本输入，
 * P3c 完整版会换成带缓存的远程 Select。
 */
import { useState, useEffect } from 'react'
import { Save, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAllPlatformMetas, getPlatformProfile } from '../../adapters'
import { getSavedParams, setSavedParams, clearSavedParams } from '../../lib/platform-settings'
import type { PublishParams, SchemaField, PlatformProfile } from '@mediasync/core'

export function PlatformConfigSection() {
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [profile, setProfile] = useState<PlatformProfile | null>(null)
  const [params, setParams] = useState<PublishParams>({})
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    const metas = getAllPlatformMetas()
    setPlatforms(metas.map(m => ({ id: m.id, name: m.name })))
    if (metas.length) setSelectedId(metas[0].id)
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const p = getPlatformProfile(selectedId)
    setProfile(p)
    getSavedParams(selectedId).then(saved => {
      setParams({ ...(p?.publishDefaults ?? {}), ...(saved ?? {}) })
    })
  }, [selectedId])

  const handleSave = async () => {
    if (!selectedId) return
    // 只保存用户实际改动的字段（去掉 publishDefaults 注入的初始值同名项也无所谓，合并时会兜底）
    await setSavedParams(selectedId, params)
    setHint('已保存')
    setTimeout(() => setHint(null), 1800)
  }

  const handleClear = async () => {
    if (!selectedId) return
    await clearSavedParams(selectedId)
    setParams({ ...(profile?.publishDefaults ?? {}) })
    setHint('已恢复默认')
    setTimeout(() => setHint(null), 1800)
  }

  const fields = profile?.publishSchema?.fields ?? []

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground px-0.5">平台默认发布配置</h3>
      <div className="card-soft p-3 space-y-3">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="input-soft"
        >
          {platforms.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">该平台暂无可配置项（仅按默认行为同步）</p>
        ) : (
          <div className="space-y-2.5">
            {fields.map(field => (
              <FieldRenderer
                key={field.key}
                field={field}
                value={params}
                onChange={setParams}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1 border-t border-border/40 mt-2">
          <button
            type="button"
            onClick={handleSave}
            className="btn-brand px-3 py-1.5 text-xs inline-flex items-center gap-1"
          >
            <Save className="w-3 h-3" /> 保存
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors inline-flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> 恢复默认
          </button>
          {hint && <span className="text-[11px] text-primary ml-auto">{hint}</span>}
        </div>
      </div>
    </section>
  )
}

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: SchemaField
  value: PublishParams
  onChange: (p: PublishParams) => void
}) {
  const get = (key: string): string => {
    const v = (value as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v })

  switch (field.kind) {
    case 'tags':
      return (
        <TextInput
          label={field.label}
          help={field.help}
          value={(value.tags ?? []).join(', ')}
          onChange={v =>
            onChange({
              ...value,
              tags: v.split(/[,，]/).map(s => s.trim()).filter(Boolean),
            })
          }
          placeholder="用逗号分隔，如：前端, React"
        />
      )
    case 'category':
    case 'column':
    case 'node':
    case 'activity':
    case 'topic':
      return (
        <TextInput
          label={field.label}
          help={field.help}
          value={get(field.key)}
          onChange={v => set(field.key, v)}
          placeholder="id（可从平台编辑器地址栏复制）"
        />
      )
    case 'cover':
      return (
        <TextInput
          label={field.label}
          help={field.help}
          value={value.cover ?? ''}
          onChange={v => onChange({ ...value, cover: v })}
          placeholder="图片 URL，或 auto（首图）/ none"
        />
      )
    case 'summary':
    case 'subtitle':
      return (
        <TextInput
          label={field.label}
          help={field.help}
          value={get(field.key)}
          onChange={v => set(field.key, v)}
          placeholder={field.kind === 'summary' ? '留空则由平台自动生成' : ''}
          multiline
        />
      )
    case 'originalType':
      return (
        <SelectInput
          label={field.label}
          help={field.help}
          value={value.originalType ?? ''}
          onChange={v =>
            onChange({ ...value, originalType: (v || undefined) as PublishParams['originalType'] })
          }
          options={[{ value: '', label: '默认' }, ...field.options]}
        />
      )
    case 'visibility':
      return (
        <SelectInput
          label={field.label}
          help={field.help}
          value={value.visibility ?? ''}
          onChange={v => onChange({ ...value, visibility: v || undefined })}
          options={[{ value: '', label: '默认' }, ...field.options]}
        />
      )
    case 'comments':
      return (
        <ToggleInput
          label={field.label}
          help={field.help}
          on={value.commentsEnabled ?? false}
          onClick={() => onChange({ ...value, commentsEnabled: !value.commentsEnabled })}
        />
      )
    case 'reward':
      return (
        <ToggleInput
          label={field.label}
          help={field.help}
          on={value.reward ?? false}
          onClick={() => onChange({ ...value, reward: !value.reward })}
        />
      )
    case 'schedule':
      if (!field.enabled) return null
      return (
        <DateTimeInput
          label={field.label}
          help={field.help}
          value={value.scheduleAt}
          onChange={ts =>
            onChange({ ...value, scheduleAt: ts, mode: ts ? 'schedule' : 'draft' })
          }
        />
      )
    case 'toggle': {
      const on = (value.extra?.[field.key] as boolean) ?? false
      return (
        <ToggleInput
          label={field.label}
          help={field.help}
          on={on}
          onClick={() =>
            onChange({ ...value, extra: { ...value.extra, [field.key]: !on } })
          }
        />
      )
    }
    default:
      return null
  }
}

function FieldLabel({ label, help }: { label: string; help?: string }) {
  return (
    <div className="mb-1">
      <span className="text-[11px] font-medium text-foreground">{label}</span>
      {help && <p className="text-[10px] text-muted-foreground">{help}</p>}
    </div>
  )
}

function TextInput({
  label,
  help,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string
  help?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
}) {
  return (
    <div>
      <FieldLabel label={label} help={help} />
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="input-soft resize-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="input-soft"
        />
      )}
    </div>
  )
}

function SelectInput({
  label,
  help,
  value,
  onChange,
  options,
}: {
  label: string
  help?: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <div>
      <FieldLabel label={label} help={help} />
      <select value={value} onChange={e => onChange(e.target.value)} className="input-soft">
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function ToggleInput({
  label,
  help,
  on,
  onClick,
}: {
  label: string
  help?: string
  on: boolean
  onClick: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <FieldLabel label={label} help={help} />
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'relative h-5 w-9 flex-shrink-0 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
            on ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  )
}

function DateTimeInput({
  label,
  help,
  value,
  onChange,
}: {
  label: string
  help?: string
  value?: number
  onChange: (ts: number | undefined) => void
}) {
  const local = value
    ? new Date(value - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : ''
  return (
    <div>
      <FieldLabel label={label} help={help} />
      <input
        type="datetime-local"
        value={local}
        onChange={e => {
          const v = e.target.value
          onChange(v ? new Date(v).getTime() : undefined)
        }}
        className="input-soft"
      />
    </div>
  )
}
