# README media

`editor.png` and `walkthrough.gif` show a newly created demo vault. The notes, filenames, author identity, and git history are synthetic. The capture script does not read the configured vault or load `.env.local`.

To regenerate from the repository root:

```sh
pnpm exec playwright install chromium
pnpm build
node scripts/capture-readme.mjs
```

The script requires `ffmpeg` on PATH. It starts its own server on a free loopback port, authenticates with a demo password, records Edit/Source/Read, search, and history, then stops the server. Lossless frames and the demo vault stay in a temporary directory; only the PNG and GIF are copied here.
