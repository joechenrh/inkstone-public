# uploader

Somewhere to put a picture, and nothing else.

This is a package that happens to live in Inkstone's repository. It imports nothing from the
application, and the application reaches it through one interface:

```ts
export interface Uploader {
  readonly name: string
  /** Bytes in, a public URL out. Throws `UploadFailed`. */
  put(bytes: Uint8Array, ext: string, hash: string): Promise<string>
}
```

`hash` names the content, so a driver writes to a key derived from it: the same picture uploaded
twice is the same object at the same address.

## It does not read the environment

Configuration arrives as an argument:

```ts
import { qiniu } from './uploader/index.js'

const store = qiniu({
  accessKey: '…',
  secretKey: '…',
  bucket: 'notes',
  baseUrl: 'https://cdn.example.com',   // the domain bound to the bucket
  uploadHost: 'https://up-z2.qiniup.com', // optional; asked for once if left out
})

const url = await store.put(bytes, 'webp', 'a1b2c3d4e5f60718')
```

That is the line between a library and a piece of a program. A module that reads `process.env` has
its host's deployment habits welded into it and can never be used by anything else — which is why
`tests/uploader` asserts, on the source, that it does not.

## It does not recover

A driver throws; whoever called it decides what that means. In Inkstone a failure means the picture
is written into the vault instead and the line under it says so — a decision about notes, and
therefore not one this package can make.

## Drivers

- **qiniu** — Kodo, through its form upload. No SDK: the credential is
  `AccessKey : urlsafe(HMAC-SHA1(policy)) : urlsafe(policy)`, and the upload is a multipart POST of
  `token`, `key`, `file`. The policy's `scope` carries the key, which makes every upload an
  overwrite. About sixty lines of `node:crypto`.

Adding another — S3 (R2, MinIO, B2), or a POST to an address of your own in the shape PicGo calls a
custom uploader — is implementing the interface again. Nothing outside this directory changes.
