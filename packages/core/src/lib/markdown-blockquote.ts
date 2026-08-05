/**
 * 引用块换行归一化（掘金/火山等平台）
 *
 * 平台 Markdown 渲染会把引用块（> ...）内的软换行合并，导致多行引用变成一行。
 * 在非列表、非空行的引用行尾加 `\` 强制换行（硬换行）。
 *
 * 列表行（- / * / + / 1.）不加 `\`，避免破坏列表渲染。
 */
export function normalizeBlockquoteLineBreaks(markdown: string): string {
  if (!markdown) return markdown
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^\s*>/.test(line)) continue
    const content = line.replace(/^\s*>\s?/, '')
    if (
      content &&
      !/^\s*[-*+]\s/.test(content) &&
      !/^\s*\d+\.\s/.test(content) &&
      !/\\\s*$/.test(content)
    ) {
      lines[i] = line.replace(/\s*$/, '  \\')
    }
  }
  return lines.join('\n')
}
