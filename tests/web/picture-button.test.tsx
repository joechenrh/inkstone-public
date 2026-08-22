import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PictureButton } from '../../src/web/assets/PictureButton.js'
import { canReceiveImages, receiveImages, type EditorOffer } from '../../src/web/assets/inbox.js'

/**
 * The phone's way in.
 *
 * The button is nowhere near the editor — it lives in the bottom bar, where a thumb is — so what is
 * being tested is the wire between them as much as the sheet itself.
 */

const offers: EditorOffer[] = []
let stop = () => {}

function listen() {
  offers.length = 0
  stop = receiveImages((offer) => offers.push(offer))
}

afterEach(() => { stop() })

describe('adding a picture on a phone', () => {
  it('offers the library, the camera and the clipboard', async () => {
    render(<PictureButton />)
    fireEvent.click(screen.getByTitle('Add a picture'))

    expect(screen.getByText('Photo library')).toBeTruthy()
    expect(screen.getByText('Take a photo')).toBeTruthy()
    expect(screen.getByText('Paste')).toBeTruthy()
  })

  it('hands a chosen photo to the mounted editor', async () => {
    listen()
    const { container } = render(<PictureButton />)
    const input = container.querySelector<HTMLInputElement>('input[type=file]:not([capture])')!

    const file = new File([new Uint8Array(4)], 'IMG_0421.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    expect(offers).toEqual([{ files: [file] }])
  })

  it('takes the camera one from an input the operating system fills', () => {
    listen()
    const { container } = render(<PictureButton />)
    // `capture` is the whole implementation of "Take a photo".
    expect(container.querySelector('input[capture]')).toBeTruthy()
  })

  it('says so when the clipboard has nothing to give', async () => {
    listen()
    vi.stubGlobal('navigator', { clipboard: { read: () => Promise.resolve([]) } })
    render(<PictureButton />)
    fireEvent.click(screen.getByTitle('Add a picture'))
    fireEvent.click(screen.getByText('Paste'))

    await waitFor(() => {
      expect(offers).toEqual([{ notice: { head: 'not pasted', detail: 'there is no picture on the clipboard' } }])
    })
    vi.unstubAllGlobals()
  })

  it('says so when the browser refuses to share it', async () => {
    listen()
    vi.stubGlobal('navigator', { clipboard: { read: () => Promise.reject(new Error('denied')) } })
    render(<PictureButton />)
    fireEvent.click(screen.getByTitle('Add a picture'))
    fireEvent.click(screen.getByText('Paste'))

    await waitFor(() => {
      expect(offers.at(-1)).toEqual({
        notice: { head: 'not pasted', detail: 'the clipboard was not shared with this page' },
      })
    })
    vi.unstubAllGlobals()
  })

  it('knows whether anything is listening', () => {
    expect(canReceiveImages()).toBe(false)
    listen()
    expect(canReceiveImages()).toBe(true)
    stop()
    expect(canReceiveImages()).toBe(false)
  })
})
