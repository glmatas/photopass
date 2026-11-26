import { PhotoPeer } from './peer.js?v=12';
import { decodeCompact, encodeCompact } from './signal-codec.js';

// The existing camera reads offers between photo frames. A phone's speaker
// returns the answer to the kiosk microphone. The visitor keeps one camera view.
// Every answer byte costs about 22 ms of pairing tone, so the answer carries
// only the 6-byte pickup nonce, and the offer round is 32 random bits.
const OFFER = 79,
  ANSWER = 97;
const limit = 1200;
// The kiosk waits for a reply long enough for a slow optical read of the offer
// and two plays of the reply, then gives the network its own connection budget.
const REPLY_MS = 60000,
  CONNECT_MS = 30000;
// Two plays of a reply (about 22 ms a byte plus 0.42 s each, 1 s apart) and a
// 2 s margin for the kiosk to decode and start its checks.
const RELEASE_MS = bytes => 2 * (22 * bytes + 420) + 3000;
const FAILED = {
  reply: 'No pairing reply reached the kiosk. Screen transfer is running.',
  network: 'Phone reply received, but the direct network connection failed. Screen transfer is running.',
  dropped: 'The direct connection dropped. Screen transfer is running.',
  start: 'Direct connection could not start. Screen transfer is running.',
};

function message(token, kind, description, round) {
  const payload = encodeCompact(description, round);
  if (payload.length + token.length + 1 > limit) throw new Error('Pairing details exceed one packet.');
  return Uint8Array.of(...token, kind, ...payload);
}

function matches(bytes, token, kind) {
  return (
    bytes?.length > token.length + 1 &&
    bytes.length <= limit &&
    bytes[token.length] === kind &&
    token.every((value, i) => bytes[i] === value)
  );
}

const nonceOf = token => token.subarray(token.length - 6);

// Appended to a failure message so a field test names the stalled phase.
function diagnosis(detail, since, label) {
  const parts = [detail];
  if (since !== undefined) parts.push(Math.round((performance.now() - since) / 1000) + ' s ' + label);
  const text = parts.filter(Boolean).join(', ');
  return text ? ' [' + text + ']' : '';
}

// Trim what the kiosk never uses from the reply, since each byte is airtime:
// the SDP session id, optional candidate extension attributes, and TCP
// candidates (a phone's active TCP candidates need a passive TCP candidate,
// which a kiosk browser does not offer). Every UDP candidate is kept.
export function trimAnswer(sdp) {
  let trimmed = sdp.replace(/^o=(\S+) \d+ /m, 'o=$1 0 ')
    .replace(/^(a=candidate:[^\r\n]*?)(?: (?:generation|network-id|network-cost) \d+)+(?=\r?$)/gm, '$1');
  if (/^a=candidate:\S+ \d+ udp /im.test(trimmed)) trimmed = trimmed.replace(/^a=candidate:\S+ \d+ tcp [^\n]*\n/gim, '');
  return trimmed;
}

function answerMessage(token, description, round) {
  const sdp = trimAnswer(description.sdp);
  const payload = encodeCompact({ type: 'answer', sdp }, round);
  const nonce = nonceOf(token);
  if (payload.length + nonce.length + 1 > limit) throw new Error('Pairing details exceed one packet.');
  return Uint8Array.of(ANSWER, ...nonce, ...payload);
}

function answerPayload(bytes, token) {
  const nonce = nonceOf(token);
  if (!(bytes?.length > nonce.length + 1) || bytes.length > limit || bytes[0] !== ANSWER ||
      !nonce.every((value, i) => bytes[i + 1] === value)) return;
  return bytes.subarray(nonce.length + 1);
}

export function offerPickup(file, token, transfer, signal, onStatus) {
  let peer, round, accepted, acceptedAt, timer;
  function clear() {
    clearTimeout(timer);
    transfer.setOffer();
    peer?.close();
    peer = undefined;
  }
  signal.addEventListener('abort', clear, { once: true });
  function failed(reason, detail = peer?.describe()) {
    const code = diagnosis(detail, acceptedAt, 'after reply');
    clear();
    onStatus(FAILED[reason] + code);
  }
  async function start() {
    if (peer || signal.aborted) return;
    if (!globalThis.RTCPeerConnection) { onStatus('Phone tone received. Using screen transfer.'); return; }
    onStatus('Phone tone received. Pairing for direct transfer…');
    let sending = false;
    const current = new PhotoPeer({
      onSent() { clear(); onStatus('Phone verified the photo over the direct connection.'); },
      onFailure(_, phase, detail) {
        if (peer === current) failed(phase === 'transfer' ? 'dropped' : accepted ? 'network' : 'start', detail);
      },
      onProgress() {
        if (!sending) { sending = true; clearTimeout(timer); onStatus('Sending the photo directly.'); }
      },
    });
    peer = current;
    round = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');
    accepted = false;
    acceptedAt = undefined;
    try {
      const description = await current.offer(file, { quickGather: true });
      if (peer !== current) return;
      transfer.setOffer(message(token, OFFER, description, round));
      timer = setTimeout(() => { if (peer === current && !accepted) failed('reply'); }, REPLY_MS);
    } catch {
      if (peer === current) failed('start');
    }
  }
  async function answer(bytes) {
    const current = peer;
    const payload = current && !accepted && answerPayload(bytes, token);
    if (!payload) return;
    try {
      const decoded = decodeCompact(payload, 'answer');
      if (decoded.session !== round) return;
      accepted = true;
      acceptedAt = performance.now();
      clearTimeout(timer);
      timer = setTimeout(() => { if (peer === current) failed('network'); }, CONNECT_MS);
      onStatus('Phone reply received. Connecting directly…');
      transfer.setOffer();
      await current.accept(decoded.description);
    } catch {
      if (accepted && peer === current) failed('network');
    }
  }
  return { start, answer };
}

export function receivePickup(token, id, signal, sendAnswer, onPhoto, onProgress, onOffer) {
  let peer, lastRound, timer, release, answeredAt;
  function clear() {
    clearTimeout(timer);
    clearTimeout(release);
    peer?.close();
    peer = undefined;
  }
  signal.addEventListener('abort', clear, { once: true });
  function stop(reason, detail = peer?.describe()) {
    const code = diagnosis(detail, answeredAt, 'after the reply started');
    clear();
    onProgress(0, reason, code);
  }
  async function connect({ session, description }) {
    clear();
    lastRound = session;
    answeredAt = undefined;
    onOffer();
    const current = new PhotoPeer({
      onPhoto(blob, name, digest) {
        if (peer !== current || signal.aborted) return;
        if (digest.startsWith(id)) onPhoto(blob, name);
        else {
          clear();
          onProgress(0);
        }
      },
      onProgress(fraction) {
        if (peer === current) {
          clearTimeout(timer);
          onProgress(fraction);
        }
      },
      onFailure(_, phase, detail) {
        if (peer === current) stop(phase === 'transfer' ? 'dropped' : 'network', detail);
      },
    });
    peer = current;
    // Allow for two plays of the reply and the kiosk's network budget.
    timer = setTimeout(() => { if (peer === current) stop('reply'); }, REPLY_MS);
    try {
      // Hold the kiosk's candidates: a kiosk firewall (e.g. a Windows Public
      // network) drops the phone's checks until the kiosk itself has sent to
      // the phone, and a phone that keeps checking during the reply tone gives
      // up before the kiosk has decoded it. Held, the phone answers the kiosk's
      // own checks instead. After both reply plays it starts its own checks too.
      const descriptionAnswer = await current.answer(description, { quickGather: true, holdCandidates: true });
      if (peer !== current) return;
      answeredAt = performance.now();
      const reply = answerMessage(token, descriptionAnswer, session);
      sendAnswer(reply);
      release = setTimeout(() => { if (peer === current) void current.releaseCandidates(); }, RELEASE_MS(reply.length));
    } catch {
      if (peer === current) stop('start');
    }
  }
  return (bytes) => {
    if (signal.aborted || !globalThis.RTCPeerConnection || !matches(bytes, token, OFFER)) return false;
    if (peer) return true;
    try {
      const decoded = decodeCompact(bytes.subarray(token.length + 1), 'offer');
      if (decoded.session !== lastRound) void connect(decoded);
    } catch {
      /* A later camera frame can still carry a valid offer. */
    }
    return true;
  };
}
