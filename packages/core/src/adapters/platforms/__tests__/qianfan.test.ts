import { describe, expect, it } from 'vitest'
import {
  buildSummary,
  markdownToQianfanNodes,
  nodesToQianfanHtml,
  parseInline,
} from '../qianfan'

describe('markdownToQianfanNodes', () => {
  it('converts heading and paragraph', () => {
    const nodes = markdownToQianfanNodes('# 标题一\n\n这是段落')
    expect(nodes[0]).toMatchObject({ type: 'title' })
    expect(nodes[1]).toMatchObject({
      type: 'heading',
      level: 1,
    })
    expect(nodes[1].children?.[0]).toEqual({ text: '标题一' })
    expect(nodes[2]).toMatchObject({ type: 'paragraph' })
    expect(nodes[2].children?.[0]).toEqual({ text: '这是段落' })
  })

  it('converts strong and inline code', () => {
    const nodes = markdownToQianfanNodes('这是**加粗**和`代码`')
    const inline = nodes[1].children || []
    expect(inline).toEqual([
      { text: '这是' },
      { text: '加粗', bold: true },
      { text: '和' },
      { type: 'inline-code', children: [{ text: '代码' }] },
    ])
  })

  it('converts unordered and ordered lists', () => {
    const nodes = markdownToQianfanNodes('- a\n- b\n\n1. x\n2. y')
    expect(nodes[1]).toMatchObject({
      type: 'unordered-list-item',
      depth: 0,
    })
    expect(nodes[1].children?.[0]).toEqual({ text: 'a' })
    expect(nodes[2].children?.[0]).toEqual({ text: 'b' })

    expect(nodes[3]).toMatchObject({
      type: 'ordered-list-item',
      index: 1,
      initialNumber: 1,
    })
    expect(nodes[4]).toMatchObject({
      type: 'ordered-list-item',
      index: 2,
    })
    expect(nodes[4].children?.[0]).toEqual({ text: 'y' })
  })

  it('sets depth on nested unordered list items', () => {
    const nodes = markdownToQianfanNodes('- a\n  - b\n- c')
    expect(nodes.slice(1, 4).map((n) => n.depth)).toEqual([0, 1, 0])
  })

  it('resets index per depth on nested ordered list', () => {
    const nodes = markdownToQianfanNodes(
      '1. 第一个\n2. 第二个\n3. 第三个\n  1. 第三第一\n  2. 第三第二\n4. 第四个'
    )
    const items = nodes.filter((n) => n.type === 'ordered-list-item')
    expect(
      items.map((it) => ({
        depth: it.depth,
        index: it.index,
        initialNumber: it.initialNumber,
      }))
    ).toEqual([
      { depth: 0, index: 1, initialNumber: 1 },
      { depth: 0, index: 2, initialNumber: undefined },
      { depth: 0, index: 3, initialNumber: undefined },
      { depth: 1, index: 1, initialNumber: undefined },
      { depth: 1, index: 2, initialNumber: undefined },
      { depth: 0, index: 4, initialNumber: undefined },
    ])
  })

  it('converts fenced code to block-code', () => {
    const nodes = markdownToQianfanNodes('```python\nimport os\n```')
    expect(nodes[1]).toMatchObject({
      type: 'block-code',
      language: 'python',
      autowrap: false,
      title: '',
    })
    expect(nodes[1].children?.[0]).toMatchObject({
      type: 'block-code-line',
      children: [{ text: 'import os' }],
    })
  })

  it('converts inline formula', () => {
    const nodes = markdownToQianfanNodes('公式：$y^2=a^2$')
    expect(nodes[1].children).toEqual([
      { text: '公式：' },
      { type: 'inline-formula', formula: 'y^2=a^2', children: [{ text: '' }] },
    ])
  })

  it('converts block formula to centered inline-formula paragraph', () => {
    const nodes = markdownToQianfanNodes('$$E=mc^2$$')
    expect(nodes[1]).toMatchObject({
      type: 'paragraph',
      textAlign: 'center',
    })
    expect(nodes[1].children?.[0]).toEqual({
      type: 'inline-formula',
      formula: 'E=mc^2',
      children: [{ text: '' }],
    })
  })

  it('converts GFM table to table node', () => {
    // 列0最大2字，列1最大10字 → 宽度按列内最大字符数
    const md = '| 短 | 一二三四五六七八九十 |\n| --- | --- |\n| ab | 短文 |'
    const nodes = markdownToQianfanNodes(md)
    const table = nodes[1]
    expect(table.type).toBe('table')
    const widths = (table.data as { width?: number[] })?.width || []
    expect(widths.length).toBe(2)
    // maxChars=[2,10] → 2*14+28=56→min80, 10*14+28=168
    expect(widths[0]).toBe(80)
    expect(widths[1]).toBe(168)
    expect(widths[1]).toBeGreaterThan(widths[0])
  })

  it('converts image to image node', () => {
    const nodes = markdownToQianfanNodes('![图](https://example.com/a.png)')
    expect(nodes[1]).toMatchObject({
      type: 'image',
      src: 'https://example.com/a.png',
      caption: '图',
    })
  })

  it('converts link to link node', () => {
    const nodes = markdownToQianfanNodes('[访问](https://qianfan.cloud.baidu.com/)')
    expect(nodes[1].children?.[0]).toEqual({
      type: 'link',
      href: 'https://qianfan.cloud.baidu.com/',
      title: 'https://qianfan.cloud.baidu.com/',
      children: [{ text: '访问' }],
    })
  })
})

describe('parseInline', () => {
  it('parses bold text', () => {
    expect(parseInline('**粗**')).toEqual([{ text: '粗', bold: true }])
  })

  it('parses inline formula', () => {
    expect(parseInline('$a^2$')).toEqual([
      { type: 'inline-formula', formula: 'a^2', children: [{ text: '' }] },
    ])
  })
})

describe('nodesToQianfanHtml', () => {
  it('renders heading and paragraph', () => {
    const html = nodesToQianfanHtml([
      { type: 'title', children: [{ text: '' }] },
      { type: 'heading', level: 2, children: [{ text: '标题' }] },
      { type: 'paragraph', children: [{ text: '段落' }] },
    ])
    expect(html).toContain('<h2>')
    expect(html).toContain('标题')
    expect(html).toContain('<div><span>段落</span></div>')
  })

  it('renders block-code table and formula', () => {
    const html = nodesToQianfanHtml([
      {
        type: 'block-code',
        language: 'python',
        children: [{ type: 'block-code-line', children: [{ text: 'import os' }] }],
      },
      {
        type: 'table',
        children: [
          {
            type: 'table-row',
            children: [
              {
                type: 'table-cell',
                children: [{ type: 'paragraph', children: [{ text: 'a' }] }],
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        children: [{ type: 'inline-formula', formula: 'x^2', children: [{ text: '' }] }],
      },
    ])
    expect(html).toContain('<pre')
    expect(html).toContain('<table>')
    expect(html).toContain('data-formula-value')
  })
})

describe('buildSummary', () => {
  it('takes first plain paragraph', () => {
    expect(buildSummary('# 题\n\n你好世界\n\n第二段', 4)).toBe('题 你好')
  })
})
