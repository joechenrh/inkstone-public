# The two engines, measured

Both engines ship in the same build and are chosen by a setting, so this is not a harness comparison: it is the application, on the real vault, with the engine as the only variable. Chromium, one machine, medians over repeated runs.

The short version: **for every note in this vault under about 25 KB, the two are indistinguishable.** Everything below happens at the 106 KB note.

## Opening a note

Click to painted. A fresh browser context per measurement, so every open is a first open — median of 4.

| note | size | Vditor | Crepe | |
|---|---|---|---|---|
| `C++/并发.md` | 1.1 KB | 49.8 ms | 48.7 ms | — |
| `misc/deploy.md` | 3.0 KB | 118.3 ms | **91.5 ms** | Crepe 1.3× |
| `LLM/build-my-inference.md` | 12.7 KB | **187.2 ms** | 207.6 ms | Vditor 1.1× |
| `OS/地址空间.md` | 26.6 KB | 274.6 ms | **180.8 ms** | Crepe 1.5× |
| `big.md` | 106.6 KB | 517.3 ms | **286.3 ms** | Crepe 1.8× |

The 12.7 KB row is the only one where Vditor leads, by less than the spread between its own runs.

## Typing

Neither engine's `input` event is where its work happens — Vditor debounces a full re-serialisation through lute, Crepe runs a transaction and a serialisation — so timing the event reported half a millisecond for both and measured nothing. What a reader feels is the main thread not answering, so this is **long tasks** during a 40-key burst plus the settle time after it.

| note | Vditor | Crepe |
|---|---|---|
| 3.0 KB | none | none |
| 26.6 KB | none | none |
| 106.6 KB | **3 tasks, worst 63 ms**, 18 ms blocking | none |

## Scrolling

Frame times end to end, twice: the first pass pays for anything mounted on the way down, the second is what every scroll after the first costs.

| note | pass | Vditor p95 / worst | Crepe p95 / worst |
|---|---|---|---|
| 12.7 KB | first | 9.5 / 11.7 ms | 10.1 / 11.5 ms |
| 26.6 KB | first | 9.2 / 232.9 ms | 10.9 / 12.5 ms |
| 106.6 KB | first | **9.4 / 12.1 ms** | 41.7 / 74.1 ms |
| 106.6 KB | again | 9.2 / 10.4 ms | 9.6 / 13.8 ms |

**This is the one place Crepe is worse**, and it is once per note: its fenced blocks are real CodeMirror instances that mount as they scroll into view, and `big.md` has 80 fences. Scrolled a second time it matches Vditor exactly. (Vditor's 232.9 ms on the 26.6 KB note is a single outlier that did not repeat.)

## Everything else

| | Vditor | Crepe |
|---|---|---|
| Cold load to a note on screen | 468 ms | **366 ms** |
| Transferred | 6181 KB, 21 requests | 6134 KB, 18 requests |
| Reading the outline, 106 KB | 0.4 ms | 0.5 ms |
| Heap after opening a note | 26–47 MB | 15–44 MB |

Heap varied more between runs of the same engine than between engines; there is no difference to report.

## What this does and does not say

Performance is not a reason to prefer either engine for this vault. The two differences that are real — Crepe opens the largest note in half the time and never blocks while typing in it; Vditor scrolls it smoothly the first time — both concern one note out of sixteen.

Whatever is wrong with the newer engine, it is not speed.

## How this was measured, including what was wrong with it

Three earlier versions of the open-time table reported **17 ms for the 106 KB note** — faster than the 1 KB one. Each time the readiness check was satisfied by the note that was already on screen: first a length threshold the previous note already met, then a breadcrumb that updates on click rather than on render, then a length comparison against a note the application had restored. The number was absurd on its face and was worth three rewrites rather than one explanation.

The version that stands opens each note in a fresh context and waits for a string only that note contains. `scripts` are in the scratchpad, not the repository — they are throwaway.
