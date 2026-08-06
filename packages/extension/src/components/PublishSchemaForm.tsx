/**
 * 按 publishSchema 渲染发布参数表单（设置页 / 同步页共用）
 *
 * 支持远程引用（remoteRef）：category/activity/topic/column/node 有 remoteRef
 * 且 remoteRefs[prop] 非空时，渲染 RemoteSelect（下拉选 id）；
 * 否则降级为 TextInput（手填 id）。
 *
 * selectMode:
 *   single   → 普通下拉
 *   multi    → 多选（chip 展示，max 限制上限）
 *   either-or → 选中时自动清互斥字段（eitherWith）
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { PublishParams, SchemaField } from '@mediasync/core'

type RemoteOption = { id: string; name: string }
type RemoteRefsMap = Record<string, RemoteOption[]>

export function PublishSchemaForm({
  fields,
  value,
  onChange,
  fieldKeyPrefix = '',
  remoteRefs = {},
}: {
  fields: SchemaField[]
  value: PublishParams
  onChange: (p: PublishParams) => void
  /** 切换平台时重置 TagsTextInput 等本地状态 */
  fieldKeyPrefix?: string
  /** 远程引用列表（如 { activities: [...], topics: [...], columns: [...] }） */
  remoteRefs?: RemoteRefsMap
}) {
  if (fields.length === 0) {
    return <p className="text-xs text-muted-foreground">该平台暂无可配置项</p>
  }

  return (
    <div className="space-y-2.5">
      {fields.map(field => (
        <FieldRenderer
          key={`${fieldKeyPrefix}:${field.key}`}
          field={field}
          value={value}
          onChange={onChange}
          remoteRefs={remoteRefs}
        />
      ))}
    </div>
  )
}

/** field.kind → remoteRefs key 映射 */
function getRefKey(kind: string, refKey?: string): string {
  switch (kind) {
    case 'activity': return 'activities'
    case 'topic': return 'topics'
    case 'category':
    case 'column': return 'columns'
    case 'node': return 'nodes'
    default: return refKey ?? kind
  }
}

function FieldRenderer({
  field,
  value,
  onChange,
  remoteRefs,
}: {
  field: SchemaField
  value: PublishParams
  onChange: (p: PublishParams) => void
  remoteRefs: RemoteRefsMap
}) {
  const get = (key: string): string => {
    const v = (value as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v })

  switch (field.kind) {
    case 'tags':
      return (
        <TagsTextInput
          label={field.label}
          help={
            field.help ??
            (field.max ? `用逗号分隔，最多 ${field.max} 个` : '用逗号分隔，如：前端, React')
          }
          max={field.max}
          tags={value.tags ?? []}
          onChange={tags => onChange({ ...value, tags })}
        />
      )
    case 'category':
    case 'column':
    case 'node':
    case 'activity':
    case 'topic': {
      // 有 remoteRef 且有列表 → RemoteSelect
      if (field.remoteRef) {
        const refKey = getRefKey(field.kind, (field as { refKey?: string }).refKey)
        const options = remoteRefs[refKey]
        if (options && options.length > 0) {
          return (
            <RemoteSelectInput
              label={field.label}
              help={
                field.help ??
                (field.selectMode === 'multi'
                  ? `可选 ${(field as { max?: number }).max ?? '多'} 个`
                  : field.selectMode === 'either-or'
                    ? `与${field.eitherWith ? '另一项' : ''}二选一`
                    : undefined)
              }
              value={get(field.key)}
              onChange={v => set(field.key, v)}
              options={options}
              selectMode={field.selectMode}
              max={(field as { max?: number }).max}
              onEitherClear={() => {
                if (field.eitherWith) {
                  onChange({ ...value, [field.eitherWith]: '' })
                }
              }}
            />
          )
        }
      }
      // 无远程列表 → TextInput（手填 id）
      return (
        <TextInput
          label={field.label}
          help={field.help}
          value={get(field.key)}
          onChange={v => set(field.key, v)}
          placeholder="id（可从平台编辑器地址栏复制）"
        />
      )
    }
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
          onChange={ts => onChange({ ...value, scheduleAt: ts, mode: ts ? 'schedule' : 'draft' })}
        />
      )
    case 'toggle': {
      const on = (value.extra?.[field.key] as boolean) ?? false
      return (
        <ToggleInput
          label={field.label}
          help={field.help}
          on={on}
          onClick={() => onChange({ ...value, extra: { ...value.extra, [field.key]: !on } })}
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

/**
 * 远程引用下拉（single / multi / either-or）
 * multi 时 value 为逗号分隔；either-or 选中后自动调 onEitherClear 清互斥字段
 */
function RemoteSelectInput({
  label,
  help,
  value,
  onChange,
  options,
  selectMode = 'single',
  max,
  onEitherClear,
}: {
  label: string
  help?: string
  value: string
  onChange: (v: string) => void
  options: RemoteOption[]
  selectMode?: 'single' | 'multi' | 'either-or'
  max?: number
  onEitherClear?: () => void
}) {
  const selectedIds =
    selectMode === 'multi'
      ? value.split(',').map(s => s.trim()).filter(Boolean)
      : value
        ? [value]
        : []

  const handleSelect = (id: string) => {
    if (selectMode === 'multi') {
      const next = selectedIds.includes(id)
        ? selectedIds.filter(i => i !== id)
        : [...selectedIds, id].slice(0, max ?? 99)
      onChange(next.join(','))
    } else {
      onChange(id)
      if (selectMode === 'either-or' && onEitherClear) {
        onEitherClear()
      }
    }
  }

  const placeholder =
    selectMode === 'multi' ? '＋ 添加…' : selectMode === 'either-or' ? '— 不选（二选一）—' : '— 不选 —'

  return (
    <div>
      <FieldLabel label={label} help={help} />
      <select
        value=""
        onChange={e => {
          if (e.target.value) handleSelect(e.target.value)
        }}
        className="input-soft"
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o.id} value={o.id} disabled={selectMode === 'multi' && selectedIds.includes(o.id)}>
            {o.name}
          </option>
        ))}
      </select>
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {selectedIds.map(id => {
            const opt = options.find(o => o.id === id)
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded"
              >
                {opt?.name ?? id}
                <button
                  type="button"
                  onClick={() => {
                    if (selectMode === 'multi') {
                      handleSelect(id)
                    } else {
                      onChange('')
                    }
                  }}
                  className="hover:text-destructive leading-none"
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TagsTextInput({
  label,
  help,
  tags,
  max,
  onChange,
}: {
  label: string
  help?: string
  tags: string[]
  max?: number
  onChange: (tags: string[]) => void
}) {
  const [text, setText] = useState(() => tags.join(', '))

  const parseTags = (raw: string): string[] => {
    let next = raw.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    if (typeof max === 'number' && max > 0) {
      next = next.slice(0, max)
    }
    return next
  }

  return (
    <div>
      <FieldLabel label={label} help={help} />
      <input
        type="text"
        value={text}
        onChange={e => {
          const raw = e.target.value
          setText(raw)
          onChange(parseTags(raw))
        }}
        onBlur={() => {
          const next = parseTags(text)
          onChange(next)
          setText(next.join(', '))
        }}
        placeholder="用逗号分隔，如：前端, React"
        className="input-soft"
      />
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
