import { LTDecoder, fnv1a, parseFrame, streamIdentity, unpackFile } from './vendor/optical/core.js';
import { decodeQR } from './vendor/qr-codecs.js';
import { restoreColor } from './light-color.js?v=8';
import { highBlockBytes, RepairDecoder } from './light-repair.js?v=2';

const MAX_BYTES = 32 * 1024 * 1024;
const HEADER_BYTES = 49;
const MAX_CONTAINER = MAX_BYTES + HEADER_BYTES + 65535 * 2;
const MIME = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
const cancelled = () => new DOMException('Camera capture canceled.', 'AbortError');

function mimeOf(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
}

function filename(name, mime) {
  const stem = name.split(/[\\/]/).pop().replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 90);
  return (stem || 'Photo') + '.' + MIME.get(mime);
}

async function checkedPhoto(container, expected, checksum) {
  if (container.length < HEADER_BYTES || fnv1a(container) !== checksum) throw new Error('The camera transfer checksum did not match. Scan the photo again.');
  const header = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const size = header.getUint32(9, true);
  // PhotoPass sends JPEG, PNG and WebP uncompressed. Verify the declared size
  // before any container reader allocates or attempts to decompress a file.
  if (container[4] !== 0 || !size || size > MAX_BYTES || size !== header.getUint32(13, true)) {
    throw new Error('The optical stream does not contain a supported photo up to 32 MiB.');
  }
  const file = await unpackFile(container);
  if (file.bytes.length !== size || !MIME.has(file.type) || mimeOf(file.bytes) !== file.type) {
    throw new Error('The recovered photo format is invalid.');
  }
  const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes));
  if (!actual.every((byte, i) => byte === file.sha256[i]) || !expected.every((byte, i) => byte === actual[i])) {
    throw new Error('The photo failed verification. Scan the code for your photo again.');
  }
  return { blob: new Blob([file.bytes], { type: file.type }), name: filename(file.name, file.type) };
}

function cameraError(error) {
  if (['NotAllowedError', 'SecurityError'].includes(error.name)) return new Error('Allow camera access in this browser to receive your photo.');
  if (['NotFoundError', 'OverconstrainedError'].includes(error.name)) return new Error('This browser could not find a camera.');
  if (error.name === 'NotReadableError') return new Error('The camera is busy. Close the other camera app and try again.');
  return error;
}

// The 12-byte prefix belongs to PhotoPass. The enclosed Decimen v0.3.0
// frames may arrive in any order, with omissions or repeated camera frames.
export async function startLightReceiver(video, { id, onCameraReady, onControl, onProgress, onPhoto, onError, signal }) {
  if (typeof id !== 'string' || !/^[\da-f]{24}$/i.test(id)) throw new Error('Scan the camera-transfer link for your photo again.');
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.crypto?.subtle) throw new Error('Open this HTTPS link in your phone’s main browser, such as Safari or Chrome, to use the camera.');
  if (signal?.aborted) throw cancelled();
  const expected = Uint8Array.from(id.match(/../g), pair => parseInt(pair, 16));
  const sessionId = expected[0] * 256 + expected[1];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot read camera frames.');
  const workers = [];
  // Four colors adds one warm/cool packet. High speed is brightness only.
  let colorHeader;
  const colors = [{worker:null, busy:false, disabled:false, next:0, failures:0}];
  let stream, nextFrame, decoder, identity, verify = false, closed = false;
  let seq = 0, misses = 0, lastSeen = 0, lastTime = -1, lastProgress = 0;
  // Video-space bounds of the square in the last accepted capture.
  let roi;
  let cancelStartup;
  let firstPacketAt;
  const stopped = new Promise((_, reject) => { cancelStartup = reject; });
  stopped.catch(() => {}); // A device API can throw before the first startup race.
  const usingVideoCallback = typeof video.requestVideoFrameCallback === 'function';

  function releaseCamera() {
    if (nextFrame != null) {
      if (usingVideoCallback) video.cancelVideoFrameCallback?.(nextFrame);
      else cancelAnimationFrame(nextFrame);
      nextFrame = undefined;
    }
    for (const worker of workers.splice(0)) worker.instance.terminate();
    for (const layer of colors) layer.worker?.terminate();
    colorHeader = undefined;
    stream?.getTracks().forEach(track => track.stop());
    if (stream && video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
    canvas.width = canvas.height = 1;
    decoder = null;
  }
  function stop() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', stop);
    window.removeEventListener('pagehide', stop);
    releaseCamera();
    cancelStartup(cancelled());
  }
  function fail(error) {
    if (closed) return;
    stop();
    onError?.(error.message || 'The camera transfer stopped. Try again.');
  }
  async function finish(payload, checksum) {
    verify = true;
    releaseCamera();
    try {
      const { blob, name } = await checkedPhoto(payload, expected, checksum);
      if (closed) return;
      stop();
      onProgress?.(1);
      onPhoto?.(blob, name, (performance.now() - firstPacketAt) / 1000);
    } catch (e) { fail(e); }
  }
  function receive(bytes, highSpeed = false) {
    if (closed || verify || !bytes || bytes.length <= expected.length ||
        !expected.every((byte, i) => bytes[i] === byte)) return false;
    let packet = bytes.subarray(expected.length);
    if (packet[0] === 0x48 && packet[1] === 0x37) {
      if (packet.length < 6) return false;
      const check = new DataView(packet.buffer, packet.byteOffset).getUint32(2);
      packet = packet.subarray(6);
      if (fnv1a(packet) !== check) return false;
      highSpeed = true;
    }
    const frame = parseFrame(packet);
    if (!frame) return false;
    const h = frame.header;
    if (h.sessionId !== sessionId || h.totalLen < HEADER_BYTES || h.totalLen > MAX_CONTAINER ||
        h.blockLen > 2953 - expected.length - 20 || h.k !== Math.ceil(h.totalLen / h.blockLen)) return false;
    if (highSpeed && (h.blockLen !== Math.min(highBlockBytes, h.totalLen) || h.seq >>> 31 !== 1)) return false;
    const key = (highSpeed ? 'H7/' : '') + streamIdentity(h), now = performance.now();
    if (key !== identity) {
      // Another kiosk is rejected by the complete id above. If the sender
      // changes symbol density for this photo, allow its new stream to take over.
      if (decoder && now - lastSeen < 1200) return false;
      identity = key;
      firstPacketAt = now;
      decoder = highSpeed ? new RepairDecoder(h.k, h.blockLen, h.totalLen)
        : new LTDecoder(h.k, h.blockLen, h.sessionId, h.totalLen);
      lastProgress = 0;
      onProgress?.(0);
    }
    lastSeen = now;
    if (h.seq >>> 30 !== 3) colorHeader = h.seq >>> 30 === 2 && !highSpeed ? h : undefined;
    decoder.addFrame(h.seq, frame.block);
    if (decoder.isComplete) {
      const payload = decoder.assemble();
      void finish(payload, h.payloadFnv);
      return true;
    }
    // Bound retained equations even for a malformed same-id stream.
    if (decoder.framesNew > 3 * h.k + 512) { decoder = null; identity = undefined; return false; }
    const progress = Math.min(0.985, Math.max(decoder.solvedCount / h.k, decoder.framesNew / (1.18 * h.k + 6)));
    if (progress - lastProgress >= 0.002) { lastProgress = progress; onProgress?.(progress); }
    return true;
  }
  function decoded(raw) {
    try {
      const bytes = raw && !(raw instanceof Uint8Array) ? new Uint8Array(raw) : raw;
      if (bytes?.[0] === 80 && bytes[1] === 80 && onControl?.(bytes)) return;
      const accepted = receive(bytes);
      misses = accepted ? 0 : Math.min(misses + 1, 30);
      return accepted;
    } catch (error) { fail(error); }
  }
  function makeWorker() {
    const instance = new Worker(new URL('./vendor/optical/reader-worker.js?v=9', import.meta.url), { type: 'module' });
    const slot = { instance, busy: false, started: 0 };
    instance.onmessage = ({ data }) => {
      if (data.id < 0) return;
      slot.busy = false;
      if (decoded(data.bytes) && data.quad && slot.region) track(data.quad, slot.region);
    };
    const discard = () => {
      const i = workers.indexOf(slot);
      if (i >= 0) workers.splice(i, 1);
      instance.terminate();
    };
    instance.onerror = discard;
    instance.onmessageerror = discard;
    slot.discard = discard;
    workers.push(slot);
  }
  function track(quad, {sx, sy, scale}) {
    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
    if (!points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))) return;
    const xs = points.map(p => sx + p.x / scale), ys = points.map(p => sy + p.y / scale);
    const x = Math.min(...xs), y = Math.min(...ys);
    roi = {x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, at: performance.now()};
  }
  function tryColor(layer, pixels, w, h) {
    if (!colorHeader || layer.busy || layer.disabled || seq < layer.next || performance.now() - lastSeen > 1200) return;
    const disable = () => {
      layer.worker?.terminate();
      layer.worker = null;
      layer.disabled = true;
    };
    try {
      if (!layer.worker) {
        layer.worker = new Worker(new URL('./vendor/optical/color-reader.js?v=8', import.meta.url), {type:'module'});
        layer.worker.onerror = layer.worker.onmessageerror = disable;
        layer.worker.onmessage = ({data}) => {
          if (data.id < 0 || closed || verify) return;
          layer.busy = false;
          const bytes = restoreColor(data.bytes, expected, colorHeader);
          if (bytes && receive(bytes)) layer.failures = 0;
          else layer.failures = Math.min(8, layer.failures + 1);
          const minimumGap = navigator.hardwareConcurrency <= 2 ? 4 : 1;
          layer.next = seq + Math.max(minimumGap, 1 << Math.max(0, layer.failures - 3));
        };
      }
      const copy = pixels.slice();
      layer.busy = true;
      layer.worker.postMessage({id:seq, buf:copy.buffer, w, h, green:false}, [copy.buffer]);
    } catch { disable(); }
  }
  function loop() {
    if (closed || verify) return;
    nextFrame = usingVideoCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2 || (!usingVideoCallback && lastTime === video.currentTime)) return;
    for (const w of [...workers]) if (w.busy && performance.now() - w.started > 10000) w.discard();
    const slot = workers.find(w => !w.busy);
    if (workers.length && !slot) return;
    lastTime = video.currentTime;
    // After misses, also look at individual regions. If several kiosks are in
    // view, a stronger but unrelated QR need not monopolize every decode.
    const view = misses >= 3 ? seq % 7 : 0;
    const horizontal = view === 2 || view === 3, vertical = view === 4 || view === 5;
    let sw = vw * (horizontal ? 0.62 : view === 1 ? 0.76 : 1);
    let sh = vh * (vertical ? 0.62 : view === 1 ? 0.76 : 1);
    let sx = (vw - sw) * (view === 2 ? 0 : view === 3 ? 1 : 0.5);
    let sy = (vh - sh) * (view === 4 ? 0 : view === 5 ? 1 : 0.5);
    // While the square stays in view, read only its neighborhood at the
    // camera's full resolution instead of a downscaled complete frame.
    if (roi && performance.now() - roi.at < 1500 && (misses < 10 || seq % 3)) {
      const pad = 0.25 * Math.max(roi.w, roi.h);
      sx = Math.max(0, Math.floor(roi.x - pad));
      sy = Math.max(0, Math.floor(roi.y - pad));
      sw = Math.min(vw, Math.ceil(roi.x + roi.w + pad)) - sx;
      sh = Math.min(vh, Math.ceil(roi.y + roi.h + pad)) - sy;
    }
    const scale = Math.min(1, 1440 / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    try {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      seq++;
      if (slot && !(misses >= 10 && seq % 10 === 0)) {
        slot.busy = true;
        slot.started = performance.now();
        slot.region = {sx, sy, scale};
        for (const layer of colors) tryColor(layer, pixels, w, h);
        slot.instance.postMessage({ id: seq, buf: pixels.buffer, w, h }, [pixels.buffer]);
      } else {
        // Some WebKit versions run module workers but cannot instantiate this
        // WASM build. Periodic raw-byte JS decoding also covers that path.
        decoded(decodeQR(pixels, w, h, { inversionAttempts: 'dontInvert' })?.binaryData);
      }
    } catch (error) { fail(error); }
  }

  signal?.addEventListener('abort', stop, { once: true });
  window.addEventListener('pagehide', stop, { once: true });
  try {
    const open = navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
    } }).then(active => {
      if (closed) { active.getTracks().forEach(track => track.stop()); throw cancelled(); }
      stream = active;
      return active;
    });
    await Promise.race([open, stopped]);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('The camera did not provide a video track.');
    track.addEventListener('ended', () => {
      if (!verify) fail(new Error('Camera disconnected. Open the camera again.'));
    }, { once: true });
    const capabilities = track.getCapabilities?.() || {}, settings = track.getSettings?.() || {};
    const tuning = {};
    if (capabilities.focusMode?.includes('continuous')) tuning.advanced = [{ focusMode: 'continuous' }];
    // A faster camera captures each symbol several times between content
    // changes. Keep the opened resolution; finer grids need it more than speed.
    if (settings.width && settings.height && capabilities.frameRate?.max >= 50 && !(settings.frameRate >= 50)) {
      Object.assign(tuning, { width: { exact: settings.width }, height: { exact: settings.height }, frameRate: { ideal: 60 } });
    }
    if (Object.keys(tuning).length) track.applyConstraints(tuning).catch(() => {});
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    await Promise.race([video.play(), stopped]);
    if (!closed) onCameraReady?.();
    try {
      const count = navigator.hardwareConcurrency >= 4 ? 2 : 1;
      for (let i = 0; i < count; i++) makeWorker();
    } catch { /* Local jsQR also runs without module worker support. */ }
    loop();
    return stop;
  } catch (error) {
    stop();
    throw cameraError(error);
  }
}
