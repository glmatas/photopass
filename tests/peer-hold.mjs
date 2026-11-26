// Checks the phone's held-candidate pairing in one headless browser: with the
// kiosk's candidates held, the phone sends no checks of its own, and the photo
// still arrives once the kiosk applies the reply, even many seconds later. Also
// checks the diagnosis code's "held" marker and private /24 prefixes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  // A blank page: the test loads only peer.js, never the app or a camera.
  if (pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>peer</title>');
  const target = path.resolve(root, pathname.slice(1));
  if (!target.startsWith(root + path.sep) || !target.endsWith('.js')) return res.writeHead(404).end();
  try {
    const bytes = await readFile(target);
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  // Raw host addresses instead of mDNS names, so the /24 prefixes show.
  args: ['--mute-audio', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  for (const [acceptAfter, releaseFirst] of [[6000, false], [1000, true]]) {
    const result = await page.evaluate(async ([acceptAfter, releaseFirst]) => {
      const { PhotoPeer } = await import('/peer.js');
      const photo = new File([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), new Uint8Array(199996).map((_, i) => (i * 7919) & 255)], 'qa.jpg', { type: 'image/jpeg' });
      let got, sent, failure;
      const arrived = new Promise(resolve => { got = resolve; });
      const kiosk = new PhotoPeer({ onSent() { sent = true; }, onFailure(m, p, d) { failure = 'kiosk ' + m + ' ' + d; } });
      const phone = new PhotoPeer({ onPhoto: (blob) => got(blob.size), onFailure(m, p, d) { failure = 'phone ' + m + ' ' + d; } });
      const offer = await kiosk.offer(photo, { quickGather: true });
      const reply = await phone.answer(offer, { quickGather: true, holdCandidates: true });
      const heldCode = phone.describe();
      const remoteHasCandidates = /^a=candidate:/m.test(phone.session.pc.remoteDescription.sdp);
      const kioskCode = kiosk.describe();
      await new Promise(resolve => setTimeout(resolve, acceptAfter));
      if (releaseFirst) await phone.releaseCandidates();
      const releasedCode = phone.describe();
      const t = performance.now();
      await kiosk.accept(reply);
      const size = await Promise.race([arrived, new Promise(resolve => setTimeout(() => resolve(0), 15000))]);
      const ms = Math.round(performance.now() - t);
      kiosk.close(); phone.close();
      return { size, ms, sent, failure, heldCode, remoteHasCandidates, releasedCode, kioskCode, offerHasCandidates: /^a=candidate:/m.test(offer.sdp) };
    }, [acceptAfter, releaseFirst]);
    console.log(JSON.stringify(result));
    assert.equal(result.failure, undefined);
    assert.equal(result.size, 200000, 'The photo must arrive after the kiosk applies the reply.');
    assert(result.offerHasCandidates, 'The kiosk offer carries candidates.');
    assert(!result.remoteHasCandidates, 'The phone holds the offer candidates.');
    assert.match(result.heldCode, /remote (?:[a-z0-9]+=\d+ ?)+(?: \([^)]*\))? held$/);
    if (releaseFirst) assert.doesNotMatch(result.releasedCode, /held$/);
    if (/ h4=/.test(result.kioskCode.split(', remote')[0])) {
      assert.match(result.kioskCode, /local [^,]*\((?:\d+\.\d+\.\d+\.x ?)+\)/, 'Private IPv4 hosts show their /24 prefix.');
    }
  }
  console.log('PASS held-candidate pairing.');
} finally {
  await browser.close();
  server.close();
}
