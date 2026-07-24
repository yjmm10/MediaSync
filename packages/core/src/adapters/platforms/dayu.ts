/**
 * 大鱼号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('DaYu')

const DAYU_CODE_BLOCK_STYLE =
  'margin:8px 0;padding:12px;background:#f6f8fa;border-radius:4px;' +
  'font-family:Menlo,Monaco,Consolas,monospace;font-size:13px;line-height:1.6;word-break:break-all;'

interface DaYuMeta {
  utoken: string
  uploadSign: string
  uid: string
  title: string
  avatar: string
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTagsToText(html: string): string {
  const withoutTags = html.replace(/<[^>]+>/g, '')
  return decodeBasicEntities(withoutTags)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * 大鱼 UEditor 不支持 pre/code 换行与行内 code：
 * - 代码块转为带 <br> 的等宽段落
 * - 行内 code 降为纯文本
 */
function prepareHtmlForDayu(html: string): string {
  let result = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const text = stripTagsToText(inner).replace(/^\n+/, '').replace(/\n+$/, '')
    if (!text.trim()) {
      return ''
    }
    const lines = text.split('\n').map((line) => escapeHtmlText(line))
    return `<p style="${DAYU_CODE_BLOCK_STYLE}">${lines.join('<br>')}</p>`
  })

  result = result.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => {
    const text = stripTagsToText(inner)
    if (!text) {
      return ''
    }
    return escapeHtmlText(text)
  })

  return result
}

export class DaYuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dayu',
    name: '大鱼号',
    icon: 'https://image.uc.cn/s/uae/g/1v/images/index/favicon.ico',
    homepage: 'https://mp.dayu.com/dashboard/article/write',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private cacheMeta: DaYuMeta | null = null

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.dayu.com/*',
      headers: {
        Origin: 'https://mp.dayu.com',
        Referer: 'https://mp.dayu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ns.dayu.com/*',
      headers: {
        Origin: 'https://mp.dayu.com',
        Referer: 'https://mp.dayu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const ok = await this.refreshMetaInner()
        if (!ok || !this.cacheMeta) {
          return {
            isAuthenticated: false,
            error: '未登录大鱼号，请先在浏览器打开并登录 https://mp.dayu.com/dashboard/index',
          }
        }
        return {
          isAuthenticated: true,
          userId: this.cacheMeta.uid,
          username: this.cacheMeta.title,
          avatar: this.cacheMeta.avatar,
        }
      })
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting publish...')
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (!this.cacheMeta) {
          const ok = await this.refreshMetaInner()
          if (!ok) {
            throw new Error('请先登录大鱼号')
          }
        }

        let content = article.html || ''
        content = prepareHtmlForDayu(content)
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            onProgress: options?.onImageProgress,
          }
        )

        const formData = new URLSearchParams()
        formData.append('title', article.title)
        formData.append('content', content)
        formData.append('author', this.cacheMeta!.title)
        formData.append('article_type', '1')
        formData.append('utoken', this.cacheMeta!.utoken)
        formData.append('coverImg', '')
        formData.append('cover_from', '')

        const response = await this.runtime.fetch('https://mp.dayu.com/dashboard/save-draft', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            utoken: this.cacheMeta!.utoken,
          },
          body: formData,
        })

        const res = await response.json() as {
          error?: string
          data?: { _id: string }
        }
        logger.debug('Save response:', res)

        if (res.error) {
          throw new Error(res.error)
        }
        if (!res.data?._id) {
          throw new Error('保存草稿失败')
        }

        const postId = res.data._id
        return this.createResult(true, {
          postId,
          postUrl: `https://mp.dayu.com/dashboard/article/write?draft_id=${postId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  /** 在已有 header rules 上下文中刷新登录信息，避免嵌套 withHeaderRules */
  private async refreshMetaInner(): Promise<boolean> {
    const response = await this.runtime.fetch('https://mp.dayu.com/dashboard/index', {
      method: 'GET',
      credentials: 'include',
    })
    const pageHtml = await response.text()
    const markStr = 'var globalConfig = '
    const authIndex = pageHtml.indexOf(markStr)
    if (authIndex === -1) {
      return false
    }

    const authTokenStr = pageHtml.substring(
      authIndex + markStr.length,
      pageHtml.indexOf('var G = {', authIndex)
    )
    const pageConfig = this.parseGlobalConfig(authTokenStr)
    const isLogin = pageConfig?.isLogin === true || pageConfig?.isLogin === 'true'
    const wmid = String(pageConfig?.wmid || '')
    const utoken = String(pageConfig?.utoken || '')
    if (!pageConfig || !utoken || !isLogin || !wmid) {
      return false
    }

    this.cacheMeta = {
      utoken,
      uploadSign: String(pageConfig.nsImageUploadSign || ''),
      uid: wmid,
      title: String(pageConfig.weMediaName || ''),
      avatar: (() => {
        const av = String(pageConfig.wmAvator || '')
        if (!av) return ''
        return av.indexOf('http') > -1 ? av : av.replace('//', 'https://')
      })(),
    }
    return true
  }

  private parseGlobalConfig(configStr: string): Record<string, unknown> | null {
    try {
      let cleaned = configStr.trim()
      if (cleaned.endsWith(';')) {
        cleaned = cleaned.slice(0, -1)
      }
      if (cleaned.startsWith('{')) {
        return JSON.parse(cleaned) as Record<string, unknown>
      }
      const jsonStr = cleaned
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
      return JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      const result: Record<string, unknown> = {}
      const patterns: Record<string, RegExp> = {
        utoken: /utoken['":\s]+['"]([^'"]+)['"]/,
        nsImageUploadSign: /nsImageUploadSign['":\s]+['"]([^'"]+)['"]/,
        wmid: /wmid['":\s]+['"]([^'"]+)['"]/,
        weMediaName: /weMediaName['":\s]+['"]([^'"]+)['"]/,
        wmAvator: /wmAvator['":\s]+['"]([^'"]+)['"]/,
      }
      for (const [key, pattern] of Object.entries(patterns)) {
        const match = configStr.match(pattern)
        if (match) {
          result[key] = match[1]
        }
      }
      const loginMatch = configStr.match(/isLogin['":\s]+(true|false)/)
      if (loginMatch) {
        result.isLogin = loginMatch[1] === 'true'
      }
      return Object.keys(result).length > 0 ? result : null
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.cacheMeta) {
      throw new Error('未登录')
    }

    let imageBlob: Blob
    if (src.startsWith('data:')) {
      imageBlob = await fetch(src).then((r) => r.blob())
    } else {
      const imageResponse = await this.runtime.fetch(src, { credentials: 'include' })
      if (!imageResponse.ok) {
        throw new Error('图片下载失败: ' + src)
      }
      imageBlob = await imageResponse.blob()
    }

    if (!this.cacheMeta.uploadSign) {
      throw new Error('缺少大鱼号上传签名，请重新登录后再试')
    }

    const uploadUrl =
      `https://ns.dayu.com/article/imageUpload?appid=website&fromMaterial=0` +
      `&wmid=${this.cacheMeta.uid}` +
      `&wmname=${encodeURIComponent(this.cacheMeta.title)}` +
      `&sign=${this.cacheMeta.uploadSign}`

    const formData = new FormData()
    const fileName = `${Date.now()}.jpg`
    formData.append('upfile', imageBlob, fileName)
    formData.append('type', imageBlob.type || 'image/jpeg')
    formData.append('id', 'WU_FILE_1')
    formData.append('fileid', `uploadm-${Math.floor(Math.random() * 1000000)}`)
    formData.append('name', fileName)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(imageBlob.size))

    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    const res = await uploadResponse.json() as {
      data?: { imgInfo?: { url?: string } }
      error?: string
      message?: string
    }
    logger.debug('Image upload response:', res)

    let url = res.data?.imgInfo?.url || ''
    if (url.startsWith('//')) {
      url = `https:${url}`
    }
    if (!url) {
      throw new Error(res.error || res.message || '图片上传失败')
    }

    return { url }
  }
}
