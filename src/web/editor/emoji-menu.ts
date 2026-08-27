import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { emojiMatching } from './emoji.js'
import { readOnly } from '../state/settings.js'

/**
 * The list that offers shortcodes while `:ta` is being typed.
 *
 * Nobody remembers the name of an emoji, which is the whole reason Typora shows this: you type two
 * letters and pick the one you meant. What it inserts is the shortcode — `:tada:` — because that is
 * what the file holds; the picture is drawn over it by `emoji.ts`.
 *
 * Built as plain DOM rather than as a component: it belongs to the editor's own keyboard, it has to
 * be positioned against a caret that only ProseMirror can locate, and every state it has is one
 * plugin's. A component would need all three handed to it.
 */

/** `:` then at least one letter, at a word boundary, ending at the caret. */
const TYPING = /(?:^|[\s(])(:([a-z0-9_+-]+))$/

interface Offer {
  from: number
  matches: { name: string; emoji: string }[]
  active: number
}

const KEY = new PluginKey<Offer | null>('inkstoneEmojiMenu')

function offerAt(view: EditorView): Offer | null {
  if (readOnly.value) return null
  const { selection } = view.state
  if (!selection.empty) return null
  const $head = selection.$head
  if (!$head.parent.isTextblock || $head.parent.type.spec.code === true) return null

  const before = $head.parent.textBetween(Math.max(0, $head.parentOffset - 30), $head.parentOffset, '', '')
  const typed = TYPING.exec(before)
  const prefix = typed?.[2]
  if (prefix === undefined) return null

  const matches = emojiMatching(prefix)
  if (matches.length === 0) return null
  return { from: $head.pos - (typed?.[1]?.length ?? 0), matches, active: 0 }
}

/** The rest of a shortcode the caret is standing in the middle of: `:tad|a:` has `a:` after it. */
const REMAINDER = /^[a-z0-9_+-]*:/

/**
 * Put the shortcode in, colons included: what is inserted is what the file will hold.
 *
 * The replacement runs to the end of whatever shortcode is being *edited*, not to the caret. Taking
 * an offer while standing inside `:tada:` used to leave the old closing colon where it was and the
 * line came out `:tada::` — the list is as much for correcting a shortcode as for finishing one.
 */
function accept(view: EditorView, offer: Offer): boolean {
  const chosen = offer.matches[offer.active]
  if (chosen === undefined) return false
  const head = view.state.selection.head
  const $head = view.state.selection.$head
  const after = $head.parent.textBetween($head.parentOffset, Math.min($head.parentOffset + 40, $head.parent.content.size), '', '')
  const to = head + (REMAINDER.exec(after)?.[0]?.length ?? 0)
  const tr = view.state.tr.insertText(`:${chosen.name}:`, offer.from, to)
  // Withdrawn in the same transaction that accepts it. Left to be recomputed afterwards, the list
  // stayed on screen over a shortcode that was already complete.
  view.dispatch(tr.setMeta(KEY, null))
  view.focus()
  return true
}

export const emojiMenu = $prose(() =>
  new Plugin<Offer | null>({
    key: KEY,
    state: {
      init: () => null,
      apply: (tr, value) => {
        // `??` would be wrong here and was: `null` is the *withdrawal*, and `null ?? value` falls
        // back to the offer that was being withdrawn — so the list stayed on screen over a
        // shortcode it had just completed. Only `undefined` means "this transaction said nothing".
        const meta = tr.getMeta(KEY) as Offer | null | undefined
        return meta === undefined ? value : meta
      },
    },
    props: {
      handleKeyDown(view, event) {
        const offer = KEY.getState(view.state)
        if (offer === null || offer === undefined) return false
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.setMeta(KEY, null))
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') return accept(view, offer)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1
          const next = (offer.active + step + offer.matches.length) % offer.matches.length
          view.dispatch(view.state.tr.setMeta(KEY, { ...offer, active: next }))
          return true
        }
        return false
      },
    },
    view: (view) => {
      const box = document.createElement('div')
      box.className = 'ink-emoji-menu'
      box.setAttribute('role', 'listbox')
      box.hidden = true
      document.body.appendChild(box)

      // The pointer picks without moving the caret first: `mousedown` rather than `click`, because
      // by the time a click lands the editor has already been blurred and the offer withdrawn.
      box.addEventListener('mousedown', (event) => {
        const row = (event.target as Element | null)?.closest?.('[data-index]')
        const offer = KEY.getState(view.state)
        if (row === null || row === undefined || offer === null || offer === undefined) return
        event.preventDefault()
        accept(view, { ...offer, active: Number(row.getAttribute('data-index')) })
      })

      const draw = () => {
        const offer = KEY.getState(view.state)
        if (offer === null || offer === undefined) { box.hidden = true; return }
        box.replaceChildren(...offer.matches.map((match, index) => {
          const row = document.createElement('div')
          row.className = `ink-emoji-row${index === offer.active ? ' ink-emoji-row--active' : ''}`
          row.setAttribute('data-index', String(index))
          row.setAttribute('role', 'option')
          row.setAttribute('aria-selected', String(index === offer.active))
          const glyph = document.createElement('span')
          glyph.className = 'ink-emoji-glyph'
          glyph.textContent = match.emoji
          const name = document.createElement('span')
          name.className = 'ink-emoji-name'
          name.textContent = `:${match.name}:`
          row.append(glyph, name)
          return row
        }))
        const at = view.coordsAtPos(offer.from)
        box.hidden = false
        // Below the line it belongs to, and flipped above when there is no room under it.
        const height = box.offsetHeight
        const below = at.bottom + 4
        box.style.left = `${Math.round(at.left)}px`
        box.style.top = `${Math.round(below + height > window.innerHeight ? at.top - height - 4 : below)}px`
      }

      return {
        update: (updated, previous) => {
          // Recomputed from the document, except when the plugin has just been told what to show:
          // moving the highlight must not re-read the text and reset it to the first row.
          const told = KEY.getState(updated.state) !== KEY.getState(previous)
          if (!told) {
            const offer = offerAt(updated)
            const current = KEY.getState(updated.state) ?? null
            /*
             * Nothing to offer and nothing offered is *the same state*, and saying otherwise cost
             * an afternoon: this dispatched a transaction on every update, each one causing the
             * next, and the flood swallowed what was being typed — two tests about arrow keys in
             * an unrelated note started failing, which is what a self-feeding loop looks like from
             * the outside.
             */
            const same = offer === null
              ? current === null
              : current !== null && offer.from === current.from
                && offer.matches.length === current.matches.length
                && offer.matches[0]?.name === current.matches[0]?.name
            if (!same) {
              updated.dispatch(updated.state.tr.setMeta(KEY, offer))
              return
            }
          }
          draw()
        },
        destroy: () => { box.remove() },
      }
    },
  }),
)
