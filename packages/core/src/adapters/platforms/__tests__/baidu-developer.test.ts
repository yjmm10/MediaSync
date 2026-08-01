import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  authFromBaiduDevUser,
  markdownToBaiduDeveloperHtml,
} from '../baidu-developer'

describe('authFromBaiduDevUser', () => {
  it('parses successful user/current', () => {
    const auth = authFromBaiduDevUser({
      success: true,
      result: {
        id: 5935474,
        nickname: 'lucas',
        displayName: '173******03',
        avatar: 'https://example.com/a.jpg',
      },
    })
    expect(auth).toEqual({
      isAuthenticated: true,
      userId: '5935474',
      username: 'lucas',
      avatar: 'https://example.com/a.jpg',
    })
  })

  it('rejects missing id', () => {
    expect(authFromBaiduDevUser({ success: true, result: {} })).toBeNull()
    expect(authFromBaiduDevUser({ success: false, result: { id: 1 } })).toBeNull()
  })
})

describe('markdownToBaiduDeveloperHtml', () => {
  it('converts heading and paragraph', () => {
    const html = markdownToBaiduDeveloperHtml('# 标题一\n\n这是段落')
    expect(html).toContain('<h1>标题一</h1>')
    expect(html).toContain('<p>这是段落</p>')
  })

  it('converts strong and inline code', () => {
    const html = markdownToBaiduDeveloperHtml('这是**加粗**和`代码`')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>代码</code>')
  })

  it('keeps mermaid as code block', () => {
    const html = markdownToBaiduDeveloperHtml('```mermaid\nflowchart LR\n  A --> B\n```')
    expect(html).toContain('data-lang="mermaid"')
    expect(html).toContain('flowchart LR')
  })

  it('keeps block and inline $$ formulas', () => {
    const html = markdownToBaiduDeveloperHtml('行内$$a^2$$\n\n$$\nE=mc^2\n$$')
    expect(html).toContain('$$a^2$$')
    expect(html).toContain('$$E=mc^2$$')
  })

  it('converts GFM table', () => {
    const html = markdownToBaiduDeveloperHtml(
      '| a | b |\n| --- | --- |\n| 1 | 2 |'
    )
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('converts image and link', () => {
    const html = markdownToBaiduDeveloperHtml(
      '![图](https://example.com/a.png)\n\n[访问](https://developer.baidu.com/)'
    )
    expect(html).toContain('<img src="https://example.com/a.png" alt="图"')
    expect(html).toContain('<a href="https://developer.baidu.com/">访问</a>')
  })

  it('handles @test sample structure', () => {
    const mdPath = resolve(__dirname, '../../../../../../test/md2img 示例文档.md')
    let md: string
    try {
      md = readFileSync(mdPath, 'utf8')
    } catch {
      // monorepo 相对路径在部分环境可能不同；用内联片段兜底
      md = [
        '# md2img 示例文档',
        '',
        '| 功能 | 说明 |',
        '| --- | --- |',
        '| 表格 | ok |',
        '',
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
        '行内公式$$c^2=a^2+b^2$$',
        '',
        '$$',
        'E = mc^2',
        '$$',
        '',
        '![doocs](https://cdn-doocs.oss-cn-shenzhen.aliyuncs.com/gh/doocs/md/images/logo-2.png)',
      ].join('\n')
    }
    const html = markdownToBaiduDeveloperHtml(md)
    expect(html).toContain('<table>')
    expect(html).toContain('data-lang="mermaid"')
    expect(html).toMatch(/\$\$c\^2=a\^2\+b\^2\$\$|\$\$[\s\S]*E\s*=\s*mc\^2[\s\S]*\$\$/)
    expect(html).toContain('cdn-doocs.oss-cn-shenzhen.aliyuncs.com')
  })
})
