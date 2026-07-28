/**
 * 判定文章是否以 Markdown 为权威原文（非 HTML→Turndown 派生）。
 * import / edited / mcp + 非空 markdown → 真 md 源。
 */
export function isAuthenticMarkdownSource(article: {
  source?: unknown
  markdown?: string
}): boolean {
  const s = article.source
  if (s === 'import' || s === 'edited' || s === 'mcp') {
    return Boolean(article.markdown?.trim())
  }
  return false
}

/**
 * 双格式平台：真 md 源用 markdown，否则优先 html。
 */
export function pickMarkdownOrHtmlContent(article: {
  source?: unknown
  markdown?: string
  html?: string
}): string {
  if (isAuthenticMarkdownSource(article) && article.markdown) {
    return article.markdown
  }
  return article.html || article.markdown || ''
}

/**
 * 仅 Markdown 平台：真 md 源用原文；否则仍用 markdown（派生），无 html 退路。
 */
export function pickMarkdownOnlyContent(article: {
  source?: unknown
  markdown?: string
  html?: string
}): { content: string; asMarkdown: boolean } {
  if (isAuthenticMarkdownSource(article) && article.markdown) {
    return { content: article.markdown, asMarkdown: true }
  }
  const md = article.markdown?.trim()
  if (md) {
    return { content: article.markdown as string, asMarkdown: true }
  }
  return { content: article.html || '', asMarkdown: false }
}
