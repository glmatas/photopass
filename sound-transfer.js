import { openSoundModem } from './sound-modem.js';
import { PhotoPeer } from './peer.js';
import { decodeCompact, encodeCompact } from './signal-codec.js';
import { LTDecoder, LTEncoder, fnv1a, frameIndices, packFile, solitonCdf, unpackFile } from './vendor/optical/core.js?v=5';

const BEACON = 1, OFFER = 2, ANSWER = 3, DATA = 4, RECEIPT = 5, USE_SOUND = 6;
const HEADER = 28, BLOCK_HEADER = 16, GROUP = 128;
const LIMIT = 32 * 1024 * 1024, CONTAINER_LIMIT = LIMIT + 49 + 2 * 65535;
const OFFER_REPEAT = 12000, FALLBACK_AFTER = 35000, READVERTISE = 45000;
const TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
const abortError = () => new DOMException('Sound pickup canceled.', 'AbortError');
const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
const viewOf = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Enter the six digits shown on the kiosk.');
  return Number(code);
}
function mime(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
}
function imageName(name, type) {
  const leaf = String(name || 'Photo').split(/[\\/]/).pop();
  const stem = leaf.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 90);
  return (stem || 'Photo') + '.' + TYPES.get(type);
}

// Every acoustic message is addressed to one human-entered code and one file
// session. Quiet provides packet CRC and FEC. SDP fragments additionally share
// a negotiation generation and a checksum of the complete description.
function packet(kind, code, tag, data = new Uint8Array(0)) {
  const result = new Uint8Array(HEADER + data.length);
  result.set([0x50, 0x50, 0x53, 1, kind, code >>> 16, code >>> 8, code], 0);
  result.set(tag, 8); result.set(data, HEADER);
  return result;
}
function parse(raw, code) {
  if (!(raw instanceof Uint8Array)) raw = new Uint8Array(raw);
  if (raw.length < HEADER || raw.length > 4096 || raw[0] !== 0x50 || raw[1] !== 0x50 || raw[2] !== 0x53 ||
      raw[3] !== 1 || raw[5] * 65536 + raw[6] * 256 + raw[7] !== code) return null;
  const tag = raw.subarray(8, HEADER);
  return { kind: raw[4], tag, key: hex(tag), body: raw.subarray(HEADER) };
}
function signalPackets(kind, code, tag, round, description, mtu) {
  const bytes = encodeCompact(description, hex(tag) + '.' + round);
  const size = mtu - HEADER - 10, count = Math.ceil(bytes.length / size), checksum = fnv1a(bytes);
  if (size < 32 || count > 160) throw new Error('These connection details are too large for audio pairing.');
  return Array.from({ length: count }, (_, i) => {
    const chunk = bytes.subarray(i * size, (i + 1) * size), body = new Uint8Array(10 + chunk.length);
    const v = viewOf(body); v.setUint32(0, round); v.setUint32(4, checksum); body[8] = i; body[9] = count;
    body.set(chunk, 10); return packet(kind, code, tag, body);
  });
}
function readFragments(previous, msg, expected) {
  const b = msg.body;
  if (b.length <= 10 || b[9] === 0 || b[9] > 160 || b[8] >= b[9]) return previous;
  const v = viewOf(b), round = v.getUint32(0), crc = v.getUint32(4), count = b[9];
  let state = previous;
  if (!state || state.round !== round || state.crc !== crc || state.count !== count) {
    state = { round, crc, count, bytes: 0, chunks: new Map() };
  }
  if (state.description || state.chunks.has(b[8])) return state;
  state.chunks.set(b[8], b.slice(10)); state.bytes += b.length - 10;
  if (state.bytes > 100000) return null;
  if (state.chunks.size === count) {
    const whole = new Uint8Array(state.bytes);
    let pos = 0;
    for (let i = 0; i < count; i++) { const part = state.chunks.get(i); whole.set(part, pos); pos += part.length; }
    try {
      if (fnv1a(whole) !== crc) return null;
      const decoded = decodeCompact(whole, expected);
      if (decoded.session !== msg.key + '.' + round) return null;
      state.description = decoded.description;
      state.chunks.clear();
    } catch { return null; }
  }
  return state;
}

function lifetime(opts) {
  const ctl = new AbortController();
  let modem, peer, last = '';
  function close() {
    if (ctl.signal.aborted) return;
    ctl.abort();
    opts.signal?.removeEventListener('abort', close);
    globalThis.removeEventListener?.('pagehide', close);
    modem?.close(); peer?.close();
    modem = peer = undefined;
  }
  close.close = close;
  opts.signal?.addEventListener('abort', close, { once: true });
  globalThis.addEventListener?.('pagehide', close, { once: true });
  if (opts.signal?.aborted) close();
  return {
    close, signal: ctl.signal, get active() { return !ctl.signal.aborted; },
    get modem() { return modem; }, set modem(m) { if (ctl.signal.aborted) m.close(); else modem = m; },
    get peer() { return peer; }, set peer(p) { peer?.close(); if (ctl.signal.aborted) p?.close(); else peer = p; },
    status(text) { if (!ctl.signal.aborted && text !== last) { last = text; opts.onStatus?.(text); } },
    fail(error) { if (!ctl.signal.aborted) { close(); opts.onError?.(error.message || String(error)); } },
  };
}

// These ordinary Decimen sequences each select one distinct source block.
// Sending them first lets every previously published receiver finish a clean
// transfer in exactly k frames. Low sequence numbers remain available for repair.
function scheduleForGroup(k, seed) {
  const cdf = solitonCdf(k), singles = new Uint32Array(k);
  let found = 0;
  for (let n = 0; n < 131072 && found < k; n++) {
    const seq = 0x80000000 + n, indices = frameIndices(k, cdf, seed, seq);
    if (indices.length === 1 && !singles[indices[0]]) {
      singles[indices[0]] = seq;
      found++;
    }
  }
  // Planning has a hard CPU ceiling; a missing entry is an ordinary fountain
  // equation, and later repair sweeps work regardless of the initial plan.
  for (let i = 0; i < k; i++) if (!singles[i]) singles[i] = 0x90000000 + i;
  let cursor = 0;
  function repair() {
    // When most source blocks are already known, wider XOR equations have
    // a better chance to cover a missing block. Tiny groups keep all degrees.
    const minDegree = Math.min(5, 1 + Math.floor(k / 16));
    for (let tries = 0; ; tries++) {
      const seq = cursor;
      cursor = (cursor + 1) % 0x80000000;
      if (minDegree === 1 || tries === 63 || frameIndices(k, cdf, seed, seq).length >= minDegree) return seq;
    }
  }
  return { singles, repair };
}

// Small independent fountain generations keep memory bounded and a 32 MiB
// file fits the wire format even on a modem with a smaller maximum packet.
function bulkSource(container, tag, code, mtu) {
  const block = Math.min(1024, mtu - HEADER - BLOCK_HEADER);
  if (block < 64) throw new Error('The audio modem cannot carry photo packets.');
  const checksum = fnv1a(container), groups = Math.ceil(container.length / (block * GROUP));
  const seed = (tag[8] << 8) | tag[9];
  const plans = new Map();
  let group = 0, pass = 0, index = 0, encoder;
  return () => {
    if (!encoder) {
      const start = group * block * GROUP;
      encoder = new LTEncoder(container.subarray(start, start + block * GROUP), block, seed ^ group);
      if (!plans.has(group)) plans.set(group, scheduleForGroup(encoder.k, seed ^ group));
    }
    // Sweep the entire file before sending redundancy. Alternate fresh repair
    // equations with rotated systematic sweeps so late joiners can also finish.
    const systematic = pass % 2 === 0, cycle = Math.floor(pass / 2);
    const perPass = systematic ? encoder.k : Math.ceil(encoder.k * 0.65) + 6;
    const plan = plans.get(group);
    const seq = systematic
      ? plan.singles[(index + cycle * (13 + group)) % encoder.k]
      : plan.repair();
    const data = new Uint8Array(BLOCK_HEADER + block), v = viewOf(data);
    v.setUint32(0, container.length); v.setUint32(4, checksum); v.setUint16(8, block); v.setUint16(10, group); v.setUint32(12, seq);
    data.set(encoder.encode(seq), BLOCK_HEADER);
    if (++index >= perPass) { index = 0; encoder = undefined; if (++group >= groups) { group = 0; pass++; } }
    return packet(DATA, code, tag, data);
  };
}
function receiveBlock(old, message) {
  const b = message.body;
  if (b.length <= BLOCK_HEADER) return old;
  const v = viewOf(b), total = v.getUint32(0), crc = v.getUint32(4), block = v.getUint16(8), group = v.getUint16(10);
  if (total < 49 || total > CONTAINER_LIMIT || block < 64 || block > 2048 || b.length !== BLOCK_HEADER + block) return old;
  const stride = block * GROUP, groups = Math.ceil(total / stride);
  if (group >= groups) return old;
  const state = old || { total, crc, block, output: new Uint8Array(total), parts: new Array(groups), bytes: 0, done: 0 };
  if (state.total !== total || state.crc !== crc || state.block !== block || state.parts[group] === true) return state;
  const len = Math.min(stride, total - group * stride), k = Math.ceil(len / block);
  let p = state.parts[group];
  if (!p) {
    const seed = (message.tag[8] << 8) | message.tag[9];
    p = state.parts[group] = { decoder: new LTDecoder(k, block, seed ^ group, len), estimated: 0 };
  }
  p.decoder.addFrame(v.getUint32(12), b.subarray(BLOCK_HEADER));
  if (p.decoder.isComplete) {
    state.output.set(p.decoder.assemble(), group * stride);
    state.bytes += len - p.estimated; state.parts[group] = true; state.done++;
  } else if (p.decoder.framesNew > 3 * k + 256) {
    state.bytes -= p.estimated; state.parts[group] = undefined;
  } else {
    const next = len * Math.min(0.98, Math.max(p.decoder.solvedCount / k, p.decoder.framesNew / (1.18 * k + 6)));
    state.bytes += next - p.estimated; p.estimated = next;
  }
  return state;
}
async function verifyBulk(state, tag) {
  const bytes = state.output, header = viewOf(bytes), size = header.getUint32(9, true);
  if (fnv1a(bytes) !== state.crc || bytes[4] !== 0 || !size || size > LIMIT || size !== header.getUint32(13, true)) {
    throw new Error('The audio photo failed its size or checksum check.');
  }
  const photo = await unpackFile(bytes);
  if (!TYPES.has(photo.type) || mime(photo.bytes) !== photo.type) throw new Error('The recovered file is not a supported photo.');
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', photo.bytes));
  if (!sha.every((b, i) => b === photo.sha256[i]) || !tag.subarray(8).every((b, i) => b === sha[i])) {
    throw new Error('The original photo failed verification. Start a new pickup.');
  }
  return { blob: new Blob([photo.bytes], { type: photo.type }), name: imageName(photo.name, photo.type), sha };
}

export async function startSoundSender(file, opts) {
  const code = validCode(opts.code);
  if (!file || !file.size || file.size > LIMIT || !TYPES.has(file.type)) throw new Error('Choose a JPEG, PNG or WebP up to 32 MiB.');
  const life = lifetime(opts);
  let tag, key, sha, nextBlock, offer, round, fragments, accepted = false, direct = false;
  let bulk = false, firstOfferAt = 0, lastOffer = 0, nextRetry = 0, quietUntil = 0;
  let lastBeacon = 0, burst = 0;
  function soundOnly() {
    if (!life.active) return;
    if (!bulk || direct) life.status('Sending the original through sound. Keep both devices close; large photos can take hours.');
    bulk = true; direct = false;
  }
  function sent() {
    if (!life.active) return;
    life.close(); opts.onSent?.();
  }
  function directFailed() {
    life.peer = undefined; offer = fragments = undefined; accepted = false; direct = false;
    nextRetry = Date.now() + READVERTISE; soundOnly();
  }
  async function offerDirect() {
    if (!life.active || !life.modem?.listening || !globalThis.RTCPeerConnection) { soundOnly(); return; }
    round = crypto.getRandomValues(new Uint32Array(1))[0];
    offer = fragments = undefined; accepted = false; lastOffer = 0;
    const peer = new PhotoPeer({
      onProgress(f) { if (life.peer === peer) { direct = true; life.status('Sending the original directly.'); opts.onProgress?.(f); } },
      onSent() { if (life.peer === peer) sent(); },
      onFailure() { if (life.peer === peer) directFailed(); },
    });
    life.peer = peer;
    try {
      const desc = await peer.offer(file);
      if (life.active && life.peer === peer) offer = signalPackets(OFFER, code, tag, round, desc, life.modem.maxPacketSize);
    } catch { if (life.active && life.peer === peer) directFailed(); }
  }
  function onPacket(raw) {
    if (!life.active || !key) return;
    const m = parse(raw, code);
    if (!m || m.key !== key) return;
    if (m.kind === RECEIPT && m.body.length === 32 && sha.every((b, i) => b === m.body[i])) return sent();
    if (m.kind === USE_SOUND && !direct) { quietUntil = 0; soundOnly(); return; }
    if (m.kind !== ANSWER || m.body.length < 10 || viewOf(m.body).getUint32(0) !== round || accepted || !life.peer) return;
    fragments = readFragments(fragments, m, 'answer');
    if (!fragments?.description) return;
    accepted = true;
    const peer = life.peer;
    life.status('Connecting to the phone…');
    // A direct route may still succeed while the independent acoustic transfer starts.
    quietUntil = Date.now() + 6500;
    peer.accept(fragments.description).catch(() => { if (life.active && life.peer === peer) directFailed(); });
  }
  async function broadcast() {
    while (life.active) {
      const now = Date.now();
      if (direct) { await sleep(200); continue; }
      if (!bulk && firstOfferAt && now - firstOfferAt >= FALLBACK_AFTER) soundOnly();
      if (bulk && !life.peer && life.modem.listening && globalThis.RTCPeerConnection && now >= nextRetry) void offerDirect();
      if (life.modem.listening && !accepted && offer && now - lastOffer >= (bulk ? READVERTISE : OFFER_REPEAT)) {
        lastOffer = now;
        for (const data of offer) { if (!life.active || accepted) break; await life.modem.send(data); }
        if (!firstOfferAt) firstOfferAt = Date.now();
        quietUntil = Date.now() + (bulk ? 3700 : 2300);
        continue;
      }
      if (bulk && now >= quietUntil) {
        await life.modem.send(nextBlock());
        // Leave a receipt-sized listening window after every frame when the
        // kiosk has a mic. Phones can finish on any fountain frame.
        if (life.modem.listening) quietUntil = Date.now() + 420 + Math.random() * 120;
        else if (++burst % 5 === 0) quietUntil = Date.now() + 100 + Math.random() * 130;
      } else if (!bulk && !offer && now - lastBeacon > 5000) {
        lastBeacon = now; await life.modem.send(packet(BEACON, code, tag));
      } else await sleep(130);
    }
  }
  try {
    if (!life.active) throw abortError();
    life.status('Preparing sound pickup…');
    const open = openSoundModem({ context: opts.context, listen: true, signal: life.signal, onPacket, onError: () => soundOnly() })
      .then(m => { life.modem = m; });
    const prepare = (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mime(bytes) !== file.type) throw new Error('The file contents do not match the selected photo format.');
      return (await packFile(imageName(file.name, file.type), file.type, bytes)).container;
    })();
    const [, container] = await Promise.all([open, prepare]);
    if (!life.active) throw abortError();
    sha = container.slice(17, 49); tag = new Uint8Array(20);
    crypto.getRandomValues(tag.subarray(0, 8)); tag.set(sha.subarray(0, 12), 8); key = hex(tag);
    nextBlock = bulkSource(container, tag, code, life.modem.maxPacketSize);
    life.status('Playing the pairing signal. Open the listening page on the phone.');
    void offerDirect(); void broadcast().catch(e => life.fail(e));
    return life.close;
  } catch (error) { life.close(); throw error; }
}

export async function startSoundReceiver(opts) {
  const code = validCode(opts.code), life = lifetime(opts);
  let key, tag, fragments, round, answer, busy = false, replying = false;
  let groups, verifying = false, direct = false, lastReply = 0, lastProgress = 0;
  const fallbackText = 'Listening for the original photo over sound. Keep this page open and the devices close.';
  async function finish(blob, name, sha) {
    if (!life.active) return;
    try {
      const receipt = packet(RECEIPT, code, tag, sha);
      // Give the sender its completion receipt before the UI closes the audio
      // context. A missing speaker must never prevent the visitor saving a file.
      const acknowledge = async () => {
        await sleep(100);
        if (!life.active) return;
        await life.modem.send(receipt);
        await sleep(100);
        if (life.active) await life.modem.send(receipt);
      };
      await Promise.race([acknowledge(), sleep(1600)]);
    } catch { /* One-way senders keep broadcasting until the kiosk is stopped. */ }
    if (!life.active) return;
    life.close(); opts.onProgress?.(1); opts.onPhoto?.(blob, name);
  }
  async function askForBulk() {
    life.status(fallbackText);
    try { await life.modem.send(packet(USE_SOUND, code, tag)); } catch { /* Passive listening still works. */ }
  }
  async function sendAnswer() {
    if (replying || !answer || !life.active || direct || verifying || Date.now() - lastReply < 1600) return;
    replying = true; lastReply = Date.now();
    const list = answer;
    try {
      await sleep(100 + Math.random() * 180);
      for (const data of list) { if (!life.active || answer !== list || direct) break; await life.modem.send(data); }
    } catch { if (life.active) life.status(fallbackText); }
    finally { replying = false; }
  }
  async function respond(state) {
    if (busy || verifying || direct) return;
    if (!globalThis.RTCPeerConnection) { if (round !== state.round) { round = state.round; void askForBulk(); } return; }
    if (round === state.round) { void sendAnswer(); return; }
    busy = true; round = state.round; answer = undefined;
    const peer = new PhotoPeer({
      onProgress(f) { if (life.peer === peer && !verifying) { direct = true; life.status('Receiving the original directly.'); opts.onProgress?.(f); } },
      async onPhoto(blob, name) {
        if (life.peer !== peer || verifying) return;
        verifying = true;
        try {
          const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
          if (!tag.subarray(8).every((b, i) => b === sha[i])) throw new Error('The audio session identified a different photo.');
          await finish(blob, name, sha);
        } catch (error) { life.fail(error); }
      },
      onFailure() {
        if (life.peer !== peer || !life.active || verifying) return;
        direct = false; answer = undefined; life.peer = undefined; void askForBulk();
      },
    });
    life.peer = peer;
    if (!groups) life.status('Heard your kiosk. Preparing the audio reply…');
    try {
      const desc = await peer.answer(state.description);
      if (life.active && life.peer === peer) {
        answer = signalPackets(ANSWER, code, tag, round, desc, life.modem.maxPacketSize);
        await sendAnswer();
      }
    } catch { if (life.active && life.peer === peer) { life.peer = undefined; void askForBulk(); } }
    finally { busy = false; }
  }
  function onPacket(raw) {
    if (!life.active || verifying || !life.modem) return;
    const m = parse(raw, code);
    if (!m || ![OFFER, BEACON, DATA].includes(m.kind) || (key && m.key !== key)) return;
    if (!key) { key = m.key; tag = m.tag.slice(); }
    if (m.kind === BEACON && !groups) life.status('Heard your kiosk. Waiting for its connection details…');
    if (m.kind === OFFER) {
      fragments = readFragments(fragments, m, 'offer');
      if (fragments?.description) void respond(fragments);
    }
    if (m.kind !== DATA || direct) return;
    try {
      groups = receiveBlock(groups, m);
      if (!groups) return;
      life.status('Receiving the original through sound. Keep the devices close; large photos can take hours.');
      const progress = Math.min(0.99, groups.bytes / groups.total);
      if (progress - lastProgress >= 0.001) { lastProgress = progress; opts.onProgress?.(progress); }
      if (groups.done !== groups.parts.length) return;
      verifying = true;
      life.status('Verifying the original photo…');
      verifyBulk(groups, tag).then(({ blob, name, sha }) => finish(blob, name, sha)).catch(error => life.fail(error));
    } catch (error) { life.fail(error); }
  }
  try {
    if (!life.active) throw abortError();
    life.status('Listening for the kiosk with your code…');
    life.modem = await openSoundModem({
      context: opts.context, listen: true, signal: life.signal, micTimeoutMs: 30000, onPacket,
      onError: e => { if (life.active) life.fail(e); },
    });
    if (!life.active) throw abortError();
    if (!life.modem.listening) throw new Error('Allow microphone access in this browser to receive the photo through sound.');
    return life.close;
  } catch (error) { life.close(); throw error; }
}
