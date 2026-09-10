import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { qiniu, uploadToken } from '../../src/uploader/qiniu.js'
import { UploadFailed } from '../../src/uploader/index.js'

const CONFIG = {
  accessKey: 'AK',
  secretKey: 'SK',
  bucket: 'notes',
  baseUrl: 'https://cdn.example.com/',
  uploadHost: 'https://up-z2.qiniup.com',
  now: () => 1_700_000_000_000,
}

const urlsafe = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

describe('the upload credential', () => {
  /*
   * Worked by hand from Qiniu's own description rather than pinned to whatever the code produces:
   * a test that computes the answer the same way the code does proves only that it is consistent
   * with itself. https://developer.qiniu.com/kodo/1208/upload-token
   */
  it('is the access key, the signature, and the policy, joined by colons', () => {
    const token = uploadToken(CONFIG, 'assets/a1b2.webp', 1_700_003_600)
    const [ak, sign, policy] = token.split(':')

    expect(ak).toBe('AK')
    expect(JSON.parse(Buffer.from(policy!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()))
      // The key is in the scope, which is what makes the upload an overwrite rather than a second
      // copy: the same picture pasted twice lands on itself.
      .toEqual({ scope: 'notes:assets/a1b2.webp', deadline: 1_700_003_600 })
    expect(sign).toBe(urlsafe(createHmac('sha1', 'SK').update(policy!).digest()))
  })

  it('signs the encoded policy, not the raw one', () => {
    const token = uploadToken(CONFIG, 'assets/x.webp', 1)
    const [, sign, policy] = token.split(':')
    const raw = Buffer.from(policy!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    expect(sign).not.toBe(urlsafe(createHmac('sha1', 'SK').update(raw).digest()))
  })
})

describe('putting a picture', () => {
  it('posts token, key and file, and answers with the public address', async () => {
    let seen: { url: string; form: FormData } | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), form: init!.body as FormData }
      return new Response(JSON.stringify({ key: 'assets/a1b2.webp' }), { status: 200 })
    })
    const store = qiniu({ ...CONFIG, fetch: fetchMock as unknown as typeof globalThis.fetch })

    const url = await store.put(new Uint8Array([1, 2, 3]), 'webp', 'a1b2')

    expect(url).toBe('https://cdn.example.com/assets/a1b2.webp')
    expect(seen!.url).toBe('https://up-z2.qiniup.com')
    expect(seen!.form.get('key')).toBe('assets/a1b2.webp')
    expect(String(seen!.form.get('token'))).toMatch(/^AK:/)
    expect(seen!.form.get('file')).toBeInstanceOf(Blob)
  })

  it('asks where the bucket is when no upload host was given, once', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return String(input).startsWith('https://api.qiniu.com')
        ? new Response(JSON.stringify({ hosts: [{ up: { domains: ['up-z1.qiniup.com', 'upload-z1.qiniup.com'] } }] }))
        : new Response('{}')
    })
    const store = qiniu({
      ...CONFIG, uploadHost: undefined, fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    await store.put(new Uint8Array([1]), 'webp', 'aa')
    await store.put(new Uint8Array([2]), 'webp', 'bb')

    expect(calls.filter((u) => u.startsWith('https://api.qiniu.com'))).toHaveLength(1)
    expect(calls.filter((u) => u === 'https://up-z1.qiniup.com')).toHaveLength(2)
  })

  it('does not keep a failed answer about where the bucket is', async () => {
    let fail = true
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://api.qiniu.com')) {
        if (fail) { fail = false; throw new TypeError('offline') }
        return new Response(JSON.stringify({ hosts: [{ up: { domains: ['up-z0.qiniup.com'] } }] }))
      }
      return new Response('{}')
    })
    const store = qiniu({
      ...CONFIG, uploadHost: undefined, fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    // One bad minute must not poison every upload for the life of the process.
    await expect(store.put(new Uint8Array([1]), 'webp', 'aa')).rejects.toThrow(UploadFailed)
    await expect(store.put(new Uint8Array([1]), 'webp', 'aa')).resolves.toContain('/assets/aa.webp')
  })

  /*
   * The shape of this answer was guessed once and got it wrong — `up.acc.main`, from some other
   * version of the API — and the test guessed the same way, so it was green while the first real
   * upload failed. The literal below is what api.qiniu.com actually returned, copied from it.
   */
  it('reads the upload domain out of the answer Qiniu really gives', async () => {
    const real = {
      hosts: [{
        region: 'z2', ttl: 86400,
        io: { domains: ['iovip-z2.qbox.me'] },
        up: { domains: ['upload-z2.qiniup.com', 'up-z2.qiniup.com'], old: ['upload-z2.qbox.me'] },
        s3: { region_alias: 'cn-south-1' },
      }],
      ttl: 86400,
    }
    const seen: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return String(input).startsWith('https://api.qiniu.com')
        ? new Response(JSON.stringify(real))
        : new Response('{}')
    })
    const store = qiniu({
      ...CONFIG, uploadHost: undefined, fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    await store.put(new Uint8Array([1]), 'webp', 'aa')
    expect(seen[1]).toBe('https://upload-z2.qiniup.com')
  })

  it('says which shape it could not read, when it cannot', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('https://api.qiniu.com')
        ? new Response(JSON.stringify({ hosts: [{ up: { acc: { main: ['x'] } } }] }))
        : new Response('{}')
    ))
    const store = qiniu({
      ...CONFIG, uploadHost: undefined, fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    // Not "unreachable": Qiniu answered, and this driver could not read the answer.
    await expect(store.put(new Uint8Array([1]), 'webp', 'aa')).rejects.toMatchObject({
      failure: 'unexpected',
      message: expect.stringContaining('"acc"'),
    })
  })

  it('says what Qiniu said, in the terms the caller can act on', async () => {
    const refuse = vi.fn(async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 401 }))
    const store = qiniu({ ...CONFIG, fetch: refuse as unknown as typeof globalThis.fetch })
    await expect(store.put(new Uint8Array([1]), 'webp', 'aa')).rejects.toMatchObject({
      failure: 'refused',
      message: 'Qiniu refused it: bad token',
    })

    // A server that is having a bad day is worth retrying; a refusal is not.
    const broken = vi.fn(async () => new Response('nginx', { status: 502 }))
    const other = qiniu({ ...CONFIG, fetch: broken as unknown as typeof globalThis.fetch })
    await expect(other.put(new Uint8Array([1]), 'webp', 'aa')).rejects.toMatchObject({ failure: 'unreachable' })
  })

  it('never touches the environment', () => {
    // The line between a library and a piece of this program. Grepped rather than mocked, because
    // the point is that the source cannot reach for it at all.
    const code = ['index.ts', 'qiniu.ts']
      .map((f) => readFileSync(new URL(`../../src/uploader/${f}`, import.meta.url), 'utf8'))
      .join('\n')
      // Comments are allowed to *say* `process.env`; this file's whole subject is that it must not
      // reach for it, and the prose in there explains why.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('process.env')
  })
})
