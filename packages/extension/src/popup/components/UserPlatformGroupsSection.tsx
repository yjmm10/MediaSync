/**
 * 设置页：用户自定义平台分组管理
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Search, Star, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAllPlatformMetas, initAdapters } from '../../adapters'
import {
  createGroup,
  deleteGroup,
  getUserPlatformGroups,
  moveGroup,
  renameGroup,
  setGroupPlatformIds,
  type UserPlatformGroup,
} from '../../lib/user-platform-groups'

export function UserPlatformGroupsSection() {
  const [groups, setGroups] = useState<UserPlatformGroup[]>([])
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string }>>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [platformQuery, setPlatformQuery] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const renameTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const refresh = async () => {
    const next = await getUserPlatformGroups()
    setGroups(next)
    return next
  }

  useEffect(() => {
    initAdapters().then(() => {
      const metas = getAllPlatformMetas()
      setPlatforms(metas.map(m => ({ id: m.id, name: m.name })))
    })
    refresh()
    return () => {
      for (const t of Object.values(renameTimers.current)) clearTimeout(t)
    }
  }, [])

  const showHint = (msg: string) => {
    setHint(msg)
    setTimeout(() => setHint(null), 1800)
  }

  const handleRenameLocal = (groupId: string, name: string) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, name } : g)))
    const existing = renameTimers.current[groupId]
    if (existing) clearTimeout(existing)
    renameTimers.current[groupId] = setTimeout(() => {
      renameGroup(groupId, name).then(setGroups)
    }, 400)
  }

  const handleCreate = async () => {
    const next = await createGroup()
    setGroups(next)
    const created = next[next.length - 1]
    if (created) {
      setExpandedId(created.id)
      setPlatformQuery('')
    }
    showHint('已新建分组')
  }

  const handleDelete = async (groupId: string) => {
    setGroups(await deleteGroup(groupId))
    if (expandedId === groupId) setExpandedId(null)
    showHint('已删除分组')
  }

  const handleMove = async (groupId: string, direction: -1 | 1) => {
    setGroups(await moveGroup(groupId, direction))
  }

  const handleTogglePlatform = async (group: UserPlatformGroup, platformId: string) => {
    const has = group.platformIds.includes(platformId)
    const platformIds = has
      ? group.platformIds.filter(id => id !== platformId)
      : [...group.platformIds, platformId]
    setGroups(await setGroupPlatformIds(group.id, platformIds))
  }

  const filteredPlatforms = useMemo(() => {
    const q = platformQuery.trim().toLowerCase()
    if (!q) return platforms
    return platforms.filter(
      p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }, [platforms, platformQuery])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground leading-relaxed flex-1">
          可与默认分类并存同一平台；第一组为快捷收藏目标。
        </p>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline flex-shrink-0"
        >
          <Plus className="w-3 h-3" />
          新建
        </button>
      </div>

      <div className="space-y-1.5">
        {groups.map((group, index) => {
          const expanded = expandedId === group.id
          const isFavoriteTarget = index === 0
          return (
            <div key={group.id} className="card-soft overflow-hidden">
              <div className="flex items-center gap-1.5 px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => {
                    setExpandedId(expanded ? null : group.id)
                    setPlatformQuery('')
                  }}
                  className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                >
                  {isFavoriteTarget ? (
                    <Star className="w-3.5 h-3.5 text-primary fill-primary/30 flex-shrink-0" />
                  ) : (
                    <span className="w-0.5 h-3 rounded-full bg-primary flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate">{group.name || '未命名'}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground flex-shrink-0">
                    {group.platformIds.length}
                  </span>
                  <ChevronDown
                    className={cn(
                      'w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform',
                      expanded && 'rotate-180',
                    )}
                  />
                </button>
                <button
                  type="button"
                  title="上移"
                  disabled={index === 0}
                  onClick={() => handleMove(group.id, -1)}
                  className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="下移"
                  disabled={index === groups.length - 1}
                  onClick={() => handleMove(group.id, 1)}
                  className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="删除分组"
                  onClick={() => handleDelete(group.id)}
                  className="p-1 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {expanded && (
                <div className="border-t border-border/60 px-2.5 py-2 space-y-2">
                  <input
                    type="text"
                    value={group.name}
                    onChange={e => handleRenameLocal(group.id, e.target.value)}
                    placeholder="分组名称"
                    className="input-soft h-8 text-sm"
                    aria-label="分组名称"
                  />
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      type="search"
                      value={platformQuery}
                      onChange={e => setPlatformQuery(e.target.value)}
                      placeholder="搜索平台…"
                      className="input-soft h-8 text-sm pl-7"
                    />
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-0.5 rounded-md border border-border/50 p-1">
                    {filteredPlatforms.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground px-1.5 py-2">无匹配平台</p>
                    ) : (
                      filteredPlatforms.map(p => {
                        const checked = group.platformIds.includes(p.id)
                        return (
                          <label
                            key={p.id}
                            className={cn(
                              'flex items-center gap-2 px-1.5 py-1 rounded-md text-sm cursor-pointer hover:bg-muted/60',
                              checked && 'bg-primary/[0.06]',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleTogglePlatform(group, p.id)}
                              className="rounded border-border"
                            />
                            <span className="truncate">{p.name}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hint && <p className="text-[11px] text-primary">{hint}</p>}
    </div>
  )
}
