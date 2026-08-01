import { describe, expect, it } from 'vitest'
import { QiehaoAdapter } from '../qiehao'

function callTransformContent(html: string): string {
  const adapter = new QiehaoAdapter()
  const transformContent = (
    adapter as unknown as { transformContent(content: string): string }
  ).transformContent.bind(adapter)
  return transformContent(html)
}

describe('QiehaoAdapter', () => {
  it('converts nested unordered lists to ex-editor nested format', () => {
    const html =
      '<ul><li>第一条<ul><li>第一条缩进</li><li>第二条缩进</li></ul></li><li>第二条</li></ul>'

    const result = callTransformContent(html)

    // 仍为 li 内嵌套，不是兄弟提升
    expect(result).not.toContain('</li><ul')
    expect(result).toMatch(/data-ex-list="ul"/)
    expect(result).toMatch(/classname="ex-list"/)
    expect(result).toMatch(/data-list-style-type="circle"/)
    expect(result).toContain('<p>第一条</p>')
    expect(result).toContain('<p style="text-indent: 2em">第一条缩进</p>')
    expect(result).toContain('<p style="text-indent: 2em">第二条缩进</p>')
    expect(result).toMatch(
      /<li><p>第一条<\/p><ul[^>]*data-ex-list="ul"[^>]*>[\s\S]*第一条缩进[\s\S]*<\/ul><\/li>/
    )
  })

  it('converts nested ordered lists to ex-editor nested format', () => {
    const html =
      '<ol><li>第一个</li><li>第二个<ol><li>第二子项</li></ol></li><li>第三个</li></ol>'

    const result = callTransformContent(html)

    expect(result).not.toContain('</li><ol')
    expect(result).toMatch(/data-ex-list="ol"/)
    expect(result).toContain('<p>第一个</p>')
    expect(result).toContain('<p style="text-indent: 2em">第二子项</p>')
    expect(result).toMatch(
      /<li><p>第二个<\/p><ol[^>]*data-ex-list="ol"[^>]*>[\s\S]*第二子项[\s\S]*<\/ol><\/li>/
    )
  })

  it('does not alter formulas or code blocks', () => {
    const html = [
      '<p>行内 $E=mc^2$</p>',
      '<p>$$x^2+y^2$$</p>',
      '<pre><code class="language-python">print(1)</code></pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toBe(html)
  })
})
