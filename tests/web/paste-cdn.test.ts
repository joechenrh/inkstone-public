import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as apiModule from '../../src/web/api/index.js'
import * as cdn from '../../src/web/assets/cdn.js'
import { describeStatus, storeImages, type PasteStatus } from '../../src/web/assets/paste.js'
import * as encode from '../../src/web/assets/encode.js'

/**
 * Where a pasted picture ends up when there is a picture host.
 *
 * The rule the design turns on: **a picture is never lost to a failed upload.** The host is tried
 * first, the vault catches whatever it drops, and the line under the picture says which happened —
 * because a note whose pictures quietly went somewhere other than where the reader believes is a
 * note that breaks months later, silently.
 */
const IMAGE = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  type: 'image/webp',
  ext: 'webp',
  from: 581_000,
  to: 35_000,
  width: 1600,
  height: 871,
}

function run() {
  const inserted: string[] = []
  const reported: PasteStatus[] = []
  return {
    inserted,
    reported,
    target: {
      insert: (markdown: string) => { inserted.push(markdown) },
      report: (status: PasteStatus) => { reported.push(status) },
    },
    last: () => reported[reported.length - 1]!,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(encode, 'encodeForNote').mockResolvedValue(IMAGE)
  vi.spyOn(encode, 'hashName').mockResolvedValue('a1b2c3d4e5f60718.webp')
  cdn.uploadDriver.value = 'qiniu'
  cdn.setUploadToCdn(true)
})

const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })

describe('with a picture host', () => {
  it('puts the address it answers with into the note, and writes nothing to the vault', async () => {
    const write = vi.spyOn(apiModule.backend, 'writeAsset')
    vi.spyOn(cdn, 'uploadToHost').mockResolvedValue({ url: 'https://cdn.example.com/assets/a1b2c3d4e5f60718.webp', why: '' })

    const r = run()
    await storeImages([file], r.target)

    expect(r.inserted).toEqual(['![](https://cdn.example.com/assets/a1b2c3d4e5f60718.webp)'])
    expect(write, 'the vault was written to anyway').not.toHaveBeenCalled()
    expect(describeStatus(r.last()).detail).toContain('uploaded')
  })

  it('falls back to the vault when the host will not take it, and says so', async () => {
    const write = vi.spyOn(apiModule.backend, 'writeAsset')
      .mockResolvedValue({ path: 'assets/a1b2c3d4e5f60718.webp', existed: false })
    vi.spyOn(cdn, 'uploadToHost').mockResolvedValue({ url: null, why: 'Qiniu refused it: bad token' })

    const r = run()
    await storeImages([file], r.target)

    // The picture is in the note and in the vault. Nothing was lost.
    expect(r.inserted).toEqual(['![](/assets/a1b2c3d4e5f60718.webp)'])
    expect(write).toHaveBeenCalledOnce()

    // And the line says where it went, and why it went there rather than to the host.
    const said = describeStatus(r.last())
    expect(r.last().kind).toBe('fell-back')
    expect(said.head).toContain('vault')
    expect(said.detail).toContain('bad token')
  })

  it('is not asked at all when the switch is off', async () => {
    const upload = vi.spyOn(cdn, 'uploadToHost')
    vi.spyOn(apiModule.backend, 'writeAsset')
      .mockResolvedValue({ path: 'assets/a1b2c3d4e5f60718.webp', existed: false })
    cdn.setUploadToCdn(false)

    const r = run()
    await storeImages([file], r.target)

    expect(upload).not.toHaveBeenCalled()
    expect(r.inserted).toEqual(['![](/assets/a1b2c3d4e5f60718.webp)'])
    // The old line, unchanged: nothing about a host, because there was no host in this.
    expect(describeStatus(r.last()).detail).not.toContain('uploaded')
  })

  it('is not asked when the server has no host to offer', async () => {
    const upload = vi.spyOn(cdn, 'uploadToHost')
    vi.spyOn(apiModule.backend, 'writeAsset')
      .mockResolvedValue({ path: 'assets/a1b2c3d4e5f60718.webp', existed: false })
    cdn.uploadDriver.value = null

    await storeImages([file], run().target)
    expect(upload).not.toHaveBeenCalled()
  })

  it('does not report "already here" when it only landed in the vault because the host failed', async () => {
    // `linked` means nothing was written and nothing needed to be. After a fallback that reading is
    // wrong twice over: something was written, and the reader needs to know the host refused.
    vi.spyOn(apiModule.backend, 'writeAsset')
      .mockResolvedValue({ path: 'assets/a1b2c3d4e5f60718.webp', existed: true })
    vi.spyOn(cdn, 'uploadToHost').mockResolvedValue({ url: null, why: 'could not reach this server' })

    const r = run()
    await storeImages([file], r.target)
    expect(r.last().kind).toBe('fell-back')
  })
})
