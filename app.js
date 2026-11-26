import { PhotoPeer } from './peer.js?v=13';
import { makeSignalURL, makeAnswerText, readSignal, drawCode, startCamera } from './qr.js?v=4';
import { openCapture, takePhoto } from './camera.js';
import {pickupPacket, phonePairing, readyTone, replyTone, startPickupDisplay} from './pickup.js?v=18';
import {answerMessage, budget, codePairing, receivePickup, trimReply} from './pickup-direct.js?v=15';

const el = id => document.getElementById(id);
const panels = ['start', 'pairing', 'transfer', 'done', 'error', 'light-send', 'light-receive', 'sound-send', 'sound-receive'];
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
let page = 'start';
let role = 'kiosk';
let session = '';
let generation = 0;
let peer;
let camera;
let cameraPending = false;
let picked;
let previousPreview;
let receivedURL;
let receivedFile;
let capture;
let captureController;
let captureVersion = 0;
let selectedCameraId;
let selectedCameraGroup = '';
let capturedHere = false;
let receiverPage;
let lightSender;
let lightReceiver;
let lightController;
let lightId;
let pickupNonce;
let stopPickupDisplay;
let sound;
let retryMode;
let wakeLock;
let wakePending = false;
let pairing;
let phoneReply;
let phoneTimer;
// QR pairing is the default; ?square starts with the moving square instead.
const preferSquare = new URLSearchParams(location.search).has('square');

async function updateScreenLock() {
  const needsScreen = () => (page.startsWith('light-') || page === 'pairing' || (sound && page.startsWith('sound-'))) && document.visibilityState === 'visible';
  if (!needsScreen()) {
    const previous = wakeLock;
    wakeLock = undefined;
    if (previous) await previous.release().catch(() => {});
    return;
  }
  if (wakePending || wakeLock || !navigator.wakeLock) return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!needsScreen()) await lock.release();
    else {
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = undefined; });
    }
  } catch { /* Camera transfer still works while the visitor keeps the screen awake. */ }
  finally { wakePending = false; }
}

function show(name) {
  page = name;
  updateScreenLock();
  if (name !== 'pairing' && document.documentElement.classList.contains('qr-expanded')) setExpanded(false);
  if (name !== 'light-send' && document.documentElement.classList.contains('light-expanded')) expandLight(false);
  for (const panel of panels) el(panel + '-panel').hidden = name !== panel;
  el('reset-button').hidden = name === 'start' || name === 'light-receive';
  let resetLabel = 'Start over';
  if (role === 'phone') resetLabel = 'Close session';
  else if (name === 'done' || name === 'light-send' || name === 'sound-send') resetLabel = 'Next visitor';
  else if (name === 'pairing' && capturedHere) resetLabel = 'Retake photo';
  el('reset-button').textContent = resetLabel;
}

function stopScan() {
  camera?.();
  camera = undefined;
  el('scanner').hidden = true;
  el('pairing-panel').classList.remove('scanning');
}

function setExpanded(value) {
  document.documentElement.classList.toggle('qr-expanded', value);
  el('expand-qr').setAttribute('aria-pressed', String(value));
  el('expand-qr').textContent = value ? 'Close enlarged view' : 'Enlarge code';
}

function expandLight(value) {
  document.documentElement.classList.toggle('light-expanded', value);
  el('light-zoom').setAttribute('aria-pressed', String(value));
}

function stopLight() {
  stopPickupDisplay?.();
  stopPickupDisplay = undefined;
  lightSender?.stop();
  lightSender = undefined;
  lightController?.abort();
  lightController = undefined;
  lightReceiver?.();
  lightReceiver = undefined;
}

function stopSound() {
  const active = sound;
  if (!active) return;
  sound = undefined;
  active.controller.abort();
  active.release?.();
  if (active.context?.state !== 'closed') active.context?.close().catch(() => {});
}

function stopCapture() {
  captureVersion++;
  captureController?.abort();
  captureController = undefined;
  capture = undefined;
  el('capture-video').hidden = true;
  el('camera-picker').hidden = true;
  el('take-button').hidden = true;
  el('take-button').disabled = true;
}

function cameraMessage(error) {
  if (['NotAllowedError', 'SecurityError'].includes(error.name)) return 'Allow camera access in your browser’s site settings, then select Enable camera.';
  if (['NotReadableError', 'AbortError'].includes(error.name)) return 'The camera could not start. Close any other app using it, then try again.';
  if (['NotFoundError', 'OverconstrainedError'].includes(error.name)) return 'No camera was found. Connect a camera and select Enable camera, or choose an existing photo.';
  return 'Camera unavailable. You can enable it again or choose an existing photo.';
}

async function startCapture() {
  if (role !== 'kiosk' || page !== 'start') return;
  stopCapture();
  const version = captureVersion;
  captureController = new AbortController();
  el('camera-button').hidden = false;
  el('camera-button').disabled = true;
  el('camera-button').textContent = 'Opening camera…';
  el('retake-button').hidden = true;
  el('start-button').hidden = true;
  el('capture-status').textContent = 'Allow camera access to see your live preview.';
  try {
    const active = await openCapture(el('capture-video'), selectedCameraId, captureController.signal);
    if (version !== captureVersion) { active.stop(); return; }
    capture = active;
    selectedCameraId = active.deviceId;
    selectedCameraGroup = el('capture-video').srcObject?.getVideoTracks()[0]?.getSettings?.().groupId ||
      active.devices.find(d => d.deviceId === selectedCameraId)?.groupId || '';
    const select = el('camera-select');
    select.replaceChildren(...active.devices.map((device, index) => new Option(device.label || 'Camera ' + (index + 1), device.deviceId)));
    select.value = selectedCameraId || '';
    el('camera-picker').hidden = active.devices.length < 2;
    el('camera-button').hidden = true;
    el('capture-video').hidden = false;
    el('take-button').disabled = el('take-button').hidden = false;
    el('capture-status').textContent = '';
    el('capture-video').srcObject?.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (version !== captureVersion) return;
      stopCapture();
      el('camera-button').textContent = 'Enable camera';
      el('camera-button').hidden = el('camera-button').disabled = false;
      el('capture-status').textContent = 'Camera disconnected. Reconnect it or choose an existing photo.';
    }, { once: true });
  } catch (error) {
    if (version !== captureVersion) return;
    el('camera-button').hidden = el('camera-button').disabled = false;
    el('camera-button').textContent = 'Enable camera';
    el('capture-status').textContent = cameraMessage(error);
  }
}

function cleanUp() {
  generation++;
  stopPairing();
  stopPhoneReply();
  stopSound();
  stopLight();
  stopCapture();
  stopScan();
  peer?.close();
  peer = undefined;
  cameraPending = false;
  if (receivedURL) URL.revokeObjectURL(receivedURL);
  if (previousPreview) URL.revokeObjectURL(previousPreview);
  receivedURL = previousPreview = receivedFile = picked = undefined;
  capturedHere = false;
}

function reset(clearLocation = true) {
  cleanUp();
  const onPhone = role === 'phone';
  if (clearLocation) history.replaceState(null, '', location.pathname + location.search);
  session = '';
  el('file-input').value = '';
  el('preview').removeAttribute('src');
  el('preview').hidden = true;
  el('pair-photo').removeAttribute('src');
  el('pair-photo').hidden = true;
  el('received-image').removeAttribute('src');
  el('received-image').hidden = true;
  el('save-link').removeAttribute('href');
  el('pair-text').value = el('manual-input').value = '';
  el('manual-tools').open = false;
  el('start-button').disabled = true;
  el('start-button').hidden = el('retake-button').hidden = true;
  el('file-label').textContent = 'JPEG, PNG or WebP · Up to 32 MiB';
  el('scan-status').textContent = el('status').textContent = '';
  el('progress').value = 0;
  if (onPhone) {
    show('done');
    el('done-title').textContent = 'Session closed';
    el('done-description').textContent = 'You can close this tab or start another pickup at the kiosk.';
    el('save-link').hidden = el('share-button').hidden = el('reset-button').hidden = true;
  } else {
    show('start');
  }
}

function fail(message, title = 'Transfer interrupted') {
  stopPairing();
  stopPhoneReply();
  stopScan();
  stopLight();
  stopSound();
  peer?.close();
  peer = undefined;
  generation++;
  show('error');
  el('error-title').textContent = title;
  el('error-message').textContent = message;
  el('error-retry').hidden = role !== 'kiosk' || !picked;
  el('error-sound').hidden = role === 'kiosk' && (!picked || retryMode === 'sound');
  el('error-retry').textContent = retryMode === 'light' ? 'Show pickup code again' : 'Retry with this photo';
  el('status').textContent = '';
}

function working(title, label) {
  show('transfer');
  el('transfer-title').textContent = title;
  el('progress').removeAttribute('value');
  el('progress-label').textContent = label;
}

function done(blob, filename) {
  stopScan();
  show('done');
  el('status').textContent = '';
  const receiver = role === 'phone';
  el('done-title').textContent = receiver ? 'Your photo is ready' : 'Photo delivered';
  el('done-description').textContent = receiver
    ? 'Save the original to your phone before closing this tab.'
    : 'The phone received and verified the original file.';
  el('save-link').hidden = !receiver;
  el('share-button').hidden = true;
  if (!receiver) return;
  receivedURL = URL.createObjectURL(blob);
  receivedFile = new File([blob], filename, { type: blob.type });
  el('received-image').src = receivedURL;
  el('received-image').hidden = false;
  el('save-link').href = receivedURL;
  el('save-link').download = filename;
  el('share-button').hidden = !navigator.canShare?.({ files: [receivedFile] });
}

function createPeer() {
  const current = generation;
  return new PhotoPeer({
    onState(message) {
      if (current === generation && page !== 'done') el('status').textContent = message;
    },
    onProgress(fraction) {
      if (current !== generation) return;
      stopScan();
      stopPhoneReply();
      show('transfer');
      el('transfer-title').textContent = role === 'phone' ? 'Receiving your photo' : 'Sending the original';
      const percent = Math.floor(fraction * 100);
      el('progress').value = percent;
      el('progress-label').textContent = percent === 100 ? 'Verifying the file…' : percent + '% transferred';
    },
    onPhoto(blob, filename) { if (current === generation) done(blob, filename); },
    onSent() { if (current === generation) done(); },
    onFailure(message, stage) {
      if (current !== generation || page === 'done') return;
      if (role === 'phone' && lightId) {
        useCamera(stage === 'pairing' ? 'The direct connection failed. Using the camera instead.' : 'The direct connection dropped. Using the camera instead.');
        return;
      }
      const title = stage === 'pairing' ? 'The devices couldn’t connect' : 'Transfer interrupted';
      if (role === 'kiosk') retryMode = 'light';
      if (stage === 'pairing' && role === 'phone') message += ' Scan the screen-transfer pickup code on the kiosk to receive it by camera.';
      fail(message, title);
    }
  });
}

async function pair(text, receiver, current) {
  const qr = el('pair-qr');
  let qrAvailable = true;
  try {
    // The phone's reply uses the coarsest grid so a kiosk webcam reads it.
    await drawCode(qr, text, { level: receiver ? 'L' : 'M' });
  } catch {
    qrAvailable = false;
  }
  if (current !== generation || page !== 'transfer' || el('progress').hasAttribute('value')) return;
  qr.parentElement.hidden = !qrAvailable;
  el('manual-tools').open = !qrAvailable;
  el('pair-text').value = text;
  el('manual-input').hidden = el('manual-apply').hidden = receiver;
  el('manual-input').labels?.forEach(label => { label.hidden = receiver; });
  el('scan-status').textContent = el('pair-status').textContent = el('pair-listen').textContent = '';
  el('scanner').hidden = true;
  el('pair-square').hidden = receiver;
  el('pair-camera').hidden = !receiver || !lightId;
  el('pair-tone').hidden = el('pair-tone-status').hidden = true;
  el('pairing-panel').classList.toggle('phone-reply', receiver);
  el('pair-photo').hidden = receiver || !previousPreview;
  if (!el('pair-photo').hidden) el('pair-photo').src = previousPreview;
  el('pair-title').textContent = receiver ? 'Show this code to the kiosk' : 'Scan with your phone';
  el('pair-instructions').textContent = receiver
    ? 'Hold your screen up to the kiosk camera, about a hand’s length away, with the brightness up. Keep this page open.'
    : 'Open your phone’s camera and scan this code. Then hold your phone up to the kiosk camera.';
  if (!qrAvailable) {
    el('pair-title').textContent = 'Pair using text';
    el('pair-instructions').textContent = receiver
      ? 'These details exceed the size of one QR code. Copy the reply text to the kiosk to pair.'
      : 'These details exceed the size of one QR code. Open the pairing link on the phone, then return its reply to this kiosk.';
  }
  el('status').textContent = '';
  show('pairing');
  return qrAvailable;
}

function clearPicked() {
  picked = undefined;
  capturedHere = false;
  if (previousPreview) URL.revokeObjectURL(previousPreview);
  previousPreview = undefined;
  el('preview').removeAttribute('src');
  el('preview').hidden = true;
  el('start-button').disabled = el('start-button').hidden = true;
  el('retake-button').hidden = true;
}

function selectFile(file, fromCamera = false) {
  if (!file) return;
  if (!allowedTypes.has(file.type) || file.size === 0 || file.size > 32 * 1024 * 1024) {
    el('file-label').textContent = 'Choose a nonempty JPEG, PNG or WebP up to 32 MiB.';
    return;
  }
  clearPicked();
  stopCapture();
  capturedHere = fromCamera;
  picked = file;
  previousPreview = URL.createObjectURL(file);
  el('preview').src = previousPreview;
  el('preview').hidden = false;
  el('file-label').textContent = file.name + ' · ' + (file.size / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' MB';
  el('camera-button').hidden = true;
  el('capture-status').textContent = '';
  el('retake-button').hidden = false;
  el('retake-button').textContent = fromCamera ? 'Retake photo' : 'Use camera';
  el('start-button').hidden = el('start-button').disabled = false;
}

function stopPairing() {
  const active = pairing;
  if (!active) return;
  pairing = undefined;
  clearTimeout(active.timer);
  active.life.abort();
  stopScan();
}

function stopPhoneReply() {
  clearTimeout(phoneTimer);
  phoneTimer = undefined;
  phoneReply?.abort();
  phoneReply = undefined;
}

const newNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(6)))).replaceAll('+', '-').replaceAll('/', '_');
const nonceBytes = nonce => Uint8Array.from(atob(nonce.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const idBytes = id => Uint8Array.from(id.match(/../g), hex => parseInt(hex, 16));
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const toNonce = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');

const PAIR_FAILED = {
  reply: 'No reply from a phone yet. The moving square is running too, and the code still works.',
  slow: 'The phone’s reply has not connected yet. The moving square is running too.',
  network: 'Phone reply received, but the direct network connection failed. The moving square is running.',
  dropped: 'The direct connection dropped. The moving square is running.',
  start: 'Direct pairing could not start. The moving square is running.',
  expired: 'The pairing code expired. The moving square is running.',
  devices: 'The kiosk camera and microphone are unavailable. The moving square is running.',
  ready: 'The phone is using its camera. The moving square is running.',
  manual: '',
};

// Default kiosk pickup. A static QR carries the direct-connection offer and
// the screen-transfer id. The phone's reply returns as a QR to the kiosk
// camera or as a tone to its microphone, whichever comes first. Without a
// reply in time, the moving square joins the code, so pickup never depends on
// direct pairing.
async function beginPair() {
  if (!picked || role !== 'kiosk') return;
  stopLight();
  stopPairing();
  retryMode = 'light';
  const current = generation;
  working('Preparing the pickup code', 'Finding a direct connection…');
  let transfer;
  try {
    const { prepareLightSender } = await import('./light-sender.js?v=11');
    if (current !== generation) return;
    transfer = await prepareLightSender(picked, el('light-stream'), {
      onError(message) { if (current === generation && page === 'light-send') fail(String(message), 'Screen transfer stopped'); }
    });
  } catch (error) {
    if (current === generation) fail(error.message, 'Couldn’t prepare screen transfer');
    return;
  }
  if (current !== generation) { transfer.stop(); return; }
  lightSender = transfer;
  const nonce = newNonce();
  if (!window.isSecureContext || !window.RTCPeerConnection) { showSquare(transfer, nonce); return; }
  const token = pickupPacket(transfer.id, nonce);
  const active = { life: new AbortController(), transfer, nonce, token, phase: 1 };
  pairing = active;
  const note = message => {
    if (pairing !== active || !message) return;
    el(active.phase === 1 ? 'pair-status' : 'pickup-note').textContent = message;
  };
  active.attempt = codePairing(picked, token, active.life.signal, {
    onStatus: note,
    onReplied() {
      if (pairing !== active) return;
      stopScan();
      active.mic?.abort();
      el('scan-status').textContent = el('pair-listen').textContent = '';
      clearTimeout(active.timer);
      if (active.phase === 1) active.timer = setTimeout(() => squareFor(active, 'slow'), budget('slow'));
    },
    onProgress(fraction) {
      if (pairing !== active) return;
      clearTimeout(active.timer);
      if (active.phase !== 1) return;
      show('transfer');
      el('transfer-title').textContent = 'Sending the original';
      const percent = Math.floor(fraction * 100);
      el('progress').value = percent;
      el('progress-label').textContent = percent === 100 ? 'Verifying the file…' : percent + '% transferred';
    },
    onSent() {
      if (pairing !== active) return;
      stopPairing();
      stopLight();
      done();
    },
    onFailed(reason, code) {
      if (pairing !== active) return;
      const message = PAIR_FAILED[reason] + code;
      if (active.phase === 1) { squareFor(active, reason, message); return; }
      // The offer is spent: a late phone should open the plain pickup link.
      note(message);
      stopScan();
      active.retired = true;
      drawCode(el('light-join'), squareLink(transfer, nonce));
    },
  });
  try {
    const { description, round } = await active.attempt.start();
    if (pairing !== active) return;
    session = round;
    const pickup = Uint8Array.of(...idBytes(transfer.id), ...nonceBytes(nonce));
    active.link = await makeSignalURL(description, round, receiverPage, pickup);
    if (pairing !== active) return;
    if (!(await pair(active.link, false, current)) || pairing !== active) { squareFor(active, 'start'); return; }
  } catch {
    if (pairing === active) squareFor(active, 'start');
    return;
  }
  active.timer = setTimeout(() => squareFor(active, 'reply'), budget('reply'));
  listenForReply(active);
  scanCode(active);
}

function deviceDown(active, kind) {
  active[kind] = true;
  if (active.micDown && active.cameraDown && !active.attempt.accepted) squareFor(active, 'devices');
}

function listenForReply(active) {
  active.mic = new AbortController();
  const stop = () => active.mic.abort();
  active.life.signal.addEventListener('abort', stop, { once: true });
  el('pair-listen').textContent = 'Opening the kiosk microphone…';
  void readyTone(active.token, active.mic.signal, () => squareFor(active, 'ready'), {
    cameraGroup: selectedCameraGroup,
    onListening(label) {
      if (pairing === active && active.phase === 1) el('pair-listen').textContent = 'Listening for the phone’s tone' + (label ? ' on ' + label : '') + '.';
    },
    onUnavailable() {
      if (pairing !== active || active.phase !== 1) return;
      el('pair-listen').textContent = 'The kiosk microphone is unavailable. Show the phone’s code to the camera.';
      deviceDown(active, 'micDown');
    },
    onMessage: bytes => { void active.attempt.tone(bytes); },
  });
}

async function codeText(active, text) {
  if (!active || pairing !== active || active.attempt.accepted) return;
  let decoded;
  try {
    decoded = await readSignal(String(text).trim());
  } catch {
    if (pairing === active) el('scan-status').textContent = 'That is not a PhotoPass reply. Show the code from the phone that scanned this kiosk.';
    return;
  }
  if (pairing !== active) return;
  if (decoded.description.type !== 'answer' || decoded.session !== active.attempt.round) {
    el('scan-status').textContent = 'That reply belongs to an earlier code. Scan this kiosk’s code again with the phone.';
    return;
  }
  await active.attempt.code(decoded);
}

async function scanCode(active) {
  if (camera || cameraPending) return;
  cameraPending = true;
  el('scanner').hidden = false;
  el('scan-status').textContent = 'Opening the kiosk camera…';
  try {
    const release = await startCamera(el('scanner'), text => codeText(active, text), selectedCameraId);
    if (pairing !== active || active.attempt.accepted) release();
    else {
      camera = release;
      el('pairing-panel').classList.add('scanning');
      if (active.phase === 1) el('scan-status').textContent = 'Hold the phone’s code up to this camera.';
    }
  } catch {
    if (pairing === active) {
      el('scanner').hidden = true;
      el('scan-status').textContent = 'The kiosk camera is unavailable. The phone can still pair by its tone.';
      deviceDown(active, 'cameraDown');
    }
  } finally {
    cameraPending = false;
  }
}

// Add the moving square. The QR code stays on screen, and the kiosk keeps
// accepting the phone's reply by camera and microphone.
function squareFor(active, reason, message = PAIR_FAILED[reason]) {
  if (pairing !== active || active.phase !== 1) return;
  active.phase = 2;
  clearTimeout(active.timer);
  active.mic?.abort();
  showSquare(active.transfer, active.nonce, {
    link: active.retired ? undefined : active.link, confirmed: reason === 'ready', note: message,
    onMessage: bytes => { void active.attempt.tone(bytes); },
  });
}

function lightHash(id) {
  const bytes = id.match(/../g).map(hex => Number.parseInt(hex, 16));
  return '#L' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');
}

function parseLightHash(hash) {
  const match = /^#L([A-Za-z0-9_-]{16})(?:\.([A-Za-z0-9_-]{8}))?$/.exec(hash);
  if (!match) throw new Error('Scan the pickup code on the kiosk again.');
  pickupNonce = match[2];
  const bytes = atob(match[1].replaceAll('-', '+').replaceAll('_', '/'));
  return Array.from(bytes, byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

async function beginLight() {
  if (!picked || role !== 'kiosk') return;
  stopLight();
  retryMode = 'light';
  const current = generation;
  working('Preparing your photo', 'Making the pickup code…');
  try {
    const { prepareLightSender } = await import('./light-sender.js?v=11');
    if (current !== generation) return;
    const transfer = await prepareLightSender(picked, el('light-stream'), {
      onError(message) { if (current === generation && page === 'light-send') fail(String(message), 'Screen transfer stopped'); }
    });
    if (current !== generation) { transfer.stop(); return; }
    lightSender = transfer;
    showSquare(transfer, newNonce());
  } catch (error) {
    if (current === generation) fail(error.message, 'Couldn’t prepare screen transfer');
  }
}

// Show the moving square. link: the QR pairing code to keep showing for a
// late phone (it also carries this pickup); otherwise the plain pickup link.
function squareLink(transfer, nonce) {
  const url = new URL(receiverPage || location.href);
  url.search = '?14';
  url.hash = lightHash(transfer.id) + '.' + nonce;
  return url.href;
}

function showSquare(transfer, nonce, { link, confirmed = false, note = '', onMessage } = {}) {
  retryMode = 'light';
  drawCode(el('light-join'), link || squareLink(transfer, nonce));
  const size = picked.size < 1000000 ? Math.ceil(picked.size / 1000) + ' KB'
    : (picked.size / 1000000).toLocaleString(undefined, {maximumFractionDigits: 2}) + ' MB';
  el('light-size').textContent = capturedHere ? size : picked.name + ' · ' + size;
  el('light-options').open = false;
  el('light-direct').hidden = Boolean(link);
  el('light-mode').value = 'fast';
  transfer.setHighSpeed(true);
  el('light-mode-note').textContent = '';
  el('pickup-note').textContent = note;
  el('light-send-intro').textContent = link
    ? 'Scan the code with your phone. If it can’t pair directly, it uses its camera: keep the moving square in view until your photo appears.'
    : 'Scan the pickup code, open the link, and allow camera access. Keep the moving square in view until your photo appears.';
  el('status').textContent = '';
  show('light-send');
  stopPickupDisplay = startPickupDisplay(transfer, pickupPacket(transfer.id, nonce), (streaming, confirmed) => {
    el('light-send-panel').dataset.pickupState = streaming ? (confirmed ? 'ready' : 'broadcast') : 'join';
    const join = el('light-join');
    const slot = streaming ? el('late-join') : el('light-stream').parentElement;
    if (join.parentElement !== slot) slot.prepend(join);
    el('late-join').hidden = !streaming;
    el('light-stream').hidden = !streaming;
    el('pickup-state').textContent = streaming ? 'Keep your camera here' : 'Scan to open';
  }, {
    file:picked, cameraGroup:selectedCameraGroup, micRetry:el('pickup-mic-retry'),
    onPairStatus(message) { el('pickup-pair-status').textContent = message; },
    immediate: Boolean(link), confirmed, onMessage,
  });
}

function begin() {
  if (page !== 'start') return;
  return preferSquare ? beginLight() : beginPair();
}

async function readLight() {
  if (lightController || role !== 'phone' || page !== 'light-receive') return;
  const current = generation;
  lightController = new AbortController();
  const signal = lightController.signal;
  let hintTimer;
  let started;
  let previousProgress = 0;
  let directProgress = 0;
  let cameraFailure;
  let cameraReadyAt;
  const token = pickupNonce && pickupPacket(lightId, pickupNonce);
  const pair = token && phonePairing(token, signal, el('phone-pair-status'), el('phone-tone'));
  function finishPickup(blob, name, route) {
    if (signal.aborted) return;
    const seconds = (performance.now() - cameraReadyAt) / 1000;
    stopLight();
    done(blob, name);
    const timing = seconds >= 0.1
      ? ' in ' + seconds.toFixed(1) + ' s (' + Math.round(blob.size / (1000 * seconds)) + ' KB/s)' : '';
    el('done-description').textContent = 'Received' + timing + ' ' + route + '. Save the original before closing this tab.';
  }
  const onControl = token && receivePickup(token, lightId, signal, pair.play, (blob, name) => {
    finishPickup(blob, name, 'by direct connection');
  }, (fraction, reason, code) => {
    if (signal.aborted) return;
    if (!directProgress || !fraction) pair.direct(fraction > 0, reason, code);
    directProgress = fraction;
    if (!fraction && cameraFailure) { cameraError(cameraFailure); return; }
    if (fraction > previousProgress || fraction === 0) {
      const amount = Math.floor(100 * Math.max(fraction, previousProgress));
      el('light-progress').value = amount;
      el('light-label').textContent = amount + '% received · ' + (fraction ? 'Receiving directly.' : 'Keep the whole kiosk square in view.');
    }
  }, pair.offer);
  function cameraError(message) {
    if (signal.aborted) return;
    stopLight();
    el('light-label').textContent = String(message);
    el('light-start').hidden = false;
    el('light-sound-help').hidden = false;
  }
  const hintAfterPause = () => {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (!signal.aborted && !directProgress) el('light-label').textContent = previousProgress
        ? 'Hold steady with all four corners in view. If progress stays here, enlarge the square under Kiosk options.'
        : 'Looking for the photo. Move closer while keeping all four corners in view. For a blurry camera, select Larger squares under Kiosk options.';
    }, 10000);
  };
  signal.addEventListener('abort', () => clearTimeout(hintTimer), { once: true });
  el('light-start').hidden = true;
  el('light-sound-help').hidden = true;
  el('light-label').textContent = 'Allow the camera, then point it at the moving code.';
  try {
    const { startLightReceiver } = await import('./light-receiver.js?v=12');
    if (signal.aborted) return;
    const release = await startLightReceiver(el('light-video'), {
      id: lightId,
      onControl,
      onCameraReady() { cameraReadyAt = performance.now(); pair?.play(token); },
      signal,
      onProgress(fraction) {
        if (signal.aborted) return;
        if (fraction < previousProgress) started = undefined;
        if (fraction > 0 && !started) started = performance.now();
        previousProgress = fraction;
        if (directProgress > fraction) return;
        const percent = Math.min(100, Math.floor(fraction * 100));
        el('light-progress').value = percent;
        let hint = 'Keep the whole moving square in view.';
        const seconds = started ? (performance.now() - started) / 1000 : 0;
        if (seconds > 8 && fraction > 0 && fraction < 0.96) {
          const remaining = seconds * (1 - fraction) / fraction;
          hint = remaining >= 60 ? 'About ' + Math.ceil(remaining / 60) + ' min remaining.' : 'Less than a minute remaining.';
        }
        el('light-label').textContent = percent < 100 ? percent + '% received · ' + hint : 'Verifying the original photo…';
        hintAfterPause();
      },
      onPhoto(blob, name) { finishPickup(blob, name, 'by camera'); },
      onError(message) {
        if (directProgress > 0) cameraFailure = message;
        else cameraError(message);
      }
    });
    if (signal.aborted || page !== 'light-receive') release();
    else {
      lightReceiver = release;
      if (!previousProgress && !directProgress) el('light-label').textContent = 'Camera ready. Keep the whole kiosk square in view.';
      hintAfterPause();
    }
  } catch (error) {
    if (current !== generation || signal.aborted) return;
    cameraError(error.name === 'NotAllowedError' ? 'Allow camera access in your browser, then try again.' : error.message);
  }
}

function openLight() {
  role = 'phone';
  try { lightId = parseLightHash(location.hash); }
  catch (error) { fail(error.message, 'Incomplete pickup link'); return; }
  el('light-progress').value = 0;
  show('light-receive');
  readLight();
}

function openSoundListener(code = '') {
  role = 'phone';
  el('sound-pin').value = code;
  el('sound-pin').disabled = false;
  el('sound-listen').disabled = false;
  el('sound-receive-progress').value = 0;
  el('sound-received').textContent = '';
  el('sound-receive-status').textContent = code ? 'Kiosk code filled in. Tap Start listening.' : 'On the kiosk, open Kiosk options and select Camera-free pickup by sound to see the six digits.';
  show('sound-receive');
}

async function runSound(sending) {
  if (sound || (sending && !picked)) return;
  let code;
  if (sending) {
    stopLight();
    retryMode = 'sound';
    code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    el('sound-code').textContent = code.slice(0, 3) + ' ' + code.slice(3);
    const address = new URL(receiverPage || location.href);
    address.search = '?listen';
    address.hash = '';
    el('sound-address').href = address.href;
    el('sound-address').textContent = address.host + address.pathname + address.search;
    const qrOption = el('sound-qr');
    qrOption.open = false;
    address.search = '?s';
    address.hash = 'S' + code;
    try {
      drawCode(el('sound-join'), address.href);
      qrOption.hidden = false;
    } catch {
      qrOption.hidden = true;
    }
    // Approximate end-to-end rate observed in the software audio loopback.
    const minutes = Math.ceil(picked.size / (450 * 60));
    el('sound-time').textContent = minutes >= 2
      ? 'If the entire photo travels by sound, allow roughly ' + minutes + ' minutes for this file. Room noise can add time.'
      : 'The devices try a direct connection first. If that fails, the photo travels by sound.';
  } else {
    code = el('sound-pin').value.replace(/[ -]/g, '');
    if (!/^\d{6}$/.test(code)) {
      el('sound-receive-status').textContent = 'Enter all six digits from the kiosk.';
      el('sound-pin').focus();
      return;
    }
    el('sound-pin').disabled = el('sound-listen').disabled = true;
  }
  const side = sending ? 'sound-send' : 'sound-receive';
  const status = el(side + '-status');
  const meter = el(side + '-progress');
  if (sending) meter.removeAttribute('value');
  else {
    meter.value = 0;
    el('sound-received').textContent = '';
  }
  let firstProgress;
  const active = {controller:new AbortController()};
  sound = active;
  show(side);
  status.textContent = sending ? 'Opening sound. Allow the microphone for two-way pairing.' : 'Opening the microphone. Keep this phone near the kiosk speaker.';
  function failed(message) {
    if (sound !== active) return;
    stopSound();
    if (sending) fail(message, 'Couldn’t start sound pickup');
    else {
      status.textContent = message;
      el('sound-listen').disabled = el('sound-pin').disabled = false;
    }
  }
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('This browser cannot use sound pickup. Open the page in Safari, Chrome or Firefox.');
    // Resume in the user's click, before loading codecs; mobile browsers require this gesture.
    active.context = new Context();
    const resume = active.context.resume();
    const [, transport] = await Promise.all([resume, import('./sound-transfer.js?v=5')]);
    if (sound !== active) return;
    const options = {
      code,
      context: active.context,
      signal: active.controller.signal,
      onStatus(message) { if (sound === active) status.textContent = message; },
      onProgress(fraction) {
        if (sound !== active) return;
        const percent = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
        meter.value = percent;
        if (!sending) {
          const now = performance.now();
          if (!firstProgress || fraction < firstProgress.fraction) firstProgress = {fraction, time: now};
          const gain = fraction - firstProgress.fraction;
          let text = percent + '% received';
          if (now - firstProgress.time > 15000 && gain > 0.005 && percent < 99) {
            const minutes = Math.ceil((now - firstProgress.time) * (1 - fraction) / (gain * 60000));
            text += ' · About ' + minutes + (minutes === 1 ? ' minute' : ' minutes') + ' left';
          }
          el('sound-received').textContent = text;
        }
      },
      onSent() { if (sound === active) { stopSound(); done(); } },
      onPhoto(blob, filename) { if (sound === active) { stopSound(); done(blob, filename); } },
      onError: failed
    };
    const release = sending ? await transport.startSoundSender(picked, options) : await transport.startSoundReceiver(options);
    if (sound === active) active.release = release;
    else release?.();
  } catch (error) {
    failed(error.message || 'Sound pickup could not start. Check microphone access and try again.');
  }
}

// A photo booth embedding this page can pass the File produced by its camera.
export async function startPhotoSession(file, { receiverURL } = {}) {
  if (role !== 'kiosk') throw new Error('Open the kiosk page to start a photo session.');
  reset();
  receiverPage = receiverURL ? new URL(receiverURL, location.href).href : undefined;
  selectFile(file);
  if (!picked) throw new Error(el('file-label').textContent);
  await begin();
}

// A reload cannot reuse the reply the kiosk may already hold.
function firstVisit(key) {
  try {
    const name = 'photopass-offer-' + key;
    if (sessionStorage.getItem(name)) return false;
    sessionStorage.setItem(name, '1');
  } catch { /* Storage can be unavailable in private modes. */ }
  return true;
}

// Switch this phone to the moving square: the QR code it opened carries the
// screen-transfer id, so no second scan is needed.
function useCamera(note = '') {
  if (role !== 'phone' || !lightId || !pickupNonce) return;
  const id = lightId, nonce = pickupNonce;
  cleanUp();
  history.replaceState(null, '', location.pathname + '?14' + lightHash(id) + '.' + nonce);
  openLight();
  el('status').textContent = note;
}

function waitForKiosk() {
  phoneTimer = undefined;
  if (role !== 'phone' || page !== 'pairing' || !lightId) return;
  // Once the kiosk's own checks arrive, the connection settles by itself.
  const state = peer?.session?.pc?.iceConnectionState;
  if (state && state !== 'new') { phoneTimer = setTimeout(waitForKiosk, 5000); return; }
  useCamera('The kiosk did not connect. Using the camera instead.');
}

// The phone opened the kiosk's QR code. It shows its reply as a QR for the
// kiosk camera and plays the same reply as a tone for the kiosk microphone.
// If the kiosk does not connect, it switches to its camera and the moving square.
async function openOffer(text) {
  role = 'phone';
  const current = generation;
  working('Preparing your reply code', 'Finding a direct connection…');
  let errorTitle = 'Couldn’t read the kiosk code';
  let signal;
  try {
    signal = await readSignal(text);
    if (signal.description.type !== 'offer') throw new Error('Scan the code on the kiosk to start a transfer.');
  } catch (error) {
    if (current === generation) fail(error.message, errorTitle);
    return;
  }
  if (current !== generation) return;
  lightId = signal.pickup && toHex(signal.pickup.subarray(0, 12));
  pickupNonce = signal.pickup && toNonce(signal.pickup.subarray(12));
  if (lightId && (!firstVisit(signal.session) || !window.isSecureContext || !window.RTCPeerConnection || !crypto.subtle)) {
    useCamera('Point the camera at the moving square on the kiosk.');
    return;
  }
  if (lightId) phoneTimer = setTimeout(waitForKiosk, budget('phone'));
  try {
    requireBrowser();
    errorTitle = 'Couldn’t prepare the phone’s reply';
    session = signal.session;
    peer = createPeer();
    // Hold the kiosk's candidates until its checks arrive: its firewall may
    // drop ours, and the reply can take a visitor many seconds to deliver.
    const answer = await peer.answer(signal.description, { quickGather: true, holdCandidates: 'checking' });
    if (current !== generation) return;
    const reply = { type: 'answer', sdp: trimReply(answer.sdp) };
    await pair(await makeAnswerText(reply, session, signal.protocol), true, current);
    if (current !== generation || page !== 'pairing' || !lightId) return;
    phoneReply = new AbortController();
    replyTone(answerMessage(pickupPacket(lightId, pickupNonce), answer, session, trimReply),
      phoneReply.signal, el('pair-tone-status'), el('pair-tone'));
  } catch (error) {
    if (current !== generation) return;
    if (lightId) useCamera('Direct pairing could not start. Using the camera instead.');
    else fail(error.message, errorTitle);
  }
}

function requireBrowser() {
  if (!window.isSecureContext || !window.RTCPeerConnection || !crypto.subtle) {
    throw new Error('Open the published HTTPS page in a current browser to transfer a photo.');
  }
}

el('file-input').addEventListener('change', event => selectFile(event.target.files[0]));
el('camera-button').addEventListener('click', startCapture);
el('camera-select').addEventListener('change', () => {
  selectedCameraId = el('camera-select').value;
  startCapture();
});
el('take-button').addEventListener('click', async () => {
  if (!capture || el('take-button').disabled) return;
  const version = captureVersion;
  el('take-button').disabled = true;
  try {
    const photo = await takePhoto(el('capture-video'));
    if (version === captureVersion) {
      selectFile(photo, true);
      if (picked === photo) await begin();
    }
  } catch {
    if (version === captureVersion) el('capture-status').textContent = 'The photo could not be captured. Wait for a clear preview and try again.';
  } finally {
    if (version === captureVersion) el('take-button').disabled = false;
  }
});
el('retake-button').addEventListener('click', () => {
  clearPicked();
  el('file-input').value = '';
  el('file-label').textContent = 'JPEG, PNG or WebP · Up to 32 MiB';
  startCapture();
});
el('start-button').addEventListener('click', begin);
el('light-start').addEventListener('click', readLight);
el('light-direct').addEventListener('click', () => { if (page === 'light-send') { stopLight(); beginPair(); } });
el('pair-square').addEventListener('click', () => { if (pairing) squareFor(pairing, 'manual'); });
el('pair-camera').addEventListener('click', () => useCamera('Point the camera at the moving square on the kiosk.'));
el('light-sound').addEventListener('click', () => runSound(true));
el('sound-back').addEventListener('click', () => { stopSound(); beginLight(); });
el('error-sound').addEventListener('click', () => {
  if (role === 'phone') location.hash = 'listen';
  else runSound(true);
});
el('sound-listen').addEventListener('click', () => runSound(false));
el('sound-pin').addEventListener('keydown', event => { if (event.key === 'Enter') runSound(false); });
el('light-mode').addEventListener('change', () => {
  if (!lightSender) return;
  const mode = el('light-mode').value;
  lightSender.setHighSpeed(mode === 'fast');
  lightSender.setLargeSquares(mode === 'easy');
  lightSender.setColor(mode === 'color');
  el('light-mode-note').textContent = 'Changing square density restarts collection on the phone.';
});
el('light-expand').addEventListener('click', () => expandLight(true));
el('light-zoom').addEventListener('click', () => expandLight(!document.documentElement.classList.contains('light-expanded')));
el('error-retry').addEventListener('click', () => {
  if (retryMode === 'sound') return runSound(true);
  return beginLight();
});
el('reset-button').addEventListener('click', () => {
  reset();
  if (role === 'kiosk') startCapture();
});
el('expand-qr').addEventListener('click', () => setExpanded(!document.documentElement.classList.contains('qr-expanded')));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.documentElement.classList.contains('qr-expanded')) setExpanded(false);
  if (event.key === 'Escape' && document.documentElement.classList.contains('light-expanded')) expandLight(false);
});
el('manual-apply').addEventListener('click', () => codeText(pairing, el('manual-input').value));
el('copy-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('pair-text').value);
    el('status').textContent = 'Pairing details copied.';
  } catch {
    el('pair-text').select();
    el('status').textContent = 'Select Copy to copy the pairing details.';
  }
});
el('share-button').addEventListener('click', async () => {
  if (!receivedFile) return;
  try { await navigator.share({ files: [receivedFile] }); }
  catch (error) { if (error.name !== 'AbortError') el('status').textContent = 'Use the download button to save your photo.'; }
});
window.addEventListener('pagehide', cleanUp);
document.addEventListener('visibilitychange', updateScreenLock);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
function enterRoute() {
  const soundLink = /^#S(\d{6})$/.exec(location.hash);
  if (soundLink) return openSoundListener(soundLink[1]);
  if (new URLSearchParams(location.search).has('s') && !location.hash) return openSoundListener();
  if (location.hash === '#listen' || (!location.hash && new URLSearchParams(location.search).has('listen'))) return openSoundListener();
  if (location.hash.startsWith('#L')) return openLight();
  if (location.hash) return openOffer(location.href);
  if (['?2', '?3', '?7', '?8', '?9', '?10', '?11', '?12', '?13', '?14'].includes(location.search)) {
    role = 'phone';
    return fail('Scan the full pickup code on the kiosk again.', 'Incomplete pickup link');
  }
  if (role === 'kiosk') {
    show('start');
    startCapture();
  }
}
window.addEventListener('hashchange', () => { reset(false); enterRoute(); });
enterRoute();
