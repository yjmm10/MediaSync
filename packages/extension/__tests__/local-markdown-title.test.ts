import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/lib/local-markdown'
import {
  extractFrontmatterTitle,
  serializeMarkdownWithTitle,
  stripYamlFrontmatter,
} from '../src/lib/article-meta'

const SAMPLE = `---
title: From FM
cover: ./c.png
abstract: A short blurb
tags: [foo, bar]
category: Frontend
---
# From H1

body text
`

describe('parseMarkdown title source', () => {
  it('auto prefers H1 over filename', () => {
    const r = parseMarkdown(SAMPLE, 'file-name', { titleSource: 'auto' })
    expect(r.title).toBe('From H1')
    expect(r.body).toBe('body text')
    expect(r.cover).toBe('./c.png')
    expect(r.summary).toBe('A short blurb')
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

  it('normalizes unknown titleSource to auto (h1 first)', () => {
    const r = parseMarkdown(SAMPLE, 'file-name', {
      titleSource: 'frontmatter' as unknown as 'auto',
    })
    expect(r.title).toBe('From H1')
  })
})

describe('stripYamlFrontmatter', () => {
  it('extracts title cover summary and body', () => {
    const r = stripYamlFrontmatter(SAMPLE)
    expect(extractFrontmatterTitle('title: From FM\n')).toBe('From FM')
    expect(r.title).toBe('From FM')
    expect(r.cover).toBe('./c.png')
    expect(r.summary).toBe('A short blurb')
    expect(r.body.startsWith('---')).toBe(false)
    expect(r.body).not.toContain('abstract:')
  })

  it('maps banner/summary aliases', () => {
    const fm = `---
banner: ./b.png
summary: Hello
---
body
`
    const r = stripYamlFrontmatter(fm)
    expect(r.cover).toBe('./b.png')
    expect(r.summary).toBe('Hello')
    expect(r.body.trim()).toBe('body')
  })

  it('serializeMarkdownWithTitle round-trips title', () => {
    const out = serializeMarkdownWithTitle('hello', 'T')
    expect(out).toContain('title: T')
    expect(out.trimEnd().endsWith('hello')).toBe(true)
  })
})
