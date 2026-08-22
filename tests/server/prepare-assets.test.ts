import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')

describe('prepare-assets', () => {
  it('copies vditor dist to public/vditor/dist (preserving the dist layer to match Vditor\'s ${cdn}/dist/... convention)', async () => {
    execFileSync('node', ['scripts/prepare-assets.mjs'], { cwd: root })
    // lute engine is the core of IR rendering and must be present; missing i18n bundles cause /vditor/dist/js/i18n/*.js 404s
    await expect(access(path.join(root, 'public/vditor/dist/js/lute/lute.min.js'))).resolves.toBeUndefined()
    await expect(access(path.join(root, 'public/vditor/dist/js/i18n/zh_CN.js'))).resolves.toBeUndefined()
  })
})
