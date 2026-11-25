import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {repairEncoder, RepairDecoder} from '../light-repair.js';
import {colorPacket, restoreColor} from '../light-color.js';

const blockLen = 2915;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lanes = [0x80000000, 0xc0000000, 0xe0000000];
for (const size of [79, 48 * blockLen, 48 * blockLen + 1, 2_300_000, 32 * 1024 * 1024]) {
  const original = new Uint8Array(size);
  let state = 0x2b3f981a;
  for (let i = 0; i < size; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    original[i] = state >>> 24;
  }
  const block = Math.min(blockLen, size);
  const encoder = repairEncoder(original, block);
  for (const channels of [lanes, lanes.slice(0, 2), [lanes[0]]]) {
    const decoder = new RepairDecoder(encoder.k, block, size);
    const start = 2301;
    const limit = start + encoder.k * 5 + 256;
    for (let n = start; n < limit && !decoder.isComplete; n++) {
      if (n % 5 === 3) continue;
      for (const lane of channels) {
        const seq = lane + n;
        const bytes = encoder.encode(seq);
        decoder.addFrame(seq, bytes);
        decoder.addFrame(seq, bytes);
      }
    }
    assert(decoder.isComplete, 'Receiver should recover after late join and 20% erasures');
    assert.equal(sha(decoder.assemble()), sha(original));
  }
}

const prefix = new Uint8Array(12).fill(9);
const header = {sessionId:2313, blockLen:32, totalLen:96, k:3, payloadFnv:1234};
const packet = colorPacket(prefix, header, 0xe0000001, new Uint8Array(32).fill(7), true);
assert(restoreColor(packet, prefix, header, true));
assert.equal(restoreColor(packet, prefix, header, false), undefined);
for (let offset = 0; offset < packet.length; offset++) {
  const damaged = packet.slice();
  damaged[offset] ^= 4;
  assert.equal(restoreColor(damaged, prefix, header, true), undefined);
}
console.log('Verified 1–3 usable layers, late joins, duplicates, packet loss, checksums and 32 MiB recovery.');
