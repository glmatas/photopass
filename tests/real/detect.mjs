// Step A: snapshot the BRIO and find which monitor it sees.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startServer, listMonitors, launch, placeWindow, blankPage, snapDir } from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function detect({ save = true } = {}) {
  await mkdir(snapDir, { recursive: true });
  const monitors = listMonitors();
  console.log('Monitors', JSON.stringify(monitors));
  const srv = await startServer();
  const { browser, cdp } = await launch();
  const context = await browser.newContext({ viewport: null });
  try {
    const cam = await blankPage(context, srv.url, '<!doctype html><body style="margin:0;background:#222"><video id=v muted playsinline autoplay></video><canvas id=c></canvas>');
    const info = await cam.evaluate(async () => {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      probe.getTracks().forEach(t => t.stop());
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const brio = devs.find(d => /brio/i.test(d.label));
      if (!brio) return { error: 'no BRIO', devices: devs.map(d => d.label) };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: brio.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
      const v = document.getElementById('v');
      v.srcObject = stream; await v.play();
      const track = stream.getVideoTracks()[0];
      return { label: brio.label, settings: track.getSettings(), capabilities: track.getCapabilities(), devices: devs.map(d => d.label) };
    });
    if (info.error) throw Error(JSON.stringify(info));
    console.log('Camera', info.label, JSON.stringify(info.settings));
    const grab = () => cam.evaluate(async () => {
      const v = document.getElementById('v'), c = document.getElementById('c');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      await new Promise(r => v.requestVideoFrameCallback(r));
      x.drawImage(v, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let sum = 0; for (let i = 0; i < d.length; i += 16) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return { mean: sum / (d.length / 16), png: c.toDataURL('image/png').split(',')[1], w: c.width, h: c.height };
    });
    await sleep(1500);
    const ambient = await grab();
    // Lock exposure so auto-exposure cannot hide or fake the white/black change.
    await cam.evaluate(() => document.getElementById('v').srcObject.getVideoTracks()[0].applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: 100, whiteBalanceMode: 'manual', colorTemperature: 5500 }] }).catch(e => console.log(e.message)));
    await sleep(1000);
    if (save) {
      await writeFile(path.join(snapDir, 'camera-view.png'), Buffer.from(ambient.png, 'base64'));
      await writeFile(path.join(snapDir, 'camera-info.json'), JSON.stringify({ label: info.label, devices: info.devices, frame: [ambient.w, ambient.h], settings: info.settings, capabilities: info.capabilities }, null, 2));
    }
    const results = [];
    for (const monitor of monitors) {
      const page = await blankPage(context, srv.url, '<!doctype html><body style="margin:0;background:#000;cursor:none"><div id=f style="position:fixed;inset:0;background:#000"></div>');
      await placeWindow(cdp, page, monitor, true);
      await sleep(2500);
      const screenInfo = await page.evaluate(() => ({ w: screen.width, h: screen.height, dpr: devicePixelRatio, x: screenX, y: screenY, iw: innerWidth, ih: innerHeight }));
      const shoot = async color => { await page.evaluate(c => { document.getElementById('f').style.background = c; }, color); await sleep(2200); return grab(); };
      const black = await shoot('#000'), white = await shoot('#fff'), black2 = await shoot('#000');
      const diff = await cam.evaluate(async ({ white, black }) => { const load = async b64 => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; }; const [w, b] = [await load(white), await load(black)]; const W = Math.round(Math.sqrt(w.length / 4 * 16 / 9)); let n = 0, left = 0; for (let i = 0; i < w.length; i += 4) if ((w[i] + w[i+1] + w[i+2]) - (b[i] + b[i+1] + b[i+2]) > 150) { n++; if (((i / 4) % 1920) < 3) left++; } return 100 * n / (w.length / 4) * (left > 50 ? 0.25 : 1); }, { white: white.png, black: black.png });
      results.push({ monitor: monitor.name, bounds: monitor, window: screenInfo, black: black.mean, white: white.mean, diff, whitePng: white.png, blackPng: black.png });
      await writeFile(path.join(snapDir, 'probe-' + monitor.name.replace(/[^A-Za-z0-9]/g, '') + '-white.png'), Buffer.from(white.png, 'base64'));
      console.log(monitor.name, JSON.stringify(screenInfo), 'black', black.mean.toFixed(1), 'white', white.mean.toFixed(1), 'changed%', diff.toFixed(2));
      await page.close();
    }
    const forced = process.argv.find(a => a.startsWith('--monitor='))?.slice(10);
    const best = forced ? results.find(r => r.monitor.endsWith(forced)) : results.reduce((a, b) => (b.diff > a.diff ? b : a));
    const out = { chosen: best.diff > 1 ? best.monitor : null, results: results.map(({ whitePng, blackPng, ...r }) => r) };
    if (best.diff > 1) {
      // Bounding box of pixels that brightened a lot between black and white fields.
      out.cameraBox = await cam.evaluate(async ({ white, black }) => {
        const load = async b64 => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, c.width, c.height); };
        const [w, b] = [await load(white), await load(black)];
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) {
          const i = (y * w.width + x) * 4;
          const lw = 0.2126 * w.data[i] + 0.7152 * w.data[i + 1] + 0.0722 * w.data[i + 2], lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
          if (lw - lb > 60) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: n, frame: [w.width, w.height] };
      }, { white: best.whitePng, black: best.blackPng });
      if (save) {
        await writeFile(path.join(snapDir, 'camera-white.png'), Buffer.from(best.whitePng, 'base64'));
        await writeFile(path.join(snapDir, 'camera-black.png'), Buffer.from(best.blackPng, 'base64'));
        await writeFile(path.join(snapDir, 'monitor.json'), JSON.stringify({ monitor: monitors.find(m => m.name === best.monitor), diff: best.diff, cameraBox: out.cameraBox, window: best.window }, null, 2));
      }
    }
    if (save) await writeFile(path.join(snapDir, 'detect.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
    return out;
  } finally {
    // Windows keeps the manual exposure/WB lock after the session ends: put auto back.
    for (const p of context.pages()) await p.evaluate(() => document.getElementById('v')?.srcObject?.getVideoTracks()[0].applyConstraints({ advanced: [{ exposureMode: 'continuous', whiteBalanceMode: 'continuous' }] })).catch(() => {});
    await browser.close();
    srv.close();
  }
}

if (import.meta.url === 'file:///' + process.argv[1].replaceAll('\\', '/')) await detect();
