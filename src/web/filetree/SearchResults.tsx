import type { SearchMatch, VaultEntry } from '../../shared/types.js'
import {
  corpusLoading,
  corpusTruncated,
  corpusVersion,
  matchingNames,
  matchingText,
  searchQuery,
} from '../state/search.js'
import { tree } from '../state/vault.js'
import './search.css'

/** "notes/deep/file.md" → "notes / deep" */
function where(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.length ? parts.join(' / ') : 'Vault root'
}

/**
 * The matching text with the query marked.
 *
 * Split on the literal query rather than rebuilt with a regex: the query is whatever was typed,
 * and `co_await(` is a reasonable thing to look for and an invalid pattern.
 */
function Marked({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at === -1 || query === '') return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  )
}

function Hit(
  { path, name, excerpt, query, onOpen }:
  { path: string; name: string; excerpt?: string; query: string; onOpen: (p: string) => void },
) {
  return (
    <button type="button" class="ink-search-hit" onClick={() => { onOpen(path) }}>
      <span class="ink-search-hit-head">
        <span class="ink-search-hit-name"><Marked text={name} query={query} /></span>
        <span class="ink-search-hit-where">{where(path)}</span>
      </span>
      {excerpt !== undefined && (
        <span class="ink-search-hit-line"><Marked text={excerpt} query={query} /></span>
      )}
    </button>
  )
}

export function SearchResults({ onOpen }: { onOpen: (path: string) => void }) {
  const query = searchQuery.value.trim()
  // Read so the list re-runs once the vault's text has arrived, on the one search that asked for it.
  corpusVersion.value

  const named: VaultEntry[] = matchingNames(tree.value ?? [], query)
  const namedPaths = new Set(named.map((e) => e.path))
  const allMatches: SearchMatch[] = matchingText(query)

  // A note whose name matched is listed once, above — carrying its excerpt if the text matched too.
  const excerptFor = new Map(allMatches.map((m) => [m.path, m]))
  const inText: SearchMatch[] = allMatches.filter((m) => !namedPaths.has(m.path))

  if (named.length === 0 && inText.length === 0) {
    // Only ever said once the text is here to be searched — claiming nothing matches while the
    // vault is still arriving is a wrong answer, not a slow one.
    return (
      <div class="ink-search-note">
        {corpusLoading.value ? 'Loading the vault…' : `Nothing matches “${query}”.`}
      </div>
    )
  }

  return (
    <div class="ink-search-results">
      {named.length > 0 && (
        <>
          <div class="ink-search-group">Notes</div>
          {named.map((e) => (
            <Hit
              key={e.path}
              path={e.path}
              name={e.name}
              excerpt={excerptFor.get(e.path)?.text}
              query={query}
              onOpen={onOpen}
            />
          ))}
        </>
      )}

      {inText.length > 0 && (
        <>
          <div class="ink-search-group">In the text</div>
          {inText.map((m) => (
            <Hit
              key={`${m.path}:${m.line}`}
              path={m.path}
              name={m.path.split('/').pop() ?? m.path}
              excerpt={m.text}
              query={query}
              onOpen={onOpen}
            />
          ))}
        </>
      )}

      {corpusTruncated.value && (
        <div class="ink-search-note">This vault is larger than search covers; some notes are not included.</div>
      )}
    </div>
  )
}
