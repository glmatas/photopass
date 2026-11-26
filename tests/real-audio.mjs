// REAL speaker -> microphone loop harness (measurement only, never opens the camera).
//
// WARNING: this plays AUDIBLE tones and packets through the machine's real default speaker and records
// from a real microphone (it expects a Logitech BRIO and auto-accepts the permission). It is opt-in:
// it is NOT part of any default or test script and refuses to run without --real-speaker.
// (--kind digital never plays or records anything and does not need the flag.)
//
//   node tests/real-audio.mjs [--kind calibrate|ready|answer[,..]] [--trials N]
//        [--out DIR] [--constraints raw|default] [--fresh-listener] [--label NAME]
//
// Two pages share one headless Chrome: PLAYER (phone role: plays) and LISTENER (kiosk role: the real
// openSoundModem BRIO-selection path, plus a cloned mic track recorded to WAV for offline analysis).
// Playwright's default --mute-audio is removed and --use-fake-ui-for-media-stream auto-accepts the
// permission on the REAL devices. Application modules are imported from the served worktree.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? fallback : argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1];
};
const kinds = String(flag('kind', 'calibrate,ready,answer')).split(',');
if (!argv.includes('--real-speaker') && !(kinds.length === 1 && kinds[0] === 'digital')) {
  console.error('tests/real-audio.mjs plays audible tones through the real speaker and records the real microphone.');
  console.error('Re-run with --real-speaker to confirm (use --kind digital for the silent encode/decode check).');
  process.exit(2);
}
const trials = Number(flag('trials', 20));
const constraints = flag('constraints', 'raw'); // raw = app's constraints, default = audio:true style (EC/NS/AGC on)
const freshListener = flag('fresh-listener', false) === true;
const soundOnly = flag('sound-only', false) === true;
const out = path.resolve(flag('out', 'C:\\Users\\Info\\AppData\\Local\\Temp\\claude\\a846f806ed882179\\4da170e0-4d16-4ed0-9d1e-7e8ca2de129e\\scratchpad\\real-audio'));
const profileArg = flag('profile', undefined);
const profile = profileArg === undefined || profileArg === true ? undefined : /^\s*[{"]/.test(profileArg) ? JSON.parse(profileArg) : profileArg;
const txGainDb = Number(flag('tx-gain-db', 0));
const txGain = 10 ** (txGainDb / 20);
const phoneBand = flag('phone-band', false) === true;
const label = flag('label', constraints + (freshListener ? '-fresh' : '') + (soundOnly ? '-soundonly' : ''));
await mkdir(out, { recursive: true });

const root = path.resolve(import.meta.dirname, '..');
const route = '/photopass/';
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === route + '__blank.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>blank</title>');
  const target = path.resolve(root, pathname.slice(route.length) || 'index.html');
  if (!pathname.startsWith(route) || !target.startsWith(root + path.sep)) return res.writeHead(404).end();
  try { res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(await readFile(target)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + route;

// ---------- offline DSP (Node) ----------
const db = x => 20 * Math.log10(Math.max(x, 1e-9));
function biquad(type, f0, rate, q = Math.SQRT1_2) {
  const w = 2 * Math.PI * f0 / rate, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; } else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  const a0 = 1 + a;
  return [b0 / a0, b1 / a0, b2 / a0, -2 * c / a0, (1 - a) / a0];
}
function filter(x, coefs) {
  let y = x;
  for (const [b0, b1, b2, a1, a2] of coefs) {
    const o = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v;
    }
    y = o;
  }
  return y;
}
const bandpass = (x, rate, lo = 6000, hi = 12000) => filter(x, [biquad('hp', lo, rate), biquad('hp', lo, rate), biquad('lp', hi, rate), biquad('lp', hi, rate)]);
// Occupied band of a signal: the span holding the central 99% of its Welch power spectrum.
function occupiedBand(x, rate, from, to) {
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N), psd = new Float64Array(N / 2);
  for (let p = from; p + N <= to; p += N / 2) {
    for (let i = 0; i < N; i++) { re[i] = x[p + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = -2 * Math.PI / len;
      for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let k = 0; k < N / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  const total = psd.reduce((a, v) => a + v, 0); let c = 0, lo = 0, hi = N / 2 - 1;
  for (let k = 0; k < N / 2; k++) { c += psd[k]; if (c < 0.005 * total) lo = k; if (c < 0.995 * total) hi = k + 1; }
  return { lo: Math.max(100, Math.round(lo * rate / N - 100)), hi: Math.min(rate * 0.45, Math.round(hi * rate / N + 100)) };
}
function cumPower(x) { const c = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) c[i + 1] = c[i] + x[i] * x[i]; return c; }
const rmsOf = (cum, a, b) => { a = Math.max(0, a | 0); b = Math.min(cum.length - 1, b | 0); return b > a ? Math.sqrt((cum[b] - cum[a]) / (b - a)) : 0; };
function goertzel(x, a, n, f, rate) {
  const w = 2 * Math.PI * f / rate, co = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = a; i < a + n; i++) { const s = x[i] + co * s1 - s2; s2 = s1; s1 = s; }
  return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / n; // sine amplitude
}
const median = a => { const s = a.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
const stat = a => { const s = a.filter(Number.isFinite); return s.length ? { n: s.length, min: +Math.min(...s).toFixed(1), med: +median(s).toFixed(1), max: +Math.max(...s).toFixed(1) } : null; };

function wavBytes(float, rate) {
  const buf = Buffer.alloc(44 + float.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + float.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(float.length * 2, 40);
  for (let i = 0; i < float.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, float[i])) * 32767), 44 + i * 2);
  return buf;
}
const saveWav = (name, float, rate) => writeFile(path.join(out, `${label}-${name}.wav`), wavBytes(float, rate)).then(() => path.join(out, `${label}-${name}.wav`));

// ---------- browser ----------
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  args: [
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const faults = [];
const result = { profile: profile ?? 'default(audible-7k-channel-0)', txGainDb, phoneBand, label, constraints, freshListener, soundOnly, started: new Date().toISOString(), base, kinds: {} };
try {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: new URL(base).origin });
  const player = await context.newPage(), listener = await context.newPage();
  for (const [name, p] of [['player', player], ['listener', listener]]) {
    p.on('pageerror', e => faults.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') faults.push(name + ' console.' + m.type() + ': ' + m.text()); });
  }
  // Instrumentation shared by both pages: worker counters and a tap on everything played.
  const common = ({ soundOnly }) => {
    if (soundOnly) delete window.RTCPeerConnection;
    window.__cnt = { encode: 0, consume: 0, packets: 0, kinds: {}, emits: 0 };
    window.__emit = [];
    window.__keepEmit = true;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, ...r) {
      if (m && m.kind === 'encode') window.__cnt.encode++;
      if (m && m.kind === 'consume') window.__cnt.consume++;
      return post.call(this, m, ...r);
    };
    const W = window.Worker;
    window.Worker = function (...a) {
      const w = new W(...a);
      w.addEventListener('message', e => {
        if (e.data?.kind === 'packet') { window.__cnt.packets++; const k = e.data.bytes[4]; window.__cnt.kinds[k] = (window.__cnt.kinds[k] || 0) + 1; }
      });
      return w;
    };
    window.Worker.prototype = W.prototype;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      window.__cnt.emits++;
      if (this.buffer && window.__keepEmit && window.__emit.length < 64) {
        window.__emit.push({ epoch: performance.timeOrigin + performance.now(), rate: this.buffer.sampleRate, pcm: this.buffer.getChannelData(0).slice() });
      }
      return start.apply(this, a);
    };
  };
  await player.addInitScript(o => { window.__opts = o; }, { profile, txGain, phoneBand });
  await listener.addInitScript(o => { window.__opts = o; }, { profile, txGain: 1, phoneBand: false });
  await player.addInitScript(common, { soundOnly });
  // Listener: remember every stream; "default" mode strips the app's EC/NS/AGC/channel constraints.
  await listener.addInitScript(common, { soundOnly });
  await listener.addInitScript(({ mode }) => {
    window.__streams = []; window.__gum = [];
    if (!navigator.mediaDevices) return;
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async c => {
        let sent = c;
        if (mode === 'default' && c?.audio) {
          const a = c.audio, keep = {};
          if (typeof a === 'object') { if (a.deviceId) keep.deviceId = a.deviceId; if (a.groupId) keep.groupId = a.groupId; }
          sent = { ...c, audio: Object.keys(keep).length ? keep : true };
        }
        window.__gum.push({ requested: JSON.stringify(c), sent: JSON.stringify(sent) });
        const s = await orig(sent);
        window.__streams.push(s);
        return s;
      },
    });
  }, { mode: constraints });
  await player.goto(base + '__blank.html');
  await listener.goto(base + '__blank.html');

  // Pull a typed array out of a page in base64 slices.
  async function pull(page, expr, Type) {
    const bytes = await page.evaluate(e => { const a = (0, eval)(e); window.__blob = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); return window.__blob.length; }, expr);
    const parts = [], step = 3 * 1024 * 1024;
    for (let i = 0; i < bytes; i += step) {
      parts.push(Buffer.from(await page.evaluate(([i, step]) => {
        const s = window.__blob.subarray(i, i + step); let r = '';
        for (let j = 0; j < s.length; j += 0x8000) r += String.fromCharCode(...s.subarray(j, j + 0x8000));
        return btoa(r);
      }, [i, step]), 'base64'));
    }
    const buf = Buffer.concat(parts);
    return new Type(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  }

  // Offline decoder: pushes PCM through a fresh modem worker; returns {total, matching} packet counts.
  const defineDecoder = () => {
    window.__decode = (chunks, rate, hex, gain = 1) => new Promise((resolve, reject) => {
      const want = Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
      const w = new Worker(new URL('./vendor/sound/modem-worker.js', location.href));
      let total = 0, matching = 0, pending = 0, sent = false;
      const finish = () => { w.terminate(); resolve({ total, matching }); };
      w.onmessage = ({ data }) => {
        if (data.kind === 'ready') {
          (async () => {
            for (const c of chunks) {
              const g = new Float32Array(c.length);
              for (let i = 0; i < c.length; i++) g[i] = Math.max(-1, Math.min(1, c[i] * gain));
              pending++; w.postMessage({ kind: 'consume', pcm: g }, [g.buffer]);
              if (pending > 16) await new Promise(r => setTimeout(r, 5));
            }
            sent = true; if (!pending) finish();
          })();
        } else if (data.kind === 'packet') {
          total++; const b = data.bytes; if (b.length === want.length && b.every((v, i) => v === want[i])) matching++;
        } else if (data.kind === 'consumed') { pending--; if (sent && pending <= 0) finish(); }
        else if (data.kind === 'error') reject(new Error(data.message));
      };
      w.postMessage({ kind: 'init', rate, listen: true, profile: window.__opts.profile });
    });
  };
  await player.evaluate(defineDecoder); await listener.evaluate(defineDecoder);

  // ---------- page-side roles ----------
  await player.evaluate(async () => {
    const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    const ctx = new AudioContext();
    await ctx.resume();
    const { openSoundModem } = await import('./sound-modem.js');
    let outputNode;
    if (window.__opts.phoneBand) {
      // Phone-speaker model: 2nd-order 800 Hz highpass + 8 kHz lowpass in front of the destination.
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 800;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8000;
      hp.connect(lp); lp.connect(ctx.destination); outputNode = hp;
    }
    const modem = await openSoundModem({ context: ctx, listen: false, profile: window.__opts.profile, txGain: window.__opts.txGain, outputNode });
    window.P = { ctx, modem, hex, maxPacket: () => modem.maxPacketSize };
    window.P.fromHex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
    // Plays one packet exactly like the phone: pairingChirp true for ready, false for the answer.
    window.P.play = async (h, pairingChirp) => {
      window.__emit.length = 0;
      const sent = performance.timeOrigin + performance.now();
      await modem.send(window.P.fromHex(h), { pairingChirp });
      const e = window.__emit[0];
      return { call: sent, t0: e.epoch, seconds: e.pcm.length / e.rate, samples: e.pcm.length, rate: e.rate, done: performance.timeOrigin + performance.now() };
    };
    window.P.tone = async (freq, ms, amp) => {
      window.__emit.length = 0;
      const rate = ctx.sampleRate, n = Math.round(rate * ms / 1000), fade = Math.round(rate * 0.005);
      const buf = ctx.createBuffer(1, n, rate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = amp * Math.min(1, i / fade, (n - 1 - i) / fade) * Math.sin(2 * Math.PI * freq * i / rate);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      await new Promise(res => { src.onended = res; src.start(); });
      return { t0: window.__emit[0].epoch, rate };
    };
  });
  const playerInfo = await player.evaluate(() => ({ sampleRate: P.ctx.sampleRate, baseLatency: P.ctx.baseLatency, outputLatency: P.ctx.outputLatency, state: P.ctx.state }));
  result.player = playerInfo;

  const needListener = kinds.some(k => k !== 'digital');
  async function openListener() {
    return listener.evaluate(async () => {
      if (!window.L) {
        const ctx = new AudioContext();
        await ctx.resume();
        window.L = { ctx, packets: [], rec: [], times: [], expect: undefined, meterOn: false };
        window.L.mod = await import('./sound-modem.js');
      }
      const L = window.L;
      L.packets.length = 0;
      const t0 = performance.now();
      L.modem = await L.mod.openSoundModem({
        context: L.ctx, listen: true, cameraGroup: '', profile: window.__opts.profile,
        onPacket(bytes) {
          const e = L.expect, ok = !!e && e.length === bytes.length && e.every((v, i) => v === bytes[i]);
          let diff = null;
          if (e && !ok && e.length === bytes.length) diff = bytes.reduce((n, v, i) => n + (v !== e[i] ? 1 : 0), 0);
          L.packets.push({ epoch: performance.timeOrigin + performance.now(), ok, len: bytes.length, diff, head: Array.from(bytes.slice(0, 8)).join(',') });
        },
        onError: e => { L.error = String(e); },
      });
      L.openMs = performance.now() - t0;
      if (!L.meterOn) {
        // Meter: a clone of the live capture track, recorded raw for offline analysis.
        const live = window.__streams.filter(s => s.getAudioTracks()[0]?.readyState === 'live').at(-1);
        const track = live.getAudioTracks()[0];
        L.track = track;
        const src = L.ctx.createMediaStreamSource(new MediaStream([track.clone()]));
        const sp = L.ctx.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = e => { L.rec.push(e.inputBuffer.getChannelData(0).slice()); L.times.push(performance.timeOrigin + performance.now()); };
        const mute = L.ctx.createGain(); mute.gain.value = 0;
        src.connect(sp); sp.connect(mute); mute.connect(L.ctx.destination);
        L.meterOn = true;
      }
      return { listening: L.modem.listening, listenError: String(L.modem.listenError ?? ''), inputLabel: L.modem.inputLabel, openMs: L.openMs };
    });
  }
  async function closeListener() { await listener.evaluate(() => { window.L.modem.close(); }); }

  let opened;
  if (needListener) {
    opened = await openListener();
    if (!opened.listening) {
      console.error('LISTENER NOT LISTENING:', JSON.stringify(opened));
      result.fatal = opened; throw new Error('Microphone did not open: ' + opened.listenError);
    }
    result.listenerOpen = opened;
    result.listener = await listener.evaluate(async () => {
      const t = L.track, devs = await navigator.mediaDevices.enumerateDevices();
      return {
        label: t.label, settings: t.getSettings(), capabilities: t.getCapabilities?.(), sampleRate: L.ctx.sampleRate,
        baseLatency: L.ctx.baseLatency, outputLatency: L.ctx.outputLatency, gum: window.__gum,
        devices: devs.filter(d => d.kind !== 'videoinput').map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId.slice(0, 8), groupId: d.groupId.slice(0, 8) })),
        isBrio: /brio/i.test(t.label),
      };
    });
    console.log('Mic:', result.listener.label, '| BRIO:', result.listener.isBrio, '| rate', result.listener.sampleRate, '| settings', JSON.stringify(result.listener.settings));
    await new Promise(r => setTimeout(r, 800));
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Take the whole recording since the last reset, as float samples + an epoch->sample mapping.
  async function takeRecording() {
    const rate = result.listener.sampleRate;
    const samples = await pull(listener, `(()=>{const n=L.rec.reduce((a,b)=>a+b.length,0),o=new Float32Array(n);let p=0;for(const b of L.rec){o.set(b,p);p+=b.length}return o})()`, Float32Array);
    const times = await listener.evaluate(() => L.times.slice());
    // Block k (1024 samples) was delivered at times[k]; fit a line to average out callback jitter.
    const n = times.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    times.forEach((t, k) => { sx += k; sy += t; sxx += k * k; sxy += k * t; });
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
    // epoch of the END of block k = icpt + slope*k ; sample index of that end = (k+1)*1024.
    const idx = e => ((e - icpt) / slope + 1) * 1024; // sample index at epoch e (block end ~ delivery time)
    const epochAt = i => icpt + slope * (i / 1024 - 1); // inverse of idx
    return { samples, rate, idx, epochAt, blockMs: slope, startEpoch: times[0] };
  }
  const resetRecording = () => listener.evaluate(() => { L.rec.length = 0; L.times.length = 0; });

  // ---------- calibrate ----------
  async function calibrate() {
    await resetRecording();
    const silence0 = Date.now();
    await sleep(2000);
    const silence1 = Date.now();
    await sleep(300);
    const freqs = [300, 500, 800, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 16000];
    const amp = 0.25, steps = [];
    for (const f of freqs) {
      const r = await player.evaluate(([f, a]) => P.tone(f, 150, a), [f, amp]);
      steps.push({ f, t0: r.t0 });
      await sleep(450);
    }
    // Constant tones to expose ducking / AGC: level every 100 ms.
    const ducks = [];
    for (const f of [1000, 9200]) {
      await sleep(800);
      const t = Date.now();
      const r = await player.evaluate(([f, a]) => P.tone(f, 2000, a), [f, amp]);
      ducks.push({ f, t0: r.t0, before: t });
      await sleep(1000);
    }
    await sleep(500);
    const rec = await takeRecording();
    const x = rec.samples, rate = rec.rate, W = Math.round(rate * 0.1);
    const idx0 = Math.max(rec.idx(silence0), 0) + 0.3 * rate, idx1 = rec.idx(silence1) - 0.1 * rate; // margins: recording start / first tone
    const silence = { rms: db(Math.sqrt(cumPowerRange(x, idx0, idx1))) };
    function cumPowerRange(x, a, b) { let s = 0; a = Math.max(0, a | 0); for (let i = a; i < b; i++) s += x[i] * x[i]; return s / (b - a); }
    const bp = bandpass(x, rate), cumBp = cumPower(bp), cumAll = cumPower(x);
    silence.inband = db(rmsOf(cumBp, idx0, idx1));
    const rows = [];
    for (const s of steps) {
      const i0 = Math.round(rec.idx(s.t0));
      // noise at this frequency, 100 ms windows across the silence interval
      const noiseAmps = [];
      for (let i = Math.round(idx0); i + W < idx1; i += W) noiseAmps.push(goertzel(x, i, W, s.f, rate));
      const noiseA = Math.sqrt(noiseAmps.reduce((a, v) => a + v * v, 0) / noiseAmps.length);
      let best = 0, bestI = i0;
      for (let i = i0 - Math.round(rate * 0.05); i < i0 + Math.round(rate * 0.8); i += Math.round(rate * 0.005)) {
        const a = goertzel(x, i, W, s.f, rate);
        if (a > best) { best = a; bestI = i; }
      }
      // onset: first 20 ms window whose amplitude exceeds 12 dB above the noise amplitude
      let onset = null; const w20 = Math.round(rate * 0.02);
      for (let i = i0 - Math.round(rate * 0.05); i < i0 + Math.round(rate * 0.8); i += Math.round(rate * 0.002)) {
        if (goertzel(x, i, w20, s.f, rate) > noiseA * 4) { onset = rec.epochAt(i + w20 / 2) - s.t0; break; }
      }
      let peak = 0, clip = 0;
      for (let i = i0; i < i0 + Math.round(rate * 0.8); i++) { const v = Math.abs(x[i]); peak = Math.max(peak, v); if (v >= 0.98) clip++; }
      rows.push({ f: s.f, rxDbfs: +db(best / Math.SQRT2).toFixed(1), noiseDbfs: +db(noiseA / Math.SQRT2).toFixed(1),
        snrDb: +db(best / noiseA).toFixed(1), gainDb: +db(best / amp).toFixed(1), onsetMs: onset == null ? null : +onset.toFixed(0), peak: +peak.toFixed(3), clip });
    }
    // ducking: levels every 100 ms around each constant tone
    const duck = ducks.map(d => {
      const i0 = rec.idx(d.t0), series = [];
      for (let k = -5; k < 35; k++) {
        const a = Math.round(i0 + k * W);
        series.push({ t: k * 100, tone: +db(goertzel(x, a, W, d.f, rate) / Math.SQRT2).toFixed(1), rms: +db(rmsOf(cumAll, a, a + W)).toFixed(1) });
      }
      const at = (lo, hi) => { const v = series.filter(s => s.t >= lo && s.t < hi).map(s => s.tone); return v.length ? v.reduce((a, b) => a + b) / v.length : NaN; };
      const peak = Math.max(...series.map(s => s.tone));
      return {
        f: d.f, peakDb: peak, first300ms: +at(200, 500).toFixed(1), mid: +at(800, 1200).toFixed(1), last: +at(1500, 1900).toFixed(1),
        dropDb: +(at(1500, 1900) - at(200, 500)).toFixed(1),
        noiseBefore: +(series.filter(s => s.t < 0).reduce((a, s) => a + s.rms, 0) / 5).toFixed(1),
        noiseAfter: +(series.filter(s => s.t >= 2400 && s.t < 3400).reduce((a, s) => a + s.rms, 0) / 10).toFixed(1),
        series,
      };
    });
    const wavFile = await saveWav('calibrate-mic', x, rate);
    const lat = median(rows.filter(r => r.snrDb > 20).map(r => r.onsetMs));
    const clipTotal = rows.reduce((a, r) => a + r.clip, 0);
    console.log('\nCALIBRATION  (tone 0.25 amp, rx = Goertzel amp in dBFS RMS-equivalent; noise measured in the same 100 ms/10 Hz bin)');
    console.log(' freq   rx dBFS  noise dBFS  SNR dB  gain dB  onset ms  peak  clip');
    for (const r of rows) console.log(String(r.f).padStart(6), String(r.rxDbfs).padStart(9), String(r.noiseDbfs).padStart(11), String(r.snrDb).padStart(7), String(r.gainDb).padStart(8), String(r.onsetMs).padStart(9), String(r.peak).padStart(6), String(r.clip).padStart(5));
    console.log(`broadband silence RMS ${silence.rms.toFixed(1)} dBFS, in-band 6-12k ${silence.inband.toFixed(1)} dBFS; median onset latency (SNR>20) ${lat} ms; clipped samples ${clipTotal}`);
    for (const d of duck) console.log(`ducking ${d.f} Hz: tone ${d.first300ms} dB (0.2-0.5 s) -> ${d.mid} (0.8-1.2 s) -> ${d.last} (1.5-1.9 s), drop ${d.dropDb} dB; noise before ${d.noiseBefore} after ${d.noiseAfter} dBFS`);
    result.kinds.calibrate = { silence, rows, duck, medianOnsetMs: lat, clipTotal, wav: wavFile };
  }

  // ---------- ready / answer ----------
  async function packetTrials(kind) {
    const idHex = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
    // Real packet builders, imported from the served worktree.
    const built = await player.evaluate(async ({ kind, idHex, nonce }) => {
      const { pickupPacket } = await import('./pickup.js');
      const token = pickupPacket(idHex, nonce);
      let bytes = token, detail = {};
      if (kind === 'answer') {
        const [{ PhotoPeer }, { encodeCompact }] = await Promise.all([import('./peer.js'), import('./signal-codec.js')]);
        const c = document.createElement('canvas'); c.width = 64; c.height = 48; c.getContext('2d').fillRect(0, 0, 40, 30);
        const file = new File([await new Promise(r => c.toBlob(r, 'image/jpeg'))], 'qa.jpg', { type: 'image/jpeg' });
        const a = new PhotoPeer({}), b = new PhotoPeer({});
        const offer = await a.offer(file, { quickGather: true });
        const answer = await b.answer(offer, { quickGather: true });
        const round = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(16).padStart(8, '0')).join('');
        const payload = encodeCompact(answer, round);
        bytes = Uint8Array.of(...token, 65, ...payload); // exactly pickup-direct.js message()
        detail = { sdpLength: answer.sdp.length, compactBytes: payload.length };
        a.close(); b.close();
      }
      return { hex: P.hex(bytes), length: bytes.length, tokenLength: token.length, ...detail };
    }, { kind, idHex, nonce });
    console.log(`\n${kind.toUpperCase()} packet: ${built.length} bytes`, JSON.stringify(built).slice(0, 160));
    const maxPacket = await player.evaluate(() => P.maxPacket());
    if (built.length > maxPacket) {
      console.log(`${kind}: packet ${built.length} B exceeds this profile's frame_length ${maxPacket}; skipped`);
      result.kinds[kind] = { summary: { kind, packetBytes: built.length, skipped: 'packet exceeds frame_length ' + maxPacket } };
      return;
    }
    await listener.evaluate(h => { L.expect = Uint8Array.from(h.match(/../g), x => parseInt(x, 16)); }, built.hex);
    await resetRecording();
    const rows = [], chirp = kind === 'ready';
    let emittedWav;
    await sleep(1500);
    for (let n = 0; n < trials; n++) {
      if (freshListener && n) { await closeListener(); await sleep(300); const o = await openListener(); if (!o.listening) throw new Error('reopen failed ' + JSON.stringify(o)); await sleep(500); await listener.evaluate(h => { L.expect = Uint8Array.from(h.match(/../g), x => parseInt(x, 16)); }, built.hex); }
      const before = await listener.evaluate(() => L.packets.length);
      const r = await player.evaluate(([h, c]) => P.play(h, c), [built.hex, chirp]);
      if (!emittedWav) {
        const pcm = await pull(player, '__emit[0].pcm', Float32Array);
        emittedWav = { pcm, rate: r.rate };
        await saveWav(`${kind}-emitted`, pcm, r.rate);
      }
      await sleep(1500);
      const pk = (await listener.evaluate(() => L.packets.slice())).slice(before);
      const good = pk.filter(p => p.ok), bad = pk.filter(p => !p.ok);
      rows.push({ n, t0: r.t0, seconds: r.seconds, decoded: good.length > 0, copies: good.length,
        latencyMs: good.length ? Math.round(good[0].epoch - r.t0) : null, wrong: bad.map(p => ({ len: p.len, diff: p.diff, head: p.head })) });
      process.stdout.write(good.length ? '+' : '.');
    }
    console.log();
    await sleep(1500);
    // Controls: (a) the emitted PCM straight into a decoder, (b) the recorded microphone audio, at several digital gains.
    const control = await player.evaluate(async ([hex]) => {
      const e = window.__emit[0], pad = new Float32Array(Math.round(e.rate * 0.5));
      return window.__decode([pad, e.pcm, pad], e.rate, hex);
    }, [built.hex]);
    const offline = {};
    for (const g of [1, 4, 16]) {
      offline['x' + g] = await listener.evaluate(([hex, g]) => window.__decode(L.rec, L.ctx.sampleRate, hex, g), [built.hex, g]);
    }
    console.log('  control: emitted PCM direct ->', JSON.stringify(control), '| recorded mic offline ->', JSON.stringify(offline));
    const rec = await takeRecording(), x = rec.samples, rate = rec.rate;
    // Band actually occupied by the modem body (skip chirp + 40 ms lead cue and the 25 ms tail).
    const skip = Math.round(((chirp ? 0.155 : 0) + 0.05) * emittedWav.rate);
    const band = occupiedBand(emittedWav.pcm, emittedWav.rate, skip, emittedWav.pcm.length - Math.round(0.03 * emittedWav.rate));
    const bp = bandpass(x, rate, band.lo, band.hi), cumBp = cumPower(bp), cumAll = cumPower(x);
    const ebp = emittedWav.rate === rate ? rmsOf(cumPower(bandpass(emittedWav.pcm.subarray(skip), rate, band.lo, band.hi)), 0, emittedWav.pcm.length - skip) : NaN;
    for (const row of rows) {
      const i0 = rec.idx(row.t0), W = Math.round(row.seconds * rate), step = Math.round(rate * 0.02);
      const nA = i0 - 0.6 * rate, nB = i0 - 0.05 * rate;
      const noiseBp = rmsOf(cumBp, nA, nB), noiseAll = rmsOf(cumAll, nA, nB);
      let best = -1, bi = i0;
      for (let i = Math.round(i0); i < i0 + rate * (row.seconds + 1.2); i += step) { const p = rmsOf(cumBp, i, i + W); if (p > best) { best = p; bi = i; } }
      let peak = 0, clip = 0;
      for (let i = Math.round(i0 - 0.05 * rate); i < i0 + rate * (row.seconds + 1.2); i++) { const v = Math.abs(x[i] || 0); if (v > peak) peak = v; if (v >= 0.98) clip++; }
      // onset: first 10 ms in-band window 10 dB over the noise floor
      let onset = null; const w10 = Math.round(rate * 0.01);
      for (let i = Math.round(i0 - 0.05 * rate); i < i0 + rate * (row.seconds + 1.2); i += Math.round(rate * 0.002)) {
        if (rmsOf(cumBp, i, i + w10) > noiseBp * 3.16) { onset = rec.epochAt(i) - row.t0; break; }
      }
      Object.assign(row, {
        sigInbandDbfs: +db(best).toFixed(1), noiseInbandDbfs: +db(noiseBp).toFixed(1), noiseBroadDbfs: +db(noiseAll).toFixed(1),
        snrDb: +db(best / noiseBp).toFixed(1), lossDb: Number.isFinite(ebp) ? +db(ebp / best).toFixed(1) : null,
        peak: +peak.toFixed(3), clipped: clip, onsetMs: onset == null ? null : Math.round(onset),
        sigBroadDbfs: +db(rmsOf(cumAll, bi, bi + W)).toFixed(1),
      });
    }
    const wavFile = await saveWav(`${kind}-mic`, x, rate);
    const ok = rows.filter(r => r.decoded);
    const summary = {
      kind, packetBytes: built.length, detail: built, trials, decoded: ok.length, packetsWrong: rows.reduce((a, r) => a + r.wrong.length, 0),
      emittedInbandDbfs: Number.isFinite(ebp) ? +db(ebp).toFixed(1) : null,
      signalInbandDbfs: stat(rows.map(r => r.sigInbandDbfs)), noiseInbandDbfs: stat(rows.map(r => r.noiseInbandDbfs)),
      snrDb: stat(rows.map(r => r.snrDb)), lossDb: stat(rows.map(r => r.lossDb)), peak: stat(rows.map(r => r.peak)),
      clippedTrials: rows.filter(r => r.clipped > 0 || r.peak >= 0.98).length,
      decodeLatencyMs: stat(ok.map(r => r.latencyMs)), acousticOnsetMs: stat(rows.map(r => r.onsetMs)),
      snrWhenDecoded: stat(ok.map(r => r.snrDb)), snrWhenFailed: stat(rows.filter(r => !r.decoded).map(r => r.snrDb)),
      packetSeconds: +rows[0].seconds.toFixed(2), modemSeconds: +(rows[0].seconds - (chirp ? 0.155 : 0)).toFixed(2), band, maxPacket, control, offlineDecodeOfMicRecording: offline, wavMic: wavFile, wavEmitted: path.join(out, `${label}-${kind}-emitted.wav`),
    };
    console.log(`${kind}: decoded ${summary.decoded}/${trials}; wrong packets ${summary.packetsWrong}; packet ${summary.packetSeconds}s; clipped trials ${summary.clippedTrials}`);
    console.log(`  band ${summary.band.lo}-${summary.band.hi} Hz dBFS: emitted`, summary.emittedInbandDbfs, '| received', JSON.stringify(summary.signalInbandDbfs), '| noise', JSON.stringify(summary.noiseInbandDbfs));
    console.log('  SNR dB', JSON.stringify(summary.snrDb), '| acoustic loss dB', JSON.stringify(summary.lossDb), '| peak', JSON.stringify(summary.peak));
    console.log('  decode latency ms', JSON.stringify(summary.decodeLatencyMs), '| onset ms', JSON.stringify(summary.acousticOnsetMs));
    result.kinds[kind] = { summary, rows };
  }

  for (const kind of kinds) {
    if (kind === 'digital') {
      // Digital-only check: encode random packets of several sizes with the profile and decode the PCM directly.
      for (const size of [22, 208, 256, 400, 512, 600, 800, 1200]) {
        const r = await player.evaluate(async ([size, profile]) => {
          const bytes = crypto.getRandomValues(new Uint8Array(size));
          const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
          try {
            const pcm = await new Promise((res, rej) => {
              const w = new Worker(new URL('./vendor/sound/modem-worker.js', location.href));
              w.onmessage = ({ data }) => {
                if (data.kind === 'ready') w.postMessage({ kind: 'encode', id: 1, bytes });
                else if (data.kind === 'wave') { w.terminate(); res(data.pcm); }
                else if (data.kind === 'error') { w.terminate(); rej(new Error(data.message)); }
              };
              w.postMessage({ kind: 'init', rate: 48000, listen: false, profile });
            });
            const pad = new Float32Array(24000);
            const d = await window.__decode([pad, pcm, pad], 48000, hex);
            return { size, seconds: +(pcm.length / 48000).toFixed(2), ...d };
          } catch (e) { return { size, error: e.message }; }
        }, [size, profile]);
        console.log('digital', JSON.stringify(r));
        (result.kinds.digital ??= []).push(r);
      }
    } else if (kind === 'calibrate') await calibrate();
    else if (kind === 'ready' || kind === 'answer') await packetTrials(kind);
    else throw new Error('Unknown --kind ' + kind);
    await sleep(500);
  }
  if (needListener) result.listenerErrors = await listener.evaluate(() => window.L.error ?? null);
  result.totalPackets = needListener ? await listener.evaluate(() => ({ all: L.packets.length, wrong: L.packets.filter(p => !p.ok).length })) : undefined;
} catch (error) {
  result.error = String(error?.stack || error);
  console.error('ERROR', result.error);
  process.exitCode = 1;
} finally {
  result.faults = faults.slice(0, 30);
  result.finished = new Date().toISOString();
  const file = path.join(out, `${label}-${kinds.join('+')}-results.json`);
  await writeFile(file, JSON.stringify(result, null, 1));
  console.log('\nresults JSON:', file);
  if (faults.length) console.log('page faults:', faults.slice(0, 8));
  await browser.close().catch(() => {});
  server.close();
}
