import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import { isPhone } from '../state/ui.js'
import { usePendingPlaceholder } from '../state/pending.js'
import {
  closeLivePanel,
  livePanel,
  livePeers,
  liveSession,
  liveStatus,
  startLive,
  stopLive,
  type LivePanel as PanelState,
} from '../state/live.js'
import '../share/share.css'
import './live.css'

/**
 * The panel a session is started and ended from.
 *
 * **The share panel's own markup**, class for class — scrim, head, body, foot, the selectable link
 * beside one button, the destructive action as text under a hairline. The first version invented its
 * own look and read as a different application: a coloured dot in the head, uppercase mini-labels, a
 * bulleted list of terms, a boxed input for the link. None of those exist anywhere else here.
 *
 * In English, like every other label in this interface.
 *
 * Closing it is not ending the session: the note is behind it, and that is where the collaborating
 * happens.
 */

/** How long the button says `Copied` before going back to `Copy`. */
const COPIED_MS = 2000

export function LivePanel() {
  const state = livePanel.value
  const open = state.kind !== 'closed'

  useLayoutEffect(() => {
    if (!open) return
    // Layout, not plain effect, for the reason the share panel gives: a plain one runs after paint
    // and drops the first Escape.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLivePanel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  if (state.kind === 'closed') return null

  return (
    <div class="ink-share-scrim" onClick={closeLivePanel}>
      <div
        class={`ink-share${isPhone.value ? ' ink-share--sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Live share"
        onClick={(e) => { e.stopPropagation() }}
      >
        <div class="ink-share-head">
          <span class="ink-share-title">Live share</span>
          <button type="button" class="ink-iconbtn" aria-label="Close live share" onClick={closeLivePanel}>✕</button>
        </div>
        <Body state={state} />
      </div>
    </div>
  )
}

function Body({ state }: { state: Exclude<PanelState, { kind: 'closed' }> }) {
  if (state.kind === 'offer') return <Offer state={state} />
  if (state.kind === 'starting' || state.kind === 'running') return <Running state={state} />
  if (state.kind === 'ended') return <Ended state={state} />
  return (
    <div class="ink-share-body">
      <div class="ink-share-error">
        <b>Could not start</b>
        {state.detail}
      </div>
    </div>
  )
}

/** What pressing the button will do, said before it is pressed. */
function Offer({ state }: { state: PanelState & { kind: 'offer' } }) {
  return (
    <div class="ink-share-body">
      <div class="ink-share-note">
        <b>Anyone with the link can edit this note with you</b>
        They do not sign in, and they see nothing else in this vault. While the session runs this
        note does not save or commit — it is written once, when the session ends — and its markdown
        syntax stops revealing itself, because those characters would travel to everyone.
      </div>
      <div>
        <button
          type="button"
          class="ink-share-btn"
          onClick={() => { void startLive(state.path, state.title) }}
        >
          Start
        </button>
      </div>
    </div>
  )
}

function Running({ state }: { state: PanelState & { kind: 'running' | 'starting' } }) {
  const linkRef = useRef<HTMLSpanElement>(null)
  const tokenRef = useRef<HTMLSpanElement>(null)
  /*
   * Hidden until asked for.
   *
   * It is a credential, and this panel is open while somebody is reading a link off their screen to
   * the person next to them. The link is for people and the token is for a program: one of them is
   * safe to have in the room and the other is not.
   */
  const [tokenShown, setTokenShown] = useState(false)
  const session = liveSession.value
  const waiting = usePendingPlaceholder(state.kind === 'starting')
  const copied = state.kind === 'running' && state.copied
  const selectable = state.kind === 'running' && state.selectable === true
  const url = session === null ? null : `${location.origin}/live/${session.id}`

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => {
      if (livePanel.value.kind === 'running') livePanel.value = { kind: 'running', copied: false }
    }, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])

  useEffect(() => {
    if (!selectable) return
    selectAll(linkRef)
  }, [selectable])

  const copy = () => {
    if (url === null) return
    // Nothing touches the clipboard before a press: a press *is* the gesture iOS wants. The share
    // panel learned this the hard way — see `docs/design/sharing.md`.
    void navigator.clipboard?.writeText(url).then(
      () => { livePanel.value = { kind: 'running', copied: true } },
      () => { livePanel.value = { kind: 'running', copied: false, selectable: true } },
    )
  }

  // Everyone but us. "1 person" with nobody there reads wrong.
  const others = Math.max(0, livePeers.value.length - 1)
  const dropped = liveStatus.value === 'retrying' || liveStatus.value === 'connecting'

  return (
    <>
      <div class="ink-share-body">
        <div class="ink-share-link">
          {url === null
            ? (
              <span class={`ink-share-url pending${waiting ? ' breathe' : ''}`}>
                <span class="ink-share-urltext">{waiting ? 'opening a session…' : ''}</span>
              </span>
            )
            : (
              <span ref={linkRef} class="ink-share-url" onClick={() => { selectAll(linkRef) }}>
                <span class="ink-share-urltext">{url.replace(/^https?:\/\//, '')}</span>
              </span>
            )}
          <button type="button" class="ink-share-btn" disabled={url === null} onClick={copy}>
            {copied ? 'Copied' : selectable ? 'Select' : 'Copy'}
          </button>
        </div>

        {/* One sentence carrying both facts, as the share panel's does. */}
        <div class="ink-share-meta">
          <span>
            {dropped
              ? 'Reconnecting. The server holds the note for a few minutes and the others keep editing.'
              : others === 0
                ? 'Anyone with the link can edit this while the session is open.'
                : `Editing with you: ${others} ${others === 1 ? 'person' : 'people'}.`}
          </span>
        </div>

        {session !== null && (
          <div class="ink-live-token">
            <span class="ink-live-token-label">Agent token</span>
            <span
              ref={tokenRef}
              class={tokenShown ? 'ink-live-token-value' : 'ink-live-token-value hidden'}
              onClick={() => { if (tokenShown) selectAll(tokenRef) }}
            >
              {tokenShown ? session.agentToken : '••••••••••••••••'}
            </span>
            <button
              type="button"
              class="ink-live-token-show"
              onClick={() => { setTokenShown(!tokenShown) }}
            >
              {tokenShown ? 'Hide' : 'Show'}
            </button>
          </div>
        )}

        {others > 0 && (
          <div class="ink-live-who">
            {livePeers.value.map((one, at) => (
              <span class="ink-live-one" key={`${one.name}-${at}`}>
                <span class="ink-live-pip" style={{ background: one.color }} aria-hidden="true" />
                {one.name === 'me' ? 'You' : one.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {session !== null && (
        <div class="ink-share-foot">
          <button type="button" class="ink-share-stop" onClick={() => { void stopLive() }}>
            End session
          </button>
        </div>
      )}
    </>
  )
}

/**
 * Reports rather than closing.
 *
 * Everything ending changes is somewhere the owner cannot see — a link in somebody else's hands, a
 * commit in the history — so a panel that simply vanished would be indistinguishable from a button
 * that did nothing.
 */
function Ended({ state }: { state: PanelState & { kind: 'ended' } }) {
  return (
    <div class="ink-share-body">
      <div class="ink-share-note">
        <b>Session ended</b>
        {state.saved
          ? 'The note is saved, with one commit for the whole session, and saving works as usual again.'
          : 'Saving failed — the text is still in the editor. Press Cmd/Ctrl+S to try again.'}
        {state.guests > 0 && (
          <>
            {' '}
            The link no longer works; {state.guests === 1 ? 'the person' : `the ${state.guests} people`}
            {' '}still on it {state.guests === 1 ? 'sees' : 'see'} that it ended, and can only read.
          </>
        )}
      </div>
    </div>
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
