import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as apiModule from '../../src/web/api/index.js'
import { showAssetImages } from '../../src/web/assets/images.js'
import { carriesText, describeStatus, imagesFrom, storeImages, type PasteStatus } from '../../src/web/assets/paste.js'

const writeAsset = vi.spyOn(apiModule.backend, 'writeAsset')
const assetUrl = vi.spyOn(apiModule.backend, 'assetUrl')

/**
 * jsdom has no canvas, so `encodeForNote` falls through to keeping the original bytes — which is a
 * real path (it is what a browser without WebP does) and the one that can be tested here. What is
 * being tested is the pipeline around it: what is written, what is inserted, and what the reader is
 * told about each outcome.
 */
function clipboard(files: File[], text = ''): DataTransfer {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    getData: () => text,
  } as unknown as DataTransfer
}

/** jsdom's `File` has no `arrayBuffer`, and the bytes are the only part of it this reads. */
const png = (bytes = 8): File => ({
  type: 'image/png',
  name: 'shot.png',
  arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
} as unknown as File)

beforeEach(() => {
  writeAsset.mockReset()
  assetUrl.mockReset()
  writeAsset.mockResolvedValue({ path: 'assets/abc.webp', existed: false })
})

describe('what comes off a clipboard', () => {
  it('takes the pictures', () => {
    expect(imagesFrom(clipboard([png()]))).toHaveLength(1)
  })

  it('ignores everything that is not one', () => {
    const pdf = new File([new Uint8Array(2)], 'a.pdf', { type: 'application/pdf' })
    expect(imagesFrom(clipboard([pdf]))).toHaveLength(0)
  })

  it('lets text win, so a link with a favicon beside it pastes as the link', () => {
    expect(carriesText(clipboard([png()], 'https://example.com'))).toBe(true)
  })
})

describe('storing what was pasted', () => {
  it('writes it, then puts a root-absolute path in the note', async () => {
    const inserted: string[] = []
    await storeImages([png()], { insert: (md) => inserted.push(md), report: () => {} })

    expect(writeAsset).toHaveBeenCalledTimes(1)
    // Root-absolute: the one form that survives the note being moved, and the form github.com
    // resolves against the repository root.
    expect(inserted).toEqual(['![](/assets/abc.webp)'])
  })

  it('says what it cost, and what it is', async () => {
    const seen: PasteStatus[] = []
    await storeImages([png(2048)], { insert: () => {}, report: (s) => seen.push(s) })

    const last = seen.at(-1)
    expect(last?.kind).toBe('kept')
    expect(describeStatus(last!).head).toBe('kept')
    expect(describeStatus(last!).detail).toContain('2 KB')
  })

  it('says nothing was written when the picture was already here', async () => {
    writeAsset.mockResolvedValue({ path: 'assets/abc.webp', existed: true })
    const seen: PasteStatus[] = []
    await storeImages([png()], { insert: () => {}, report: (s) => seen.push(s) })

    expect(seen.at(-1)?.kind).toBe('linked')
    expect(describeStatus(seen.at(-1)!).detail).toContain('nothing written')
  })

  it('names the number it refused on', async () => {
    writeAsset.mockRejectedValue(new Error('that picture is too large'))
    const seen: PasteStatus[] = []
    await storeImages([png()], { insert: () => {}, report: (s) => seen.push(s) })

    expect(seen.at(-1)).toMatchObject({ kind: 'refused', head: 'not pasted' })
    expect(describeStatus(seen.at(-1)!).detail).toContain('too large')
  })

  it('stops at the first failure rather than half-writing the note', async () => {
    writeAsset
      .mockResolvedValueOnce({ path: 'assets/one.webp', existed: false })
      .mockRejectedValueOnce(new Error('GitHub did not answer'))
    const inserted: string[] = []
    await storeImages([png(), png(9), png(10)], { insert: (md) => inserted.push(md), report: () => {} })

    expect(inserted).toEqual(['![](/assets/one.webp)'])
    expect(writeAsset).toHaveBeenCalledTimes(2)
  })

  it('counts them when there are several', async () => {
    writeAsset
      .mockResolvedValueOnce({ path: 'assets/one.webp', existed: false })
      .mockResolvedValueOnce({ path: 'assets/two.webp', existed: false })
    const seen: PasteStatus[] = []
    await storeImages([png(), png(9)], { insert: () => {}, report: (s) => seen.push(s) })

    expect(describeStatus(seen.at(-1)!).detail).toContain('2 pictures')
    expect(seen.some((s) => s.kind === 'working' && s.total === 2)).toBe(true)
  })
})

describe('showing them', () => {
  it('asks the backend what the path means, and only for a path in assets/', async () => {
    assetUrl.mockResolvedValue('/api/asset?path=assets%2Fabc.webp')
    const root = document.createElement('div')
    root.innerHTML = '<img src="/assets/abc.webp"><img src="https://example.com/x.png">'
    document.body.append(root)

    const stop = showAssetImages(root)
    await vi.waitFor(() => {
      expect(root.querySelector('img')?.getAttribute('src')).toBe('/api/asset?path=assets%2Fabc.webp')
    })
    expect(assetUrl).toHaveBeenCalledTimes(1)
    expect(assetUrl).toHaveBeenCalledWith('assets/abc.webp')
    stop()
    root.remove()
  })

  it('does not ask twice for one that has already been resolved', async () => {
    assetUrl.mockResolvedValue('blob:one')
    const root = document.createElement('div')
    document.body.append(root)
    const stop = showAssetImages(root)

    const img = document.createElement('img')
    img.setAttribute('src', '/assets/abc.webp')
    root.append(img)
    await vi.waitFor(() => { expect(img.getAttribute('src')).toBe('blob:one') })

    // Our own write comes back through the observer; without the guard this is a loop.
    await new Promise((r) => setTimeout(r, 10))
    expect(assetUrl).toHaveBeenCalledTimes(1)
    stop()
    root.remove()
  })

  it('picks up a picture the editor renders later', async () => {
    assetUrl.mockResolvedValue('blob:two')
    const root = document.createElement('div')
    document.body.append(root)
    const stop = showAssetImages(root)

    const p = document.createElement('p')
    p.innerHTML = '<img src="assets/abc.webp">'
    root.append(p)

    await vi.waitFor(() => {
      expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:two')
    })
    stop()
    root.remove()
  })
})

describe('the pictures a note refers to', () => {
  it('finds them, in both spellings, and only in an image', async () => {
    const { assetsIn } = await import('../../src/web/assets/images.js')
    const markdown = [
      '![](/assets/0123456789abcdef.webp)',
      '![alt](assets/fedcba9876543210.png)',
      '[a link](/assets/not-an-image.webp)',
      '![](https://example.com/x.png)',
      '![](/assets/0123456789abcdef.webp)',
    ].join('\n\n')

    // Deduplicated: the same picture twice in a note is one file to carry.
    expect(assetsIn(markdown)).toEqual([
      'assets/0123456789abcdef.webp',
      'assets/fedcba9876543210.png',
    ])
  })
})
