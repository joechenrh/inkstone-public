import { useState } from 'preact/hooks'
import { useBackend } from '../api/index.js'
import { createGitHubBackend } from '../api/github/backend.js'
import { chosenRepo, identityProvider, session, type IdentityProvider } from '../auth/identity.js'
import type { SharedNote as Note } from './api.js'
import { saveCopy, type Save } from './save.js'

/** Where a reader's copy lands. One folder, named for what is in it. */
const FOLDER = 'shared'

/**
 * The one thing to do with a shared note.
 *
 * Under the note, never over it: a reader who never signs in should be able to read to the end
 * without stepping around an advertisement. On a phone it is full width at the bottom of the
 * note and scrolls with it — a fixed bar over a phone-sized note covers a tenth of it.
 */
export function SaveBar({ note, identity, onNeedRepo }: {
  note: Note & { ok: true }
  identity: IdentityProvider | null
  onNeedRepo: () => void
}) {
  const [save, setSave] = useState<Save>({ kind: 'idle' })
  const signedIn = session.value !== null
  const repo = chosenRepo.value
  const target = `${FOLDER}/${note.path.split('/').pop() ?? 'note.md'}`

  if (identity === null) {
    return (
      <div class="ink-shared-cta">
        <span>Shared with you · read-only</span>
      </div>
    )
  }

  if (!signedIn) {
    return (
      <div class="ink-shared-cta">
        <span>Shared with you · read-only</span>
        <button
          type="button"
          class="ink-shared-go"
          // Back to this very note afterwards, still unsaved: a trip that performs the action by
          // itself on the way home is a save nobody consented to twice.
          onClick={() => { identity.begin(location.pathname) }}
        >
          Save to my notes
        </button>
      </div>
    )
  }

  if (repo === null) {
    return (
      <div class="ink-shared-cta">
        <span>Choose where your notes live first.</span>
        <button type="button" class="ink-shared-go" onClick={onNeedRepo}>Choose a repository</button>
      </div>
    )
  }

  if (save.kind === 'saved' || save.kind === 'already') {
    return (
      <div class="ink-shared-cta">
        <span>{save.kind === 'saved' ? `Saved to ${save.path}` : `Already in your notes · ${save.path}`}</span>
        {/* An ordinary uncommitted change: it shows in the commit panel like any edit, and
            nothing enters anyone's repository until they commit it. */}
        <a class="ink-shared-go" href="/">Open it</a>
      </div>
    )
  }

  const run = async (): Promise<void> => {
    setSave({ kind: 'saving' })
    try {
      useBackend(createGitHubBackend({
        owner: repo.owner,
        repo: repo.name,
        ref: repo.defaultBranch,
        token: () => identityProvider().token(),
        renew: () => identityProvider().renew(),
      }))
      const landed = await saveCopy(note.content, target)
      setSave(landed)
    } catch (err) {
      setSave({ kind: 'failed', detail: err instanceof Error ? err.message : 'Something went wrong.' })
    }
  }

  return (
    <div class={`ink-shared-cta${save.kind === 'failed' ? ' bad' : ''}`}>
      {/* The destination before the press, not after. */}
      <span>{save.kind === 'failed' ? `Could not save: ${save.detail}` : `Save as ${target}`}</span>
      <button type="button" class="ink-shared-go" disabled={save.kind === 'saving'} onClick={() => { void run() }}>
        {save.kind === 'saving' ? 'Saving…' : save.kind === 'failed' ? 'Try again' : 'Save'}
      </button>
    </div>
  )
}
