import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorState } from '@milkdown/kit/prose/state'
import { readOnly } from '../state/settings.js'
import './emoji.css'

/**
 * `:tada:` is drawn as 🎉, and stays `:tada:` in the file.
 *
 * The first version of this replaced the shortcode with the character as it was typed, on the
 * grounds that rendering one would mean writing the emoji into the note on the next save. That is
 * true of any approach that puts the emoji *in the document*, and it is not what Typora does:
 * there the shortcode is the text, the emoji is drawn over it, and putting the caret in it shows
 * `:tada:` in grey beside the picture — the same rule as every other bit of syntax in this editor.
 * So the bytes on disk are the six characters somebody typed, whichever machine or editor opens
 * them next, and the drawing is a decoration that the document never sees.
 *
 * The names are fetched when an editor is built (`loadEmojiNames`), not with the bundle: 80 KB of
 * shortcodes for a convenience. Until they arrive nothing is drawn and `:tada:` is six characters,
 * which is exactly what it is.
 */

type Lookup = (name: string) => string | undefined

let lookup: Lookup | null = null
let names: string[] = []
const ready = { value: false }

/** Start fetching the names. Called once, when an editor is built. */
export function loadEmojiNames(): void {
  if (ready.value) return
  ready.value = true
  void import('node-emoji').then((module) => {
    lookup = (name) => module.get(name)
    names = module.search('').map((hit) => hit.name)
  }).catch(() => { /* no names, no drawing: the text stays as it was typed */ })
}

/** The emoji a shortcode stands for, or undefined — including before the names have arrived. */
export function emojiFor(name: string): string | undefined {
  return lookup?.(name)
}

/**
 * Shortcodes starting with `prefix`, for the list that offers them.
 *
 * Alphabetical, because the order a list of names is offered in should be the one the reader can
 * predict — `:ta` gives taco, tada, taiwan — rather than whatever order the names happen to be
 * stored in.
 */
export function emojiMatching(prefix: string, limit = 8): { name: string; emoji: string }[] {
  const found: { name: string; emoji: string }[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const emoji = lookup?.(name)
    if (emoji === undefined) continue
    found.push({ name, emoji })
  }
  found.sort((a, b) => a.name.localeCompare(b.name))
  return found.slice(0, limit)
}

/** The picture itself. Not part of the text, and not somewhere a caret can be put. */
function glyph(emoji: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'ink-emoji-glyph-drawn'
  span.textContent = emoji
  span.contentEditable = 'false'
  return span
}

/** `:name:` — the shape a shortcode has, wherever it is in a line. */
const SHORTCODE = /:([a-z0-9_+-]+):/g

/**
 * The last answer, kept because this is asked far more often than the document changes.
 *
 * Decorations are recomputed on every view update — a focus change, a scroll, a selection that
 * lands in the same place — and this one walks every text node in the note. Two things decide the
 * answer: the document, and where the caret is (which shortcode is spelled out). Nothing else, so
 * anything else asking gets the same set back.
 */
let last: { doc: unknown; from: number; to: number; set: DecorationSet | null } | null = null

export const emojiReveal = $prose(() =>
  new Plugin({
    key: new PluginKey('inkstoneEmojiReveal'),
    props: {
      decorations(state: EditorState) {
        if (lookup === null) return null
        if (last !== null && last.doc === state.doc && last.from === state.selection.from
          && last.to === state.selection.to) return last.set
        const found: Decoration[] = []
        const { from: caretFrom, to: caretTo } = state.selection

        state.doc.descendants((node, position) => {
          if (!node.isText) return true
          const text = node.text ?? ''
          if (!text.includes(':')) return false
          for (const match of text.matchAll(SHORTCODE)) {
            const name = match[1]
            const emoji = name === undefined ? undefined : lookup?.(name)
            if (emoji === undefined) continue
            const from = position + (match.index ?? 0)
            const to = from + match[0].length
            // In it: the shortcode shows, in grey, beside what it draws. Everywhere else it is the
            // picture alone. The same rule the marks and the headings follow.
            const open = caretFrom <= to && caretTo >= from
            /*
             * The picture is a widget rather than the span's own `::before`.
             *
             * A pseudo-element lives *inside* the span, and at the start of a paragraph that is
             * where the caret has to go: there is no text before it to hold the position, so the
             * caret landed after the emoji and `:tada:` at the start of a line had a stop that the
             * same shortcode mid-line did not. Measured — 20px in from the span's left edge, which
             * is exactly the emoji's width. A widget at the run's first position with `side: 1` is
             * drawn *after* any caret sharing that position, so `|🎉:tada:` reads the same wherever
             * the shortcode is, and the emoji and the colon after it stay one unit with nothing
             * between them.
             */
            found.push(Decoration.widget(from, () => glyph(emoji), {
              side: 1,
              key: `emoji:${emoji}`,
            }))
            found.push(Decoration.inline(from, to, {
              class: `ink-emoji${open && !readOnly.value ? ' ink-emoji--open' : ''}`,
            }))
          }
          return false
        })

        const set = found.length === 0 ? null : DecorationSet.create(state.doc, found)
        last = { doc: state.doc, from: state.selection.from, to: state.selection.to, set }
        return set
      },
    },
  }),
)
