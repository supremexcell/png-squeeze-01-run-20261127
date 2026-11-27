// V6 hybrid — colour reduction, filter cost models, zlib sweep.
// Changes vs V5: a palette form is only offered for NON-grey images with
// <=256 colours. For a grey image the palette form can never beat the grey
// channel form: a palette index is a bijection of the grey value, so the
// filter-0 byte-equality structure (and hence the LZ77/Huffman cost) is
// identical, the arithmetic filters only get worse under the permutation,
// and the PLTE chunk adds up to ~780 bytes of pure overhead. Skipping it
// saves a full row-cost pass plus two level-6 screening deflates per grey
// image, for zero bytes lost (verified on the practice set: palette forms
// lost by 65 KB on i004 and by 563 bytes on i008 at level 6).
import { constants, deflateSync } from 'node:zlib';
import { filterRow, ihdr, pngBytes } from './pngio.mjs';

// log2 table for histogram counts up to a full row (5120 samples max here).
const LOG2 = (() => {
  const t = new Float64Array(8192);
  for (let i = 1; i < t.length; i++) t[i] = Math.log2(i);
  return t;
})();

export function analyseImage(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}

// The one fully-transparent value the image can key with tRNS instead of an
// alpha channel: every non-opaque pixel is that exact value at alpha 0, and no
// opaque pixel shares the value. Null when there is none.
export function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

export function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

export function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// All candidate forms for an image: palette (count order) only when the
// image is non-grey and fits in 256 colours; otherwise the channel form
// (grey/RGB/grey+alpha/RGBA, tRNS key when usable). The luminance palette
// order never won on the practice set and costs a full filter/brute/screen
// pass, so it is not tried.
export function formsOf(rgba) {
  const { opaque, grey, colours } = analyseImage(rgba);
  const forms = [];
  if (colours !== null && !grey) {
    const p = paletteForm(rgba, colours, 'count');
    forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, order: 'count' });
    return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, order: null });
  return forms;
}

// ---- single-pass per-row costs -------------------------------------------
// One pass over the image: filter every row all five ways and record the
// per-row minsum and Shannon-entropy costs of each. All cheap models
// (fixed/minsum/entropy/combo) are then just an argmin over these arrays,
// so screening many models costs one filter pass, not one per model.
export function rowCostsAll(samples, width, height, bpp) {
  const stride = width * bpp;
  const minsum = new Float64Array(height * 5);
  const entropy = new Float64Array(height * 5);
  const trials = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const hist = new Uint32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const base = y * 5;
    for (let t = 0; t < 5; t++) {
      const row = trials[t];
      filterRow(t, cur, prev, bpp, row);
      let s = 0;
      hist.fill(0);
      for (let i = 0; i < stride; i++) {
        const v = row[i];
        hist[v]++;
        s += v < 128 ? v : 256 - v;
      }
      minsum[base + t] = s;
      let acc = stride * LOG2[stride];
      for (let v = 0; v < 256; v++) {
        const c = hist[v];
        if (c) acc -= c * LOG2[c];
      }
      entropy[base + t] = acc / 8;
    }
  }
  return { minsum, entropy };
}

// Pick one filter per row from precomputed costs by `model`:
// 'minsum' | 'entropy' | 'combo' (entropy + lambda * minsum/256) | 'fixed:<t>'.
// `switchPenalty` (bytes) is added when the filter changes from the previous row.
export function filtersFromCosts(costs, height, model, opts = {}) {
  const lambda = opts.lambda ?? 0;
  const switchPenalty = opts.switchPenalty ?? 0;
  const filters = new Uint8Array(height);
  if (model.startsWith('fixed:')) {
    filters.fill(Number(model.slice(6)));
    return filters;
  }
  let prevType = -1;
  for (let y = 0; y < height; y++) {
    const base = y * 5;
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      let cost;
      if (model === 'minsum') cost = costs.minsum[base + t];
      else if (model === 'entropy') cost = costs.entropy[base + t];
      else if (model === 'combo') cost = costs.entropy[base + t] + lambda * (costs.minsum[base + t] / 256);
      else throw new Error('unknown model ' + model);
      if (switchPenalty && prevType >= 0 && t !== prevType) cost += switchPenalty;
      if (cost < best) { best = cost; type = t; }
    }
    filters[y] = type;
    prevType = type;
  }
  return filters;
}

// Brute-force filter choice: each row tries all 5 filters, compressed by zlib
// at `level` with the preceding 32 KiB as dictionary; keeps the smallest.
// Ground truth for measuring how well the cheap models predict real cost.
export function chooseFiltersBrute(samples, width, height, bpp, level = 4) {
  const stride = width * bpp;
  const filters = new Uint8Array(height);
  const trials = Array.from({ length: 5 }, () => {
    const row = new Uint8Array(stride + 1);
    return row;
  });
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trials[t][0] = t;
      filterRow(t, cur, prev, bpp, trials[t].subarray(1));
      const len = before.length === 0
        ? deflateSync(trials[t], { level, memLevel: 9 }).length
        : deflateSync(trials[t], { level, memLevel: 9, dictionary: before }).length;
      if (len < best) { best = len; type = t; }
    }
    filters[y] = type;
    raw[at] = type;
    filterRow(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return filters;
}

// Filter the samples with the chosen per-row filters into raw scanline data.
export function buildRaw(samples, width, height, bpp, filters) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = filters[y];
    filterRow(filters[y], samples.subarray(y * stride, (y + 1) * stride),
      y === 0 ? null : samples.subarray((y - 1) * stride, y * stride),
      bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

export function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

export function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdr(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngBytes(chunks);
}
