import { $prose } from '@milkdown/kit/utils'
import { InputRule, inputRules } from '@milkdown/kit/prose/inputrules'

/**
 * `:smile:` becomes 😄 as it is typed.
 *
 * The other engine did this and this one did not, found by rendering the same note in both. What
 * it does *not* do is the other half of Vditor's behaviour: a `:smile:` already in a file is left
 * exactly as it is. Rendering it would mean writing the emoji back into the note on the next save
 * — the file rewritten for something nobody typed today — and this application's rule is that what
 * is on disk is what was typed. So the shortcut helps you write one and never edits your notes.
 *
 * **The map is fetched when the editor mounts, not when the bundle loads.** It is 80 KB of names
 * for a convenience, and nothing about the editor waits for it: until it arrives the rule declines
 * and `:smile:` stays the six characters you typed.
 */

type Lookup = (name: string) => string | undefined

let lookup: Lookup | null = null

/** Start fetching the names. Called once, when an editor is built. */
export function loadEmojiNames(): void {
  if (lookup !== null) return
  void import('node-emoji').then((module) => {
    lookup = (name) => module.get(name)
  }).catch(() => { /* no names, no shortcut: the text stays as it was typed */ })
}

/** `:` a name `:`, completed by the closing colon — the shape every chat window uses. */
const SHORTCODE = /(?:^|[\s(])(:([a-z0-9_+-]+):)$/

export const emojiInputRule = $prose(() =>
  inputRules({
    rules: [
      new InputRule(SHORTCODE, (state, match, start, end) => {
        const name = match[2]
        const emoji = name === undefined ? undefined : lookup?.(name)
        if (emoji === undefined) return null
        // The match begins at whatever came before the first colon — a space, an opening bracket,
        // or nothing — and that character is not part of the shortcode. Written back rather than
        // measured around: computing the position of the colon instead ate the space in front of
        // it, and `typed :tada:` came out as `typed🎉`.
        const whole = match[0] ?? ''
        const prefix = whole.slice(0, whole.length - (match[1]?.length ?? 0))
        return state.tr.replaceWith(start, end, state.schema.text(prefix + emoji))
      }),
    ],
  }),
)
