import { decodeQR, deflateSync, inflateSync, makeQR } from './vendor/qr-codecs.js';
import { encodeCompact, decodeCompact } from './signal-codec.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const maxPacketBytes = 64 * 1024;
const answerPrefix = 'PP1.';
const offerPrefix = '#offer=';
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-.';
const charsPerBlock = [0, 2, 3, 5, 6];

// Six QR alphanumeric characters hold four bytes. This alphabet is also safe
// in URL fragments, so phone cameras can open the link without percent escapes.
function packText(bytes) {
  let text = '';
  for (let pos = 0; pos < bytes.length; pos += 4) {
    const count = Math.min(4, bytes.length - pos);
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 256 + bytes[pos + i];
    let block = '';
    for (let i = 0; i < charsPerBlock[count]; i++) {
      block = alphabet[value % alphabet.length] + block;
      value = Math.floor(value / alphabet.length);
    }
    text += block;
  }
  return text;
}

function unpackText(text) {
  if (!text.length || text.length > 100_000) throw new Error('Invalid pairing details.');
  const bytes = new Uint8Array(Math.ceil(text.length / 6) * 4);
  let offset = 0;
  for (let pos = 0; pos < text.length; pos += 6) {
    const width = Math.min(6, text.length - pos);
    const count = charsPerBlock.indexOf(width);
    if (count < 1) throw new Error('Invalid block length.');
    let value = 0;
    for (let i = 0; i < width; i++) {
      const digit = alphabet.indexOf(text[pos + i]);
      if (digit < 0) throw new Error('Invalid character.');
      value = value * alphabet.length + digit;
    }
    if (value >= 256 ** count) throw new Error('Invalid block value.');
    for (let i = count - 1; i >= 0; i--) {
      bytes[offset + i] = value % 256;
      value = Math.floor(value / 256);
    }
    offset += count;
  }
  return bytes.subarray(0, offset);
}

// The v1 wire format uses a shared DEFLATE dictionary. Common WebRTC SDP lines
// then cost only a few bytes even in a short message. The SDP itself is lossless.
const dictionary = encoder.encode([
  'v=0', 'o=- 123456789 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:', 'a=ice-pwd:', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 ', 'a=setup:actpass', 'a=setup:active',
  'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  'a=candidate: 1 udp 2122260223 .local  typ host generation 0 network-cost 999',
  'a=candidate: 1 tcp 1518280447 .local 9 typ host tcptype active generation 0',
  'a=end-of-candidates',
].join('\\r\\n'));

function encodeSignal(description, session, type) {
  if (description?.type !== type || !/^v=0\r?\n/.test(description.sdp)) {
    throw new Error('The browser has not finished creating the pairing code.');
  }
  if (typeof session !== 'string' || !session.length || session.length > 128) {
    throw new Error('The pairing session is invalid.');
  }
  const packet = encoder.encode(JSON.stringify([1, session, description.sdp]));
  if (packet.byteLength > maxPacketBytes) throw new Error('The pairing details are too large.');
  const bytes = deflateSync(packet, { level: 9, dictionary });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function makeSignalURL(description, session, receiverURL = location.href) {
  const url = new URL(receiverURL);
  url.search = '?2';
  url.hash = '#2' + packText(encodeCompact(description, session));
  return url.href;
}

export async function makeAnswerText(description, session, protocol = 2) {
  if (protocol === 1) return answerPrefix + encodeSignal(description, session, 'answer');
  return 'P2:' + packText(encodeCompact(description, session));
}

export async function readSignal(text) {
  try {
    if (typeof text !== 'string' || text.length > 100_000) throw new Error();
    const value = text.trim();
    if (value.startsWith('P2:')) return { ...decodeCompact(unpackText(value.slice(3)), 'answer'), protocol: 2 };
    const isAnswer = value.startsWith(answerPrefix);
    let token;
    if (isAnswer) {
      token = value.slice(answerPrefix.length);
    } else {
      const hash = decodeURIComponent(value.startsWith('#') ? value : new URL(value).hash);
      if (hash.startsWith('#2')) return { ...decodeCompact(unpackText(hash.slice(2)), 'offer'), protocol: 2 };
      if (!hash.startsWith(offerPrefix)) throw new Error();
      token = hash.slice(offerPrefix.length);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const compressed = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const output = inflateSync(compressed, { dictionary, out: new Uint8Array(maxPacketBytes + 1) });
    if (output.length > maxPacketBytes) throw new Error();
    const [version, session, sdp] = JSON.parse(decoder.decode(output));
    if (version !== 1 || typeof session !== 'string' || !session.length || session.length > 128 ||
        typeof sdp !== 'string' || !/^v=0\r?\n/.test(sdp)) throw new Error();
    return { description: { type: isAnswer ? 'answer' : 'offer', sdp }, session, protocol: 1 };
  } catch {
    throw new Error('This is not a PhotoPass pairing code. Scan the code shown on the other device.');
  }
}

export function drawCode(canvas, text) {
  const compactOffset = text.includes('#2') ? text.indexOf('#2') + 1 : 0;
  const compact = (compactOffset > 0 || text.startsWith('P2:'));
  function make(level, version = 0) {
    const qr = makeQR(version, level);
    if (compactOffset) qr.addData(text.slice(0, compactOffset), 'Byte');
    qr.addData(text.slice(compactOffset), compact ? 'Alphanumeric' : 'Byte');
    qr.make();
    return qr;
  }
  let qr;
  try { qr = make('M'); }
  catch {
    try { qr = make('L'); }
    catch { throw new Error('This pairing code is too large for a QR. Use the text pairing option.'); }
  }
  // Additional correction is free when it fits the same grid.
  const version = (qr.getModuleCount() - 17) / 4;
  for (const level of ['H', 'Q']) {
    try { qr = make(level, version); break; }
    catch { /* This level would require smaller squares at the same display size. */ }
  }
  const modules = qr.getModuleCount();
  const margin = 4;
  const side = modules + margin * 2;
  canvas.style.setProperty('--qr-step', (side / (globalThis.devicePixelRatio || 1)) + 'px');
  const scale = Math.max(4, Math.ceil(600 / side));
  canvas.width = canvas.height = side * scale;
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
    }
  }
}

export async function startCamera(video, onCode, deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera scanning requires HTTPS and a browser with camera access. You can also paste the code.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { ideal: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: 1920 }, height: { ideal: 1080 },
    },
  });
  let stopped = false;
  let timer;
  function stop() {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
  }
  try {
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const frame = document.createElement('canvas');
    const ctx = frame.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Camera scanning is unavailable in this browser.');
    let detector;
    if (globalThis.BarcodeDetector) {
      try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { /* Use jsQR. */ }
    }
    let lastValue;
    let lastTime = 0;
    let misses = 0;
    async function scan() {
      if (stopped) return;
      try {
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        let value;
        if (detector) {
          try { value = (await detector.detect(video))[0]?.rawValue; } catch { detector = null; }
        }
        if (!value && !stopped) {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          // Alternate full-frame coverage with a detailed centre view after a
          // miss. Downscaling a wide feed can erase small squares on the phone.
          const detail = misses % 2 === 1;
          const sw = detail ? Math.min(vw, vh) : vw;
          const sh = detail ? sw : vh;
          const ratio = Math.min(1, 1200 / Math.max(sw, sh));
          const width = Math.round(sw * ratio);
          const height = Math.round(sh * ratio);
          if (frame.width !== width || frame.height !== height) {
            frame.width = width;
            frame.height = height;
          }
          ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height);
          value = decodeQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data;
        }
        misses = value ? 0 : misses + 1;
        if (!stopped && value && (value !== lastValue || Date.now() - lastTime > 1800)) {
          lastValue = value;
          lastTime = Date.now();
          await onCode(value);
        }
      } catch {
        // A frame or unrelated QR can fail. The visitor can keep scanning.
      } finally {
        if (!stopped) timer = setTimeout(scan, 130);
      }
    }
    timer = setTimeout(scan, 0);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
