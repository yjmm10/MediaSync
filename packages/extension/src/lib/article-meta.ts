/**
 * 本地 Markdown frontmatter → 文档元数据
 *
 * 正文与元数据分离：FM 不进入 markdown 渲染，结构化存于 ArticleMeta，
 * 并可映射为跨平台 PublishParams（封面/摘要/标签/分类）。
 */
import type { PublishParams } from '@mediasync/core'

export interface ArticleMeta {
  cover?: string
  summary?: string
  tags?: string[]
  category?: string
  /** 合集（博客园等）：FM 中 columns/column/collection/collections 映射而来 */
  columns?: string[]
}

/** 去掉成对引号 */
function unquote(s: string): string {
  const t = s.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** 解析 YAML 风格的简单列表值（行内 [a, b] 或逗号分隔） */
function parseStringList(raw: string): string[] {
  let s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1)
  }
  return s
    .split(/[,，]/)
    .map((x) => unquote(x))
    .filter(Boolean)
}

/**
 * 从 YAML front matter 文本块解析结构化元数据（不含 title）。
 * 仅支持本项目关心的扁平键；未知键忽略。
 */
export function parseFrontmatterMeta(fmText: string): ArticleMeta {
  const meta: ArticleMeta = {}
  const lines = fmText.split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = m[1].toLowerCase()
    const rest = m[2]

    // YAML 块列表：key:\n  - a\n  - b
    if (rest.trim() === '' || rest.trim() === '|' || rest.trim() === '>') {
      if (
        key === 'tags' ||
        key === 'categories' ||
        key === 'columns' ||
        key === 'column' ||
        key === 'collection' ||
        key === 'collections'
      ) {
        const items: string[] = []
        let j = i + 1
        while (j < lines.length) {
          const lm = lines[j].match(/^\s+-\s+(.+)$/)
          if (!lm) break
          items.push(unquote(lm[1]))
          j++
        }
        if (items.length > 0) {
          if (key === 'tags') meta.tags = items
          else if (key === 'categories') meta.category = items[0]
          else if (!meta.columns) meta.columns = items
        }
        i = j
        continue
      }
    }

    const value = unquote(rest)
    if (!value && rest.trim() !== '[]') {
      i++
      continue
    }

    if (key === 'cover' || key === 'banner' || key === 'image' || key === 'thumbnail') {
      if (value && !meta.cover) meta.cover = value
    } else if (key === 'abstract' || key === 'summary' || key === 'description') {
      if (value && !meta.summary) meta.summary = value
    } else if (key === 'tags') {
      const list = parseStringList(rest)
      if (list.length > 0) meta.tags = list
    } else if (key === 'category') {
      if (value) meta.category = value
    } else if (key === 'categories') {
      const list = parseStringList(rest)
      if (list.length > 0 && !meta.category) meta.category = list[0]
    } else if (
      key === 'columns' ||
      key === 'column' ||
      key === 'collection' ||
      key === 'collections'
    ) {
      const list = parseStringList(rest)
      if (list.length > 0 && !meta.columns) meta.columns = list
    }

    i++
  }

  return meta
}

/** 是否有任意已填字段 */
export function hasArticleMeta(meta?: ArticleMeta | null): boolean {
  if (!meta) return false
  return !!(
    meta.cover ||
    meta.summary ||
    (meta.tags && meta.tags.length > 0) ||
    meta.category
  )
}

/** ArticleMeta → PublishParams（仅输出已定义字段；可按平台调整映射） */
export function metaToPublishParams(
  meta?: ArticleMeta | null,
  platformId?: string,
): PublishParams {
  if (!meta) return {}
  const params: PublishParams = {}
  if (meta.cover) params.cover = meta.cover
  if (meta.summary) params.summary = meta.summary
  if (meta.tags && meta.tags.length > 0) params.tags = [...meta.tags]
  if (meta.category) {
    if (platformId === 'cnblogs') {
      // 博客园：FM category → 合集(columns)；个人分类无 FM 对应
      params.columns = [meta.category]
    } else {
      params.category = meta.category
    }
  }
  // 博客园合集：FM columns/collection 等 → params.columns
  if (meta.columns && meta.columns.length > 0 && platformId === 'cnblogs') {
    params.columns = [...meta.columns]
  }
  return params
}

/**
 * 仅当 category 能在选项中匹配（id 或名称）时返回解析后的 id；否则 undefined。
 */
export function tryResolveCategoryId(
  category: string | undefined,
  options:
    | Array<{ value?: string; label?: string; id?: string; name?: string }>
    | undefined,
): string | undefined {
  if (!category || !options?.length) return undefined
  const needle = category.trim()
  if (!needle) return undefined
  const valueOf = (o: { value?: string; id?: string }) => o.value ?? o.id
  const labelOf = (o: { label?: string; name?: string }) => o.label ?? o.name
  if (options.some((o) => valueOf(o) === needle)) return needle
  const lower = needle.toLowerCase()
  const byLabel = options.find((o) => {
    const label = labelOf(o)
    return typeof label === 'string' && label.trim().toLowerCase() === lower
  })
  return valueOf(byLabel ?? {})
}

type RefOption = { id?: string; name?: string; value?: string; label?: string }

/**
 * 将 FM 按字段条件合并进已有 PublishParams（defaults⊕saved 之后）。
 * - summary / cover：FM 有则覆盖
 * - tags：cnblogs 直接用 FM；其它平台有 suggestions 时仅保留能匹配的，全不匹配则保留 base
 * - category / columns：仅当能在 refs 中解析成功才覆盖（博客园 FM category→columns，不填个人分类）
 */
export function applyFrontmatterToPublishParams(
  base: PublishParams,
  meta: ArticleMeta | null | undefined,
  opts: {
    platformId: string
    refs?: {
      categories?: RefOption[]
      columns?: RefOption[]
      tagSuggestions?: string[]
    } | null
  },
): PublishParams {
  if (!meta) return base
  const next: PublishParams = { ...base }
  const { platformId, refs } = opts

  if (meta.summary) next.summary = meta.summary
  if (meta.cover) next.cover = meta.cover

  if (meta.tags && meta.tags.length > 0) {
    if (platformId === 'cnblogs') {
      next.tags = [...meta.tags]
    } else {
      const suggestions = refs?.tagSuggestions
      if (suggestions && suggestions.length > 0) {
        const lower = new Set(suggestions.map((s) => String(s).toLowerCase()))
        const matched = meta.tags.filter((t) => lower.has(t.toLowerCase()))
        if (matched.length > 0) next.tags = matched
      } else {
        next.tags = [...meta.tags]
      }
    }
  }

  if (meta.category) {
    if (platformId === 'cnblogs') {
      const cols = refs?.columns
      if (cols && cols.length > 0) {
        const resolved = tryResolveCategoryId(meta.category, cols)
        // 能匹配才覆盖；匹配失败保留 base（历史 saved）
        if (resolved) next.columns = [resolved]
      } else {
        // refs 尚未拉取：先写入名称，待刷新/加载选项后再解析为 id
        next.columns = [meta.category]
      }
    } else {
      const cats = refs?.categories
      if (cats && cats.length > 0) {
        const resolved = tryResolveCategoryId(meta.category, cats)
        if (resolved) next.category = resolved
      } else {
        next.category = meta.category
      }
    }
  }

  // 博客园：FM columns/collection 等 → 合集 columns（仅当尚无合集来源时）
  if (platformId === 'cnblogs' && meta.columns && meta.columns.length > 0) {
    if (!next.columns || next.columns.length === 0) {
      const cols = refs?.columns
      if (cols && cols.length > 0) {
        const resolved = meta.columns
          .map((c) => tryResolveCategoryId(c, cols))
          .filter(Boolean) as string[]
        if (resolved.length > 0) next.columns = resolved
        else next.columns = [...meta.columns]
      } else {
        next.columns = [...meta.columns]
      }
    }
  }

  return next
}

/** 用 meta 镜像顶层 cover/summary（兼容既有同步路径） */
export function mirrorMetaToArticleFields(meta?: ArticleMeta | null): {
  cover?: string
  summary?: string
} {
  if (!meta) return {}
  return {
    ...(meta.cover ? { cover: meta.cover } : {}),
    ...(meta.summary ? { summary: meta.summary } : {}),
  }
}

/**
 * 将正文与结构化 meta（及可选 title）序列化为带 YAML front matter 的 Markdown。
 */
export function serializeMarkdownWithMeta(
  body: string,
  meta?: ArticleMeta | null,
  title?: string
): string {
  const lines: string[] = []
  if (title?.trim()) {
    lines.push(`title: ${yamlScalar(title.trim())}`)
  }
  if (meta?.cover) lines.push(`cover: ${yamlScalar(meta.cover)}`)
  if (meta?.summary) lines.push(`abstract: ${yamlScalar(meta.summary)}`)
  if (meta?.category) lines.push(`category: ${yamlScalar(meta.category)}`)
  if (meta?.tags && meta.tags.length > 0) {
    lines.push('tags:')
    for (const t of meta.tags) {
      lines.push(`  - ${yamlScalar(t)}`)
    }
  }
  if (lines.length === 0) return body
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`
}

function yamlScalar(s: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(s) || /^\s|\s$/.test(s) || s === '') {
    return JSON.stringify(s)
  }
  return s
}

/**
 * 若 category 是名称而非 option value，按 label/name 忽略大小写匹配为 id。
 * 兼容 FieldOption({ value, label }) 与 PublishRefs({ id, name })。
 */
export function resolveCategoryId(
  category: string | undefined,
  options:
    | Array<{ value?: string; label?: string; id?: string; name?: string }>
    | undefined
): string | undefined {
  if (!category || !options?.length) return category
  const valueOf = (o: { value?: string; id?: string }) => o.value ?? o.id
  const labelOf = (o: { label?: string; name?: string }) => o.label ?? o.name
  if (options.some((o) => valueOf(o) === category)) return category
  const lower = category.toLowerCase()
  const byLabel = options.find((o) => {
    const label = labelOf(o)
    return typeof label === 'string' && label.toLowerCase() === lower
  })
  return valueOf(byLabel ?? {}) ?? category
}

/**
 * 将名称列表解析为 option id 列表（已是 id 则保留）。
 * 兼容 { value, label } / { id, name }。
 */
export function resolveRefIds(
  names: string[] | undefined,
  options:
    | Array<{ value?: string; label?: string; id?: string; name?: string }>
    | undefined,
): string[] | undefined {
  if (!names?.length) return names
  return names.map((name) => resolveCategoryId(name, options) ?? name)
}
