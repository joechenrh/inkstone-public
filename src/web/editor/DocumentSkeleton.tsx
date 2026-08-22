import { loadingPath } from '../state/document.js'
import { usePendingPlaceholder } from '../state/pending.js'
import './document-skeleton.css'

/**
 * The shape a note is about to take, while it is still coming.
 *
 * A centred heading and three lines, because that is what Lapis draws there — a placeholder that
 * matches what replaces it is a transition rather than two unrelated screens.
 *
 * Nothing at all for the first 180ms, which is every open on a local disk (37ms measured) and
 * most on a good connection. Past that it appears, and once up it stays 300ms so an open landing
 * at 190ms does not flash it.
 */
export function DocumentSkeleton() {
  const visible = usePendingPlaceholder(loadingPath.value !== null)
  if (!visible) return null

  return (
    <div class="ink-doc-skeleton" aria-hidden="true">
      <div class="ink-doc-skeleton-inner">
        <div class="ink-doc-skeleton-title" />
        <div class="ink-doc-skeleton-line a" />
        <div class="ink-doc-skeleton-line b" />
        <div class="ink-doc-skeleton-line c" />
      </div>
    </div>
  )
}
