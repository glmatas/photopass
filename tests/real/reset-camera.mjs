// Restore BRIO auto exposure / auto white balance (Windows keeps manual locks across sessions).
import { startServer, launch, blankPage } from './lib.mjs';
const srv = await startServer(); const { browser } = await launch();
const ctx = await browser.newContext({ viewport: null });
try {
  const p = await blankPage(ctx, srv.url, '<body><video id=v muted autoplay></video>');
  const r = await p.evaluate(async () => {
    const t0 = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); t0.getTracks().forEach(t => t.stop());
    const b = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'videoinput' && /brio/i.test(d.label));
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: b.deviceId }, width: 1920, height: 1080 } });
    const tr = s.getVideoTracks()[0]; const before = tr.getSettings();
    await tr.applyConstraints({ advanced: [{ exposureMode: 'continuous', whiteBalanceMode: 'continuous', focusMode: 'continuous' }] });
    await new Promise(r => setTimeout(r, 1500));
    const after = tr.getSettings(); tr.stop();
    return { before: [before.exposureMode, before.whiteBalanceMode, before.exposureTime], after: [after.exposureMode, after.whiteBalanceMode, after.exposureTime] };
  });
  console.log(JSON.stringify(r));
} finally { await browser.close(); srv.close(); }
