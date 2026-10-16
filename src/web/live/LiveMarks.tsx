import { liveHere, livePeers, liveStatus, openLivePanel } from '../state/live.js'
import './live.css'

/**
 * What says a session is running, on the owner's own screen.
 *
 * Two marks, because a session is two facts in two places. The bar says *who* — the note's own
 * heading is where the people editing it belong, and the faces are the only presence list a desktop
 * needs while the panel is shut. The status bar says what the session is doing to the application:
 * this note is not being saved or committed until it ends, which is a thing somebody will otherwise
 * notice as an absence and mistrust.
 *
 * Both are the way in, as sharing's menu item is: the state is the control. Neither appears unless
 * the open note is the one the session is about.
 *
 * The first version had neither, and a session looked exactly like no session — reported as the
 * interface losing what the design had at the top and the bottom, which it had.
 */

/** In the top bar, beside the note's name: who is here. */
export function LiveTopMark() {
  const here = liveHere.value
  if (here === null) return null
  const dropped = liveStatus.value === 'retrying' || liveStatus.value === 'connecting'
  const others = livePeers.value.filter((one) => one.name !== 'me')

  return (
    <button
      type="button"
      class="ink-live-mark"
      title={dropped ? 'Reconnecting — open the session' : 'Open the live session'}
      onClick={() => { openLivePanel(here.path, here.title) }}
    >
      <span class={dropped ? 'ink-live-led waiting' : 'ink-live-led'} aria-hidden="true" />
      <span class="ink-live-mark-text">{dropped ? 'Reconnecting' : 'Live'}</span>
      {others.length > 0 && (
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

/** In the status bar: what the session is doing to this note. */
export function LiveStatusMark() {
  const here = liveHere.value
  if (here === null) return null
  const others = livePeers.value.filter((one) => one.name !== 'me').length
  const dropped = liveStatus.value === 'retrying' || liveStatus.value === 'connecting'

  return (
    <span class="ink-live-status">
      <span class={dropped ? 'ink-live-led waiting' : 'ink-live-led'} aria-hidden="true" />
      <span>
        {dropped
          ? 'Reconnecting'
          : others === 0
            ? 'Live · waiting for others'
            : `Live · ${others} ${others === 1 ? 'person' : 'people'}`}
      </span>
      {/* Said here rather than nowhere: the saving everybody relies on has stopped on purpose, and
          an absence nobody explained is an absence nobody trusts. */}
      <span class="ink-live-status-aside">saving when the session ends</span>
    </span>
  )
}
