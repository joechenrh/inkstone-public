import { IconUsers } from '../components/icons.js'
import { liveHere, livePeers, liveStatus, openLivePanel } from '../state/live.js'
import './live.css'

/**
 * What says a session is running, on the owner's own screen.
 *
 * Two marks, because a session is two facts in two places: the bar says there is one and opens it,
 * the status bar says what it is doing to the note. Neither appears unless the open note is the one
 * the session is about.
 *
 * **The faces are Overleaf's**, which is what was asked for and is the right reference: a small
 * solid disc per person in their own colour, one initial in white, overlapped by about a third with
 * a ring of the page behind each so the stack reads as separate people. Asked for after the first
 * version was reported — what was wrong there was the *pill* those discs sat in, a bordered,
 * rounded container that exists nowhere else in this interface, not the discs themselves.
 *
 * With nobody else in the room there is nobody to draw, so the button falls back to the icon with
 * a lit dot: the session still has to be visible when it is only yours.
 *
 * The status bar is plain muted words at the counters' own size, separated by the strip's own gap.
 */

/** In the top bar: who is here, as Overleaf draws it, or the icon when it is only you. */
export function LiveTopMark() {
  const here = liveHere.value
  if (here === null) return null
  const dropped = liveStatus.value === 'retrying' || liveStatus.value === 'connecting'
  const others = livePeers.value.filter((one) => one.name !== 'me')
  const who = others.length === 0
    ? 'nobody else yet'
    : others.map((one) => one.name).join(', ')

  return (
    <button
      type="button"
      class="ink-iconbtn ink-live-btn"
      title={dropped ? 'Live session — reconnecting' : `Live session — ${who}`}
      onClick={() => { openLivePanel(here.path, here.title) }}
    >
      {others.length === 0
        ? (
          <>
            <IconUsers />
            {/* The same dot the branch uses for unsaved work, and the only lit thing in the bar. */}
            <span class={dropped ? 'ink-live-led waiting' : 'ink-live-led'} aria-hidden="true" />
          </>
        )
        : (
          <span class="ink-live-faces">
            {others.map((one, at) => (
              <span
                key={`${one.name}-${at}`}
                class="ink-live-face"
                style={{ background: one.color }}
                title={one.name}
              >
                {[...one.name][0] ?? '·'}
              </span>
            ))}
          </span>
        )}
    </button>
  )
}

/** In the status bar: plain words, in the voice of the counters beside them. */
export function LiveStatusMark() {
  const here = liveHere.value
  if (here === null) return null
  const others = livePeers.value.filter((one) => one.name !== 'me').length
  const dropped = liveStatus.value === 'retrying' || liveStatus.value === 'connecting'

  return (
    <>
      <span class="ink-live-status">
        {dropped
          ? 'Reconnecting'
          : others === 0
            ? 'Live'
            : `Live · ${others} ${others === 1 ? 'person' : 'people'}`}
      </span>
      {/* Said rather than left as an absence: the saving everybody relies on has stopped on
          purpose, and an absence nobody explained is an absence nobody trusts. */}
      <span class="ink-live-status">saved when the session ends</span>
    </>
  )
}
