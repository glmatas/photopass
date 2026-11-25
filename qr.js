import { decodeQR, deflateSync, inflateSync, makeQR } from './vendor/qr-codecs.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const maxPacketBytes = 64 * 1024;
const answerPrefix = 'PP1.';
const offerPrefix = '#offer=';

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

export async function makeSignalURL(description, session) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = offerPrefix + encodeSignal(description, session, 'offer');
  return url.href;
}

export async function makeAnswerText(description, session) {
  return answerPrefix + encodeSignal(description, session, 'answer');
}

export async function readSignal(text) {
  try {
    if (typeof text !== 'string' || text.length > 100_000) throw new Error();
    const value = text.trim();
    const isAnswer = value.startsWith(answerPrefix);
    let token;
    if (isAnswer) {
      token = value.slice(answerPrefix.length);
    } else {
      const hash = value.startsWith('#') ? value : new URL(value).hash;
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
    return { description: { type: isAnswer ? 'answer' : 'offer', sdp }, session };
  } catch {
    throw new Error('This is not a PhotoPass pairing code. Scan the code shown on the other device.');
  }
}

export function drawCode(canvas, text) {
  // Both signaling formats are ASCII. Medium correction tolerates screen glare;
  // allow low correction for unusually long page URLs or extra ICE interfaces.
  const qr = makeQR(0, text.length > 2331 ? 'L' : 'M');
  qr.addData(text, 'Byte');
  try {
    qr.make();
  } catch {
    throw new Error('This pairing code is too large for a QR. Use the text pairing option.');
  }
  const modules = qr.getModuleCount();
  const margin = 4;
  const side = modules + margin * 2;
  const scale = Math.max(4, Math.ceil(600 / side));
  canvas.width = canvas.height = side * scale;
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#101010';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
    }
  }
}

export async function startCamera(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera scanning requires HTTPS and a browser with camera access. You can also paste the code.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
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
    async function scan() {
      if (stopped) return;
      try {
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        let value;
        if (detector) {
          try { value = (await detector.detect(video))[0]?.rawValue; } catch { detector = null; }
        }
        if (!value && !stopped) {
          const ratio = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
          const width = Math.round(video.videoWidth * ratio);
          const height = Math.round(video.videoHeight * ratio);
          if (frame.width !== width || frame.height !== height) {
            frame.width = width;
            frame.height = height;
          }
          ctx.drawImage(video, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height);
          value = decodeQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data;
        }
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
