/**
 * DOM 预处理页面
 *
 * 当没有可用的 http/https tab 时，Service Worker 创建此页面的临时 tab 做 DOM 预处理。
 * 处理完后 tab 自动关闭。
 */
import { preprocessForPlatform, preprocessContentDOM, type PreprocessResult } from '../lib/content-processor'
import { htmlToMarkdownNative, type PreprocessConfig } from '@mediasync/core'
import { resolvePreprocessRawHtml } from '../lib/sync-message-threshold'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PREPROCESS_FOR_PLATFORMS') {
    const payload = message.payload as {
      rawHtml?: string
      fromStorage?: boolean
      platforms: string[]
      configs: Record<string, PreprocessConfig>
    }

    resolvePreprocessRawHtml(payload).then((rawHtml) => {
      const platformContents: Record<string, PreprocessResult> = {}

      for (const platformId of payload.platforms) {
        const config = payload.configs[platformId]
        if (config) {
          platformContents[platformId] = preprocessForPlatform(rawHtml, config)
        } else {
          const tempDiv = document.createElement('div')
          tempDiv.innerHTML = rawHtml
          preprocessContentDOM(tempDiv)
          const html = tempDiv.innerHTML
          platformContents[platformId] = {
            html,
            markdown: htmlToMarkdownNative(html),
          }
        }
      }

      sendResponse({ platformContents })
    }).catch(() => sendResponse({ platformContents: {} }))
    return true
  }
  return false
})
