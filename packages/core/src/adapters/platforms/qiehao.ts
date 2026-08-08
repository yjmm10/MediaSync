/**
 * 企鹅号（腾讯内容开放平台）适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：initInfo 鉴权（SW + 页面回退）+ orginalupload 图床 +
 * 列表转 ex-editor 嵌套格式 + omSave 草稿全部保留。
 * checkAuth 重写（保留 refreshSession + refreshSessionViaPage + releaseEphemeralTabs 原逻辑）。
 *
 * 创作页：https://om.qq.com/main/creation/article
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
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

export class QiehaoAdapter extends PipelineAdapter {
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

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
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

  // ============ checkAuth（重写，保留 SW + 页面回退原逻辑）============

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

  // ============ 管道钩子 ============

  /** 1. 鉴权：refreshSession（SW）失败再 refreshSessionViaPage（页面回退） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      if (!this.mediaId) {
        const ok = (await this.refreshSession()) || (await this.refreshSessionViaPage())
        if (!ok || !this.mediaId) {
          throw new Error(
            '未登录企鹅号。请先在浏览器打开并登录 https://om.qq.com/main/creation/article'
          )
        }
      }
    })
  }

  /** 2. 内容规整：img src 统一双引号（processImages 只匹配双引号） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    ctx.content.html = ctx.content.html.replace(
      /<img\b([^>]*?)\bsrc\s*=\s*'([^']*)'/gi,
      '<img$1src="$2"',
    )
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
        skipPatterns: ['inews.gtimg.com', 'om.qq.com', 'image.om.qq.com', 'puui.qpic.cn'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
  }

  /** 5. 构建 omSave 请求体（标题校验 + 列表转 ex-editor 嵌套格式） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    // 创作页标题：5–64 字；超长截断，过短报错
    let title = (ctx.article.title || '').trim()
    if (title.length < 5) {
      throw new Error('企鹅号标题至少 5 个字')
    }
    if (title.length > 64) {
      title = title.slice(0, 64)
      logger.info('Title truncated to 64 chars')
    }

    // 嵌套列表 → 兄弟结构，减轻二级缩进被 ex-editor 拆平
    const content = this.transformContent(ctx.content.html)

    ctx.payload = {
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
  }

  /** 6. 提交：marticlepublish/omSave */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const res = await this.postJson<OmResponse<OmSaveData>>(
      `${ORIGIN}/marticlepublish/omSave?relogin=1`,
      ctx.payload as Record<string, unknown>,
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
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 列表转换 / 图片上传 / 鉴权（保持原样）============

  /**
   * 企鹅号内容变换：目前仅处理列表为 ex-editor 嵌套格式（公式/代码块不改）。
   */
  private transformContent(content: string): string {
    return this.transformLists(content)
  }

  /** 无序列表：对齐创作页 ex-editor 导出结构 */
  private static readonly EX_UL_ATTRS =
    `style="--ul-list-style-type: '\\25EF'" class="nonUnicode-list-style-type" data-list-style-type="circle" classname="ex-list" data-ex-list="ul"`

  /** 有序列表：对称属性（平台样例以 ul 为主） */
  private static readonly EX_OL_ATTRS =
    `style="--ol-list-style-type: decimal" class="nonUnicode-list-style-type" data-list-style-type="decimal" classname="ex-list" data-ex-list="ol"`

  /**
   * 将普通 ul/ol 转为企鹅号 ex-list 嵌套格式：
   * - 子列表仍在父 li 内（不做兄弟提升）
   * - li 文案包在 p 中；嵌套层级加 text-indent: 2em
   * - 仅本适配器调用，不影响其它平台
   */
  private transformLists(html: string): string {
    const preBlocks: string[] = []
    const withPlaceholders = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (block) => {
      const idx = preBlocks.length
      preBlocks.push(block)
      return `<!--QIEHAO_PRE_${idx}-->`
    })

    const transformed = this.transformListFragment(withPlaceholders, 0)

    return transformed.replace(/<!--QIEHAO_PRE_(\d+)-->/g, (_m, idx: string) => {
      return preBlocks[Number(idx)] ?? ''
    })
  }

  /** 扫描片段中的 ul/ol，按出现顺序改写 */
  private transformListFragment(html: string, listDepth: number): string {
    let result = ''
    let i = 0
    const len = html.length

    while (i < len) {
      const slice = html.slice(i)
      const open = /^<(ul|ol)(\b[^>]*)>/i.exec(slice)
      if (open) {
        const tag = open[1].toLowerCase() as 'ul' | 'ol'
        const innerStart = i + open[0].length
        const closeIdx = this.findMatchingCloseTag(html, innerStart, tag)
        if (closeIdx < 0) {
          result += html[i]
          i += 1
          continue
        }
        const inner = html.slice(innerStart, closeIdx)
        result += this.transformOneList(tag, inner, listDepth)
        i = closeIdx + tag.length + 3 // </ul> / </ol>
        continue
      }

      const next = slice.search(/<(ul|ol)\b/i)
      if (next === -1) {
        result += html.slice(i)
        break
      }
      result += html.slice(i, i + next)
      i += next
    }

    return result
  }

  private transformOneList(tag: 'ul' | 'ol', inner: string, depth: number): string {
    const attrs = tag === 'ul' ? QiehaoAdapter.EX_UL_ATTRS : QiehaoAdapter.EX_OL_ATTRS
    const items = this.splitTopLevelLis(inner)
    const lis = items
      .map((liInner) => {
        // 先处理子列表（更深一层），再包 p
        const withNested = this.transformListFragment(liInner, depth + 1)
        const body = this.wrapLiBlocks(withNested, depth)
        return `<li>${body}</li>`
      })
      .join('')
    return `<${tag} ${attrs}>${lis}</${tag}>`
  }

  /**
   * 将 li 内非列表块包进 <p>；depth>=1（嵌套列表项）加 text-indent。
   */
  private wrapLiBlocks(liHtml: string, listDepth: number): string {
    const parts = this.splitByTopLevelLists(liHtml)
    const indent = listDepth >= 1
    return parts
      .map((part) => {
        if (/^<(ul|ol)\b/i.test(part.trim())) return part
        const trimmed = part.trim()
        if (!trimmed) return ''
        return this.ensureParagraph(trimmed, indent)
      })
      .join('')
  }

  private ensureParagraph(html: string, indent: boolean): string {
    const indentStyle = indent ? ' style="text-indent: 2em"' : ''
    // 单个 p：按需补/改 text-indent
    const singleP = /^<p(\b[^>]*)>([\s\S]*)<\/p>$/i.exec(html)
    if (singleP) {
      let attrs = singleP[1] || ''
      const body = singleP[2]
      if (indent) {
        if (/\bstyle\s*=/i.test(attrs)) {
          attrs = attrs.replace(
            /\bstyle\s*=\s*(["'])(.*?)\1/i,
            (_m, q: string, style: string) => {
              const next = /text-indent\s*:/i.test(style)
                ? style
                : `${style}${style.trim().endsWith(';') || !style.trim() ? '' : ';'}text-indent: 2em`
              return `style=${q}${next}${q}`
            }
          )
        } else {
          attrs += ' style="text-indent: 2em"'
        }
      }
      return `<p${attrs}>${body}</p>`
    }
    return `<p${indentStyle}>${html}</p>`
  }

  /** 按顶层 ul/ol 切开，保留列表块 */
  private splitByTopLevelLists(html: string): string[] {
    const parts: string[] = []
    let i = 0
    let buf = ''
    while (i < html.length) {
      const slice = html.slice(i)
      const open = /^<(ul|ol)(\b[^>]*)>/i.exec(slice)
      if (open) {
        if (buf) {
          parts.push(buf)
          buf = ''
        }
        const tag = open[1].toLowerCase()
        const innerStart = i + open[0].length
        const closeIdx = this.findMatchingCloseTag(html, innerStart, tag)
        if (closeIdx < 0) {
          buf += html[i]
          i += 1
          continue
        }
        const end = closeIdx + tag.length + 3
        parts.push(html.slice(i, end))
        i = end
        continue
      }
      buf += html[i]
      i += 1
    }
    if (buf) parts.push(buf)
    return parts
  }

  /** 拆出顶层 li 的 innerHTML */
  private splitTopLevelLis(listInner: string): string[] {
    const items: string[] = []
    let i = 0
    while (i < listInner.length) {
      const slice = listInner.slice(i)
      const open = /^<li(\b[^>]*)>/i.exec(slice)
      if (!open) {
        i += 1
        continue
      }
      const innerStart = i + open[0].length
      const closeIdx = this.findMatchingCloseTag(listInner, innerStart, 'li')
      if (closeIdx < 0) break
      items.push(listInner.slice(innerStart, closeIdx))
      i = closeIdx + 5 // </li>
    }
    return items
  }

  /** 从 innerStart 起找与 tag 匹配的关闭标签位置（返回 '<' 下标） */
  private findMatchingCloseTag(html: string, innerStart: number, tag: string): number {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'i')
    const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
    let depth = 1
    let i = innerStart
    while (i < html.length && depth > 0) {
      const rest = html.slice(i)
      const openM = openRe.exec(rest)
      const closeM = closeRe.exec(rest)
      const openAt = openM ? openM.index : -1
      const closeAt = closeM ? closeM.index : -1
      if (closeAt < 0) return -1
      if (openAt >= 0 && openAt < closeAt && openM) {
        depth += 1
        i += openAt + openM[0].length
      } else if (closeM) {
        depth -= 1
        if (depth === 0) return i + closeAt
        i += closeAt + closeM[0].length
      } else {
        return -1
      }
    }
    return -1
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
