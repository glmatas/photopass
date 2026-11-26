import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { installDigitalAudio } from './digital-audio.mjs';
import { choosePhoto, savedPhoto } from './photo-qa-fixture.mjs';

const live = process.argv.includes('--live');
const dropRTC = process.argv.includes('--drop-rtc');
const loseAnswer = process.argv.includes('--lose-answer');
const brio = process.argv.includes('--brio');
const retryTone = process.argv.includes('--retry-tone');
const direct = !process.argv.includes('--no-rtc');
const breakRTC = process.argv.includes('--break-rtc');
const root = path.resolve(import.meta.dirname, '..');
const route = '/photopass/';
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const target = path.resolve(root, pathname.slice(route.length) || 'index.html');
  if (!pathname.startsWith(route) || !target.startsWith(root + path.sep)) return res.writeHead(404).end();
  try {
    const bytes = await readFile(target);
    res
      .writeHead(200, {
        'content-type':
          {
            '.js': 'text/javascript',
            '.html': 'text/html',
            '.css': 'text/css',
            '.wasm': 'application/wasm',
            '.json': 'application/json',
          }[path.extname(target)] || 'application/octet-stream',
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
if (!live) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = live
  ? 'https://glmatas.github.io/photopass/'
  : 'http://127.0.0.1:' + server.address().port + route;
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
try {
  const ctx = await browser.newContext();
  const faults = [];
  ctx.on('page', (page) => page.on('pageerror', (e) => faults.push(e.message)));
  function installCamera() {
    if (!navigator.mediaDevices) return;
    const audio = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.camCalls = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (c) => {
        if (!c.video || !location.hash.startsWith('#L')) return audio(c);
        window.camCalls++;
        // Opening the link must wait for camera permission before emitting PCM.
        await new Promise((resolve) => {
          window.grant = resolve;
        });
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 640;
        const context = canvas.getContext('2d'),
          stream = canvas.captureStream(30);
        window.phoneTrack = stream.getVideoTracks()[0];
        const interval = setInterval(() => {
          if (!stream.active) {
            clearInterval(interval);
            return;
          }
          const d = window.opener.document,
            join = d.getElementById('light-join');
          const streamCanvas = d.getElementById('light-stream');
          context.drawImage(streamCanvas.hidden ? join : streamCanvas, 0, 0, 640, 640);
        }, 33);
        return stream;
      },
    });
  }
  function installFailures({ breakRTC, dropRTC, brio, loseAnswer, retryTone }) {
    if (!navigator.mediaDevices) return;
    if (retryTone) {
      Object.defineProperty(navigator, 'audioSession', {value: { type:'auto' }, configurable:true});
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable:true, value:c => {
        if (c.audio && !location.hash && !window.allowKioskMic) return Promise.reject(new DOMException('Test denied mic', 'NotAllowedError'));
        return original(c);
      }});
    }
    if (loseAnswer || retryTone) {
      window.Worker = new Proxy(window.Worker, {
        construct(WorkerType, args) {
          const worker = new WorkerType(...args);
          if (!String(args[0]).includes('sound/modem-worker')) return worker;
          const post = worker.postMessage.bind(worker);
          const muted = new Set();
          worker.postMessage = (msg, ...rest) => {
              if (msg.kind === 'encode') {
                if (loseAnswer && msg.bytes.length > 22 && msg.bytes[22] === 65) muted.add(msg.id);
                if (retryTone && window.simulateSilent && navigator.audioSession.type !== 'playback') muted.add(msg.id);
              }
            return post(msg, ...rest);
          };
          worker.addEventListener('message', ({ data }) => {
            if (data.kind === 'wave' && muted.delete(data.id)) {
              data.pcm.fill(0);
              window.testAnswerLost = true;
                window.mutedBursts = (window.mutedBursts || 0) + 1;
            }
          });
          return worker;
        },
      });
    }
    if (breakRTC) {
      const applyRemote = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (desc) {
        if (desc.type === 'answer') {
          window.testNetworkBlocked = true;
          return Promise.reject(new Error('simulated blocked connection'));
        }
        return applyRemote.call(this, desc);
      };
    }
    if (dropRTC) {
      const descriptor = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
      Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
        ...descriptor,
        set(handler) {
          return descriptor.set.call(this, function (event) {
            if (
              location.hash.startsWith('#L') &&
              window.qaAudio.received >= 163840 &&
              !window.testChannelLost
            ) {
              window.testChannelLost = true;
              this.close();
              return;
            }
            handler.call(this, event);
          });
        },
      });
    }
    if (brio) {
      const devices = navigator.mediaDevices;
      Object.defineProperty(devices, 'enumerateDevices', {
        configurable: true,
        value: async () => [
          { kind: 'audioinput', deviceId: 'desk', groupId: 'laptop', label: 'PC microphone' },
          { kind: 'audioinput', deviceId: 'webcam', groupId: 'cam-group', label: 'Logitech BRIO 4K' },
        ],
      });
      const original = devices.getUserMedia.bind(devices);
      Object.defineProperty(devices, 'getUserMedia', {
        configurable: true,
        value: async (c) => {
          if (c.audio) (window.requestedInputs ??= []).push(c.audio.deviceId?.exact || 'desk');
          return original(c);
        },
      });
    }
  }
  // Install in a single init script so the camera can reuse the bridged microphone.
  const setup = [
    [installDigitalAudio, { direct }],
    [installCamera, {}],
    [installFailures, { breakRTC, dropRTC, brio, loseAnswer, retryTone }],
  ];
  await ctx.addInitScript({
    content: setup
      .map(([fn, options]) => '(' + fn.toString() + ')(' + JSON.stringify(options) + ');')
      .join('\n'),
  });
  const kiosk = await ctx.newPage();
  await kiosk.goto(url + '?pickup-test=10');
  await kiosk.waitForFunction(() => window.qaAudio?.camera > 0);
  const original = await kiosk.evaluate(choosePhoto, {
    size: process.argv.includes('--10mb') ? 10000000 : 2300000,
    index: 0,
  });
  await kiosk.locator('#start-button').click();
  await kiosk.locator('#light-join').waitFor();
  const qrImage = (await kiosk.locator('.pickup-target').screenshot()).toString('base64');
  const link = await kiosk.evaluate(async (png) => {
    const { decodeQR } = await import('./vendor/qr-codecs.js');
    const screen = new Image();
    screen.src = 'data:image/png;base64,' + png;
    await screen.decode();
    const c = document.createElement('canvas');
    c.width = screen.width;
    c.height = screen.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(screen, 0, 0);
    const frame = ctx.getImageData(0, 0, c.width, c.height);
    return decodeQR(frame.data, c.width, c.height).data;
  }, qrImage);
  assert.match(link, /\?12#L[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8}$/);
  const before = await kiosk.locator('.pickup-target').boundingBox();
  // Exercise an actual packet with incorrect session bytes on the same PCM bus.
  const wrong = await kiosk.evaluate(async (link) => {
    const { readyTone, pickupPacket } = await import('./pickup.js');
    const m = link.split('#L')[1].split('.');
    const id = Array.from(atob(m[0].replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0).toString(16).padStart(2, '0'),
    ).join('');
    const wrong = m[1].slice(0, 7) + (m[1].endsWith('A') ? 'B' : 'A');
    return Array.from(pickupPacket(id, wrong));
  }, link);
  const next = kiosk.waitForEvent('popup');
  await kiosk.evaluate((link) => {
    window.open(link, '_blank');
  }, link);
  const phone = await next;
  await phone.setViewportSize({width:390, height:844});
  await phone
    .waitForFunction(() => !!window.grant, null, { timeout: 9000 })
    .catch(async (error) => {
      console.log(
        'permission wait',
        phone.url(),
        await phone.locator('body').innerText(),
        faults,
        await phone.evaluate(() => [window.camCalls, window.qaAudio?.camera]),
      );
      throw error;
    });
  assert.equal(await phone.evaluate(() => window.qaAudio.contexts.length), 0);
  assert.equal(await phone.locator('#light-start').isVisible(), false);
  assert.equal(
    await phone.locator('#light-receive-panel button:visible, #light-receive-panel a:visible').count(),
    0,
  );
  if (retryTone) {
    await kiosk.locator('#pickup-mic-retry').waitFor();
    assert.match(await kiosk.locator('#pickup-pair-status').innerText(), /microphone unavailable/i);
    await kiosk.evaluate(() => { window.allowKioskMic = true; });
    await kiosk.locator('#pickup-mic-retry').click();
  }
  await kiosk.waitForFunction(() => document.querySelector('#pickup-pair-status').textContent.startsWith('Listening for'));
  await kiosk.evaluate(() => {
    const label = document.querySelector('#pickup-pair-status');
    window.statusLog = [];
    new MutationObserver(() => window.statusLog.push(label.textContent)).observe(label, {childList:true});
  });
  await phone.evaluate(async (data) => {
    const { readyTone } = await import('./pickup.js');
    window.testLife = new AbortController();
    await readyTone(Uint8Array.from(data), window.testLife.signal);
  }, wrong);
  await phone.waitForTimeout(500);
  assert(await kiosk.evaluate(() => window.qaBus.outputs.phone > 0));
  assert.notEqual(await kiosk.locator('#light-send-panel').getAttribute('data-pickup-state'), 'ready');
  const started = Date.now();
  await phone.evaluate(retry => {
    window.testLife.abort();
    window.simulateSilent = retry;
    window.grant();
  }, retryTone);
  if (retryTone) {
    await phone.locator('#phone-tone').waitFor();
    assert((await phone.evaluate(() => window.mutedBursts)) >= 2);
    assert.equal(await kiosk.locator('#light-send-panel').getAttribute('data-pickup-state'), 'broadcast');
    assert.match(await kiosk.locator('#pickup-pair-status').innerText(), /Listening for/);
    await phone.locator('#phone-tone').click();
  }
  await kiosk.waitForFunction(
    () => document.getElementById('light-send-panel').dataset.pickupState === 'ready',
    null,
    { timeout: 14000 },
  );
  const after = await kiosk.locator('.pickup-target').boundingBox();
  assert.deepEqual(after, before);
  await phone.locator('#save-link').waitFor({ timeout: 100000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  const bytes = await phone.evaluate(() => window.qaAudio.received);
  const statuses = await kiosk.evaluate(() => window.statusLog);
  assert(statuses.some(message => message.startsWith('Phone tone received.')));
  if (retryTone) assert.equal(await phone.evaluate(() => navigator.audioSession.type), 'auto');
  if (direct && !breakRTC && !dropRTC && !loseAnswer) {
    assert(bytes >= original.size, 'Direct channel should deliver the original.');
    assert(statuses.includes('Phone reply received. Connecting directly…'));
    assert(statuses.includes('Sending the photo directly.'));
  }
  if (breakRTC)
    assert(
      await kiosk.evaluate(() => window.testNetworkBlocked),
      'The camera must keep working after an actual answer is rejected.',
    );
  if (dropRTC)
    assert(
      (await phone.evaluate(() => window.testChannelLost)) && bytes > 0 && bytes < original.size,
      'Expected partial direct transfer and complete optical pickup.',
    );
  if (brio) assert.deepEqual(await kiosk.evaluate(() => window.requestedInputs), retryTone ? ['desk', 'desk', 'webcam'] : ['desk', 'webcam']);
  if (loseAnswer) assert((await phone.evaluate(() => window.testAnswerLost)) && bytes === 0);
  assert.deepEqual(await phone.evaluate(savedPhoto), original);
  assert.equal(await phone.evaluate(() => window.camCalls), 1);
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await phone.evaluate(() => window.qaAudio.mic), 0);
  assert.equal(await phone.evaluate(() => window.phoneTrack.readyState), 'ended');
  await kiosk.locator('#reset-button').click();
  await kiosk.waitForFunction(
    () =>
      window.qaAudio.inputs.every((t) => t.readyState === 'ended') &&
      window.qaAudio.contexts.every((c) => c.state === 'closed'),
  );
  await phone.waitForFunction(() => window.qaAudio.contexts.every((c) => c.state === 'closed'));
  assert.deepEqual(faults, []);
  console.log(
    'PASS',
    url,
    'Bytes:',
    original.size,
    'direct bytes:',
    bytes,
    'blocked RTC:',
    breakRTC,
    'lost channel:',
    dropRTC,
    'Brio selection:',
    brio,
    'camera grant to display:',
    seconds,
    's. Manual tone retry:', retryTone, 'No phone microphone. Resources released.',
  );
} finally {
  await browser.close();
  if (!live) {
    server.closeAllConnections();
    server.close();
  }
}
