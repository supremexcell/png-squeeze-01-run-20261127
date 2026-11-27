// V6 hybrid — entropy filter cost model + zlib sweep + optimal-parsing
// deflate, with the CPU budget cut from V5's ~50 s to ~37 s on the
// practice set and 42.7 s worst observed on unseen sets (vs the grader's
// 60 s wall). Reads
// MAKEFUN_INPUT_DIR (default /input), writes MAKEFUN_OUTPUT_DIR (default
// /output) as <output>/<id>/image.png. Lossless, deterministic: fixed work
// per image, no clock, no randomness, no environment variation.
//
// TUNING (every number measured on the practice set; the grid runs live in
// /tmp/v6bench, summarised here):
// - V5 as-is: 737.707 pts, zopt ~41.1 s of the ~49 s total. findMatches
//   dominates; DP rounds are cheap (~0.8 s/round over the whole set) but
//   matter on rich images (i006: dpRounds 8->4 costs +1,790 bytes).
// - Chain 512->256 + dpRounds 8->6: -1,276 pts, -6.1 s zopt.
//   Chain 256->128: -2,100 pts more, only -2.5 s (the per-position byte
//   budget, not the chain, binds the walk) — rejected.
// - Budget 1024->512 at chain 256: -863 pts, -5.6 s zopt; 512->384:
//   -214 pts, -1.6 s. Budget 256: -3,400 pts — rejected.
// - strideGate 258->128: -18,681 pts (the stride matches that matter are
//   exactly the ones where the chain found a mediocre 128-257 match) —
//   stride search stays ungated (gate 258).
// - Block 1 MiB vs 512 KiB: bytes a wash (+/- per image, net ~0) — kept 512 KiB.
// - DP round 2 (V2's iter-2 idea): a second full optimal-parse pass would
//   cost another ~30 s for at most the dpRounds gain already captured — rejected.
// - Per-block dynamic/fixed/stored choice by exact bit cost (from V4):
//   +0 bytes on practice (dynamic always wins there) but free at emit
//   time and verified correct on all three paths — kept as insurance for
//   unseen blocks.
// - Brute-force filters only for GREY and ALPHA forms: brute won only
//   on grey (i004: -7,833 bytes vs entropy at level 6) and on alpha
//   (i003: -546 bytes at level 6, -869 after the optimal parse); it never
//   won on rich. Restricting it to grey+alpha saves ~1.1 s vs running it
//   everywhere, for 0 bytes lost on practice.
// - Palette forms skipped for grey images (see encode.mjs): saves ~0.3 s,
//   0 bytes lost.
// - Level-9 finalists: top-1 plus any candidate within 1.5% of it at
//   level 6, instead of a fixed top 3. On practice the level-6 winner was
//   the level-9 winner on all 8 images, so this saves ~1.8 s for 0 bytes.
// - Adaptive zopt search by raw size AND compressibility ratio (see
//   zoptOpts): ratio > 0.08 gets the medium search. Measured on 24
//   images (practice + 2 unseen validation sets): worst observed total
//   falls from 54 s (deep search everywhere, validation set A) to
//   42.7 s, for +1.0-2.9 KB per high-ratio image. Practice lands at
//   736,160 pts in ~36.8 s CPU; validation set A 727,670 (baseline
//   454,980) and set B 737,350 (baseline 413,731) — V6 beats the
//   baseline by a wide margin on every unseen set, while the
//   deep-search V5 shape would have risked the 60 s wall on a set
//   like A.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync } from 'node:zlib';
import { decodePng, filterRow, pngBytes, ihdr } from './pngio.mjs';
import {
  formsOf, rowCostsAll, filtersFromCosts, chooseFiltersBrute, buildRaw,
  chunkOverhead, pngOfForm,
} from './encode.mjs';
import { deflateOptimal } from './zopt.mjs';

// Two-stage selection. Stage 1 (cheap): one filter pass per form records the
// per-row minsum and Shannon-entropy costs of all five filters; the cheap
// models are argmins over those costs, and brute force (real zlib per row,
// level 1, 32 KiB dictionary) is the ground-truth check — grey only, where
// it is the only model that ever wins. Every candidate is screened by a
// level-6 deflate. Stage 2 (exact): the best raw is compressed by the
// optimal-parsing deflate and by zlib level 9, and the smaller wins.
const SCREEN_CFG = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const L9_CFG = { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const MODELS = ['fixed:0', 'entropy'];

// Optimal-parser search depth, by raw size and by compressibility (the
// work budget is by size and by measured ratio, never by clock):
// - ratio = level-6 deflate bytes / raw bytes of the winning raw. A high
//   ratio means the image barely compresses: in those regions the hash
//   chain walk almost never finds a good match, so it runs the full chain
//   at nearly every position and the optimal parse takes 6-8.5 s per
//   image (validation set A ran 54 s total with the deep search — 6 s
//   from the 60 s wall). The medium search (chain 128, budget 256,
//   dpRounds 4) cuts those images to 2.5-6 s. Measured on 24 images
//   (practice + 2 unseen sets): ratio > 0.08 -> medium costs
//   +1.0-2.9 KB per image but saves 1.7-3.2 s each; worst observed
//   total falls from 54 s to ~41 s. Ratio <= 0.08 keeps the deep search:
//   small raws (flat/grey, bpp 1) get chain 512, budget 1024, dpRounds 4
//   (small images converge in 4 rounds); large raws (rich/alpha) get
//   chain 256, budget 384, dpRounds 6.
function zoptOpts(rawLen, ratio) {
  if (ratio > 0.08) return { chain: 128, budget: 256, dpRounds: 4 };
  if (rawLen <= 1048576) return { chain: 512, budget: 1024, dpRounds: 4 };
  return { chain: 256, budget: 384, dpRounds: 6 };
}

// Last-resort encoder (house-baseline shape): RGBA, every row Paeth, zlib 9.
// Used only if the main pipeline throws on an image, so an answer is always
// written.
function fallbackPng(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 4;
    filterRow(4, rgba.subarray(y * stride, (y + 1) * stride),
      y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride),
      4, raw.subarray(at + 1, at + 1 + stride));
  }
  const stream = deflateSync(raw, L9_CFG);
  return pngBytes([
    ['IHDR', ihdr(width, height, 6)],
    ['IDAT', stream],
    ['IEND', new Uint8Array(0)],
  ]);
}

function encodeImage(rgba, width, height) {
  const forms = formsOf(rgba);
  const screened = [];
  for (const form of forms) {
    const overhead = chunkOverhead(form);
    const costs = rowCostsAll(form.samples, width, height, form.bpp);
    for (const model of MODELS) {
      const filters = filtersFromCosts(costs, height, model);
      const raw = buildRaw(form.samples, width, height, form.bpp, filters);
      const z = deflateSync(raw, SCREEN_CFG);
      screened.push({ form, raw, bytes: z.length + overhead, model });
    }
    // Brute-force per-row filters, grey and alpha forms only: on the
    // practice set brute won on grey (i004, by ~7.8 KB over entropy) and
    // on alpha (i003, by ~0.5 KB at level 6, ~0.9 KB after the optimal
    // parse); it never won on rich, and each pass costs ~0.5 s of zlib
    // calls. When brute loses, the level-6 screen rejects its raw, so
    // the only cost of trying it on alpha is CPU. Palette indices do
    // not correlate with neighbours the way channel samples do, so
    // filtering loses badly there and the brute pass is pure cost.
    if (form.colourType === 0 || form.colourType === 6) {
      const brute = chooseFiltersBrute(form.samples, width, height, form.bpp, 1);
      const rawB = buildRaw(form.samples, width, height, form.bpp, brute);
      const zB = deflateSync(rawB, SCREEN_CFG);
      screened.push({ form, raw: rawB, bytes: zB.length + overhead, model: 'brute' });
    }
  }
  screened.sort((a, b) => a.bytes - b.bytes);
  // Stage 2 (exact): level-9 compress the level-6 winner plus any candidate
  // within 1.5% of it — the level-6 ranking is noisy at this granularity,
  // but on the practice set the level-6 winner was the level-9 winner on
  // all 8 images, so a fixed top-3 wastes ~2 s. Then run the optimal
  // parser on the level-9 winner and keep the smaller of the two streams.
  const best6 = screened[0].bytes;
  const finalists = screened.filter((c) => c.bytes <= best6 * 1.015).slice(0, 3);
  let bestPng = null;
  let bestBytes = Infinity;
  const consider = (png, bytes) => {
    if (bytes < bestBytes) { bestBytes = bytes; bestPng = png; }
  };
  let l9Winner = null;
  let l9WinnerBytes = Infinity;
  for (const cand of finalists) {
    const z9 = deflateSync(cand.raw, L9_CFG);
    const bytes = z9.length + chunkOverhead(cand.form);
    consider(pngOfForm(width, height, cand.form, z9), bytes);
    if (bytes < l9WinnerBytes) { l9WinnerBytes = bytes; l9Winner = cand; }
  }
  try {
    // Compressibility of the winning raw, from its level-6 screening
    // bytes (chunk overhead removed): drives the search depth, see
    // zoptOpts. A deterministic quantity of the work itself, not a clock.
    const ratio = (l9Winner.bytes - chunkOverhead(l9Winner.form)) / l9Winner.raw.length;
    const zo = deflateOptimal(l9Winner.raw, {
      blockSize: 524288,
      ...zoptOpts(l9Winner.raw.length, ratio),
      // Row stride (filter byte + one row of samples): the same text or line
      // recurs at the same x in other rows, and checking stride multiples
      // directly finds those far-back matches that a hash chain reaches only
      // after thousands of nearer candidates.
      stride: l9Winner.form.bpp * width + 1,
    });
    consider(pngOfForm(width, height, l9Winner.form, zo), zo.length + chunkOverhead(l9Winner.form));
  } catch {
    // Fall through with the level-9 winner already considered above.
  }
  return bestPng;
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(O, id), { recursive: true });
  let png;
  try {
    png = encodeImage(image.rgba, image.width, image.height);
  } catch {
    png = fallbackPng(image.rgba, image.width, image.height);
  }
  writeFileSync(join(O, id, 'image.png'), png);
}
