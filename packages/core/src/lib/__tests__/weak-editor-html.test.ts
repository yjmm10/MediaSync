import { describe, expect, it } from 'vitest'
import { markdownToHtml } from '../turndown'
import {
  formatCodeBlocksForWeakEditor,
  inlineCodeToBoldForWeakEditor,
  prepareHtmlForWeakEditor,
  prepareHtmlForYidian,
  prepareHtmlForNetease,
} from '../weak-editor-html'

describe('weak-editor-html', () => {
  it('converts pre/code newlines to br with monospace style', () => {
    const html = '<p>intro</p><pre><code>line1\nline2\n  indented</code></pre><p>end</p>'
    const out = formatCodeBlocksForWeakEditor(html)
    expect(out).not.toMatch(/<pre\b/i)
    expect(out).toContain('<br>')
    expect(out).toContain('line1')
    expect(out).toContain('line2')
    expect(out).toContain('&nbsp;&nbsp;indented')
    expect(out).toContain('font-family:Consolas')
    expect(out).not.toContain('<br>\n')
  })

  it('converts inline code to bold', () => {
    const out = inlineCodeToBoldForWeakEditor('use <code>venv</code> please')
    expect(out).toBe('use <strong>venv</strong> please')
    expect(out).not.toMatch(/<code\b/i)
  })

  it('keeps snake_case identifiers inline as bold (netease regression)', () => {
    const md =
      '提取 8 个基础字段——`innovation_approach`（一句话策略）、`key_step`（诊断步）、`abstract_strategy` 等'
    const html = markdownToHtml(md)
    const prepared = prepareHtmlForWeakEditor(html)

    expect(prepared).toContain('<strong>innovation_approach</strong>（一句话策略）')
    expect(prepared).toContain('<strong>key_step</strong>（诊断步）')
    expect(prepared).toContain('<strong>abstract_strategy</strong>')
    expect(prepared).not.toMatch(/<code\b/i)
    expect(prepared).toMatch(/<strong>innovation_approach<\/strong>（一句话策略）/)
  })

  it('yidian keeps headings/lists, only weak-editor + compact whitespace', () => {
    const md = [
      '## Title',
      '',
      '> quote text',
      '',
      '- item a',
      '- item b',
      '',
      '```',
      'line1',
      'line2',
      '```',
      '',
      '用 `foo_bar` 结束',
    ].join('\n')

    const prepared = prepareHtmlForYidian(markdownToHtml(md))
    // 结构贴近 Markdown：保留标题/列表/引用
    expect(prepared).toMatch(/<h2\b/i)
    expect(prepared).toMatch(/<(ul|ol|li)\b/i)
    expect(prepared).toMatch(/<blockquote\b/i)
    expect(prepared).toContain('Title')
    expect(prepared).toContain('item a')
    // 弱编辑器：code → 加粗 / pre → br 块
    expect(prepared).not.toMatch(/<code\b/i)
    expect(prepared).not.toMatch(/<pre\b/i)
    expect(prepared).toContain('<strong>foo_bar</strong>')
    expect(prepared).toContain('line1<br>line2')
    expect(prepared.includes('\n')).toBe(false)
  })

  it('netease demotes headings in place (no toc extraction)', () => {
    const md = [
      '# 阅读笔记：ResearchStudio-Idea',
      '',
      '## TL;DR',
      '',
      '摘要内容在这里。',
      '',
      '## 1. 研究内容',
      '',
      '### 1.1 研究问题、痛点与动机',
      '',
      '正文段落。',
      '',
      '## 2. 方法概要',
      '',
      '方法说明。',
    ].join('\n')

    const html = markdownToHtml(md)
    expect(html).toMatch(/<h1[\s\S]*阅读笔记/)
    expect(html).toMatch(/<h2[\s\S]*TL;DR/)

    const prepared = prepareHtmlForNetease(html)
    expect(prepared).not.toMatch(/<h[1-6]\b/i)
    // 标题仍按原文顺序出现在对应位置附近，而不是全部粘在开头
    const tldrAt = prepared.indexOf('TL;DR')
    const bodyAt = prepared.indexOf('摘要内容在这里')
    const h11At = prepared.indexOf('1.1 研究问题')
    const body2At = prepared.indexOf('正文段落')
    expect(tldrAt).toBeGreaterThan(-1)
    expect(bodyAt).toBeGreaterThan(tldrAt)
    expect(h11At).toBeGreaterThan(bodyAt)
    expect(body2At).toBeGreaterThan(h11At)
    expect(prepared).toContain('font-size:22px')
    expect(prepared).toContain('font-size:20px')
  })

  it('preserves multi-line shell blocks from sample markdown', () => {
    const md = [
      '## Windows 安装',
      '',
      '> 针对 **ostris/ai-toolkit**',
      '',
      '```',
      'git clone https://github.com/ostris/ai-toolkit.git',
      'cd ai-toolkit',
      'python -m venv venv',
      '.\\venv\\Scripts\\activate',
      'pip install -r requirements.txt',
      '```',
      '',
      '用 `git clone` 下载',
    ].join('\n')

    const html = markdownToHtml(md)
    expect(html).toMatch(/<pre[\s\S]*<code/)

    const prepared = prepareHtmlForWeakEditor(html)
    expect(prepared).not.toMatch(/<pre\b/i)
    expect(prepared).not.toMatch(/<code\b/i)
    expect(prepared).toContain('<strong>git clone</strong>')
    expect(prepared).toContain('git clone https://github.com/ostris/ai-toolkit.git')
    const blockMatch = prepared.match(/git clone[\s\S]*?requirements\.txt/)
    expect(blockMatch?.[0]).toContain('<br>')
  })

  it('escapes html special chars inside code without eating comparisons', () => {
    const html = '<pre><code>if a < b && c > d</code></pre>'
    const out = formatCodeBlocksForWeakEditor(html)
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
    expect(out).toContain('&amp;&amp;')
    expect(out).toContain('if a &lt; b &amp;&amp; c &gt; d')
  })

  it('adds max-width to images without style', () => {
    const out = prepareHtmlForWeakEditor('<p><img src="https://example.com/a.png"></p>')
    expect(out).toMatch(/style="[^"]*max-width:100%/)
  })
})
