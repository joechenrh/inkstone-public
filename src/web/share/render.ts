/**
 * Markdown to HTML for the reader's page, using the editor's own renderer.
 *
 * `vditor/dist/method.js` is the rendering half of Vditor without the editor — a fraction of the
 * whole, and the reader page has nothing to edit. It is imported dynamically so that the *editor*
 * never pays for it either — Vite gives the reader its own chunk, and someone opening a shared
 * link downloads neither the editor nor its toolbar.
 *
 * `cdn: '/vditor'` is not optional. Vditor builds every runtime asset URL as `${cdn}/dist/...` and
 * this app fetches nothing from a CDN — the assets are copied into `public/vditor/dist` by
 * `scripts/prepare-assets.mjs`.
 */
export async function renderMarkdown(host: HTMLElement, markdown: string): Promise<void> {
  // `method.js` rather than `method.min.js`: it is the one with a `.d.ts` beside it, and the build
  // minifies it regardless.
  const { default: VditorMethod } = await import('vditor/dist/method.js')
  await VditorMethod.preview(host as HTMLDivElement, markdown, {
    cdn: '/vditor',
    mode: 'light',
    // Two round trips this page has no use for. Vditor fetches an icon sprite unless `icon` is
    // falsy, and an i18n bundle unless it is handed the strings outright — both for a toolbar a
    // reading page does not have. `codeRender`'s copy button is the only thing here that reads
    // either, and it wants one word. On a high-latency link two serial requests cost more than the
    // 45KB they carry.
    //
    // `as never` because Vditor's types describe the *editor's* options, where a toolbar always
    // exists: `icon` is 'ant' | 'material' and `i18n` is the full 75-key table. The preview path
    // reads exactly two of those keys — `close` and `spin`, for the image lightbox — and checks
    // `icon` only for truthiness.
    icon: '' as never,
    i18n: { close: 'close', spin: 'spin' } as never,
    // The document themes are ours and are already on the page; Vditor's own content theme would
    // load a stylesheet over the top of them.
    theme: { current: 'light', path: '/vditor/dist/css/content-theme' },
    hljs: { style: 'github' },
  })
}
