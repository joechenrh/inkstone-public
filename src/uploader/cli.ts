/**
 * The package, from a terminal.
 *
 * `node dist/uploader/cli.js ./a.png` prints the address the picture ended up at, or says why it
 * did not. It exists so a set of credentials can be proved right *before* anyone pastes a picture
 * into a note — the first upload failing inside an editor is a bad place to discover a wrong region
 * or a mistyped key.
 *
 * Reading the environment is a thing a *host* does, and this file is a host. The library beside it
 * still takes its configuration as an argument; see `README.md`.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { qiniu, UploadFailed } from './index.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is not set`)
    process.exit(2)
  }
  return value
}

async function main(): Promise<void> {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('usage: node dist/uploader/cli.js <file>')
    process.exit(2)
  }

  const bytes = new Uint8Array(readFileSync(file))
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  // The same digest, to the same length, as the browser and the vault use — so a picture put here
  // by hand and the same picture pasted into a note are one object.
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)

  const store = qiniu({
    accessKey: required('QINIU_ACCESS_KEY'),
    secretKey: required('QINIU_SECRET_KEY'),
    bucket: required('QINIU_BUCKET'),
    baseUrl: required('QINIU_BASE_URL'),
    uploadHost: process.env.QINIU_UPLOAD_HOST,
  })

  try {
    console.log(await store.put(bytes, ext, hash))
  } catch (err) {
    // The failure kind as well as the words: `refused` is a key or a bucket, `unreachable` is worth
    // trying again, `unexpected` is this driver misreading a perfectly good answer.
    if (err instanceof UploadFailed) {
      console.error(`${err.failure}: ${err.message}`)
      process.exit(1)
    }
    throw err
  }
}

await main()
