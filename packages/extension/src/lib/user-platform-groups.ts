/**
 * 用户自定义平台分组（本地）
 *
 * 与默认分类（技术社区等）并存；同一平台可同时出现在用户组与默认分类。
 * order === 0 的第一组为快捷收藏目标（默认名「收藏」，用户可改名）。
 */

export interface UserPlatformGroup {
  id: string
  name: string
  platformIds: string[]
  order: number
}

export const USER_PLATFORM_GROUPS_KEY = 'userPlatformGroups'

const DEFAULT_GROUP_ID = 'user-favorites'
const DEFAULT_GROUP_NAME = '收藏'

function createDefaultGroups(): UserPlatformGroup[] {
  return [
    {
      id: DEFAULT_GROUP_ID,
      name: DEFAULT_GROUP_NAME,
      platformIds: [],
      order: 0,
    },
  ]
}

function normalizeGroups(raw: unknown): UserPlatformGroup[] {
  if (!Array.isArray(raw) || raw.length === 0) return createDefaultGroups()
  const groups: UserPlatformGroup[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const g = item as Partial<UserPlatformGroup>
    if (typeof g.id !== 'string' || typeof g.name !== 'string') continue
    groups.push({
      id: g.id,
      name: g.name.trim() || DEFAULT_GROUP_NAME,
      platformIds: Array.isArray(g.platformIds)
        ? g.platformIds.filter((id): id is string => typeof id === 'string')
        : [],
      order: typeof g.order === 'number' ? g.order : groups.length,
    })
  }
  if (groups.length === 0) return createDefaultGroups()
  return groups.sort((a, b) => a.order - b.order)
}

export async function getUserPlatformGroups(): Promise<UserPlatformGroup[]> {
  const storage = await chrome.storage.local.get(USER_PLATFORM_GROUPS_KEY)
  const groups = normalizeGroups(storage[USER_PLATFORM_GROUPS_KEY])
  // 缺省写入种子，保证后续读写一致
  if (!storage[USER_PLATFORM_GROUPS_KEY]) {
    await chrome.storage.local.set({ [USER_PLATFORM_GROUPS_KEY]: groups })
  }
  return groups
}

export async function setUserPlatformGroups(groups: UserPlatformGroup[]): Promise<UserPlatformGroup[]> {
  const normalized = normalizeGroups(groups)
  // 重新编号 order
  const ordered = normalized.map((g, i) => ({ ...g, order: i }))
  await chrome.storage.local.set({ [USER_PLATFORM_GROUPS_KEY]: ordered })
  return ordered
}

/** 快捷收藏目标：order 最小的第一组 */
export function getFavoriteTargetGroup(groups: UserPlatformGroup[]): UserPlatformGroup {
  const sorted = [...groups].sort((a, b) => a.order - b.order)
  return sorted[0] ?? createDefaultGroups()[0]
}

export async function toggleFavorite(platformId: string): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const target = getFavoriteTargetGroup(groups)
  const has = target.platformIds.includes(platformId)
  const next = groups.map(g => {
    if (g.id !== target.id) return g
    return {
      ...g,
      platformIds: has
        ? g.platformIds.filter(id => id !== platformId)
        : [...g.platformIds, platformId],
    }
  })
  return setUserPlatformGroups(next)
}

export async function addPlatformToGroup(
  groupId: string,
  platformId: string,
): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const next = groups.map(g => {
    if (g.id !== groupId) return g
    if (g.platformIds.includes(platformId)) return g
    return { ...g, platformIds: [...g.platformIds, platformId] }
  })
  return setUserPlatformGroups(next)
}

export async function removePlatformFromGroup(
  groupId: string,
  platformId: string,
): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const next = groups.map(g => {
    if (g.id !== groupId) return g
    return { ...g, platformIds: g.platformIds.filter(id => id !== platformId) }
  })
  return setUserPlatformGroups(next)
}

export async function renameGroup(groupId: string, name: string): Promise<UserPlatformGroup[]> {
  const trimmed = name.trim() || DEFAULT_GROUP_NAME
  const groups = await getUserPlatformGroups()
  const next = groups.map(g => (g.id === groupId ? { ...g, name: trimmed } : g))
  return setUserPlatformGroups(next)
}

export async function createGroup(name = '未命名分组'): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  return setUserPlatformGroups([
    ...groups,
    { id, name: name.trim() || '未命名分组', platformIds: [], order: groups.length },
  ])
}

export async function deleteGroup(groupId: string): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const next = groups.filter(g => g.id !== groupId)
  if (next.length === 0) {
    return setUserPlatformGroups(createDefaultGroups())
  }
  return setUserPlatformGroups(next)
}

export async function moveGroup(groupId: string, direction: -1 | 1): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const idx = groups.findIndex(g => g.id === groupId)
  if (idx < 0) return groups
  const target = idx + direction
  if (target < 0 || target >= groups.length) return groups
  const next = [...groups]
  const [moved] = next.splice(idx, 1)
  next.splice(target, 0, moved)
  return setUserPlatformGroups(next)
}

export async function setGroupPlatformIds(
  groupId: string,
  platformIds: string[],
): Promise<UserPlatformGroup[]> {
  const groups = await getUserPlatformGroups()
  const next = groups.map(g => (g.id === groupId ? { ...g, platformIds: [...platformIds] } : g))
  return setUserPlatformGroups(next)
}
