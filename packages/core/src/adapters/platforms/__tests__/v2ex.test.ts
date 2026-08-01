import { describe, expect, it } from 'vitest'
import {
  buildPublishForm,
  DEFAULT_NODE,
  parseAuthFromWriteHtml,
  parseOnceFromWriteHtml,
  parseTopicUrlFromPublishResult,
} from '../v2ex'

describe('parseAuthFromWriteHtml', () => {
  it('returns null on signin redirect', () => {
    expect(
      parseAuthFromWriteHtml('<html></html>', 'https://www.v2ex.com/signin?next=%2Fwrite')
    ).toBeNull()
  })

  it('parses memberId and username from write page html', () => {
    const html = `
      <a href="/member/Petrichors" class="top">Petrichors</a>
      <script>const memberId = 552521; const titleElem = $('#topic_title');</script>
    `
    const auth = parseAuthFromWriteHtml(html, 'https://www.v2ex.com/write')
    expect(auth).toEqual({
      isAuthenticated: true,
      userId: '552521',
      username: 'Petrichors',
    })
  })

  it('returns null when no member link', () => {
    expect(
      parseAuthFromWriteHtml(
        '<script>const memberId = 1;</script>',
        'https://www.v2ex.com/write'
      )
    ).toBeNull()
  })
})

describe('parseOnceFromWriteHtml', () => {
  it('extracts once token', () => {
    expect(
      parseOnceFromWriteHtml('<input type="hidden" name="once" id="once" value="87312">')
    ).toBe('87312')
  })
})

describe('buildPublishForm', () => {
  it('uses algorithm node and markdown syntax', () => {
    expect(buildPublishForm('标题', '# body', '123')).toEqual({
      title: '标题',
      content: '# body',
      syntax: 'markdown',
      node_name: DEFAULT_NODE,
      once: '123',
    })
    expect(DEFAULT_NODE).toBe('algorithm')
  })
})

describe('parseTopicUrlFromPublishResult', () => {
  it('parses from final url', () => {
    expect(
      parseTopicUrlFromPublishResult('https://www.v2ex.com/t/123456', '')
    ).toBe('https://www.v2ex.com/t/123456')
  })

  it('parses from html href', () => {
    expect(
      parseTopicUrlFromPublishResult('https://www.v2ex.com/write', '<a href="/t/999">x</a>')
    ).toBe('https://www.v2ex.com/t/999')
  })
})
