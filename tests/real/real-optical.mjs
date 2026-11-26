// Real-hardware optical loop: kiosk square on a physical monitor -> Logitech BRIO -> receiver page.
//   node tests/real/real-optical.mjs --mode high|four|bw --runs N [--timeout 180] [--label name] [--size 2300000]
//                                    [--probe] [--detect] [--monitor=DISPLAY2]
// Never opens a microphone, never uses WebRTC, never uses a fake media device.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { choosePhoto, savedPhoto } from '../photo-qa-fixture.mjs';
import { startServer, listMonitors, launch, placeWindow, snapDir, resultDir } from './lib.mjs';
import { detect } from './detect.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const has = name => argv.includes('--' + name);
const probe = has('probe');
const modeName = probe ? 'high' : opt('mode', 'high');
if (!['high', 'four', 'bw'].includes(modeName)) throw Error('--mode must be high|four|bw');
const runs = Number(opt('runs', 1));
const timeoutS = Number(opt('timeout', 180));
const size = Number(opt('size', 2_300_000));
const label = opt('label', probe ? 'probe' : 'run');
const selectValue = { high: 'fast', four: 'color', bw: 'mono' }[modeName];
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = path.join(resultDir, `${label}-${modeName}-${stamp}.jsonl`);
const framesDir = path.join(resultDir, 'frames');

// ---------------------------------------------------------------- page instrumentation
function installHarness({ fps, neutral, camfps }) {
  if (!navigator.mediaDevices) return;
  // Evaluated lazily: a window.open() popup reuses its initial about:blank window, so the hash is not yet set here.
  const receiverNow = () => location.hash.startsWith('#L');
  window.AudioContext = window.webkitAudioContext = undefined; // no tones, no acoustic pairing
  const qa = window.qa = {
    rtcCalls: 0, audioRequests: 0, rendered: 0, readings: 0, recognized: 0,
    colorReads: 0, colorHits: 0, layers: { warm: { reads: 0, hits: 0 }, green: { reads: 0, hits: 0 } },
    unique: 0, duplicates: 0, streamHits: 0, otherHits: 0, seen: new Set(), vframes: 0, firstFrameAt: 0, firstPresented: -1, lastPresented: -1,
    lastMediaTime: 0, perSec: [], lat: {}, workerSeq: 0, drawTimes: [], prep: [], rafStart: 0, failedFrames: [], quads: [], keys: {}, frameLog: []
  };
  // Payload identity: length + FNV-1a over every byte (the join QR repeats one payload; real packets differ by seq).
  const keyOf = bytes => { const b = new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength ?? bytes.length); let h = 0x811c9dc5; for (const v of b) h = Math.imul(h ^ v, 0x01000193) >>> 0; return b.length + ':' + h.toString(16); };

  // Kiosk pacing: interval between draws on #light-stream and rAF-start -> drawImage-call time.
  const rafNative = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => rafNative(t => { qa.rafStart = performance.now(); return cb(t); });
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) {
    if (this.canvas.id === 'light-stream') {
      const now = performance.now();
      qa.rendered++;
      if (qa.drawTimes.length < 40000) { qa.drawTimes.push(now); qa.prep.push(now - qa.rafStart); }
    }
    return draw.apply(this, a);
  };

  // Camera frame accounting from requestVideoFrameCallback metadata.
  if (HTMLVideoElement.prototype.requestVideoFrameCallback) {
    const native = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
      return native.call(this, (now, md) => {
        if (!receiverNow()) return cb(now, md);
        qa.vframes++;
        if (!qa.firstFrameAt) { qa.firstFrameAt = Date.now(); qa.firstPresented = md.presentedFrames; }
        qa.lastPresented = md.presentedFrames;
        qa.lastMediaTime = md.mediaTime;
        qa.videoSize = [this.videoWidth, this.videoHeight];
        return cb(now, md);
      });
    };
  }

  // Worker traffic: brightness reader and the two color layers.
  const NativeWorker = window.Worker;
  let sinceCopy = 0;
  window.Worker = new Proxy(NativeWorker, { construct(target, args) {
    const worker = new target(...args);
    const isColor = String(args[0]).includes('color-reader.js');
    const wname = (isColor ? 'color' : 'bright') + '#' + (++qa.workerSeq);
    qa.lat[wname] = [];
    const pending = new Map(); // id -> { green, frame }
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (msg, transfer) => {
      if (msg && typeof msg.id === 'number') {
        const entry = { green: !!msg.green, sent: performance.now() };
        // Keep an occasional copy of brightness-reader frames so failures can be saved as images.
        if (!isColor && qa.failedFrames.length < 10 && msg.buf && ++sinceCopy % 5 === 0) entry.frame = { w: msg.w, h: msg.h, buf: msg.buf.slice(0) };
        pending.set(msg.id, entry);
        if (pending.size > 64) pending.delete(pending.keys().next().value);
      }
      return post(msg, transfer);
    };
    worker.addEventListener('message', ({ data }) => {
      if (!data || data.id < 0) return;
      for (const k of Object.keys(data)) qa.keys[k] = 1;
      const entry = pending.get(data.id) || {};
      pending.delete(data.id);
      if (entry.sent && qa.lat[wname].length < 20000) qa.lat[wname].push(performance.now() - entry.sent);
      const hit = !!data.bytes;
      if (isColor) {
        qa.colorReads++; if (hit) qa.colorHits++;
        const layer = qa.layers[entry.green ? 'green' : 'warm'];
        layer.reads++; if (hit) layer.hits++;
      } else {
        qa.readings++; if (hit) qa.recognized++;
        if (data.quad && qa.quads.length < 400) qa.quads.push(data.quad);
        if (!hit && entry.frame && qa.failedFrames.length < 10) qa.failedFrames.push(entry.frame);
      }
      if (hit && !isColor) {
        // Only payloads that start with this pickup's 12-byte id are stream packets (not the join QR or controls).
        const id = location.hash.slice(2, 18).replaceAll('-', '+').replaceAll('_', '/');
        let pre = ''; try { pre = Array.from(atob(id), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); } catch { /* bad hash */ }
        const head = Array.from((ArrayBuffer.isView(data.bytes) ? new Uint8Array(data.bytes.buffer, data.bytes.byteOffset, Math.min(12, data.bytes.byteLength)) : new Uint8Array(data.bytes, 0, 12)), v => v.toString(16).padStart(2, '0')).join('');
        if (head === pre) qa.streamHits++; else qa.otherHits++;
        entry.stream = head === pre;
      }
      if (hit && (isColor || entry.stream)) {
        const key = (isColor ? 'c' + (entry.green ? 'g' : 'w') : 'b') + keyOf(data.bytes);
        // Uniqueness is judged by payload only, regardless of which reader decoded it.
        const payload = key.slice(isColor ? 2 : 1);
        if (qa.seen.has(payload)) qa.duplicates++; else { qa.seen.add(payload); qa.unique++; }
      }
    });
    return worker;
  } });

  if (window.RTCPeerConnection) {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct() { qa.rtcCalls++; throw Error('Optical flow attempted WebRTC'); } });
  }

  const media = navigator.mediaDevices;
  const original = media.getUserMedia.bind(media);
  let brio;
  async function brioId() {
    if (brio) return brio;
    const p = await original({ audio: false, video: true });
    p.getTracks().forEach(t => t.stop());
    const found = (await media.enumerateDevices()).find(d => d.kind === 'videoinput' && /brio/i.test(d.label));
    if (!found) throw new DOMException('Logitech BRIO not found', 'NotFoundError');
    return (brio = found.deviceId);
  }
  Object.defineProperty(media, 'getUserMedia', { configurable: true, value: async constraints => {
    if (!constraints?.video) { qa.audioRequests++; throw new DOMException('Audio capture is disabled in the harness', 'NotAllowedError'); }
    if (!receiverNow()) {
      // The kiosk never touches the BRIO: hand its own preview a black canvas stream.
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      c.getContext('2d').fillRect(0, 0, 640, 480);
      return c.captureStream(5);
    }
    const base = constraints.video === true ? {} : { ...constraints.video };
    delete base.facingMode; // desktop camera has none; keep the app's width/height/frameRate ideals
    if (camfps) base.frameRate = { ideal: camfps };
    qa.constraints = JSON.stringify(constraints);
    const stream = await original({ audio: false, video: { ...base, deviceId: { exact: await brioId() } } });
    window.__track = stream.getVideoTracks()[0];
    qa.gumSettings = JSON.stringify(window.__track.getSettings()); console.log('[harness] gUM video constraints', JSON.stringify({ ...base, deviceId: 'brio' }), 'settings', qa.gumSettings);
    // Windows keeps manual locks across sessions: every run starts from auto exposure and auto WB.
    await window.__track.applyConstraints({ advanced: [{ exposureMode: 'continuous', whiteBalanceMode: 'continuous' }] }).catch(() => {});
    return stream;
  } });
}

// ---------------------------------------------------------------- helpers
const server = await startServer();
const url = server.url;
let monitorInfo;
async function loadMonitor() {
  const file = path.join(snapDir, 'monitor.json');
  const forced = argv.find(a => a.startsWith('--monitor='));
  if (!has('detect') && !forced) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* detect below */ } }
  if (forced) {
    const name = forced.slice(10);
    const monitor = listMonitors().find(m => m.name.endsWith(name));
    if (!monitor) throw Error('No such monitor ' + name);
    let previous = {}; try { previous = JSON.parse(await readFile(file, 'utf8')); } catch { /* none */ }
    const info = { ...previous, monitor, forced: true };
    await writeFile(file, JSON.stringify(info, null, 2));
    return info;
  }
  console.log('Detecting which monitor the BRIO sees...');
  await detect();
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readJoinLink(page) {
  const png = await page.locator('#light-join').screenshot({ timeout: 60000 });
  return page.evaluate(async b64 => {
    const { decodeQR } = await import('./vendor/qr-codecs.js');
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height);
    return decodeQR(d.data, d.width, d.height)?.data;
  }, png.toString('base64'));
}

const log = async obj => appendFile(logFile, JSON.stringify(obj) + '\n');
const stat = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1), p90: +s[Math.floor(s.length * 0.9)].toFixed(1) }; };
const BINS = [20, 30, 36, 45, 60, 100, Infinity];
function pacing({ t, prep }) {
  const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  const hist = {}; let lo = 0; for (const hi of BINS) { hist[(hi === Infinity ? '>' + lo : '<=' + hi)] = d.filter(x => x > lo && x <= hi).length; lo = hi; }
  hist['<=20'] += d.filter(x => x <= 0).length;
  const dur = t.length > 1 ? (t.at(-1) - t[0]) / 1000 : 0;
  return { draws: t.length, fps: dur ? +((t.length - 1) / dur).toFixed(1) : 0, interval: stat(d), hist, prepMs: stat(prep) };
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');

async function receiverSnapshot(phone) {
  return phone.evaluate(() => {
    const q = window.qa || {};
    const t = window.__track?.getSettings?.() || {};
    const pick = ['exposureTime', 'whiteBalanceMode', 'colorTemperature', 'focusDistance', 'focusMode', 'exposureMode', 'frameRate', 'width', 'height', 'brightness', 'exposureCompensation'];
    const settings = {}; for (const k of pick) if (t[k] !== undefined) settings[k] = t[k];
    const progress = document.getElementById('light-progress');
    return {
      done: !document.getElementById('done-panel').hidden,
      error: !document.getElementById('error-panel').hidden && document.getElementById('error-message').textContent,
      status: document.getElementById('light-label')?.textContent,
      progress: progress ? progress.value / (progress.max || 1) : 0,
      vframes: q.vframes, presented: q.lastPresented, firstPresented: q.firstPresented, firstFrameAt: q.firstFrameAt, videoSize: q.videoSize,
      readings: q.readings, recognized: q.recognized, colorReads: q.colorReads, colorHits: q.colorHits,
      layers: JSON.parse(JSON.stringify(q.layers || {})), unique: q.unique, duplicates: q.duplicates, streamHits: q.streamHits, otherHits: q.otherHits, settings
    };
  });
}

async function saveCameraFrame(phone, file) {
  const b64 = await phone.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find(x => x.srcObject && x.videoWidth); if (!v) return null;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { png: c.toDataURL('image/png').split(',')[1], currentTime: v.currentTime, presented: window.qa.lastPresented };
  });
  if (!b64) return null;
  const buf = Buffer.from(b64.png, 'base64');
  await writeFile(file, buf);
  return { sha1: createHash('sha1').update(buf).digest('hex').slice(0, 12), currentTime: +b64.currentTime.toFixed(3), presented: b64.presented, bytes: buf.length };
}

// The reader worker does not return a quad, so measure the moving square straight from a camera frame:
// it is the largest dense region of high local contrast. v40 QR = 177 modules (185 with quiet zone).
async function measureSquare(phone) {
  return phone.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find(x => x.srcObject && x.videoWidth); if (!v) return null;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 0);
    const { data, width, height } = x.getImageData(0, 0, c.width, c.height);
    const B = 8, bw = Math.floor(width / B), bh = Math.floor(height / B), hot = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let n = 0, s1 = 0, s2 = 0;
      for (let yy = 0; yy < B; yy += 2) for (let xx = 0; xx < B; xx += 2) { const i = ((by * B + yy) * width + bx * B + xx) * 4; const l = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11; n++; s1 += l; s2 += l * l; }
      const sd = Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2));
      hot[by * bw + bx] = sd > 28 ? 1 : 0;
    }
    // density filter, then largest 4-connected component
    const dense = new Uint8Array(bw * bh);
    for (let by = 2; by < bh - 2; by++) for (let bx = 2; bx < bw - 2; bx++) { let k = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) k += hot[(by + j) * bw + bx + i]; dense[by * bw + bx] = k >= 19 ? 1 : 0; }
    const seen = new Uint8Array(bw * bh); let best = null;
    for (let st = 0; st < dense.length; st++) {
      if (!dense[st] || seen[st]) continue;
      const stack = [st]; seen[st] = 1; let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      while (stack.length) { const p = stack.pop(); n++; const px = p % bw, py = (p / bw) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (const q of [p - 1, p + 1, p - bw, p + bw]) if (q >= 0 && q < dense.length && dense[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
      if (!best || n > best.n) best = { n, x0, y0, x1, y1 };
    }
    if (!best) return null;
    const w = (best.x1 - best.x0 + 3) * B, h = (best.y1 - best.y0 + 3) * B; // +dense filter margin
    const side = Math.sqrt(best.n) * B;
    return { bbox: [best.x0 * B, best.y0 * B, w, h], sideCameraPx: Math.round((w + h) / 2), areaSidePx: Math.round(side), pxPerModule177: +(((w + h) / 2) / 177).toFixed(2), pxPerModule185: +(((w + h) / 2) / 185).toFixed(2), frame: [width, height] };
  });
}

// ---------------------------------------------------------------- main
await mkdir(framesDir, { recursive: true });
let browser, rows = [];
try {
  const monitors = listMonitors();
  monitorInfo = await loadMonitor();
  const cam = monitors.find(m => m.name === monitorInfo.monitor.name) || monitorInfo.monitor;
  const other = monitors.find(m => m.name !== cam.name);
  console.log('Camera monitor', cam.name, cam.w + 'x' + cam.h, '@' + cam.hz + ' Hz;', other ? 'receiver on ' + other.name : 'single monitor');
  await log({ type: 'start', label, mode: modeName, runs, size, timeoutS, monitor: cam, probe, argv });

  const launched = await launch();
  browser = launched.browser;
  const cdp = launched.cdp;
  const context = await browser.newContext({ viewport: null, acceptDownloads: true });
  await context.addInitScript(installHarness, { fps: Number(opt('fps', 0)) || 0, neutral: has('neutral'), camfps: Number(opt('camfps', 0)) || 0 });
  const errors = [];
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));

  const kiosk = await context.newPage();
  await placeWindow(cdp, kiosk, cam, true);

  // The receiver is a separate small popup window (a plain new page would share the kiosk's window).
  const openReceiver = async link => {
    const m = other || cam;
    let dip = { x: m.x, y: m.y, w: m.w, h: m.h };
    try { const w = JSON.parse(await readFile(path.join(snapDir, 'detect.json'), 'utf8')).results.find(r => r.monitor === m.name)?.window; if (w) dip = { x: w.x, y: w.y, w: w.w, h: w.h }; } catch { /* physical fallback */ }
    const left = Math.round(dip.x + dip.w - 340), top = Math.round(dip.y + dip.h - 300);
    const ready = kiosk.waitForEvent('popup');
    await kiosk.evaluate(({ link, f }) => { window.__phone = window.open(link, '_blank', f); }, { link, f: `popup,width=320,height=240,left=${left},top=${top}` });
    const phone = await ready;
    try {
      const t = await phone.context().newCDPSession(phone);
      const { targetInfo } = await t.send('Target.getTargetInfo');
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top, width: 320, height: 240 } });
      await t.detach().catch(() => {});
    } catch { /* popup placement from window.open is already close enough */ }
    return phone;
  };

  for (let run = 1; run <= runs; run++) {
    const tag = `${label}-${modeName}-${stamp}-r${run}`;
    const out = { type: 'run', run, mode: modeName, size, success: false };
    const t0 = Date.now();
    let phone;
    try {
      await kiosk.goto(url);
      await kiosk.waitForFunction(() => window.qa);
      const fixture = await kiosk.evaluate(choosePhoto, { index: 0, size, textured: true });
      await kiosk.locator('#start-button').click();
      const link = await readJoinLink(kiosk);
      if (!link || !link.includes('#L')) throw Error('Could not read the pickup link from the kiosk QR');
      if (selectValue !== 'fast' || has('enlarge')) {
        // The default flow shows the join QR for ~5 s before the square streams.
        if (has('enlarge')) await kiosk.waitForFunction(() => !document.getElementById('light-stream').hidden, null, { timeout: 30000 });
        await kiosk.locator('#light-options summary').click();
        if (selectValue !== 'fast') await kiosk.locator('#light-mode').selectOption(selectValue);
        if (has('enlarge')) await kiosk.locator('#light-expand').click(); // leave the enlarged view open
        else await kiosk.locator('#light-options summary').click(); // collapse: keep default layout
        await delay(500);
      }
      await kiosk.evaluate(() => { window.qa.rendered = 0; });
      phone = await openReceiver(link);
      await phone.locator('#light-receive-panel').waitFor({ timeout: 30000 });

      const started = Date.now();
      let lastSettings = '', lastRendered = 0, lastPresented = null, lastReads = 0, lastHits = 0, lastV = 0, lastKiosk = 0;
      const frameTimes = [5, 15, 30], frameTaken = new Set(), squareMeasures = [], capturedFrames = [];
      const perSec = [];
      let snap, sec = 0, firstFrameAt = 0, success = false, failure = '';
      const settingsTrace = [];
      while (true) {
        await delay(1000);
        sec++;
        snap = await receiverSnapshot(phone);
        const rendered = await kiosk.evaluate(() => window.qa.rendered).catch(() => 0);
        if (snap.firstFrameAt && !firstFrameAt) firstFrameAt = snap.firstFrameAt;
        const camFps = lastPresented == null || snap.presented == null ? 0 : snap.presented - lastPresented;
        const row = { type: 'sec', run, t: sec, camPresented: camFps, camDelivered: (snap.vframes || 0) - lastV, kioskDraws: rendered - lastKiosk,
          reads: (snap.readings || 0) - lastReads, hits: (snap.recognized || 0) - lastHits, unique: snap.unique || 0, progress: +snap.progress.toFixed(4) };
        lastPresented = snap.presented ?? lastPresented; lastV = snap.vframes || 0; lastKiosk = rendered; lastReads = snap.readings || 0; lastHits = snap.recognized || 0;
        perSec.push(row); await log(row);
        if (sec % 5 === 1 || JSON.stringify(snap.settings) !== lastSettings) {
          if (JSON.stringify(snap.settings) !== lastSettings) { lastSettings = JSON.stringify(snap.settings); settingsTrace.push({ t: sec, settings: snap.settings }); await log({ type: 'settings', run, t: sec, settings: snap.settings }); }
        }
        if (sec % 5 === 0) await log({ type: 'progress', run, t: sec, progress: snap.progress, status: snap.status });
        const sinceFirst = firstFrameAt ? (Date.now() - firstFrameAt) / 1000 : 0;
        for (const ft of frameTimes) if (sinceFirst >= ft && !frameTaken.has(ft)) { frameTaken.add(ft); const fr = await saveCameraFrame(phone, path.join(framesDir, `${tag}-t${ft}.png`)); if (fr) { capturedFrames.push({ t: ft, ...fr }); await log({ type: 'frame', run, t: ft, ...fr }); } const sq = await measureSquare(phone); if (sq) { squareMeasures.push(sq); await log({ type: 'square', run, t: sec, ...sq }); } }
        if (has('desktop-shot') && sec === 8) console.log('kiosk', JSON.stringify(await kiosk.evaluate(() => ({ v: document.visibilityState, x: screenX, y: screenY, w: innerWidth, h: innerHeight, hidden: document.getElementById('light-stream').hidden }))), 'phone', JSON.stringify(await phone.evaluate(() => { const v = [...document.querySelectorAll('video')].find(x => x.srcObject) || document.querySelector('video'); return ({ video: v && { rs: v.readyState, paused: v.paused, t: v.currentTime, w: v.videoWidth, hid: v.hidden, disp: getComputedStyle(v).display, track: window.__track?.readyState, muted: window.__track?.muted }, gum: window.qa.constraints, href: location.href.slice(0, 60), start: !document.getElementById('light-start').hidden, body: document.body.innerText.slice(0, 300), v: document.visibilityState, x: screenX, y: screenY, w: innerWidth, h: innerHeight }); })));
        if (has('desktop-shot') && sec === 8) execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'desktop-shot.ps1'), path.join(framesDir, tag + '-desktop.png')]);
        if (snap.error) { failure = 'app error: ' + snap.error; break; }
        if (snap.done) { success = true; break; }
        if (probe ? sec >= Number(opt('secs', 20)) : (Date.now() - started) / 1000 >= timeoutS) { failure = probe ? '' : 'timeout'; break; }
      }
      const doneAt = Date.now();
      const secs = (doneAt - (firstFrameAt || started)) / 1000;
      Object.assign(out, { success: false, finalProgress: +snap.progress.toFixed(4), status: snap.status });

      if (success) {
        const saved = await phone.evaluate(savedPhoto);
        let hashOk = saved.hash === fixture.hash && saved.size === fixture.size;
        const dl = phone.waitForEvent('download', { timeout: 20000 });
        await phone.locator('#save-link').click();
        const download = await dl;
        const h = createHash('sha256'); let n = 0;
        for await (const chunk of await download.createReadStream()) { h.update(chunk); n += chunk.length; }
        hashOk = hashOk && Array.from(h.digest()).join(',') === fixture.hash && n === fixture.size;
        out.success = hashOk; if (!hashOk) failure = 'hash mismatch';
        out.appReported = (await phone.locator('#done-description').textContent().catch(() => '')).trim();
      }
      const quad = squareMeasures.length ? squareMeasures[squareMeasures.length >> 1] : null;
      const q = await phone.evaluate(() => ({ ...window.qa, seen: undefined, quads: undefined, failedFrames: window.qa.failedFrames.length, perSec: undefined }));
      // Failed brightness-read frames (up to 10) -> PNG, to tell tearing / blur / bloom apart.
      const failedPngs = await phone.evaluate(async () => {
        const res = [];
        for (const f of window.qa.failedFrames) {
          const c = document.createElement('canvas'); c.width = f.w; c.height = f.h;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.buf), f.w, f.h), 0, 0);
          res.push(c.toDataURL('image/png').split(',')[1]);
        }
        return res;
      }).catch(() => []);
      for (let i = 0; i < failedPngs.length; i++) await writeFile(path.join(framesDir, `${tag}-miss${i + 1}.png`), Buffer.from(failedPngs[i], 'base64'));

      const lat = await phone.evaluate(() => window.qa.lat);
      const pace = await kiosk.evaluate(() => ({ t: window.qa.drawTimes, prep: window.qa.prep }));
      const presentedDelta = q.lastPresented >= 0 && q.firstPresented >= 0 ? q.lastPresented - q.firstPresented + 1 : null;
      Object.assign(out, {
        failure, seconds: +secs.toFixed(1), kbps: out.success ? +(size / 1000 / secs).toFixed(1) : null,
        camFramesDelivered: q.vframes, camFramesPresented: presentedDelta, camFramesDropped: presentedDelta == null ? null : Math.max(0, presentedDelta - q.vframes),
        cameraFps: +((presentedDelta ?? q.vframes) / Math.max(1, secs)).toFixed(1), videoSize: q.videoSize,
        kioskDrawsPerSec: +((await kiosk.evaluate(() => window.qa.rendered)) / Math.max(1, (doneAt - started) / 1000)).toFixed(1),
        brightReads: q.readings, brightHits: q.recognized, brightHitRate: q.readings ? +(q.recognized / q.readings).toFixed(3) : 0,
        colorLayers: q.layers, colorBackoffs: { warm: q.layers.warm.reads - q.layers.warm.hits, green: q.layers.green.reads - q.layers.green.hits },
        uniquePackets: q.unique, duplicatePackets: q.duplicates, streamHits: q.streamHits, joinOrOtherHits: q.otherHits, uniquePerSec: (() => { const first = perSec.find(r => r.unique > 0); const last = perSec.at(-1); return first ? +((last.unique) / Math.max(1, last.t - first.t + 1)).toFixed(1) : 0; })(), fps: Number(opt('fps', 0)) || 30, neutral: has('neutral'), quad, camBox: monitorInfo.cameraBox, displayHz: cam.hz,
        messageKeys: Object.keys(q.keys), settingsTrace, gumSettings: q.gumSettings, gumConstraints: q.constraints, rtcCalls: q.rtcCalls, audioRequests: q.audioRequests, failedFramesSaved: failedPngs.length,
        decodeLatencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stat(v)])), decodeLatencyBright: stat(Object.entries(lat).filter(([k]) => k.startsWith('bright')).flatMap(([, v]) => v)),
        senderPacing: pacing(pace), frameCaptures: capturedFrames, enlarge: has('enlarge'),
        pageErrors: errors.slice(), constraints: q.constraints
      });
      if (probe) {
        out.perSecond = perSec.map(r => ({ t: r.t, camFps: r.camPresented, delivered: r.camDelivered, kioskFps: r.kioskDraws, reads: r.reads, hits: r.hits }));
        console.log('t  cam  dlvr  kiosk  reads  hits');
        for (const r of out.perSecond) console.log(String(r.t).padStart(2), String(r.camFps).padStart(4), String(r.delivered).padStart(5), String(r.kioskFps).padStart(6), String(r.reads).padStart(6), String(r.hits).padStart(5));
      }
    } catch (error) {
      out.failure = out.failure || String(error.message || error);
      out.success = false;
    } finally {
      await log(out);
      rows.push(out);
      await phone?.close().catch(() => {});
    }
  }
} finally {
  await browser?.close().catch(() => {});
  server.close();
}

// ---------------------------------------------------------------- summary
console.log('\nlabel=' + label + ' mode=' + modeName + (has('enlarge') ? ' (enlarged)' : '') + ' log=' + path.relative(process.cwd(), logFile));
const cols = ['run', 'ok', 'secs', 'KB/s', 'camfps', 'pres/drop', 'bright r/h/%', 'uniq/dup', 'uniq/s', 'warm r/h', 'green r/h', 'prog', 'lat mean/p90 ms', 'kiosk fps', 'interval hist', 'px/mod(185)', 'side px', 'failure'];
console.log(cols.join(' | '));
for (const r of rows) {
  const L = r.colorLayers || {}, lat = r.decodeLatencyBright, p = r.senderPacing;
  console.log([r.run, r.success ? 'yes' : 'NO', r.seconds ?? '-', r.kbps ?? '-', r.cameraFps ?? '-',
    (r.camFramesPresented ?? '-') + '/' + (r.camFramesDropped ?? '-'), (r.brightReads ?? '-') + '/' + (r.brightHits ?? '-') + '/' + pct(r.brightHits, r.brightReads),
    (r.uniquePackets ?? '-') + '/' + (r.duplicatePackets ?? '-'), r.uniquePerSec ?? '-', (L.warm?.reads ?? 0) + '/' + (L.warm?.hits ?? 0), (L.green?.reads ?? 0) + '/' + (L.green?.hits ?? 0),
    r.finalProgress ?? '-', lat ? lat.mean + '/' + lat.p90 : '-', p?.fps ?? '-', p ? Object.entries(p.hist).map(([k, v]) => k + ':' + v).join(' ') : '-',
    r.quad?.pxPerModule185 ?? '-', r.quad?.sideCameraPx ?? '-', r.failure || ''].join(' | '));
}
for (const r of rows) if (probe) console.log('PROBE fps=' + r.fps + (r.neutral ? ' neutral' : ' color') + ': uniq/s=' + r.uniquePerSec + ' bright-hit%=' + pct(r.brightHits, r.brightReads) + ' (stream hits ' + r.streamHits + ', join/other ' + r.joinOrOtherHits + ') colorHits=' + ((r.colorLayers?.warm?.hits || 0) + (r.colorLayers?.green?.hits || 0)) + ' kiosk draws/s=' + r.senderPacing?.fps + ' hist ' + Object.entries(r.senderPacing?.hist || {}).map(([k, v]) => k + ':' + v).join(' '));
process.exit(0);
