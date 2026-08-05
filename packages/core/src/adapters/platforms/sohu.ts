/**
 * 搜狐号适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：account/list 鉴权（多子账号取第一个）+ sp-cm cookie +
 * outerUpload 图床 + news/draft/v2 草稿全部保留。
 * checkAuth 重写（保留 account/list + 设 accountInfo/spCm 原逻辑）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Sohu')

interface SohuAccountInfo {
  id: string
  nickName: string
  avatar: string
}

/**
 * 生成设备 ID (dv-id)
 */
function generateDeviceId(): string {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export class SohuAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohu',
    name: '搜狐号',
    icon: 'https://mp.sohu.com/favicon.ico',
    homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 搜狐号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
      { kind: 'category', key: 'category', label: '分类', source: 'remote' },
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
      { kind: 'originalType', key: 'originalType', label: '原创声明',
        needsOriginalLink: true,
        options: [
          { value: 'original', label: '原创' },
          { value: 'reprint', label: '转载' },
        ] },
      { kind: 'topic', key: 'topicId', label: '话题', source: 'remote' },
    ],
  }

  private accountInfo: SohuAccountInfo | null = null
  private deviceId: string = generateDeviceId()
  private spCm: string = ''

  /** 搜狐号 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        'Origin': 'https://mp.sohu.com',
        'Referer': 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留 account/list + 设 accountInfo/spCm 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用 /account/list 获取所有子账号（搜狐号支持多个子账号）
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/account/list?_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          data?: Array<{
            accounts: SohuAccountInfo[]
          }>
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code !== 2000000 || !res.data?.data?.[0]?.accounts?.length) {
        return { isAuthenticated: false }
      }

      // 收集所有子账号
      const allAccounts: SohuAccountInfo[] = []
      for (const group of res.data.data) {
        if (group.accounts) {
          allAccounts.push(...group.accounts)
        }
      }

      if (allAccounts.length === 0) {
        return { isAuthenticated: false }
      }

      // 默认使用第一个子账号
      this.accountInfo = allAccounts[0]
      logger.info(`Using account: ${this.accountInfo.nickName} (id: ${this.accountInfo.id})` +
        (allAccounts.length > 1 ? `, ${allAccounts.length} sub-accounts available` : ''))

      // 获取 mp-cv cookie 用于 sp-cm header
      await this.fetchSpCm()

      // 如果有多个子账号，在用户名中标注
      const displayName = allAccounts.length > 1
        ? `${this.accountInfo.nickName} (共${allAccounts.length}个子账号)`
        : this.accountInfo.nickName

      return {
        isAuthenticated: true,
        userId: String(this.accountInfo.id),
        username: displayName,
        avatar: this.accountInfo.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 accountInfo 已获取 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.accountInfo) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录搜狐号')
      }
    }
  }

  /** 3. 上传图片：在 Header 规则保护下走 SharedImageCache 去重上传 */
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
        skipPatterns: ['sohu.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
  }

  /** 5. 构建 draft/v2 请求体（P2 写死保持等价） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      title: ctx.article.title,
      brief: '',
      content: ctx.content.html,
      channelId: 24,
      categoryId: -1,
      id: 0,
      userColumnId: 0,
      columnNewsIds: [],
      businessCode: 0,
      declareOriginal: false,
      cover: '',
      topicIds: [],
      isAd: 0,
      userLabels: '[]',
      reprint: false,
      customTags: '',
      infoResource: 0,
      sourceUrl: '',
      visibleToLoginedUsers: 0,
      attrIds: [],
      auto: true,
      accountId: Number(this.accountInfo!.id),
    }
  }

  /** 6. 提交：news/draft/v2 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    if (!this.accountInfo) {
      throw new Error('未登录')
    }
    const response = await this.runtime.fetch(
      `https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=${this.accountInfo.id}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'dv-id': this.deviceId,
          'sp-cm': this.spCm,
        },
        body: JSON.stringify(ctx.payload),
      }
    )

    const res = await response.json() as {
      success: boolean
      data?: string | number
      msg?: string
    }

    logger.debug(' Save response:', res)

    if (!res.success) {
      throw new Error(res.msg || '保存失败')
    }

    const postId = res.data
    return this.createResult(true, {
      postId: String(postId),
      postUrl: `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smpp.articlelist.0.0&contentStatus=2&id=${postId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ sp-cm / 图片上传（保持原样）============

  /**
   * 获取 sp-cm 值 (从 cookie 或生成)
   */
  private async fetchSpCm(): Promise<void> {
    try {
      // 尝试通过 runtime 获取 cookie（如果支持）
      if (this.runtime.getCookie) {
        const cookieValue = await this.runtime.getCookie('.sohu.com', 'mp-cv')
        if (cookieValue) {
          this.spCm = cookieValue
          logger.debug('Got sp-cm from cookie:', this.spCm)
          return
        }
      }
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Generated sp-cm:', this.spCm)
    } catch (error) {
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      logger.debug('Fallback sp-cm:', this.spCm)
    }
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) {
      throw new Error('未登录')
    }

    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到搜狐
    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')
    formData.append('accountId', this.accountInfo.id)

    const uploadResponse = await this.runtime.fetch(
      'https://mp.sohu.com/commons/front/outerUpload/image/file?accountId='+  this.accountInfo.id,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      url?: string
      msg?: string
    }

    logger.debug(' Image upload response:', res)
    if (!res.url) {
      throw new Error('图片上传失败:'+ (res.msg))
    }

    return {
      url: res.url,
    }
  }
}
