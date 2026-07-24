/**
 * 一点号适配器
 *
 * 现代 SPA 后台（#/Home）不再注入 window.mpuser / #__val_。
 * - 鉴权 / 发文 / 转存图片：优先 Service Worker fetch（Header 规则补 Origin/Referer）
 * - SW 失败时再落到页面上下文（pageFetchJson），并清理临时标签
 * - 正文：弱编辑器兼容（代码块 / 行内 code），保留标题列表与图片
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { prepareHtmlForYidian } from '../../lib/weak-editor-html'

const logger = createLogger('Yidian')

interface YidianSession {
  mediaId: string
  username?: string
}

interface YidianArticleResponse {
  id?: string | number
  status?: string
  errorCode?: number
  reason?: string
  message?: string
}

/**
 * 解析一点号上传响应。
 * 成功时常见形态：
 * 1) JSON：{ status:'success', url:'...' }
 * 2) iframe 脚本：... $triggerEvent('image-upload', {"status":"success","url":"..."}, ...)
 */
export function parseYidianUploadResponse(text: string): string | null {
  const trimmed = (text || '').trim()
  if (!trimmed) return null

  // iframe/script 包裹的 JSON
  const eventMatch = trimmed.match(
    /\$triggerEvent\(\s*['"]image-upload['"]\s*,\s*(\{[\s\S]*?\})\s*,/
  )
  const jsonCandidate = eventMatch?.[1] || trimmed

  try {
    const data = JSON.parse(jsonCandidate) as Record<string, unknown>
    if (data.status && String(data.status) !== 'success') {
      return null
    }
    if (typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
      return data.url
    }
    if (typeof data.inner_addr === 'string' && /^https?:\/\//i.test(data.inner_addr)) {
      return data.inner_addr
    }
  } catch {
    // fall through
  }

  const urlMatch = trimmed.match(/"url"\s*:\s*"(https?:[^"]+)"/i)
  if (urlMatch?.[1] && /"status"\s*:\s*"success"/i.test(trimmed)) {
    return urlMatch[1]
  }

  return null
}

export class YidianAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'yidian',
    name: '一点号',
    icon: 'https://www.yidianzixun.com/favicon.ico',
    homepage: 'https://mp.yidianzixun.com/#/Writing/articleEditor',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    processCodeBlocks: true,
    compactHtml: true,
    // 一点号富文本编辑器不支持 <table>，会把每个单元格拆成带圆点的单行；
    // 预处理阶段把表格转成「列名: 值 | 列名: 值」的纯文本段落
    convertTablesToText: true,
  }

  private readonly PAGE = {
    pattern: 'https://mp.yidianzixun.com/*',
    url: 'https://mp.yidianzixun.com/#/Home',
  }

  private readonly HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: '*://mp.yidianzixun.com/*',
      headers: {
        Origin: 'https://mp.yidianzixun.com',
        Referer: 'https://mp.yidianzixun.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private readonly JSON_HEADERS = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const session = await this.loadSessionViaFetch()
      if (!session?.mediaId) {
        return {
          isAuthenticated: false,
          error: '未登录一点号自媒体，请先在浏览器打开 mp.yidianzixun.com 并登录写作后台',
        }
      }

      return {
        isAuthenticated: true,
        userId: session.mediaId,
        username: session.username || `一点号 ${session.mediaId}`,
      }
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting publish...')

      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const session = await this.loadSession()
        if (!session?.mediaId) {
          throw new Error(
            '一点号未登录自媒体账号。请先在浏览器打开并登录 https://mp.yidianzixun.com 写作后台（仅打开官网不够）'
          )
        }

        let content = article.html || ''
        // 仅做弱编辑器兼容：代码块换行、行内 code→加粗、压缩源码空白；保留标题/列表/图片
        content = prepareHtmlForYidian(content)
        // processImages 只匹配双引号 src；统一成双引号以免漏传 data URI
        content = content.replace(/<img\b([^>]*?)\bsrc\s*=\s*'([^']*)'/gi, '<img$1src="$2"')
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['yidianzixun.com', 'yidian.com'],
            onProgress: options?.onImageProgress,
            // 一点号 getImageFromUrl 为服务端同步抓取外链图，单图偏慢；
            // 串行会让 20 张外链图拖到 10 分钟以上，故启用并发
            concurrency: 4,
          }
        )
        // 一点号禁止正文残留 base64：会撑爆 post_covers
        this.assertNoDataUriImages(content)

        // 对齐 legacy：空封面数组，避免服务端把正文长图 URL 拼进 post_covers
        const payload = this.buildArticlePayload(article.title, content)
        const res = await this.saveArticle(payload)

        if (!res.id) {
          const reason = res.reason || res.message || JSON.stringify(res)
          throw new Error(this.formatPublishError(res.errorCode, reason))
        }

        const postId = String(res.id)
        return this.createResult(true, {
          postId,
          postUrl: `https://mp.yidianzixun.com/#/Writing/${postId}`,
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

  /** 与 legacy YiDian.js 字段对齐，封面强制为空数组 */
  private buildArticlePayload(title: string, content: string): Record<string, unknown> {
    return {
      title,
      content,
      cate: '',
      cateB: '',
      coverType: 'default',
      covers: [],
      hasSubTitle: 0,
      subTitle: '',
      original: 0,
      reward: 0,
      videos: [],
      audios: [],
      votes: {
        vote_id: '',
        vote_options: [],
        vote_end_time: '',
        vote_title: '',
        vote_type: 1,
        isAdded: false,
      },
      images: [],
      goods: [],
      is_mobile: 0,
      status: 0,
      import_url: '',
      import_hash: '',
      image_urls: {},
      minTimingHour: 3,
      maxTimingDay: 7,
      tags: [],
      isPubed: false,
      lastSaveTime: '',
      dirty: false,
      editorType: 'articleEditor',
      activity_id: 0,
      join_activity: 0,
      notSaveToStore: true,
      document_type: 0,
      category: [],
      articles: [],
    }
  }

  /** 发文：SW JSON POST → 失败再页面上下文 */
  private async saveArticle(payload: Record<string, unknown>): Promise<YidianArticleResponse> {
    try {
      const res = await this.postJson<YidianArticleResponse>(
        'https://mp.yidianzixun.com/model/Article',
        payload,
        this.JSON_HEADERS
      )
      if (res && (res.id != null || res.errorCode != null || res.reason || res.status)) {
        logger.info('Article saved via SW')
        return res
      }
      logger.warn('SW article response unexpected, fallback to page:', res)
    } catch (error) {
      logger.warn('SW article save failed, fallback to page:', error)
    }

    return this.pageFetchJson<YidianArticleResponse>(
      this.PAGE.pattern,
      this.PAGE.url,
      'https://mp.yidianzixun.com/model/Article',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.JSON_HEADERS,
        },
        body: JSON.stringify(payload),
      }
    )
  }

  /**
   * 同步前图床 / Blob 上传入口。
   * 注意：基类默认会把 Blob 再转成 data URI，一点号禁止这么做。
   */
  async uploadImage(file: Blob, filename = 'image.png'): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const result = await this.uploadImageBlob(file, filename)
      return result.url
    })
  }

  /**
   * 图片转存：
   * - http(s) → GET /api/getImageFromUrl（已验证）
   * - data URI → 解码为 Blob 后走 /upload multipart（已验证，绝不把 base64 写入正文）
   */
  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (src.startsWith('data:')) {
      const blob = await this.dataUriToBlob(src)
      const subtype = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
      return this.uploadImageBlob(blob, `${Date.now()}.${subtype}`)
    }
    if (!/^https?:\/\//i.test(src)) {
      throw new Error(`一点号仅支持 http(s) 或本地图片上传: ${src.slice(0, 80)}`)
    }

    const apiUrl = `https://mp.yidianzixun.com/api/getImageFromUrl?src=${encodeURIComponent(src)}`

    try {
      const res = await this.get<{
        status?: string
        inner_addr?: string
        reason?: string
        message?: string
      }>(apiUrl, this.JSON_HEADERS)

      if (res.status === 'success' && res.inner_addr) {
        return { url: res.inner_addr }
      }
      throw new Error(res.reason || res.message || 'getImageFromUrl 失败')
    } catch (swError) {
      logger.warn('SW getImageFromUrl failed, try page:', src.slice(0, 80), swError)
    }

    const res = await this.pageFetchJson<{
      status?: string
      inner_addr?: string
      reason?: string
      message?: string
    }>(this.PAGE.pattern, this.PAGE.url, apiUrl, {
      method: 'GET',
      headers: this.JSON_HEADERS,
    })

    if (res.status !== 'success' || !res.inner_addr) {
      throw new Error(res.reason || res.message || `图片转存失败: ${src.slice(0, 80)}`)
    }
    return { url: res.inner_addr }
  }

  /**
   * 本地/解码图片上传。
   * 实测可用：
   * - POST /upload?action=uploadimage&picType=wemedia_cnt&id=...（纯 JSON，优先）
   * - 带 event=image-upload 时多为 iframe 脚本包裹同一 JSON
   * 字段 upfile。过小/无效图可能返回 status=failed。
   */
  private async uploadImageBlob(file: Blob, filename: string): Promise<ImageUploadResult> {
    const id = `ms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const uploadUrls = [
      `https://mp.yidianzixun.com/upload?action=uploadimage&picType=wemedia_cnt&id=${encodeURIComponent(id)}`,
      `https://mp.yidianzixun.com/upload?event=image-upload&action=uploadimage&picType=wemedia_cnt&id=${encodeURIComponent(id)}`,
    ]

    let lastError: Error | null = null
    for (const uploadUrl of uploadUrls) {
      const formData = new FormData()
      formData.append('upfile', file, filename)
      try {
        const response = await this.runtime.fetch(uploadUrl, {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })
        const text = await response.text()
        const url = parseYidianUploadResponse(text)
        if (url) {
          logger.info('Image uploaded via /upload multipart')
          return { url }
        }
        lastError = new Error(`上传响应异常 HTTP ${response.status}: ${text.slice(0, 160)}`)
      } catch (swError) {
        lastError = swError as Error
        logger.warn('SW multipart upload failed:', uploadUrl, swError)
      }
    }

    try {
      return await this.uploadImageBlobInPage(file, filename, uploadUrls[0])
    } catch (pageError) {
      throw lastError || pageError
    }
  }

  private async uploadImageBlobInPage(
    file: Blob,
    filename: string,
    uploadUrl: string
  ): Promise<ImageUploadResult> {
    if (!this.runtime.tabs) {
      throw new Error('一点号本地图片上传失败：无可用页面上下文')
    }

    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
    const mime = file.type || 'image/png'
    const tabId = await this.ensurePageTab(this.PAGE.pattern, this.PAGE.url)
    // 页面内用相对路径，避免跨域
    const relativeUrl = uploadUrl.replace('https://mp.yidianzixun.com', '')

    const result = await this.runtime.tabs.executeScript(
      tabId,
      async (
        byteArr: number[],
        mimeType: string,
        name: string,
        path: string,
        timeoutMs: number
      ) => {
        try {
          const blob = new Blob([new Uint8Array(byteArr)], { type: mimeType })
          const form = new FormData()
          form.append('upfile', blob, name)
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
          let response: Response
          try {
            response = await fetch(path, {
              method: 'POST',
              credentials: 'include',
              body: form,
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timeoutId)
          }
          return { ok: response.ok, status: response.status, text: await response.text() }
        } catch (error) {
          const err = error as Error
          const msg =
            err?.name === 'AbortError'
              ? `页面上传超时（${Math.round(timeoutMs / 1000)}秒）`
              : err.message
          return { ok: false, status: 0, text: '', error: msg }
        }
      },
      [bytes, mime, filename, relativeUrl, 60000] as [number[], string, string, string, number]
    )

    if (!result || result.error) {
      throw new Error(result?.error || '页面上传失败')
    }
    const url = parseYidianUploadResponse(result.text || '')
    if (!url) {
      throw new Error(`页面上传响应无法解析: ${(result.text || '').slice(0, 160)}`)
    }
    return { url }
  }

  /** 发文前兜底：禁止把 data URI 留给一点号 */
  private assertNoDataUriImages(content: string): void {
    if (/data:image\//i.test(content) || /src=["']data:/i.test(content)) {
      throw new Error(
        '正文仍含 base64 图片，一点号禁止提交。本地图需先上传为短链；请确认已登录一点号写作后台后重试'
      )
    }
  }

  private async loadSession(): Promise<YidianSession | null> {
    const viaFetch = await this.loadSessionViaFetch()
    if (viaFetch?.mediaId) return viaFetch

    if (this.runtime.tabs) {
      try {
        return await this.loadSessionInPage()
      } catch (error) {
        logger.warn('page session probe failed:', error)
      }
    }
    return null
  }

  private async loadSessionViaFetch(): Promise<YidianSession | null> {
    try {
      const res = await this.get<{
        status?: string
        result?: { mediaId?: number | string } | null
      }>('https://mp.yidianzixun.com/api/new-user-task-info', this.JSON_HEADERS)

      const mediaId = res.result?.mediaId
      if (res.status === 'success' && mediaId != null && String(mediaId)) {
        return { mediaId: String(mediaId) }
      }
    } catch (error) {
      logger.warn('SW session fetch failed:', error)
    }
    return null
  }

  private async loadSessionInPage(): Promise<YidianSession | null> {
    if (!this.runtime.tabs) return null

    const tabId = await this.ensurePageTab(this.PAGE.pattern, this.PAGE.url)

    return this.runtime.tabs.executeScript(
      tabId,
      async () => {
        try {
          const response = await fetch('/api/new-user-task-info', {
            credentials: 'include',
            headers: {
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
          })
          const data = (await response.json()) as {
            status?: string
            result?: { mediaId?: number | string } | null
          }
          const mediaId = data.result?.mediaId
          if (data.status !== 'success' || mediaId == null || !String(mediaId)) {
            return null
          }

          const text = document.body?.innerText || ''
          const nameMatch = text.match(/发布\s*\n?\s*([\w\u4e00-\u9fa5]{2,20})\s*\d/)
          return {
            mediaId: String(mediaId),
            username: nameMatch?.[1],
          }
        } catch {
          return null
        }
      },
      [] as []
    )
  }

  private formatPublishError(errorCode: number | undefined, reason: string): string {
    const text = reason || ''
    if (/post_covers|Data too long|DataTruncation/i.test(text)) {
      return (
        '一点号保存失败：封面字段 post_covers 过长。' +
        '已使用空封面并转存图片；若仍失败请减少正文图数量或缩短外链。' +
        (errorCode != null ? `(${errorCode})` : '')
      )
    }
    if (errorCode === 299) {
      return (
        `一点号保存失败(299)：${text.slice(0, 240) || '自媒体信息异常'}。` +
        '若写作台可正常打开，多半不是 Cookie 问题；请根据详情排查。'
      )
    }
    return `同步失败: ${text}`
  }
}
