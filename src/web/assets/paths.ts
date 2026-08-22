/**
 * Where the pictures live, and how to tell one.
 *
 * One directory at the vault root, in both routes. It is here rather than in either backend
 * because three unrelated places need the same answer — the tree that hides it, the row that opens
 * a picture instead of a note, and the resolver that turns a path into a URL.
 */
export const ASSET_DIR = 'assets'

/** Whether this vault path is a picture rather than a note. */
export function isAssetPath(path: string): boolean {
  return path.startsWith(`${ASSET_DIR}/`)
}
