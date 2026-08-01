/**
 * 百度智能云千帆社区适配器
 * https://qianfan.cloud.baidu.com/qianfandev/topic/create
 *
 * 仅保存草稿；正文为 Slate JSON（mdContent）+ 简易 htmlContent。
 * CSRF：cookie bce-user-info-ct-id → header csrftoken
 * SW fetch 常丢 SameSite Cookie，需 DNR 注入 Cookie（resourceTypes 含 other）
 * ⚠️ 本版本不支持图片：本地 data URI 会剥离；http(s) 外链也不中转图床。
 * （产品策略：当前仅千帆关闭外链图片中转，其余平台均支持。）
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Qianfan')

const BASE = 'https://qianfan.cloud.baidu.com'
const API = `${BASE}/api/community`
const CREATE_URL = `${BASE}/qianfandev/topic/create`
const PAGE_URL_PATTERN = '*://qianfan.cloud.baidu.com/qianfandev/*'
const SKIP_IMAGE_HOSTS = ['bce.bdstatic.com/community/uploads']
/** data URI 经 executeScript args 传递的上限；更大走 storage + ISOLATED */
const PAGE_UPLOAD_INLINE_MAX_BYTES = 200 * 1024

/** SW fetch 常丢 SameSite Cookie，需从这些 domain 收集后经 DNR 注入 */
const COOKIE_DOMAINS = [
  'baidu.com',
  'bce.baidu.com',
  'cloud.baidu.com',
  'qianfan.cloud.baidu.com', // 最具体，collect 时后者覆盖前者
]
const SESSION_COOKIE = 'bce-session'
const CSRF_COOKIE = 'bce-user-info-ct-id'

interface QianfanApiResponse<T = unknown> {
  success?: boolean
  status?: number
  result?: T
  code?: string
  message?: string | { global?: string; detail?: unknown }
  error?: {
    code?: string
    message?: string
    detail?: { global?: string }
  }
}

interface QianfanUser {
  id?: number
  displayName?: string
  nickname?: string
  avatar?: string
}

interface QianfanTopicCreateResult {
  id?: number
  submitAt?: string
  updateAt?: string
}

interface QianfanUploadResult {
  fileName?: string
  fileSize?: number
  fileUrl?: string
}

export interface QianfanNode {
  type?: string
  text?: string
  bold?: boolean
  italic?: boolean
  children?: QianfanNode[]
  level?: number
  indent?: number
  depth?: number
  index?: number
  initialNumber?: number
  textAlign?: string
  textIndent?: number
  src?: string
  align?: string
  href?: string
  title?: string
  caption?: string
  uuid?: string
  [key: string]: unknown
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stripCookieQuotes(value: string): string {
  return value.replace(/^["'](.*)["']$/, '$1')
}

/** 从 Markdown 取首段纯文本摘要 */
export function buildSummary(markdown: string, maxLen = 120): string {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '')
  const lines = withoutCode.split(/\r?\n/)
  const parts: string[] = []
  for (const line of lines) {
    const t = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~`]+/g, '')
      .trim()
    if (!t) continue
    parts.push(t)
    if (parts.join('').length >= maxLen) break
  }
  const summary = parts.join(' ').replace(/\s+/g, ' ').trim()
  return summary.length > maxLen ? summary.slice(0, maxLen) : summary
}

function textLeaf(text: string, marks?: { bold?: boolean; italic?: boolean }): QianfanNode {
  const node: QianfanNode = { text }
  if (marks?.bold) node.bold = true
  if (marks?.italic) node.italic = true
  return node
}

function emptyParagraph(): QianfanNode {
  return {
    type: 'paragraph',
    children: [{ text: '' }],
    textAlign: 'left',
    textIndent: 0,
  }
}

function paragraphWith(children: QianfanNode[], textAlign: string = 'left'): QianfanNode {
  return {
    type: 'paragraph',
    children: children.length ? children : [{ text: '' }],
    textAlign,
    textIndent: 0,
  }
}

/** Markdown 列表行首空白 → depth（Tab=2 空格，每 2 空格一级） */
function listIndentFromLine(line: string): number {
  const ws = line.match(/^(\s*)/)?.[1] ?? ''
  const spaces = ws.replace(/\t/g, '  ').length
  return Math.min(8, Math.max(0, Math.floor(spaces / 2)))
}

function inlineFormulaNode(formula: string): QianfanNode {
  return {
    type: 'inline-formula',
    formula,
    children: [{ text: '' }],
  }
}

function splitTableCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableCells(line)
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c))
}

function cellParagraph(text: string): QianfanNode {
  const inline = parseInline(text)
  return {
    type: 'paragraph',
    textIndent: 1,
    children: inline.length ? inline : [{ text: '' }],
  }
}

/**
 * 列宽：取该列每一行单元格的最大字符长度（String.length），
 * 再 × 单字像素 + 内边距；总宽过大时等比缩小。
 */
function computeTableColWidths(rows: string[][], cols: number): number[] {
  const PX_PER_CHAR = 14
  const PAD = 28
  const MIN = 80
  const MAX = 480
  const MAX_TOTAL = 800

  const maxChars = Array.from({ length: cols }, () => 0)
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const len = Array.from((row[c] ?? '').trim()).length
      if (len > maxChars[c]) maxChars[c] = len
    }
  }

  const widths = maxChars.map((n) =>
    Math.min(MAX, Math.max(MIN, n * PX_PER_CHAR + PAD))
  )

  const sum = widths.reduce((a, b) => a + b, 0)
  if (sum > MAX_TOTAL && cols > 0) {
    const scale = MAX_TOTAL / sum
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(MIN, Math.floor(widths[c] * scale))
    }
  }
  return widths
}

/** GFM Markdown 表格 → 千帆 table / table-row / table-cell */
function markdownTableToQianfanNodes(tableLines: string[]): QianfanNode {
  const hasSep = tableLines.length >= 2 && isTableSeparatorRow(tableLines[1])
  const header = hasSep ? splitTableCells(tableLines[0]) : null
  const bodyStart = hasSep ? 2 : 0
  const bodyRows = tableLines
    .slice(bodyStart)
    .filter((l) => !isTableSeparatorRow(l))
    .map(splitTableCells)

  const rows: string[][] = []
  if (header) rows.push(header)
  rows.push(...bodyRows)

  const cols = Math.max(1, ...rows.map((r) => r.length))
  const tableRows: QianfanNode[] = rows.map((row) => {
    const cells: QianfanNode[] = []
    for (let c = 0; c < cols; c++) {
      cells.push({
        type: 'table-cell',
        data: { rowspan: 1, colspan: 1 },
        children: [cellParagraph(row[c] ?? '')],
      })
    }
    return { type: 'table-row', children: cells }
  })

  return {
    type: 'table',
    sticky: false,
    data: {
      headless: !hasSep,
      width: computeTableColWidths(rows, cols),
    },
    children: tableRows,
  }
}

function parseEmphasis(text: string): QianfanNode[] {
  if (!text) return []
  const nodes: QianfanNode[] = []
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|(~~)(.+?)\5/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(textLeaf(text.slice(last, m.index)))
    }
    if (m[1]) {
      nodes.push(textLeaf(m[2], { bold: true }))
    } else if (m[3]) {
      nodes.push(textLeaf(m[4], { italic: true }))
    } else if (m[5]) {
      nodes.push(textLeaf(m[6]))
    }
    last = m.index + m[0].length
  }
  if (last < text.length) {
    nodes.push(textLeaf(text.slice(last)))
  }
  return nodes.length ? nodes : [textLeaf(text)]
}

/** 行内：code / 公式 / 图片 / 链接 / 加粗 / 斜体 */
export function parseInline(text: string): QianfanNode[] {
  if (!text) return []

  type Token =
    | { kind: 'text'; value: string }
    | { kind: 'code'; value: string }
    | { kind: 'formula'; value: string }
    | { kind: 'image'; alt: string; src: string }
    | { kind: 'link'; label: string; href: string }

  const tokens: Token[] = []
  const re =
    /(`[^`]+`)|(\$[^$\n]+\$)|(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\))|(\[([^\]]+)\]\(([^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: 'text', value: text.slice(last, m.index) })
    }
    if (m[1]) {
      tokens.push({ kind: 'code', value: m[1].slice(1, -1) })
    } else if (m[2]) {
      tokens.push({ kind: 'formula', value: m[2].slice(1, -1) })
    } else if (m[3]) {
      tokens.push({ kind: 'image', alt: m[4] || '', src: m[5] })
    } else if (m[7]) {
      tokens.push({ kind: 'link', label: m[8], href: m[9] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) {
    tokens.push({ kind: 'text', value: text.slice(last) })
  }

  const nodes: QianfanNode[] = []
  for (const tok of tokens) {
    if (tok.kind === 'code') {
      nodes.push({ type: 'inline-code', children: [{ text: tok.value }] })
    } else if (tok.kind === 'formula') {
      nodes.push(inlineFormulaNode(tok.value))
    } else if (tok.kind === 'image') {
      nodes.push(imageNode(tok.src, tok.alt))
    } else if (tok.kind === 'link') {
      nodes.push({
        type: 'link',
        href: tok.href,
        title: tok.href,
        children: parseEmphasis(tok.label),
      })
    } else {
      nodes.push(...parseEmphasis(tok.value))
    }
  }
  return nodes
}

function imageNode(src: string, caption = ''): QianfanNode {
  return {
    type: 'image',
    src,
    align: 'left',
    caption: caption || '',
    children: [{ text: '' }],
  }
}

/**
 * Markdown → 千帆 Slate 节点数组（无 DOM）
 */
export function markdownToQianfanNodes(markdown: string): QianfanNode[] {
  const src = (markdown || '').replace(/\r\n/g, '\n')
  const placeholders: string[] = []
  const protect = (block: string): string => {
    const idx = placeholders.length
    placeholders.push(block)
    return `\0BLK${idx}\0`
  }

  let work = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) =>
    protect(JSON.stringify({ kind: 'code', lang: lang || '', body: body.replace(/\n$/, '') }))
  )
  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) =>
    protect(JSON.stringify({ kind: 'formula', body: body.trim() }))
  )

  const lines = work.split('\n')
  const content: QianfanNode[] = [{ type: 'title', children: [{ text: '' }] }]
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const ph = line.match(/^\0BLK(\d+)\0\s*$/)
    if (ph) {
      const raw = placeholders[Number(ph[1])] || ''
      try {
        const meta = JSON.parse(raw) as { kind: string; lang?: string; body: string }
        if (meta.kind === 'code') {
          const codeLines = (meta.body || '').split('\n')
          content.push({
            type: 'block-code',
            language: meta.lang || 'text',
            autowrap: false,
            title: '',
            children: codeLines.map((codeLine) => ({
              type: 'block-code-line',
              children: [{ text: codeLine }],
              textIndent: 0,
              textAlign: 'left',
            })),
          })
        } else if (meta.kind === 'formula') {
          content.push(
            paragraphWith([inlineFormulaNode(meta.body), { text: '' }], 'center')
          )
        } else {
          content.push(paragraphWith(parseInline(line)))
        }
      } catch {
        content.push(paragraphWith(parseInline(line)))
      }
      i++
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const inline = parseInline(heading[2])
      content.push({
        type: 'heading',
        level: heading[1].length,
        indent: 0,
        textAlign: 'left',
        children: inline.length ? inline : [{ text: '' }],
      })
      i++
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: 'hr', children: [{ text: '' }] })
      i++
      continue
    }

    // 表格 → table / table-row / table-cell
    if (/\|/.test(line) && /^\s*\|?.*\|.*\|?\s*$/.test(line)) {
      const tableLines: string[] = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        tableLines.push(lines[i])
        i++
      }
      content.push(markdownTableToQianfanNodes(tableLines))
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      const paras = quoteLines
        .join('\n')
        .split(/\n{2,}/)
        .map((p) => p.replace(/\n/g, ' ').trim())
        .filter(Boolean)
      content.push({
        type: 'blockquote',
        children: (paras.length ? paras : ['']).map((p) => paragraphWith(parseInline(p))),
      })
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const depth = listIndentFromLine(lines[i])
        const text = lines[i].replace(/^\s*[-*+]\s+/, '')
        const inline = parseInline(text)
        content.push({
          type: 'unordered-list-item',
          depth,
          textAlign: 'left',
          children: inline.length ? inline : [{ text: '' }],
        })
        i++
      }
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const counters: number[] = []
      let sawDepth0 = false
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const depth = listIndentFromLine(lines[i])
        counters.length = depth + 1
        counters[depth] = (counters[depth] ?? 0) + 1
        const index = counters[depth]
        const text = lines[i].replace(/^\s*\d+\.\s+/, '')
        const inline = parseInline(text)
        const item: QianfanNode = {
          type: 'ordered-list-item',
          depth,
          index,
          textAlign: 'left',
          children: inline.length ? inline : [{ text: '' }],
        }
        if (depth === 0 && !sawDepth0) {
          item.initialNumber = 1
          sawDepth0 = true
        }
        content.push(item)
        i++
      }
      continue
    }

    const onlyImg = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/)
    if (onlyImg) {
      content.push(imageNode(onlyImg[2], onlyImg[1] || ''))
      i++
      continue
    }

    const paraLines: string[] = [line]
    i++
    while (i < lines.length) {
      const next = lines[i]
      if (!next.trim()) break
      if (/^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\0BLK\d+\0)/.test(next)) break
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break
      if (/\|/.test(next) && /^\s*\|?.*\|.*\|?\s*$/.test(next)) break
      if (/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/.test(next)) break
      paraLines.push(next)
      i++
    }
    content.push(paragraphWith(parseInline(paraLines.join('\n'))))
  }

  if (content.length === 1) {
    content.push(emptyParagraph())
  }

  return content
}

function inlineToHtml(nodes: QianfanNode[] | undefined): string {
  if (!nodes || nodes.length === 0) return ''
  return nodes
    .map((n) => {
      if (n.type === 'inline-code') {
        return `<code>${escapeHtml((n.children || []).map((c) => c.text || '').join(''))}</code>`
      }
      if (n.type === 'inline-formula') {
        const formula = String(n.formula || '')
        return `<span data-tag-name="inline-formula" data-formula-value="${escapeHtml(formula)}">$${escapeHtml(formula)}$</span>`
      }
      if (n.type === 'link') {
        const label = inlineToHtml(n.children) || escapeHtml(n.href || '')
        return `<a href="${escapeHtml(n.href || '')}">${label}</a>`
      }
      if (n.type === 'image') {
        return `<img src="${escapeHtml(n.src || '')}" alt="${escapeHtml(String(n.caption || ''))}" />`
      }
      let t = escapeHtml(n.text || '')
      if (n.bold) t = `<b><span>${t}</span></b>`
      else if (n.italic) t = `<i><span>${t}</span></i>`
      else if (t) t = `<span>${t}</span>`
      return t
    })
    .join('')
}

/** Slate 节点 → 简易 HTML（无 DOM） */
export function nodesToQianfanHtml(nodes: QianfanNode[]): string {
  const parts: string[] = []
  for (const n of nodes) {
    if (!n.type || n.type === 'title') {
      parts.push('<div></div>')
      continue
    }
    if (n.type === 'hr') {
      parts.push('<hr>')
      continue
    }
    if (n.type === 'heading') {
      const lv = Math.min(Math.max(n.level || 2, 1), 6)
      parts.push(`<h${lv}>${inlineToHtml(n.children)}</h${lv}>`)
      continue
    }
    if (n.type === 'paragraph') {
      parts.push(`<div>${inlineToHtml(n.children)}</div>`)
      continue
    }
    if (n.type === 'blockquote') {
      const inner = (n.children || [])
        .map((c) =>
          c.type === 'paragraph'
            ? `<div>${inlineToHtml(c.children)}</div>`
            : inlineToHtml([c])
        )
        .join('\n')
      parts.push(`<blockquote>${inner}</blockquote>`)
      continue
    }
    if (n.type === 'unordered-list-item') {
      parts.push(`<ul><li>${inlineToHtml(n.children)}</li></ul>`)
      continue
    }
    if (n.type === 'ordered-list-item') {
      parts.push(`<ol><li>${inlineToHtml(n.children)}</li></ol>`)
      continue
    }
    if (n.type === 'block-code') {
      const lang = escapeHtml(String(n.language || 'text'))
      const lines = (n.children || [])
        .map((line) => {
          const text = (line.children || []).map((c) => c.text || '').join('')
          return `<div>${escapeHtml(text)}</div>`
        })
        .join('')
      parts.push(`<pre data-lang="${lang}">${lines}</pre>`)
      continue
    }
    if (n.type === 'table') {
      const rows = (n.children || [])
        .map((row) => {
          const cells = (row.children || [])
            .map((cell) => {
              const inner = (cell.children || [])
                .map((p) =>
                  p.type === 'paragraph' ? inlineToHtml(p.children) : inlineToHtml([p])
                )
                .join('')
              return `<td>${inner}</td>`
            })
            .join('')
          return `<tr>${cells}</tr>`
        })
        .join('')
      parts.push(`<table>${rows}</table>`)
      continue
    }
    if (n.type === 'image') {
      parts.push(
        `<div><img src="${escapeHtml(n.src || '')}" alt="${escapeHtml(String(n.caption || ''))}" /></div>`
      )
      continue
    }
    parts.push(`<div>${inlineToHtml(n.children || [n])}</div>`)
  }
  return parts.join('\n')
}

export class QianfanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'qianfan',
    name: '百度智能云千帆社区',
    // 社区站内 logo.png 为 510×84 横幅，列表里显示异常；改用云站方标
    icon: 'https://bce.bdstatic.com/img/favicon.ico',
    homepage: `${BASE}/qianfandev`,
    capabilities: ['article', 'draft'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 收集百度云相关 Cookie，供 DNR 注入（绕过 SW 丢 SameSite 会话） */
  private async collectCookieHeader(): Promise<string> {
    const map = new Map<string, string>()
    // 顺序：泛域名 → 具体域名；后者覆盖前者，避免 baidu.com 旧值挡住 qianfan 会话
    for (const domain of COOKIE_DOMAINS) {
      try {
        const list = await this.runtime.cookies.get(domain)
        for (const c of list) {
          if (!c.name || !c.value) continue
          map.set(c.name, c.value)
        }
      } catch (error) {
        logger.debug(`cookies.get(${domain}) failed:`, error)
      }
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private hasLoginCookies(cookieHeader: string): boolean {
    if (!cookieHeader) return false
    return (
      cookieHeader.includes(`${SESSION_COOKIE}=`) ||
      cookieHeader.includes('bce-passport-stoken=') ||
      cookieHeader.includes(`${CSRF_COOKIE}=`) ||
      cookieHeader.includes('loginUserId=') ||
      cookieHeader.includes('bce-user-info=')
    )
  }

  /** 动态注入 Cookie/Origin/Referer，resourceTypes 含 other（SW fetch） */
  private async withCommunitySession<T>(fn: () => Promise<T>): Promise<T> {
    const cookieHeader = await this.collectCookieHeader()
    const apiHeaders: Record<string, string> = {
      Origin: BASE,
      Referer: `${BASE}/qianfandev/`,
    }
    // 部分 Chromium 禁止 DNR 改 Cookie；有值时仍尝试注入，失败时依赖 credentials + 页面探测
    if (cookieHeader) {
      apiHeaders.Cookie = cookieHeader
    }

    const rules = [
      {
        urlFilter: '*://qianfan.cloud.baidu.com/api/community/*',
        headers: apiHeaders,
        resourceTypes: ['xmlhttprequest', 'other'] as string[],
      },
    ]

    return this.withHeaderRules(rules, fn)
  }

  private authFromUser(user: QianfanUser | null | undefined): AuthResult | null {
    if (!user?.id) return null
    return {
      isAuthenticated: true,
      userId: String(user.id),
      username: user.displayName || user.nickname,
      avatar: user.avatar,
    }
  }

  /**
   * 仅在已打开的千帆标签页内探测登录（不 create / 不导航）。
   * 无可用标签时返回 null。
   */
  private async fetchUserViaExistingTab(): Promise<QianfanUser | null> {
    if (!this.runtime.tabs?.query || !this.runtime.tabs.executeScript) return null

    const tabs = await this.runtime.tabs.query([
      '*://qianfan.cloud.baidu.com/qianfandev/*',
      '*://qianfan.cloud.baidu.com/*',
    ])
    const tabId = tabs.find((t) => t.id !== undefined)?.id
    if (tabId === undefined) return null

    const csrf = await this.getCsrfToken().catch(() => '')
    const userUrl = `${API}/user_center/current`

    try {
      const pageResult = await this.runtime.tabs.executeScript(
        tabId,
        async (url: string, token: string) => {
          try {
            const headers: Record<string, string> = {
              Accept: 'application/json',
            }
            if (token) headers.csrftoken = token
            const res = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              headers,
            })
            const text = await res.text()
            return { ok: res.ok, status: res.status, text }
          } catch (error) {
            return {
              ok: false,
              status: 0,
              text: '',
              error: (error as Error)?.message || String(error),
            }
          }
        },
        [userUrl, csrf]
      )

      const result = pageResult as {
        ok?: boolean
        text?: string
        error?: string
      } | null
      if (result?.error || !result?.text?.trim()) {
        logger.debug('existing-tab auth probe failed:', result?.error || 'empty')
        return null
      }
      const trimmed = result.text.trim()
      if (trimmed.startsWith('<') || /<!DOCTYPE|<html/i.test(trimmed.slice(0, 80))) {
        logger.debug('existing-tab auth probe got HTML')
        return null
      }
      let data: QianfanApiResponse<QianfanUser>
      try {
        data = JSON.parse(result.text) as QianfanApiResponse<QianfanUser>
      } catch {
        logger.debug('existing-tab auth probe non-JSON')
        return null
      }
      if (!data.success || !data.result?.id) {
        logger.debug('existing-tab auth probe rejected:', this.extractError(data))
        return null
      }
      return data.result
    } catch (error) {
      logger.debug('existing-tab auth executeScript failed:', error)
      return null
    }
  }

  /** 是否已有可复用的千帆标签（不 create） */
  private async hasExistingQianfanTab(): Promise<boolean> {
    if (!this.runtime.tabs?.query) return false
    const tabs = await this.runtime.tabs.query([
      '*://qianfan.cloud.baidu.com/qianfandev/*',
      '*://qianfan.cloud.baidu.com/*',
    ])
    return tabs.some((t) => t.id !== undefined)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookieHeader = await this.collectCookieHeader()
      const hasSession = this.hasLoginCookies(cookieHeader)

      // ① SW + Cookie（不开标签，对齐 publish）
      const injected = await this.withCommunitySession(async () => {
        try {
          return await this.fetchUser()
        } catch (error) {
          logger.debug('user_center/current via SW failed:', error)
          return null
        }
      })
      const fromInjected = this.authFromUser(injected)
      if (fromInjected) return fromInjected

      // ② 仅复用已打开千帆页（不 create）
      try {
        const pageUser = await this.fetchUserViaExistingTab()
        const fromPage = this.authFromUser(pageUser)
        if (fromPage) return fromPage
      } catch (error) {
        logger.debug('existing-tab login probe failed:', error)
      }

      const hasTab = await this.hasExistingQianfanTab()
      if (hasSession) {
        if (hasTab) {
          return {
            isAuthenticated: false,
            error: '会话 Cookie 存在但社区未识别，请刷新千帆社区页后重新检测',
          }
        }
        return {
          isAuthenticated: false,
          error:
            '会话 Cookie 存在但未识别；可打开 https://qianfan.cloud.baidu.com/qianfandev 后重新检测（不会自动开页）',
        }
      }

      return {
        isAuthenticated: false,
        error: '未登录千帆社区（未找到会话 Cookie）',
      }
    } catch (error) {
      logger.debug('checkAuth failed:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting Qianfan draft sync...')
      return await this.withCommunitySession(async () => {
        const user = await this.fetchUser()
        if (!user?.id) {
          throw new Error('请先登录百度智能云/千帆社区')
        }

        const content = (article.markdown || '').trim()
        if (!content) {
          throw new Error('文章内容为空（未得到 Markdown），请重试同步')
        }

        // 本地/外链均不上传图床：去掉 data URI；http(s) 原样保留（不 processImages）
        const processedMd = content
          .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
          .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')

        const nodes = markdownToQianfanNodes(processedMd)
        const mdContent = JSON.stringify(nodes)
        const htmlContent = nodesToQianfanHtml(nodes)
        const summary = buildSummary(processedMd)

        const csrf = await this.getCsrfToken()
        const res = await this.apiPostJson<QianfanTopicCreateResult>(
          `${API}/topic`,
          {
            title: (article.title || '').trim() || '未命名话题',
            tagIds: '',
            categoryId: 2,
            subPartitionId: 1,
            summary,
            type: 'TEXT',
            coverImageUrl: '',
            mdContent,
            htmlContent,
            id: null,
          },
          csrf
        )

        const id = res.id
        if (!id) {
          throw new Error('保存草稿失败：未返回 ID')
        }

        const draftUrl = `${BASE}/qianfandev/topic/create?id=${id}`
        logger.debug('Draft created:', id)

        return this.createResult(true, {
          postId: String(id),
          postUrl: draftUrl,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      logger.error('publish failed:', error)
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (SKIP_IMAGE_HOSTS.some((h) => src.includes(h))) {
      return { url: src }
    }

    // SW 首试：依赖外层 publish 的 withCommunitySession（勿再嵌套）
    try {
      const imgRes = await this.runtime.fetch(src, { credentials: 'omit' })
      if (!imgRes.ok) {
        throw new Error(`下载图片失败: ${imgRes.status}`)
      }
      const blob = await imgRes.blob()
      const mime = blob.type || 'image/png'
      const filename = this.imageFilenameFromMime(mime)
      const csrf = await this.getCsrfToken()
      const formData = new FormData()
      formData.append('name', blob, filename)
      const data = await this.postMultipart<QianfanApiResponse<QianfanUploadResult>>(
        `${API}/upload/image`,
        formData,
        { csrftoken: csrf }
      )
      if (data.success && data.result?.fileUrl) {
        return { url: data.result.fileUrl }
      }
      throw new Error(this.extractError(data) || '图片上传失败')
    } catch (swError) {
      logger.debug('SW image upload failed:', swError)
    }

    // 主路径：页内上传（有页复用，无页 ensurePageTab 后台打开）
    try {
      return await this.uploadImageViaPageTab(src)
    } catch (pageError) {
      const msg = (pageError as Error)?.message || String(pageError)
      throw new Error(`千帆图片上传失败：${msg}`)
    }
  }

  private imageFilenameFromMime(mime: string): string {
    const ext =
      mime.includes('png')
        ? 'png'
        : mime.includes('gif')
          ? 'gif'
          : mime.includes('webp')
            ? 'webp'
            : 'jpg'
    return `image.${ext}`
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }

  /**
   * 在千帆页内上传：http(s) 只传 URL；小 data 走 args；大 data 走 storage + ISOLATED。
   */
  private async uploadImageViaPageTab(src: string): Promise<ImageUploadResult> {
    if (!this.runtime.tabs?.executeScript) {
      throw new Error('当前运行时不支持页面上下文上传')
    }

    const csrf = await this.getCsrfToken().catch(() => '')
    const uploadUrl = `${API}/upload/image`
    const isHttp = /^https?:\/\//i.test(src)
    const isData = src.startsWith('data:')

    type PageUploadPayload =
      | {
          mode: 'url'
          imageUrl: string
          filename: string
          csrf: string
          uploadUrl: string
        }
      | {
          mode: 'inline'
          base64: string
          mime: string
          filename: string
          csrf: string
          uploadUrl: string
        }
      | {
          mode: 'storage'
          storageKey: string
          csrf: string
          uploadUrl: string
        }

    let payload: PageUploadPayload
    let storageKey: string | null = null

    if (isHttp) {
      payload = {
        mode: 'url',
        imageUrl: src,
        filename: 'image.png',
        csrf,
        uploadUrl,
      }
    } else if (isData) {
      const imgRes = await this.runtime.fetch(src, { credentials: 'omit' })
      if (!imgRes.ok) {
        throw new Error(`读取 data URI 失败: ${imgRes.status}`)
      }
      const blob = await imgRes.blob()
      const mime = blob.type || 'image/png'
      const filename = this.imageFilenameFromMime(mime)
      const base64 = await this.blobToBase64(blob)
      if (blob.size <= PAGE_UPLOAD_INLINE_MAX_BYTES) {
        payload = { mode: 'inline', base64, mime, filename, csrf, uploadUrl }
      } else {
        storageKey = `qianfan:upload:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
        await this.runtime.storage.set(storageKey, { base64, mime, filename })
        payload = { mode: 'storage', storageKey, csrf, uploadUrl }
      }
    } else {
      // blob: 等：SW 下载后按大小 inline / storage
      const imgRes = await this.runtime.fetch(src, { credentials: 'omit' })
      if (!imgRes.ok) {
        throw new Error(`下载图片失败: ${imgRes.status}`)
      }
      const blob = await imgRes.blob()
      const mime = blob.type || 'image/png'
      const filename = this.imageFilenameFromMime(mime)
      const base64 = await this.blobToBase64(blob)
      if (blob.size <= PAGE_UPLOAD_INLINE_MAX_BYTES) {
        payload = { mode: 'inline', base64, mime, filename, csrf, uploadUrl }
      } else {
        storageKey = `qianfan:upload:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
        await this.runtime.storage.set(storageKey, { base64, mime, filename })
        payload = { mode: 'storage', storageKey, csrf, uploadUrl }
      }
    }

    const world = payload.mode === 'storage' ? ('ISOLATED' as const) : ('MAIN' as const)

    try {
      const pageResult = await this.runOnPageTab(PAGE_URL_PATTERN, CREATE_URL, (tabId) =>
        this.runtime.tabs!.executeScript(
          tabId,
          async (p: {
            mode: 'url' | 'inline' | 'storage'
            imageUrl?: string
            base64?: string
            mime?: string
            filename?: string
            storageKey?: string
            csrf: string
            uploadUrl: string
          }) => {
            try {
              let fileBlob: Blob
              let filename = p.filename || 'image.png'
              let mime = p.mime || 'image/png'

              if (p.mode === 'url') {
                const imgRes = await fetch(p.imageUrl!, { credentials: 'omit' })
                if (!imgRes.ok) {
                  return {
                    ok: false,
                    status: imgRes.status,
                    text: '',
                    error: `页面下载图片失败 HTTP ${imgRes.status}`,
                  }
                }
                fileBlob = await imgRes.blob()
                mime = fileBlob.type || mime
                if (mime.includes('png')) filename = 'image.png'
                else if (mime.includes('gif')) filename = 'image.gif'
                else if (mime.includes('webp')) filename = 'image.webp'
                else filename = 'image.jpg'
              } else if (p.mode === 'inline') {
                const raw = atob(p.base64!)
                const arr = new Uint8Array(raw.length)
                for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
                fileBlob = new Blob([arr], { type: mime })
              } else {
                const key = p.storageKey!
                const chromeApi = (
                  globalThis as unknown as {
                    chrome?: {
                      storage: {
                        local: {
                          get: (k: string) => Promise<Record<string, unknown>>
                          remove: (k: string) => Promise<void>
                        }
                      }
                    }
                  }
                ).chrome
                if (!chromeApi?.storage?.local) {
                  return {
                    ok: false,
                    status: 0,
                    text: '',
                    error: '页面上下文无 chrome.storage（需 ISOLATED）',
                  }
                }
                const bagResult = await chromeApi.storage.local.get(key)
                const bag = bagResult[key] as
                  | { base64?: string; mime?: string; filename?: string }
                  | undefined
                try {
                  await chromeApi.storage.local.remove(key)
                } catch {
                  // ignore
                }
                if (!bag?.base64) {
                  return {
                    ok: false,
                    status: 0,
                    text: '',
                    error: 'storage 中未找到图片载荷',
                  }
                }
                mime = bag.mime || mime
                filename = bag.filename || filename
                const raw = atob(bag.base64)
                const arr = new Uint8Array(raw.length)
                for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
                fileBlob = new Blob([arr], { type: mime })
              }

              const fd = new FormData()
              fd.append('name', fileBlob, filename)
              const headers: Record<string, string> = {}
              if (p.csrf) headers.csrftoken = p.csrf
              const res = await fetch(p.uploadUrl, {
                method: 'POST',
                credentials: 'include',
                headers,
                body: fd,
              })
              const text = await res.text()
              return { ok: res.ok, status: res.status, text }
            } catch (error) {
              return {
                ok: false,
                status: 0,
                text: '',
                error: (error as Error)?.message || String(error),
              }
            }
          },
          [
            {
              mode: payload.mode,
              imageUrl: payload.mode === 'url' ? payload.imageUrl : undefined,
              base64: payload.mode === 'inline' ? payload.base64 : undefined,
              mime: payload.mode === 'inline' ? payload.mime : undefined,
              filename:
                payload.mode === 'url' || payload.mode === 'inline'
                  ? payload.filename
                  : undefined,
              storageKey: payload.mode === 'storage' ? payload.storageKey : undefined,
              csrf: payload.csrf,
              uploadUrl: payload.uploadUrl,
            },
          ],
          { world }
        )
      )

      const result = pageResult as {
        ok?: boolean
        status?: number
        text?: string
        error?: string
      } | null

      if (result?.error) {
        throw new Error(result.error)
      }
      if (!result?.text) {
        throw new Error('页面上传无响应')
      }
      let data: QianfanApiResponse<QianfanUploadResult>
      try {
        data = JSON.parse(result.text) as QianfanApiResponse<QianfanUploadResult>
      } catch {
        throw new Error(`页面上传响应非 JSON: ${result.text.slice(0, 120)}`)
      }
      if (!data.success || !data.result?.fileUrl) {
        throw new Error(this.extractError(data) || `上传被拒绝 HTTP ${result.status ?? ''}`)
      }
      return { url: data.result.fileUrl }
    } finally {
      if (storageKey) {
        await this.runtime.storage.remove(storageKey).catch(() => undefined)
      }
    }
  }

  private async fetchUser(): Promise<QianfanUser | null> {
    const csrf = await this.getCsrfToken().catch(() => '')
    const data = await this.apiGetJson<QianfanUser>(
      `${API}/user_center/current`,
      csrf || undefined
    )
    return data ?? null
  }

  private async getCsrfToken(): Promise<string> {
    const cookieHeader = await this.collectCookieHeader()
    if (cookieHeader) {
      const re = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`)
      const m = cookieHeader.match(re)
      if (m?.[1]) {
        const token = stripCookieQuotes(decodeURIComponent(m[1]))
        if (token) return token
      }
    }

    if (this.runtime.getCookie) {
      for (const domain of COOKIE_DOMAINS) {
        const raw = await this.runtime.getCookie(domain, CSRF_COOKIE)
        if (raw) {
          const token = stripCookieQuotes(raw)
          if (token) return token
        }
      }
    }

    throw new Error('请先登录百度智能云/千帆社区')
  }

  private async apiGetJson<T>(url: string, csrf?: string): Promise<T | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (csrf) headers.csrftoken = csrf

    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers,
    })
    const text = await response.text()
    let data: QianfanApiResponse<T>
    try {
      data = JSON.parse(text) as QianfanApiResponse<T>
    } catch {
      throw new Error(`响应不是有效 JSON: ${text.substring(0, 100)}`)
    }
    if (!data.success) {
      throw new Error(this.extractError(data) || '请求失败')
    }
    return data.result ?? null
  }

  private async apiPostJson<T>(
    url: string,
    body: Record<string, unknown>,
    csrf: string
  ): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
        csrftoken: csrf,
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let data: QianfanApiResponse<T>
    try {
      data = JSON.parse(text) as QianfanApiResponse<T>
    } catch {
      throw new Error(`响应不是有效 JSON: ${text.substring(0, 100)}`)
    }
    if (!data.success || !data.result) {
      throw new Error(this.extractError(data) || '请求失败')
    }
    return data.result
  }

  private extractError(data: QianfanApiResponse): string {
    if (typeof data.message === 'string') return data.message
    if (data.message && typeof data.message === 'object' && data.message.global) {
      return data.message.global
    }
    if (data.error?.detail?.global) return data.error.detail.global
    if (data.error?.message) return data.error.message
    if (data.code) return String(data.code)
    return ''
  }
}
