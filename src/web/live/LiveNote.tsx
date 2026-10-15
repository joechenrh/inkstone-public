import { useEffect, useState } from 'preact/hooks'
import { CrepeEditor } from '../editor/CrepeEditor.js'
import { content } from '../state/document.js'
import { viewMode } from '../state/settings.js'
import { sessionMeta, type LiveMeta } from './api.js'
import { connectLive, type LiveUser, type LiveWire } from './provider.js'
import './live.css'

/**
 * The page a guest opens, which is the only page in this application a stranger can write through.
 *
 * It has the editor and nothing else: no tree, no history, no settings, no agent. A guest is here
 * for one note and has no vault behind them — see `CrepeEditor`'s `guest`, which is what keeps the
 * first keystroke from trying to save a file this browser has no credential for.
 *
 * **A name before a caret.** Joining asks who you are, because the whole point of the cursors is
 * that the owner can tell them apart, and "Anonymous" twice over tells them nothing. The default is
 * offered rather than demanded: pressing the button with it unchanged is a perfectly good answer.
 */

/** Distinct in lightness as well as hue, so two carets are told apart on a greyscale screen too. */
const COLORS: { name: string; value: string }[] = [
  { name: '琥珀', value: '#9a6b1f' },
  { name: '绿', value: '#2f7d5d' },
  { name: '紫', value: '#7a4fa3' },
  { name: '砖红', value: '#b04a52' },
]

type Stage =
  | { kind: 'asking' }
  | { kind: 'joining' }
  | { kind: 'in'; wire: LiveWire }
  | { kind: 'no' }

export function LiveNote({ id }: { id: string }) {
  const [meta, setMeta] = useState<LiveMeta | null | 'asking'>('asking')
  const [stage, setStage] = useState<Stage>({ kind: 'asking' })
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0]!.value)

  useEffect(() => {
    let dropped = false
    void sessionMeta(id).then((found) => {
      if (dropped) return
      setMeta(found)
      // "访客 2" rather than "访客 1": the owner is the first person in the room.
      if (found !== null) setName(`访客 ${found.guests + 2}`)
    })
    return () => { dropped = true }
  }, [id])

  // The guest's editor starts empty and fills from the room. Set before the editor mounts, because
  // what it is built with is what it would otherwise offer the session as a template.
  useEffect(() => { content.value = '' }, [])

  const join = () => {
    const user: LiveUser = { name: name.trim() === '' ? '访客' : name.trim(), color }
    setStage({ kind: 'joining' })
    const wire = connectLive({ id, user })
    setStage({ kind: 'in', wire })
  }

  useEffect(() => {
    if (stage.kind !== 'in') return
    const wire = stage.wire
    return () => { wire.destroy() }
  }, [stage.kind])

  if (meta === 'asking') {
    return <div class="ink-live-wait" role="status">正在打开…</div>
  }

  if (meta === null) {
    return (
      <Blank
        title="这个链接用不了"
        detail="它可能已经结束，也可能从来没有存在过。找分享给你的人要一个新的。"
      />
    )
  }

  if (stage.kind === 'in') {
    return <Joined id={id} meta={meta} wire={stage.wire} />
  }

  if (meta.full) {
    return <Blank title="这场协作满了" detail="同时最多 8 人。等有人离开再试一次。" />
  }

  return (
    <div class="ink-live-page">
      <Bar meta={meta} />
      <div class="ink-live-gate">
        <div class="ink-live-card">
          <div class="ink-live-card-head">
            <span class="ink-live-dot" aria-hidden="true" />
            <span>加入协作</span>
          </div>
          <div class="ink-live-card-body">
            <p class="ink-live-intro">
              {meta.owner === null ? '有人' : meta.owner} 分享了 <strong>{meta.title}</strong>，你可以直接改。
            </p>
            <label class="ink-live-label" for="ink-live-name">你叫什么</label>
            <input
              id="ink-live-name"
              class="ink-live-input"
              value={name}
              onInput={(e) => { setName((e.target as HTMLInputElement).value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') join() }}
            />
            <span class="ink-live-label">光标颜色</span>
            <div class="ink-live-colors">
              {COLORS.map((one) => (
                <button
                  key={one.value}
                  type="button"
                  aria-label={one.name}
                  aria-pressed={color === one.value}
                  class={color === one.value ? 'ink-live-color ink-live-color-on' : 'ink-live-color'}
                  style={{ background: one.value }}
                  onClick={() => { setColor(one.value) }}
                />
              ))}
            </div>
            <p class="ink-live-note">
              不需要登录。你看不到这个库里的其他文件。
            </p>
          </div>
          <div class="ink-live-card-foot">
            <button type="button" class="ink-live-go" onClick={join} disabled={stage.kind === 'joining'}>
              {stage.kind === 'joining' ? '正在加入…' : '加入'}
            </button>
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

  return (
    <div class="ink-live-page">
      <Bar meta={meta} peers={wire.peers.value} />
      {over && (
        <div class="ink-live-banner ink-live-banner-over" role="status">
          <span class="ink-live-dot ink-live-dot-warn" aria-hidden="true" />
          <span>
            协作已结束。{meta.owner === null ? '对方' : meta.owner}已保存，内容是最后那一刻的样子。
          </span>
        </div>
      )}
      {status === 'retrying' && (
        <div class="ink-live-banner" role="status">
          <span class="ink-live-dot ink-live-dot-warn" aria-hidden="true" />
          <span>连接断了，正在重连…</span>
        </div>
      )}
      {status === 'full' && (
        <div class="ink-live-banner" role="status">
          <span class="ink-live-dot ink-live-dot-warn" aria-hidden="true" />
          <span>这场协作满了，等有人离开再刷新。</span>
        </div>
      )}
      {status === 'live' && (
        <div class="ink-live-banner ink-live-banner-ok" role="status">
          <span class="ink-live-dot" aria-hidden="true" />
          <span>
            和 {meta.owner === null ? '对方' : meta.owner} 一起编辑 · {wire.peers.value.length} 人
          </span>
        </div>
      )}
      <CrepeEditor key={`live-${id}`} collab={wire} guest />
    </div>
  )
}

function Bar({ meta, peers = [] }: { meta: LiveMeta; peers?: LiveUser[] }) {
  return (
    <div class="ink-live-bar">
      <div class="ink-live-bar-left">
        <span class="ink-live-title">{meta.title}</span>
        {meta.owner !== null && <span class="ink-live-by">由 {meta.owner} 分享</span>}
      </div>
      <div class="ink-live-faces">
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
      </div>
    </div>
  )
}

function Blank({ title, detail }: { title: string; detail: string }) {
  return (
    <div class="ink-live-blank">
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
  )
}
