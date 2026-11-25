import { PhotoPeer } from './peer.js';
import { makeSignalURL, makeAnswerText, readSignal, drawCode, startCamera } from './qr.js';

const el = id => document.getElementById(id);
const panels = ['start', 'pairing', 'transfer', 'done', 'error'];
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
let page = 'start';
let role = 'kiosk';
let session = '';
let generation = 0;
let peer;
let camera;
let cameraPending = false;
let accepting = false;
let picked;
let previousPreview;
let receivedURL;
let receivedFile;

function show(name) {
  page = name;
  for (const panel of panels) el(panel + '-panel').hidden = name !== panel;
  el('reset-button').hidden = name === 'start';
  el('reset-button').textContent = role === 'phone' ? 'Close session' : name === 'done' ? 'Next visitor' : 'Start over';
}

function stopScan() {
  camera?.();
  camera = undefined;
  el('scanner').hidden = true;
}

function cleanUp() {
  generation++;
  stopScan();
  peer?.close();
  peer = undefined;
  cameraPending = false;
  accepting = false;
  if (receivedURL) URL.revokeObjectURL(receivedURL);
  if (previousPreview) URL.revokeObjectURL(previousPreview);
  receivedURL = previousPreview = receivedFile = picked = undefined;
}

function reset(clearLocation = true) {
  cleanUp();
  const onPhone = role === 'phone';
  if (clearLocation) history.replaceState(null, '', location.pathname + location.search);
  session = '';
  el('file-input').value = '';
  el('preview').removeAttribute('src');
  el('preview').hidden = true;
  el('received-image').removeAttribute('src');
  el('received-image').hidden = true;
  el('save-link').removeAttribute('href');
  el('pair-text').value = el('manual-input').value = '';
  el('manual-tools').open = false;
  el('start-button').disabled = true;
  el('file-label').textContent = 'JPEG, PNG or WebP · Up to 32 MiB';
  el('scan-status').textContent = el('status').textContent = '';
  el('progress').value = 0;
  if (onPhone) {
    show('done');
    el('done-title').textContent = 'Session closed';
    el('done-description').textContent = 'You can close this tab. Scan a new code at the kiosk for another photo.';
    el('save-link').hidden = el('share-button').hidden = el('reset-button').hidden = true;
  } else {
    show('start');
  }
}

function fail(message) {
  stopScan();
  peer?.close();
  peer = undefined;
  generation++;
  show('error');
  el('error-message').textContent = message;
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
      show('transfer');
      el('transfer-title').textContent = role === 'phone' ? 'Receiving your photo' : 'Sending the original';
      const percent = Math.floor(fraction * 100);
      el('progress').value = percent;
      el('progress-label').textContent = percent === 100 ? 'Verifying the file…' : percent + '% transferred';
    },
    onPhoto(blob, filename) { if (current === generation) done(blob, filename); },
    onSent() { if (current === generation) done(); },
    onFailure(message) { if (current === generation && page !== 'done') fail(message); }
  });
}

async function pair(text, receiver, current) {
  const qr = el('pair-qr');
  let qrAvailable = true;
  try {
    await drawCode(qr, text);
  } catch {
    qrAvailable = false;
  }
  if (current !== generation || page !== 'transfer' || el('progress').hasAttribute('value')) return;
  qr.parentElement.hidden = !qrAvailable;
  el('manual-tools').open = !qrAvailable;
  el('pair-text').value = text;
  el('manual-input').hidden = el('manual-apply').hidden = receiver;
  el('manual-input').labels?.forEach(label => { label.hidden = receiver; });
  el('scan-button').hidden = receiver;
  el('scan-button').disabled = false;
  el('scan-status').textContent = '';
  el('pair-title').textContent = receiver ? 'Show this code to the kiosk' : 'Scan to collect your photo';
  el('pair-instructions').textContent = receiver
    ? 'Hold your screen in front of the kiosk camera. Keep this tab open until your photo arrives.'
    : 'Open the phone camera and scan this code. When a reply code appears on the phone, scan it with the kiosk camera.';
  if (!qrAvailable) {
    el('pair-title').textContent = 'Pair using text';
    el('pair-instructions').textContent = receiver
      ? 'These details exceed the size of one QR code. Copy the reply text to the kiosk to pair.'
      : 'These details exceed the size of one QR code. Open the pairing link on the phone, then return its reply to this kiosk.';
  }
  el('status').textContent = '';
  show('pairing');
}

function selectFile(file) {
  picked = undefined;
  if (previousPreview) URL.revokeObjectURL(previousPreview);
  previousPreview = undefined;
  el('preview').removeAttribute('src');
  el('preview').hidden = true;
  el('start-button').disabled = true;
  if (!file) return;
  if (!allowedTypes.has(file.type) || file.size === 0 || file.size > 32 * 1024 * 1024) {
    el('file-label').textContent = 'Choose a nonempty JPEG, PNG or WebP up to 32 MiB.';
    return;
  }
  picked = file;
  previousPreview = URL.createObjectURL(file);
  el('preview').src = previousPreview;
  el('preview').hidden = false;
  el('file-label').textContent = file.name + ' · ' + (file.size / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' MB';
  el('start-button').disabled = false;
}

async function begin() {
  if (!picked || page !== 'start') return;
  const current = generation;
  working('Preparing the QR code', 'Finding a direct connection…');
  try {
    requireBrowser();
    session = crypto.randomUUID();
    peer = createPeer();
    const offer = await peer.offer(picked);
    if (current !== generation) return;
    const offerLink = await makeSignalURL(offer, session);
    if (current === generation) await pair(offerLink, false, current);
  } catch (error) {
    if (current === generation) fail(error.message);
  }
}

// A photo booth embedding this page can pass the File produced by its camera.
export async function startPhotoSession(file) {
  if (role !== 'kiosk') throw new Error('Open the kiosk page to start a photo session.');
  reset();
  selectFile(file);
  if (!picked) throw new Error(el('file-label').textContent);
  await begin();
}

async function openOffer(text) {
  role = 'phone';
  const current = generation;
  working('Preparing your reply code', 'Finding a direct connection…');
  try {
    requireBrowser();
    const signal = await readSignal(text);
    if (signal.description.type !== 'offer') throw new Error('Scan the code on the kiosk to start a transfer.');
    if (current !== generation) return;
    session = signal.session;
    peer = createPeer();
    const answer = await peer.answer(signal.description);
    if (current !== generation) return;
    const reply = await makeAnswerText(answer, session);
    if (current === generation) await pair(reply, true, current);
  } catch (error) {
    if (current === generation) fail(error.message);
  }
}

async function acceptReply(text) {
  if (accepting || page !== 'pairing' || role !== 'kiosk') return;
  const current = generation;
  accepting = true;
  try {
    let signal;
    try {
      signal = await readSignal(text.trim());
      if (signal.description.type !== 'answer' || signal.session !== session) throw new Error();
    } catch {
      if (current === generation) el('scan-status').textContent = 'Use the reply code from the phone that scanned this kiosk code.';
      return;
    }
    if (current !== generation) return;
    stopScan();
    working('Connecting to the phone', 'Keep both screens open.');
    await peer.accept(signal.description);
  } catch (error) {
    if (current === generation) fail(error.message);
  } finally {
    if (current === generation) accepting = false;
  }
}

function requireBrowser() {
  if (!window.isSecureContext || !window.RTCPeerConnection || !crypto.subtle) {
    throw new Error('Open the published HTTPS page in a current browser to transfer a photo.');
  }
}

el('file-input').addEventListener('change', event => selectFile(event.target.files[0]));
el('start-button').addEventListener('click', begin);
el('reset-button').addEventListener('click', () => reset());
el('scan-button').addEventListener('click', async () => {
  if (cameraPending || camera) return;
  const current = generation;
  cameraPending = true;
  el('scan-button').disabled = true;
  el('scanner').hidden = false;
  el('scan-status').textContent = 'Allow camera access, then hold the phone’s reply code in view.';
  try {
    const release = await startCamera(el('scanner'), acceptReply);
    if (current !== generation || page !== 'pairing') release();
    else camera = release;
  } catch {
    if (current === generation) {
      el('scanner').hidden = true;
      el('manual-tools').open = true;
      el('scan-status').textContent = 'Camera unavailable. Allow camera access and try again, or paste the reply using the pairing details below.';
      el('scan-button').disabled = false;
    }
  } finally {
    if (current === generation) cameraPending = false;
  }
});
el('manual-apply').addEventListener('click', () => acceptReply(el('manual-input').value));
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
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('hashchange', () => {
  reset(false);
  if (location.hash) openOffer(location.href);
});
if (location.hash) openOffer(location.href);
else show('start');
