import { describe, expect, it } from 'vitest'
import { extractFirstImageUrl, isCnblogsHostedUrl } from '../cnblogs'

describe('cnblogs featuredImage helpers', () => {
  it('isCnblogsHostedUrl accepts cnblogs hosts only', () => {
    expect(isCnblogsHostedUrl('https://img2024.cnblogs.com/blog/1.png')).toBe(true)
    expect(isCnblogsHostedUrl('https://www.cnblogs.com/x.png')).toBe(true)
    expect(isCnblogsHostedUrl('https://s2.51cto.com/a.png')).toBe(false)
    expect(isCnblogsHostedUrl('data:image/png;base64,xx')).toBe(false)
  })

  it('extractFirstImageUrl skips external and returns first cnblogs image', () => {
    const md = [
      '![a](https://example.com/a.png)',
      '![b](https://img2023.cnblogs.com/blog/b.png)',
      '![c](https://img2024.cnblogs.com/blog/c.png)',
    ].join('\n')
    expect(extractFirstImageUrl(md)).toBe('https://img2023.cnblogs.com/blog/b.png')
    expect(extractFirstImageUrl('![x](https://cdn.example.com/x.png)')).toBeUndefined()
  })
})
