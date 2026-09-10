/**
 * Somewhere to put a picture, and nothing else.
 *
 * This directory is a package that happens to live in this repository. It imports nothing from the
 * application, knows nothing about notes, vaults, sessions or HTTP routing, and **does not read the
 * environment** — configuration arrives as an argument. That last one is the line between a library
 * and a piece of this program: a module that reads `process.env` has the host's deployment habits
 * welded into it, and can never be used by anything else.
 *
 * What it does not do is recover. A driver throws; whoever called it decides what that means. In
 * Inkstone that means writing the picture into the repository instead, which is a decision about
 * notes and therefore not one this package can make.
 */

/** A place bytes can be put, addressed afterwards by a URL. */
export interface Uploader {
  /** For messages and logs — `qiniu`, `s3`. */
  readonly name: string
  /**
   * Store these bytes and answer with the address they can be read at.
   *
   * `hash` names the content: the same picture uploaded twice is the same object at the same URL,
   * so a driver should write to a key derived from it rather than inventing a name. Throws
   * {@link UploadFailed} for anything that went wrong.
   */
  put(bytes: Uint8Array, ext: string, hash: string): Promise<string>
}

/** Why an upload did not happen, in the terms the caller can act on. */
export type UploadFailure =
  /** The host could not be reached, or did not answer in time. Worth retrying. */
  | 'unreachable'
  /** The host answered, and said no: bad credentials, a bucket that is full or gone. */
  | 'refused'
  /** The host answered with something this driver could not read. */
  | 'unexpected'

export class UploadFailed extends Error {
  constructor(message: string, readonly failure: UploadFailure, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UploadFailed'
  }
}

export { qiniu, type QiniuConfig } from './qiniu.js'
