/**
 * 魔搭研习社适配器
 * https://modelscope.cn/learn/create
 *
 * 仅保存草稿；正文为 Cangjie JsonML（由 Markdown 转换）。
 * 鉴权：GET /api/v1/users/login/info（SW 优先，失败再页面上下文）。
 * 图片：uploadUrl(RACE_IMAGE) → OSS PUT → downloadUrl。
 * 草稿：POST /api/v1/articles { ContentDraft }；成功后 /learn/edit/{Id}。
 * 创建需账号具备勋章；不支持 Mermaid / 公式（降级为普通代码块，平台不渲染）；本地 data URI 剥离。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Modelscope')

const BASE = 'https://modelscope.cn'
const CREATE_URL = `${BASE}/learn/create`
const PAGE_URL_PATTERN = '*://modelscope.cn/*'
const API = `${BASE}/api/v1`
const LOGIN_INFO_URL = `${API}/users/login/info`
const UPLOAD_URL_API = `${API}/rm/uploadUrl`
const DOWNLOAD_URL_API = `${API}/rm/downloadUrl`
const ARTICLES_API = `${API}/articles`
const COOKIE_DOMAINS = ['modelscope.cn']
const UPLOAD_TYPE = 'RACE_IMAGE'

type JsonML = [string, Record<string, unknown>, ...JsonMLNode[]]
type JsonMLNode = JsonML | string

interface MsApiResponse<T = unknown> {
  Code?: number
  Success?: boolean
  Message?: string
  Data?: T
}

interface LoginInfoData {
  Name?: string
  NickName?: string
  Avatar?: string
  Email?: string
  HavanaId?: string
}

interface UploadUrlData {
  UploadUrl?: string
}

interface DownloadUrlData {
  DownloadUrl?: string
}

interface CreateArticleData {
  Id?: number | string
  id?: number | string
  Articles?: Array<{ Id?: number | string }>
}

/** 从 login/info 响应解析鉴权结果（可单测） */
export function authFromLoginInfo(payload: MsApiResponse<LoginInfoData> | null | undefined): AuthResult | null {
  if (!payload || payload.Success !== true || payload.Code !== 200) return null
  const name = (payload.Data?.Name || payload.Data?.NickName || '').trim()
  if (!name) return null
  return {
    isAuthenticated: true,
    username: name,
    avatar: payload.Data?.Avatar || undefined,
  }
}

function newUuid(): string {
  return `ms${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function emptyInline(): JsonML {
  return ['span', { 'data-type': 'text' }, ['span', { 'data-type': 'leaf' }, '']]
}

function leafSpan(text: string, marks: Record<string, unknown> = {}): JsonML {
  return ['span', { 'data-type': 'text' }, ['span', { 'data-type': 'leaf', ...marks }, text]]
}

function pNode(...inlines: JsonMLNode[]): JsonML {
  return ['p', { uuid: newUuid() }, ...(inlines.length ? inlines : [emptyInline()])]
}

const ULIST_BULLETS = ['●', '○', '■', '◆'] as const

/** 列表行首空白折合空格数（Tab=2） */
export function listIndentSpaces(line: string): number {
  const ws = line.match(/^(\s*)/)?.[1] ?? ''
  return ws.replace(/\t/g, '  ').length
}

/**
 * 将同一列表块内的原始缩进映射为 0/1/2… 级。
 * 避免「2 空格一级」把常见的 4 空格二级列表算成三级。
 */
export function normalizeListLevels(spaceCounts: number[]): number[] {
  const ranked = [...new Set(spaceCounts)].sort((a, b) => a - b)
  return spaceCounts.map((s) => Math.min(8, Math.max(0, ranked.indexOf(s))))
}

function listStyleFor(level: number, isOrdered: boolean): { format: string; text: string; align: string } {
  if (isOrdered) {
    return {
      format: level === 0 ? 'decimal' : level === 1 ? 'lowerLetter' : 'lowerRoman',
      text: '%1.',
      align: 'left',
    }
  }
  return {
    format: 'bullet',
    text: ULIST_BULLETS[Math.min(level, ULIST_BULLETS.length - 1)],
    align: 'left',
  }
}

/** 列表项 → 带 list/listStyle 的段落（对齐平台 markdownToJsonML，不用 ind） */
function listItemNode(
  text: string,
  opts: { listId: string; level: number; isOrdered: boolean },
): JsonML {
  const inlines = parseInline(text)
  return [
    'p',
    {
      uuid: newUuid(),
      list: {
        listId: opts.listId,
        level: opts.level,
        isOrdered: opts.isOrdered,
        listStyle: listStyleFor(opts.level, opts.isOrdered),
      },
    },
    ...(inlines.length ? inlines : [emptyInline()]),
  ]
}

function headingNode(level: number, text: string): JsonML {
  const tag = level <= 1 ? 'h3' : level === 2 ? 'h3' : level === 3 ? 'h3' : 'h4'
  return [tag, { uuid: newUuid() }, leafSpan(text)]
}

function hrNode(): JsonML {
  return ['hr', { uuid: newUuid() }, emptyInline()]
}

function codeBlockNode(code: string, syntax: string): JsonML {
  return [
    'code',
    {
      syntax: syntax || 'plaintext',
      theme: 'default',
      code,
      uuid: newUuid(),
    },
    emptyInline(),
  ]
}

function imgNode(src: string, name = 'image.png'): JsonML {
  return [
    'img',
    {
      uuid: newUuid(),
      name,
      src,
      size: 0,
      width: 0,
      height: 0,
    },
    emptyInline(),
  ]
}

function linkNode(href: string, text: string): JsonML {
  return ['a', { href, uuid: newUuid() }, leafSpan(text || href)]
}

function inlineCodeNode(text: string): JsonML {
  return ['inlineCode', { uuid: newUuid() }, leafSpan(text)]
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

/** 识别 Markdown 对齐分隔行（含 `---` / `:-:` / `:---` / `---:`） */
function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableCells(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

/** 从分隔单元格解析对齐：`:-:` 居中，`---:` 右，`:---` / `---` 左 */
function cellAlignFromSep(sepCell: string): 'left' | 'center' | 'right' | undefined {
  const c = sepCell.trim()
  if (!c) return undefined
  const left = c.startsWith(':')
  const right = c.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return undefined
}

function tcNode(text: string, align?: 'left' | 'center' | 'right'): JsonML {
  const para = pNode(...parseInline(text || ''))
  if (align === 'center' || align === 'right') {
    ;(para[1] as Record<string, unknown>).jc = align
  }
  return [
    'tc',
    { rowSpan: 1, colSpan: 1, uuid: newUuid(), vAlign: 'top' },
    para,
  ]
}

function trNode(cells: string[], isHeader: boolean, aligns?: Array<'left' | 'center' | 'right' | undefined>): JsonML {
  const attrs: Record<string, unknown> = { uuid: newUuid() }
  if (isHeader) attrs.isTblHeader = true
  return [
    'tr',
    attrs,
    ...cells.map((c, i) => tcNode(c, aligns?.[i])),
  ]
}

/** Markdown 表格行 → 魔搭 table JsonML（丢弃对齐分隔行，并应用列对齐） */
export function markdownTableToJsonML(tableLines: string[]): JsonML {
  const sepIdx = tableLines.findIndex((line) => isTableSeparatorRow(line))
  const aligns =
    sepIdx >= 0
      ? splitTableCells(tableLines[sepIdx]).map(cellAlignFromSep)
      : undefined
  const dataLines = tableLines.filter((line) => !isTableSeparatorRow(line))
  const rows = dataLines.map(splitTableCells)
  if (!rows.length) {
    return ['table', { uuid: newUuid(), styleId: 'tableHeader' }, trNode([''], true)]
  }
  const header = rows[0]
  const body = rows.slice(1)
  const colCount = Math.max(header.length, ...body.map((r) => r.length), 1)
  const normalize = (cells: string[]) => {
    const next = cells.slice(0, colCount)
    while (next.length < colCount) next.push('')
    return next
  }
  const colsWidth = Array.from({ length: colCount }, () => Math.floor(980 / colCount))
  return [
    'table',
    {
      colsWidth,
      tblW: { type: 'pct' },
      styleId: 'tableHeader',
      tblLook: { firstRow: 1, lastRow: 0, firstColumn: 0, lastColumn: 0 },
      uuid: newUuid(),
    },
    trNode(normalize(header), true, aligns),
    ...body.map((r) => trNode(normalize(r), false, aligns)),
  ]
}

/** 行内：code / 图片 / 链接 / 加粗 / 斜体 */
export function parseInline(text: string): JsonMLNode[] {
  const nodes: JsonMLNode[] = []
  const re =
    /(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(leafSpan(text.slice(last, m.index)))
    }
    const token = m[0]
    if (token.startsWith('`')) {
      nodes.push(inlineCodeNode(token.slice(1, -1)))
    } else if (token.startsWith('![')) {
      const img = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
      if (img) nodes.push(imgNode(img[2], img[1] || 'image.png'))
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) nodes.push(linkNode(link[2], link[1]))
    } else if (token.startsWith('**')) {
      nodes.push(leafSpan(token.slice(2, -2), { bold: true }))
    } else if (token.startsWith('*')) {
      nodes.push(leafSpan(token.slice(1, -1), { italic: true }))
    }
    last = m.index + token.length
  }
  if (last < text.length) {
    nodes.push(leafSpan(text.slice(last)))
  }
  return nodes.length ? nodes : [leafSpan('')]
}

/**
 * Markdown → 魔搭研习社 ContentDraft（JsonML 字符串）
 * Mermaid / 块级与行间公式降级为普通代码块；无 DOM。
 */
export function markdownToModelscopeJsonML(markdown: string): string {
  const src = (markdown || '').replace(/\r\n/g, '\n')
  const placeholders: string[] = []
  const protect = (block: string): string => {
    const idx = placeholders.length
    placeholders.push(block)
    return `\0BLK${idx}\0`
  }

  // 保护 fence；mermaid / 数学 fence 一律当代码块
  let work = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const rawLang = (lang || '').trim()
    const syntax =
      rawLang === 'mermaid' || rawLang === 'math' || rawLang === 'latex' || rawLang === 'tex'
        ? 'plaintext'
        : rawLang || 'plaintext'
    return protect(JSON.stringify({ kind: 'code', syntax, body: body.replace(/\n$/, '') }))
  })
  // 块级 $$...$$ → 代码块
  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) =>
    protect(JSON.stringify({ kind: 'code', syntax: 'plaintext', body: body.trim() }))
  )
  // 行内 $...$ → 行内代码
  work = work.replace(/\$([^$\n]+?)\$/g, (_m, body: string) => `\`${body.trim()}\``)

  const lines = work.split('\n')
  const blocks: JsonML[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const ph = line.match(/^\0BLK(\d+)\0\s*$/)
    if (ph) {
      try {
        const meta = JSON.parse(placeholders[Number(ph[1])]) as {
          kind: string
          syntax?: string
          body: string
        }
        if (meta.kind === 'code') {
          blocks.push(codeBlockNode(meta.body, meta.syntax || 'plaintext'))
        }
      } catch {
        blocks.push(pNode(...parseInline(line.replace(/\0BLK\d+\0/g, ''))))
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
      blocks.push(headingNode(heading[1].length, heading[2]))
      i++
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(hrNode())
      i++
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(pNode(...parseInline(quoteLines.join(' '))))
      continue
    }

    // 无序 / 有序列表 → p + list/listStyle；缩进按块内相对层级归一
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const rawItems: Array<{ raw: string; spaces: number; isOrdered: boolean; text: string }> = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const raw = lines[i]
        rawItems.push({
          raw,
          spaces: listIndentSpaces(raw),
          isOrdered: /^\s*\d+\.\s+/.test(raw),
          text: raw.replace(/^\s*([-*+]|\d+\.)\s+/, ''),
        })
        i++
      }
      const levels = normalizeListLevels(rawItems.map((it) => it.spaces))
      let listId = newUuid()
      let prevOrdered: boolean | null = null
      for (let k = 0; k < rawItems.length; k++) {
        const it = rawItems[k]
        if (prevOrdered !== null && prevOrdered !== it.isOrdered) {
          listId = newUuid()
        }
        prevOrdered = it.isOrdered
        blocks.push(listItemNode(it.text, { listId, level: levels[k], isOrdered: it.isOrdered }))
      }
      continue
    }

    // 表格 → table/tr/tc（非代码块）
    if (/\|/.test(line) && /^\s*\|?.*\|.*\|?\s*$/.test(line)) {
      const tableLines: string[] = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        tableLines.push(lines[i])
        i++
      }
      if (!tableLines.length) continue
      blocks.push(markdownTableToJsonML(tableLines))
      continue
    }

    // 普通段落：合并连续非空非特殊行
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^\0BLK\d+\0\s*$/.test(lines[i]) &&
      !( /\|/.test(lines[i]) && /^\s*\|?.*\|.*\|?\s*$/.test(lines[i]) )
    ) {
      para.push(lines[i])
      i++
    }
    if (para.length) {
      blocks.push(pNode(...parseInline(para.join('\n'))))
    }
  }

  const root: JsonML = ['root', {}, ...(blocks.length ? blocks : [pNode(leafSpan(''))])]
  return JSON.stringify(root)
}

export class ModelscopeAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'modelscope',
    name: '魔搭研习社',
    icon: 'https://img.alicdn.com/imgextra/i4/O1CN01fvt4it25rEZU4Gjso_!!6000000007579-2-tps-128-128.png',
    homepage: BASE,
    capabilities: ['article', 'draft'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://modelscope.cn/api/*',
      headers: {
        Origin: BASE,
        Referer: CREATE_URL,
      },
      resourceTypes: ['xmlhttprequest', 'other'] as string[],
    },
  ]

  private async getCsrfToken(): Promise<string> {
    for (const domain of COOKIE_DOMAINS) {
      try {
        const cookies = await this.runtime.cookies.get(domain)
        const hit = cookies.find((c) => c.name === 'csrf_token')
        if (hit?.value) {
          try {
            return decodeURIComponent(hit.value)
          } catch {
            return hit.value
          }
        }
      } catch (error) {
        logger.debug('getCsrfToken failed for', domain, error)
      }
    }
    return ''
  }

  private async jsonHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const csrf = await this.getCsrfToken()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...extra,
    }
    if (csrf) headers['X-CSRF-TOKEN'] = csrf
    return headers
  }

  private async detectAuthViaSw(): Promise<AuthResult | null> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const response = await this.runtime.fetch(LOGIN_INFO_URL, {
        method: 'GET',
        credentials: 'include',
        headers: await this.jsonHeaders(),
      })
      const text = await response.text()
      let data: MsApiResponse<LoginInfoData>
      try {
        data = JSON.parse(text) as MsApiResponse<LoginInfoData>
      } catch {
        logger.debug('SW login/info non-JSON:', text.substring(0, 120))
        return null
      }
      return authFromLoginInfo(data)
    })
  }

  private async detectAuthViaPage(): Promise<AuthResult | null> {
    if (!this.runtime.tabs) return null
    const data = await this.pageFetchJson<MsApiResponse<LoginInfoData>>(
      PAGE_URL_PATTERN,
      CREATE_URL,
      LOGIN_INFO_URL,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    )
    return authFromLoginInfo(data)
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      try {
        const fromSw = await this.detectAuthViaSw()
        if (fromSw) return fromSw
        logger.debug('SW login/info did not recognize login')
      } catch (error) {
        logger.debug('SW login probe failed:', error)
      }

      try {
        const fromPage = await this.detectAuthViaPage()
        if (fromPage) return fromPage
      } catch (error) {
        logger.debug('pageFetchJson login probe failed:', error)
      }

      return {
        isAuthenticated: false,
        error: `未登录魔搭社区，请先打开并登录 ${CREATE_URL}`,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  private async uploadImageBinary(file: Blob, filename: string): Promise<string> {
    const headers = await this.jsonHeaders()
    const tokenRes = await this.runtime.fetch(UPLOAD_URL_API, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ FileName: filename, Type: UPLOAD_TYPE }),
    })
    const tokenText = await tokenRes.text()
    let tokenJson: MsApiResponse<UploadUrlData>
    try {
      tokenJson = JSON.parse(tokenText) as MsApiResponse<UploadUrlData>
    } catch {
      throw new Error(`uploadUrl 响应非 JSON: ${tokenText.slice(0, 160)}`)
    }
    const uploadUrl = tokenJson.Data?.UploadUrl
    if (!tokenJson.Success || tokenJson.Code !== 200 || !uploadUrl) {
      throw new Error(tokenJson.Message || '获取上传地址失败')
    }

    const putRes = await this.runtime.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-oss-meta-author': 'aliy',
      },
      body: file,
    })
    if (!putRes.ok) {
      throw new Error(`OSS 上传失败: HTTP ${putRes.status}`)
    }

    const fileUrl = uploadUrl.split('?')[0]
    const dlRes = await this.runtime.fetch(DOWNLOAD_URL_API, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ FileUrl: fileUrl, Type: UPLOAD_TYPE }),
    })
    const dlText = await dlRes.text()
    let dlJson: MsApiResponse<DownloadUrlData>
    try {
      dlJson = JSON.parse(dlText) as MsApiResponse<DownloadUrlData>
    } catch {
      throw new Error(`downloadUrl 响应非 JSON: ${dlText.slice(0, 160)}`)
    }
    const downloadUrl = (dlJson.Data?.DownloadUrl || '').split('?')[0]
    if (!dlJson.Success || dlJson.Code !== 200 || !downloadUrl) {
      throw new Error(dlJson.Message || '换取下载地址失败')
    }
    return downloadUrl
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const response = await this.runtime.fetch(src, { method: 'GET' })
      if (!response.ok) {
        logger.warn('Failed to download image:', response.status)
        return { url: src }
      }
      const blob = await response.blob()
      const ext =
        blob.type.includes('png')
          ? 'png'
          : blob.type.includes('gif')
            ? 'gif'
            : blob.type.includes('webp')
              ? 'webp'
              : 'jpg'
      const url = await this.uploadImageBinary(blob, `image.${ext}`)
      return { url }
    } catch (error) {
      logger.warn('外链转存失败，保留原 URL:', src.slice(0, 80), error)
      return { url: src }
    }
  }

  private articleIdFrom(data: MsApiResponse<CreateArticleData> | null | undefined): string | null {
    if (!data?.Data) return null
    const d = data.Data
    const id = d.Id ?? d.id ?? d.Articles?.[0]?.Id
    return id != null && String(id) ? String(id) : null
  }

  private isMedalError(message: string): boolean {
    return /勋章/.test(message)
  }

  private async createDraftSw(contentDraft: string): Promise<MsApiResponse<CreateArticleData>> {
    const bodyStr = JSON.stringify({ ContentDraft: contentDraft })
    const response = await this.runtime.fetch(ARTICLES_API, {
      method: 'POST',
      credentials: 'include',
      headers: await this.jsonHeaders(),
      body: bodyStr,
    })
    const text = await response.text()
    logger.debug('SW articles create:', response.status, text.substring(0, 300))
    let data: MsApiResponse<CreateArticleData>
    try {
      data = JSON.parse(text) as MsApiResponse<CreateArticleData>
    } catch {
      throw new Error(`创建草稿响应非 JSON: ${text.slice(0, 160)}`)
    }
    return data
  }

  /** 页面上下文回退：storage 中转正文，避免 executeScript args 过大 */
  private async createDraftViaPage(contentDraft: string): Promise<MsApiResponse<CreateArticleData>> {
    if (!this.runtime.tabs?.executeScript) {
      throw new Error('创建草稿失败: Service Worker 无效且当前运行时不支持页面探测')
    }
    const bodyStr = JSON.stringify({ ContentDraft: contentDraft })
    const key = `modelscope:articles:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    await this.runtime.storage.set(key, bodyStr)
    const stored = await this.runtime.storage.get<string>(key)
    if (typeof stored !== 'string' || !stored) {
      throw new Error('草稿正文写入 storage 失败（读回为空）')
    }

    try {
      const result = await this.runOnPageTab(PAGE_URL_PATTERN, CREATE_URL, async (tabId) => {
        return this.runtime.tabs!.executeScript(
          tabId,
          async (storageKey: string, fetchUrl: string) => {
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
            try {
              const bag = await chromeApi.storage.local.get(storageKey)
              const body = bag[storageKey]
              if (typeof body !== 'string' || !body) {
                return {
                  ok: false,
                  status: 0,
                  text: '',
                  error: '草稿正文未传到页面（storage 为空）',
                }
              }
              const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
              const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : ''
              const headers: Record<string, string> = {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              }
              if (csrf) headers['X-CSRF-TOKEN'] = csrf
              try {
                const response = await fetch(fetchUrl, {
                  method: 'POST',
                  credentials: 'include',
                  headers,
                  body,
                })
                const text = await response.text()
                return { ok: response.ok, status: response.status, text }
              } finally {
                await chromeApi.storage.local.remove(storageKey)
              }
            } catch (error) {
              try {
                await chromeApi.storage.local.remove(storageKey)
              } catch {
                // ignore
              }
              return {
                ok: false,
                status: 0,
                text: '',
                error: (error as Error)?.message || String(error),
              }
            }
          },
          [key, ARTICLES_API] as [string, string],
          { world: 'ISOLATED' }
        )
      })

      if (!result || result.error) {
        throw new Error(result?.error || '页面请求失败')
      }
      if (!result.text?.trim()) {
        throw new Error(`页面响应为空 HTTP ${result.status}`)
      }
      let data: MsApiResponse<CreateArticleData>
      try {
        data = JSON.parse(result.text) as MsApiResponse<CreateArticleData>
      } catch {
        throw new Error(`页面响应非 JSON HTTP ${result.status}: ${result.text.slice(0, 120)}`)
      }
      return data
    } finally {
      await this.runtime.storage.remove(key).catch(() => undefined)
    }
  }

  private async createDraft(contentDraft: string): Promise<MsApiResponse<CreateArticleData>> {
    try {
      const data = await this.withHeaderRules(this.HEADER_RULES, () =>
        this.createDraftSw(contentDraft)
      )
      if (this.articleIdFrom(data)) return data
      const msg = data.Message || ''
      if (this.isMedalError(msg)) {
        throw new Error(msg)
      }
      if (data.Success === false || (data.Code !== undefined && data.Code !== 200)) {
        logger.debug('SW create business fail:', data.Code, data.Message)
      } else if (!this.articleIdFrom(data)) {
        logger.debug('SW create missing Id:', data)
      }
    } catch (error) {
      const msg = (error as Error).message || ''
      if (this.isMedalError(msg)) throw error
      logger.debug('SW articles create failed:', error)
    }

    const pageData = await this.createDraftViaPage(contentDraft)
    if (this.articleIdFrom(pageData)) return pageData
    const pageMsg = pageData.Message || '创建草稿失败'
    throw new Error(pageMsg)
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting ModelScope draft publish...')

      let markdown = (article.markdown || '')
        .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
        .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')

      markdown = await this.withHeaderRules(this.HEADER_RULES, async () =>
        this.processImages(
          markdown,
          async (src) => {
            try {
              return await this.uploadImageByUrl(src)
            } catch (error) {
              logger.warn('外链转存失败，保留原 URL:', src.slice(0, 80), error)
              return { url: src }
            }
          },
          {
            skipPatterns: ['resources.modelscope.cn', 'modelscope-resouces.oss'],
            onProgress: options?.onImageProgress,
          }
        )
      )

      const contentDraft = markdownToModelscopeJsonML(markdown)
      const data = await this.createDraft(contentDraft)
      const id = this.articleIdFrom(data)
      if (!id) {
        throw new Error(data.Message || '创建草稿失败: 无效响应')
      }

      const draftUrl = `${BASE}/learn/edit/${id}`
      logger.info('Draft created:', draftUrl)
      return this.createResult(true, {
        postId: id,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    } catch (error) {
      logger.error('publish failed:', (error as Error).message)
      return this.createResult(false, {
        error: (error as Error).message,
      })
    } finally {
      await this.releaseEphemeralTabs()
    }
  }
}
