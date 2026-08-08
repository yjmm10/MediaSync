/**
 * 虎扑适配器（思路 A：默认发到步行街主干道）
 *
 * 发帖页：https://bbs.hupu.com/newpost?tabkey=1
 * 发帖：POST /pcmapi/pc/bbs/v1/createThread
 * 传图：本机 Blob → kaleido credentials → OSS PUT → uploadStatus
 */
import md5Lib from 'js-md5'
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Hupu')

// js-md5 导出的是函数本身
const jsMd5 = md5Lib as unknown as (message: string | ArrayBuffer | Uint8Array) => string

const DEFAULT_TOPIC_ID = 1
const CREATE_URL = 'https://bbs.hupu.com/pcmapi/pc/bbs/v1/createThread'
const AUTH_PROBE_URL = 'https://bbs.hupu.com/pcmapi/pc/bbs/v1/topic/cates'
const LOGIN_HINT = 'https://bbs.hupu.com/newpost?tabkey=1'

const HSS_BASE = 'https://hss.hupu.com'
const CREDENTIALS_URL = `${HSS_BASE}/kaleido/hss/app/file/credentials`
const UPLOAD_STATUS_URL = `${HSS_BASE}/kaleido/hss/uploadStatus`
const HSS_APP_ID = 'sHCGmnf6Q22giqt5BD8dvZY8lB4='
const HSS_SK = 'tsB7gwSsXPo9UTtSYFcPdtfckis='
const HSS_MODULE = 'editor-oss'
const HSS_PATH = '/editor'
const HSS_ACTION = '1'

interface HupuApiResponse {
  code?: number | string
  msg?: string
  message?: string
  data?: {
    tid?: number | string
  } | string
}

interface KaleidoCredentials {
  status?: string
  fileSrc?: string
  region?: string
  accessKey?: string
  secretKey?: string
  bucket?: string
  token?: string
  objectKey?: string
  expiration?: number
}

interface TipTapNode {
  type: string
  content?: TipTapNode[]
  text?: string
  attrs?: Record<string, string>
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTags(html: string): string {
  return decodeBasicEntities(html.replace(/<[^>]+>/g, '')).trim()
}

function normalizeTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim()
  if (title.length < 4) {
    throw new Error('虎扑标题至少需要 4 个字')
  }
  if (title.length > 40) {
    return title.slice(0, 40)
  }
  return title
}

function ensureContentHtml(html: string): string {
  const trimmed = html.trim()
  if (!trimmed) {
    throw new Error('文章内容为空')
  }
  if (/<(p|div|h[1-6]|ul|ol|li|img|blockquote|pre)\b/i.test(trimmed)) {
    return trimmed
  }
  return `<p>${trimmed}</p>`
}

function normalizeCdnUrl(url: string): string {
  if (url.startsWith('//')) {
    return `https:${url}`
  }
  return url
}

function guessExtension(blob: Blob, src: string): string {
  const type = (blob.type || '').toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('png')) return 'png'
  if (type.includes('gif')) return 'gif'
  if (type.includes('webp')) return 'webp'
  if (type.includes('svg')) return 'svg'
  const m = src.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/)
  if (m) {
    const ext = m[1].toLowerCase()
    return ext === 'jpeg' ? 'jpg' : ext
  }
  return 'png'
}

/** 将正文 img 规范为官网 slate-image 形态 */
function wrapHupuImages(html: string): string {
  return html.replace(/<img\b([^>]*?)\/?\s*>/gi, (full, attrs: string) => {
    if (/\bdata-origin=/i.test(attrs)) {
      return full
    }
    const srcMatch = attrs.match(/\bsrc=(["'])([^"']+)\1/i)
    if (!srcMatch) {
      return full
    }
    const src = srcMatch[2]
    return `<div class="slate-image" style="margin:0 auto"><img data-origin="${src}" src="${src}" /></div>`
  })
}

function collectImgList(html: string): Array<{ remoteUrl: string; key: string }> {
  const list: Array<{ remoteUrl: string; key: string }> = []
  const imgRe = /<img\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0]
    const origin = tag.match(/\bdata-origin=["']([^"']+)["']/i)
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)
    const url = (origin?.[1] || src?.[1] || '').trim()
    if (!url) continue
    list.push({
      remoteUrl: url,
      key: Math.random().toString().slice(-16),
    })
  }
  return list
}

/** Service Worker 无 DOM：用正则把 HTML 收成最小 TipTap doc */
function buildJsonV3(html: string): TipTapNode {
  const paragraphs: TipTapNode[] = []
  const blockRe = /<(?:p|div|h[1-6]|li|blockquote)[^>]*>([\s\S]*?)<\/(?:p|div|h[1-6]|li|blockquote)>/gi
  let match: RegExpExecArray | null
  let matched = false

  while ((match = blockRe.exec(html)) !== null) {
    matched = true
    const inner = match[1]
    const imgMatch = inner.match(/<img[^>]+src=["']([^"']+)["']/i)
    if (imgMatch) {
      paragraphs.push({
        type: 'image',
        attrs: { src: imgMatch[1] },
      })
    }
    const text = stripTags(inner)
    if (text) {
      paragraphs.push({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })
    }
  }

  if (!matched) {
    const text = stripTags(html)
    paragraphs.push({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ type: 'paragraph', content: [] })
  }

  return { type: 'doc', content: paragraphs }
}

export class HupuAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'hupu',
    name: '虎扑',
    icon: 'https://w1.hoopchina.com.cn/images/pc/new/favicon.ico',
    homepage: LOGIN_HINT,
    capabilities: ['article', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    processCodeBlocks: true,
  }

  private readonly HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: '*://bbs.hupu.com/*',
      headers: {
        Origin: 'https://bbs.hupu.com',
        Referer: LOGIN_HINT,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://hss.hupu.com/*',
      headers: {
        Origin: 'https://bbs.hupu.com',
        Referer: 'https://bbs.hupu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://*.aliyuncs.com/*',
      headers: {
        Origin: 'https://bbs.hupu.com',
        Referer: 'https://bbs.hupu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const ok = await this.checkAuthInner()
        if (!ok) {
          return {
            isAuthenticated: false,
            error: `未登录虎扑，请先在浏览器打开并登录 ${LOGIN_HINT}`,
          }
        }

        let userId: string | undefined
        try {
          const cookies = await this.runtime.cookies.get('hupu.com')
          const ua = cookies.find((c) => c.name === 'ua')
          if (ua?.value) {
            userId = ua.value
          }
        } catch {
          // ignore cookie read failures
        }

        return {
          isAuthenticated: true,
          userId,
        }
      })
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保登录（checkAuthInner） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const ok = await this.checkAuthInner()
      if (!ok) {
        throw new Error('请先登录虎扑')
      }
    })
  }

  /** 3. 上传图片 + slate-image 包裹 */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      const opts: ImageProcessOptions = {
        skipPatterns: ['hoopchina.com', 'hupu.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
      ctx.content.html = wrapHupuImages(ctx.content.html)
    })
  }

  /** 5. 构建 createThread 请求体（标题校验 + TipTap doc + imgList + shumeiId） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const title = normalizeTitle(ctx.article.title || '')
    const content = ensureContentHtml(ctx.content.html)
    const jsonV3 = buildJsonV3(content)
    const imgList = collectImgList(content)
    const shumeiId = await this.resolveShumeiId()

    ctx.payload = {
      title,
      content,
      format: JSON.stringify({
        htmlV3: content,
        jsonV3,
        imgList,
        videoInfo: { extra: 1 },
      }),
      topicId: DEFAULT_TOPIC_ID,
      tagIdList: '',
      shumeiId,
      zoneId: 0,
      visibleRange: 'ALL_SEE',
      creationType: 'ORIGINAL',
      containsAi: 0,
    }
  }

  /** 6. 提交：createThread（社区型直接发帖，draftOnly=false） */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const response = await this.runtime.fetch(CREATE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ctx.payload),
    })
    const res = (await response.json()) as HupuApiResponse
    logger.debug('createThread response:', res)

    if (Number(res.code) !== 1) {
      throw new Error(res.msg || res.message || '发帖失败')
    }

    const tid =
      typeof res.data === 'object' && res.data && 'tid' in res.data
        ? res.data.tid
        : undefined
    if (tid == null || tid === '') {
      throw new Error('发帖成功但未返回帖子 ID')
    }

    return this.createResult(true, {
      postId: String(tid),
      postUrl: `https://bbs.hupu.com/${tid}.html`,
      draftOnly: false,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  private async checkAuthInner(): Promise<boolean> {
    const response = await this.runtime.fetch(AUTH_PROBE_URL, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      return false
    }
    const res = (await response.json()) as HupuApiResponse
    return Number(res.code) === 1
  }

  // buildThreadPayload 已内联到 buildPayload 钩子（避免与基类抽象方法同名）

  private async resolveShumeiId(): Promise<string> {
    try {
      const cookies = await this.runtime.cookies.get('hupu.com')
      const smid = cookies.find((c) => c.name === 'smidV2')
      if (smid?.value) {
        return smid.value
      }
    } catch {
      // ignore
    }
    return ''
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const blob = await this.resolveImageBlob(src)
    const extension = guessExtension(blob, src)
    const { width, height } = await this.readImageSize(blob)
    const fileHash = await this.md5Blob(blob)

    const cred = await this.requestCredentials({
      fileHash,
      extension,
      width,
      height,
    })

    if (cred.status !== 'processing' && cred.fileSrc) {
      return { url: normalizeCdnUrl(cred.fileSrc) }
    }

    if (cred.status !== 'processing') {
      throw new Error('虎扑图片 credentials 响应异常')
    }

    await this.putToOss(blob, cred)
    const fileSrc = await this.confirmUploadStatus(fileHash)
    if (!fileSrc) {
      throw new Error('虎扑图片上传确认失败')
    }
    return { url: normalizeCdnUrl(fileSrc) }
  }

  private async resolveImageBlob(src: string): Promise<Blob> {
    if (src.startsWith('data:')) {
      return this.dataUriToBlob(src)
    }

    const response = await this.runtime.fetch(src, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`下载图片失败: HTTP ${response.status}`)
    }
    const blob = await response.blob()
    if (!blob || blob.size === 0) {
      throw new Error('下载图片失败: 空内容')
    }
    return blob
  }

  private async readImageSize(blob: Blob): Promise<{ width: number; height: number }> {
    try {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob)
        const size = { width: bitmap.width || 0, height: bitmap.height || 0 }
        bitmap.close()
        return size
      }
    } catch (error) {
      logger.debug('createImageBitmap failed:', error)
    }
    return { width: 0, height: 0 }
  }

  private async md5Blob(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    return jsMd5(new Uint8Array(buffer))
  }

  private async hmacSha1Base64(key: string, message: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(key)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
  }

  /** kaleido hss_sign：HMAC-SHA1 → Base64URL */
  private async buildHssSign(params: Record<string, string>): Promise<string> {
    const payload = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&')
    const base64 = await this.hmacSha1Base64(HSS_SK, payload)
    return base64.replace(/\+/g, '-').replace(/\//g, '_')
  }

  private async requestCredentials(opts: {
    fileHash: string
    extension: string
    width: number
    height: number
  }): Promise<KaleidoCredentials> {
    const timestamp = Date.now().toString()
    const signParams = {
      action: HSS_ACTION,
      appId: HSS_APP_ID,
      extension: opts.extension,
      fileHash: opts.fileHash,
      module: HSS_MODULE,
      path: HSS_PATH,
      timestamp,
    }
    const hss_sign = await this.buildHssSign(signParams)

    const query = new URLSearchParams({
      ...signParams,
      hss_sign,
      width: String(opts.width),
      height: String(opts.height),
    })

    const response = await this.runtime.fetch(`${CREDENTIALS_URL}?${query.toString()}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`虎扑 credentials 失败: HTTP ${response.status}`)
    }

    const body = (await response.json()) as {
      code?: number | string
      msg?: string
      message?: string
      data?: KaleidoCredentials
    }
    const data = body.data
    if (!data) {
      throw new Error(body.message || body.msg || '虎扑 credentials 无数据')
    }
    return data
  }

  private async putToOss(blob: Blob, cred: KaleidoCredentials): Promise<void> {
    const {
      region,
      accessKey,
      secretKey,
      bucket,
      token,
      objectKey,
    } = cred

    if (!region || !accessKey || !secretKey || !bucket || !token || !objectKey) {
      throw new Error('虎扑 OSS 凭证不完整')
    }

    const regionHost = region.includes('aliyuncs.com')
      ? region.replace(/^https?:\/\//, '')
      : `${region.startsWith('oss-') ? region : `oss-${region}`}.aliyuncs.com`
    const url = `https://${bucket}.${regionHost}/${objectKey}`
    const contentType = blob.type || 'application/octet-stream'
    const ossDate = new Date().toUTCString()
    const ossUserAgent = 'aliyun-sdk-js/6.8.0'

    const ossHeaders: Record<string, string> = {
      'x-oss-date': ossDate,
      'x-oss-security-token': token,
      'x-oss-user-agent': ossUserAgent,
    }
    const canonicalizedOSSHeaders = Object.keys(ossHeaders)
      .sort()
      .map((key) => `${key}:${ossHeaders[key]}`)
      .join('\n')
    const canonicalizedResource = `/${bucket}/${objectKey}`
    const stringToSign =
      'PUT\n' +
      '\n' +
      contentType +
      '\n' +
      ossDate +
      '\n' +
      canonicalizedOSSHeaders +
      '\n' +
      canonicalizedResource

    const signature = await this.hmacSha1Base64(secretKey, stringToSign)
    const authorization = `OSS ${accessKey}:${signature}`

    const response = await this.runtime.fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        Authorization: authorization,
        'x-oss-date': ossDate,
        'x-oss-security-token': token,
        'x-oss-user-agent': ossUserAgent,
      },
      body: blob,
    })

    if (!response.ok) {
      const text = await response.text()
      logger.error('OSS upload failed:', response.status, text.slice(0, 300))
      throw new Error(`虎扑 OSS 上传失败: HTTP ${response.status}`)
    }
  }

  private async confirmUploadStatus(fileHash: string): Promise<string> {
    const response = await this.runtime.fetch(UPLOAD_STATUS_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify({ fileHash }),
    })
    if (!response.ok) {
      throw new Error(`虎扑 uploadStatus 失败: HTTP ${response.status}`)
    }

    const body = (await response.json()) as {
      code?: number | string
      msg?: string
      message?: string
      data?: { fileSrc?: string; data?: { fileSrc?: string } } | string
    }

    let fileSrc = ''
    if (typeof body.data === 'string') {
      fileSrc = body.data
    } else if (body.data && typeof body.data === 'object') {
      fileSrc = body.data.fileSrc || body.data.data?.fileSrc || ''
    }

    if (!fileSrc) {
      throw new Error(body.message || body.msg || '虎扑 uploadStatus 未返回 fileSrc')
    }
    return fileSrc
  }
}
