import { AgentPanel } from '../agent/AgentPanel.js'
import { HistoryPanel } from '../history/HistoryPanel.js'
import { rightTab } from '../state/ui.js'
import './rightpanel.css'

/**
 * The right drawer, which now holds two things.
 *
 * It held exactly one for two phases, so the toggle was the whole control. A second view needs a
 * way to choose between them, and this is the smallest one that does not spend anything in the top
 * bar — the drawer already has a top edge, and a feature this size earns one row and a drawer that
 * already exists, not a button beside the sidebar toggle.
 *
 * The phone reaches both of these as sheets instead; see `PhoneSheet`.
 */
export function RightPanel() {
  const tab = rightTab.value

  return (
    <div class="ink-rightpanel">
      <div class="ink-rightpanel-tabs" role="tablist" aria-label="Right panel">
        {(['history', 'agent'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            class={`ink-rightpanel-tab${tab === id ? ' on' : ''}`}
            aria-selected={tab === id}
            onClick={() => { rightTab.value = id }}
          >
            {id === 'history' ? 'History' : 'Agent'}
          </button>
        ))}
      </div>
      {/* Both stay mounted. The agent's turn is held in a signal and survives either way, but the
          history panel refetches on mount — switching tabs to read an answer and back should not
          cost a round trip and a collapsed session. */}
      <div class="ink-rightpanel-body" hidden={tab !== 'history'}><HistoryPanel /></div>
      <div class="ink-rightpanel-body" hidden={tab !== 'agent'}><AgentPanel /></div>
    </div>
  )
}
