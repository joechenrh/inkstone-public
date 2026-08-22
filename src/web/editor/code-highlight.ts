import { autocompletion } from '@codemirror/autocomplete'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/**
 * The colours a fenced block is highlighted in, so both engines highlight it the same.
 *
 * Vditor renders code through highlight.js wearing `github.min.css`; Crepe renders it through a
 * CodeMirror instance wearing CodeMirror's own default. Side by side that is not a shade or two —
 * `int` is red in one and orange in the other, strings green here and dark blue there — and on a
 * note with forty fences in it, the difference is most of the page.
 *
 * The values below are read off the shipped `github.min.css` rather than chosen, so this matches
 * what the application has rendered since Phase 1 rather than approximating it. highlight.js groups
 * many token names onto one colour; the groups are kept, with the CodeMirror tag that means the
 * same thing in each.
 *
 * This is deliberately not per-document-theme. Neither engine's palette ever was: Vditor's code
 * colours come from its own stylesheet and do not change when the reader changes theme — verified
 * in dark mode, where its keywords are still this red on the dark panel — so making Crepe's change
 * would be a new behaviour rather than a matching one.
 *
 * Nothing here colours ordinary code text, and that is the reason the dark mode works at all.
 * highlight.js only wraps the tokens it recognises; everything else is bare text that inherits the
 * colour the theme gives the block, which is `#4f5467` in light and `#abbad4` in dark. Assigning
 * even a "base" colour here froze that at a light-mode value, and on the dark panel the plain half
 * of every fence — an XML element's content, an unrecognised identifier — went nearly invisible.
 */

/** github.min.css, by the group highlight.js puts each token in. */
const KEYWORD = '#d73a49' // .hljs-keyword, -doctag, -type, -template-tag, -variable.language_
const ENTITY = '#6f42c1' // .hljs-title, -title.class_, -title.function_
const CONSTANT = '#005cc5' // .hljs-attr, -attribute, -literal, -meta, -number, -operator, -variable
const STRING = '#032f62' // .hljs-string, -regexp
const BUILT_IN = '#e36209' // .hljs-built_in, -symbol
const COMMENT = '#6a737d' // .hljs-comment, -code, -formula
const TAG = '#22863a' // .hljs-name, -quote, -selector-tag, -selector-pseudo
const BULLET = '#735c0f' // .hljs-bullet
const ADDITION = '#22863a'
const DELETION = '#b31d28'

const githubLight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self, t.typeName, t.standard(t.name)], color: KEYWORD },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.function(t.variableName)), t.className, t.definition(t.className), t.macroName], color: ENTITY },
  { tag: [t.number, t.bool, t.literal, t.atom, t.attributeName, t.propertyName, t.operator, t.meta, t.annotation, t.unit], color: CONSTANT },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], color: STRING },
  { tag: [t.standard(t.variableName), t.namespace], color: BUILT_IN },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.docString], color: COMMENT, fontStyle: 'normal' },
  { tag: [t.tagName, t.quote, t.angleBracket, t.attributeValue], color: TAG },
  { tag: t.list, color: BULLET },
  { tag: t.inserted, color: ADDITION },
  { tag: t.deleted, color: DELETION },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.heading, color: CONSTANT, fontWeight: '600' },
  { tag: t.invalid, color: DELETION },
])

/**
 * `basicSetup` already installs CodeMirror's default style, but installs it as a *fallback* — a
 * style added afterwards is the one that applies. So this is added, not substituted, and no part of
 * Crepe's own setup has to be taken apart to make room for it.
 */
export const codeHighlighting: Extension = syntaxHighlighting(githubLight)

/**
 * Tab indents by four spaces inside a fenced block.
 *
 * CodeMirror's default unit is a literal tab, so pressing Tab put `\t` into the note — a character
 * that renders at whatever width whichever program opens the file next happens to use, which for a
 * file kept in git and read on GitHub is not a width anyone chose. Four spaces is what the code in
 * these notes already uses.
 */
export const codeIndent: Extension[] = [indentUnit.of('    ')]

/**
 * No completion box in a fenced block.
 *
 * Crepe builds its CodeMirror from `basicSetup`, which installs `autocompletion()` — so typing
 * `con` in a fence marked `js` opened an IDE's suggestion list over the note offering `const`,
 * `continue` and `functiondefinition`. In an editor that is what you want; in a *note about* code
 * it is a popup between you and the page, and the words in these fences are as often prose or
 * assembly or a shell line as they are JavaScript.
 *
 * `basicSetup` is a fixed array and nothing can be taken out of it, so this is the feature
 * configured off rather than removed: `activateOnTyping` stops the box from opening as you type,
 * and an empty `override` leaves the sources empty, so `Ctrl+Space` has nothing to offer either.
 * Both are needed to say "off" — the first alone leaves a shortcut that still opens a list.
 *
 * It wins over `basicSetup`'s own call because that one passes no options at all: CodeMirror
 * combines the two configurations field by field, and a field only one of them defines is taken
 * from the one that defines it.
 */
export const codeCompletion: Extension = autocompletion({ activateOnTyping: false, override: [] })
