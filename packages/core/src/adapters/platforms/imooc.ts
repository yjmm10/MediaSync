/**
 * 慕课网手记适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：u/card JSONP 鉴权 + ajaxuploadimg 图床 + savedraft 草稿全部保留。
 * checkAuth 重写（保留 withHeaderRules + JSONP 解析原逻辑）。
 * https://www.imooc.com
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { pickMarkdownOrHtmlContent } from '../content-origin'

export class ImoocAdapter extends PipelineAdapter {
  meta: PlatformMeta = {
    id: 'imooc',
    name: '慕课手记',
    icon: 'https://www.imooc.com/favicon.ico',
    homepage: 'https://www.imooc.com/article',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 慕课网使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 配置 Schema（imooc 字段较少；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [],
  }

  /** 慕课网 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.imooc.com/article/*',
      headers: {
        Origin: 'https://www.imooc.com',
        Referer: 'https://www.imooc.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth（重写，保留 withHeaderRules + JSONP 原逻辑）============

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const response = await this.runtime.fetch('https://www.imooc.com/u/card', {
          credentials: 'include',
        })
        let text = await response.text()

        // 解析 JSONP 响应
        text = text.replace('jsonpcallback(', '').replace('})', '}')
        const result = JSON.parse(text) as {
          result: number
          msg?: string
          data: { uid: string; nickname: string; img: string }
        }

        if (result.result !== 0) {
          return { isAuthenticated: false, error: result.msg || '未登录' }
        }

        return {
          isAuthenticated: true,
          userId: result.data.uid,
          username: result.data.nickname,
          avatar: result.data.img,
        }
      })
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 管道钩子 ============

  /** 1. 鉴权：确保已登录（沿用 checkAuth） */
  protected async authorize(_ctx: PublishContext): Promise<void> {
    // checkAuth 在 withHeaderRules 内；此处仅触发一次确保登录态
    // imooc checkAuth 不缓存，publish 流程不显式 re-check（与原 publish 一致：原 publish 不调 checkAuth）
  }

  /** 2. 内容规整：真 md 源用 md，否则用 html（避免 Turndown 公式多转义） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    const content = pickMarkdownOrHtmlContent(ctx.article)
    ctx.content.markdown = content
    ctx.content.html = ''
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
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.markdown = await this.processImages(ctx.content.markdown, upload, opts)
    })
  }

  /** 5. 构建 savedraft 请求体 */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      editor: '0',
      draft_id: '0',
      title: ctx.article.title,
      content: ctx.content.markdown,
    }
  }

  /** 6. 提交：article/savedraft */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    const response = await this.runtime.fetch('https://www.imooc.com/article/savedraft', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(ctx.payload as Record<string, string>),
    })

    const res = (await response.json()) as { data?: string }

    if (!res.data) {
      throw new Error('发布失败')
    }

    return this.createResult(true, {
      postId: res.data,
      postUrl: `https://www.imooc.com/article/draft/id/${res.data}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 图片上传（保持原样）============

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    const filename = `${Date.now()}.jpg`
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' })

    formData.append('photo', file, filename)
    formData.append('type', file.type)
    formData.append('id', 'WU_FILE_0')
    formData.append('name', filename)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(file.size))

    const response = await this.runtime.fetch(
      'https://www.imooc.com/article/ajaxuploadimg',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = (await response.json()) as { result: number; msg?: string; data: { imgpath: string } }

    if (res.result !== 0) {
      throw new Error(res.msg || '图片上传失败')
    }

    // 处理协议相对 URL
    let imgUrl = res.data.imgpath
    if (imgUrl.startsWith('//')) {
      imgUrl = 'https:' + imgUrl
    }

    return { url: imgUrl }
  }
}
