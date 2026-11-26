import { fnv1a, HEADER_LEN, LTEncoder, packFile, packFrame } from './vendor/optical/core.js';
import { createQR, rasterizeQr } from './vendor/optical/render.js';
import { colorFlag, colorPacket, paintColor } from './light-color.js?v=8';
import { highBlockBytes, repairEncoder } from './light-repair.js?v=2';

const maxFileBytes = 32 * 1024 * 1024;
const idLength = 12;
const fastBytes = 1465;  // A single version 27-L QR, including both headers.
const largeSquareBytes = 287; // A version 12-M QR for files up to about 16 MiB.
const margin = 4;
const active = new WeakMap();

export async function prepareLightSender(file, canvas, { onError } = {}) {
  if (!file || file.size < 1 || file.size > maxFileBytes) {
    throw new Error('Choose a nonempty photo up to 32 MiB.');
  }
  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => signature[i] === byte);
  const webp = String.fromCharCode(...signature.slice(0, 4)) === 'RIFF' && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP';
  if (!({ 'image/jpeg': jpeg, 'image/png': png, 'image/webp': webp })[file.type]) {
    throw new Error('Choose a JPEG, PNG or WebP photo. The file contents do not match its format.');
  }
  let { container } = await packFile(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  // The DCF2 header contains the SHA-256 of the original file at bytes 17..48.
  // Copy the prefix so it won't keep the container alive after stop().
  const prefix = container.slice(17, 17 + idLength);
  const id = Array.from(prefix, byte => byte.toString(16).padStart(2, '0')).join('');
  const sessionId = (prefix[0] << 8) | prefix[1];
  const checksum = fnv1a(container);
  let encoder, header;
  let largeSquares = false;
  let color = false;
  let highSpeed = false;
  const staging = document.createElement('canvas');
  const source = staging.getContext('2d', { alpha: false });
  const screen = canvas.getContext('2d', { alpha: false });
  if (!source || !screen) throw new Error('This browser could not display the optical transfer.');
  let sequence = 0;
  let highSequence = 0;
  let version;
  let animation;
  let lastDraw = -Infinity, lastTick = 0, refresh = 1000 / 60;
  const deltas = [];
  let offerCanvas, nextOfferAt = 0, offerUntil = 0;

  function setOffer(bytes) {
    offerCanvas = undefined;
    offerUntil = nextOfferAt = 0;
    if (!bytes || !encoder) return;
    const qr = createQR([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: 'M' });
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, margin);
    offerCanvas = document.createElement('canvas');
    offerCanvas.width = offerCanvas.height = raster.size;
    offerCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size), 0, 0);
  }

  function configure() {
    const standardBudget = (largeSquares ? largeSquareBytes : fastBytes) - idLength - HEADER_LEN;
    const budget = highSpeed ? highBlockBytes : standardBudget;
    // The wire's block count is a u16. Increase the block size just enough for
    // larger photos to work in large-square mode without truncating the count.
    const blockLen = Math.min(container.length, Math.max(budget, Math.ceil(container.length / 65535)));
    encoder = highSpeed ? repairEncoder(container, blockLen) : new LTEncoder(container, blockLen, sessionId);
    highSequence = 0;
    header = { sessionId, k: encoder.k, blockLen, totalLen: container.length, payloadFnv: checksum };
    version = undefined;
  }
  configure();

  function setLargeSquares(enabled) {
    if (!container || largeSquares === Boolean(enabled)) return;
    largeSquares = Boolean(enabled);
    configure();
    lastDraw = -Infinity;
  }
  function setHighSpeed(enabled) {
    if (!container || highSpeed === enabled) return;
    highSpeed = enabled;
    configure();
    lastDraw = -Infinity;
  }

  function draw() {
    // High speed draws brightness only: tinted layers lowered its contrast and
    // did not survive real camera chroma processing at this density.
    const boosted = color && !largeSquares && !highSpeed;
    const seq = highSpeed ? colorFlag + (highSequence++ & 0x1fffffff)
      : (sequence++ & 0x3fffffff) + (boosted ? colorFlag : 0);
    const frame = packFrame({ ...header, seq }, encoder.encode(seq));
    const extraHeader = highSpeed ? 6 : 0;
    const bytes = new Uint8Array(prefix.length + extraHeader + frame.length);
    bytes.set(prefix);
    if (highSpeed) {
      bytes.set([0x48, 0x37], prefix.length);
      new DataView(bytes.buffer).setUint32(prefix.length + 2, fnv1a(frame));
    }
    bytes.set(frame, prefix.length + extraHeader);
    // A fixed valid mask and version avoid eight full matrix evaluations on each tick.
    const qr = createQR([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: largeSquares && !highSpeed ? 'M' : 'L', maskPattern: 4, version });
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, margin);
    if (version === undefined) {
      version = qr.version;
      staging.width = staging.height = raster.size;
      canvas.width = canvas.height = raster.size * 4;
      canvas.style.imageRendering = 'pixelated';
      canvas.style.setProperty('--qr-step', raster.size / (window.devicePixelRatio || 1) + 'px');
      screen.imageSmoothingEnabled = false;
    }
    const pixels = new Uint8ClampedArray(raster.pixels.buffer);
    if (boosted) {
      const extraSeq = seq + 0x40000000;
      const data = colorPacket(prefix, header, extraSeq, encoder.encode(extraSeq));
      const extra = createQR([{data, mode:'byte'}], {errorCorrectionLevel:'L', maskPattern:4, version:qr.version});
      paintColor(pixels, qr.modules, extra.modules, margin);
    }
    source.putImageData(new ImageData(pixels, raster.size, raster.size), 0, 0);
    screen.drawImage(staging, 0, 0, canvas.width, canvas.height);
  }

  function stop() {
    cancelAnimationFrame(animation);
    animation = undefined;
    encoder = null;
    container = null;
    offerCanvas = undefined;
    if (active.get(canvas) === stop) {
      active.delete(canvas);
      screen.fillStyle = 'white';
      screen.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Estimate the display's refresh period from the median rAF interval.
  // Pauses are ignored. A throttled page can tick at only 20 Hz.
  function trackRefresh(now) {
    const interval = now - lastTick;
    lastTick = now;
    if (!(interval > 4 && interval < 100)) return;
    deltas.push(interval);
    if (deltas.length > 31) deltas.shift();
    if (deltas.length >= 7) refresh = [...deltas].sort((a, b) => a - b)[deltas.length >> 1];
  }

  function tick(now) {
    if (!encoder) return;
    try {
      trackRefresh(now);
      // Show each symbol for a whole number of display refreshes so camera
      // exposures can find a stable frame between two content changes.
      // Twenty symbols/s at 60 Hz gives a 30 frames/s rolling-shutter camera at
      // least one capture of almost every symbol without a content change.
      const rate = largeSquares ? 12 : 20;
      const hold = Math.max(1, Math.round(1000 / rate / refresh));
      if (now - lastDraw >= (hold - 0.5) * refresh) {
        lastDraw = now;
        if (offerCanvas && version && now >= nextOfferAt) {
          offerUntil = now + 180;
          nextOfferAt = now + 2300;
        }
        if (offerCanvas && now < offerUntil) {
          screen.drawImage(offerCanvas, 0, 0, canvas.width, canvas.height);
        } else draw();
      }
      animation = requestAnimationFrame(tick);
    } catch (error) {
      stop();
      onError?.(error.message || 'The photo stream could not be drawn.');
    }
  }

  function start() {
    if (!encoder || animation !== undefined) return;
    if (active.get(canvas) !== stop) active.get(canvas)?.();
    active.set(canvas, stop);
    lastDraw = -Infinity;
    tick(performance.now());
  }
  function pause() {
    cancelAnimationFrame(animation);
    animation = undefined;
  }
  return { id, start, pause, stop, setOffer, setLargeSquares, setHighSpeed, setColor(enabled) { color = Boolean(enabled); } };
}
