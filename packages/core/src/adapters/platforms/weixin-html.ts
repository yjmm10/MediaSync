/**
 * 微信公众号 HTML 规范化（Service Worker 安全：仅正则，无 DOM）
 *
 * - 闭标签后标点内收、压缩字与标点间空白
 * - 列表项：仅含行内内容时外包 display:inline 的 span，
 *   避免微信编辑器在「li 以 strong/em 等行内标签开头」时把后续裸文本改写成块级导致硬换行
 */

const INLINE_CLOSE_TAGS = 'strong|b|em|i|span|a|u|code|s|del'

/** 紧跟行内闭合标签或「字」之后需要粘住的标点 */
const PUNCT =
  '，。！？；：、）》」』】〉…%‰°℃,.!?;:)]}'

/** li 内若出现这些块级标签则不做整包 span（避免非法嵌套） */
const LI_BLOCK_RE = /<(?:p|div|ul|ol|table|section|pre|blockquote|h[1-6])\b/i

const LI_INLINE_WRAP_OPEN = '<span style="display: inline;">'

function escapeForCharClass(chars: string): string {
  return chars.replace(/[\\^\-\]]/g, '\\$&')
}

/**
 * 解开无属性（或仅空 class=""）的 span，最多 5 轮。
 */
function unwrapBareSpans(html: string): string {
  const unwrapOnce = (input: string): string =>
    input.replace(
      /<span([^>]*)>([\s\S]*?)<\/span>/gi,
      (match, rawAttrs: string, inner: string) => {
        const attrs = (rawAttrs || '').trim()
        if (attrs === '') return inner
        if (/^class\s*=\s*(?:""|'')$/i.test(attrs)) return inner
        return match
      }
    )

  let result = html
  for (let i = 0; i < 5; i++) {
    const next = unwrapOnce(result)
    if (next === result) break
    result = next
  }
  return result
}

/**
 * 用占位符保护 pre/code，避免后续空白压缩破坏代码。
 */
function protectPreCode(html: string): { html: string; slots: string[] } {
  const slots: string[] = []
  const replaced = html.replace(/<(pre|code)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, (match) => {
    const idx = slots.length
    slots.push(match)
    return `\u0000WEIXIN_SLOT_${idx}\u0000`
  })
  return { html: replaced, slots }
}

function restorePreCode(html: string, slots: string[]): string {
  return html.replace(/\u0000WEIXIN_SLOT_(\d+)\u0000/g, (_, n: string) => {
    return slots[Number(n)] ?? ''
  })
}

/**
 * 将行内闭合标签后紧跟的标点内收到标签内：</strong>。 → 。</strong>
 */
function pullPunctuationInsideInlineClosings(html: string): string {
  const re = new RegExp(
    `</(${INLINE_CLOSE_TAGS})>([${escapeForCharClass(PUNCT)}]+)`,
    'gi'
  )
  return html.replace(re, (_, tag: string, punct: string) => `${punct}</${tag}>`)
}

/**
 * 去掉非空白字符与后续标点之间的空白（含换行）。
 */
function collapseSpaceBeforePunctuation(html: string): string {
  const re = new RegExp(
    `(\\S)\\s+([${escapeForCharClass(PUNCT)}])`,
    'g'
  )
  let result = html
  for (let i = 0; i < 5; i++) {
    const next = result.replace(re, '$1$2')
    if (next === result) break
    result = next
  }
  return result
}

function alreadyWrappedAsInlineSpan(inner: string): boolean {
  const trimmed = inner.trim()
  return (
    /^<span\s+[^>]*style\s*=\s*["'][^"']*display\s*:\s*inline/i.test(trimmed) &&
    /<\/span>$/i.test(trimmed)
  )
}

/**
 * 将不含嵌套 li、且无块级子元素的 li 内容包进带 style 的 span。
 * 无 style 的 span 会被微信剥掉，必须带 display:inline。
 */
function wrapLiInlineContent(html: string): string {
  // 只匹配内部不再出现 <li 的列表项（由内向外多轮；每轮新建正则避免 lastIndex 残留）
  let result = html
  for (let i = 0; i < 5; i++) {
    let changed = false
    const liRe = /<li(\s[^>]*)?>((?:(?!<li\b)[\s\S])*?)<\/li>/gi
    const next = result.replace(liRe, (match, attrs: string | undefined, inner: string) => {
      if (LI_BLOCK_RE.test(inner)) return match
      if (alreadyWrappedAsInlineSpan(inner)) return match
      changed = true
      return `<li${attrs || ''}>${LI_INLINE_WRAP_OPEN}${inner}</span></li>`
    })
    result = next
    if (!changed) break
  }
  return result
}

/**
 * 微信正文规范化。
 */
export function normalizeWeixinHtml(html: string): string {
  let content = unwrapBareSpans(html)

  const { html: protectedHtml, slots } = protectPreCode(content)
  content = protectedHtml

  content = pullPunctuationInsideInlineClosings(content)
  content = collapseSpaceBeforePunctuation(content)

  content = restorePreCode(content, slots)
  content = wrapLiInlineContent(content)
  return content
}
