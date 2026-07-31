import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/lib/local-markdown'

const SAMPLE = `---
title: From FM
cover: ./c.png
---
# From H1

body text
`

describe('parseMarkdown title source', () => {
  it('auto prefers H1 over frontmatter', () => {
    const r = parseMarkdown(SAMPLE, 'file-name', { titleSource: 'auto' })
    expect(r.title).toBe('From H1')
    expect(r.body).toBe('body text')
    expect(r.cover).toBe('./c.png')
  })

  it('frontmatter preference uses FM when present', () => {
    const r = parseMarkdown(SAMPLE, 'file-name', { titleSource: 'frontmatter' })
    expect(r.title).toBe('From FM')
    expect(r.body).toContain('# From H1')
  })

  it('filename preference uses file name', () => {
    const r = parseMarkdown(SAMPLE, 'file-name', { titleSource: 'filename' })
    expect(r.title).toBe('file-name')
    expect(r.body).toContain('# From H1')
  })

  it('falls back when preferred source missing', () => {
    const md = `---\nfoo: 1\n---\n\nonly body\n`
    const r = parseMarkdown(md, 'only-file', { titleSource: 'h1' })
    expect(r.title).toBe('only-file')
  })

  it('defaults to auto when unset', () => {
    const r = parseMarkdown(SAMPLE, 'file-name')
    expect(r.title).toBe('From H1')
  })
})
