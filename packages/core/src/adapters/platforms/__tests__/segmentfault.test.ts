import { describe, expect, it } from 'vitest'
import { SegmentfaultAdapter } from '../segmentfault'

function callNormalize(markdown: string): string {
  const adapter = new SegmentfaultAdapter()
  const normalize = (
    adapter as unknown as { normalizeMarkdownForSegmentfault(md: string): string }
  ).normalizeMarkdownForSegmentfault.bind(adapter)
  return normalize(markdown)
}

describe('SegmentfaultAdapter.normalizeMarkdownForSegmentfault', () => {
  it('unescapes backslashes in block formulas', () => {
    const input = '$$\\\\frac{a}{b}$$'
    const result = callNormalize(input)
    expect(result).toBe('$$\\frac{a}{b}$$')
    expect(result).not.toContain('\\\\frac')
  })

  it('converts inline $...$ to \\\\(...\\\\) and unescapes body', () => {
    const input = '行内 $a\\\\^2$ 公式'
    const result = callNormalize(input)
    expect(result).toBe('行内 \\\\(a\\^2\\\\) 公式')
  })

  it('converts plain inline formula to \\\\(...\\\\)', () => {
    const input = '$c^2=a^2+b^2$'
    const result = callNormalize(input)
    expect(result).toBe('\\\\(c^2=a^2+b^2\\\\)')
  })

  it('normalizes table separator to compact |---|', () => {
    const input = ['| A | B |', '| :---: | ---: |', '| 1 | 2 |'].join('\n')
    const result = callNormalize(input)
    const lines = result.split('\n')
    expect(lines[1]).toBe('|---|---|')
    expect(lines[0]).toBe('| A | B |')
    expect(lines[2]).toBe('| 1 | 2 |')
  })

  it('preserves code blocks without normalizing formulas or tables', () => {
    const input = ['```', '$$\\\\frac{a}{b}$$', '| --- | --- |', '```'].join('\n')
    const result = callNormalize(input)
    expect(result).toContain('$$\\\\frac{a}{b}$$')
    expect(result).toContain('| --- | --- |')
  })
})
