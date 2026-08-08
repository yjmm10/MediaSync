/**
 * 本地 Markdown YAML front matter 最小助手
 *
 * 仅负责：剥离 front matter、提取 title（及可选 cover/summary 顶层字段）。
 * 不再映射为跨平台 PublishParams。
 */

/** 去掉成对引号 */
function unquote(s: string): string {
  const t = s.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim()
  }
  return t
}

/**
 * 从 YAML front matter 文本块提取 title 字符串。
 */
export function extractFrontmatterTitle(fmText: string): string | null {
  const titleMatch = fmText.match(/^title:\s*(.+?)\s*$/m)
  if (!titleMatch) return null
  const t = unquote(titleMatch[1])
  return t || null
}

/**
 * 从 YAML 扁平键提取 cover / summary（可选，供导入顶层字段）。
 */
export function extractFrontmatterCoverSummary(fmText: string): {
  cover?: string
  summary?: string
} {
  const out: { cover?: string; summary?: string } = {}
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = unquote(m[2])
    if (!value) continue
    if (
      !out.cover &&
      (key === 'cover' || key === 'banner' || key === 'image' || key === 'thumbnail')
    ) {
      out.cover = value
    } else if (
      !out.summary &&
      (key === 'abstract' || key === 'summary' || key === 'description')
    ) {
      out.summary = value
    }
  }
  return out
}

/**
 * 剥离开头的 YAML front matter，返回正文与可选元数据。
 */
export function stripYamlFrontmatter(content: string): {
  body: string
  title?: string
  cover?: string
  summary?: string
} {
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!yamlMatch) {
    return { body: content }
  }
  const fmText = yamlMatch[1]
  const title = extractFrontmatterTitle(fmText) ?? undefined
  const { cover, summary } = extractFrontmatterCoverSummary(fmText)
  return {
    body: content.slice(yamlMatch[0].length),
    ...(title ? { title } : {}),
    ...(cover ? { cover } : {}),
    ...(summary ? { summary } : {}),
  }
}

/**
 * 将正文与可选 title 序列化为带 YAML front matter 的 Markdown（本地下载用）。
 */
export function serializeMarkdownWithTitle(body: string, title?: string): string {
  if (!title?.trim()) return body
  const safe = /[:#{}[\],&*?|>!%@`]/.test(title) || /^\s|\s$/.test(title)
    ? JSON.stringify(title.trim())
    : title.trim()
  return `---\ntitle: ${safe}\n---\n\n${body.replace(/^\n+/, '')}`
}
