/**
 * 雪球适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：writeV2 页面 UOM_CURRENTUSER 解析鉴权 + Remarkable md→html 转换 +
 * photo/upload 图床 + statuses/draft/save 草稿全部保留。
 * checkAuth 重写（保留 HTML 解析 + 设 currentUser 原逻辑）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { Remarkable } from 'remarkable'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Xueqiu')

interface XueqiuUser {
  id: string
  screen_name: string
  photo_domain: string
  profile_image_url: string
}

export class XueqiuAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'xueqiu',
    name: '雪球',
    icon: 'https://xqdoc.imedao.com/17aebcfb84a145d33fc18679.ico',
    homepage: 'https://mp.xueqiu.com/writeV2',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 雪球使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
    // doPreFilter + processDocCode (旧版)
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    processCodeBlocks: true,
  }

  /** 配置 Schema（声明式；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
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

  private currentUser: XueqiuUser | null = null

  /** 雪球 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.xueqiu.com/xq/*',
      headers: {
        'Origin': 'https://mp.xueqiu.com',
        'Referer': 'https://mp.xueqiu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留 HTML 解析 + 设 currentUser 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://mp.xueqiu.com/writeV2',
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const html = await response.text()

      // 解析 window.UOM_CURRENTUSER - 新版格式
      const userMatch = html.match(/window\.UOM_CURRENTUSER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
      if (!userMatch) {
        return { isAuthenticated: false }
      }

      try {
        const state = JSON.parse(userMatch[1])
        const { currentUser } = state

        if (!currentUser?.id) {
          return { isAuthenticated: false }
        }

        this.currentUser = currentUser

        const avatar = currentUser.photo_domain && currentUser.profile_image_url
          ? `https:${currentUser.photo_domain}${currentUser.profile_image_url.split(',')[0]}`
          : ''

        return {
          isAuthenticated: true,
          userId: String(currentUser.id),
          username: currentUser.screen_name,
          avatar,
        }
      } catch (e) {
        logger.error(' Failed to parse user data:', e)
        return { isAuthenticated: false }
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保 currentUser 已获取 */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    if (!this.currentUser) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录雪球')
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
        skipPatterns: ['xueqiu.com', 'imedao.com'],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    })
  }

  /** 5. 构建草稿请求体（Markdown → 雪球简化 HTML） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    const rendered = this.renderMarkdown(ctx.content.markdown)
    ctx.payload = {
      text: rendered,
      title: ctx.article.title,
      cover_pic: '',
      flags: 'false',
      original_event: '',
      status_id: '',
      legal_user_visible: 'false',
      is_private: 'false',
    }
  }

  /** 6. 提交：statuses/draft/save */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const response = await this.runtime.fetch(
      'https://mp.xueqiu.com/xq/statuses/draft/save.json',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(ctx.payload as Record<string, string>),
      }
    )

    const res = await response.json() as {
      id?: string | number
      error_description?: string
    }

    logger.debug(' Save response:', res)

    if (!res.id) {
      throw new Error(res.error_description || '保存失败')
    }

    const postId = res.id
    return this.createResult(true, {
      postId: String(postId),
      postUrl: `https://mp.xueqiu.com/write/draft/${postId}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ Markdown 渲染 / 图片上传（保持原样）============

  /** Markdown → 雪球简化 HTML（标题→h4、strong→b、em→i、列表/	hr 去包装） */
  private renderMarkdown(markdown: string): string {
    const md = new Remarkable({
      html: true,
      breaks: true,
    })

    // 所有标题都转为 h4
    md.renderer.rules.heading_open = () => '<h4>'
    md.renderer.rules.heading_close = () => '</h4>'

    // strong -> b
    md.renderer.rules.strong_open = () => '<b>'
    md.renderer.rules.strong_close = () => '</b>'

    // em -> i
    md.renderer.rules.em_open = () => '<i>'
    md.renderer.rules.em_close = () => '</i>'

    // 列表 - 移除列表包装
    md.renderer.rules.bullet_list_open = () => ''
    md.renderer.rules.bullet_list_close = () => ''
    md.renderer.rules.ordered_list_open = () => ''
    md.renderer.rules.ordered_list_close = () => ''
    md.renderer.rules.list_item_open = () => ''
    md.renderer.rules.list_item_close = () => ''

    // 移除 hr
    md.renderer.rules.hr = () => ''

    // 图片添加 class
    md.renderer.rules.image = (tokens: Array<{ src?: string; alt?: string }>, idx: number) => {
      const src = tokens[idx].src || ''
      const alt = tokens[idx].alt || ''
      return `<img src="${src}" alt="${alt}" class="ke_img">`
    }

    let rendered = md.render(markdown)

    // Clean up: remove empty p tags and excessive newlines
    rendered = rendered
      .replace(/<p>\s*<\/p>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return rendered
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到雪球
    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')

    const uploadResponse = await this.runtime.fetch(
      'https://mp.xueqiu.com/xq/photo/upload.json',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      url?: string
      filename?: string
    }

    logger.debug(' Image upload response:', res)

    if (!res.url || !res.filename) {
      throw new Error('图片上传失败')
    }

    // 雪球返回的 url 是 //开头，需要加 https:
    const fullUrl = res.url.startsWith('//') ? `https:${res.url}/${res.filename}` : `${res.url}/${res.filename}`

    return {
      url: fullUrl,
    }
  }
}
