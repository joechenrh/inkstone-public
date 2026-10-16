import { useEffect, useState } from 'preact/hooks'
import { CrepeEditor } from '../editor/CrepeEditor.js'
import { content } from '../state/document.js'
import { viewMode } from '../state/settings.js'
import { sessionMeta, type LiveMeta } from './api.js'
import { connectLive, type LiveUser, type LiveWire } from './provider.js'
import '../share/shared.css'
import './live.css'

/**
 * The page a guest opens, which is the only page in this application a stranger can write through.
 *
 * **The shared page's own chrome**, class for class: `ink-shared` with its bar, its brand, its kind
 * label and its `ink-shared-gone` for every way a link can fail. The first version invented a bar
 * of its own and read as a different application — see the note on `LivePanel`, which was the same
 * mistake. What is genuinely new here is a presence row and a name card, and only those are new CSS.
 *
 * It has the editor and nothing else: no tree, no history, no settings, no agent. A guest is here
 * for one note and has no vault behind them — see `CrepeEditor`'s `guest`, which is what keeps the
 * first keystroke from trying to save a file this browser has no credential for.
 *
 * **A name before a caret.** Joining asks who you are, because the whole point of the cursors is
 * that the others can tell them apart. The default is offered rather than demanded: pressing the
 * button with it unchanged is a perfectly good answer.
 */

/** Distinct in lightness as well as hue, so two carets are told apart on a greyscale screen too. */
const COLORS: { name: string; value: string }[] = [
  { name: 'Amber', value: '#9a6b1f' },
  { name: 'Green', value: '#2f7d5d' },
  { name: 'Purple', value: '#7a4fa3' },
  { name: 'Brick', value: '#b04a52' },
]

export function LiveNote({ id }: { id: string }) {
  const [meta, setMeta] = useState<LiveMeta | null | 'asking'>('asking')
  const [wire, setWire] = useState<LiveWire | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0]!.value)

  useEffect(() => {
    let dropped = false
    void sessionMeta(id).then((found) => {
      if (dropped) return
      setMeta(found)
      // "Guest 2" rather than "Guest 1": the owner is the first person in the room.
      if (found !== null) setName(`Guest ${found.guests + 2}`)
    })
    return () => { dropped = true }
  }, [id])

  // The guest's editor starts empty and fills from the room. Set before the editor mounts, because
  // what it is built with is what it would otherwise offer the session as a template.
  useEffect(() => { content.value = '' }, [])

  useEffect(() => {
    if (wire === null) return
    return () => { wire.destroy() }
  }, [wire])

  const join = () => {
    const user: LiveUser = { name: name.trim() === '' ? 'Guest' : name.trim(), color }
    setWire(connectLive({ id, user }))
  }

  if (meta === 'asking') {
    return (
      <div class="ink-shared">
        <Bar meta={null} />
        <div class="ink-shared-body" aria-hidden="true">
          <div class="ink-shared-skel title" />
          <div class="ink-shared-skel a" />
          <div class="ink-shared-skel b" />
        </div>
      </div>
    )
  }

  if (meta === null) {
    return (
      <Gone
        title="This link does not work"
        detail="It may have ended, or it may never have existed. Ask whoever sent it for a new one."
      />
    )
  }

  if (wire !== null) return <Joined id={id} meta={meta} wire={wire} />

  if (meta.full) {
    return (
      <Gone
        title="This session is full"
        detail="Eight people at a time. Try again when somebody leaves."
      />
    )
  }

  return (
    <div class="ink-shared">
      <Bar meta={meta} />
      <div class="ink-shared-body">
        <div class="ink-live-gate">
          <div class="ink-live-join">
            <p class="ink-live-join-head">
              <b>{meta.owner ?? 'Someone'}</b> shared <b>{meta.title}</b> for you to edit together.
            </p>
            <label class="ink-live-join-label" for="ink-live-name">Your name</label>
            <input
              id="ink-live-name"
              class="ink-live-join-name"
              value={name}
              onInput={(e) => { setName((e.target as HTMLInputElement).value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') join() }}
            />
            <span class="ink-live-join-label">Cursor colour</span>
            <div class="ink-live-join-colors">
              {COLORS.map((one) => (
                <button
                  key={one.value}
                  type="button"
                  aria-label={one.name}
                  aria-pressed={color === one.value}
                  class={color === one.value ? 'ink-live-swatch on' : 'ink-live-swatch'}
                  style={{ background: one.value }}
                  onClick={() => { setColor(one.value) }}
                />
              ))}
            </div>
            <p class="ink-live-join-fine">
              No account needed. You cannot see anything else in this vault, and nothing is kept on
              this device.
            </p>
            <button type="button" class="ink-share-btn" onClick={join}>Join</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The note, once this browser is in the room. */
function Joined({ id, meta, wire }: { id: string; meta: LiveMeta; wire: LiveWire }) {
  const status = wire.status.value
  const over = status === 'ended' || status === 'held' || status === 'gone'

  // Read-only once it is over: what is on screen is the last thing that was true, and letting
  // somebody type into a room nobody is listening to is the cruellest possible interface.
  useEffect(() => { viewMode.value = over ? 'read' : 'edit' }, [over])

  const said = over
    ? `This session has ended. ${meta.owner ?? 'The owner'} saved it; what is here is how it was left.`
    : status === 'retrying' || status === 'connecting'
      ? 'Reconnecting…'
      : status === 'full'
        ? 'This session is full. Try again when somebody leaves.'
        : null

  return (
    <div class="ink-shared">
      <Bar meta={meta} peers={wire.peers.value} />
      {said !== null && <div class="ink-live-said" role="status">{said}</div>}
      <div class="ink-shared-body">
        <CrepeEditor key={`live-${id}`} collab={wire} guest />
      </div>
    </div>
  )
}

function Bar({ meta, peers = [] }: { meta: LiveMeta | null; peers?: LiveUser[] }) {
  return (
    <header class="ink-shared-bar">
      <span class="ink-shared-brand">Inkstone</span>
      <span class="ink-shared-kind">{meta === null ? 'live note' : `editing ${meta.title}`}</span>
      {peers.length > 0 && (
        <span class="ink-live-faces">
          {peers.map((one, at) => (
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
    </header>
  )
}

function Gone({ title, detail }: { title: string; detail: string }) {
  return (
    <div class="ink-shared">
      <Bar meta={null} />
      <div class="ink-shared-gone">
        <p class="ink-shared-gone-title">{title}</p>
        <p class="ink-shared-gone-detail">{detail}</p>
      </div>
    </div>
  )
}
