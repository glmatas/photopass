import { fnv1a, HEADER_LEN, packFrame } from './vendor/optical/core.js';

export const colorFlag = 0x80000000;
const prefixSize = 12;
const extraHeader = 8;
const palette = [[255,226,181], [180,230,255], [106,45,17], [14,51,112]];
// Brightness, red-vs-blue, and green-vs-magenta can be read independently.
const fastPalette = Array.from({length:8}, (_, index) => {
  const level = index & 4 ? 60 : 194;
  const warm = index & 2 ? -35 : 35, green = index & 1 ? -22 : 22;
  return [level + warm - green / 2, level + green, level - warm - green / 2];
});

// Use the brightness frame's geometry. Four quiet-zone modules stay white.
export function paintColor(pixels, base, extra, margin, third) {
  const rowSize = base.size + margin * 2;
  for (let y = 0; y < base.size; y++) {
    let dest = 4 * ((y + margin) * rowSize + margin);
    for (let x = 0; x < base.size; x++, dest += 4) {
      const i = y * base.size + x;
      const pair = 2 * base.data[i] + extra.data[i];
      const rgb = third ? fastPalette[2 * pair + third.data[i]] : palette[pair];
      pixels[dest] = rgb[0];
      pixels[dest + 1] = rgb[1];
      pixels[dest + 2] = rgb[2];
    }
  }
}

// Omit repeated stream metadata on the color layer. Check the complete
// reconstructed frame before admitting a color equation into the decoder.
export function colorPacket(prefix, header, seq, block, highSpeed = false) {
  const bytes = new Uint8Array(prefixSize + extraHeader + block.length);
  const view = new DataView(bytes.buffer, prefixSize);
  bytes.set(prefix);
  view.setUint32(0, seq);
  const check = fnv1a(packFrame({...header, seq}, block));
  view.setUint32(4, highSpeed ? check ^ 0x48370000 : check);
  bytes.set(block, prefixSize + extraHeader);
  return bytes;
}

export function restoreColor(bytes, prefix, header, highSpeed = false) {
  if (!header || bytes?.length !== prefixSize + extraHeader + header.blockLen ||
      !prefix.every((b, i) => bytes[i] === b)) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset + prefixSize);
  const seq = view.getUint32(0);
  if (seq >>> 30 !== 3) return;
  const frame = packFrame({...header, seq}, bytes.subarray(prefixSize + extraHeader));
  const target = view.getUint32(4);
  if (fnv1a(frame) !== (highSpeed ? (target ^ 0x48370000) >>> 0 : target)) return;
  const result = new Uint8Array(prefixSize + HEADER_LEN + header.blockLen);
  result.set(prefix);
  result.set(frame, prefixSize);
  return result;
}
