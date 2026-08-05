/**
 * InfoQ 写作社区适配器
 * https://xie.infoq.cn/draft/
 *
 * 流程：create 草稿 → pushFull 写入 ProseMirror JSON → 返回草稿链接（不自动发布）
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('InfoQ')

const BASE = 'https://xie.infoq.cn'
const SKIP_IMAGE_HOSTS = ['static001.geekbang.org', 'static001.infoq.cn']

interface InfoqApiResponse<T = unknown> {
  code: number
  data?: T
  error?: { code?: number; msg?: string }
}

interface InfoqUserData {
  uid?: number
  nickname?: string
  avatar?: string
  is_author?: number
}

interface InfoqMark {
  type: string
}

export interface InfoqNode {
  type: string
  attrs?: Record<string, unknown>
  marks?: InfoqMark[]
  text?: string
  content?: InfoqNode[]
}

function emptyParagraph(number = 0, indent = 0): InfoqNode {
  return {
    type: 'paragraph',
    attrs: { indent, number, align: null, origin: null },
  }
}

function paragraphWith(content: InfoqNode[], number = 0, indent = 0): InfoqNode {
  const node = emptyParagraph(number, indent)
  if (content.length > 0) node.content = content
  return node
}

/** Markdown 列表行首空白 → InfoQ paragraph.attrs.indent（Tab=2 空格，每 2 空格一级） */
function listIndentFromLine(line: string): number {
  const ws = line.match(/^(\s*)/)?.[1] ?? ''
  const spaces = ws.replace(/\t/g, '  ').length
  return Math.min(8, Math.max(0, Math.floor(spaces / 2)))
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

/** GFM Markdown 表格行 → InfoQ embedcomp 用的 HTML table */
function markdownTableToHtml(tableLines: string[]): string {
  const rows = tableLines.map(splitTableCells)
  if (rows.length === 0) return '<table></table>'

  const hasSep = rows.length >= 2 && isTableSeparatorRow(tableLines[1])
  const header = hasSep ? rows[0] : null
  const bodyStart = hasSep ? 2 : 0
  const bodyRows = tableLines
    .slice(bodyStart)
    .filter((l) => !isTableSeparatorRow(l))
    .map(splitTableCells)

  let html = '<table>'
  if (header) {
    html +=
      '<thead><tr>' +
      header.map((c) => `<th>${escapeHtml(c)}</th>`).join('') +
      '</tr></thead>'
  }
  if (bodyRows.length > 0) {
    html +=
      '<tbody>' +
      bodyRows
        .map(
          (r) =>
            '<tr>' + r.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>'
        )
        .join('') +
      '</tbody>'
  }
  html += '</table>'
  return html
}

function textNode(text: string, marks?: InfoqMark[]): InfoqNode {
  const node: InfoqNode = { type: 'text', text }
  if (marks && marks.length > 0) node.marks = marks
  return node
}

/** 从 Markdown 取首段纯文本摘要，最长 120 字 */
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

/**
 * Markdown → InfoQ ProseMirror JSON（无 DOM）
 */
export function markdownToInfoqDoc(markdown: string): InfoqNode {
  const src = (markdown || '').replace(/\r\n/g, '\n')
  const placeholders: string[] = []
  const protect = (block: string): string => {
    const idx = placeholders.length
    placeholders.push(block)
    return `\0BLK${idx}\0`
  }

  // 保护 code fence 与块级公式，避免被行解析拆碎
  let work = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) =>
    protect(JSON.stringify({ kind: 'code', lang: lang || '', body: body.replace(/\n$/, '') }))
  )
  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) =>
    protect(JSON.stringify({ kind: 'katex', body: body.trim() }))
  )

  const lines = work.split('\n')
  const content: InfoqNode[] = []
  let i = 0

  const flushTable = (tableLines: string[]) => {
    content.push({
      type: 'embedcomp',
      attrs: {
        type: 'table',
        data: { content: markdownTableToHtml(tableLines) },
      },
    })
  }

  while (i < lines.length) {
    const line = lines[i]

    // 占位块
    const ph = line.match(/^\0BLK(\d+)\0\s*$/)
    if (ph) {
      const raw = placeholders[Number(ph[1])]
      try {
        const meta = JSON.parse(raw) as { kind: string; lang?: string; body: string }
        if (meta.kind === 'code') {
          content.push({
            type: 'codeblock',
            attrs: { lang: meta.lang || '' },
            content: [textNode(meta.body)],
          })
        } else if (meta.kind === 'katex') {
          content.push({
            type: 'katexblock',
            attrs: { mathString: meta.body },
          })
        }
      } catch {
        content.push(paragraphWith(parseInline(line)))
      }
      i++
      continue
    }

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const inline = parseInline(heading[2])
      content.push({
        type: 'heading',
        attrs: { align: null, level },
        content: inline.length ? inline : [textNode('')],
      })
      i++
      continue
    }

    // 水平线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: 'horizontalrule' })
      i++
      continue
    }

    // 表格：连续含 | 的行
    if (/\|/.test(line) && /^\s*\|?.*\|.*\|?\s*$/.test(line)) {
      const tableLines: string[] = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        tableLines.push(lines[i])
        i++
      }
      flushTable(tableLines)
      continue
    }

    // 引用：每行一个 paragraph，保留空 > 行
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      content.push({
        type: 'blockquote',
        content: (quoteLines.length ? quoteLines : ['']).map((p) =>
          paragraphWith(parseInline(p))
        ),
      })
      continue
    }

    // 无序列表（平铺 listitem，缩进写入 paragraph.attrs.indent）
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: InfoqNode[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const indent = listIndentFromLine(lines[i])
        const text = lines[i].replace(/^\s*[-*+]\s+/, '')
        items.push({
          type: 'listitem',
          attrs: { listStyle: null },
          content: [paragraphWith(parseInline(text), 0, indent)],
        })
        i++
      }
      content.push({ type: 'bulletedlist', content: items })
      continue
    }

    // 有序列表（平铺 + indent；同层 number 递增，回到上层时父序号继续）
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InfoqNode[] = []
      const counters: number[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const indent = listIndentFromLine(lines[i])
        counters.length = indent + 1
        counters[indent] = (counters[indent] ?? 0) + 1
        const number = counters[indent]
        const text = lines[i].replace(/^\s*\d+\.\s+/, '')
        items.push({
          type: 'listitem',
          attrs: { listStyle: null },
          content: [paragraphWith(parseInline(text), number, indent)],
        })
        i++
      }
      content.push({
        type: 'numberedlist',
        attrs: { start: 1, normalizeStart: 1 },
        content: items,
      })
      continue
    }

    // 单独一行图片
    const onlyImg = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/)
    if (onlyImg) {
      content.push(imageNode(onlyImg[2], onlyImg[1] || null))
      i++
      continue
    }

    // 普通段落：合并连续非空、非块起始行
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

  if (content.length === 0) {
    content.push(emptyParagraph())
  }

  return { type: 'doc', content }
}

function imageNode(src: string, alt: string | null): InfoqNode {
  return {
    type: 'image',
    attrs: {
      src,
      alt,
      title: null,
      style: [
        { key: 'width', value: '75%' },
        { key: 'bordertype', value: 'none' },
      ],
      href: null,
      fromPaste: true,
      pastePass: true,
    },
  }
}

/** 行内解析：code / 公式 / 图片 / 链接 / 加粗 / 斜体 / 删除线 */
export function parseInline(text: string): InfoqNode[] {
  if (!text) return []

  type Token =
    | { kind: 'text'; value: string }
    | { kind: 'code'; value: string }
    | { kind: 'katex'; value: string }
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
      tokens.push({ kind: 'katex', value: m[2].slice(1, -1) })
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

  const nodes: InfoqNode[] = []
  for (const tok of tokens) {
    if (tok.kind === 'code') {
      nodes.push({ type: 'codeinline', content: [textNode(tok.value)] })
    } else if (tok.kind === 'katex') {
      nodes.push({ type: 'katexinline', attrs: { mathString: tok.value } })
    } else if (tok.kind === 'image') {
      nodes.push(imageNode(tok.src, tok.alt || null))
    } else if (tok.kind === 'link') {
      nodes.push({
        type: 'link',
        attrs: { href: tok.href, title: '', type: null },
        content: parseEmphasis(tok.label),
      })
    } else {
      nodes.push(...parseEmphasis(tok.value))
    }
  }
  return nodes
}

/** 加粗 / 斜体 / 删除线（嵌套简化：不递归嵌套同类型） */
function parseEmphasis(text: string): InfoqNode[] {
  if (!text) return []
  const nodes: InfoqNode[] = []
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|(~~)(.+?)\5/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(textNode(text.slice(last, m.index)))
    }
    if (m[1]) {
      nodes.push(textNode(m[2], [{ type: 'strong' }]))
    } else if (m[3]) {
      nodes.push(textNode(m[4], [{ type: 'italic' }]))
    } else if (m[5]) {
      nodes.push(textNode(m[6], [{ type: 'del' }]))
    }
    last = m.index + m[0].length
  }
  if (last < text.length) {
    nodes.push(textNode(text.slice(last)))
  }
  return nodes.length ? nodes : [textNode(text)]
}

export class InfoqAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'infoq',
    name: 'InfoQ',
    icon: 'https://static001.geekbang.org/static/infoq/www/img/logo.b51e49df.png',
    homepage: 'https://xie.infoq.cn/draft/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://xie.infoq.cn/*',
      headers: {
        Origin: 'https://xie.infoq.cn',
        Referer: 'https://xie.infoq.cn/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://account.infoq.cn/*',
      headers: {
        Origin: 'https://xie.infoq.cn',
        Referer: 'https://xie.infoq.cn/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const user = await this.fetchUser()
        if (!user?.uid) {
          return { isAuthenticated: false, error: '未登录 InfoQ' }
        }
        return {
          isAuthenticated: true,
          userId: String(user.uid),
          username: user.nickname,
          avatar: user.avatar,
        }
      })
    } catch (error) {
      logger.debug('checkAuth failed:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting InfoQ draft sync...')
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const user = await this.fetchUser()
        if (!user?.uid) {
          throw new Error('请先登录 InfoQ 写作社区')
        }
        if ((user.is_author ?? 0) < 2) {
          throw new Error('请先在 InfoQ 开通创作权限')
        }

        const content = (article.markdown || '').trim()
        if (!content) {
          throw new Error('文章内容为空（未得到 Markdown），请重试同步')
        }

        const processedMd = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: SKIP_IMAGE_HOSTS,
            onProgress: options?.onImageProgress,
          }
        )

        const doc = markdownToInfoqDoc(processedMd)
        const summary = buildSummary(processedMd)

        let cover = ''
        const coverSrc = (article.cover || '').trim()
        if (/^https?:\/\//i.test(coverSrc)) {
          try {
            const up = await this.uploadImageByUrl(coverSrc)
            cover = up.url
          } catch (e) {
            logger.warn('cover upload failed, skip:', e)
          }
        }

        const draftId = await this.createDraft()
        await this.pushFull({
          id: draftId,
          version: 0,
          cover,
          title: article.title,
          summary,
          is_force: 1,
          content: JSON.stringify(doc),
        })

        return this.createResult(true, {
          postId: String(draftId),
          postUrl: `${BASE}/draft/${draftId}`,
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

    // data:/blob: 只能走 base64；https 先 urls，失败再下载后 base64
    if (/^data:/i.test(src) || /^blob:/i.test(src)) {
      const url = await this.uploadViaBase64(src)
      return { url }
    }

    if (/^https?:\/\//i.test(src)) {
      try {
        const url = await this.uploadViaUrls(src)
        return { url }
      } catch (error) {
        logger.debug('upload/urls failed, fallback to base64:', error)
      }
      const url = await this.uploadViaBase64(src)
      return { url }
    }

    const url = await this.uploadViaBase64(src)
    return { url }
  }

  /** 公网 URL 转存（服务端拉图） */
  private async uploadViaUrls(src: string): Promise<string> {
    const data = await this.apiPost<Array<{ src?: string; result?: string }>>(
      `${BASE}/api/v1/upload/urls`,
      { urls: [src] }
    )
    const result = data?.[0]?.result
    if (!result) {
      throw new Error('图片转存失败')
    }
    return result
  }

  /** 本地下载后 base64 上传（支持 data URI / 防盗链外链） */
  private async uploadViaBase64(src: string): Promise<string> {
    const imgRes = await this.runtime.fetch(src, { credentials: 'omit' })
    if (!imgRes.ok) {
      throw new Error(`下载图片失败: ${imgRes.status}`)
    }
    const blob = await imgRes.blob()
    const mime = blob.type || 'image/png'
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    const b64 = btoa(binary)
    const file = `data:${mime};base64,${b64}`

    const data = await this.apiPost<{ url?: string }>(`${BASE}/api/v1/upload/base64`, {
      file,
    })
    if (!data?.url) {
      throw new Error('图片转存失败')
    }
    return data.url
  }

  private async fetchUser(): Promise<InfoqUserData | null> {
    const data = await this.apiPost<InfoqUserData>(`${BASE}/public/v1/user/get_user`, {})
    return data ?? null
  }

  private async createDraft(): Promise<number> {
    try {
      const data = await this.apiPost<{ id?: number }>(`${BASE}/api/v1/draft/create`, {})
      if (!data?.id) {
        throw new Error('创建草稿失败：未返回 ID')
      }
      return data.id
    } catch (error) {
      const msg = (error as Error).message
      if (msg.includes('-12005') || msg.includes('草稿')) {
        throw new Error('草稿箱已满，请先清理 InfoQ 草稿')
      }
      throw error
    }
  }

  private async pushFull(payload: Record<string, unknown>): Promise<void> {
    await this.apiPost(`${BASE}/api/v1/draft/pushFull`, payload)
  }

  private async apiPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.postJson<InfoqApiResponse<T>>(url, body)
    if (res.code !== 0) {
      const errCode = res.error?.code
      const errMsg = res.error?.msg
      if (errCode === -12005 || String(errCode) === '-12005') {
        throw new Error('草稿箱已满，请先清理 InfoQ 草稿')
      }
      throw new Error(errMsg || `请求失败 code=${res.code}`)
    }
    return res.data as T
  }
}
