import { describe, expect, it } from 'vitest'
import { parseYidianUploadResponse } from '../yidian'

describe('parseYidianUploadResponse', () => {
  it('parses iframe script success payload', () => {
    const text =
      `<script>parent.$triggerEvent && parent.$triggerEvent('image-upload', ` +
      `{"status":"success","url":"https://i1.go2yd.com/image.php?url=YD_cnt_255_abc","format":"PNG","id":"editor"}, this)</script>`
    expect(parseYidianUploadResponse(text)).toBe(
      'https://i1.go2yd.com/image.php?url=YD_cnt_255_abc'
    )
  })

  it('parses plain JSON success payload', () => {
    expect(
      parseYidianUploadResponse(
        JSON.stringify({
          status: 'success',
          url: 'https://i1.go2yd.com/image.php?url=ok',
        })
      )
    ).toBe('https://i1.go2yd.com/image.php?url=ok')
  })

  it('rejects failed payload', () => {
    const text =
      `<script>parent.$triggerEvent('image-upload', {"status":"failed","message":{},"id":"x"}, this)</script>`
    expect(parseYidianUploadResponse(text)).toBeNull()
  })
})
