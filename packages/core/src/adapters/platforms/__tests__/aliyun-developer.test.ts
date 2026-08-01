import { describe, expect, it } from 'vitest'
import {
  authFromGetUser,
  buildPutDraftBody,
  stripMarkdownImages,
} from '../aliyun-developer'

describe('authFromGetUser', () => {
  it('parses successful getUser payload', () => {
    const auth = authFromGetUser({
      success: true,
      code: '200',
      data: {
        aliyunPK: '123',
        uccId: 'ucc1',
        nickname: 'tester',
        avatar: 'https://example.com/a.png',
      },
    })
    expect(auth).toEqual({
      isAuthenticated: true,
      userId: '123',
      username: 'tester',
      avatar: 'https://example.com/a.png',
    })
  })

  it('returns null when not success', () => {
    expect(authFromGetUser({ success: false, data: { nickname: 'x' } })).toBeNull()
    expect(authFromGetUser(null)).toBeNull()
  })
})

describe('buildPutDraftBody', () => {
  it('only includes title and content', () => {
    const body = buildPutDraftBody('标题', '# 正文')
    expect(body).toEqual({ title: '标题', content: '# 正文' })
    expect(body).not.toHaveProperty('abstractContent')
    expect(body).not.toHaveProperty('productTags')
  })
})

describe('stripMarkdownImages', () => {
  it('removes markdown and html images', () => {
    const md =
      '前\n![a](https://x.com/a.png)\n中<img src="https://x.com/b.png" />\n后'
    expect(stripMarkdownImages(md)).toBe('前\n\n中\n后')
  })
})
