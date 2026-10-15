import { useEffect, useRef } from 'preact/hooks'
import {
  closeLivePanel,
  livePanel,
  livePeers,
  liveSession,
  liveStatus,
  startLive,
  stopLive,
} from '../state/live.js'
import './live.css'

/**
 * The panel the owner starts and ends a session from.
 *
 * The commit panel's shape, because that is this application's shape for a thing you need to look
 * at: a centred modal on a desktop, a sheet on a phone, a lid and a base of the same height. See
 * `docs/design/sharing.md` for why the two edges matching matters.
 *
 * **Ending reports rather than closing.** Everything it changes is somewhere the owner cannot see —
 * a link in somebody else's hands, a commit in the history — so a panel that simply vanished would
 * be indistinguishable from a button that did nothing. Sharing learned this the same way.
 */
export function LivePanel() {
  const state = livePanel.value
  const linkRef = useRef<HTMLInputElement>(null)
  const open = state.kind !== 'closed'

  /*
   * Escape closes it, and closing it is not ending the session.
   *
   * The panel is modal — it has to be, it is how the link is read — and the first version had no
   * way out of the running state but `结束协作`. So the only way to get back to the note you were
   * collaborating on was to stop collaborating on it.
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLivePanel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  if (state.kind === 'closed') return null

  const session = liveSession.value
  const url = session === null ? '' : `${location.origin}/live/${session.id}`

  const copy = () => {
    if (state.kind !== 'running') return
    // A press *is* the gesture iOS wants; nothing touches the clipboard before one. See the note in
    // `docs/design/sharing.md` — the first version of the share panel copied automatically and
    // failed on every phone.
    void navigator.clipboard?.writeText(url).then(
      () => { livePanel.value = { kind: 'running', copied: true } },
      () => {
        // A refusal with an obvious manual fix is not worth a sentence: select it and say nothing.
        linkRef.current?.select()
      },
    )
    if (state.copied) return
    window.setTimeout(() => {
      if (livePanel.value.kind === 'running') livePanel.value = { kind: 'running', copied: false }
    }, 2000)
  }

  return (
    <div class="ink-live-modal" role="dialog" aria-modal="true" aria-label="Live share">
      <div class="ink-live-card">
        {state.kind === 'offer' && (
          <>
            <div class="ink-live-card-head">
              <span>一起编辑 · {state.title}</span>
              <button type="button" class="ink-live-x" aria-label="关闭" onClick={closeLivePanel}>✕</button>
            </div>
            <div class="ink-live-card-body">
              <p class="ink-live-intro">
                生成一个链接。拿到链接的人<strong>无需登录</strong>即可和你同时编辑这一篇。
              </p>
              <ul class="ink-live-terms">
                <li>会话期间这篇的提交暂停，结束时提交一次</li>
                <li>会话期间语法不展开（加粗不显示 <code>**</code>）</li>
                <li>最多 8 人，空闲 30 分钟自动结束</li>
              </ul>
            </div>
            <div class="ink-live-card-foot ink-live-card-foot-pair">
              <button type="button" class="ink-live-quiet" onClick={closeLivePanel}>取消</button>
              <button
                type="button"
                class="ink-live-go"
                onClick={() => { void startLive(state.path, state.title) }}
              >
                开始协作
              </button>
            </div>
          </>
        )}

        {state.kind === 'starting' && (
          <>
            <div class="ink-live-card-head"><span>正在开始…</span></div>
            <div class="ink-live-card-body">
              <p class="ink-live-intro">先保存这一篇，再开一个房间。</p>
            </div>
            <div class="ink-live-card-foot" />
          </>
        )}

        {state.kind === 'running' && session !== null && (
          <>
            <div class="ink-live-card-head">
              <span class={liveStatus.value === 'live' ? 'ink-live-dot' : 'ink-live-dot ink-live-dot-warn'} aria-hidden="true" />
              <span>{liveStatus.value === 'live' ? '协作中' : '连接断了'} · {session.title}</span>
              {/* Closing the panel leaves the session running: the note is behind it, and that is
                  where the collaborating happens. */}
              <button type="button" class="ink-live-x" aria-label="关闭" onClick={closeLivePanel}>✕</button>
            </div>
            <div class="ink-live-card-body">
              <div class="ink-live-linkrow">
                <label class="ink-live-hidden" for="ink-live-link">协作链接</label>
                <input id="ink-live-link" ref={linkRef} class="ink-live-link" readOnly value={url} />
                {/* Never changes width or colour — only the word. Three changes to say one thing
                    made the share panel twitch on every press. */}
                <button type="button" class="ink-live-go ink-live-copy" onClick={copy}>
                  {state.copied ? '已复制' : '复制'}
                </button>
              </div>

              {liveStatus.value === 'retrying' && (
                <p class="ink-live-note">
                  连接断了，正在重连。服务器替你把文档撑着几分钟，这段时间对方照改；超时会话就结束，
                  对方页面变只读，你回来时把结果落盘。
                </p>
              )}

              <span class="ink-live-label">在线 {livePeers.value.length} 人</span>
              <div class="ink-live-who">
                {livePeers.value.map((one, at) => (
                  <div class="ink-live-one" key={`${one.name}-${at}`}>
                    <span class="ink-live-pip" style={{ background: one.color }} aria-hidden="true" />
                    <span>{one.name === 'me' ? '我' : one.name}</span>
                  </div>
                ))}
              </div>
            </div>
            <div class="ink-live-card-foot ink-live-card-foot-pair">
              <span class="ink-live-fine">链接只在会话期间有效</span>
              <button type="button" class="ink-live-stop" onClick={() => { void stopLive() }}>
                结束协作
              </button>
            </div>
          </>
        )}

        {state.kind === 'ended' && (
          <>
            <div class="ink-live-card-head"><span>协作已结束</span></div>
            <div class="ink-live-card-body">
              <p class="ink-live-line">
                {state.saved ? '已保存并提交一次。' : '保存失败了 —— 文本还在编辑器里，按 Cmd/Ctrl+S 再试。'}
              </p>
              <p class="ink-live-line">这篇的提交恢复正常。</p>
              <p class="ink-live-line">
                链接已失效{state.guests > 0 ? `，还开着页面的 ${state.guests} 人看到「协作已结束」，内容变只读` : ''}。
              </p>
              <p class="ink-live-note">别人改坏了？历史里这一条可以整条回退。</p>
            </div>
            <div class="ink-live-card-foot">
              <button type="button" class="ink-live-go" onClick={closeLivePanel}>好</button>
            </div>
          </>
        )}

        {state.kind === 'failed' && (
          <>
            <div class="ink-live-card-head"><span>没能开始</span></div>
            <div class="ink-live-card-body">
              <p class="ink-live-line">{state.detail}</p>
            </div>
            <div class="ink-live-card-foot">
              <button type="button" class="ink-live-go" onClick={closeLivePanel}>好</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
