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
 * **In the application's own vocabulary**, which the first version was not. That one put a
 * bordered pill in the top bar with a filled disc of somebody's initial beside it, and a green dot
 * with a hairline divider in the status bar — three shapes that exist nowhere else here, and the
 * loudest things on the screen in the two quietest strips of it. Reported, twice. The top bar is
 * icon buttons and text; the status bar is plain muted words with a gap between them. So that is
 * what these are.
 */

/** In the top bar: one more icon button, lit while a session is running. */
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
      <IconUsers />
      {/* The one lit thing, and the same dot the branch uses for unsaved work. */}
      <span class={dropped ? 'ink-live-led waiting' : 'ink-live-led'} aria-hidden="true" />
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
