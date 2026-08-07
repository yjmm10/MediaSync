import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/lib/local-markdown'
import {
  applyFrontmatterToPublishParams,
  metaToPublishParams,
  parseFrontmatterMeta,
  resolveCategoryId,
  serializeMarkdownWithMeta,
  tryResolveCategoryId,
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
  it('auto prefers H1 over frontmatter', () => {
    const r = parseMarkdown(SAMPLE, 'file-name', { titleSource: 'auto' })
    expect(r.title).toBe('From H1')
    expect(r.body).toBe('body text')
    expect(r.cover).toBe('./c.png')
    expect(r.frontmatter.cover).toBe('./c.png')
    expect(r.frontmatter.summary).toBe('A short blurb')
    expect(r.frontmatter.tags).toEqual(['foo', 'bar'])
    expect(r.frontmatter.category).toBe('Frontend')
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

describe('frontmatter meta aliases', () => {
  it('maps banner/summary/categories list', () => {
    const fm = `banner: ./b.png
summary: Hello
categories: [A, B]
tags:
  - x
  - y
`
    const meta = parseFrontmatterMeta(fm)
    expect(meta.cover).toBe('./b.png')
    expect(meta.summary).toBe('Hello')
    expect(meta.category).toBe('A')
    expect(meta.tags).toEqual(['x', 'y'])
  })

  it('body has no frontmatter after parse', () => {
    const r = parseMarkdown(SAMPLE, 'f')
    expect(r.body.startsWith('---')).toBe(false)
    expect(r.body).not.toContain('abstract:')
  })

  it('metaToPublishParams only emits defined fields', () => {
    expect(metaToPublishParams({ summary: 's', tags: ['a'] })).toEqual({
      summary: 's',
      tags: ['a'],
    })
  })

  it('serializeMarkdownWithMeta round-trips fields', () => {
    const out = serializeMarkdownWithMeta('hello', {
      cover: 'https://x/c.png',
      summary: 'abs',
      tags: ['t1'],
      category: 'cat',
    }, 'T')
    expect(out).toContain('title: T')
    expect(out).toContain('cover: "https://x/c.png"')
    expect(out).toContain('abstract: abs')
    expect(out).toContain('category: cat')
    expect(out).toContain('- t1')
    expect(out.trimEnd().endsWith('hello')).toBe(true)
  })

  it('resolveCategoryId matches by label', () => {
    const opts = [
      { value: '1', label: '前端' },
      { value: '2', label: '后端' },
    ]
    expect(resolveCategoryId('前端', opts)).toBe('1')
    expect(resolveCategoryId('1', opts)).toBe('1')
    expect(resolveCategoryId('未知', opts)).toBe('未知')
  })

  it('metaToPublishParams maps cnblogs category to columns', () => {
    expect(metaToPublishParams({ category: '合集A', tags: ['t'] }, 'cnblogs')).toEqual({
      columns: ['合集A'],
      tags: ['t'],
    })
    expect(metaToPublishParams({ category: '前端' }, 'juejin')).toEqual({
      category: '前端',
    })
  })
})

describe('applyFrontmatterToPublishParams', () => {
  it('applies summary always; cnblogs tags from FM; columns only when matched', () => {
    expect(tryResolveCategoryId('合集A', [{ id: '1', name: '合集A' }])).toBe('1')
    expect(tryResolveCategoryId('未知', [{ id: '1', name: '合集A' }])).toBeUndefined()

    const base = { category: 'saved-cat', columns: ['saved-col'], tags: ['old'] }
    const merged = applyFrontmatterToPublishParams(
      base,
      { summary: 's', tags: ['a', 'b'], category: '合集A' },
      {
        platformId: 'cnblogs',
        refs: {
          columns: [{ id: '9', name: '合集A' }],
          categories: [{ id: 'c1', name: '个人分类' }],
        },
      },
    )
    expect(merged.summary).toBe('s')
    expect(merged.tags).toEqual(['a', 'b'])
    expect(merged.columns).toEqual(['9'])
    // 个人分类不来自 FM
    expect(merged.category).toBe('saved-cat')
  })

  it('keeps saved columns when FM category does not match', () => {
    const merged = applyFrontmatterToPublishParams(
      { columns: ['keep'] },
      { category: '不存在' },
      {
        platformId: 'cnblogs',
        refs: { columns: [{ id: '1', name: '合集A' }] },
      },
    )
    expect(merged.columns).toEqual(['keep'])
  })

  it('parks cnblogs category name as columns when refs empty', () => {
    const merged = applyFrontmatterToPublishParams(
      {},
      { category: '合集A' },
      { platformId: 'cnblogs', refs: null },
    )
    expect(merged.columns).toEqual(['合集A'])
  })

  it('filters tags by suggestions on non-cnblogs platforms', () => {
    const matched = applyFrontmatterToPublishParams(
      { tags: ['saved'] },
      { tags: ['Foo', 'nope'] },
      {
        platformId: 'juejin',
        refs: { tagSuggestions: ['foo', 'bar'] },
      },
    )
    expect(matched.tags).toEqual(['Foo'])

    const none = applyFrontmatterToPublishParams(
      { tags: ['saved'] },
      { tags: ['nope'] },
      {
        platformId: 'juejin',
        refs: { tagSuggestions: ['foo'] },
      },
    )
    expect(none.tags).toEqual(['saved'])
  })
})
