// Shared helpers for the real-hardware optical harness (BRIO camera <-> physical monitor).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

export const root = path.resolve(import.meta.dirname, '..', '..');
export const snapDir = path.join(import.meta.dirname, 'snapshots');
export const resultDir = path.join(import.meta.dirname, 'results');
const route = '/photopass/';
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };

export async function startServer() {
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET' || !pathname.startsWith(route)) return response.writeHead(404).end();
    const file = path.resolve(root, decodeURIComponent(pathname.slice(route.length)) || 'index.html');
    if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + route;
  return { server, url, close() { server.closeAllConnections(); server.close(); } };
}

export function listMonitors() {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'refresh.ps1')], { encoding: 'utf8' }).trim();
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function launch() {
  const browser = await chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--use-fake-ui-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check']
  });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

// Move a page's OS window onto a monitor (CDP bounds), then optionally fullscreen it.
export async function placeWindow(cdp, page, monitor, fullscreen = true) {
  const target = await page.context().newCDPSession(page);
  const { targetInfo } = await target.send('Target.getTargetInfo');
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
  await target.detach().catch(() => {});
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: monitor.x + 60, top: monitor.y + 60, width: 800, height: 600 } });
  await new Promise(r => setTimeout(r, 250));
  if (fullscreen) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  return windowId;
}

// Serve a tiny synthetic page at the app origin (secure context, no file needed).
export async function blankPage(context, url, html = '<!doctype html><body style="margin:0;background:#000">') {
  const page = await context.newPage();
  await page.route(url + '__blank', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url + '__blank');
  return page;
}

// Runs in a page: force audio:false, target the BRIO, keep the app's other video constraints.
export function installBrioWrapper() {
  const media = navigator.mediaDevices;
  if (!media || media.__brioWrapped) return;
  const original = media.getUserMedia.bind(media);
  media.__brioWrapped = true;
  window.AudioContext = window.webkitAudioContext = undefined;
  window.__gum = [];
  let brio;
  async function brioId() {
    if (brio) return brio;
    // Permission is auto-granted (fake UI flag); a throwaway video-only stream unlocks labels.
    const probe = await original({ audio: false, video: true });
    probe.getTracks().forEach(t => t.stop());
    const devices = await media.enumerateDevices();
    const found = devices.find(d => d.kind === 'videoinput' && /brio/i.test(d.label));
    if (!found) throw new DOMException('Logitech BRIO not found: ' + devices.filter(d => d.kind === 'videoinput').map(d => d.label).join(', '), 'NotFoundError');
    return (brio = found.deviceId);
  }
  Object.defineProperty(media, 'getUserMedia', { configurable: true, value: async constraints => {
    const video = constraints?.video;
    if (!video) throw new DOMException('Audio-only capture is disabled in this harness', 'NotAllowedError');
    const deviceId = await brioId();
    const base = video === true ? {} : { ...video };
    delete base.facingMode;
    window.__gum.push(JSON.stringify(constraints));
    return original({ audio: false, video: { ...base, deviceId: { exact: deviceId } } });
  } });
}
