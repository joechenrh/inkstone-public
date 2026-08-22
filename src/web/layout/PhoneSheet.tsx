import { useLayoutEffect } from 'preact/hooks'
import { AgentPanel } from '../agent/AgentPanel.js'
import { byteSize, HistoryPanel, relative } from '../history/HistoryPanel.js'
import { content, modifiedAt } from '../state/document.js'
import { OutlinePanel } from '../outline/OutlinePanel.js'
import { closePhoneSheet, phoneSheet } from '../state/ui.js'
import './phonesheet.css'

/**
 * A panel over the document, on a phone.
 *
 * One component, three kinds of content: the outline, the file's history, and the agent. The first
 * two were screens that replaced the note — the outline lived on the list screen, and history had
 * no way back at all except the menu that opened it. The agent is here rather than in a drawer for
 * the same reason, and because the phone is a first-class client of it: it reaches the same agent
 * the desktop does, on a machine the person is not sitting at. Dismissed by the scrim, by its close button, and — for the
 * outline — by picking a heading, which is the only reason it was opened.
 */
export function PhoneSheet() {
  const which = phoneSheet.value

  useLayoutEffect(() => {
    if (which === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closePhoneSheet()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [which])

  if (which === null) return null

  const title = which === 'outline' ? 'Outline' : which === 'agent' ? 'Agent' : 'History'

  // The note's modified time and size, on the title row rather than as a block above the log.
  // Inside a sheet called History they were a section that was not history — two blocks stacked
  // where one was asked for. As a subtitle nothing is lost and there is one heading.
  const subtitle = which === 'history' && modifiedAt.value !== null
    ? `${relative(modifiedAt.value)} · ${byteSize(content.value)}`
    : null

  return (
    <div class="ink-sheet-scrim" onClick={closePhoneSheet}>
      <div
        // The outline is read from the document as it renders, so its height is known at once
        // and the box can fit it. History fetches, and keeps the fixed detent.
        class={`ink-sheet${which === 'outline' ? ' ink-sheet--fits' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => { e.stopPropagation() }}
      >
        <div class="ink-sheet-head">
          <span class="ink-sheet-title">{title}</span>
          {subtitle !== null && <span class="ink-sheet-sub">{subtitle}</span>}
          <button
            type="button"
            class="ink-iconbtn"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={closePhoneSheet}
          >
            ✕
          </button>
        </div>
        <div class="ink-sheet-body">
          {which === 'outline'
            // Picking a heading is the whole point of opening this, so it closes on the way.
            ? <OutlinePanel onJump={closePhoneSheet} />
            : which === 'agent'
              ? <AgentPanel />
              : <HistoryPanel />}
        </div>
      </div>
    </div>
  )
}
