import { useEffect, useRef, useState } from 'preact/hooks'
import {
  chosenRepo,
  identityProvider,
  restoreSession,
  session,
  useIdentity,
  type IdentityProvider,
} from '../auth/identity.js'
import { RepoPicker } from '../auth/RepoPicker.js'
import { SaveBar } from './SaveBar.js'
import { usePendingPlaceholder } from '../state/pending.js'
import { listShares, readShare, type SharedNote as Note } from './api.js'
import { renderMarkdown } from './render.js'
import { showAlerts } from '../editor/alert-dom.js'
// The same face, base and document themes the editor wears — this page is the app, not a copy.
import '../editor/document.css'
import './shared.css'

/** The two weights the document themes ask for, and the CSS value each maps to. */
const FACE_WEIGHTS = [['regular', 400], ['bold', 700]] as const

/**
 * Prefer this note's own CJK face over the one the app ships.
 *
 * The app's carries the common 3,755 characters at a megabyte a weight — right for an editor
 * someone opens daily and the browser keeps for a year, wrong for a link a stranger opens once.
 * The server cuts each shared note a face holding only the characters that note uses: **96KB for
 * both weights against 2,106KB**, with the same outlines.
 *
 * Appended to the head, so it is the last rule declared for this family and wins the match. It
 * carries no `unicode-range` and needs none — the cut face contains no Latin glyphs at all, so
 * Latin falls through to exactly where it does in the editor.
 */
function installNoteFace(id: string): void {
  const at = encodeURIComponent(id)
  const style = document.createElement('style')
  style.textContent = FACE_WEIGHTS
    .map(([weight, css]) => '@font-face{font-family:"Source Han Serif CN";'
      + `src:url("/api/share/${at}/font/${weight}.woff2") format("woff2");`
      + `font-weight:${css};font-display:swap}`)
    .join('\n')
  document.head.append(style)
}

/**
 * A shared note, for whoever has the link.
 *
 * A page, not the application: no tree, no bars, no editor, and one thing to do with it. It is
 * rendered by the same lute and wearing the same document theme as the editor, so a shared note
 * reads exactly as it does to the person who wrote it — and it carries *the reader's* appearance
 * and theme settings, because it is their screen.
 */
export function SharedNote({ id, identity }: { id: string; identity: IdentityProvider | null }) {
  const [note, setNote] = useState<Note | null>(null)
  // Whether the identity has finished restoring. Until it has, the bar cannot honestly say
  // whether saving needs a sign-in, so it says nothing.
  const [ready, setReady] = useState(identity === null)
  const [picking, setPicking] = useState(false)
  /** Whether this link is the reader's own. Null until there is an answer either way. */
  const [mine, setMine] = useState<boolean | null>(identity === null ? false : null)

  useEffect(() => {
    void readShare(id).then((found) => {
      // Before the note is rendered, not after: a face declared later would be a second download
      // on top of the one it was meant to replace.
      if (found.ok && found.hasFont === true) installNoteFace(id)
      setNote(found)
    })
    if (identity === null) return
    useIdentity(identity)
    void restoreSession().then(async () => {
      setReady(true)
      if (session.value === null) { setMine(false); return }
      // Whose share this is. The app knows from `sharedByPath`, but this page is not the app and
      // may be the first thing a tab ever loads, so it asks.
      try {
        setMine((await listShares(await identityProvider().token())).some((s) => s.id === id))
      } catch {
        // Unanswerable, so treat it as somebody else's: offering to save a note you already have
        // is a wasted press, where hiding the offer from its author would be a dead end.
        setMine(false)
      }
    })
  }, [id])

  const waiting = usePendingPlaceholder(note === null)

  if (picking && session.value !== null && chosenRepo.value === null) return <RepoPicker />

  return (
    <div class="ink-shared">
      <header class="ink-shared-bar">
        <span class="ink-shared-brand">Inkstone</span>
        <span class="ink-shared-kind">{mine === true ? 'your shared note' : 'shared note'}</span>
        {mine === true
          // The author's whole business with this page is confirming it looks right and getting
          // back. That belongs at the top, where they land — not in a bar under a note they wrote.
          ? <a class="ink-shared-back" href="/">Open in Inkstone</a>
          : ready && session.value !== null && chosenRepo.value !== null && (
            // So nobody saves into the wrong one.
            <span class="ink-shared-repo">{chosenRepo.value.owner}/{chosenRepo.value.name}</span>
          )}
      </header>

      {note === null
        ? <Skeleton visible={waiting} />
        : note.ok
          ? (
            <>
              <Body markdown={note.content} id={id} />
              {/* Nothing under the note for its own author: "Save to my notes" would offer them a
                  second copy of a note they are looking at from their own repository. */}
              {ready && mine === false && (
                <SaveBar
                  note={note}
                  identity={identity}
                  onNeedRepo={() => { setPicking(true) }}
                />
              )}
            </>
          )
          : <Gone reason={note.reason} />}
    </div>
  )
}

/** The same two thresholds as the editor: nothing for 180ms, then this, then at least 300ms of it. */
function Skeleton({ visible }: { visible: boolean }) {
  if (!visible) return <div class="ink-shared-body" />
  return (
    <div class="ink-shared-body" aria-hidden="true">
      <div class="ink-shared-skel title" />
      <div class="ink-shared-skel a" />
      <div class="ink-shared-skel b" />
      <div class="ink-shared-skel c" />
    </div>
  )
}

function Body({ markdown, id }: { markdown: string; id: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (el === null) return
    let live = true
    let stopAlerts: (() => void) | null = null
    void renderMarkdown(el, markdown).then(() => {
      if (!live) return
      // The same five callouts, drawn the same way. `live: false` because this page has no caret:
      // a reader never sees the syntax, only what it means.
      stopAlerts = showAlerts(el, { live: false })
      // The pictures. A note says `/assets/…`, which on this page would be a request to the root
      // of this server for something only the vault has — and a reader of a shared link has no
      // account at all. They were copied with the note; this is where the copy is.
      for (const img of Array.from(el.querySelectorAll('img[src]'))) {
        const src = img.getAttribute('src') ?? ''
        const name = /^\/?assets\/([^/?#]+)$/.exec(src)?.[1]
        if (name !== undefined) img.setAttribute('src', `/api/share/${encodeURIComponent(id)}/asset/${name}`)
      }
      // Read-only means read-only: a link inside a shared note leaves this page, and it must not
      // carry the referrer of a private note's address with it.
      //
      // A link to *another note* is a different matter and stops being a link at all. A share is a
      // copy of one file; the note it points at was never published and the reader has no account
      // for it, so the words stay and the href goes. Offering a link that 404s is worse than not
      // offering one, and quietly publishing a private path is worse than both.
      for (const a of Array.from(el.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') ?? ''
        if (!/^(https?|mailto):/i.test(href) && !href.startsWith('#')) {
          a.replaceWith(...Array.from(a.childNodes))
          continue
        }
        a.setAttribute('rel', 'noopener noreferrer ugc')
        a.setAttribute('target', '_blank')
      }
    })
    return () => { live = false; stopAlerts?.() }
  }, [markdown])

  // `ink-doc` is what every document theme is scoped to, so wearing it is what makes this page look
  // like the editor rather than merely similar to it. It used to wear `vditor-ir vditor-reset` for
  // the same reason, back when the themes named an engine — this page has no editor anywhere near
  // it, and should never have had to say which one it was not.
  //
  // `vditor-reset` stays for one thing only: Vditor's own stylesheet gives it the `overflow: auto`
  // that makes this a scroll container, which `shared.css` depends on.
  return (
    <div class="ink-shared-body">
      <div ref={host} class="ink-doc vditor-reset" />
    </div>
  )
}

/** A link that used to work is a different fact from one that never did. */
function Gone({ reason }: { reason: 'missing' | 'expired' | 'stopped' | 'offline' }) {
  const said = {
    expired: {
      title: 'This link has expired',
      detail: 'Shared notes are readable for thirty days. Ask whoever sent it for a new link.',
    },
    stopped: {
      title: 'This note is no longer shared',
      detail: 'Whoever shared it has stopped. Ask them for a new link.',
    },
    missing: {
      title: 'Nothing here',
      detail: 'That link does not point at a shared note. Check it was copied whole.',
    },
    offline: {
      title: 'Could not reach the server',
      detail: 'The link may be fine. Try again in a moment.',
    },
  }[reason]

  return (
    <div class="ink-shared-gone">
      <p class="ink-shared-gone-title">{said.title}</p>
      <p class="ink-shared-gone-detail">{said.detail}</p>
    </div>
  )
}
