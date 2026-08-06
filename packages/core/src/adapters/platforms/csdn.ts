/**
 * CSDN 适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：原有签名鉴权、图片上传（OBS 直传）、saveArticle 草稿流程全部保留。
 * 新增 publishSchema 声明（为 UI 准备），P1 运行时 buildPayload 仍用写死值，
 * 等 P2 注册代码 + UI 接入后再让 buildPayload 读 ctx.params。
 *
 * Header 规则拆分（与原实现等价）：
 *   原来用一次 withHeaderRules 包整个 publish；迁移后管道分层，拆为两次顺序包：
 *   - uploadImages 钩子内包一次（imgservice + OBS 需要 Origin/Referer）
 *   - submit 外层由管道自动包一次（getHeaderRules 返回 HEADER_RULES）
 *   两次 add/clear 顺序执行，不嵌套，避免 clearHeaderRules 互相清空。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('CSDN')

interface CSDNUserInfo {
  csdnid: string
  username: string
  avatarurl: string
}

export class CSDNAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'csdn',
    name: 'CSDN',
    icon: 'https://g.csdnimg.cn/static/logo/favicon32.ico',
    homepage: 'https://editor.csdn.net/md/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: CSDN 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /**
   * 配置 Schema（声明式，UI 据此渲染）
   * 注意：P1 运行时 buildPayload 仍用写死值保持行为等价；
   *      等注册代码（P2）与 UI 接入后，buildPayload 再读 ctx.params。
   */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签', max: 7 },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      {
        kind: 'originalType',
        key: 'originalType',
        label: '原创类型',
        needsOriginalLink: true,
        options: [
          { value: 'original', label: '原创' },
          { value: 'reprint', label: '转载' },
          { value: 'translate', label: '翻译' },
        ],
      },
      { kind: 'activity', key: 'activityId', label: '活动', source: 'remote' },
      {
        kind: 'visibility',
        key: 'visibility',
        label: '可见性',
        options: [
          { value: 'public', label: '公开' },
          { value: 'private', label: '仅自己可见' },
        ],
      },
    ],
  }

  private userInfo: CSDNUserInfo | null = null

  // CSDN API 签名密钥
  private readonly API_KEY = '203803574'
  private readonly API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

  /** CSDN API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://bizapi.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imgservice.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    // 签名接口可能返回其它 OBS host，追加通配避免 Origin/Referer 缺失
    {
      urlFilter: '*://*.myhuaweicloud.com/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（保持原有签名 API 逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用带签名的 API
      const apiPath = '/blog-console-api/v3/editor/getBaseInfo'
      const headers = await this.signRequest(apiPath, 'GET')

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'GET',
          credentials: 'include',
          headers,
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          name: string
          nickname: string
          avatar: string
          blog_url: string
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code === 200 && res.data?.name) {
        this.userInfo = {
          csdnid: res.data.name,
          username: res.data.nickname || res.data.name,
          avatarurl: res.data.avatar,
        }
        return {
          isAuthenticated: true,
          userId: res.data.name,
          username: res.data.nickname || res.data.name,
          avatar: res.data.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 userInfo 已获取（沿用原有 checkAuth 签名 API） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.userInfo) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录 CSDN')
      }
    }
  }

  /**
   * 3. 上传图片：在 Header 规则保护下走 SharedImageCache 去重 + processImages
   *    保留原 skipPatterns 与 stripDataUriImages 清理（行为等价）
   */
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
        skipPatterns: ['csdnimg.cn', 'csdn.net'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
    // 上传失败残留的 data URI 不得写入草稿（体积过大）
    ctx.content.markdown = stripDataUriImages(ctx.content.markdown)
    ctx.content.html = stripDataUriImages(ctx.content.html)
  }

  /** 5. 构建平台请求体（P1 写死保持等价；P2 注册代码 + UI 接入后读 ctx.params） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const { params } = ctx
    const isPublish = params.mode === 'publish'
    const coverUrl =
      params.cover && params.cover !== 'auto' && params.cover !== 'none'
        ? params.cover
        : ''
    ctx.payload = {
      id: 0, // 0=新建
      title: ctx.article.title,
      markdowncontent: ctx.content.markdown,
      content: ctx.content.html,
      readType: 'public',
      level: String(this.visibilityToLevel(params.visibility)), // 真实接口要字符串
      tags: (params.tags ?? []).slice(0, 7).join(','),
      status: isPublish ? 0 : 2, // 0=发布 2=草稿（对齐真实接口）
      categories: params.category ?? '',
      type: params.originalType ?? 'original',
      original_link: params.originalLink ?? '',
      authorized_status: false,
      Description: params.summary ?? '', // AI 摘要（大写 D）
      resource_url: '',
      not_auto_saved: '1',
      source: 'pc_mdeditor',
      cover_images: coverUrl ? [coverUrl] : [],
      cover_type: 1,
      is_new: 1,
      vote_id: 0,
      resource_id: '',
      pubStatus: isPublish ? 'publish' : 'draft',
      creation_statement: (params.extra?.creationStatement as number) ?? 0, // 0=无 1=原创声明 2=独家授权 3=原创+独家
      sync_git_code: (params.extra?.syncGitCode as number) ?? 0,
      creator_activity_id: params.activityId ?? '',
    }
  }

  /** 可见性 → CSDN level（0=公开，1=粉丝可见，2=仅自己） */
  private visibilityToLevel(visibility?: string): number {
    if (visibility === 'private') return 2
    if (visibility === 'followers') return 1
    return 0
  }

  /** 6. 提交：签名 + saveArticle，返回草稿结果 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const apiPath = '/blog-console-api/v3/mdeditor/saveArticle'
    const headers = await this.signRequest(apiPath)

    const response = await this.runtime.fetch(
      `https://bizapi.csdn.net${apiPath}`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(ctx.payload),
      }
    )

    const res = await response.json() as {
      code: number
      message?: string
      msg?: string
      data?: { id: string }
    }

    logger.debug('Save response:', res)

    if (res.code !== 200 || !res.data?.id) {
      throw new Error(res.msg || res.message || '保存草稿失败')
    }

    const postId = res.data.id
    return this.createResult(true, {
      postId,
      postUrl: `https://editor.csdn.net/md?articleId=${postId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 签名 / 图片上传（保持原样）============

  /**
   * 生成 UUID
   */
  private createUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /**
   * HMAC-SHA256 签名 (使用 Web Crypto API)
   */
  private async hmacSha256(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)

    // 转换为 Base64
    const bytes = new Uint8Array(signature)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * 生成 CSDN API 签名
   * 签名格式: METHOD\nAccept\nContent-MD5\nContent-Type\n\nHeaders\nPath
   */
  private async signRequest(apiPath: string, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, string>> {
    const nonce = this.createUuid()

    // GET: 没有 Content-Type，所以那一行为空
    // POST: Content-Type 为 application/json
    const signStr = method === 'GET'
      ? `GET\n*/*\n\n\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`
      : `POST\n*/*\n\napplication/json\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`

    logger.debug('Sign string:', JSON.stringify(signStr))

    const signature = await this.hmacSha256(signStr, this.API_SECRET)

    const headers: Record<string, string> = {
      'accept': '*/*',
      'x-ca-key': this.API_KEY,
      'x-ca-nonce': nonce,
      'x-ca-signature': signature,
      'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
    }

    if (method === 'POST') {
      headers['content-type'] = 'application/json'
    }

    return headers
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   * 需要设置动态请求头规则以支持 MCP / 中间层调用
   * 直接上传 Blob，禁止再转大 data URI 后 fetch
   */
  async uploadImage(file: Blob, filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const ext = guessImageExt(file, filename || '')
      return this.uploadBlobToCsdn(file, ext)
    })
  }

  /**
   * 通过 URL / data URI 上传图片
   * Header rules 由 uploadImages / uploadImage 外层负责（避免嵌套 withHeaderRules 清规则）
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const blob = await resolveImageBlob(src, (url, init) => this.runtime.fetch(url, init))
    const ext = guessImageExt(blob, src)
    const url = await this.uploadBlobToCsdn(blob, ext)
    return { url }
  }

  /**
   * 签名 + OBS 直传；成功必须返回 http(s)，失败抛错（禁止回退 data URI）
   */
  private async uploadBlobToCsdn(blob: Blob, ext: string): Promise<string> {
    if (!blob || blob.size === 0) {
      throw new Error('图片内容为空')
    }

    const apiPath = '/resource-api/v1/image/direct/upload/signature'
    const headers = await this.signRequest(apiPath, 'POST')

    const signatureRes = await this.runtime.fetch(
      `https://bizapi.csdn.net${apiPath}`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          imageTemplate: '',
          appName: 'direct_blog_markdown',
          imageSuffix: ext,
        }),
      }
    )

    const signatureData = await signatureRes.json() as {
      code: number
      message?: string
      msg?: string
      data?: {
        filePath: string
        host: string
        accessId: string
        policy: string
        signature: string
        callbackUrl: string
        callbackBody: string
        callbackBodyType: string
        customParam: {
          rtype: string
          filePath: string
          isAudit: number
          'x-image-app': string
          type: string
          'x-image-suffix': string
          username: string
        }
      }
    }

    logger.debug('Upload signature response:', signatureData)

    if (signatureData.code !== 200 || !signatureData.data) {
      const detail = signatureData.msg || signatureData.message || `code=${signatureData.code}`
      logger.warn('Failed to get upload signature:', detail)
      throw new Error(`CSDN 获取上传签名失败: ${detail}`)
    }

    const uploadData = signatureData.data
    const customParam = uploadData.customParam
    logger.debug('OBS upload host:', uploadData.host)

    const formData = new FormData()
    formData.append('key', uploadData.filePath)
    formData.append('policy', uploadData.policy)
    formData.append('signature', uploadData.signature)
    formData.append('callbackBody', uploadData.callbackBody)
    formData.append('callbackBodyType', uploadData.callbackBodyType)
    formData.append('callbackUrl', uploadData.callbackUrl)
    formData.append('AccessKeyId', uploadData.accessId)
    formData.append('x:rtype', customParam.rtype)
    formData.append('x:filePath', customParam.filePath)
    formData.append('x:isAudit', String(customParam.isAudit))
    formData.append('x:x-image-app', customParam['x-image-app'])
    formData.append('x:type', customParam.type)
    formData.append('x:x-image-suffix', customParam['x-image-suffix'])
    formData.append('x:username', customParam.username)
    formData.append('file', blob, `image.${ext}`)

    const obsResponse = await this.runtime.fetch(uploadData.host, {
      method: 'POST',
      body: formData,
    })

    const obsText = await obsResponse.text()
    let obsRes: { code: number; message?: string; msg?: string; data?: { imageUrl: string } }
    try {
      obsRes = JSON.parse(obsText) as typeof obsRes
    } catch {
      logger.warn('OBS upload non-JSON:', obsText.slice(0, 120))
      throw new Error(`CSDN OBS 响应非 JSON HTTP ${obsResponse.status}`)
    }

    logger.debug('OBS upload response:', obsRes)

    if (obsRes.code !== 200 || !obsRes.data?.imageUrl) {
      const detail = obsRes.msg || obsRes.message || `code=${obsRes.code}`
      logger.warn('OBS upload failed:', detail)
      throw new Error(`CSDN OBS 上传失败: ${detail}`)
    }

    if (!/^https?:\/\//i.test(obsRes.data.imageUrl)) {
      throw new Error('CSDN 图床未返回 http(s) URL')
    }

    return obsRes.data.imageUrl
  }
}

/** 从 MIME / path / data URI 推断扩展名，默认 png */
function guessImageExt(blob: Blob, src: string): string {
  const type = (blob.type || '').toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('png')) return 'png'
  if (type.includes('gif')) return 'gif'
  if (type.includes('webp')) return 'webp'

  const dataMime = src.match(/^data:image\/([a-zA-Z0-9.+-]+)/i)
  if (dataMime) {
    const sub = dataMime[1].toLowerCase()
    if (sub === 'jpeg' || sub === 'jpg') return 'jpg'
    if (sub === 'png' || sub === 'gif' || sub === 'webp') return sub
  }

  const pathExt = src.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/)
  if (pathExt) {
    const ext = pathExt[1].toLowerCase()
    if (ext === 'jpeg') return 'jpg'
    if (['jpg', 'png', 'gif', 'webp'].includes(ext)) return ext
  }

  return 'png'
}

/** data: 用 atob 解析；http(s) 用 runtime.fetch。禁止对大 data URI 再 fetch */
async function resolveImageBlob(
  src: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>
): Promise<Blob> {
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/i)
    if (!m) throw new Error('无效 data URI')
    const mime = m[1] || 'image/png'
    const isBase64 = !!m[2]
    const data = m[3] || ''
    if (isBase64) {
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(data)], { type: mime })
  }

  if (!/^https?:\/\//i.test(src)) {
    throw new Error(`不支持的图片地址: ${src.slice(0, 80)}`)
  }

  const response = await fetchFn(src, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`下载图片失败 HTTP ${response.status}`)
  }
  return response.blob()
}

/** 去掉残留 data: 图，避免 base64 撑爆草稿 */
function stripDataUriImages(content: string): string {
  return (content || '')
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/gi, '')
    .replace(/<img\b[^>]*\bsrc=["']data:[^"']+["'][^>]*>/gi, '')
}
