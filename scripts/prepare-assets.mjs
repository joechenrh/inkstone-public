import { cp, mkdir, rm, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/vditor/dist')
const publicVditor = resolve(root, 'public/vditor')
// Vditor hardcodes every runtime asset URL as `${cdn}/dist/...` (i18n, lute,
// content-theme, icons, emoji, mathjax). With `cdn: '/vditor'` it requests
// `/vditor/dist/...`, so the dist folder MUST be preserved under public/vditor.
const dest = resolve(publicVditor, 'dist')

await access(src) // throws clearly if vditor is not installed
await rm(publicVditor, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true })
console.log(`copied vditor dist -> public/vditor/dist`)
