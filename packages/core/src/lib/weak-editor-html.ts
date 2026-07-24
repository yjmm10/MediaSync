/**
 * 弱编辑器 HTML 兼容处理
 *
 * 网易号 / 一点号 / 大鱼号等自媒体后台的富文本编辑器：
 * - 对 <pre><code> 支持差（换行折叠、# 被当成标题）
 * - 对行内 <code> / Markdown `` ` `` 支持差（内容被抽走、带下划线的标识符错位）
 * - 一点号还会把标签间的 \\n、h/ul/blockquote 拆成「一堆分行」
 *
 * 策略：
 * - 代码块 → 带 <br> 的样式块（不插入源码换行）
 * - 行内 code → <strong>
 * - 一点号额外：标题/列表/引用扁平化 + 压缩标签间空白
 * 仅用正则，可在 Service Worker 中安全调用。
 */

const CODE_BLOCK_STYLE =
  'margin:12px 0;padding:12px 14px;background:#f5f7fa;border:1px solid #e4e7ed;' +
  "border-radius:4px;font-family:Consolas,Monaco,'Courier New',monospace;" +
  'font-size:13px;line-height:1.6;overflow-x:auto;word-break:break-all;'

const QUOTE_STYLE =
  'margin:12px 0;padding:8px 12px;border-left:3px solid #ddd;color:#666;'

/** 标题降级为段落时的字号，避免网易号把 h1-h6 抽到文首 */
const HEADING_FONT_SIZE: Record<string, string> = {
  '1': '22px',
  '2': '20px',
  '3': '18px',
  '4': '16px',
  '5': '15px',
  '6': '14px',
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 保留行首缩进与连续空格 */
function preserveSpaces(line: string): string {
  return line
    .replace(/^ +/g, (spaces) => '&nbsp;'.repeat(spaces.length))
    .replace(/ {2}/g, '&nbsp;&nbsp;')
}

function extractPreText(inner: string): string {
  // 仅剥真实 HTML 标签名，避免把代码里的 `a < b` 当成标签吃掉
  let text = inner
    .replace(/<\/?code\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g, '')

  text = decodeBasicEntities(text)
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

function stripInnerTags(inner: string): string {
  return String(inner)
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 扁平化时保留加粗，并把残余 code 转成 strong */
function toInlineHtml(inner: string): string {
  let s = String(inner)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div)>/gi, ' ')
    .replace(/<(?:p|div)\b[^>]*>/gi, '')

  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_full, codeInner: string) => {
    const text = stripInnerTags(codeInner)
    return text ? `<strong>${text}</strong>` : ''
  })

  // 去掉除 strong/b/em/i 以外的标签
  s = s.replace(/<\/?(?!strong\b|\/strong\b|b\b|\/b\b|em\b|\/em\b|i\b|\/i\b)[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/gi, '')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 将 <pre>…</pre> 转为弱编辑器可保留换行的 HTML
 */
export function formatCodeBlocksForWeakEditor(html: string): string {
  if (!html || !/<pre\b/i.test(html)) return html

  return html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_full, inner: string) => {
    const text = extractPreText(inner)
    if (!text.trim()) return ''

    const lines = text.split('\n').map((line) => preserveSpaces(escapeHtml(line)))
    // 折叠多余空行，且只用 <br>、不插入源码 \n（一点号会把 \n 再拆成行）
    const body = lines
      .reduce<string[]>((acc, line) => {
        if (line === '' && acc[acc.length - 1] === '') return acc
        acc.push(line)
        return acc
      }, [])
      .join('<br>')

    return `<p style="${CODE_BLOCK_STYLE}">${body}</p>`
  })
}

/**
 * 行内 <code>…</code> → <strong>…</strong>
 */
export function inlineCodeToBoldForWeakEditor(html: string): string {
  if (!html || !/<code\b/i.test(html)) return html

  return html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_full, inner: string) => {
    const text = stripInnerTags(inner)
    if (!text) return ''
    return `<strong>${text}</strong>`
  })
}

/** @deprecated 使用 inlineCodeToBoldForWeakEditor */
export function styleInlineCodeForWeakEditor(html: string): string {
  return inlineCodeToBoldForWeakEditor(html)
}

/** 压缩标签间空白，避免编辑器把 HTML 源码换行显示成空行 */
export function compactInterTagWhitespace(html: string): string {
  return html
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/>\s+</g, '><')
    .replace(/\n+/g, ' ')
    .trim()
}

/**
 * 将 h1-h6 就地改为加粗段落（保留字号层级），不改动在文中的位置。
 * 网易号编辑器会收集所有标题堆到文首，必须去掉真实 heading 标签。
 */
export function demoteHeadingsToParagraphs(html: string): string {
  if (!html || !/<h[1-6]\b/i.test(html)) return html

  return html.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_full, level: string, inner: string) => {
      const text = toInlineHtml(inner)
      if (!text) return ''
      const size = HEADING_FONT_SIZE[level] || '16px'
      const style = `margin:1em 0 0.5em;font-size:${size};font-weight:bold;line-height:1.4;`
      if (/^\s*<strong[\s>][\s\S]*<\/strong>\s*$/i.test(text)) {
        return `<p style="${style}">${text}</p>`
      }
      return `<p style="${style}"><strong>${stripInnerTags(text)}</strong></p>`
    }
  )
}

/**
 * 一点号等极弱编辑器：把标题/列表/引用收成普通段落，减少「一行一块」
 */
export function flattenBlocksForPrimitiveEditor(html: string): string {
  let content = demoteHeadingsToParagraphs(html)

  // 引用 → 左边线段落
  content = content.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_full, inner: string) => {
    const text = toInlineHtml(inner)
    return text ? `<p style="${QUOTE_STYLE}">${text}</p>` : ''
  })

  // 有序/无序列表 → 多段
  content = content.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_full, tag: string, inner: string) => {
    let index = 0
    const items: string[] = []
    String(inner).replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_li, liInner: string) => {
      index += 1
      const text = toInlineHtml(liInner)
      if (!text) return ''
      const bullet = String(tag).toLowerCase() === 'ol' ? `${index}. ` : '· '
      items.push(`<p>${bullet}${text}</p>`)
      return ''
    })
    return items.join('')
  })

  // section/article 外壳拆掉
  content = content.replace(/<\/?(?:section|article)\b[^>]*>/gi, '')

  return content
}

/**
 * 网易号 / 大鱼号等内容预处理入口
 */
export function prepareHtmlForWeakEditor(html: string): string {
  let content = formatCodeBlocksForWeakEditor(html)
  content = inlineCodeToBoldForWeakEditor(content)
  content = content.replace(/<img\b([^>]*?)\/?>/gi, (full, attrs: string) => {
    if (/\sstyle\s*=/i.test(attrs)) return full
    const trimmed = attrs.trimEnd()
    const selfClose = /\/\s*$/.test(trimmed)
    const cleanAttrs = selfClose ? trimmed.replace(/\/\s*$/, '').trimEnd() : trimmed
    const close = selfClose || /\/\s*>$/.test(full) ? ' /' : ''
    return `<img${cleanAttrs ? ` ${cleanAttrs}` : ''} style="max-width:100%;height:auto;"${close}>`
  })
  return content
}

/**
 * 一点号专用：弱编辑器兼容，尽量贴近原稿结构。
 * - 代码块 / 行内 code：编辑器不支持，仍需转换
 * - 标题 / 列表 / 引用 / 图片：保留，不再扁平化、不去图
 * - 仅压缩标签间源码空白，避免被拆成空行瀑布
 */
export function prepareHtmlForYidian(html: string): string {
  let content = prepareHtmlForWeakEditor(html)
  content = compactInterTagWhitespace(content)
  content = content.replace(/(?:<br\s*\/?>){3,}/gi, '<br><br>')
  return content
}

/**
 * 网易号专用：行内 code→加粗，并把 h1-h6 就地降级为加粗段落，
 * 避免写作台把层级标题全部抽到文章开头。
 */
export function prepareHtmlForNetease(html: string): string {
  let content = prepareHtmlForWeakEditor(html)
  content = demoteHeadingsToParagraphs(content)
  return content
}
