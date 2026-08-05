/**
 * 图片缓存（方案 A：同平台去重）
 *
 * 一次同步任务创建一个实例，传给所有平台的 PipelineAdapter。
 * 同一 platformId + src 只上传一次：第二次 getUploadedUrl 命中后直接返回 URL。
 * setUploadedUrl 接受 Promise，让并发请求自动合并为同一次上传。
 *
 * 跨平台字节共享（fetchBlob LRU）留待第二阶段。
 */

/** 缓存条目：已完成的 URL 或进行中的 Promise */
type CacheEntry = string | Promise<string>

/** 图片缓存接口 */
export interface SharedImageCache {
  /**
   * 查询是否已上传
   * @returns 已上传则返回 URL；否则返回 undefined（调用方应执行上传并 setUploadedUrl）
   */
  getUploadedUrl(platformId: string, src: string): Promise<string | undefined>
  /**
   * 登记上传结果
   * @param url 最终 URL，或进行中的 Promise（让并发请求自动合并为同一次上传）
   */
  setUploadedUrl(platformId: string, src: string, url: CacheEntry): void
}

/** 内存实现（同步任务级生命周期） */
class MemoryImageCache implements SharedImageCache {
  private store = new Map<string, CacheEntry>()

  private key(platformId: string, src: string): string {
    return `${platformId}::${src}`
  }

  async getUploadedUrl(platformId: string, src: string): Promise<string | undefined> {
    const entry = this.store.get(this.key(platformId, src))
    if (entry === undefined) return undefined
    try {
      return await entry
    } catch {
      // 上传失败的 Promise 不缓存：清除并返回 undefined，让调用方重试
      this.store.delete(this.key(platformId, src))
      return undefined
    }
  }

  setUploadedUrl(platformId: string, src: string, url: CacheEntry): void {
    this.store.set(this.key(platformId, src), url)
  }
}

/** 创建一个同步任务级的 SharedImageCache 实例 */
export function createSharedImageCache(): SharedImageCache {
  return new MemoryImageCache()
}

/** 空实现（兼容未传缓存的场景，例如独立调用单个适配器） */
export function createNoopImageCache(): SharedImageCache {
  return {
    async getUploadedUrl(): Promise<string | undefined> {
      return undefined
    },
    setUploadedUrl(): void {
      /* noop */
    },
  }
}
