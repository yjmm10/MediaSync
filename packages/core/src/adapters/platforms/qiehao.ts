/**
 * 企鹅号（腾讯内容开放平台）适配器
 *
 * 创作页：https://om.qq.com/main/creation/article
 * 内容管理：https://om.qq.com/main/management/articleManage（未发布 = 草稿）
 * 鉴权：GET /marticle/creation/initInfo（Cookie）；SW 失败时回退页面上下文
 * 图片：POST /image/orginalupload（multipart Filedata）
 * 草稿：POST /marticlepublish/omSave（JSON，不调用 omPublish）
 *
 * 端点与字段基于创作页实际网络请求与前端包实测。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Qiehao')

const ORIGIN = 'https://om.qq.com'
const CREATION_URL = `${ORIGIN}/main/creation/article`
/** 内容管理：草稿在「未发布」列表，不在创作页 editorCache */
const MANAGE_URL = `${ORIGIN}/main/management/articleManage`
const PAGE_PATTERN = '*://om.qq.com/*'
const INIT_INFO_URL = `${ORIGIN}/marticle/creation/initInfo?params=%7B%7D&relogin=1`

interface OmResponse<T = unknown> {
  response?: { code?: number | string; msg?: string }
  data?: T
}

interface OmCpInfo {
  mediaid?: string | number
  mediaId?: string | number
  media_id?: string | number
  medianame?: string
  mediaName?: string
  media_name?: string
  header?: string
  avatar?: string
}

interface OmInitData {
  cpInfo?: OmCpInfo
  mediaInfo?: OmCpInfo
  userInfo?: OmCpInfo
}

interface OmSaveData {
  articleId?: string
}

export class QiehaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'qiehao',
    name: '企鹅号',
    icon: 'https://om.qq.com/favicon.ico',
    homepage: MANAGE_URL,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private mediaId: string | null = null
  private mediaName: string | null = null
  private avatar: string | null = null

  private readonly HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: '*://om.qq.com/*',
      headers: {
        Origin: ORIGIN,
        Referer: CREATION_URL,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://image.om.qq.com/*',
      headers: {
        Origin: ORIGIN,
        Referer: CREATION_URL,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const ok = await this.refreshSession()
        if (ok && this.mediaId) {
          return {
            isAuthenticated: true,
            userId: this.mediaId,
            username: this.mediaName || `企鹅号 ${this.mediaId}`,
            avatar: this.avatar || undefined,
          }
        }

        // SW Cookie 可能因 SameSite / 无 Referer 失败；再探 Cookie 与页面上下文
        const hasCookie = await this.hasOmCookies()
        const pageOk = await this.refreshSessionViaPage()
        if (pageOk && this.mediaId) {
          return {
            isAuthenticated: true,
            userId: this.mediaId,
            username: this.mediaName || `企鹅号 ${this.mediaId}`,
            avatar: this.avatar || undefined,
          }
        }

        return {
          isAuthenticated: false,
          error: hasCookie
            ? '企鹅号 Cookie 存在但鉴权接口未返回媒体号，请打开 https://om.qq.com/main/creation/article 确认已登录并刷新后重试'
            : '未登录企鹅号，请先在浏览器打开并登录 https://om.qq.com/main/creation/article',
        }
      })
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting draft save...')
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (!this.mediaId) {
          const ok = (await this.refreshSession()) || (await this.refreshSessionViaPage())
          if (!ok || !this.mediaId) {
            throw new Error(
              '未登录企鹅号。请先在浏览器打开并登录 https://om.qq.com/main/creation/article'
            )
          }
        }

        // 创作页标题：5–64 字；超长截断，过短报错
        let title = (article.title || '').trim()
        if (title.length < 5) {
          throw new Error('企鹅号标题至少 5 个字')
        }
        if (title.length > 64) {
          title = title.slice(0, 64)
          logger.info('Title truncated to 64 chars')
        }

        let content = article.html || ''
        content = content.replace(/<img\b([^>]*?)\bsrc\s*=\s*'([^']*)'/gi, '<img$1src="$2"')
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['inews.gtimg.com', 'om.qq.com', 'image.om.qq.com', 'puui.qpic.cn'],
            onProgress: options?.onImageProgress,
          }
        )

        // 对齐创作页 editorCache / omSave 字段
        const payload: Record<string, unknown> = {
          title,
          title2: '',
          tag: '',
          video: '',
          cover_type: '1',
          imgurl_ext: '[]',
          category_id: '',
          content: `${content}<div powered-by="ex-editor"></div>`,
          orignal: 0,
          user_original: 0,
          music: '',
          activity: '',
          apply_olympic_flag: 0,
          apply_push_flag: 0,
          apply_reward_flag: 0,
          reward_flag: 0,
          survey_id: '',
          survey_name: '',
          imgurlsrc: null,
          om_activity_id: '',
          om_activity_name: '',
          activityInfo: '',
          commercialization_source: '',
          caimaiInfo: '',
          isHowto: '0',
          howtoInfo: '',
          daihuoInfo: '',
          novel: '',
          needpub: 1,
          event_id: '',
          event_name: '',
          activity_scene_id: 0,
          hotBreak: '',
          self_declare: '',
          resource_aigc_mark_info: '{}',
          parent_article_id: '',
          conclusion: '',
          summary: '',
          failedImage: 0,
          adContentImgs: [],
          mediaId: Number(this.mediaId) || this.mediaId,
          // 前端部分路径会写 media=mediaId，一并带上避免归属异常
          media: Number(this.mediaId) || this.mediaId,
          type: 0,
          articleId: '',
        }

        const res = await this.postJson<OmResponse<OmSaveData>>(
          `${ORIGIN}/marticlepublish/omSave?relogin=1`,
          payload,
          {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
          }
        )

        const code = res.response?.code
        if (code !== 0 && code !== '0') {
          throw new Error(res.response?.msg || `存草稿失败: ${JSON.stringify(res)}`)
        }

        const articleId = res.data?.articleId
        if (!articleId) {
          throw new Error('存草稿成功但未返回 articleId')
        }

        // 未发布稿的 page.om.qq.com 预览链常不可用；回创作编辑页才能打开草稿
        const postUrl = `${CREATION_URL}?articleId=${encodeURIComponent(articleId)}`
        return this.createResult(true, {
          postId: articleId,
          postUrl,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    } finally {
      await this.releaseEphemeralTabs()
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    let imageBlob: Blob
    if (src.startsWith('data:')) {
      imageBlob = await fetch(src).then((r) => r.blob())
    } else {
      const imageResponse = await this.runtime.fetch(src, { credentials: 'include' })
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败: ${src.slice(0, 80)}`)
      }
      imageBlob = await imageResponse.blob()
    }

    const ext = (imageBlob.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg'
    const fileName = `${Date.now()}.${ext}`
    const formData = new FormData()
    formData.append('Filedata', imageBlob, fileName)
    formData.append('appkey', '1')
    formData.append('isRetImgAttr', '1')
    formData.append('from', 'user')

    const uploadRes = await this.postMultipart<{
      response?: { code?: number | string; msg?: string }
      data?: { url?: { url?: string } }
    }>(`${ORIGIN}/image/orginalupload`, formData)

    const code = uploadRes.response?.code
    const url = uploadRes.data?.url?.url
    if ((code !== 0 && code !== '0') || !url) {
      throw new Error(uploadRes.response?.msg || `图片上传失败: ${src.slice(0, 80)}`)
    }
    return { url }
  }

  private async refreshSession(): Promise<boolean> {
    try {
      const res = await this.get<OmResponse<OmInitData>>(INIT_INFO_URL, {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      })
      return this.applyInitInfo(res)
    } catch (error) {
      logger.warn('SW initInfo failed:', error)
      return false
    }
  }

  /** 页面上下文重试：带上站点 Cookie / 同源 Referer */
  private async refreshSessionViaPage(): Promise<boolean> {
    if (!this.runtime.tabs) return false
    try {
      const res = await this.pageFetchJson<OmResponse<OmInitData>>(
        PAGE_PATTERN,
        CREATION_URL,
        INIT_INFO_URL,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
        }
      )
      return this.applyInitInfo(res)
    } catch (error) {
      logger.warn('page initInfo failed:', error)
      return false
    }
  }

  private applyInitInfo(res: OmResponse<OmInitData>): boolean {
    const code = res.response?.code
    const data = res.data
    const cp = data?.cpInfo || data?.mediaInfo || data?.userInfo

    const mediaIdRaw = cp?.mediaid ?? cp?.mediaId ?? cp?.media_id
    const mediaId =
      mediaIdRaw != null && String(mediaIdRaw).trim() !== '' ? String(mediaIdRaw) : ''

    if ((code !== 0 && code !== '0') || !mediaId) {
      this.mediaId = null
      this.mediaName = null
      this.avatar = null
      return false
    }

    this.mediaId = mediaId
    this.mediaName =
      (cp?.medianame || cp?.mediaName || cp?.media_name || '').trim() || null
    this.avatar = (cp?.header || cp?.avatar || '').trim() || null
    return true
  }

  private async hasOmCookies(): Promise<boolean> {
    if (!this.runtime.cookies) return false
    try {
      const cookies = await this.runtime.cookies.get('om.qq.com')
      return cookies.some((c) => !!(c.name && c.value))
    } catch {
      return false
    }
  }
}
