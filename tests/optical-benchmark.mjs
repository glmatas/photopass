import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox } from 'playwright';
import { choosePhoto, savedPhoto } from './photo-qa-fixture.mjs';

// Two independent kiosk/phone page pairs. Their only simulated physical link
// is a camera aimed at the kiosk's visible code. --quick uses a smaller file.
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const fixtureBytes = args.has('--quick') ? 75_000 : args.has('--field-size') ? 2_300_000 : 10_000_000;
const route = '/photopass/';
const root = path.resolve(import.meta.dirname, '..');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };
const traffic = [];
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (request.method !== 'GET' || !pathname.startsWith(route)) return response.writeHead(404).end();
  const file = path.resolve(root, decodeURIComponent(pathname.slice(route.length)) || 'index.html');
  if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(content);
  } catch { response.writeHead(404).end(); }
});
if (!live) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = live ? 'https://glmatas.github.io/photopass/' : 'http://127.0.0.1:' + server.address().port + route;
const pages = [];
let browser;

function installCameraHarness({ emulateDisplays, gray, footprint, impaired }) {
  if (!navigator.mediaDevices) return;
  // Exercise the automatic visual fallback without using any physical audio hardware.
  window.AudioContext = window.webkitAudioContext = undefined;
  const qa = window.qa = { cameraCalls: 0, rtcCalls: 0, frames: 0, source: 'other', rendered: 0, readings: 0, recognized: 0 };
  // Several independently visible headless pages share one Chromium display.
  // Its compositor can throttle a kiosk to 1–2 rAF/s when a phone popup opens.
  // Model a foreground 60 Hz kiosk display; production still selects and
  // renders every optical frame and controls its own symbol rate.
  if (emulateDisplays) {
    window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 1000 / 60);
    window.cancelAnimationFrame = clearTimeout;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return setTimeout(() => callback(performance.now(), { mediaTime: this.currentTime }), 1000 / 30);
    };
    HTMLVideoElement.prototype.cancelVideoFrameCallback = timer => clearTimeout(timer);
  }
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    if (this.canvas.id === 'light-stream') qa.rendered++;
    return draw.apply(this, args);
  };
  window.Worker = new Proxy(window.Worker, {
    construct(target, args) {
      const worker = new target(...args);
      const color = String(args[0]).includes('color-reader.js');
      worker.addEventListener('message', ({ data }) => {
        if (color && data.id >= 0) { qa.colorReads = (qa.colorReads || 0) + 1; if (data.bytes) qa.colorHits = (qa.colorHits || 0) + 1; }
        if (data.id >= 0) { qa.readings++; if (data.bytes) qa.recognized++; }
      });
      return worker;
    }
  });
  if (window.RTCPeerConnection) {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct() { qa.rtcCalls++; throw Error('Optical flow attempted WebRTC'); }
    });
  }
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async constraints => {
      qa.cameraCalls++;
      if (!location.hash.startsWith('#L')) throw new DOMException('Tests import a file at the kiosk', 'NotAllowedError');
      qa.constraints = constraints;
      // Every receiver is a top-level page with its own application state. The
      // synthetic camera references these windows only to capture their screens.
      const booth = window.opener;
      const cameras = {
        main: booth.document.getElementById('light-stream'),
        other: booth.otherBooth.document.getElementById('light-stream')
      };
      const camera = document.createElement('canvas');
      const context = camera.getContext('2d', { alpha: false });
      const sourceSize = footprint || 740;
      camera.width = camera.height = sourceSize + 32;
      context.fillStyle = '#eee';
      context.fillRect(0, 0, camera.width, camera.height);
      context.imageSmoothingEnabled = false;
      let ticks = 0;
      function paint() {
        if (gray) context.filter = 'grayscale(100%)';
        const canvas = cameras[qa.source];
        const source = canvas.hidden ? canvas.ownerDocument.getElementById('light-join') : canvas;
        if (impaired && ++ticks % 5 === 2) return;
        const side = footprint || Math.min(sourceSize, source.width);
        if (footprint) context.imageSmoothingEnabled = true;
        if (impaired) context.filter = 'contrast(76%) saturate(72%) blur(0.4px)';
        context.drawImage(source, Math.floor((camera.width - side) / 2), Math.floor((camera.height - side) / 2), side, side);
        qa.frames++;
      }
      paint();
      const stream = camera.captureStream(30);
      const timer = setInterval(() => {
        if (stream.getTracks().every(track => track.readyState === 'ended')) clearInterval(timer);
        else paint();
      }, 29);
      return stream;
    }
  });
}

async function openChild(booth, reference, destination) {
  const ready = booth.waitForEvent('popup');
  await booth.evaluate(({ reference, destination }) => {
    window[reference] = window.open(destination, '_blank');
  }, { reference, destination });
  const child = await ready;
  pages.push(child);
  return child;
}

async function opticallyReadJoin(page) {
  await page.locator('#light-send-panel').waitFor({ timeout: 60000 });
  const link = await page.evaluate(async () => {
    const { decodeQR } = await import('./vendor/qr-codecs.js');
    const canvas = document.getElementById('light-join');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return decodeQR(data.data, data.width, data.height)?.data;
  });
  const target = new URL(link);
  assert.equal(target.origin + target.pathname, url);
  assert.match(target.hash, /^#L[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8}$/);
  return link;
}

async function waitForPhoto(page, label, deadlineMs) {
  const started = Date.now();
  let logAt = started + 30000;
  while (Date.now() - started < deadlineMs) {
    assert.deepEqual(errors, [], label + ': browser exception');
    const state = await page.evaluate(() => ({
      done: !document.getElementById('done-panel').hidden,
      error: !document.getElementById('error-panel').hidden && document.getElementById('error-message').textContent,
      status: document.getElementById('light-label').textContent,
      retry: !document.getElementById('light-start').hidden,
      frames: window.qa.frames,
      rendered: window.opener?.qa?.rendered,
      readings: window.qa.readings,
      recognized: window.qa.recognized
    }));
    assert(!state.error, label + ': ' + state.error);
    if (state.done) return;
    if (state.retry && Date.now() - started > 3000) throw Error(label + ': reader requested retry: ' + state.status);
    if (Date.now() >= logAt) {
      console.log(label + ': ' + state.status + ' (' + Math.round((Date.now() - started) / 1000) + 's; ' +
        state.rendered + ' sent, ' + state.readings + ' worker reads, ' + state.recognized + ' recognized)');
      logAt = Date.now() + 30000;
    }
    await delay(250);
  }
  throw Error(label + ': timed out waiting for the optical transfer.');
}

const errors = [];
try {
  const engine = args.has('--firefox') ? firefox : chromium;
  browser = await engine.launch(engine === chromium ? {
    channel: 'chrome', headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required']
  } : {headless:true});
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(installCameraHarness, { emulateDisplays: !args.has('--native-scheduling'), gray:args.has('--gray'), footprint:args.has('--fixed') ? 532 : 0, impaired:args.has('--impaired') });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  context.on('request', request => {
    if (/^https?:/.test(request.url())) traffic.push([request.method(), request.url()]);
  });
  const main = await context.newPage();
  pages.push(main);
  await main.goto(args.has('--fast-entry') ? url + '?fast' : url);
  const other = await openChild(main, 'otherBooth', url);
  await Promise.all([main, other].map(page => page.waitForFunction(() => window.qa?.cameraCalls > 0)));
  const source = await main.evaluate(choosePhoto, { index: 0, size: fixtureBytes, textured: args.has('--textured') });
  const otherSource = await other.evaluate(choosePhoto, { index: 1, size: 25_000 });
  assert.notEqual(source.hash, otherSource.hash);
  const captureCalls = await Promise.all([main, other].map(page => page.evaluate(() => window.qa.cameraCalls)));
  await Promise.all([main, other].map(page => page.locator('#start-button').click()));
  const [join, otherJoin] = await Promise.all([main, other].map(opticallyReadJoin));
  assert.equal(await main.locator('#light-mode').inputValue(), 'fast');
  assert.equal(await main.locator('#light-options').evaluate(el => el.open), false);
  if (args.has('--color') || args.has('--mono')) {
    await main.locator('#light-options summary').click();
    await main.locator('#light-mode').selectOption(args.has('--color') ? 'color' : 'mono');
  }
  assert.notEqual(join, otherJoin);
  console.log('Two kiosk pages produced distinct short pickup QRs on the default route.');

  const phone = await openChild(main, 'firstPhone', join);
  const otherPhone = await openChild(main, 'otherPhone', otherJoin);
  for (const page of [phone, otherPhone]) await page.locator('#light-receive-panel').waitFor();
  // Both phones initially see exactly the same active kiosk's moving frames.
  await waitForPhoto(otherPhone, 'Cross-kiosk control', 120000);
  assert.deepEqual(await otherPhone.evaluate(savedPhoto), otherSource);
  assert(await phone.locator('#light-receive-panel').isVisible());
  const mismatch = await phone.evaluate(() => ({ fraction: document.getElementById('light-progress').value, frames: window.qa.frames }));
  assert.equal(mismatch.fraction, 0);
  assert(mismatch.frames > 10);
  console.log('The second phone saved its correct photo. The first phone ignored those blocks.');
  await other.locator('#reset-button').click();

  const started = Date.now();
  const cameraStarted = await phone.evaluate(() => window.qa.cameraCalls);
  await phone.evaluate(() => { window.qa.source = 'main'; });
  if (args.has('--switch')) {
    await phone.waitForFunction(() => document.getElementById('light-progress').value >= 12);
    if (!await main.locator('#light-options').evaluate(el => el.open)) await main.locator('#light-options summary').click();
    await main.locator('#light-mode').selectOption('mono');
    assert.equal(await phone.locator('#light-receive-panel').isVisible(), true);
  }
  await waitForPhoto(phone, 'Photo pickup', fixtureBytes > 1000000 ? 3600000 : 120000);
  assert.equal(await phone.evaluate(() => window.qa.cameraCalls), cameraStarted);
  assert.deepEqual(await phone.evaluate(savedPhoto), source);
  if (fixtureBytes >= 2_000_000) assert.match(await phone.locator('#done-description').textContent(), /Received in [\d.]+ s \(\d+ KB\/s\)/);
  if (args.has('--color') || args.has('--fast')) {
    const counts = await phone.evaluate(() => [window.qa.colorReads || 0, window.qa.colorHits || 0]);
    console.log('Color worker reads / decoded packets', counts);
    assert(counts[0] > 0);
    assert(args.has('--gray') ? counts[1] === 0 : counts[1] > 0);
  }
  const downloadEvent = phone.waitForEvent('download');
  await phone.locator('#save-link').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), source.name);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of await download.createReadStream()) { hash.update(chunk); size += chunk.length; }
  assert.equal(size, source.size);
  assert.equal(Array.from(hash.digest()).join(','), source.hash);
  for (const page of pages) assert.equal(await page.evaluate(() => window.qa.rtcCalls), 0);
  assert.equal(await main.evaluate(() => window.qa.cameraCalls), captureCalls[0]);
  for (const page of [phone, otherPhone]) {
    assert.equal(await page.evaluate(() => document.getElementById('pairing-panel').hidden), true);
    const rear = await page.evaluate(() => window.qa.constraints.video?.facingMode);
    assert(rear === 'environment' || rear?.ideal === 'environment' || rear?.exact === 'environment', 'Receiver must request the rear camera.');
  }
  assert.deepEqual(errors, []);
  assert(traffic.every(([method, requestUrl]) => method === 'GET' && !requestUrl.includes('#')), 'Unexpected writes or URL fragments reached HTTP');
  console.log(size.toLocaleString('en-US') + ' exact JPEG bytes saved via animated camera frames in ' +
    ((Date.now() - started) / 1000).toFixed(2) + 's. Mode flags ' + [...args].join(' ') + '. No WebRTC, return scan, or HTTP upload.');
} catch (error) {
  for (const page of pages) {
    const summary = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '(unavailable)');
    const camera = await page.evaluate(() => ({ frame: window.qa?.frames, calls: window.qa?.cameraCalls, source: window.qa?.source, opened: Boolean(window.opener), visibility: document.visibilityState })).catch(() => ({}));
    console.error(page.url().split('#')[0] + ': ' + JSON.stringify(camera) + ' ' + summary.slice(-550));
  }
  throw error;
} finally {
  await browser?.close();
  if (!live) { server.closeAllConnections(); server.close(); }
}
