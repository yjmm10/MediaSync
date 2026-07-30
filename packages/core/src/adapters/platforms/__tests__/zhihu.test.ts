import { describe, expect, it } from 'vitest'
import { ZhihuAdapter } from '../zhihu'

function callTransformContent(html: string): string {
  const adapter = new ZhihuAdapter()
  const transformContent = (
    adapter as unknown as { transformContent(content: string): string }
  ).transformContent.bind(adapter)
  return transformContent(html)
}

describe('ZhihuAdapter', () => {
  it('renders markdown latex as Zhihu equation images', () => {
    const html = [
      '<p>行内 $111$ 公式</p>',
      '<p>$$x^2 + y^2$$</p>',
      '<p><img src="https://example.com/a.png"></p>',
      '<pre><code>$keep$</code></pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toContain('https://www.zhihu.com/equation?tex=111')
    expect(result).toContain('eeimg="1"')
    expect(result).toContain('https://www.zhihu.com/equation?tex=x%5E2%20%2B%20y%5E2')
    expect(result).toContain('eeimg="2"')
    expect(result).toContain('<figure><img src="https://example.com/a.png"></figure>')
    expect(result).toContain('<pre lang="text">$keep$</pre>')
    expect(result).not.toMatch(/<figure><img[^>]*eeimg=/)
  })

  it('lifts nested unordered lists to sibling structure', () => {
    const html =
      '<ul><li>第一条<ul><li>第一条缩进</li><li>第二条缩进</li></ul></li><li>第二条</li><li>第三条<ul><li>第三条缩进1</li><li>第三条缩进2</li></ul></li></ul>'

    const result = callTransformContent(html)

    expect(result).not.toMatch(/<li\b[^>]*>(?:(?!<\/li>).)*<ul\b/i)
    expect(result).toContain('</li><ul>')
    expect(result).toContain('<li>第一条</li><ul><li>第一条缩进</li><li>第二条缩进</li></ul><li>第二条</li>')
    expect(result).toContain('<li>第三条</li><ul><li>第三条缩进1</li><li>第三条缩进2</li></ul>')
  })

  it('lifts nested ordered lists to sibling structure', () => {
    const html =
      '<ol><li>第一个</li><li>第二个</li><li>第三个<ol><li>第三第一</li><li>第三第二</li></ol></li><li>第四个</li></ol>'

    const result = callTransformContent(html)

    expect(result).not.toMatch(/<li\b[^>]*>(?:(?!<\/li>).)*<ol\b/i)
    expect(result).toContain('</li><ol>')
    expect(result).toContain(
      '<li>第三个</li><ol><li>第三第一</li><li>第三第二</li></ol><li>第四个</li>'
    )
    // 不应因嵌套被拆成两个独立 ol
    expect(result).not.toMatch(/<\/ol>\s*<ol>/i)
  })

  it('normalizes code blocks to pre lang without nested code', () => {
    const html = [
      '<pre><code class="language-js">const x = 1;</code></pre>',
      '<pre lang="python"><code>print(1)</code></pre>',
      '<pre><code class="hljs language-typescript">type T = 1;</code></pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toContain('<pre lang="js">const x = 1;</pre>')
    expect(result).toContain('<pre lang="python">print(1)</pre>')
    expect(result).toContain('<pre lang="typescript">type T = 1;</pre>')
    expect(result).not.toMatch(/<pre[^>]*>\s*<code/i)
  })

  it('collapses multiline block latex so alt and tex URL have no newlines', () => {
    const html = '<p>$$\n\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$</p><p></p><p><br></p>'

    const result = callTransformContent(html)
    const img = result.match(/<img[^>]*eeimg="2"[^>]*>/i)?.[0] ?? ''

    expect(img).toContain('eeimg="2"')
    expect(img).not.toMatch(/alt="[^"]*\n[^"]*"/)
    expect(img).not.toMatch(/equation\?tex=[^"]*%0A/)
    expect(result).not.toMatch(/<p>(?:\s|<br\s*\/?>)*<\/p>/i)
  })

  it('compacts inter-tag whitespace but preserves pre body newlines', () => {
    const html = [
      '<h2>表格</h2>\n',
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>\n',
      '<ul>\n<li>第一条</li>\n<li>第二条</li>\n</ul>\n',
      '<pre><code class="language-js">const x = 1;\nconst y = 2;</code></pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).not.toMatch(/>\s+</)
    expect(result).toContain('</h2><table')
    expect(result).toContain('<li>第一条</li><li>第二条</li>')
    expect(result).toContain('<pre lang="js">const x = 1;\nconst y = 2;</pre>')
  })
})
