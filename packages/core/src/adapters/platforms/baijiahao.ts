/**
 * 百家号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Baijiahao')

interface BaijiahaoUserInfo {
  userid: string
  name: string
  avatar: string
}

export class BaijiahaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'baijiahao',
    name: '百家号',
    icon: 'https://www.baidu.com/favicon.ico',
    homepage: 'https://baijiahao.baidu.com/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 百家号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private userInfo: BaijiahaoUserInfo | null = null
  private authToken: string = ''

  /** 百家号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://baijiahao.baidu.com/*',
      headers: {
        'Origin': 'https://baijiahao.baidu.com',
        'Referer': 'https://baijiahao.baidu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        errno: number
        errmsg: string
        data?: { user: BaijiahaoUserInfo }
      }>(`https://baijiahao.baidu.com/builder/app/appinfo?_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.errmsg === 'success' && res.data?.user) {
        this.userInfo = res.data.user
        return {
          isAuthenticated: true,
          userId: res.data.user.userid,
          username: res.data.user.name,
          avatar: res.data.user.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private async fetchAuthToken(): Promise<string> {
    const response = await this.runtime.fetch('https://baijiahao.baidu.com/builder/rc/edit', {
      credentials: 'include',
    })
    const html = await response.text()

    const match = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/)
    if (!match) {
      throw new Error('登录失效，请重新登录百家号')
    }

    const token = match[1]
    logger.debug('Auth token obtained')
    return token
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录百家号')
        }
      }

      this.authToken = await this.fetchAuthToken()

      // Use pre-processed HTML content; normalize code blocks for BJH editor
      let content = this.transformContent(article.html || '')

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
          onProgress: options?.onImageProgress,
        }
      )

      const response = await this.runtime.fetch(
        'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'token': this.authToken,
          },
          body: new URLSearchParams({
            title: article.title,
            content: content,
            feed_cat: '1',
            len: String(content.length),
            activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
            source_reprinted_allow: '0',
            original_status: '0',
            original_handler_status: '1',
            isBeautify: 'false',
            subtitle: '',
            bjhtopic_id: '',
            bjhtopic_info: '',
            type: 'news',
          }),
        }
      )

      const text = await response.text()
      const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)$/, '')
      const res = JSON.parse(jsonStr) as {
        errno: number
        errmsg: string
        ret?: { article_id: string }
      }

      logger.debug('Save response:', res)

      if (res.errmsg !== 'success' || !res.ret?.article_id) {
        throw new Error(res.errmsg || '保存草稿失败')
      }

      const postId = res.ret.article_id
      const draftUrl = `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${postId}`

      return this.createResult(true, {
        postId: postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 百家号内容转换：代码块 data-lang 归一化（公式暂不支持，保持原文）
   */
  private transformContent(content: string): string {
    return this.transformCodeBlocks(content)
  }

  /**
   * 归一化为百家号代码块：<pre data-lang="javascript">code</pre>
   * 无 data-lang 或仅 language-xxx class 时编辑器会落到 Plain Text(string)；
   * 短名 js 有高亮但 UI 语言标签空白，需映射为全名。
   */
  private transformCodeBlocks(html: string): string {
    return html.replace(
      /<pre(\b[^>]*)>([\s\S]*?)<\/pre>/gi,
      (_match, preAttrs: string, inner: string) => {
        const langFromPre =
          /(?:\sdata-lang|\slang|\slanguage)=["']([\w#+.-]+)["']/i.exec(preAttrs)?.[1] ||
          /(?:language|lang)-([\w#+.-]+)/i.exec(preAttrs)?.[1]

        const codeMatch = /^(\s*)<code(\b[^>]*)>([\s\S]*?)<\/code>(\s*)$/i.exec(inner)
        if (codeMatch) {
          const codeAttrs = codeMatch[2]
          const body = codeMatch[3]
          const langFromCode =
            /(?:language|lang)-([\w#+.-]+)/i.exec(codeAttrs)?.[1] ||
            /(?:\sdata-lang|\slang|\slanguage)=["']([\w#+.-]+)["']/i.exec(codeAttrs)?.[1]
          const lang = this.normalizeBaijiahaoLang(langFromPre || langFromCode)
          return `<pre data-lang="${lang}">${body}</pre>`
        }

        const lang = this.normalizeBaijiahaoLang(
          langFromPre || /(?:language|lang)-([\w#+.-]+)/i.exec(preAttrs)?.[1]
        )
        return `<pre data-lang="${lang}">${inner}</pre>`
      }
    )
  }

  /**
   * 映射到百家号代码块可显示标签的语言 id；未知 → string (Plain Text)
   */
  private normalizeBaijiahaoLang(lang: string | undefined): string {
    if (!lang) return 'string'
    const key = lang.trim().toLowerCase()
    const map: Record<string, string> = {
      js: 'javascript',
      javascript: 'javascript',
      py: 'python',
      python: 'python',
      go: 'go',
      golang: 'go',
      c: 'c',
      cpp: 'cpp',
      'c++': 'cpp',
      java: 'java',
      csharp: 'dotnet',
      cs: 'dotnet',
      'c#': 'dotnet',
      dotnet: 'dotnet',
      string: 'string',
      plain: 'string',
      text: 'string',
    }
    return map[key] ?? 'string'
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('media', imageBlob, 'image.jpg')
    formData.append('type', 'image')
    formData.append('app_id', '1589639493090963')
    formData.append('is_waterlog', '1')
    formData.append('save_material', '1')
    formData.append('no_compress', '0')
    formData.append('is_events', '')
    formData.append('article_type', 'news')

    const uploadUrl = 'https://baijiahao.baidu.com/pcui/picture/uploadproxy'
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      errno: number
      errmsg: string
      ret?: { https_url: string }
    }

    logger.debug('Image upload response:', res)

    if (res.errmsg !== 'success' || !res.ret?.https_url) {
      throw new Error(res.errmsg || '图片上传失败')
    }

    return {
      url: res.ret.https_url,
    }
  }
}
