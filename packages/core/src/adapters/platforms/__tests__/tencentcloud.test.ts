import { describe, expect, it } from 'vitest'
import { parseNumericIds, splitTagParams } from '../tencentcloud'

describe('tencentcloud tag/id helpers', () => {
  it('parseNumericIds keeps only positive integer strings/numbers', () => {
    expect(parseNumericIds(['12', 'LLM', '0', '-1', '3.5', 9, NaN as unknown as number])).toEqual([
      12, 9,
    ])
    expect(parseNumericIds(undefined)).toEqual([])
  })

  it('splitTagParams sends names to longtailTag and digits to tagIds', () => {
    expect(splitTagParams(['GRPO', '42', 'llm-agent'], ['exist'])).toEqual({
      tagIds: [42],
      longtailTag: ['exist', 'GRPO', 'llm-agent'],
    })
  })

  it('splitTagParams dedupes longtail case-insensitively', () => {
    expect(splitTagParams(['Foo', 'foo'], ['FOO'])).toEqual({
      tagIds: [],
      longtailTag: ['FOO'],
    })
  })
})
