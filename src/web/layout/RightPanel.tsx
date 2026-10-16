import { HistoryPanel } from '../history/HistoryPanel.js'
import './rightpanel.css'

/**
 * The right drawer, which holds the file's history and nothing else.
 *
 * It held two things for one phase: history, and an agent behind a second tab. The agent now lives
 * outside this application entirely — it is whatever program the owner points at a live session's
 * API, see `docs/design/live-agent.md` — so the drawer is back to one view, and the tab strip goes
 * with the tab it was there to choose. A strip with one tab in it is a label that looks pressable.
 *
 * The phone reaches this as a sheet instead; see `PhoneSheet`.
 */
export function RightPanel() {
  return (
    <div class="ink-rightpanel">
      <div class="ink-rightpanel-body"><HistoryPanel /></div>
    </div>
  )
}
