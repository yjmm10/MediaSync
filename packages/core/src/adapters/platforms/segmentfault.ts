/**
 * 思否 (Segmentfault) 适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：session token 获取 + 公式/表格 Markdown 规整 + gateway/draft 草稿全部保留。
 * 鉴权策略化：SwHtmlAuthStrategy 拉 user/settings 页面正则提取登录态。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { SwHtmlAuthStrategy } from '../auth-strategy'

export class SegmentfaultAdapter extends PipelineAdapter {
  meta: PlatformMeta = {
    id: 'segmentfault',
    name: '思否',
    icon: 'https://imgcache.iyiou.com/Company/2016-05-11/cf-segmentfault.jpg',
    homepage: 'https://segmentfault.com/user/draft',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 思否使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 配置 Schema（声明式，UI 据此渲染；P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '标签' },
    ],
  }

  /** 鉴权策略：SW 拉 user/settings 页面 HTML 正则提取登录态 */
  protected readonly authStrategies = [
    new SwHtmlAuthStrategy({
      url: 'https://segmentfault.com/user/settings',
      extract: (html): AuthResult | null => {
        const userLinkMatch = html.match(/href="\/u\/([^"]+)"/)
        if (!userLinkMatch) return { isAuthenticated: false, error: '未登录' }
        const uid = userLinkMatch[1]
        const avatarMatch = html.match(/src="(https:\/\/avatar-static\.segmentfault\.com\/[^"]+)"/)
        return {
          isAuthenticated: true,
          userId: uid,
          username: uid,
          avatar: avatarMatch ? avatarMatch[1] : undefined,
        }
      },
    }),
  ]

  private sessionToken: string | null = null

  /** 思否 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://segmentfault.com/gateway/*',
      headers: {
        Origin: 'https://segmentfault.com',
        Referer: 'https://segmentfault.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ 管道钩子 ============

  /** 2. 内容规整：取默认内容 + 思否 Markdown 规整（公式/表格） */
  protected async normalizeContent(ctx: PublishContext): Promise<void> {
    await super.normalizeContent(ctx)
    ctx.content.markdown = this.normalizeMarkdownForSegmentfault(ctx.content.markdown || '')
  }

  /** 3. 上传图片：在 Header 规则保护下获取 session token + SharedImageCache 去重上传 */
  protected async uploadImages(ctx: PublishContext): Promise<void> {
    await this.withHeaderRules(this.HEADER_RULES, async () => {
      this.sessionToken = await this.getSessionToken()
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

  /** 5. 构建草稿请求体（P2 写死保持等价） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      title: ctx.article.title,
      tags: [],
      text: ctx.content.markdown,
      object_id: '',
      type: 'article',
    }
  }

  /** 6. 提交：gateway/draft，解析数组/对象两种响应格式 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    if (!this.sessionToken) {
      throw new Error('未获取 token')
    }

    const response = await this.runtime.fetch('https://segmentfault.com/gateway/draft', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        token: this.sessionToken,
        accept: '*/*',
      },
      body: JSON.stringify(ctx.payload),
    })

    // 处理异常响应
    const text = await response.text()
    if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
      throw new Error(text === 'Unauthorized' ? '未授权' : text)
    }

    let res
    try {
      res = JSON.parse(text)
    } catch {
      throw new Error('发布失败: ' + text)
    }

    // 处理数组格式响应 [1, "error_message"]
    if (Array.isArray(res)) {
      if (res[0] === 1) {
        throw new Error(res[1] || '发布失败')
      }
      // [0, data] 成功格式
      const data = res[1]
      if (data?.id) {
        return this.createResult(true, {
          postId: data.id,
          postUrl: `https://segmentfault.com/write?draftId=${data.id}`,
          draftOnly: true,
        })
      }
    }

    if (!res.id) {
      const errorMsg = res.message || res.msg || res.error || res.errMsg || JSON.stringify(res)
      throw new Error(errorMsg)
    }

    return this.createResult(true, {
      postId: res.id,
      postUrl: `https://segmentfault.com/write?draftId=${res.id}`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ session token 与图片上传（保持原样）============

  /**
   * 获取 session token
   */
  private async getSessionToken(): Promise<string> {
    const response = await this.runtime.fetch('https://segmentfault.com/write', {
      credentials: 'include',
    })
    const html = await response.text()

    // 新版 token 格式: serverData":{"Token":"xxx"
    const tokenMatch = html.match(/serverData":\s*\{\s*"Token"\s*:\s*"([^"]+)"/)
    if (tokenMatch) {
      return tokenMatch[1]
    }

    // 兼容旧版格式
    const markStr = 'window.g_initialProps = '
    const authIndex = html.indexOf(markStr)
    if (authIndex === -1) {
      throw new Error('获取 session token 失败')
    }

    const endIndex = html.indexOf(';\n\t</script>', authIndex)
    if (endIndex === -1) {
      throw new Error('解析 session token 失败')
    }

    const configStr = html.substring(authIndex + markStr.length, endIndex)

    try {
      const config = JSON.parse(configStr)
      const token = config?.global?.sessionInfo?.key
      if (!token) {
        throw new Error('session token 为空')
      }
      return token
    } catch (e) {
      throw new Error('解析 session token 失败: ' + (e as Error).message)
    }
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    if (!this.sessionToken) {
      throw new Error('未获取 token')
    }

    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    formData.append('image', blob)

    const response = await this.runtime.fetch(
      'https://segmentfault.com/gateway/image',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          token: this.sessionToken,
        },
        body: formData,
      }
    )

    // 处理异常响应
    const text = await response.text()
    if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
      throw new Error(text === 'Unauthorized' ? '未授权' : text)
    }

    let res
    try {
      res = JSON.parse(text)
    } catch {
      throw new Error('图片上传失败: ' + text)
    }

    // 新版返回格式: { url: "/img/xxx", result: "https://..." }
    // 旧版返回格式: [0, url, id] 或 [1, error_message]
    const imageUrl = res.result || (Array.isArray(res) ? (res[0] === 1 ? null : res[1] || `https://image-static.segmentfault.com/${res[2]}`) : null)
    if (!imageUrl) {
      throw new Error(Array.isArray(res) ? (res[1] || '图片上传失败') : '图片上传失败')
    }
    return { url: imageUrl }
  }

  /**
   * 思否 Markdown 兼容处理：
   * - turndown 会把公式里的 \ 转成 \\，需还原为一层 \
   * - 行内公式使用 \\(...\\)，块级仍用 $$...$$
   * - 表格分隔行统一为紧凑 |---|---|（无空格、无对齐冒号）
   */
  private normalizeMarkdownForSegmentfault(markdown: string): string {
    const codeBlocks: string[] = []
    let md = markdown.replace(/```[\s\S]*?```/g, (block) => {
      const idx = codeBlocks.length
      codeBlocks.push(block)
      return `\0CODE${idx}\0`
    })

    const unescapeFormula = (body: string) => body.replace(/\\\\/g, '\\')

    // 块级公式 $$...$$
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => `$$${unescapeFormula(body)}$$`)
    // 行内公式 $...$ → \\(...\\)（排除 $$）
    md = md.replace(
      /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g,
      (_m, body: string) => `\\\\(${unescapeFormula(body)}\\\\)`
    )

    // 表格分隔行 → |---|---|
    md = md.replace(
      /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?[ \t]*$/gm,
      (line) => {
        const colCount = (line.match(/:?-+:?/g) || []).length
        if (colCount === 0) return line
        return '|' + Array(colCount).fill('---').join('|') + '|'
      }
    )

    return md.replace(/\0CODE(\d+)\0/g, (_m, i: string) => codeBlocks[Number(i)] ?? '')
  }
}
