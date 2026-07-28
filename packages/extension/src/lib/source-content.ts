/**
 * 按内容源格式分流：Markdown 源保留原文 md，HTML 源继续走预处理结果。
 *
 * 避免本地导入 / 编辑器 md 经 HTML→Turndown 往返后，公式中的 \ 被转义成 \\。
 */
import type { PreprocessConfig } from '@mediasync/core'

export type PlatformContent = { html: string; markdown: string }

/**
 * 判定文章是否以 Markdown 为权威原文。
 * - import / edited：本地 md 或编辑器双写的 md
 * - mcp + 非空 markdown：CLI/MCP 传入的 md
 * - extract 或 source 为 { url, platform }：网页 HTML 提取，不视为 md 源
 */
export function isMarkdownContentOrigin(
  article: { source?: unknown; markdown?: string },
  syncSource?: string
): boolean {
  const s = article?.source ?? syncSource
  if (s === 'import' || s === 'edited') return true
  if ((s === 'mcp' || syncSource === 'mcp') && Boolean(article?.markdown?.trim())) {
    return true
  }
  return false
}

/**
 * 对 outputFormat === 'markdown' 的平台，用 article.markdown 覆盖预处理生成的 markdown。
 * html 字段保持预处理结果，供仍可能读取 html 的逻辑使用。
 */
export function applyOriginalMarkdownToPlatformContents(
  platformContents: Record<string, PlatformContent>,
  article: { source?: unknown; markdown?: string },
  configs: Record<string, PreprocessConfig>,
  syncSource?: string
): Record<string, PlatformContent> {
  const originalMd = article.markdown?.trim()
  if (!originalMd || !isMarkdownContentOrigin(article, syncSource)) {
    return platformContents
  }

  const result: Record<string, PlatformContent> = { ...platformContents }
  for (const [id, content] of Object.entries(result)) {
    if (configs[id]?.outputFormat === 'markdown') {
      result[id] = {
        html: content.html,
        markdown: article.markdown as string,
      }
    }
  }
  return result
}
