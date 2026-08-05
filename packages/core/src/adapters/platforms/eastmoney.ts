/**
 * 东方财富适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：ctoken/utoken cookie 鉴权 + deviceId 持久化 +
 * createDraft + 图片上传（byLink/blob）+ updateDraft 两步草稿全部保留。
 * checkAuth 重写（保留 fetchToken + getauthorinfo 原逻辑）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Eastmoney')

interface UploadResponse {
  code: number
  message: string
  data?: {
    url: string
    id: string
  }
}

interface DraftApiResponse {
  RRquestSuccess: boolean
  RCode: number
  RMsg?: string
  RData: string
}

interface DraftResult {
  error_code?: number
  draft_id?: string
  me?: string
}

export class EastmoneyAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'eastmoney',
    name: '东方财富',
    icon: 'https://mp.eastmoney.com/collect/pc_article/favicon.ico',
    homepage: 'https://mp.eastmoney.com',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeComments: true,
    removeSpecialTags: true,
    processCodeBlocks: true,
    convertSectionToDiv: true,
    removeEmptyLines: true,
    removeEmptyDivs: true,
    removeNestedEmptyContainers: true,
    unwrapSingleChildContainers: true,
    unwrapNestedFigures: true,
    removeTrailingBr: true,
    removeDataAttributes: true,
    removeSrcset: true,
    removeSizes: true,
    compactHtml: true,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
      {
        kind: 'originalType',
        key: 'originalType',
        label: '原创类型',
        options: [
          { value: 'original', label: '原创' },
          { value: 'reprint', label: '转载' },
        ],
      },
      { kind: 'category', key: 'category', label: '栏目', source: 'remote' },
    ],
  }

  private ctoken: string = ''
  private utoken: string = ''
  private deviceId: string = ''

  /** 获取或生成持久化 deviceId（32位大写 hex） */
  private async getDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId
    const stored = await this.runtime.storage.get<string>('eastmoney_deviceId')
    if (stored) {
      this.deviceId = stored
      return this.deviceId
    }
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    this.deviceId = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join('')
    await this.runtime.storage.set('eastmoney_deviceId', this.deviceId)
    return this.deviceId
  }

  /** API Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.eastmoney.com/*',
      headers: {
        Origin: 'https://mp.eastmoney.com',
        HOST: 'emfront.eastmoney.com',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留 fetchToken + getauthorinfo 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      await this.fetchToken()

      const response = await this.runtime.fetch(
        `https://caifuhaoapi.eastmoney.com/api/v2/getauthorinfo?platform=&ctoken=${this.ctoken}&utoken=${this.utoken}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'x-requested-with': 'fetch' },
        },
      )

      const data = (await response.json()) as {
        Success: number
        Result?: {
          accountId?: string
          accountName?: string
          portrait?: string
        }
      }

      if (data.Success === 1 && data.Result?.accountId) {
        return {
          isAuthenticated: true,
          userId: data.Result.accountId,
          username: data.Result.accountName,
          avatar: data.Result.portrait,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 token 已获取（沿用 checkAuth） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.ctoken || !this.utoken) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录东方财富')
      }
    }
  }

  /** 3. 上传图片：在 Header 规则保护下走 SharedImageCache 去重上传 */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      await this.fetchToken()
      const upload = async (src: string): Promise<ImageUploadResult> => {
        const hit = await ctx.imageCache.getUploadedUrl(this.meta.id, src)
        if (hit) return { url: hit }
        const result = await this.uploadImageByUrl(src)
        ctx.imageCache.setUploadedUrl(this.meta.id, src, result.url)
        return result
      }
      const opts: ImageProcessOptions = {
        skipPatterns: ['gbres.dfcfw.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
  }

  /** 5. 构建 updateDraft 所需 title + content */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      title: ctx.article.title,
      content: ctx.content.html,
    }
  }

  /** 6. 提交：createDraft → updateDraft */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const payload = ctx.payload as { title: string; content: string }
    const draftId = await this.createDraft(payload.title)
    logger.debug('Draft created:', draftId)
    await this.updateDraft(draftId, payload.title, payload.content)
    logger.debug('Draft updated')

    return this.createResult(true, {
      postId: draftId,
      postUrl: `https://mp.eastmoney.com/collect/pc_article/index.html#/?id=${draftId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ token / 草稿 API / 图片上传（保持原样）============

  /** 从 cookie 读取 token */
  private async fetchToken(): Promise<void> {
    if (this.ctoken && this.utoken) return
    if (!this.runtime.getCookie) {
      throw new Error('Cookie API 不可用，请先登录东方财富')
    }

    const ctoken = await this.runtime.getCookie('.eastmoney.com', 'ct')
    const utoken = await this.runtime.getCookie('.eastmoney.com', 'ut')

    if (!ctoken || !utoken) {
      throw new Error('未检测到登录信息，请先登录东方财富')
    }

    this.ctoken = ctoken
    this.utoken = utoken
  }

  /** 构造 API 参数 */
  private async buildParm(params: {
    draftid?: string
    title: string
    text: string
  }): Promise<object[]> {
    const deviceid = await this.getDeviceId()
    return [
      { ip: '$IP$' },
      { deviceid },
      { version: '100' },
      { plat: 'web' },
      { product: 'CFH' },
      { ctoken: this.ctoken },
      { utoken: this.utoken },
      { draftid: params.draftid ?? '' },
      { drafttype: '0' },
      { type: '0' },
      { title: encodeURIComponent(params.title) },
      { text: encodeURIComponent(params.text) },
      { columns: '2' },
      { cover: '' },
      { issimplevideo: '0' },
      { videos: '' },
      { vods: '' },
      { isoriginal: '0' },
      { tgProduct: '' },
      { spcolumns: '' },
      { textsource: '0' },
      { replyauthority: '' },
      { modules: encodeURIComponent('[]') },
    ]
  }

  /** 调用草稿 API */
  private async callDraftApi(parm: object[], draftId?: string): Promise<DraftResult> {
    const pageUrl = draftId
      ? `https://mp.eastmoney.com/collect/pc_article/index.html#/?id=${draftId}`
      : 'https://mp.eastmoney.com/collect/pc_article/index.html#/'

    const body = JSON.stringify({
      pageUrl,
      path: 'draft/api/Article/SaveDraft',
      parm: JSON.stringify(parm),
    })

    const response = await this.runtime.fetch(
      'https://emfront.eastmoney.com/apifront/Tran/GetData?platform=',
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    )

    const responseText = await response.text()
    logger.debug(
      'Draft API response:',
      response.status,
      responseText.substring(0, 200),
    )

    if (!response.ok) {
      throw new Error(`草稿 API 请求失败: ${response.status}`)
    }

    let rawData: DraftApiResponse
    try {
      rawData = JSON.parse(responseText)
    } catch {
      throw new Error('草稿 API 响应不是有效 JSON')
    }

    if (!rawData.RRquestSuccess || rawData.RCode !== 200) {
      throw new Error(`草稿 API 错误: ${rawData.RMsg || '未知错误'}`)
    }

    let innerData: DraftResult
    try {
      innerData = JSON.parse(rawData.RData)
    } catch {
      throw new Error('无法解析草稿响应数据')
    }

    if (innerData.error_code !== 0) {
      throw new Error(`草稿业务错误: ${innerData.me || '未知错误'}`)
    }

    return innerData
  }

  private async createDraft(title: string): Promise<string> {
    const parm = await this.buildParm({
      title,
      text: '<div class="xeditor_content cfh_web"></div>',
    })
    const result = await this.callDraftApi(parm)
    if (!result.draft_id) {
      throw new Error('创建草稿失败: 响应缺少 draft_id')
    }
    return result.draft_id
  }

  private async updateDraft(
    draftId: string,
    title: string,
    content: string,
  ): Promise<void> {
    const parm = await this.buildParm({
      draftid: draftId,
      title,
      text: `<div class="xeditor_content cfh_web">${content}</div>`,
    })
    await this.callDraftApi(parm, draftId)
  }

  /** URL 上传图片 */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // data URI 使用二进制上传
    if (src.startsWith('data:')) {
      logger.debug('Detected data URI, using binary upload')
      const blob = await this.dataUriToBlob(src)
      return this.uploadImageBlob(blob)
    }

    // 远程 URL 使用链接上传接口
    const response = await this.runtime.fetch(
      'https://gbapi.eastmoney.com/iimage/image/byLink?platform=',
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          noinlist: '1',
          linkUrl: src,
          ctoken: this.ctoken,
          utoken: this.utoken,
        }),
      },
    )

    const res = (await response.json()) as UploadResponse
    if (res.code === 200 && res.data?.url) {
      return { url: res.data.url }
    }
    throw new Error(
      `图片上传失败: ${res.message || '未知错误'} (code: ${res.code})`,
    )
  }

  /** 上传图片 Blob */
  private async uploadImageBlob(file: Blob): Promise<ImageUploadResult> {
    const ext = file.type.split('/')[1] || 'png'
    const filename = `${Date.now()}.${ext}`

    const formData = new FormData()
    formData.append('file', file, filename)
    formData.append('noinlist', '1')
    formData.append('utoken', this.utoken)
    formData.append('ctoken', this.ctoken)

    const response = await this.runtime.fetch(
      'https://gbapi.eastmoney.com/iimage/image?platform=',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      },
    )

    const res = (await response.json()) as UploadResponse
    if (res.code === 200 && res.data?.url) {
      return { url: res.data.url }
    }
    throw new Error(
      `图片上传失败: ${res.message || '未知错误'} (code: ${res.code})`,
    )
  }
}
