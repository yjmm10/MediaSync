/**
 * 本地 Markdown 文件导入支持
 *
 * 用于从用户通过 <input type="file" webkitdirectory> 选择的目录中读取
 * Markdown 文件及其引用的本地图片资源，将本地图片（相对路径引用，
 * 如 ./imgs/1.png）转换为 data URI 嵌入到正文里。
 *
 * 之后再由各平台适配器的 processImages（见 code-adapter.ts）统一把
 * data URI 上传到对应平台的图床。这样图片会落到每个平台自己的图床，
 * 最可靠。
 *
 * 设计要点：
 * - 目录选择后，每个 File 带 webkitRelativePath（相对所选目录根）
 * - Markdown 中的图片相对路径基于 Markdown 文件所在目录解析
 * - 同一张图片多次引用只读取一次（缓存）
 */
import { markdownToHtml } from '@mediasync/core'
import { createLogger } from './logger'

const logger = createLogger('LocalMarkdown')

/** 支持的图片 MIME 类型映射 */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/** 合法的 Markdown 扩展名 */
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd'])

/**
 * 浏览器 File 对象在通过 webkitdirectory 选择时会额外携带
 * webkitRelativePath 字段，标准 lib.dom.d.ts 未声明，这里补上。
 */
type RelativeFile = File & { webkitRelativePath?: string }

/** 取文件扩展名（小写，含点） */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

/** 去掉文件名的扩展名，用作标题回退 */
function basenameWithoutExt(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(0, i) : base
}

/**
 * 归一化路径：反斜杠转正斜杠、合并重复斜杠、去掉前导 `./` 与尾部斜杠。
 * 注意：前导 `..` 必须保留，交由 resolveRelativePath 处理。
 */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/')
  s = s.replace(/^\.\/+/, '')
  s = s.replace(/\/+/g, '/')
  s = s.replace(/\/$/, '')
  return s
}

/**
 * 基于目录解析相对路径，返回归一化的完整相对路径。
 * 支持 `./`、`../`、普通相对路径；Windows 盘符或 `/` 开头的路径无法
 * 在所选目录内定位，返回其 basename 便于回退查找。
 */
function resolveRelativePath(baseDir: string, relPath: string): string {
  const rel = relPath.replace(/\\/g, '/').trim()

  // 绝对路径（/开头或 Windows 盘符）在所选目录内无法定位，
  // 回退为 basename 在文件库中碰运气查找
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    return normalizePath(rel.split('/').pop() || rel)
  }

  const combined = (baseDir ? baseDir + '/' : '') + rel
  const parts = combined.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

/**
 * 所选文件的索引：按 webkitRelativePath 建立映射，
 * 查找时大小写不敏感（兼容 Windows / 大小写不一致的引用）。
 */
export class FileIndex {
  private byPath = new Map<string, File>()
  private byLower = new Map<string, File>()

  constructor(files: File[]) {
    for (const f of files) {
      const rf = f as RelativeFile
      const key = normalizePath(rf.webkitRelativePath || f.name)
      if (!this.byPath.has(key)) this.byPath.set(key, f)
      const lower = key.toLowerCase()
      if (!this.byLower.has(lower)) this.byLower.set(lower, f)
    }
  }

  /** 按相对路径查找（大小写不敏感） */
  get(relPath: string): File | undefined {
    const key = normalizePath(relPath)
    return this.byPath.get(key) || this.byLower.get(key.toLowerCase())
  }

  /** 按 basename 查找（绝对路径引用的兜底） */
  getByBasename(relPath: string): File | undefined {
    const base = normalizePath(relPath).split('/').pop()
    if (!base) return undefined
    return this.get(base)
  }
}

/** 判断引用是否为非本地资源（不处理） */
function isRemoteOrEmbedded(src: string): boolean {
  const s = src.trim()
  return (
    s === '' ||
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('//') ||
    s.startsWith('data:') ||
    s.startsWith('#') ||
    s.startsWith('mailto:') ||
    s.startsWith('tel:')
  )
}

/** 所选文件中的 Markdown 文件列表 */
export function findMarkdownFiles(files: File[]): File[] {
  return files.filter(f => MARKDOWN_EXTS.has(extOf(f.name)))
}

/** 从 Markdown 文本提取标题与正文（剥离 front matter / 首个一级标题） */
export interface ParsedMarkdown {
  title: string
  body: string
  /** front matter 中的封面路径（尚未转换为 data URI） */
  cover?: string
}

export function parseMarkdown(content: string, fallbackTitle: string): ParsedMarkdown {
  let title: string | null = null
  let cover: string | undefined
  let body = content

  // 1. YAML front matter
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (yamlMatch) {
    const fm = yamlMatch[1]
    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch) title = titleMatch[1].trim()
    const coverMatch = fm.match(/^(?:cover|image|thumbnail|banner):\s*["']?(.+?)["']?\s*$/m)
    if (coverMatch) cover = coverMatch[1].trim()
    body = content.slice(yamlMatch[0].length)
  }

  // 2. 首个一级标题
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m)
    if (h1) {
      title = h1[1].trim()
      body = body.replace(/^#\s+.+\n?/, '')
    }
  }

  if (!body.trim()) body = content

  return { title: title || fallbackTitle, body: body.trim(), cover }
}

/** 读取 File 为 data URI */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('无法读取文件为 data URI'))
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader 读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 单张图片引用（Markdown 或 HTML） */
interface ImageRef {
  full: string
  src: string
  alt: string
  kind: 'md' | 'html'
}

/** 提取内容中的所有图片引用 */
function extractImageRefs(content: string): ImageRef[] {
  const refs: ImageRef[] = []

  // Markdown: ![alt](src) 或 ![alt](src "title") 或 ![alt](<src with space>)
  const mdRe = /!\[([^\]]*)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = mdRe.exec(content)) !== null) {
    const raw = m[2].trim()
    // 去掉尖括号包裹，去掉可选 title（空格之后的部分）
    const src = raw
      .replace(/^<|>$/g, '')
      .split(/\s+/)[0]
      .trim()
    refs.push({ full: m[0], src, alt: m[1], kind: 'md' })
  }

  // HTML: <img src="..."> （单双引号都支持）
  const htmlRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  while ((m = htmlRe.exec(content)) !== null) {
    refs.push({ full: m[0], src: m[1].trim(), alt: '', kind: 'html' })
  }

  return refs
}

export interface ResolveImagesResult {
  content: string
  total: number
  converted: number
  failed: Array<{ ref: string; reason: string }>
}

/**
 * 把内容中的本地图片引用替换为 data URI。
 * 网络图片 / data URI / 锚点等保持不变。
 */
export async function resolveLocalImages(
  content: string,
  index: FileIndex,
  baseDir: string,
  onProgress?: (done: number, total: number) => void
): Promise<ResolveImagesResult> {
  const allRefs = extractImageRefs(content)
  const localRefs = allRefs.filter(r => !isRemoteOrEmbedded(r.src))
  const total = localRefs.length

  if (total === 0) {
    return { content, total: 0, converted: 0, failed: [] }
  }

  const failed: ResolveImagesResult['failed'] = []
  const cache = new Map<string, string>() // resolvedPath -> dataUri
  let converted = 0
  let done = 0
  let result = content

  for (const ref of localRefs) {
    const resolved = resolveRelativePath(baseDir, ref.src)
    const lookupKey = ref.src !== resolved ? ref.src : resolved

    let dataUri = cache.get(resolved)
    if (!dataUri) {
      let file = index.get(resolved) || index.get(lookupKey)
      if (!file) file = index.getByBasename(ref.src) // 绝对路径引用兜底

      if (!file) {
        failed.push({ ref: ref.src, reason: '在所选目录中未找到该文件' })
        done++
        onProgress?.(done, total)
        continue
      }

      if (!MIME_TYPES[extOf(file.name)]) {
        failed.push({ ref: ref.src, reason: '不支持的图片格式' })
        done++
        onProgress?.(done, total)
        continue
      }

      try {
        dataUri = await fileToDataUri(file)
        cache.set(resolved, dataUri)
      } catch (e) {
        failed.push({ ref: ref.src, reason: (e as Error).message })
        done++
        onProgress?.(done, total)
        continue
      }
    }

    // 保留 alt 文本；data URI 内嵌
    const replacement =
      ref.kind === 'md'
        ? `![${ref.alt}](${dataUri})`
        : ref.full.split(ref.src).join(dataUri)

    // 同一图片多处引用（相同 full）全部替换
    result = result.split(ref.full).join(replacement)
    converted++
    done++
    onProgress?.(done, total)
  }

  logger.debug(`本地图片处理完成: ${converted}/${total} 成功, ${failed.length} 失败`)
  return { content: result, total, converted, failed }
}

export interface ImportedArticle {
  title: string
  /** 图片引用已转换为 data URI 的 Markdown 原文 */
  markdown: string
  /** 由 markdown 渲染得到的 HTML */
  html: string
  /** 封面（data URI 或远程 URL） */
  cover?: string
}

export interface ImportStats {
  markdownFileName: string
  totalImages: number
  convertedImages: number
  failedImages: Array<{ ref: string; reason: string }>
}

export interface LoadOptions {
  onProgress?: (done: number, total: number) => void
}

/**
 * 高层入口：从所选文件集合中读取 Markdown 及其本地图片资源，
 * 返回可直接用于同步的文章对象。
 *
 * 多个 Markdown 文件时取第一个；没有 Markdown 文件时返回 null。
 */
export async function loadMarkdownFromFiles(
  files: File[],
  options?: LoadOptions
): Promise<{ article: ImportedArticle; stats: ImportStats } | null> {
  const mdFiles = findMarkdownFiles(files)
  if (mdFiles.length === 0) return null

  const mdFile = mdFiles[0]
  const stats: ImportStats = {
    markdownFileName: mdFile.name,
    totalImages: 0,
    convertedImages: 0,
    failedImages: [],
  }

  const raw = await mdFile.text()
  const parsed = parseMarkdown(raw, basenameWithoutExt(mdFile.name))

  // Markdown 文件所在目录（基于 webkitRelativePath）
  const relPath = (mdFile as RelativeFile).webkitRelativePath || mdFile.name
  const baseDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''

  const index = new FileIndex(files)

  // 正文图片 → data URI
  const imgResult = await resolveLocalImages(parsed.body, index, baseDir, options?.onProgress)
  stats.totalImages = imgResult.total
  stats.convertedImages = imgResult.converted
  stats.failedImages = imgResult.failed

  const markdown = imgResult.content

  // 封面：若是本地路径同样转 data URI
  let cover = parsed.cover
  if (cover && !isRemoteOrEmbedded(cover)) {
    const resolved = resolveRelativePath(baseDir, cover)
    const file = index.get(resolved) || index.getByBasename(cover)
    if (file && MIME_TYPES[extOf(file.name)]) {
      try {
        cover = await fileToDataUri(file)
      } catch (e) {
        logger.warn('封面转换失败:', (e as Error).message)
      }
    }
  }

  const html = markdownToHtml(markdown)

  return {
    article: { title: parsed.title, markdown, html, cover },
    stats,
  }
}

/**
 * 把内容中的 data URI 图片上传到图床，替换为图床返回的短 URL。
 *
 * 与 resolveLocalImages 配合：本地文件 → data URI（resolveLocalImages）
 * → 图床 URL（本函数）。避免 base64 嵌入正文导致字数/体积超限。
 *
 * markdown 与 html 共享同一份上传映射（同一张图片只上传一次）。
 */
export async function uploadEmbeddedImages(
  markdown: string,
  html: string,
  uploadOne: (dataUri: string) => Promise<string>,
  onProgress?: (done: number, total: number) => void
): Promise<{ markdown: string; html: string; uploaded: number; failed: number }> {
  const re = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g
  const uniq = new Set<string>()
  for (const text of [markdown, html]) {
    for (const m of text.matchAll(re)) uniq.add(m[0])
  }
  const all = Array.from(uniq)
  if (all.length === 0) return { markdown, html, uploaded: 0, failed: 0 }

  const urlOf = new Map<string, string>()
  let uploaded = 0
  let failed = 0
  let done = 0
  for (const du of all) {
    try {
      urlOf.set(du, await uploadOne(du))
      uploaded++
    } catch (e) {
      logger.warn('图片上传失败:', (e as Error).message)
      failed++
    }
    done++
    onProgress?.(done, all.length)
  }

  // 用上传后的短 URL 替换 data URI
  let newMd = markdown
  let newHtml = html
  for (const [du, url] of urlOf) {
    newMd = newMd.split(du).join(url)
    newHtml = newHtml.split(du).join(url)
  }

  logger.debug(`data URI 上传: ${uploaded}/${all.length} 成功, ${failed} 失败`)
  return { markdown: newMd, html: newHtml, uploaded, failed }
}
