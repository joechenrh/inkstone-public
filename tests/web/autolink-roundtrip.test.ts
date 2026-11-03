import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { toMarkdown, type Options } from 'mdast-util-to-markdown'
import { writeWhatWasTyped } from '../../src/web/editor/markdown-escapes.js'
import type { Ctx } from '@milkdown/kit/ctx'

describe('autolink serialization', () => {
  it('preserves literal backslashes through repeated parse/save cycles', () => {
    let options: Options = {}
    writeWhatWasTyped({ update: (_key: unknown, update: (value: Options) => Options) => { options = update(options) } } as unknown as Ctx)
    const parser = unified().use(remarkParse).use(remarkGfm).freeze()
    options.extensions = parser.data('toMarkdownExtensions') as Options['extensions']
    expect(toMarkdown({ type: 'root', children: [{ type: 'paragraph', children: [
      { type: 'text', value: 'See https://www.example.com/book and https://new.example.com/page.' },
    ] }] }, options)).toBe('See https://www.example.com/book and https://new.example.com/page.\n')
    const original = '<https://www.example.com/book>\n\n<https://www' + '\\'.repeat(4) + '.example.com/book>\n'
      + '\n[label](https://example.com/path)\n\n```text\nC:\\notes\\file.md\n```\n'
    let text = original
    for (let round = 0; round < 8; round++) {
      text = toMarkdown(parser.parse(text), options)
      expect(text).toBe(original)
    }
  })
})
