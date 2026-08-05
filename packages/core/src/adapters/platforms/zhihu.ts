/**
 * 知乎适配器（PipelineAdapter 实现）
 *
 * 行为等价迁移：草稿 create + update 两步流程、HTML 转换（表格/列表/LaTeX/代码块）、
 * 图片上传（URL API + OSS 直传）全部保留。
 *
 * 鉴权策略化：SwApiAuthStrategy 走 user/api/v4/me。
 * Header 规则拆分：uploadImages 钩子内包一次 + submit 外层管道自动包一次（顺序、不嵌套）。
 */
import { PipelineAdapter, type PublishContext } from '../pipeline'
import type { AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { ImageProcessOptions, ImageUploadResult } from '../code-adapter'
import type { PublishSchema } from '../publish-schema'
import { SwApiAuthStrategy } from '../auth-strategy'
import { createLogger } from '../../lib/logger'
import md5Lib from 'js-md5'

const logger = createLogger('Zhihu')

// js-md5 导出的是函数本身
const jsMd5 = md5Lib as unknown as (message: string | ArrayBuffer | Uint8Array) => string

export class ZhihuAdapter extends PipelineAdapter {
  readonly meta: PlatformMeta = {
    id: 'zhihu',
    name: '知乎',
    icon: 'https://static.zhihu.com/static/favicon.ico',
    homepage: 'https://www.zhihu.com',
    capabilities: ['article', 'draft', 'image_upload', 'tags', 'cover'],
  }

  /** 预处理配置: 知乎使用 HTML，需要特殊处理 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    // doPreFilter: 移除特殊标签及其父元素
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    // processDocCode: 处理代码块
    processCodeBlocks: true,
    convertSectionToDiv: true,
    removeTrailingBr: true,
    unwrapSingleChildContainers: true,
    unwrapNestedFigures: true,
    compactHtml: true,
    // 清理空内容（与旧 processHtml 一致）
    removeEmptyLines: true,
    removeEmptyDivs: true,
    removeNestedEmptyContainers: true,
  }

  /** 配置 Schema（声明式，UI 据此渲染；P1/P2 运行时仍写死保持等价） */
  readonly publishSchema: PublishSchema = {
    fields: [
      { kind: 'tags', key: 'tags', label: '话题' },
      { kind: 'cover', key: 'cover', label: '封面', modes: ['auto', 'manual', 'none'] },
      { kind: 'column', key: 'column', label: '专栏', source: 'remote' },
    ],
  }

  /** 鉴权策略：SW 直调 user/api/v4/me（手动带 x-requested-with） */
  protected readonly authStrategies = [
    new SwApiAuthStrategy({
      url: 'https://www.zhihu.com/api/v4/me',
      headers: { 'x-requested-with': 'fetch' },
      parse: (json): AuthResult | null => {
        const data = json as { id?: string; name?: string; avatar_url?: string }
        if (data.id) {
          return {
            isAuthenticated: true,
            userId: data.id,
            username: data.name,
            avatar: data.avatar_url,
          }
        }
        return { isAuthenticated: false }
      },
    }),
  ]

  /** 知乎 API 需要的 Header 规则 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.zhihu.com/api/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://zhuanlan.zhihu.com/api/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://api.zhihu.com/*',
      headers: { 'x-requested-with': 'fetch' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ 管道钩子 ============

  // authorize / normalizeContent / resolveReferences 用基类默认：
  // - authorize：CompositeAuthStrategy 级联 authStrategies（SwApiAuthStrategy）
  // - normalizeContent：从 platformContents[zhihu] 取 html

  /**
   * 3. 上传图片 + 知乎特定内容转换
   *    在 Header 规则保护下走 SharedImageCache 去重 + processImages；
   *    图片替换后再做知乎 Draft.js 格式转换（表格/列表/LaTeX/代码块/figure）
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
        skipPatterns: [
          'zhimg.com',
          'pic1.zhimg.com',
          'pic2.zhimg.com',
          'pic3.zhimg.com',
          'pic4.zhimg.com',
          'zhihu.com/equation',
        ],
        onProgress: ctx.onImageProgress,
        concurrency: 3,
      }
      ctx.content.html = await this.processImages(ctx.content.html, upload, opts)
    })
    // 知乎特定的内容转换（图片上传后）
    ctx.content.html = this.transformContent(ctx.content.html)
  }

  /** 5. 构建草稿更新请求体（P2 写死保持等价；P3 读 ctx.params） */
  protected async buildPayload(ctx: PublishContext): Promise<void> {
    ctx.payload = {
      title: ctx.article.title,
      content: ctx.content.html,
    }
  }

  /** 6. 提交：create draft + PATCH update draft，返回草稿结果 */
  protected async submit(ctx: PublishContext): Promise<SyncResult> {
    // 1. 创建草稿
    const createResponse = await this.runtime.fetch(
      'https://zhuanlan.zhihu.com/api/articles/drafts',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-with': 'fetch',
        },
        body: JSON.stringify({
          title: ctx.article.title,
          content: '',
          delta_time: 0,
        }),
      },
    )

    const responseText = await createResponse.text()
    logger.debug('Create draft response:', createResponse.status, responseText.substring(0, 200))

    if (!createResponse.ok) {
      throw new Error(`创建草稿失败: ${createResponse.status} - ${responseText}`)
    }

    let createData: { id?: string }
    try {
      createData = JSON.parse(responseText)
    } catch {
      throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
    }

    if (!createData.id) {
      throw new Error('创建草稿失败: 无效响应')
    }

    const draftId = createData.id
    logger.debug('Draft created:', draftId)

    // 2. 更新草稿内容
    const updateResponse = await this.runtime.fetch(
      `https://zhuanlan.zhihu.com/api/articles/${draftId}/draft`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-with': 'fetch',
        },
        body: JSON.stringify(ctx.payload),
      },
    )

    if (!updateResponse.ok) {
      const updateText = await updateResponse.text()
      logger.error('Update draft failed:', updateResponse.status, updateText)
      throw new Error(`更新草稿失败: ${updateResponse.status}`)
    }

    logger.debug('Draft updated, status:', updateResponse.status)

    return this.createResult(true, {
      postId: draftId,
      postUrl: `https://zhuanlan.zhihu.com/p/${draftId}/edit`,
      draftOnly: true,
    })
  }

  /** Header 规则（submit 外层由管道自动 withHeaderRules 包装） */
  protected getHeaderRules(): Array<Omit<HeaderRule, 'id'>> {
    return this.HEADER_RULES
  }

  // ============ 知乎内容转换（保持原样）============

  /**
   * 知乎内容转换 - 适配 Draft.js 编辑器格式
   */
  private transformContent(content: string): string {
    let result = content

    // 0. 引用块内的列表转圆点（知乎 blockquote 不支持 ul/ol，圆点代替）
    result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
      const converted = inner
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_lm: string, liInner: string) => `• ${liInner.trim()}<br>`)
        .replace(/<\/?(ul|ol)[^>]*>/gi, '')
      return `<blockquote>${converted}</blockquote>`
    })

    // 1. 转换表格格式 - 知乎 Draft.js 编辑器需要特定格式
    result = this.transformTables(result)

    // 2. 嵌套列表 → 兄弟嵌套（避免同级列表被拆断）
    result = this.transformNestedLists(result)

    // 3. LaTeX 公式 - 知乎编辑器使用 equation 图片
    result = this.transformLatex(result)

    // 4. 图片格式 - 知乎需要 figure 包裹（跳过公式图）
    result = result.replace(
      /<img([^>]*?)src="([^"]+)"([^>]*)>/gi,
      (match, before, src, after) => {
        if (
          src.includes('zhihu.com/equation') ||
          /\beeimg\s*=/i.test(match)
        ) {
          return match
        }
        return `<figure><img${before}src="${src}"${after}></figure>`
      }
    )

    // 5. 代码块格式 - 知乎只认 <pre lang="xxx">，且不要内层 <code>
    //    若保留 <pre><code class="language-js">，服务端会落到 lang="text"
    result = this.transformCodeBlocks(result)

    // 6. 移除微信样式属性 (但保留知乎的 data-draft-* 属性)
    result = result.replace(/\s*data-(?!draft)[a-z-]+="[^"]*"/gi, '')
    result = result.replace(/\s*style="[^"]*"/gi, '')

    // 7. 清理空段落（公式转换等可能留下）
    result = result.replace(/<p>(?:\s|<br\s*\/?>)*<\/p>/gi, '')

    // 8. 压缩标签间空白（Draft.js 会把 >\n< 当成空块，拆断列表并在表格前插空行）
    result = this.compactInterTagWhitespace(result)

    return result
  }

  /**
   * 去掉标签之间的空白/换行，保留 <pre> 内部缩进。
   */
  private compactInterTagWhitespace(html: string): string {
    const preBlocks: string[] = []
    // 用注释占位（仍以 < 开头），保证周围的 >\s+< 也能被压掉
    const withPlaceholders = html.replace(
      /<pre\b[^>]*>[\s\S]*?<\/pre>/gi,
      (block) => {
        const idx = preBlocks.length
        preBlocks.push(block)
        return `<!--ZHIHU_PRE_${idx}-->`
      }
    )

    const compacted = withPlaceholders.replace(/>\s+</g, '><')

    return compacted.replace(/<!--ZHIHU_PRE_(\d+)-->/g, (_m, idx: string) => {
      return preBlocks[Number(idx)] ?? ''
    })
  }

  /**
   * 归一化为知乎代码块：<pre lang="js">code</pre>
   */
  private transformCodeBlocks(html: string): string {
    return html.replace(
      /<pre(\b[^>]*)>([\s\S]*?)<\/pre>/gi,
      (_match, preAttrs: string, inner: string) => {
        const langFromPre = /(?:\slang|language)=["']([\w+-]+)["']/i.exec(preAttrs)?.[1]

        const codeMatch = /^(\s*)<code(\b[^>]*)>([\s\S]*?)<\/code>(\s*)$/i.exec(inner)
        if (codeMatch) {
          const codeAttrs = codeMatch[2]
          const body = codeMatch[3]
          const langFromCode =
            /(?:language|lang)-([\w+-]+)/i.exec(codeAttrs)?.[1] ||
            /(?:\slanguage|\slang)=["']([\w+-]+)["']/i.exec(codeAttrs)?.[1]
          const lang = langFromPre || langFromCode || 'text'
          return `<pre lang="${lang}">${body}</pre>`
        }

        // 已是纯 pre 文本；补上 lang（若属性里已有则保留）
        if (langFromPre) {
          return `<pre lang="${langFromPre}">${inner}</pre>`
        }
        const langFromClass = /(?:language|lang)-([\w+-]+)/i.exec(preAttrs)?.[1]
        return `<pre lang="${langFromClass || 'text'}">${inner}</pre>`
      }
    )
  }

  /**
   * 将 li 内嵌套的 ul/ol 提升为 li 的兄弟节点。
   * 标准嵌套 HTML 在知乎 Draft.js 中会把同级项拆成多个列表；兄弟嵌套可保持连续 depth。
   */
  private transformNestedLists(html: string): string {
    let result = html
    const re =
      /<li(\b[^>]*)>([\s\S]*?)<(ul|ol)(\b[^>]*)>([\s\S]*?)<\/\3>\s*<\/li>/gi
    let prev = ''
    while (prev !== result) {
      prev = result
      result = result.replace(
        re,
        (_match, liAttr: string, before: string, tag: string, listAttr: string, inner: string) =>
          `<li${liAttr}>${before.trim()}</li><${tag}${listAttr}>${inner}</${tag}>`
      )
    }
    return result
  }

  /**
   * Markdown/HTML 中的 $ / $$ 公式转为知乎 equation 图片
   */
  private transformLatex(content: string): string {
    const converted = content
      .split(/(<pre[\s\S]*?<\/pre>)/gi)
      .map((chunk) => {
        if (/^<pre/i.test(chunk)) return chunk

        return chunk
          .replace(/\$\$([\s\S]+?)\$\$/g, (_match, latex: string) =>
            this.zhihuEquationImage(latex, '2')
          )
          .replace(/\$([^$\n]+?)\$/g, (_match, latex: string) =>
            this.zhihuEquationImage(latex, '1')
          )
      })
      .join('')

    // 知乎用 alt 恢复 TeX：alt 中的换行会变成编辑器空行；顺带清掉空段
    return converted
      .replace(/<p>(?:\s|<br\s*\/?>)*<\/p>/gi, '')
  }

  private zhihuEquationImage(latex: string, eeimg: '1' | '2'): string {
    // alt 中的 \n 会在知乎编辑器变成 <br>/空行，必须压成单行
    const formula = latex
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const encoded = encodeURIComponent(formula)
    const alt = formula
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    return `<img src="https://www.zhihu.com/equation?tex=${encoded}" alt="${alt}" class="ee_img tr_noresize" eeimg="${eeimg}">`
  }

  /**
   * 转换表格为知乎 Draft.js 格式
   */
  private transformTables(html: string): string {
    // 1. 解包 figure 中的 table
    let result = html.replace(
      /<figure[^>]*>\s*(<table[\s\S]*?<\/table>)\s*<\/figure>/gi,
      '$1'
    )

    // 2. 转换 table 结构
    result = result.replace(
      /<table[^>]*>([\s\S]*?)<\/table>/gi,
      (_match, tableContent) => {
        // 提取 thead 中的行
        const theadMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
        // 提取 tbody 中的行
        const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)

        let headerRows = ''
        let bodyRows = ''

        if (theadMatch) {
          // 处理表头行 - 确保使用 <th>
          headerRows = theadMatch[1]
            .replace(/<td([^>]*)>/gi, '<th$1>')
            .replace(/<\/td>/gi, '</th>')
        }

        if (tbodyMatch) {
          bodyRows = tbodyMatch[1]
        } else {
          // 没有 tbody，整个内容作为 body（排除 thead）
          bodyRows = tableContent
            .replace(/<thead[^>]*>[\s\S]*?<\/thead>/gi, '')
            .replace(/<\/?tbody[^>]*>/gi, '')
        }

        // 如果没有 thead，检查第一行是否全是 th
        if (!theadMatch) {
          const firstRowMatch = bodyRows.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)
          if (firstRowMatch) {
            const firstRowContent = firstRowMatch[1]
            if (/<th[^>]*>/i.test(firstRowContent) && !/<td[^>]*>/i.test(firstRowContent)) {
              headerRows = firstRowMatch[0]
              bodyRows = bodyRows.replace(firstRowMatch[0], '')
            }
          }
        }

        // 组装知乎格式的表格
        return `<table data-draft-node="block" data-draft-type="table" data-size="normal" data-row-style="normal"><tbody>${headerRows}${bodyRows}</tbody></table>`
      }
    )

    return result
  }

  // ============ 图片上传（保持原样）============

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.uploadImageBinaryInternal(file)
  }

  /**
   * 通过 URL 上传图片
   * 支持远程 URL 和 data URI
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 检测 data URI，使用二进制上传
    if (src.startsWith('data:')) {
      logger.debug('Detected data URI, using binary upload')
      const blob = await fetch(src).then(r => r.blob())
      const url = await this.uploadImageBinaryInternal(blob)
      return { url }
    }

    // 远程 URL 使用知乎 URL 上传 API
    const response = await this.runtime.fetch('https://zhuanlan.zhihu.com/api/uploaded_images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-requested-with': 'fetch',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        url: src,
        source: 'article',
      }),
    })

    const data = await response.json() as { src?: string; hash?: string }

    if (data.src) {
      return { url: data.src }
    }

    throw new Error('图片上传失败')
  }

  /**
   * 上传图片 (二进制方式) - 内部使用
   */
  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    // 1. 计算图片 hash
    const buffer = await file.arrayBuffer()
    const imageHash = jsMd5(buffer)

    // 2. 请求上传凭证
    const tokenResponse = await this.runtime.fetch('https://api.zhihu.com/images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_hash: imageHash,
        source: 'article',
      }),
    })

    const tokenData = await tokenResponse.json() as {
      upload_file: {
        state: number
        image_id: string
        object_key: string
      }
      upload_token: {
        access_id: string
        access_key: string
        access_token: string
      }
    }
    const uploadFile = tokenData.upload_file

    // 3. 检查图片是否已存在
    if (uploadFile.state === 1) {
      const imgDetail = await this.waitForImageReady(uploadFile.image_id)
      const objectKey = imgDetail.original_hash
      return `https://pic4.zhimg.com/${objectKey}`
    }

    // 4. 上传到 OSS
    const token = tokenData.upload_token
    await this.ossUpload(
      'https://zhihu-pics-upload.zhimg.com',
      uploadFile.object_key,
      file,
      token
    )

    // 5. 处理 GIF 扩展名
    let objectKey = uploadFile.object_key
    if (file.type === 'image/gif') {
      objectKey = objectKey + '.gif'
    }

    return `https://pic4.zhimg.com/${objectKey}`
  }

  /**
   * 等待图片处理完成
   */
  private async waitForImageReady(imageId: string): Promise<{ original_hash: string }> {
    const maxRetries = 10
    for (let i = 0; i < maxRetries; i++) {
      const response = await this.runtime.fetch(`https://api.zhihu.com/images/${imageId}`, {
        credentials: 'include',
      })
      const data = await response.json() as { status?: string; original_hash?: string }

      if (data.status === 'completed' || data.original_hash) {
        return data as { original_hash: string }
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Image processing timeout')
  }

  /**
   * OSS 上传 - 手动 V1 签名
   */
  private async ossUpload(
    endpoint: string,
    objectKey: string,
    blob: Blob,
    token: { access_id: string; access_key: string; access_token: string }
  ): Promise<void> {
    const contentType = blob.type || 'application/octet-stream'
    const url = `${endpoint}/${objectKey}`

    // OSS 日期格式 (GMT)
    const ossDate = new Date().toUTCString()
    const ossUserAgent = 'aliyun-sdk-js/6.8.0'

    // 构建 CanonicalizedOSSHeaders (按字母顺序排列，每行以\n结尾)
    const ossHeaders: Record<string, string> = {
      'x-oss-date': ossDate,
      'x-oss-security-token': token.access_token,
      'x-oss-user-agent': ossUserAgent,
    }
    // 按字母顺序排序，每个 header 以 \n 结尾
    const canonicalizedOSSHeaders = Object.keys(ossHeaders)
      .sort()
      .map(key => `${key}:${ossHeaders[key]}`)
      .join('\n')

    // CanonicalizedResource: /bucket/object-key
    // bucket 名是 zhihu-pics (不是 zhihu-pics-upload)
    const bucket = 'zhihu-pics'
    const canonicalizedResource = `/${bucket}/${objectKey}`

    // 构建待签名字符串
    // VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedOSSHeaders + "\n" + CanonicalizedResource
    const stringToSign =
      'PUT\n' +
      '\n' +  // Content-MD5 (空)
      contentType + '\n' +
      ossDate + '\n' +  // Date (与 x-oss-date 相同)
      canonicalizedOSSHeaders + '\n' +
      canonicalizedResource

    // 计算 HMAC-SHA1 签名
    const signature = await this.hmacSha1Base64(token.access_key, stringToSign)
    const authorization = `OSS ${token.access_id}:${signature}`

    logger.debug('OSS stringToSign:', JSON.stringify(stringToSign))
    logger.debug('OSS authorization:', authorization)

    // 添加 header 规则来设置正确的 Origin
    let ruleId: string | undefined
    try {
      if (this.runtime.headerRules) {
        ruleId = await this.runtime.headerRules.add({
          urlFilter: '*://zhihu-pics-upload.zhimg.com/*',
          headers: {
            'Origin': 'https://zhuanlan.zhihu.com',
            'Referer': 'https://zhuanlan.zhihu.com/',
          },
          resourceTypes: ['xmlhttprequest'],
        })
        logger.debug('Added header rule for OSS upload:', ruleId)
      }

      const response = await this.runtime.fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Authorization': authorization,
          'x-oss-date': ossDate,
          'x-oss-security-token': token.access_token,
          'x-oss-user-agent': ossUserAgent,
        },
        body: blob,
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error('OSS upload failed:', response.status, text)
        throw new Error(`OSS upload failed: ${response.status}`)
      }
      logger.debug('OSS upload success')
    } finally {
      // 清理 header 规则
      if (ruleId && this.runtime.headerRules) {
        await this.runtime.headerRules.remove(ruleId)
        logger.debug('Removed header rule:', ruleId)
      }
    }
  }

  /**
   * HMAC-SHA1 签名并返回 Base64 (使用 Web Crypto API)
   */
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
}
