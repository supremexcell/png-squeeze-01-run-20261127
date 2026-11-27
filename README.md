# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/supremexcell/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/supremexcell/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG encoder that squeezes 1280×720 screenshots as small as it can: stride-match optimal-parse DEFLATE with per-image filter screening, colour-type reduction (palette / grey / grey+alpha / RGBA) and adaptive search tiers. One Node 22 program, no dependencies, no network.

## Results (kit scorer, practice set of 8)

| | Score / 1,000,000 | Total bytes |
|---|---|---|
| This entry | **736,160** | 531,956 |
| House baseline fixed-paeth 1.0.0 | 420,399 | 708,151 |

Per instance (bytes → points): i001 11,415 → 771,566 · i002 50,121 → 726,497 · i003 99,910 → 715,988 · i004 102,804 → 713,214 · i005 15,352 → 785,102 · i006 167,950 → 729,070 · i007 60,712 → 703,717 · i008 23,692 → 744,125. All 8 exact (lossless), deterministic across two runs, ~37 s wall for the set (limit 60 s).

Generalisation (two unseen sets drawn from the kit generator with fresh drand seeds): set A 727,670 vs baseline 454,980; set B 737,350 vs baseline 413,731.

## How it works

- **Filter screening with real zlib:** each image is built in several forms (palette by count, grey, RGB, RGBA) × filter strategies (none, adaptive min-sum, adaptive entropy-pairs, brute-force per row for grey/alpha); candidates are ranked by actual zlib level-6 size, the winner re-compressed at level 9.
- **Stride-match optimal parsing:** the custom DEFLATE (zopt.mjs) checks match candidates at multiples of the row stride — the same UI text recurs at the same x on other rows — plus Pareto (length, distance) pairs per position, 512 KiB blocks and adaptive search tiers by compressibility. Search budget is by work, never by the clock, so two runs write identical bytes.
- **Colour-type reduction:** flat images (≤256 colours) go to palette, grey images to grey/grey+alpha, opaque rich images to RGB; alpha is kept wherever it varies, and fully transparent pixels keep their exact colour.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `<input>/<id>/image.png` for each instance, writes `<output>/<id>/image.png` (IHDR, PLTE, tRNS, IDAT, IEND only; bit depth 8, non-interlaced, one zlib stream).

---

Entered on [make.fun](https://make.fun/?ref=bj2pae9c&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards
