/**
 * 同步中间层：以预览源文（含 base64）为唯一输入，按平台克隆后各自处理。
 *
 * 不变量：
 * - 顶层 article.markdown/html 保持导入预览用的原文（含 data URI），不被改写
 * - 每个平台只写自己的 platformContents[id]，互不影响
 * - 仅当平台 uploadImage 返回 http(s) 时才在该平台副本内替换 base64
 * - Reddit 等返回非 URL 的平台跳过中间层替换，由适配器在 publish 内独自处理副本
 */
import { getAdapter } from '../adapters'
import { uploadEmbeddedImages } from '../lib/local-markdown'
import { createLogger } from '../lib/logger'

const logger = createLogger('PreparePlatformContents')

/**
 * 中间层不调用 uploadImage（本地 data URI）：
 * - qianfan：本地图与外链中转均不支持（中间层不传图）
 * - tencentcloud / volcengine：本地图暂不支持；外链在适配器 publish 内经 processImages 转存
 */
const SKIP_MIDDLEWARE_IMAGE_UPLOAD = new Set(['qianfan', 'tencentcloud', 'volcengine'])
/** 腾讯云/火山：剥离本地 data URI，保留 http(s) 外链给适配器 */
const STRIP_LOCAL_DATA_URI = new Set(['tencentcloud', 'volcengine'])

const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,/

function stripLocalDataUriImages(markdown: string, html: string): { markdown: string; html: string } {
  const stripMd = (s: string) =>
    (s || '')
      .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
      .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')
  return { markdown: stripMd(markdown), html: stripMd(html) }
}

export type PlatformContent = { html: string; markdown: string }

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('//')
}

function normalizeHttpUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

function dataUriToBlob(dataUri: string): Blob {
  const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) throw new Error('Invalid data URI')
  const mimeType = matches[1]
  const binaryStr = atob(matches[2])
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

/**
 * @param article 含预览源文（base64）及可选 DOM 预处理 platformContents
 * @param platformIds 本次同步的 DSL 平台
 */
export async function preparePlatformContents(
  article: {
    html?: string
    markdown?: string
    content?: string
    platformContents?: Record<string, PlatformContent>
  },
  platformIds: string[]
): Promise<Record<string, PlatformContent>> {
  // 预览源文：导入时已 resolveLocalImages → base64
  const baseHtml = article.html || article.content || ''
  const baseMarkdown = article.markdown || ''
  const existing = article.platformContents || {}
  const result: Record<string, PlatformContent> = {}

  for (const platformId of platformIds) {
    // 每平台从源文（或该平台 DOM 预处理结果）克隆，再独自处理
    const seed = existing[platformId] || {
      html: baseHtml,
      markdown: baseMarkdown,
    }
    let html = seed.html || baseHtml
    let markdown = seed.markdown || baseMarkdown

    if (STRIP_LOCAL_DATA_URI.has(platformId)) {
      const stripped = stripLocalDataUriImages(markdown, html)
      markdown = stripped.markdown
      html = stripped.html
      logger.debug(`${platformId}: 已剥离本地 data URI（外链图由适配器转存）`)
    }

    if (
      !SKIP_MIDDLEWARE_IMAGE_UPLOAD.has(platformId) &&
      (DATA_URI_RE.test(markdown) || DATA_URI_RE.test(html))
    ) {
      try {
        const adapter = await getAdapter(platformId)
        if (!adapter?.uploadImage) {
          result[platformId] = { html, markdown }
          continue
        }
        const uploadFn = (file: Blob) => adapter.uploadImage!(file)
        const uploaded = await uploadEmbeddedImages(
          markdown,
          html,
          async (dataUri) => {
            const url = await uploadFn(dataUriToBlob(dataUri))
            if (!url || !isHttpUrl(url)) {
              // 非 http（如 Reddit mediaId）→ 不改该平台副本，留给适配器
              throw new Error(`平台 ${platformId} 未返回可用 http(s) URL`)
            }
            return normalizeHttpUrl(url)
          }
        )
        markdown = uploaded.markdown
        html = uploaded.html
        logger.debug(
          `${platformId}: 副本内嵌图 ${uploaded.uploaded} 成功, ${uploaded.failed} 失败`
        )
      } catch (e) {
        logger.warn(`${platformId}: 中间层传图跳过，副本保留 base64:`, e)
      }
    } else if (platformId === 'qianfan') {
      logger.debug(`${platformId}: 暂时跳过全部图片处理`)
    }

    result[platformId] = { html, markdown }
  }

  return result
}
