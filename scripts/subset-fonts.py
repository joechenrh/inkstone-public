#!/usr/bin/env python3
"""Cut the shipped CJK serif down to the characters people actually write.

Not part of the build. Run it by hand when the font is replaced, and commit the result.

    pip install fonttools brotli
    python3 scripts/subset-fonts.py ~/Downloads/SourceHanSerifCN-Regular.otf regular
    python3 scripts/subset-fonts.py ~/Downloads/SourceHanSerifCN-Bold.otf bold

Why this exists
---------------
The full faces were 8.2MB and 8.8MB. They are woff2, so gzip cannot touch them — on a cold load
they were **17MB of an 18.3MB critical path, 94% of it**, and the server this is deployed to serves
about 16KB/s to the public internet. Everything else on that path (lute, highlight.js, the bundle)
compresses to well under a megabyte combined.

What is kept
------------
GB2312 level 1 — 3,755 hanzi, the standard common set, which covers essentially all modern prose —
plus CJK punctuation and the fullwidth forms. **No Latin:** Cantarell is 16KB and already sits
ahead of this face in every theme's stack, so carrying a second Latin design here would be paying
for glyphs nothing selects.

A character outside the set falls through to the next family in the stack (Songti SC, then the
system serif), which is ordinary CSS font fallback and what `unicode-range` in `fonts.css` is for.
That is the trade: a rare character is set in a different serif, and nobody waits eight megabytes
for the common ones.

The originals are not in the tree. `git show 5959458` has them if a re-subset is ever needed.
"""

import pathlib
import subprocess
import sys

# GB2312 level 1: the 3,755 characters every modern Chinese text is made of. Generated from
# Python's own codec rather than carried as a data file, so there is nothing here to drift.
def common_hanzi() -> str:
    out = []
    for high in range(0xB0, 0xD8):
        for low in range(0xA1, 0xFF):
            try:
                out.append(bytes([high, low]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return "".join(out)


# Punctuation the hanzi are set with, which the Latin face does not have the right shapes for.
PUNCTUATION = "U+3000-303F,U+FF01-FF60,U+2018-201D,U+2026,U+2014"

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in ("regular", "bold"):
        print(__doc__)
        return 2

    source, weight = pathlib.Path(sys.argv[1]).expanduser(), sys.argv[2]
    if not source.exists():
        print(f"no such font: {source}")
        return 1

    chars = ROOT / "scripts" / ".hanzi.txt"
    chars.write_text(common_hanzi(), encoding="utf-8")
    target = ROOT / "public" / "fonts" / f"source-han-serif-cn-{weight}.woff2"

    try:
        subprocess.run([
            "pyftsubset", str(source),
            f"--text-file={chars}",
            f"--unicodes={PUNCTUATION}",
            "--layout-features=*",
            "--flavor=woff2",
            f"--output-file={target}",
        ], check=True)
    finally:
        chars.unlink(missing_ok=True)

    print(f"{target.name}: {target.stat().st_size / 1024:.0f}KB "
          f"(from {source.stat().st_size / 1024:.0f}KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
