import { useRef } from 'preact/hooks'
import { IconSearch } from '../components/icons.js'
import { clearSearch, searchQuery, setSearchQuery } from '../state/search.js'
import './search.css'

/**
 * One field, both depths.
 *
 * Typing searches names and text together — there is no second key to press, because there was
 * never a second question. The results replace the tree in this same panel; clearing brings it
 * back. The same component is the first thing on the phone's list screen.
 */
export function SearchField() {
  const inputRef = useRef<HTMLInputElement>(null)
  const q = searchQuery.value

  return (
    <div class="ink-search">
      <IconSearch size={15} />
      <input
        ref={inputRef}
        type="search"
        class="ink-search-input"
        placeholder="Search notes"
        aria-label="Search notes by name and by their text"
        value={q}
        onInput={(e) => { setSearchQuery((e.target as HTMLInputElement).value) }}
        onKeyDown={(e) => {
          // Escape clears rather than blurring: the query is the thing in the way, not the focus.
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            clearSearch()
          }
        }}
      />
      {q !== '' && (
        <button
          type="button"
          class="ink-search-clear"
          aria-label="Clear search"
          onClick={() => { clearSearch(); inputRef.current?.focus() }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
