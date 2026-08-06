/**
 * Schema 驱动的发布参数表单（设置默认值 / 同步折叠实时参数共用）
 */
import { useMemo, useState } from 'react'
import type { PublishParams, PublishSchema, PublishRefs, SchemaField } from '@mediasync/core'
import { cn } from '@/lib/utils'
import { isRefsEmpty } from '@/lib/platform-publish-config'
import { RefreshCw } from 'lucide-react'

function getExtraKey(key: string): string | null {
  return key.startsWith('extra.') ? key.slice('extra.'.length) : null
}

function readFieldValue(params: PublishParams, key: string): unknown {
  const extraKey = getExtraKey(key)
  if (extraKey) return params.extra?.[extraKey]
  return (params as unknown as Record<string, unknown>)[key]
}

function writeFieldValue(params: PublishParams, key: string, value: unknown): PublishParams {
  const extraKey = getExtraKey(key)
  if (extraKey) {
    return {
      ...params,
      extra: { ...(params.extra ?? {}), [extraKey]: value },
    }
  }
  return { ...params, [key]: value } as PublishParams
}

function refsOptions(
  refs: PublishRefs | null | undefined,
  refKey: string | undefined,
  fallback: 'categories' | 'columns',
): Array<{ id: string; name: string }> {
  const key = refKey ?? fallback
  const list = refs?.[key]
  if (!Array.isArray(list)) return []
  return list as Array<{ id: string; name: string }>
}

interface SchemaParamsFormProps {
  schema: PublishSchema
  value: PublishParams
  onChange: (next: PublishParams) => void
  refs?: PublishRefs | null
  updatedAt?: number | null
  onRefreshRefs?: () => void | Promise<void>
  refreshing?: boolean
  showMode?: boolean
  /** 不渲染的字段 key（设置页排除 cover 等） */
  excludeKeys?: string[]
  className?: string
}

/** 多标签：chip + 草稿输入，避免逗号受控输入吞掉后续标签 */
function TagsInput({
  label,
  tags,
  max,
  suggestions,
  onChange,
}: {
  label: string
  tags: string[]
  max?: number
  suggestions?: string[]
  onChange: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...tags]
    for (const p of parts) {
      if (max != null && next.length >= max) break
      if (!next.includes(p)) next.push(p)
    }
    onChange(next)
    setDraft('')
  }

  const availableSuggestions = (suggestions ?? []).filter((s) => !tags.includes(s))

  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5 min-h-[32px] rounded-md border border-border/60 bg-background px-2 py-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary"
          >
            {t}
            <button
              type="button"
              className="opacity-70 hover:opacity-100"
              onClick={() => onChange(tags.filter((x) => x !== t))}
              aria-label={`移除 ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[6rem] bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          value={draft}
          placeholder={tags.length === 0 ? '输入后回车或逗号添加' : '继续添加…'}
          disabled={max != null && tags.length >= max}
          onChange={(e) => {
            const v = e.target.value
            if (/[,，]/.test(v)) {
              commit(v)
              return
            }
            setDraft(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit(draft)
            } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
              onChange(tags.slice(0, -1))
            }
          }}
          onBlur={() => {
            if (draft.trim()) commit(draft)
          }}
        />
      </div>
      {availableSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {availableSuggestions.slice(0, 20).map((s) => (
            <button
              key={s}
              type="button"
              className="text-[11px] px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground hover:border-primary/40 hover:text-primary"
              disabled={max != null && tags.length >= max}
              onClick={() => {
                if (max != null && tags.length >= max) return
                if (!tags.includes(s)) onChange([...tags, s])
              }}
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SchemaParamsForm({
  schema,
  value,
  onChange,
  refs,
  updatedAt,
  onRefreshRefs,
  refreshing,
  showMode = false,
  excludeKeys,
  className,
}: SchemaParamsFormProps) {
  const exclude = useMemo(() => new Set(excludeKeys ?? []), [excludeKeys])

  const fields = useMemo(
    () => schema.fields.filter((f) => !exclude.has(f.key)),
    [schema.fields, exclude],
  )

  const groups = useMemo(() => {
    if (!schema.groups) return undefined
    return schema.groups
      .map((g) => ({
        ...g,
        fields: g.fields.filter((k) => !exclude.has(k)),
      }))
      .filter((g) => g.fields.length > 0)
  }, [schema.groups, exclude])

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const g of schema.groups ?? []) {
      init[g.title] = g.defaultOpen ?? false
    }
    return init
  })

  const fieldMap = useMemo(() => {
    const m = new Map<string, SchemaField>()
    for (const f of fields) m.set(f.key, f)
    return m
  }, [fields])

  const needsRemote = fields.some(
    (f) =>
      ((f.kind === 'category' || f.kind === 'column') &&
        'source' in f &&
        f.source === 'remote') ||
      (f.kind === 'tags' && !!f.suggestionsKey),
  )
  const emptyRefs = isRefsEmpty(refs)

  const renderField = (field: SchemaField) => {
    switch (field.kind) {
      case 'tags': {
        const suggestionsRaw = field.suggestionsKey
          ? refs?.[field.suggestionsKey]
          : undefined
        const suggestions = Array.isArray(suggestionsRaw)
          ? (suggestionsRaw as string[]).filter((s) => typeof s === 'string')
          : undefined
        return (
          <TagsInput
            key={field.key}
            label={field.label}
            tags={value.tags ?? []}
            max={field.max}
            suggestions={suggestions}
            onChange={(tags) => onChange({ ...value, tags })}
          />
        )
      }
      case 'category': {
        const options =
          field.source === 'static'
            ? (field.options ?? []).map((o) => ({ id: o.value, name: o.label }))
            : refsOptions(refs, field.refKey, 'categories')
        return (
          <label key={field.key} className="block space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <select
              className="input-soft w-full text-sm"
              value={value.category ?? ''}
              disabled={field.source === 'remote' && options.length === 0}
              onChange={(e) =>
                onChange({ ...value, category: e.target.value || undefined })
              }
            >
              <option value="">未选择</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )
      }
      case 'column': {
        const options =
          field.source === 'static'
            ? (field.options ?? []).map((o) => ({ id: o.value, name: o.label }))
            : refsOptions(refs, field.refKey, 'columns')
        const multi = field.key === 'columns' || field.selectMode === 'multi'
        if (multi) {
          const selected = new Set(value.columns ?? [])
          return (
            <div key={field.key} className="space-y-1">
              <span className="text-xs text-muted-foreground">{field.label}</span>
              {options.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">暂无合集数据</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {options.map((o) => {
                    const checked = selected.has(o.id)
                    return (
                      <label
                        key={o.id}
                        className={cn(
                          'inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border cursor-pointer',
                          checked
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border/60 text-muted-foreground',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selected)
                            if (checked) next.delete(o.id)
                            else next.add(o.id)
                            onChange({ ...value, columns: Array.from(next) })
                          }}
                        />
                        {o.name}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        }
        return (
          <label key={field.key} className="block space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <select
              className="input-soft w-full text-sm"
              value={value.column ?? ''}
              disabled={field.source === 'remote' && options.length === 0}
              onChange={(e) =>
                onChange({ ...value, column: e.target.value || undefined })
              }
            >
              <option value="">未选择</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )
      }
      case 'visibility': {
        return (
          <div key={field.key} className="space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <div className="flex flex-wrap gap-2">
              {field.options.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border cursor-pointer',
                    value.visibility === o.value
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground',
                  )}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`vis-${field.key}`}
                    checked={value.visibility === o.value}
                    onChange={() => onChange({ ...value, visibility: o.value })}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </div>
        )
      }
      case 'comments': {
        return (
          <label key={field.key} className="flex items-center justify-between gap-2 text-sm">
            <span>{field.label}</span>
            <input
              type="checkbox"
              checked={value.commentsEnabled ?? true}
              onChange={(e) =>
                onChange({ ...value, commentsEnabled: e.target.checked })
              }
            />
          </label>
        )
      }
      case 'summary': {
        return (
          <label key={field.key} className="block space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <textarea
              className="input-soft w-full text-sm min-h-[64px]"
              value={value.summary ?? ''}
              maxLength={field.maxLength}
              onChange={(e) =>
                onChange({ ...value, summary: e.target.value || undefined })
              }
            />
          </label>
        )
      }
      case 'cover': {
        const cover = value.cover ?? (field.modes.includes('auto') ? 'auto' : 'none')
        const isManual = cover !== 'auto' && cover !== 'none'
        return (
          <div key={field.key} className="space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <div className="flex flex-wrap gap-2 mb-1">
              {field.modes.includes('auto') && (
                <button
                  type="button"
                  className={cn(
                    'text-xs px-2 py-1 rounded-md border',
                    cover === 'auto'
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60',
                  )}
                  onClick={() => onChange({ ...value, cover: 'auto' })}
                >
                  文章首图
                </button>
              )}
              {field.modes.includes('none') && (
                <button
                  type="button"
                  className={cn(
                    'text-xs px-2 py-1 rounded-md border',
                    cover === 'none'
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60',
                  )}
                  onClick={() => onChange({ ...value, cover: 'none' })}
                >
                  无
                </button>
              )}
              {field.modes.includes('manual') && (
                <button
                  type="button"
                  className={cn(
                    'text-xs px-2 py-1 rounded-md border',
                    isManual
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60',
                  )}
                  onClick={() =>
                    onChange({
                      ...value,
                      cover: isManual ? cover : '',
                    })
                  }
                >
                  手动 URL
                </button>
              )}
            </div>
            {cover === 'auto' && (
              <p className="text-[11px] text-muted-foreground">
                将使用正文第一张已上传的图片作为题图
              </p>
            )}
            {field.modes.includes('manual') && isManual && (
              <input
                className="input-soft w-full text-sm"
                placeholder="题图 URL"
                value={String(cover)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    cover: e.target.value || 'none',
                  })
                }
              />
            )}
          </div>
        )
      }
      case 'schedule': {
        if (!field.enabled) return null
        const dt = value.scheduleAt
          ? new Date(value.scheduleAt).toISOString().slice(0, 16)
          : ''
        return (
          <label key={field.key} className="block space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <input
              type="datetime-local"
              className="input-soft w-full text-sm"
              value={dt}
              onChange={(e) => {
                const ms = e.target.value ? new Date(e.target.value).getTime() : undefined
                onChange({
                  ...value,
                  scheduleAt: ms,
                  mode: ms ? 'schedule' : value.mode === 'schedule' ? 'draft' : value.mode,
                })
              }}
            />
          </label>
        )
      }
      case 'toggle': {
        const checked = Boolean(readFieldValue(value, field.key))
        return (
          <label key={field.key} className="flex items-center justify-between gap-2 text-sm">
            <span>{field.label}</span>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onChange(writeFieldValue(value, field.key, e.target.checked))}
            />
          </label>
        )
      }
      case 'text': {
        const text = String(readFieldValue(value, field.key) ?? '')
        return (
          <label key={field.key} className="block space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            {field.multiline ? (
              <textarea
                className="input-soft w-full text-sm min-h-[56px]"
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                value={text}
                onChange={(e) =>
                  onChange(writeFieldValue(value, field.key, e.target.value || undefined))
                }
              />
            ) : (
              <input
                className="input-soft w-full text-sm"
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                value={text}
                onChange={(e) =>
                  onChange(writeFieldValue(value, field.key, e.target.value || undefined))
                }
              />
            )}
          </label>
        )
      }
      default:
        return null
    }
  }

  const groupedKeys = new Set((groups ?? []).flatMap((g) => g.fields))
  const ungrouped = fields.filter((f) => !groupedKeys.has(f.key))

  return (
    <div className={cn('space-y-3', className)}>
      {showMode && (
        <div className="flex gap-2">
          {(['draft', 'publish'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={cn(
                'text-xs px-2.5 py-1 rounded-md border',
                (value.mode ?? 'draft') === m
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border/60 text-muted-foreground',
              )}
              onClick={() => onChange({ ...value, mode: m, scheduleAt: undefined })}
            >
              {m === 'draft' ? '保存草稿' : '发布'}
            </button>
          ))}
        </div>
      )}

      {needsRemote && onRefreshRefs && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {emptyRefs
              ? '暂无分类/合集/标签数据，请点击更新'
              : updatedAt
                ? `选项已缓存 · ${new Date(updatedAt).toLocaleString()}`
                : '选项已缓存'}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
            disabled={refreshing}
            onClick={() => void onRefreshRefs()}
          >
            <RefreshCw className={cn('w-3 h-3', refreshing && 'animate-spin')} />
            更新
          </button>
        </div>
      )}

      {(groups ?? []).map((g) => {
        const open = openGroups[g.title] ?? false
        return (
          <div key={g.title} className="card-soft p-2.5 space-y-2">
            <button
              type="button"
              className="flex w-full items-center justify-between text-xs font-medium"
              onClick={() =>
                setOpenGroups((prev) => ({ ...prev, [g.title]: !open }))
              }
            >
              <span>{g.title}</span>
              <span className="text-muted-foreground">{open ? '收起' : '展开'}</span>
            </button>
            {open && (
              <div className="space-y-2 pt-1">
                {g.fields.map((key) => {
                  const field = fieldMap.get(key)
                  return field ? renderField(field) : null
                })}
              </div>
            )}
          </div>
        )
      })}

      {ungrouped.length > 0 && (
        <div className="space-y-2">{ungrouped.map((f) => renderField(f))}</div>
      )}
    </div>
  )
}
