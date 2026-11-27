// V6 hybrid — own PNG codec (decoder + writer), written from the PNG spec.
// Reads colour types 0/2/3/4/6 at bit depth 8, non-interlaced, and writes
// only IHDR / PLTE / tRNS / IDAT / IEND with correct CRCs.
import { inflateSync } from 'node:zlib';

export const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
export const NCHAN = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

const CTAB = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

export function crc32(buf, from = 0, to = buf.length) {
  let c = -1;
  for (let i = from; i < to; i++) c = CTAB[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function pngBytes(chunks) {
  let total = SIG.length;
  for (const [, d] of chunks) total += 12 + d.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [name, data] of chunks) {
    v.setUint32(at, data.length);
    out[at + 4] = name.charCodeAt(0);
    out[at + 5] = name.charCodeAt(1);
    out[at + 6] = name.charCodeAt(2);
    out[at + 7] = name.charCodeAt(3);
    out.set(data, at + 8);
    v.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

export function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// Paeth predictor: pick the neighbour closest to a+b-c.
export function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter one row of samples. `cur` is this row, `prev` the row above (or null).
export function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const l = i >= bpp ? cur[i - bpp] : 0;
      const u = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((l + u) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const l = i >= bpp ? cur[i - bpp] : 0;
      const u = prev === null ? 0 : prev[i];
      const ul = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(l, u, ul);
    }
  }
}

// Decode a PNG file to { ok, width, height, rgba } (RGBA, 4 bytes/pixel).
export function decodePng(bytes) {
  const bad = (why) => ({ ok: false, why });
  if (bytes.length < 8) return bad('too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return bad('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let hdr = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let seenIdat = false;
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return bad('bytes after IEND');
    if (at + 12 > bytes.length) return bad('truncated chunk header');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return bad('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return bad('bad chunk type');
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return bad(type + ' CRC mismatch');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) return bad('unsupported chunk ' + type);
    if (hdr === null && type !== 'IHDR') return bad('first chunk not IHDR');
    if (type === 'IDAT' && idatDone) return bad('IDAT chunks not in a row');
    if (type !== 'IDAT' && seenIdat) idatDone = true;
    if (type === 'IHDR') {
      if (hdr !== null) return bad('two IHDR');
      if (len !== 13) return bad('IHDR length');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      hdr = {
        width: dv.getUint32(0), height: dv.getUint32(4),
        depth: data[8], colourType: data[9], interlace: data[12],
      };
      if (hdr.width === 0 || hdr.height === 0) return bad('zero size');
      if (hdr.depth !== 8) return bad('bit depth not 8');
      if (!Object.hasOwn(NCHAN, hdr.colourType)) return bad('bad colour type');
      if (data[10] !== 0 || data[11] !== 0) return bad('bad compression/filter method');
      if (hdr.interlace !== 0) return bad('interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) return bad('two PLTE');
      if (hdr.colourType !== 3) return bad('PLTE without palette type');
      if (seenIdat) return bad('PLTE after IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return bad('bad PLTE length');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return bad('two tRNS');
      if (seenIdat) return bad('tRNS after IDAT');
      const ct = hdr.colourType;
      if (ct === 3) {
        if (palette === null) return bad('tRNS before PLTE');
        if (len > palette.length / 3) return bad('tRNS longer than palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return bad('bad tRNS length');
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return bad('tRNS sample > 255');
      } else return bad('tRNS with colour type ' + ct);
      trns = data;
    } else if (type === 'IDAT') {
      if (hdr.colourType === 3 && palette === null) return bad('IDAT before PLTE');
      seenIdat = true;
      idatParts.push(data);
    } else {
      if (len !== 0) return bad('non-empty IEND');
      ended = true;
    }
  }
  if (!ended) return bad('no IEND');
  if (idatParts.length === 0) return bad('no IDAT');
  const { width, height, colourType } = hdr;
  const bpp = NCHAN[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), { maxOutputLength: expected + 1 });
  } catch (e) {
    return bad('IDAT inflate failed: ' + String(e && e.message).split('\n')[0]);
  }
  if (raw.length !== expected) return bad('inflated length mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return bad('bad filter type on row ' + y);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return bad('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { ok: true, width, height, rgba };
}
