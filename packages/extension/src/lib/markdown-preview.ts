/**
 * 编辑器预览专用 Markdown 渲染：
 * - mermaid 代码块（DOM 后处理）
 * - 行内 $...$ / \\(...\\) 与块级 $$...$$ / \\[...\\] 公式（KaTeX）
 * - 图片链接：独立一行的图片 URL 自动转为图片
 */
import { markdownToHtml } from '@mediasync/core'
import katex from 'katex'
import mermaid from 'mermaid'

let mermaidReady = false

function ensureMermaid() {
  if (mermaidReady) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'neutral',
  })
  mermaidReady = true
}

const CODE_PH = (i: number) => `§§CODE${i}§§`
const MATH_PH = (i: number) => `§§MATH${i}§§`

function protectCodeSegments(md: string): { text: string; slots: string[] } {
  const slots: string[] = []
  const text = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    const i = slots.length
    slots.push(m)
    return CODE_PH(i)
  })
  return { text, slots }
}

function restoreCodeSegments(text: string, slots: string[]): string {
  return text.replace(/§§CODE(\d+)§§/g, (_, i) => slots[Number(i)] ?? '')
}

function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
  } catch {
    return displayMode ? `<pre>${escapeHtml(tex)}</pre>` : `<code>${escapeHtml(tex)}</code>`
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 独立一行的图片 URL → Markdown 图片 */
function autolinkImageLines(md: string): string {
  return md.replace(
    /^(https?:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?[^\s<>"']*)?)\s*$/gim,
    '![]($1)',
  )
}

/**
 * 提取公式为占位符，避免 KaTeX HTML 被 marked 再解析。
 * 返回：带占位的 markdown + 占位→HTML 映射
 */
function extractMathPlaceholders(md: string): { text: string; htmlSlots: string[] } {
  const { text: protectedMd, slots: codeSlots } = protectCodeSegments(md)
  const htmlSlots: string[] = []

  const push = (html: string) => {
    const i = htmlSlots.length
    htmlSlots.push(html)
    return MATH_PH(i)
  }

  let out = protectedMd

  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => push(renderTex(tex, true)))
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => push(renderTex(tex, true)))
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => push(renderTex(tex, false)))
  // 行内 $...$（不含换行；避免 $$）
  out = out.replace(
    /(^|[^$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)/g,
    (_, prefix: string, tex: string) => `${prefix}${push(renderTex(tex, false))}`,
  )

  out = restoreCodeSegments(out, codeSlots)
  return { text: out, htmlSlots }
}

function restoreMathHtml(html: string, htmlSlots: string[]): string {
  return html.replace(/§§MATH(\d+)§§/g, (_, i) => htmlSlots[Number(i)] ?? '')
}

/**
 * Markdown → 预览 HTML（含公式；mermaid 需再调用 enhancePreviewDom）
 */
export function renderMarkdownPreviewHtml(markdown: string): string {
  const withImages = autolinkImageLines(markdown)
  const { text, htmlSlots } = extractMathPlaceholders(withImages)
  const html = markdownToHtml(text)
  return restoreMathHtml(html, htmlSlots)
}

/**
 * 在已注入 HTML 的预览容器中渲染 mermaid，并补强图片显示
 */
export async function enhancePreviewDom(root: HTMLElement): Promise<void> {
  root.querySelectorAll('img').forEach((img) => {
    const el = img as HTMLImageElement
    if (!el.getAttribute('loading')) el.loading = 'lazy'
    el.style.maxWidth = '100%'
    el.style.height = 'auto'
    el.onerror = () => {
      el.style.outline = '1px dashed #ccc'
      el.alt = el.alt || '图片加载失败'
    }
  })

  const nodes = Array.from(
    root.querySelectorAll(
      'pre code.language-mermaid, pre code.lang-mermaid, pre.language-mermaid > code, pre code[class*="mermaid"]',
    ),
  ) as HTMLElement[]

  if (nodes.length === 0) return

  ensureMermaid()

  for (const code of nodes) {
    const pre = code.closest('pre') || code.parentElement
    if (!pre || !(pre instanceof HTMLElement)) continue
    if (pre.parentElement?.querySelector(':scope > .mermaid-preview')) continue
    const source = code.textContent || ''
    const host = document.createElement('div')
    host.className = 'mermaid-preview'
    host.textContent = source
    pre.replaceWith(host)
  }

  const targets = Array.from(
    root.querySelectorAll('.mermaid-preview:not([data-processed])'),
  ) as HTMLElement[]
  if (targets.length === 0) return
  try {
    await mermaid.run({ nodes: targets })
  } catch (e) {
    console.warn('[markdown-preview] mermaid render failed', e)
  }
}
