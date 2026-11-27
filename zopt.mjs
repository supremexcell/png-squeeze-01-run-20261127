// V6 hybrid — optimal-parsing deflate encoder (own design, following the
// DEFLATE format in RFC 1951). Per block: hash-chain LZ77 match search at
// every position, greedy-lazy pass for first symbol statistics, then DP
// passes that choose literal/match decisions by true bit cost, with
// length-limited Huffman tables (package-merge, max 15). Deterministic:
// fixed work, no clock, no randomness.
//
// Changes vs V5 (all measured on the practice set, see the tuning notes in
// main.ts):
// - emitBlock chooses dynamic / fixed / stored Huffman per block by EXACT
//   bit cost (dynamic header included). Fixed never won on the practice
//   set's blocks (the DP optimises for dynamic lengths), but the choice is
//   free at emit time and can only help on unseen blocks; all three paths
//   were verified by inflate round-trip, including forced-fixed and
//   crypto-random inputs. Stored is only eligible for blocks <= 65535
//   bytes (the 16-bit LEN field); choosing it for a larger block would
//   truncate LEN and corrupt the stream.
// - The match-search parameters (chain / budget / dpRounds) are set by the
//   caller per raw size (see main.ts): small raws get the deep search,
//   large raws the cheaper one.
import { packageMergeLengths, canonicalCodes } from './huff.mjs';

// ---- DEFLATE length / distance code tables (RFC 1951 §3.2.5) -------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Lookups: length 3..258 -> symbol / extra bits / extra value. (Symbols run
// 257..285, so the code table must hold values above 255.)
const LEN_CODE = new Uint16Array(259);
const LEN_EBITS = new Uint8Array(259);
const LEN_EVAL = new Uint16Array(259);
for (let c = 0; c < 29; c++) {
  const span = c === 28 ? 1 : LEN_BASE[c + 1] - LEN_BASE[c];
  for (let k = 0; k < span; k++) {
    const len = LEN_BASE[c] + k;
    LEN_CODE[len] = 257 + c;
    LEN_EBITS[len] = LEN_EXT[c];
    LEN_EVAL[len] = k;
  }
}
const DIST_CODE = new Uint8Array(32769);
const DIST_EBITS = new Uint8Array(32769);
const DIST_EVAL = new Uint16Array(32769);
for (let c = 0; c < 30; c++) {
  const span = c === 29 ? 8192 : DIST_BASE[c + 1] - DIST_BASE[c];
  for (let k = 0; k < span && DIST_BASE[c] + k <= 32768; k++) {
    const d = DIST_BASE[c] + k;
    DIST_CODE[d] = c;
    DIST_EBITS[d] = DIST_EXT[c];
    DIST_EVAL[d] = k;
  }
}

// Order the code-length code's symbols are transmitted in (RFC 1951 §3.2.7).
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

// Fixed Huffman code lengths and codes (RFC 1951 §3.2.6): literals 0-143: 8,
// 144-255: 9, 256-279: 7, 280-287: 8; distances: 5 bits each. Codes are
// stored bit-reversed, matching the dynamic path's emission convention.
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_LIT_CODE = new Uint32Array(288);
for (let i = 0; i < 288; i++) {
  const c = i < 144 ? 0x30 + i : i < 256 ? 0x190 + i - 144 : i < 280 ? i - 256 : 0xc0 + i - 280;
  FIXED_LIT_CODE[i] = reverseBits(c, FIXED_LIT_LEN[i]);
}

class BitWriter {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  write(val, len) {
    this.bitBuf |= (val << this.bitCnt) >>> 0;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  byteAlign() {
    if (this.bitCnt > 0) {
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
}

// Scratch buffers, grown on demand and reused (single-threaded, deterministic).
let S = null;
function scratch(n) {
  if (S === null || S.n < n) {
    const m = Math.max(n, S === null ? 0 : S.n * 2);
    S = {
      n: m,
      head: new Int32Array(32768),
      prev: new Int32Array(m),
      bestLen: new Uint16Array(m),
      bestDist: new Uint16Array(m),
      // Pareto-optimal (length, distance) pairs per position: a pair is kept
      // when no other pair is both at least as long and at least as cheap in
      // distance bits. The DP can only see one distance per position with a
      // single best match; a slightly shorter match at a much nearer distance
      // is often cheaper, and on unfiltered data the single-distance DP lost
      // 4-14% to zlib level 9. Up to 4 pairs per position (flat arrays).
      mCount: new Uint8Array(m),
      mLen: new Uint16Array(m * 4),
      mDist: new Uint16Array(m * 4),
      cost: new Int32Array(m + 1),
      prevPos: new Int32Array(m + 1),
      decLen: new Int16Array(m + 1),
      decDist: new Uint16Array(m + 1),
      tokKind: new Uint8Array(m + 1),
      tokVal: new Uint16Array(m + 1),
      tokDist: new Uint16Array(m + 1),
      litFreq: new Uint32Array(288),
      distFreq: new Uint32Array(30),
      litLen: new Uint8Array(288),
      distLen: new Uint8Array(30),
      litCost: new Uint16Array(288),
      distCost: new Uint16Array(30),
      lenPart: new Uint16Array(259),
    };
  }
  return S;
}

function hash3(data, i) {
  const v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  return (Math.imul(v, 2654435761) >>> 17) & 32767;
}

// Insert one (length, distance) pair into position i's Pareto set. A pair is
// dominated when another pair is at least as long and its distance code costs
// no more bits (distance cost approximated as extra bits + 5 for the code).
function paretoAdd(s, i, l, d) {
  const { mCount, mLen, mDist } = s;
  const dc = DIST_EBITS[d] + 5;
  const base = i * 4;
  let cnt = mCount[i];
  for (let k = 0; k < cnt; k++) {
    if (mLen[base + k] >= l && DIST_EBITS[mDist[base + k]] + 5 <= dc) return;
  }
  // Drop pairs the new one dominates.
  let w = 0;
  for (let k = 0; k < cnt; k++) {
    if (mLen[base + k] <= l && DIST_EBITS[mDist[base + k]] + 5 >= dc) continue;
    mLen[base + w] = mLen[base + k];
    mDist[base + w] = mDist[base + k];
    w++;
  }
  cnt = w;
  if (cnt < 4) {
    mLen[base + cnt] = l;
    mDist[base + cnt] = d;
    mCount[i] = cnt + 1;
    return;
  }
  // Full: keep the new pair only if it beats the worst-scored stored pair.
  let worst = 0;
  let worstScore = Infinity;
  for (let k = 0; k < 4; k++) {
    const sc = mLen[base + k] * 4 - (DIST_EBITS[mDist[base + k]] + 3);
    if (sc < worstScore) { worstScore = sc; worst = k; }
  }
  const newScore = l * 4 - (dc - 2);
  if (newScore > worstScore) {
    mLen[base + worst] = l;
    mDist[base + worst] = d;
  }
}

// Longest match at every position of the block (window 32 KiB, in-block only).
// A match at i-1 of length L extends to i with length L-1 at the same
// distance, so it seeds the search there. Candidates are ranked by an
// approximate bit score — length times ~4 bits saved per literal, minus the
// distance code's extra bits — because a shorter match at a near distance
// often beats a longer one far away, and the DP can only use one match per
// position. The prune threshold is the longest length seen so far minus a
// slack of 8, so a slightly shorter but much closer match still gets found.
function findMatches(data, n, s, chainLimit, budget, goodCut, stride, strideGate) {
  const { head, prev, bestLen, bestDist, mCount } = s;
  head.fill(-1);
  let prevLen = 0;
  let prevDist = 0;
  for (let i = 0; i < n; i++) {
    mCount[i] = 0;
    let best = 2; // longest length seen (pruning threshold)
    let bestScore = -1;
    let bd = 0;
    let bl = 0;
    if (prevLen >= 4) {
      bl = prevLen - 1;
      bd = prevDist;
      best = bl;
      bestScore = bl * 4 - (DIST_EBITS[bd] + 3);
      paretoAdd(s, i, bl, bd);
    }
    if (i + 3 <= n) {
      const h = hash3(data, i);
      let cand = head[h];
      let chain = chainLimit;
      const maxLen = Math.min(258, n - i);
      const win = i - 32768;
      // Walk the chain while a better-scoring match is still possible. The
      // walk is bounded by a per-position budget of compared bytes, not by a
      // candidate count: in text regions each candidate compares only a few
      // bytes, so a deep chain stays affordable, while in run-heavy regions
      // a few ~200-byte compares exhaust the budget and stop the walk. Once
      // a good match (>= 32) is in hand, only `goodCut` more candidates are
      // worth checking.
      let spent = 0;
      while (cand >= win && cand >= 0 && chain-- > 0 && spent <= budget) {
        // Slack of 8 in the probe only once a long match is in hand (that
        // is when a slightly shorter but much closer match can win); for a
        // short best the plain probe prunes far better.
        const probe = best >= 24 ? best - 8 : best;
        if (data[cand + probe] === data[i + probe]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          spent += l + 1;
          if (l >= 3) {
            const d = i - cand;
            paretoAdd(s, i, l, d);
            const sc = l * 4 - (DIST_EBITS[d] + 3);
            if (sc > bestScore) { bestScore = sc; bl = l; bd = d; }
          }
          if (l > best) {
            best = l;
            if (l >= maxLen) break;
            if (l >= 32) chain = Math.min(chain, goodCut);
          }
        }
        cand = prev[cand];
      }
      prev[i] = head[h];
      head[h] = i;
      // Row-stride candidates: in a screenshot the same text or line recurs
      // at the same x in other rows, so its distance is a multiple of the row
      // stride. Those matches sit deep in the trigram chain (thousands of
      // nearer occurrences of the same trigram come first), but they can be
      // checked directly in O(1) per position with the same probe pruning.
      // NOTE: strideGate must stay at 258 — gating the stride search at 128
      // lost ~18.7k score points on the practice set, because the stride
      // matches that matter are exactly the ones where the chain found a
      // mediocre 128-257 match first.
      if (stride > 0 && best < strideGate) {
        const probeS = best >= 24 ? best - 8 : best;
        for (let d = stride; d <= 32768 && d <= i; d += stride) {
          const c = i - d;
          if (data[c + probeS] !== data[i + probeS]) continue;
          let l = 0;
          while (l < maxLen && data[c + l] === data[i + l]) l++;
          if (l >= 3) {
            paretoAdd(s, i, l, d);
            const sc = l * 4 - (DIST_EBITS[d] + 3);
            if (sc > bestScore) { bestScore = sc; bl = l; bd = d; }
          }
          if (l > best) {
            best = l;
            if (l >= maxLen) break;
          }
        }
      }
    }
    bestLen[i] = bl >= 3 ? bl : 0;
    bestDist[i] = bd;
    prevLen = bestLen[i];
    prevDist = bestDist[i];
  }
}

// Greedy lazy walk over the match arrays; returns nothing, fills freqs.
function greedyFreqs(data, n, s) {
  const { bestLen, bestDist, litFreq, distFreq } = s;
  litFreq.fill(0);
  distFreq.fill(0);
  let i = 0;
  while (i < n) {
    const L = bestLen[i];
    if (L >= 3) {
      const L2 = i + 1 < n ? bestLen[i + 1] : 0;
      if (L2 > L) { litFreq[data[i]]++; i++; continue; }
      litFreq[LEN_CODE[L]]++;
      distFreq[DIST_CODE[bestDist[i]]]++;
      i += L;
    } else {
      litFreq[data[i]]++;
      i++;
    }
  }
  litFreq[256]++;
}

// One DP pass: cheapest literal/match path under the current code lengths.
// Fills decLen/decDist/prevPos; returns the token arrays (reversed fill).
function dpPass(data, n, s) {
  const { mCount, mLen, mDist, cost, prevPos, decLen, decDist, litLen, distLen, lenPart, tokKind, tokVal, tokDist } = s;
  // cost model: literal cost = litLen[byte]; match cost = lenPart[l] + dist part.
  for (let l = 3; l <= 258; l++) lenPart[l] = litLen[LEN_CODE[l]] + LEN_EBITS[l];
  cost.fill(0x3fffffff);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    const nl = c + litLen[data[i]];
    if (nl < cost[i + 1]) { cost[i + 1] = nl; prevPos[i + 1] = i; decLen[i + 1] = 0; }
    // Every Pareto (length, distance) pair at this position: a shorter match
    // at a nearer distance can be cheaper than the longest match far away.
    const pcnt = mCount[i];
    for (let k = 0; k < pcnt; k++) {
      const L = mLen[i * 4 + k];
      const d = mDist[i * 4 + k];
      const base = c + distLen[DIST_CODE[d]] + DIST_EBITS[d];
      const maxTry = L < 8 ? L : 8;
      for (let l = 3; l <= maxTry; l++) {
        const nc = base + lenPart[l];
        if (nc < cost[i + l]) { cost[i + l] = nc; prevPos[i + l] = i; decLen[i + l] = l; decDist[i + l] = d; }
      }
      if (L > 8) {
        const nc = base + lenPart[L];
        if (nc < cost[i + L]) { cost[i + L] = nc; prevPos[i + L] = i; decLen[i + L] = L; decDist[i + L] = d; }
      }
    }
  }
  // Backtrack from n, filling tokens from the end, counting frequencies.
  const { litFreq, distFreq } = s;
  litFreq.fill(0);
  distFreq.fill(0);
  let t = n + 1;
  let p = n;
  while (p > 0) {
    const from = prevPos[p];
    const l = decLen[p];
    t--;
    if (l === 0) {
      tokKind[t] = 0;
      tokVal[t] = data[from];
      litFreq[data[from]]++;
    } else {
      tokKind[t] = 1;
      tokVal[t] = l;
      tokDist[t] = decDist[p];
      litFreq[LEN_CODE[l]]++;
      distFreq[DIST_CODE[decDist[p]]]++;
    }
    p = from;
  }
  litFreq[256]++;
  return t; // tokens live in [t, n+1)
}

// Emit one block for the tokens in [t0, n+1), choosing dynamic, fixed or
// stored Huffman by exact bit cost (dynamic header included). Fixed wins
// when the token distribution is close to the fixed lengths (saves the
// ~120-byte dynamic header); stored wins only on incompressible blocks.
function emitBlock(w, data, n, s, t0, isLast) {
  const { tokKind, tokVal, tokDist, litFreq, distFreq } = s;
  // Code lengths from the token frequencies.
  const litLen = packageMergeLengths(litFreq, 15);
  const distLen = packageMergeLengths(distFreq, 15);
  let hasMatch = false;
  for (let d = 0; d < 30; d++) if (distFreq[d] > 0) { hasMatch = true; break; }
  if (!hasMatch) distLen[0] = 1;
  // Trim HLIT / HDIST.
  let maxLit = 256;
  for (let i = 285; i > 256; i--) if (litLen[i] > 0) { maxLit = i; break; }
  let maxDist = 0;
  for (let i = 29; i >= 0; i--) if (distLen[i] > 0) { maxDist = i; break; }
  const hlit = maxLit - 256; // field value: codes - 257
  const hdist = maxDist; // field value: codes - 1
  // RLE-encode the length sequence.
  const seqLen = maxLit + 1 + maxDist + 1;
  const seq = new Uint8Array(seqLen);
  seq.set(litLen.subarray(0, maxLit + 1), 0);
  seq.set(distLen.subarray(0, maxDist + 1), maxLit + 1);
  const clSyms = [];
  const clExtra = [];
  const clFreq = new Uint32Array(19);
  let i = 0;
  while (i < seqLen) {
    const v = seq[i];
    let run = 1;
    while (i + run < seqLen && seq[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const k = Math.min(138, r);
        clSyms.push(18); clExtra.push(k - 11); clFreq[18]++;
        r -= k;
      }
      if (r >= 3) { clSyms.push(17); clExtra.push(r - 3); clFreq[17]++; r = 0; }
      while (r > 0) { clSyms.push(0); clFreq[0]++; r--; }
    } else {
      clSyms.push(v); clFreq[v]++;
      let r = run - 1;
      while (r >= 3) {
        const k = Math.min(6, r);
        clSyms.push(16); clExtra.push(k - 3); clFreq[16]++;
        r -= k;
      }
      while (r > 0) { clSyms.push(v); clFreq[v]++; r--; }
    }
    i += run;
  }
  const clLen = packageMergeLengths(clFreq, 7);
  // HCLEN: last nonzero CL length in CL_ORDER, at least 4 codes.
  let lastCl = 3;
  for (let k = 18; k >= 0; k--) if (clLen[CL_ORDER[k]] > 0) { lastCl = k; break; }
  const hclen = Math.max(0, lastCl - 3);
  const clCodes = canonicalCodes(clLen);
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  // Bit-reversed codes for emission.
  const litRev = new Uint32Array(288);
  const distRev = new Uint32Array(30);
  const clRev = new Uint32Array(19);
  for (let k = 0; k < 288; k++) if (litLen[k] > 0) litRev[k] = reverseBits(litCodes.codes[k], litLen[k]);
  for (let k = 0; k < 30; k++) if (distLen[k] > 0) distRev[k] = reverseBits(distCodes.codes[k], distLen[k]);
  for (let k = 0; k < 19; k++) if (clLen[k] > 0) clRev[k] = reverseBits(clCodes.codes[k], clLen[k]);
  // Exact token bit costs under dynamic and fixed lengths (extra bits equal).
  let dynTok = litLen[256]; // end-of-block
  let fixTok = 7;
  for (let t = t0; t < n + 1; t++) {
    if (tokKind[t] === 0) {
      const b = tokVal[t];
      dynTok += litLen[b];
      fixTok += FIXED_LIT_LEN[b];
    } else {
      const l = tokVal[t];
      const d = tokDist[t];
      const lc = LEN_CODE[l];
      const dc = DIST_CODE[d];
      dynTok += litLen[lc] + LEN_EBITS[l] + distLen[dc] + DIST_EBITS[d];
      fixTok += FIXED_LIT_LEN[lc] + LEN_EBITS[l] + 5 + DIST_EBITS[d];
    }
  }
  let dynHdr = 3 + 5 + 5 + 4 + 4 * (hclen + 4);
  let ei = 0;
  for (let k = 0; k < clSyms.length; k++) {
    const sym = clSyms[k];
    dynHdr += clLen[sym];
    if (sym === 16) { dynHdr += 2; ei++; }
    else if (sym === 17) { dynHdr += 3; ei++; }
    else if (sym === 18) { dynHdr += 7; ei++; }
  }
  const dynBits = dynHdr + dynTok;
  const fixBits = 3 + fixTok;
  const bitsNow = w.pos * 8 + w.bitCnt;
  const storedBits = 3 + ((8 - ((bitsNow + 3) % 8)) % 8) + 32 + 8 * n;
  // Stored blocks carry a 16-bit LEN, so a block over 65535 bytes can never
  // be stored (the truncated LEN would corrupt the stream).
  if (n <= 65535 && storedBits <= dynBits && storedBits <= fixBits) {
    w.write(isLast ? 1 : 0, 1);
    w.write(0, 2); // stored
    w.byteAlign();
    w.buf[w.pos++] = n & 0xff;
    w.buf[w.pos++] = (n >>> 8) & 0xff;
    w.buf[w.pos++] = (~n) & 0xff;
    w.buf[w.pos++] = ((~n) >>> 8) & 0xff;
    w.buf.set(data.subarray(0, n), w.pos);
    w.pos += n;
    return;
  }
  if (fixBits < dynBits) {
    w.write(isLast ? 1 : 0, 1);
    w.write(1, 2); // fixed Huffman
    for (let t = t0; t < n + 1; t++) {
      if (tokKind[t] === 0) {
        const b = tokVal[t];
        w.write(FIXED_LIT_CODE[b], FIXED_LIT_LEN[b]);
      } else {
        const l = tokVal[t];
        const d = tokDist[t];
        const lc = LEN_CODE[l];
        w.write(FIXED_LIT_CODE[lc], FIXED_LIT_LEN[lc]);
        if (LEN_EBITS[l] > 0) w.write(LEN_EVAL[l], LEN_EBITS[l]);
        w.write(reverseBits(DIST_CODE[d], 5), 5);
        if (DIST_EBITS[d] > 0) w.write(DIST_EVAL[d], DIST_EBITS[d]);
      }
    }
    w.write(FIXED_LIT_CODE[256], 7);
    return;
  }
  w.write(isLast ? 1 : 0, 1);
  w.write(2, 2); // dynamic Huffman
  w.write(hlit, 5);
  w.write(hdist, 5);
  w.write(hclen, 4);
  for (let k = 0; k < hclen + 4; k++) w.write(clLen[CL_ORDER[k]], 3);
  ei = 0;
  for (let k = 0; k < clSyms.length; k++) {
    const sym = clSyms[k];
    w.write(clRev[sym], clLen[sym]);
    if (sym === 16) w.write(clExtra[ei++], 2);
    else if (sym === 17) w.write(clExtra[ei++], 3);
    else if (sym === 18) w.write(clExtra[ei++], 7);
  }
  for (let t = t0; t < n + 1; t++) {
    if (tokKind[t] === 0) {
      const b = tokVal[t];
      w.write(litRev[b], litLen[b]);
    } else {
      const l = tokVal[t];
      const d = tokDist[t];
      const lc = LEN_CODE[l];
      w.write(litRev[lc], litLen[lc]);
      if (LEN_EBITS[l] > 0) w.write(LEN_EVAL[l], LEN_EBITS[l]);
      const dc = DIST_CODE[d];
      w.write(distRev[dc], distLen[dc]);
      if (DIST_EBITS[d] > 0) w.write(DIST_EVAL[d], DIST_EBITS[d]);
    }
  }
  w.write(litRev[256], litLen[256]);
}

// opts: blockSize (default 524288), chain (default 64), dpRounds (default 6:
// one greedy + six DP passes), budget (default 1024), goodCut (default 64),
// stride (default 0 = off), strideGate (default 258).
export function deflateOptimal(raw, opts = {}) {
  const blockSize = opts.blockSize ?? 131072;
  const chain = opts.chain ?? 64;
  const dpRounds = opts.dpRounds ?? 6;
  const budget = opts.budget ?? 1024;
  const goodCut = opts.goodCut ?? 64;
  const stride = opts.stride ?? 0;
  const strideGate = opts.strideGate ?? 258;
  const w = new BitWriter(raw.length + 65536);
  w.write(0x78, 8);
  w.write(0x9c, 8);
  let off = 0;
  while (off < raw.length) {
    const n = Math.min(blockSize, raw.length - off);
    const data = raw.subarray(off, off + n);
    const s = scratch(n);
    findMatches(data, n, s, chain, budget, goodCut, stride, strideGate);
    greedyFreqs(data, n, s);
    s.litLen.set(packageMergeLengths(s.litFreq, 15));
    s.distLen.set(packageMergeLengths(s.distFreq, 15));
    if (s.distFreq.every((f) => f === 0)) s.distLen[0] = 1;
    let t0 = 0;
    for (let r = 0; r < dpRounds; r++) {
      t0 = dpPass(data, n, s);
      if (r < dpRounds - 1) {
        s.litLen.set(packageMergeLengths(s.litFreq, 15));
        s.distLen.set(packageMergeLengths(s.distFreq, 15));
        if (s.distFreq.every((f) => f === 0)) s.distLen[0] = 1;
      }
    }
    emitBlock(w, data, n, s, t0, off + n >= raw.length);
    off += n;
  }
  w.byteAlign();
  const ad = adler32(raw);
  w.write((ad >>> 24) & 0xff, 8);
  w.write((ad >>> 16) & 0xff, 8);
  w.write((ad >>> 8) & 0xff, 8);
  w.write(ad & 0xff, 8);
  return w.buf.subarray(0, w.pos);
}
