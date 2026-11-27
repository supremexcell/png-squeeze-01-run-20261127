// Length-limited Huffman code lengths (package-merge, Larmore-Hirschberg,
// after Brumme's exposition) + canonical code assignment. Written from the
// algorithm's description, not copied from any implementation.
export function packageMergeLengths(freqs, limit) {
  const syms = [];
  for (let s = 0; s < freqs.length; s++) if (freqs[s] > 0) syms.push(s);
  const n = syms.length;
  const lengths = new Uint8Array(freqs.length);
  if (n === 0) return lengths;
  if (n <= 2) { for (const s of syms) lengths[s] = 1; return lengths; }
  const sorted = [...syms].sort((a, b) => freqs[a] - freqs[b]);
  const hist = sorted.map((s) => ({ w: freqs[s], pkg: false }));
  const rows = [hist];
  for (let iter = 0; iter < limit - 1; iter++) {
    const prev = rows[rows.length - 1];
    const pkgs = [];
    for (let i = 0; i + 1 < prev.length; i += 2) {
      pkgs.push({ w: prev[i].w + prev[i + 1].w, pkg: true });
    }
    const merged = [];
    let pi = 0, hi = 0;
    while (pi < pkgs.length || hi < hist.length) {
      if (hi < hist.length && (pi >= pkgs.length || hist[hi].w <= pkgs[pi].w)) merged.push(hist[hi++]);
      else merged.push(pkgs[pi++]);
    }
    rows.push(merged);
  }
  let take = 2 * n - 2;
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r];
    let numMerged = 0;
    let symbol = 0;
    const lim = Math.min(take, row.length);
    for (let i = 0; i < lim; i++) {
      if (row[i].pkg) numMerged++;
      else { lengths[sorted[symbol]]++; symbol++; }
    }
    take = 2 * numMerged;
    if (numMerged === 0) break;
  }
  return lengths;
}

// Canonical Huffman codes from lengths: returns { codes: Uint32Array, lengths }.
// Codes are assigned in symbol order within each length, first code of each
// length derived from the previous length's count (RFC 1951 §3.2.2).
export function canonicalCodes(lengths) {
  const maxLen = Math.max(...lengths);
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return { codes, lengths };
}
