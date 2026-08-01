import { describe, expect, it } from 'vitest'
import {
  authFromLoginInfo,
  markdownTableToJsonML,
  markdownToModelscopeJsonML,
  normalizeListLevels,
  parseInline,
} from '../modelscope'

describe('normalizeListLevels', () => {
  it('collapses 0/4 spaces to levels 0/1', () => {
    expect(normalizeListLevels([0, 4, 4, 0])).toEqual([0, 1, 1, 0])
  })

  it('keeps three real depths as 0/1/2', () => {
    expect(normalizeListLevels([0, 2, 4, 0])).toEqual([0, 1, 2, 0])
  })
})

describe('authFromLoginInfo', () => {
  it('returns authenticated user from login/info', () => {
    const result = authFromLoginInfo({
      Code: 200,
      Success: true,
      Data: {
        Name: 'liferecords',
        NickName: 'nick',
        Avatar: 'https://example.com/a.png',
      },
    })
    expect(result).toEqual({
      isAuthenticated: true,
      username: 'liferecords',
      avatar: 'https://example.com/a.png',
    })
  })

  it('returns null when not success', () => {
    expect(authFromLoginInfo({ Code: 400, Success: false })).toBeNull()
    expect(authFromLoginInfo({ Code: 200, Success: true, Data: { Name: '' } })).toBeNull()
    expect(authFromLoginInfo(null)).toBeNull()
  })
})

describe('parseInline', () => {
  it('parses bold and inline code', () => {
    const nodes = parseInline('这是**加粗**和`代码`')
    expect(JSON.stringify(nodes)).toContain('"bold":true')
    expect(JSON.stringify(nodes)).toContain('inlineCode')
    expect(JSON.stringify(nodes)).toContain('代码')
  })
})

describe('markdownToModelscopeJsonML', () => {
  it('converts heading and paragraph', () => {
    const json = markdownToModelscopeJsonML('# 标题一\n\n这是段落')
    const root = JSON.parse(json) as unknown[]
    expect(root[0]).toBe('root')
    expect(JSON.stringify(root)).toContain('标题一')
    expect(JSON.stringify(root)).toContain('这是段落')
    expect(JSON.stringify(root)).toContain('"h3"')
  })

  it('converts image markdown to img node with src', () => {
    const json = markdownToModelscopeJsonML('![alt](https://example.com/a.png)')
    const root = JSON.parse(json) as unknown[]
    expect(JSON.stringify(root)).toContain('"img"')
    expect(JSON.stringify(root)).toContain('https://example.com/a.png')
  })

  it('downgrades mermaid fence to plaintext code block', () => {
    const json = markdownToModelscopeJsonML('```mermaid\nflowchart LR\n  A-->B\n```')
    const root = JSON.parse(json) as unknown[]
    const text = JSON.stringify(root)
    expect(text).toContain('"code"')
    expect(text).toContain('flowchart LR')
    expect(text).not.toContain('"syntax":"mermaid"')
    expect(text).toContain('"syntax":"plaintext"')
  })

  it('downgrades block math to code block', () => {
    const json = markdownToModelscopeJsonML('$$E=mc^2$$')
    const text = JSON.stringify(JSON.parse(json))
    expect(text).toContain('"code"')
    expect(text).toContain('E=mc^2')
  })

  it('converts markdown table to table/tr/tc nodes', () => {
    const md = `| 功能 | 说明 | 状态 |
| --- | --- | --- |
| 表格渲染 | 斑马纹 | ✅ |
| Mermaid | 流程图 | ✅ |`
    const root = JSON.parse(markdownToModelscopeJsonML(md)) as unknown[]
    const text = JSON.stringify(root)
    expect(text).toContain('"table"')
    expect(text).toContain('"tr"')
    expect(text).toContain('"tc"')
    expect(text).toContain('表格渲染')
    expect(text).toContain('isTblHeader')
    expect(text).not.toContain('"syntax":"plaintext","theme":"default","code":"| 功能')
  })

  it('converts nested lists with level and listStyle', () => {
    const md = `- 一级A
  - 二级B
- 一级C

1. 有序1
   1. 有序1.1
2. 有序2`
    const root = JSON.parse(markdownToModelscopeJsonML(md)) as unknown[]
    const items = root.slice(2) as Array<[string, Record<string, unknown>, ...unknown[]]>
    expect(items).toHaveLength(6)

    const u0 = items[0][1]
    const u1 = items[1][1]
    const u2 = items[2][1]
    expect((u0.list as { level: number; isOrdered: boolean }).level).toBe(0)
    expect((u0.list as { isOrdered: boolean }).isOrdered).toBe(false)
    expect((u0.list as { listStyle: { text: string } }).listStyle.text).toBe('●')
    expect((u1.list as { level: number }).level).toBe(1)
    expect((u1.list as { listStyle: { text: string } }).listStyle.text).toBe('○')
    expect(u1.ind).toBeUndefined()
    expect((u2.list as { level: number }).level).toBe(0)
    expect((u0.list as { listId: string }).listId).toBe((u1.list as { listId: string }).listId)

    const o0 = items[3][1]
    const o1 = items[4][1]
    expect((o0.list as { isOrdered: boolean; level: number }).isOrdered).toBe(true)
    expect((o0.list as { listStyle: { format: string } }).listStyle.format).toBe('decimal')
    expect((o1.list as { level: number }).level).toBe(1)
    expect((o1.list as { listStyle: { format: string } }).listStyle.format).toBe('lowerLetter')
    expect(JSON.stringify(root)).not.toContain('• ')
  })

  it('maps 4-space nested list to level 1 (not level 2)', () => {
    const md = `- 一级
    - 二级四空格
- 回到一级`
    const root = JSON.parse(markdownToModelscopeJsonML(md)) as unknown[]
    const items = root.slice(2) as Array<[string, Record<string, unknown>]>
    expect((items[0][1].list as { level: number }).level).toBe(0)
    expect((items[1][1].list as { level: number }).level).toBe(1)
    expect((items[1][1].list as { listStyle: { text: string } }).listStyle.text).toBe('○')
    expect((items[2][1].list as { level: number }).level).toBe(0)
  })

  it('maps tab-indented nested list to level 1', () => {
    const md = `- 第一条\n\t- 第一条缩进\n\t- 第二条缩进\n- 第二条`
    const root = JSON.parse(markdownToModelscopeJsonML(md)) as unknown[]
    const items = root.slice(2) as Array<[string, Record<string, unknown>]>
    expect((items[1][1].list as { level: number }).level).toBe(1)
    expect((items[2][1].list as { level: number }).level).toBe(1)
  })

  it('drops table separator row including :-: and applies center align', () => {
    const md = `| 功能 | 说明 | 状态 |
| ------- | --------------------- | :-: |
| 表格渲染 | 斑马纹 | ✅ |
| Mermaid | 流程图 | ✅ |`
    const root = JSON.parse(markdownToModelscopeJsonML(md)) as unknown[]
    const text = JSON.stringify(root)
    expect(text).toContain('"table"')
    expect(text).not.toContain('-------')
    expect(text).not.toContain(':-:')
    expect(text).toContain('"jc":"center"')
    expect(text).toContain('表格渲染')
    const table = root[2] as unknown[]
    const rows = table.slice(2)
    expect(rows).toHaveLength(3)
  })
})

describe('markdownTableToJsonML', () => {
  it('skips separator row and keeps header flag', () => {
    const node = markdownTableToJsonML([
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ])
    expect(node[0]).toBe('table')
    const rows = node.slice(2) as unknown[][]
    expect(rows).toHaveLength(2)
    expect((rows[0][1] as { isTblHeader?: boolean }).isTblHeader).toBe(true)
    expect(JSON.stringify(rows)).toContain('1')
    expect(JSON.stringify(rows)).not.toContain('---')
  })
})
