/**
 * 标签页 / 标签组工具
 */

type TabGroupColor =
  | 'grey' | 'blue' | 'cyan' | 'green'
  | 'orange' | 'pink' | 'purple' | 'red' | 'yellow'

/**
 * 打开一组 URL；浏览器支持时归入同一个标签组（Tab Group），否则逐个打开。
 * 内部已对 URL 去重。
 */
export async function openUrlsInTabGroup(
  urls: string[],
  options?: { title?: string; color?: TabGroupColor }
): Promise<void> {
  const seen = new Set<string>()
  const unique = urls.filter(u => {
    if (!u || seen.has(u)) return false
    seen.add(u)
    return true
  })
  if (unique.length === 0) return

  const { title = '草稿', color = 'green' } = options || {}

  try {
    if (chrome.tabs.group && chrome.tabGroups) {
      // 后台打开所有标签页，再归入同一个标签组
      const tabs = await Promise.all(
        unique.map(url => chrome.tabs.create({ url, active: false }))
      )
      const groupId = await chrome.tabs.group({ tabIds: tabs.map(t => t.id!) })
      await chrome.tabGroups.update(groupId, { title, color })
    } else {
      // 不支持标签组：逐个打开
      for (const url of unique) {
        chrome.tabs.create({ url })
      }
    }
  } catch {
    // 兜底：逐个打开
    for (const url of unique) {
      chrome.tabs.create({ url }).catch(() => {})
    }
  }
}
