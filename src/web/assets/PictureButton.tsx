import { useRef, useState } from 'preact/hooks'
import { IconCamera, IconClipboard, IconPicture } from '../components/icons.js'
import { isImage } from './encode.js'
import { offerImages, offerNotice } from './inbox.js'
import './picture-button.css'

/**
 * Adding a picture on a phone.
 *
 * Two things are different here and neither is cosmetic. The clipboard is not the main way in — a
 * photo comes from the library or the camera — so this is a sheet with three ways rather than a
 * button with one. And the saving is much larger: a phone photo is 4–12 MB and 4000px wide, the
 * same rule takes it to about 120 KB, and on a metered connection that is the difference between a
 * note that opens and one that does not.
 *
 * The first two ways are an `<input type="file">` and nothing else — `accept` for the library,
 * `capture` for the camera. The operating system does the rest, including the permission.
 */

/** Where the files go: the mounted editor, which is the only thing that knows where the caret is. */
async function fromClipboard(): Promise<void> {
  const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItem[]> }
  if (typeof clipboard?.read !== 'function') {
    offerNotice('not pasted', 'this browser will not let a page read the clipboard')
    return
  }
  try {
    const items = await clipboard.read()
    const files: File[] = []
    for (const item of items) {
      const type = item.types.find(isImage)
      if (type === undefined) continue
      const blob = await item.getType(type)
      files.push(new File([blob], `pasted.${type.split('/')[1] ?? 'png'}`, { type }))
    }
    if (files.length === 0) {
      offerNotice('not pasted', 'there is no picture on the clipboard')
      return
    }
    offerImages(files)
  } catch {
    // Safari and Chrome both refuse without a permission, and refusing is a legitimate answer.
    offerNotice('not pasted', 'the clipboard was not shared with this page')
  }
}

export function PictureButton() {
  const [open, setOpen] = useState(false)
  const library = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)

  const take = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    offerImages(Array.from(input.files ?? []).filter((f) => isImage(f.type)))
    // Cleared, or picking the same photo twice in a row fires no change event at all.
    input.value = ''
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        class="ink-iconbtn ink-picture-btn"
        onClick={() => { setOpen(!open) }}
        aria-expanded={open}
        title="Add a picture"
      >
        <IconPicture />
      </button>

      {open && (
        <div class="ink-picture-scrim" onClick={() => { setOpen(false) }}>
          <div class="ink-picture-sheet" role="menu" onClick={(e) => { e.stopPropagation() }}>
            <button type="button" role="menuitem" onClick={() => library.current?.click()}>
              <IconPicture /> Photo library
            </button>
            <button type="button" role="menuitem" onClick={() => camera.current?.click()}>
              <IconCamera /> Take a photo
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); void fromClipboard() }}
            >
              <IconClipboard /> Paste
            </button>
          </div>
        </div>
      )}

      {/* Off-screen rather than `display: none`: a hidden input cannot be clicked in Safari. */}
      <input ref={library} class="ink-picture-input" type="file" accept="image/*" multiple onChange={take} />
      <input ref={camera} class="ink-picture-input" type="file" accept="image/*" capture="environment" onChange={take} />
    </>
  )
}
