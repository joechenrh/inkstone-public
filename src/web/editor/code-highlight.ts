import { autocompletion } from '@codemirror/autocomplete'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { tagHighlighter, tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * GitHub colours remain the fallback. A second highlighter emits stable CodeMirror token classes
 * for document themes to override through CSS. Unstyled tokens retain their existing fallback;
 * ordinary code text still inherits the block's foreground. Both highlighters run together, so
 * changing a theme only changes the cascade, never the editor state or undo history.
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

/** The semantic hooks used by the imported Typora themes (CodeMirror 5 token names). */
const themeTokens = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.self], class: 'cm-keyword' },
  { tag: t.variableName, class: 'cm-variable' },
  { tag: [t.definition(t.variableName), t.function(t.variableName), t.function(t.definition(t.variableName)),
    t.definition(t.function(t.variableName)), t.className, t.definition(t.className), t.macroName], class: 'cm-def' },
  { tag: t.typeName, class: 'cm-type' },
  { tag: [t.standard(t.variableName), t.namespace, t.standard(t.name)], class: 'cm-builtin' },
  { tag: t.propertyName, class: 'cm-property' },
  { tag: t.attributeName, class: 'cm-attribute' },
  { tag: t.number, class: 'cm-number' },
  { tag: [t.bool, t.literal, t.atom], class: 'cm-atom' },
  { tag: [t.string, t.character, t.regexp, t.attributeValue], class: 'cm-string' },
  { tag: [t.special(t.string), t.escape], class: 'cm-string-2' },
  { tag: t.comment, class: 'cm-comment' },
  { tag: t.operator, class: 'cm-operator' },
  { tag: [t.meta, t.annotation], class: 'cm-meta' },
  { tag: t.tagName, class: 'cm-tag' },
  { tag: [t.bracket, t.angleBracket], class: 'cm-bracket' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.heading, class: 'cm-header' },
  { tag: t.invalid, class: 'cm-error' },
])

export const codeHighlighting: Extension = [
  syntaxHighlighting(githubLight),
  syntaxHighlighting(themeTokens),
  // Scope legacy token rules to code content; language menus and the shell stay outside it.
  EditorView.contentAttributes.of({ class: 'cm-s-inner' }),
]

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

/**
 * A long line wraps instead of running off the side.
 *
 * CodeMirror scrolls horizontally by default, which is right in an IDE and wrong in a note: a
 * fence here is something you *read* while reading the prose around it, and a line you can only
 * see half of is a line you have to drag a scrollbar to finish. Worse, the scroll is per block, so
 * a note with several long fences in it has several separate places to scroll.
 *
 * The cost is that a wrapped line no longer tells you where it ends, which matters when the fence
 * is real code being counted by column. Nothing here is compiled from these notes, and the
 * alternative was already losing the right-hand end of the line entirely.
 */
export const codeWrap: Extension = EditorView.lineWrapping
