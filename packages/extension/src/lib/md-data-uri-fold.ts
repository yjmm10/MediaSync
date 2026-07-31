/**
 * Markdown 编辑辅助：折叠超长 data URI，避免撑爆编辑器篇幅
 */

const DATA_URI_RE =
  /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]{80,})/g

/** 占位符：⟦img:序号|类型|大小KB⟧ */
const PLACEHOLDER_RE = /⟦img:(\d+)\|([a-zA-Z0-9.+-]+)\|(\d+)KB⟧/g

export type DataUriStore = Map<number, string>

function nextId(store: DataUriStore): number {
  let id = 0
  while (store.has(id)) id++
  return id
}

function findIdByUri(store: DataUriStore, uri: string): number | undefined {
  for (const [k, v] of store) {
    if (v === uri) return k
  }
  return undefined
}

export function makePlaceholder(id: number, mime: string, uri: string): string {
  const kb = Math.max(1, Math.round(uri.length / 1024))
  return `⟦img:${id}|${mime}|${kb}KB⟧`
}

/** 将正文中的长 data URI 折叠为短占位符；store 保存原文 */
export function collapseDataUris(md: string, store: DataUriStore): string {
  DATA_URI_RE.lastIndex = 0
  return md.replace(DATA_URI_RE, (full, mime: string) => {
    const existing = findIdByUri(store, full)
    const id = existing ?? nextId(store)
    if (existing === undefined) store.set(id, full)
    return makePlaceholder(id, mime || 'png', full)
  })
}

/** 将占位符还原为完整 data URI */
export function expandDataUris(display: string, store: DataUriStore): string {
  PLACEHOLDER_RE.lastIndex = 0
  return display.replace(PLACEHOLDER_RE, (full, idStr: string) => {
    const id = Number(idStr)
    return store.get(id) ?? full
  })
}

/** 统计折叠数量（用于提示） */
export function countCollapsedPlaceholders(display: string): number {
  PLACEHOLDER_RE.lastIndex = 0
  return (display.match(PLACEHOLDER_RE) || []).length
}
