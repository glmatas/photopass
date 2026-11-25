import { PhotoPeer } from './peer.js?v=10';
import { decodeCompact, encodeCompact } from './signal-codec.js';

// The existing camera reads offers between photo frames. A phone's speaker
// returns the answer to the kiosk microphone. The visitor keeps one camera view.
const OFFER = 79,
  ANSWER = 65;
const limit = 1200;

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

export function offerPickup(file, token, transfer, signal) {
  let peer, round, accepted, timer;
  function clear() {
    clearTimeout(timer);
    transfer.setOffer();
    peer?.close();
    peer = undefined;
  }
  signal.addEventListener('abort', clear, { once: true });
  async function start() {
    if (peer || signal.aborted || !globalThis.RTCPeerConnection) return;
    const current = new PhotoPeer({
      onSent: clear,
      onFailure: clear,
      onProgress() {
        clearTimeout(timer);
      },
    });
    peer = current;
    round = Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) =>
      n.toString(16).padStart(8, '0'),
    ).join('');
    accepted = false;
    timer = setTimeout(clear, 26000);
    try {
      const description = await current.offer(file, { quickGather: true });
      if (peer === current) transfer.setOffer(message(token, OFFER, description, round));
    } catch {
      if (peer === current) clear();
    }
  }
  async function answer(bytes) {
    const current = peer;
    if (!current || accepted || !matches(bytes, token, ANSWER)) return;
    try {
      const decoded = decodeCompact(bytes.subarray(token.length + 1), 'answer');
      if (decoded.session !== round) return;
      accepted = true;
      transfer.setOffer();
      await current.accept(decoded.description);
    } catch {
      if (accepted && peer === current) clear();
    }
  }
  return { start, answer };
}

export function receivePickup(token, id, signal, sendAnswer, onPhoto, onProgress) {
  let peer, lastRound, timer;
  function clear() {
    clearTimeout(timer);
    peer?.close();
    peer = undefined;
  }
  signal.addEventListener('abort', clear, { once: true });
  async function connect({ session, description }) {
    clear();
    lastRound = session;
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
      onFailure() {
        if (peer === current) {
          clear();
          onProgress(0);
        }
      },
    });
    peer = current;
    timer = setTimeout(clear, 20000);
    try {
      const descriptionAnswer = await current.answer(description, { quickGather: true });
      if (peer === current) sendAnswer(message(token, ANSWER, descriptionAnswer, session));
    } catch {
      if (peer === current) clear();
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
