import { describeStatus } from './paste.js'
import type { PasteLine as Line } from './usePaste.js'
import './paste.css'

/**
 * What happened to the picture, under the picture.
 *
 * Two words and a number: what was done, and what it cost. `kept 581 KB → 35 KB · 1600×871` is the
 * whole of it — the verb first, because the reader's question is whether their file was changed,
 * and the numbers after, because a refusal that does not name the size it refused on is a wall.
 */
export function PasteLine({ line }: { line: Line }) {
  const { head, detail } = describeStatus(line.status)
  const kind = line.status.kind
  return (
    <div
      class={`ink-paste-line ink-paste-line--${kind}`}
      // Position only: the pill takes its width from its own text. See `paste.css`.
      style={{ top: `${line.rect.top}px`, left: `${line.rect.left}px` }}
      role="status"
    >
      {head !== '' && <span class="ink-paste-head">{head}</span>}
      <span class="ink-paste-detail">{detail}</span>
    </div>
  )
}
