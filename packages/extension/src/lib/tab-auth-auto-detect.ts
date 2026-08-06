/**
 * 会开标签鉴权的平台：是否允许在全量/TTL 刷新时自动 checkAuth（可能新建标签）
 * 默认关闭：仅手动「重新检测」真检。
 */

export const TAB_AUTH_AUTO_DETECT_KEY = 'tabAuthAutoDetect'
export const DEFAULT_TAB_AUTH_AUTO_DETECT = false

export async function getTabAuthAutoDetect(): Promise<boolean> {
  try {
    const storage = await chrome.storage.local.get(TAB_AUTH_AUTO_DETECT_KEY)
    const v = storage[TAB_AUTH_AUTO_DETECT_KEY]
    return typeof v === 'boolean' ? v : DEFAULT_TAB_AUTH_AUTO_DETECT
  } catch {
    return DEFAULT_TAB_AUTH_AUTO_DETECT
  }
}

export async function setTabAuthAutoDetect(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [TAB_AUTH_AUTO_DETECT_KEY]: enabled })
}
