export type ServerEvent =
  | { type: 'file-changed'; path: string; mtimeMs: number }
  | { type: 'file-removed'; path: string }
  | { type: 'tree-changed' }
  | { type: 'git-status'; dirty: boolean; branch: string; hasRemote: boolean; ahead: number }
