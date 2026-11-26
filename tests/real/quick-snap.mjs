// Quick BRIO stills: node quick-snap.mjs <name> [manualExposureTime]
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, blankPage, snapDir } from './lib.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = await startServer();
const { browser } = await launch();
const context = await browser.newContext({ viewport: null });
try {
  const cam = await blankPage(context, srv.url, '<!doctype html><body><video id=v muted autoplay></video><canvas id=c></canvas>');
  await cam.evaluate(async () => {
    const p = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); p.getTracks().forEach(t => t.stop());
    const b = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'videoinput' && /brio/i.test(d.label));
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: b.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    document.getElementById('v').srcObject = s; await document.getElementById('v').play();
  });
  for (let i = 0; i < 3; i++) {
    await sleep(3000);
    const png = await cam.evaluate(async () => { const v = document.getElementById('v'), c = document.getElementById('c'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png').split(',')[1]; });
    await writeFile(path.join(snapDir, `snap-${process.argv[2] || 'x'}-${i}.png`), Buffer.from(png, 'base64'));
  }
} finally { await browser.close(); srv.close(); }
