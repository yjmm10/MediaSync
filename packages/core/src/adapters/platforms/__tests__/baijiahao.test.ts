import { describe, expect, it } from 'vitest'
import { BaijiahaoAdapter } from '../baijiahao'

function callTransformContent(html: string): string {
  const adapter = new BaijiahaoAdapter()
  const transformContent = (
    adapter as unknown as { transformContent(content: string): string }
  ).transformContent.bind(adapter)
  return transformContent(html)
}

describe('BaijiahaoAdapter', () => {
  it('normalizes language-js / data-lang=js to data-lang=javascript without nested code', () => {
    const html = [
      '<pre><code class="language-js">const x = 1;</code></pre>',
      '<pre data-lang="js">const y = 2;</pre>',
      '<pre class="language-js" data-lang="js">const z = 3;</pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toContain('<pre data-lang="javascript">const x = 1;</pre>')
    expect(result).toContain('<pre data-lang="javascript">const y = 2;</pre>')
    expect(result).toContain('<pre data-lang="javascript">const z = 3;</pre>')
    expect(result).not.toMatch(/<pre[^>]*>\s*<code/i)
  })

  it('keeps python and maps csharp aliases to dotnet', () => {
    const html = [
      '<pre><code class="language-python">print(1)</code></pre>',
      '<pre data-lang="csharp">Console.Write(1);</pre>',
      '<pre data-lang="c#">Console.Write(2);</pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toContain('<pre data-lang="python">print(1)</pre>')
    expect(result).toContain('<pre data-lang="dotnet">Console.Write(1);</pre>')
    expect(result).toContain('<pre data-lang="dotnet">Console.Write(2);</pre>')
  })

  it('maps unknown languages and mermaid to string (Plain Text)', () => {
    const html = [
      '<pre><code class="language-typescript">type T = 1;</code></pre>',
      '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>',
      '<pre><code>no lang</code></pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toContain('<pre data-lang="string">type T = 1;</pre>')
    expect(result).toContain('<pre data-lang="string">graph TD; A-->B;</pre>')
    expect(result).toContain('<pre data-lang="string">no lang</pre>')
  })

  it('leaves latex dollars unchanged (formula not supported yet)', () => {
    const html = [
      '<p>行内 $c^2=a^2+b^2$ 公式</p>',
      '<p>$$x^2 + y^2$$</p>',
      '<pre data-lang="js">const s = "$keep$";</pre>',
    ].join('')

    const result = callTransformContent(html)

    expect(result).toContain('$c^2=a^2+b^2$')
    expect(result).toContain('$$x^2 + y^2$$')
    expect(result).toContain('<pre data-lang="javascript">const s = "$keep$";</pre>')
    expect(result).not.toContain('data-bjh-formula')
  })
})
