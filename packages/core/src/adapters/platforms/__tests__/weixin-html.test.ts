import { describe, expect, it } from 'vitest'
import { normalizeWeixinHtml } from '../weixin-html'

describe('normalizeWeixinHtml', () => {
  it('T1: pulls punctuation inside closing strong', () => {
    expect(normalizeWeixinHtml('文字</strong>。')).toBe('文字。</strong>')
  })

  it('T2: unwraps bare span and keeps punctuation with text', () => {
    expect(normalizeWeixinHtml('<span>链接</span>，后文')).toBe('链接，后文')
  })

  it('T3: collapses whitespace before CJK punctuation', () => {
    expect(normalizeWeixinHtml('字 \n 。')).toBe('字。')
  })

  it('T4: leaves pre internals unchanged', () => {
    const input = '<pre>a  。\nb</pre>'
    expect(normalizeWeixinHtml(input)).toBe(input)
  })

  it('T5: does not pull punctuation after block closing tags', () => {
    expect(normalizeWeixinHtml('</p>。')).toBe('</p>。')
  })

  it('T6: keeps styled span and pulls punctuation inside', () => {
    expect(normalizeWeixinHtml('<span style="color:red">x</span>。')).toBe(
      '<span style="color:red">x。</span>'
    )
  })

  it('T7: wraps tight list item so li does not start with bare strong', () => {
    const input =
      '<ul>\n<li><strong>动机 / 为什么重要</strong>：作者把想法质量定位为下游许多失败（执行漂移、过早成功声明）的<strong>上游瓶颈</strong>——与其说的 <em>ideation patterns</em></li>\n</ul>\n'
    const out = normalizeWeixinHtml(input)
    expect(out).toContain('<li><span style="display: inline;"><strong>动机 / 为什么重要：</strong>')
    expect(out).toContain('<em>ideation patterns</em></span></li>')
    expect(out).not.toMatch(/<li>\s*<strong/)
  })

  it('T8: does not wrap li that contains block elements', () => {
    const input = '<ul><li><p>一段</p></li></ul>'
    expect(normalizeWeixinHtml(input)).toBe(input)
  })
})
