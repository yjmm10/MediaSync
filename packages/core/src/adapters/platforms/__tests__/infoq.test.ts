import { describe, expect, it } from 'vitest'
import { markdownToInfoqDoc } from '../infoq'

describe('markdownToInfoqDoc', () => {
  it('converts heading and paragraph', () => {
    const doc = markdownToInfoqDoc('# 标题一\n\n这是段落')
    expect(doc.type).toBe('doc')
    expect(doc.content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 1, align: null },
    })
    expect(doc.content?.[0].content?.[0]).toEqual({ type: 'text', text: '标题一' })
    expect(doc.content?.[1]).toMatchObject({
      type: 'paragraph',
      attrs: { indent: 0, number: 0, align: null, origin: null },
    })
    expect(doc.content?.[1].content?.[0]).toEqual({ type: 'text', text: '这是段落' })
  })

  it('converts strong and inline code', () => {
    const doc = markdownToInfoqDoc('这是**加粗**和`代码`')
    const inline = doc.content?.[0].content || []
    expect(inline).toEqual([
      { type: 'text', text: '这是' },
      { type: 'text', text: '加粗', marks: [{ type: 'strong' }] },
      { type: 'text', text: '和' },
      { type: 'codeinline', content: [{ type: 'text', text: '代码' }] },
    ])
  })

  it('converts fenced code block', () => {
    const doc = markdownToInfoqDoc('```js\nconsole.log(1)\n```')
    expect(doc.content?.[0]).toEqual({
      type: 'codeblock',
      attrs: { lang: 'js' },
      content: [{ type: 'text', text: 'console.log(1)' }],
    })
  })

  it('converts unordered and ordered lists', () => {
    const doc = markdownToInfoqDoc('- a\n- b\n\n1. x\n2. y')
    expect(doc.content?.[0].type).toBe('bulletedlist')
    expect(doc.content?.[0].content?.[0]).toMatchObject({
      type: 'listitem',
      attrs: { listStyle: null },
    })
    expect(doc.content?.[0].content?.[0].content?.[0].content?.[0]).toEqual({
      type: 'text',
      text: 'a',
    })

    expect(doc.content?.[1].type).toBe('numberedlist')
    expect(doc.content?.[1].attrs).toEqual({ start: 1, normalizeStart: 1 })
    expect(doc.content?.[1].content?.[1].content?.[0].attrs?.number).toBe(2)
    expect(doc.content?.[1].content?.[1].content?.[0].content?.[0]).toEqual({
      type: 'text',
      text: 'y',
    })
  })

  it('sets indent on nested unordered list items', () => {
    const doc = markdownToInfoqDoc(
      '- 第一条\n  - 第一条缩进\n    - 第二条缩进\n- 第二条'
    )
    const items = doc.content?.[0].content || []
    expect(doc.content?.[0].type).toBe('bulletedlist')
    expect(items.map((it) => it.content?.[0].attrs?.indent)).toEqual([0, 1, 2, 0])
    expect(items.map((it) => it.content?.[0].content?.[0])).toEqual([
      { type: 'text', text: '第一条' },
      { type: 'text', text: '第一条缩进' },
      { type: 'text', text: '第二条缩进' },
      { type: 'text', text: '第二条' },
    ])
  })

  it('resets number per indent on nested ordered list', () => {
    const doc = markdownToInfoqDoc(
      '1. 第一个\n2. 第二个\n3. 第三个\n  1. 第三第一\n  2. 第三第二\n4. 第四个'
    )
    const items = doc.content?.[0].content || []
    expect(doc.content?.[0].type).toBe('numberedlist')
    expect(
      items.map((it) => ({
        indent: it.content?.[0].attrs?.indent,
        number: it.content?.[0].attrs?.number,
      }))
    ).toEqual([
      { indent: 0, number: 1 },
      { indent: 0, number: 2 },
      { indent: 0, number: 3 },
      { indent: 1, number: 1 },
      { indent: 1, number: 2 },
      { indent: 0, number: 4 },
    ])
  })

  it('converts GFM table to embedcomp', () => {
    const md =
      '| 功能 | 说明 | 状态 |\n| --- | --- | --- |\n| 表格渲染 | 自动斑马纹 | ✅ |\n| Mermaid | 流程图 | ✅ |'
    const doc = markdownToInfoqDoc(md)
    const node = doc.content?.[0]
    expect(node?.type).toBe('embedcomp')
    expect(node?.attrs?.type).toBe('table')
    const html = (node?.attrs?.data as { content?: string } | undefined)?.content || ''
    expect(html).toContain('<table>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th>功能</th>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('<td>表格渲染</td>')
    expect(html).not.toContain('|---')
    expect(html).not.toContain('---|')
  })

  it('converts table without separator to embedcomp tbody only', () => {
    const doc = markdownToInfoqDoc('| a | b |\n| c | d |')
    const node = doc.content?.[0]
    expect(node?.type).toBe('embedcomp')
    const html = (node?.attrs?.data as { content?: string } | undefined)?.content || ''
    expect(html).toContain('<tbody>')
    expect(html).not.toContain('<thead>')
    expect(html).toContain('<td>a</td>')
    expect(html).toContain('<td>c</td>')
  })

  it('converts image to image node', () => {
    const doc = markdownToInfoqDoc('![图](https://example.com/a.png)')
    expect(doc.content?.[0]).toMatchObject({
      type: 'image',
      attrs: {
        src: 'https://example.com/a.png',
        alt: '图',
      },
    })
  })

  it('converts link to link node', () => {
    const doc = markdownToInfoqDoc('[访问](https://xie.infoq.cn/)')
    expect(doc.content?.[0].content?.[0]).toEqual({
      type: 'link',
      attrs: { href: 'https://xie.infoq.cn/', title: '', type: null },
      content: [{ type: 'text', text: '访问' }],
    })
  })

  it('converts block katex', () => {
    const doc = markdownToInfoqDoc('$$E=mc^2$$')
    expect(doc.content?.[0]).toEqual({
      type: 'katexblock',
      attrs: { mathString: 'E=mc^2' },
    })
  })
})
