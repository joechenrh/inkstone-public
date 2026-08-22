import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'
import { isPhone } from '../state/ui.js'
import { usePendingPlaceholder } from '../state/pending.js'
import {
  clearCopied,
  closeSharePanel,
  copyLink,
  daysLeft,
  reshare,
  sharePanel,
  sharePanelPath,
  stopSharing,
  type SharePanelState,
} from '../state/share.js'
import './share.css'

/** How long the button says `Copied` before going back to `Copy`. */
const COPIED_MS = 2000

/** Under this the number takes the warning colour. That is the whole notification system. */
const NEARLY_GONE_DAYS = 3

/**
 * The link, and everything that can be true about it.
 *
 * A panel rather than a toast, because a link is a thing you need to see: the clipboard can refuse
 * — iOS does, outside a user gesture — and a notice that has faded cannot be read twice. It takes
 * the commit panel's shape at both sizes, which means a centred modal on a desktop and a sheet at
 * the bottom of a phone, where the thumb is.
 */
export function SharePanel() {
  const path = sharePanelPath.value
  const state = sharePanel.value

  useLayoutEffect(() => {
    if (path === null) return
    // Layout, not plain effect: a plain one runs after paint and leaves a window in which the
    // panel is on screen with no key listener bound, so the first Escape is dropped.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSharePanel() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [path])

  if (path === null) return null

  return (
    <div class="ink-share-scrim" onClick={closeSharePanel}>
      <div
        class={`ink-share${isPhone.value ? ' ink-share--sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Share"
        onClick={(e) => { e.stopPropagation() }}
      >
        <div class="ink-share-head">
          <span class="ink-share-title">Share</span>
          <button type="button" class="ink-iconbtn" aria-label="Close share" onClick={closeSharePanel}>✕</button>
        </div>

        {state.kind === 'failed'
          ? <Failure state={state} />
          : state.kind === 'stopped'
            ? (
              <div class="ink-share-body">
                <div class="ink-share-note">
                  <b>No longer shared</b>
                  {/* Said plainly, because it is the one thing about stopping that surprises
                      people, and it is true of every share link ever made. */}
                  Anyone opening the old link is told it has stopped. It does not reach anyone who
                  already read the note.
                </div>
              </div>
            )
            : <Link state={state} />}
      </div>
    </div>
  )
}

function Failure({ state }: { state: SharePanelState & { kind: 'failed' } }) {
  return (
    <>
      <div class="ink-share-body">
        <div class="ink-share-error">
          <b>{state.title}</b>
          {state.detail}
        </div>
        {/* No retry where retrying cannot help: a note is not going to be smaller the second time. */}
        {state.retry && (
          <div><button type="button" class="ink-share-btn ghost" onClick={reshare}>Try again</button></div>
        )}
      </div>
    </>
  )
}

function Link({ state }: { state: Exclude<SharePanelState, { kind: 'failed' | 'stopped' }> }) {
  const linkRef = useRef<HTMLSpanElement>(null)
  // The same two thresholds as the editor: nothing for 180ms, so a fast share never shows this.
  const waiting = usePendingPlaceholder(state.kind === 'creating')
  const link = state.kind === 'creating' ? null : state
  const copied = state.kind === 'ready' && state.copied
  const selectable = state.kind === 'ready' && state.selectable

  // Reports, then stops reporting. Nothing else moves — the panel stays open because the link may
  // be wanted again.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(clearCopied, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])

  // When the clipboard refuses, the link is selected instead so one keystroke finishes the job.
  useEffect(() => {
    if (!selectable) return
    selectAll(linkRef)
  }, [selectable])

  const left = link === null ? 0 : daysLeft(link.expiresAt)

  return (
    <>
      <div class="ink-share-body">
        <div class="ink-share-link">
          {link === null
            ? (
              <span class={`ink-share-url pending${waiting ? ' breathe' : ''}`}>
                <span class="ink-share-urltext">{waiting ? 'making a link…' : ''}</span>
              </span>
            )
            : (
              // Selectable text, not just a button's payload: it is the fallback when the clipboard
              // refuses, and the answer to "what was that link again".
              <span ref={linkRef} class="ink-share-url" onClick={() => { selectAll(linkRef) }}>
                <span class="ink-share-urltext">{link.url.replace(/^https?:\/\//, '')}</span>
              </span>
            )}
          <button
            type="button"
            class="ink-share-btn"
            disabled={link === null}
            onClick={() => { void copyLink(link?.url ?? '') }}
          >
            {copied ? 'Copied' : selectable ? 'Select' : 'Copy'}
          </button>
        </div>

        {/* One sentence carrying both facts, rather than a claim on the left and a clock on the
            right competing for a row neither of them fits in. */}
        <div class="ink-share-meta">
          <span>
            Anyone with the link can read this
            {link !== null && (
              <>
                {' for '}
                <span class={left < NEARLY_GONE_DAYS ? 'ink-share-soon' : undefined}>
                  {left} {left === 1 ? 'day' : 'days'}
                </span>
              </>
            )}.
          </span>
          {link !== null && (
            <span class="ink-share-when">
              {state.kind === 'busy'
                ? 'Updating…'
                // And one control, which says both things it does: the reader's copy becomes the
                // note as it is now, and the clock goes back to thirty.
                : <button type="button" class="ink-share-extend" onClick={reshare}>Update &amp; extend</button>}
            </span>
          )}
        </div>
      </div>

      {/* Text under a hairline, which is what a destructive item looks like everywhere else in this
          app. As a bordered button it was the loudest thing in a panel that is mostly a link. */}
      {link !== null && (
        <div class="ink-share-foot">
          <button type="button" class="ink-share-stop" onClick={() => { void stopSharing() }}>
            Stop sharing
          </button>
        </div>
      )}
    </>
  )
}

function selectAll(ref: RefObject<HTMLSpanElement>): void {
  const el = ref.current
  if (el === null) return
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
