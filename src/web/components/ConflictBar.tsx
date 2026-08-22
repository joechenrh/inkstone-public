import { conflict, resolveConflictKeepMine, resolveConflictTakeDisk } from '../state/document.js'
import './conflictbar.css'

export function ConflictBar() {
  if (!conflict.value) return null
  return (
    <div class="ink-conflict" role="alert">
      <span>This file was changed on disk.</span>
      <button type="button" onClick={resolveConflictTakeDisk}>
        Use disk version
      </button>
      <button type="button" onClick={() => void resolveConflictKeepMine()}>
        Keep mine
      </button>
    </div>
  )
}
