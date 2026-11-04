import { computed, effect, signal } from '@preact/signals'
import { backend, ConflictError, type FileSnapshot, type Rev } from '../api/index.js'
import { recordRecent } from './recent.js'
import { recordVisit, stepBack, stepForward, whileWalking } from './visits.js'
import { currentPath, expandAncestors } from './vault.js'
import { isPhone, phoneScreen } from './ui.js'
import { invalidateCorpus } from './search.js'
import { setViewMode, viewMode } from './settings.js'
import { suspendedPath } from './suspend.js'
import { chosenRepo } from '../auth/identity.js'
import { refreshGitStatus, sayGitNotice } from './git.js'

export const DRAFT_KEY_PREFIX = 'inkstone.draft:'
const DRAFT_INDEX_PREFIX = 'inkstone.draft-index:'
interface Draft { path: string; content: string; base: Rev | null; scope: string }
export const drafts = signal(new Map<string, Draft>())
export const savingAll = signal(false)
export const saveAllError = signal<string | null>(null)

function draftScope(): string {
  const repo = chosenRepo.value
  return repo ? `${repo.owner}/${repo.name}@${repo.defaultBranch}` : 'server'
}
const draftId = (scope: string, path: string) => `${scope}\0${path}`
const loadedScopes = new Set<string>()
effect(() => {
  const scope = draftScope()
  if (loadedScopes.has(scope)) return
  loadedScopes.add(scope)
  try {
    const stored = JSON.parse(localStorage.getItem(`${DRAFT_INDEX_PREFIX}${scope}`) ?? '[]') as Draft[]
    const next = new Map(drafts.peek())
    for (const draft of stored) {
      if (typeof draft.path === 'string' && typeof draft.content === 'string'
        && (draft.base === null || typeof draft.base === 'string')) {
        next.set(draftId(scope, draft.path), { ...draft, scope })
      }
    }
    drafts.value = next
  } catch { /* The original per-note draft remains available if metadata cannot be read. */ }
})

function updateDraft(scope: string, path: string, draft: Draft | null): void {
  const next = new Map(drafts.peek())
  if (draft) next.set(draftId(scope, path), draft)
  else next.delete(draftId(scope, path))
  drafts.value = next
  try {
    const remaining = [...next.values()].filter((entry) => entry.scope === scope)
    const key = `${DRAFT_INDEX_PREFIX}${scope}`
    if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining))
    else localStorage.removeItem(key)
  } catch { /* Keeping the in-memory draft must not depend on storage quota. */ }
}

export const unsavedCount = computed(() => [...drafts.value.values()]
  .filter((draft) => draft.scope === draftScope() && draft.path !== suspendedPath.value).length)

/**
 * The note being fetched, if one is.
 *
 * `openFile` used to await the read *before* setting `currentPath`, so between a tap and the text
 * the app still believed no file was open — and the editor column said so, for 221ms over a 200ms
 * round trip. The path is claimed first now, and this says the body is still coming.
 */
export const loadingPath = signal<string | null>(null)

export const content = signal('')
/** The version the open text was read from; handed back on write and never inspected here. */
export const baseRev = signal<Rev | null>(null)
/** When the open file was last written, for display. Null when the backend has no such fact. */
export const modifiedAt = signal<number | null>(null)
export const dirty = signal(false)
export const savingPath = signal<string | null>(null)
let documentGeneration = 0
/**
 * What went wrong, and with which of the two things a document does.
 *
 * One signal rather than a message and a flag beside it: they could disagree, and they did — a
 * failed *open* set this, and the bar reading it said "Could not save" and offered a Try again
 * that ran a save. The verb and the retry both follow from `kind`, so there is one place to be
 * wrong and it is here.
 */
export type FileError =
  | { kind: 'save'; message: string }
  /** `path` is the note that would not open — `currentPath` has already gone back to the last one. */
  | { kind: 'open'; message: string; path: string }

export const fileError = signal<FileError | null>(null)

/** The message alone, for everything that only ever cared about that. */
export const saveError = computed(() => fileError.value?.message ?? null)
/** The version that won a race against an unsaved edit, ready to show or adopt. */
export const conflict = signal<FileSnapshot | null>(null)

export const saveState = computed(() => {
  const path = currentPath.value
  if (path === null) return 'closed'
  if (loadingPath.value === path) return 'loading'
  if (suspendedPath.value === path) return 'live'
  if (savingPath.value === path) return 'saving'
  if (conflict.value !== null) return 'conflict'
  if (fileError.value?.kind === 'save') return 'failed'
  return dirty.value ? 'unsaved' : 'saved'
})

function draftKey(path: string): string {
  return `${DRAFT_KEY_PREFIX}${path}`
}

/** Reset all document state (content, dirty, mtime, errors) and remove the draft for `path`. Call when closing/deleting the currently-open file. */
export function closeDocument(path: string): void {
  documentGeneration++
  loadingPath.value = null
  content.value = ''
  dirty.value = false
  // The saved text is now different from the copy search holds.
  invalidateCorpus()
  baseRev.value = null
  modifiedAt.value = null
  fileError.value = null
  conflict.value = null
  localStorage.removeItem(draftKey(path))
  updateDraft(draftScope(), path, null)
}

/** Clears the failure notice without touching the unsaved text, which stays unsaved. */
export function dismissSaveError(): void {
  fileError.value = null
}

export async function openFile(path: string): Promise<void> {
  documentGeneration++
  // Claimed before the read, not after. The moment this returns to the caller the app is *on*
  // this note: the breadcrumb names it, its row is selected, and on a phone the screen has
  // already changed. Only the text is still coming.
  const previous = currentPath.value
  // Whatever was being held to show the last note's pictures. An object URL keeps its blob alive
  // until it is revoked, and a reader who visits forty notes should not be carrying forty of them.
  if (previous !== path) backend.releaseAssets()
  // Where you were, so `Cmd+[` can go back to it. Before the path changes, and only when the note
  // really changes — reopening the note you are on is not a turning.
  if (previous !== path) recordVisit(previous)
  currentPath.value = path
  loadingPath.value = path
  recordRecent(path)
  expandAncestors(path)

  let file: FileSnapshot
  try {
    // Do not read an older snapshot while Save all is writing this vault.
    if (savingAll.value) await saveChain
    file = await backend.readFile(path)
  } catch (err) {
    // Nothing was opened after all, so the path goes back to whatever it was and the failure is
    // reported where every other read failure is.
    loadingPath.value = null
    if (currentPath.value === path) currentPath.value = previous
    fileError.value = {
      kind: 'open',
      path,
      message: err instanceof Error ? err.message : 'Could not open that note',
    }
    return
  }

  // Another note was asked for while this one was in flight; that one owns the screen.
  if (currentPath.value !== path) return
  loadingPath.value = null

  const scope = draftScope()
  const pending = drafts.value.get(draftId(scope, path))
  const draft = pending?.content ?? localStorage.getItem(draftKey(path))

  // On a phone, opening a note pushes to it, and it opens in read.
  //
  // A phone is mostly where you look something up rather than where you write, and read mode
  // already stops a stray tap expanding a block's markers — which on a touch screen is most taps.
  // Editing is a tap on the bottom bar away. Deliberately not applied on a desktop, where the
  // reading posture is a remembered preference rather than a per-open default.
  if (isPhone.value) {
    phoneScreen.value = 'document'
    if (viewMode.value !== 'source') setViewMode('read')
  }
  baseRev.value = file.rev
  modifiedAt.value = file.modifiedAt
  conflict.value = null
  fileError.value = null

  if (draft !== null && draft !== file.content) {
    // The previous session had unsaved content; prioritize keeping the user's text
    content.value = draft
    dirty.value = true
    baseRev.value = pending ? pending.base : file.rev
    updateDraft(scope, path, { path, content: draft, base: baseRev.value, scope })
  } else {
    content.value = file.content
    dirty.value = false
    updateDraft(scope, path, null)
    localStorage.removeItem(draftKey(path))
  }
}

export function editContent(next: string): void {
  content.value = next
  dirty.value = true
  const path = currentPath.value
  if (path) {
    const scope = draftScope()
    const pending = drafts.value.get(draftId(scope, path))
    updateDraft(scope, path, { path, content: next, base: pending ? pending.base : baseRev.value, scope })
    try { localStorage.setItem(draftKey(path), next) } catch { /* a failed fallback write must not block editing */ }
  }
}

// Chain concurrent flushSave calls into a single sequence: the next save must not
// start until the previous one has fully settled.
// Why this matters: one Ctrl+S may trigger multiple flushSave calls (editor keydown +
// global keydown, or the user pressing quickly in succession). If they run concurrently,
// they all hit the backend carrying **the same stale rev**. After the writes are
// serialized, the second one finds the stored version already changed by the
// first and returns 409 — so every save falsely reports "the file was changed on disk".
// Once serialized: the first write updates baseRev and sets dirty to false; the
// second enters, sees dirty is already false, spins out immediately, and no longer
// self-collides with a 409.
//
// When idle, start doFlushSave synchronously right away (preserving writeFile's
// synchronous call timing so callers' "save has started" expectations aren't disrupted);
// only when a save is already in flight do we queue the new call behind it.
let saveChain: Promise<void> | null = null

export function flushSave(): Promise<void> {
  const prev = saveChain
  const path = currentPath.value
  const generation = documentGeneration
  // A save queued for this note must not follow the user into another note.
  const save = () => currentPath.value === path && documentGeneration === generation
    ? doFlushSave().then(() => {}) : Promise.resolve()
  // then(fn, fn): doFlushSave already swallows all exceptions internally (conflict→conflict,
  // others→saveError) and never rejects. The second argument is defensive redundancy — even
  // if it throws in the future, it guarantees the chain won't be permanently blocked by a
  // single exception, so subsequent saves can still proceed.
  const run: Promise<void> = prev ? prev.then(save, save) : save()
  saveChain = run
  // Reset once the tail of the chain settles (unless a later call has meanwhile replaced saveChain with a new chain).
  void run.finally(() => { if (saveChain === run) saveChain = null })
  return run
}

async function doFlushSave(): Promise<boolean> {
  const path = currentPath.value
  if (!path || !dirty.value || loadingPath.value !== null) return false
  // Not while this note is being edited with other people: the session ends with one write. The
  // text is not at risk — `editContent` has already put the draft in local storage. See
  // `state/suspend.ts`.
  if (path === suspendedPath.value) return false
  const snapshot = content.value
  const generation = documentGeneration
  const base = baseRev.value
  const scope = draftScope()
  // Reopening the same note may still adopt this write if it read the same base.
  const active = () => draftScope() === scope && currentPath.value === path && (documentGeneration === generation
    || (loadingPath.value === null && baseRev.value === base))
  savingPath.value = path
  try {
    const result = await backend.writeFile(path, snapshot, base ?? undefined)
    rememberOurWrite(result.rev)
    const pending = drafts.value.get(draftId(scope, path))
    updateDraft(scope, path, pending && pending.content !== snapshot ? { ...pending, base: result.rev } : null)
    if (!active()) {
      if (localStorage.getItem(draftKey(path)) === snapshot) localStorage.removeItem(draftKey(path))
      return true
    }
    baseRev.value = result.rev
    modifiedAt.value = result.modifiedAt
    fileError.value = null
    // The user may have typed more during the save; only if the content is unchanged is it truly clean.
    if (content.value === snapshot) {
      dirty.value = false
      localStorage.removeItem(draftKey(path))
    }
    return true
  } catch (err) {
    if (!active()) return false
    if (err instanceof ConflictError) {
      conflict.value = err.theirs
      fileError.value = { kind: 'save', message: 'The file has changed on disk' }
      return false
    }
    fileError.value = { kind: 'save', message: err instanceof Error ? err.message : String(err) }
    return false
  } finally {
    savingPath.value = null
  }
}

let allSavePromise: Promise<void> | null = null

/** Save registered drafts without opening notes, committing, or changing the current selection. */
export function saveAll(): Promise<void> {
  if (allSavePromise) return allSavePromise
  const scope = draftScope()
  const pending = [...drafts.value.values()].filter((draft) => draft.scope === scope)
  savingAll.value = true
  saveAllError.value = null
  const run = async () => {
    let saved = 0
    const failed: string[] = []
    for (const snapshot of pending) {
      if (draftScope() !== scope) return
      if (snapshot.path === suspendedPath.value) continue
      // An earlier queued save may already have saved or rebased this draft.
      const draft = drafts.value.get(draftId(scope, snapshot.path))
      if (!draft) continue
      try {
        if (draft.path === currentPath.value && loadingPath.value === null) {
          const saved = await doFlushSave()
          if (!saved) throw new Error(fileError.value?.kind === 'save' ? fileError.value.message : 'Could not save')
        } else {
          if (draft.base === null) throw new Error('Open this note before saving it')
          const file = await backend.readFile(draft.path)
          if (file.rev !== draft.base && !backend.isSameRev(file.rev, draft.base)) {
            throw new ConflictError('The file has changed', file)
          }
          savingPath.value = draft.path
          const result = await backend.writeFile(draft.path, draft.content, draft.base)
          rememberOurWrite(result.rev)
          const latest = drafts.value.get(draftId(scope, draft.path))
          updateDraft(scope, draft.path, latest && latest.content !== draft.content ? { ...latest, base: result.rev } : null)
          if (localStorage.getItem(draftKey(draft.path)) === draft.content) localStorage.removeItem(draftKey(draft.path))
        }
        saved++
      } catch (error) {
        failed.push(`${draft.path}: ${error instanceof Error ? error.message : 'Could not save'}`)
      } finally {
        savingPath.value = null
      }
    }
    if (draftScope() !== scope) return
    await refreshGitStatus()
    if (failed.length) {
      saveAllError.value = `Could not save ${failed.length} note${failed.length === 1 ? '' : 's'}: ${failed.join('; ')}`
      sayGitNotice('error', saveAllError.value, saveAll)
    } else if (saved) {
      sayGitNotice('done', `Saved ${saved} note${saved === 1 ? '' : 's'}`)
    }
  }
  const work = saveChain ? saveChain.then(run, run) : run()
  const tail = work.then(() => {})
  saveChain = tail
  const result = work.finally(() => {
    savingAll.value = false
    allSavePromise = null
    if (saveChain === tail) saveChain = null
  })
  allSavePromise = result
  return result
}

export function resolveConflictTakeDisk(): void {
  const current = conflict.value
  if (!current) return
  content.value = current.content
  baseRev.value = current.rev
  modifiedAt.value = current.modifiedAt
  dirty.value = false
  conflict.value = null
  fileError.value = null
  const path = currentPath.value
  if (path) localStorage.removeItem(draftKey(path))
  if (path) updateDraft(draftScope(), path, null)
}

export async function resolveConflictKeepMine(): Promise<void> {
  const current = conflict.value
  if (!current) return
  // Adopt their rev as the new baseline so the next write no longer hits a 409
  baseRev.value = current.rev
  modifiedAt.value = current.modifiedAt
  conflict.value = null
  dirty.value = true
  const path = currentPath.value
  const scope = draftScope()
  const pending = path ? drafts.value.get(draftId(scope, path)) : null
  if (pending) updateDraft(scope, pending.path, { ...pending, base: current.rev })
  await flushSave()
}

/**
 * Revs this tab has written, most recent last.
 *
 * `baseRev` alone was not enough. It holds only the *latest* write, and the watcher's echo can
 * arrive late — chokidar debounces, and a save while one is already in flight is serialized behind
 * it. So: save, save again, and the first echo turns up carrying a rev that `baseRev` has already
 * moved past. It is our own write, it looks external, and if anything has been typed since it
 * becomes "This file was changed on disk."
 *
 * Four is enough for a burst of Ctrl+S; anything older than that is genuinely stale.
 */
const ours: Rev[] = []
const OURS = 4

export function rememberOurWrite(rev: Rev): void {
  ours.push(rev)
  if (ours.length > OURS) ours.shift()
}

/** Only for tests: a fresh tab has written nothing. */
export function forgetOurWrites(): void {
  ours.length = 0
}

/**
 * Re-point the open document at the base a commit has just created.
 *
 * The rev a save returns identifies an *uncommitted* write. Committing folds those writes into a
 * new base and the rev they had stops existing, so the next save sends a base the backend has never
 * heard of and is told the file changed underneath it. It did not: the reader committed it.
 *
 * Only the rev moves. The text is not touched — it is already what was committed, and anything
 * typed since is still unsaved and still theirs.
 */
export async function rebaseOpenDocument(): Promise<void> {
  const path = currentPath.value
  if (path === null) return
  try {
    const file = await backend.readFile(path)
    rememberOurWrite(file.rev)
    baseRev.value = file.rev
    modifiedAt.value = file.modifiedAt
    const scope = draftScope()
    const pending = drafts.value.get(draftId(scope, path))
    if (pending) updateDraft(scope, path, { ...pending, base: file.rev })
  } catch { /* the next save will surface anything really wrong */ }
}

export async function handleExternalChange(path: string, rev: Rev): Promise<void> {
  if (path !== currentPath.value) return
  // Our own write, echoed back by whatever watches the vault — the latest one, or any of the few
  // before it whose echo is still on its way.
  if (backend.isSameRev(rev, baseRev.value)) return
  if (ours.some((mine) => backend.isSameRev(rev, mine))) return

  const file = await backend.readFile(path)

  if (!dirty.value) {
    content.value = file.content
    baseRev.value = file.rev
    modifiedAt.value = file.modifiedAt
    return
  }

  conflict.value = file
}

/**
 * Back and forward through the notes visited this session.
 *
 * The walk itself must not record a turning, or Back would push the note it just left and the two
 * keys would trade one note between them for ever.
 */
export async function goBack(): Promise<void> {
  const to = stepBack(currentPath.value)
  if (to !== null) await whileWalking(() => openFile(to))
}

export async function goForward(): Promise<void> {
  const to = stepForward(currentPath.value)
  if (to !== null) await whileWalking(() => openFile(to))
}
