import { describe, expect, it } from 'vitest'
import { isBareUrl, keepsItsBareForm } from '../../src/web/editor/bare-url.js'

/**
 * Which URLs may lose their angle brackets.
 *
 * The rule is not "looks like a URL" — it is "comes back as the same link, through both the text
 * handler and GFM's autolinker". Every rejection below is a URL that would reparse as something
 * else, and for those the bracketed form is correct and stays.
 */

describe('keepsItsBareForm', () => {
  it('accepts the ordinary shapes a note is full of', () => {
    expect(keepsItsBareForm('https://example.com')).toBe(true)
    expect(keepsItsBareForm('http://example.com/a/b')).toBe(true)
    expect(keepsItsBareForm('https://example.com/a/b?c=1&d=2')).toBe(true)
    expect(keepsItsBareForm('https://example.com/path#section')).toBe(true)
    expect(keepsItsBareForm('https://user@example.com:8443/x')).toBe(true)
    expect(keepsItsBareForm('https://example.com/a%20b')).toBe(true)
    expect(keepsItsBareForm('https://example.com/snake_case_path')).toBe(true)
  })

  it('refuses a scheme GFM does not autolink', () => {
    expect(keepsItsBareForm('mailto:someone@example.com')).toBe(false)
    expect(keepsItsBareForm('ftp://example.com/x')).toBe(false)
    // `www.example.com` is a GFM autolink, but then the text is not the href, so it never gets here.
    expect(keepsItsBareForm('www.example.com')).toBe(false)
  })

  it('refuses a trailing character the autolinker would trim', () => {
    // GFM drops trailing punctuation from an autolink, so the bare form would link less than the
    // bracketed one did — a shortened URL in somebody's note.
    expect(keepsItsBareForm('https://example.com/a.')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a,')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a?')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a!')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a:')).toBe(false)
  })

  it('refuses the characters the text handler unescapes', () => {
    // `writeWhatWasTyped` takes the backslash off each of these, so written as text they would
    // reparse as emphasis, maths, a link or a strikethrough rather than as the URL.
    expect(keepsItsBareForm('https://example.com/a*b*c')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a$b$c')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a[b]c')).toBe(false)
    expect(keepsItsBareForm('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(false)
    expect(keepsItsBareForm('https://example.com/~user')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a`b')).toBe(false)
  })

  it('refuses an underscore the text handler would leave escaped', () => {
    // Only between word characters does that file unescape it; at a boundary the backslash stays,
    // and `https://x/\_a` is a URL with a backslash in it.
    expect(keepsItsBareForm('https://example.com/_leading')).toBe(false)
    expect(keepsItsBareForm('https://example.com/trailing_')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a/_b')).toBe(false)
  })

  it('refuses a character reference, which ends an autolink', () => {
    expect(keepsItsBareForm('https://example.com/?a=1&amp;b=2')).toBe(false)
    expect(keepsItsBareForm('https://example.com/?a=1&#38;b=2')).toBe(false)
    // A bare ampersand is fine: nothing entity-shaped follows it.
    expect(keepsItsBareForm('https://example.com/?a=1&b=2')).toBe(true)
  })

  it('refuses anything with space or angle brackets in it', () => {
    expect(keepsItsBareForm('https://example.com/a b')).toBe(false)
    expect(keepsItsBareForm('https://example.com/<a>')).toBe(false)
    expect(keepsItsBareForm('https://example.com/a\\b')).toBe(false)
  })
})

describe('isBareUrl', () => {
  const url = 'https://example.com/a/b'

  it('is a link that is only its own address', () => {
    expect(isBareUrl(url, url, null)).toBe(true)
    expect(isBareUrl(url, url, '')).toBe(true)
    expect(isBareUrl(url, url, undefined)).toBe(true)
  })

  it('is not a link with words for its text', () => {
    expect(isBareUrl('a link', url, null)).toBe(false)
    // Nor one whose text merely contains the address.
    expect(isBareUrl(`see ${url}`, url, null)).toBe(false)
  })

  it('is not a link carrying a title, which the bare form cannot hold', () => {
    expect(isBareUrl(url, url, 'The docs')).toBe(false)
  })

  it('is not a link whose text is a different address', () => {
    expect(isBareUrl('https://example.com/other', url, null)).toBe(false)
  })

  it('declines anything that is not a string href', () => {
    expect(isBareUrl(url, null, null)).toBe(false)
    expect(isBareUrl(url, undefined, null)).toBe(false)
    expect(isBareUrl(null, url, null)).toBe(false)
  })
})
