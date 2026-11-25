// Systematic Cauchy erasure code over GF(256). Keep groups small enough for
// a phone to repair missing packets while camera frames are still arriving.
const groupSize = 48;
// Version 40-L has 2,953 binary bytes. Reserve 12 for the photo ID, six
// for the H7 marker and checksum, and 20 for the common frame header.
export const highBlockBytes = 2915;
const exp = new Uint8Array(510);
const log = new Uint8Array(256);
for (let i = 0, value = 1; i < 255; i++) {
  exp[i] = exp[i + 255] = value;
  log[value] = i;
  value <<= 1;
  if (value & 256) value ^= 0x11d;
}
const inverse = value => exp[255 - log[value]];
const products = Array.from({length:256}, (_, a) =>
  Uint8Array.from({length:256}, (_, b) => a && b ? exp[log[a] + log[b]] : 0));

function geometry(k, seq) {
  const groups = Math.ceil(k / groupSize);
  const n = seq & 0x1fffffff;
  const pass = Math.floor(n / groups);
  // Rotate group order between sweeps so periodic camera drops move around.
  // Reduce before multiplying to keep the triangular offset an exact integer.
  const cycle = pass % (2 * groups);
  const group = (n % groups + cycle * (cycle + 1) / 2) % groups;
  const first = group * groupSize;
  const layer = seq >>> 30 === 2 ? 0 : 1 + ((seq >>> 29) & 1);
  return {first, count:Math.min(groupSize, k - first), row:(pass * 3 + layer) % 256};
}
function coefficients(count, row) {
  const weights = new Uint8Array(count);
  if (row < count) weights[row] = 1;
  else for (let i = 0; i < count; i++) weights[i] = inverse(row ^ i);
  return weights;
}
function addScaled(target, source, factor) {
  const table = products[factor];
  for (let i = 0; i < source.length; i++) target[i] ^= table[source[i]];
}

export function repairEncoder(bytes, blockLen) {
  const k = Math.ceil(bytes.length / blockLen);
  return { k, encode(seq) {
    const {first, count, row} = geometry(k, seq);
    const out = new Uint8Array(blockLen);
    if (row < count) {
      const pos = (first + row) * blockLen;
      out.set(bytes.subarray(pos, pos + blockLen));
    } else {
      const weights = coefficients(count, row);
      for (let i = 0; i < count; i++) {
        const pos = (first + i) * blockLen;
        addScaled(out, bytes.subarray(pos, pos + blockLen), weights[i]);
      }
    }
    return out;
  }};
}

export class RepairDecoder {
  constructor(k, blockLen, totalLen) {
    this.k = k;
    this.blockLen = blockLen;
    this.output = new Uint8Array(totalLen);
    this.groups = new Map();
    this.framesNew = 0;
  }
  get isComplete() { return this.framesNew === this.k; }
  get solvedCount() { return this.framesNew; }
  assemble() { return this.output; }
  addFrame(seq, data) {
    const {first, count, row} = geometry(this.k, seq);
    let group = this.groups.get(first);
    if (group === true || group?.seen.has(row)) return;
    if (!group) {
      group = {basis:new Array(count), seen:new Set()};
      this.groups.set(first, group);
    }
    group.seen.add(row);
    const weights = coefficients(count, row);
    const bytes = data.slice();
    // Eliminate every existing pivot, including pivots after a vacant column.
    for (let i = 0; i < count; i++) {
      const pivot = group.basis[i], factor = weights[i];
      if (!pivot || !factor) continue;
      addScaled(weights, pivot.weights, factor);
      addScaled(bytes, pivot.bytes, factor);
    }
    const col = weights.findIndex(Boolean);
    if (col < 0) return;
    if (weights[col] !== 1) {
      const table = products[inverse(weights[col])];
      for (let i = 0; i < count; i++) weights[i] = table[weights[i]];
      for (let i = 0; i < bytes.length; i++) bytes[i] = table[bytes[i]];
    }
    for (const pivot of group.basis) {
      const factor = pivot?.weights[col];
      if (!factor) continue;
      addScaled(pivot.weights, weights, factor);
      addScaled(pivot.bytes, bytes, factor);
    }
    group.basis[col] = {weights, bytes};
    this.framesNew++;
    if (group.seen.size === count) {
      for (let i = 0; i < count; i++) {
        const pos = (first + i) * this.blockLen;
        this.output.set(group.basis[i].bytes.subarray(0, this.output.length - pos), pos);
      }
      this.groups.set(first, true);
    }
  }
}
