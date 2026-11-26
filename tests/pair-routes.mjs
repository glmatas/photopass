// Default kiosk pickup: the static QR pairing code, with the phone's reply
// racing back as a QR to the kiosk camera and as a tone to the kiosk
// microphone, then the moving-square fallback. Silent: all audio travels as
// PCM on the test bus, and both cameras are simulated canvas feeds.
//
//   --qr         Only the kiosk camera receives the reply (the tone is muted).
//   --tone       Only the kiosk microphone receives the reply (the camera sees no phone).
//   --both       Both paths deliver the same reply; the first wins.
//   --tap        Sound is blocked until the visitor taps Play pairing tone; the camera sees no phone.
//   --neither    No reply arrives: the kiosk adds the moving square and the phone switches to its camera.
//   --break-rtc  The reply arrives by QR but the connection is refused: both fall back to the square.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { installDigitalAudio } from './digital-audio.mjs';
import { choosePhoto, savedPhoto } from './photo-qa-fixture.mjs';

const modes = ['--qr', '--tone', '--both', '--tap', '--neither', '--break-rtc'];
const mode = modes.find(m => process.argv.includes(m)) || '--both';
const kioskSees = ['--qr', '--both', '--break-rtc'].includes(mode);
const muteTone = ['--qr', '--neither', '--break-rtc'].includes(mode);
const breakRTC = mode === '--break-rtc';
const tap = mode === '--tap';
const direct = ['--qr', '--tone', '--both', '--tap'].includes(mode);
// Shorter budgets keep the fallback modes quick; the order matches the defaults.
const budgets = { reply: 12000, slow: 8000, connect: 10000, phone: 20000 };

const root = path.resolve(import.meta.dirname, '..');
const route = '/photopass/';
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const target = path.resolve(root, pathname.slice(route.length) || 'index.html');
  if (!pathname.startsWith(route) || !target.startsWith(root + path.sep)) return res.writeHead(404).end();
  try {
    const bytes = await readFile(target);
    const type = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': type[path.extname(target)] || 'application/octet-stream' }).end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + route;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

function installCameras({ kioskSees }) {
  if (!navigator.mediaDevices) return;
  const inner = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.camCalls = 0;
  window.scanCalls = 0;
  function feed(width, height, fps, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(fps);
    const timer = setInterval(() => {
      if (!stream.active) { clearInterval(timer); return; }
      context.fillStyle = '#6b6b6b';
      context.fillRect(0, 0, width, height);
      try { draw(context); } catch { /* The other window may be closing. */ }
    }, 1000 / fps);
    return stream;
  }
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (c) => {
      if (!c.video) return inner(c);
      if (location.hash.startsWith('#L')) {
        // The phone camera on the kiosk screen: the moving square when shown.
        window.camCalls++;
        const stream = feed(640, 640, 30, context => {
          const d = window.opener.document;
          const square = d.getElementById('light-stream');
          if (!d.getElementById('light-send-panel').hidden && !square.hidden) context.drawImage(square, 0, 0, 640, 640);
          else context.drawImage(d.getElementById('pair-qr'), 120, 120, 400, 400);
        });
        window.phoneTrack = stream.getVideoTracks()[0];
        return stream;
      }
      // Only the kiosk's reply scanner asks for this size; the photo camera is refused by the bus.
      if (location.hash || c.video?.width?.ideal !== 1920) return inner(c);
      window.scanCalls++;
      // The kiosk webcam facing the visitor: the phone's reply at a hand's length.
      const stream = feed(1280, 720, 15, context => {
        const d = window.phoneWin?.document;
        const qr = d?.getElementById('pair-qr');
        if (!kioskSees || !qr || d.getElementById('pairing-panel').hidden) return;
        context.fillStyle = '#fff';
        context.fillRect(462, 182, 356, 356);
        context.drawImage(qr, 480, 200, 320, 320);
      });
      window.scanTrack = stream.getVideoTracks()[0];
      return stream;
    },
  });
}

function installFaults({ muteTone, breakRTC, tap, budgets }) {
  window.photoPassBudgets = budgets;
  if (muteTone) {
    window.Worker = new Proxy(window.Worker, {
      construct(WorkerType, args) {
        const worker = new WorkerType(...args);
        if (!String(args[0]).includes('sound/modem-worker')) return worker;
        const post = worker.postMessage.bind(worker);
        const muted = new Set();
        worker.postMessage = (msg, ...rest) => {
          if (msg.kind === 'encode' && msg.bytes.length > 7 && msg.bytes[0] === 97) muted.add(msg.id);
          return post(msg, ...rest);
        };
        worker.addEventListener('message', ({ data }) => {
          if (data.kind === 'wave' && muted.delete(data.id)) { data.pcm.fill(0); window.toneMuted = true; }
        });
        return worker;
      },
    });
  }
  if (tap) {
    // A phone opened from its QR scanner: sound starts only from a tap. A
    // popup keeps the window of its first blank document, so check the page
    // when each context is made, not when this script runs.
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, args) {
        const ctx = new target(...args);
        if (!location.hash.startsWith('#2')) return ctx;
        const resume = ctx.resume.bind(ctx);
        let unlocked = false, allow;
        const gesture = new Promise(resolve => { allow = resolve; });
        ctx.resume = () => {
          if (window.inToneTap) { unlocked = true; allow(); }
          return unlocked ? resume() : gesture.then(resume);
        };
        return ctx;
      },
    });
  }
  if (breakRTC) {
    const apply = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (desc) {
      if (desc.type === 'answer') {
        window.testNetworkBlocked = true;
        return Promise.reject(new Error('simulated blocked connection'));
      }
      return apply.call(this, desc);
    };
  }
}

async function readCode(page, selector) {
  const png = (await page.locator(selector).screenshot({ timeout: 3000 })).toString('base64');
  return page.evaluate(async (png) => {
    const { decodeQR } = await import('./vendor/qr-codecs.js');
    const image = new Image();
    image.src = 'data:image/png;base64,' + png;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const found = decodeQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    return found && { text: found.data, version: found.version };
  }, png);
}

try {
  const ctx = await browser.newContext();
  const faults = [];
  ctx.on('page', (page) => page.on('pageerror', (e) => faults.push(e.message)));
  const setup = [
    [installDigitalAudio, { direct: true }],
    [installCameras, { kioskSees }],
    [installFaults, { muteTone, breakRTC, tap, budgets }],
  ];
  await ctx.addInitScript({
    content: setup.map(([fn, options]) => '(' + fn.toString() + ')(' + JSON.stringify(options) + ');').join('\n'),
  });
  const kiosk = await ctx.newPage();
  await kiosk.goto(url + '?pickup-test=10');
  await kiosk.waitForFunction(() => window.qaAudio?.camera > 0);
  const original = await kiosk.evaluate(choosePhoto, { size: 2300000, index: 0 });
  await kiosk.evaluate(() => {
    window.statusLog = [];
    window.sawSquare = false;
    for (const id of ['pair-status', 'pickup-note', 'pickup-pair-status']) {
      const label = document.getElementById(id);
      new MutationObserver(() => window.statusLog.push(label.textContent)).observe(label, { childList: true });
    }
    const square = document.getElementById('light-send-panel');
    new MutationObserver(() => { if (!square.hidden) window.sawSquare = true; }).observe(square, { attributes: true });
  });
  await kiosk.locator('#start-button').click();
  await kiosk.locator('#pair-qr').waitFor();
  await kiosk.waitForFunction(() => /^Listening for/.test(document.getElementById('pair-listen').textContent) &&
    /Hold the phone/.test(document.getElementById('scan-status').textContent), null, { timeout: 15000 });
  assert.equal(await kiosk.locator('#pair-square').isVisible(), true);
  const offer = await readCode(kiosk, '#pair-qr');
  assert.match(offer.text, /\?2#2[0-9A-Z$*+.-]+\/[0-9A-Z$*+.-]+$/, 'The offer link carries the pickup for the fallback.');
  const next = kiosk.waitForEvent('popup');
  const opened = Date.now();
  await kiosk.evaluate((link) => { window.phoneWin = window.open(link, '_blank'); }, offer.text);
  const phone = await next;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.locator('#pair-text').waitFor({ state: 'attached', timeout: 15000 });
  await phone.waitForFunction(() => document.getElementById('pair-text').value.startsWith('P2:'), null, { timeout: 15000 });
  // A fast direct pickup can replace the reply screen before a screenshot.
  const reply = (await readCode(phone, '#pair-qr').catch(() => null)) ||
    { text: await phone.evaluate(() => document.getElementById('pair-text').value), version: '?' };
  assert.match(reply.text, /^P2:[0-9A-Z$*+.-]+$/);
  assert.equal(await phone.evaluate(() => window.camCalls), 0, 'The reply screen needs no phone camera.');
  await phone.evaluate(() => {
    window.statusLog = [];
    const label = document.getElementById('status');
    new MutationObserver(() => window.statusLog.push(label.textContent)).observe(label, { childList: true });
    window.toneClicks = 0;
    document.addEventListener('click', event => {
      if (!event.isTrusted || event.target.id !== 'pair-tone') return;
      window.toneClicks++;
      window.inToneTap = true;
      setTimeout(() => { window.inToneTap = false; }, 0);
    }, true);
  });
  if (tap) {
    await phone.locator('#pair-tone').waitFor({ timeout: 8000 });
    assert.match(await phone.locator('#pair-tone-status').innerText(), /Sound is off/);
    await phone.locator('#pair-tone').click();
  }
  await phone.locator('#save-link').waitFor({ timeout: 150000 }).catch(async error => {
    console.error('No photo', mode, await kiosk.evaluate(() => window.statusLog), await phone.locator('body').innerText(), faults);
    throw error;
  });
  const seconds = ((Date.now() - opened) / 1000).toFixed(1);
  const bytes = await phone.evaluate(() => window.qaAudio.received);
  const statuses = await kiosk.evaluate(() => window.statusLog);
  if (direct) {
    assert(bytes >= original.size, 'The direct channel should deliver the original.');
    const via = statuses.filter(m => m.startsWith('Phone reply received by '));
    assert.equal(via.length, 1, 'Exactly one reply is applied: ' + via.join(' | '));
    if (mode === '--qr') assert.match(via[0], /by camera/);
    if (mode === '--tone' || tap) assert.match(via[0], /by sound/);
    assert.equal(await kiosk.evaluate(() => window.sawSquare), false, 'A direct pickup never needs the moving square.');
    assert.equal(await phone.evaluate(() => window.camCalls), 0);
    await kiosk.locator('#done-panel').waitFor();
    if (tap) assert.equal(await phone.evaluate(() => window.toneClicks), 1);
  } else {
    assert.equal(bytes, 0, 'The fallback pickup travels by camera.');
    assert.equal(await kiosk.evaluate(() => window.sawSquare), true);
    assert.equal(await phone.evaluate(() => window.camCalls), 1, 'The phone switches to its camera once.');
    if (mode === '--neither') {
      assert(statuses.some(m => m.startsWith('No reply from a phone yet.')));
      assert((await phone.evaluate(() => window.statusLog)).some(m => /kiosk did not connect/.test(m)));
    } else {
      assert(await kiosk.evaluate(() => window.testNetworkBlocked));
      assert(statuses.some(m => m.startsWith('Phone reply received by camera.')));
      assert(statuses.some(m => m.startsWith('Phone reply received, but the direct network connection failed.') && /\[ice \w+, dtls /.test(m)),
        'The kiosk names the network phase with its diagnosis code.');
    }
  }
  // A QR reply can connect before the muted tone is even encoded.
  if (muteTone && !direct) assert(await phone.evaluate(() => window.toneMuted), 'The muted reply tone was played.');
  assert.equal(await kiosk.evaluate(() => window.qaBus.late), 0, 'Test audio must reach the kiosk without gaps.');
  assert.deepEqual(await phone.evaluate(savedPhoto), original);
  assert.equal(await phone.evaluate(() => window.qaAudio.mic), 0, 'The phone never opens its microphone.');
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await kiosk.locator('#reset-button').click();
  await kiosk.waitForFunction(() =>
    window.qaAudio.inputs.every(t => t.readyState === 'ended') &&
    window.qaAudio.contexts.every(c => c.state === 'closed') &&
    (!window.scanTrack || window.scanTrack.readyState === 'ended'));
  await phone.waitForFunction(() => window.qaAudio.contexts.every(c => c.state === 'closed'));
  assert.deepEqual(faults, []);
  console.log('PASS', mode, 'offer QR v' + offer.version, '(' + offer.text.length + ' chars), reply QR v' + reply.version,
    '(' + reply.text.length + ' chars), direct bytes:', bytes, 'scan to photo:', seconds, 's');
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
