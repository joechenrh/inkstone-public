/**
 * `subset-font` ships no types. One function is used, and this is its shape.
 *
 * It wraps harfbuzz compiled to wasm, which is why it can cut a woff2 in a few hundred
 * milliseconds without a Python toolchain in the image.
 */
declare module 'subset-font' {
  export default function subsetFont(
    font: Buffer,
    text: string,
    options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' },
  ): Promise<Buffer>
}
