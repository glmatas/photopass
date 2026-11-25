import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
const root = path.resolve(import.meta.dirname, '..');
const server = createServer(async (req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
  try {
    const bytes = await readFile(file);
    res
      .writeHead(200, {
        'content-type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.wasm': 'application/wasm',
            '.json': 'application/json',
          }[path.extname(file)] || 'application/octet-stream',
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = process.argv.includes('--live')
  ? 'https://glmatas.github.io/photopass/'
  : 'http://127.0.0.1:' + server.address().port + '/index.html';
try {
  for (const [name, engine, opts] of [
    [
      'Chrome',
      chromium,
      {
        channel: 'chrome',
        args: [
          '--mute-audio',
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          '--autoplay-policy=document-user-activation-required',
        ],
      },
    ],
    [
      'Firefox',
      firefox,
      {
        firefoxUserPrefs: {
          'media.navigator.streams.fake': true,
          'media.navigator.permission.disabled': true,
          'media.autoplay.default': 1,
          'media.autoplay.block-webaudio': true,
        },
      },
    ],
    ['WebKit', webkit, {}],
  ]) {
    const browser = await engine.launch({ headless: true, ...opts });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        window.probe = { mic: 0, video: 0, played: 0, noGesture: false };
        const g = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
        if (g)
          navigator.mediaDevices.getUserMedia = (c) => {
            if (c.audio) window.probe.mic++;
            if (c.video) window.probe.video++;
            return g(c);
          };
        if (window.AudioBufferSourceNode) {
          const play = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function (...args) {
            window.probe.played++;
            window.probe.noGesture = !navigator.userActivation?.hasBeenActive;
            return play.apply(this, args);
          };
        }
      });
      await page.goto(base + '?compat=10#LAAAAAAAAAAAAAAAA.AAAAAAAA');
      await page.waitForTimeout(8500);
      const record = await page.evaluate(() => ({
        supported: !!navigator.mediaDevices?.getUserMedia,
        ...window.probe,
        status: document.querySelector('#light-label').textContent,
        retry: !document.querySelector('#light-start').hidden,
        sound: !document.querySelector('#light-sound-help').hidden,
      }));
      console.log(name, browser.version(), record);
      assert.equal(record.mic, 0);
      if (!record.supported) assert(record.retry && record.sound);
      else assert(record.video > 0);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  server.close();
}
