// The phone sends this small, session-specific packet only after its camera
// is running. The optical file stream operates independently of audio.
export function pickupPacket(id, nonce) {
  const fileId = Uint8Array.from(id.match(/../g), hex => parseInt(hex, 16));
  const session = Uint8Array.from(atob(nonce.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return Uint8Array.of(80, 80, 82, 1, ...fileId, ...session);
}

export async function readyTone(packet, signal, onReady, { onMessage, cameraGroup, onListening, onUnavailable, playback = false } = {}) {
  if (signal.aborted) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) { onUnavailable?.(); return; }
  const life = new AbortController();
  let context, modem, timeout, retry, previousType;
  let audioSession;
  const unlock = () => { if (context?.state === 'suspended') context.resume().catch(() => {}); };
  function close() {
    clearTimeout(timeout);
    clearTimeout(retry);
    signal.removeEventListener('abort', close);
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
    if (life.signal.aborted) return;
    life.abort();
    if (context && context.state !== 'closed') context.close().catch(() => {});
    try {
      if (previousType && audioSession.type === 'playback') audioSession.type = previousType;
    } catch { /* A browser may withdraw access to its audio session. */ }
  }
  function unavailable() {
    if (signal.aborted || life.signal.aborted) return;
    close();
    onUnavailable?.();
  }
  signal.addEventListener('abort', close, {once:true});
  try {
    // Only an explicit phone tap opts into the iOS media playback route.
    if (playback) {
      try {
        audioSession = navigator.audioSession;
        if (audioSession?.type && audioSession.type !== 'playback') {
          previousType = audioSession.type;
          audioSession.type = 'playback';
        }
      } catch { /* Standard Web Audio still works when this API is restricted. */ }
    }
    context = new Context();
    timeout = setTimeout(unavailable, onReady ? 45000 : 7500);
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
    // A blocked resume must never delay the camera or the display timer.
    const resumed = context.resume();
    resumed.catch(unavailable);
    // A muted/blocked return path need not load a codec alongside QR decoding.
    // On the kiosk, opening the microphone can itself make playback eligible.
    if (!onReady) {
      await resumed;
      if (life.signal.aborted) return;
    }
    const {openSoundModem} = await import('./sound-modem.js?v=12');
    if (life.signal.aborted) return;
    modem = await openSoundModem({
      context, listen:Boolean(onReady), signal:life.signal, onError:unavailable, cameraGroup, micTimeoutMs:40000,
      onPacket(bytes) {
        if (onReady && !life.signal.aborted && packet.length === bytes.length &&
            packet.every((value, i) => value === bytes[i])) onReady();
        else if (!life.signal.aborted) onMessage?.(bytes);
      },
    });
    if (onReady && !modem.listening) { unavailable(); return; }
    await resumed;
    if (life.signal.aborted) return;
    if (onReady) { clearTimeout(timeout); onListening?.(modem.inputLabel); return; }
    await modem.send(packet);
    if (life.signal.aborted) return;
    retry = setTimeout(() => { modem.send(packet).catch(() => {}).finally(close); }, 1000);
  } catch { unavailable(); }
}

export function phonePairing(ready, signal, status, retry) {
  const canPair = Boolean(globalThis.RTCPeerConnection && (window.AudioContext || window.webkitAudioContext));
  let packet = ready, tone, timer, useMediaVolume = false;
  function show(message, canRetry = false) {
    status.textContent = message;
    status.hidden = !canPair || !message;
    retry.hidden = !canPair || !canRetry;
  }
  function cancelBurst() {
    clearTimeout(timer);
    tone?.abort();
  }
  function offerRetry() {
    if (!signal.aborted) show('Keep scanning. To retry direct pairing, use the phone speaker with media volume up.', true);
  }
  function play(bytes) {
    if (signal.aborted || !bytes) return;
    cancelBurst();
    packet = bytes;
    tone = new AbortController();
    show(bytes === ready ? 'Trying direct pairing…' : 'Sending the pairing reply…');
    if (canPair) timer = setTimeout(offerRetry, 5000);
    void readyTone(bytes, tone.signal, undefined, {playback:useMediaVolume, onUnavailable:offerRetry});
  }
  function retryFromTap() {
    useMediaVolume = true;
    play(packet);
  }
  retry.addEventListener('click', retryFromTap);
  signal.addEventListener('abort', () => {
    cancelBurst();
    retry.removeEventListener('click', retryFromTap);
    show('');
  }, {once:true});
  show('');
  return {
    play,
    offer() {
      cancelBurst();
      packet = undefined;
      show('Kiosk pairing offer received. Preparing the reply…');
    },
    direct(active) {
      cancelBurst();
      packet = ready;
      if (active) show('');
      else offerRetry();
    },
  };
}

export function startPickupDisplay(transfer, packet, render, { file, cameraGroup, onPairStatus, micRetry }) {
  const life = new AbortController();
  let direct;
  function stream(confirmed) {
    if (life.signal.aborted) return;
    clearTimeout(timer);
    transfer.start();
    if (life.signal.aborted) return;
    render(true, confirmed);
  }
  render(false);
  const timer = setTimeout(() => stream(false), 5000);
  function heard() {
    stream(true);
    direct ??= import('./pickup-direct.js?v=12').then(({offerPickup}) =>
      life.signal.aborted ? undefined : offerPickup(file, packet, transfer, life.signal, onPairStatus)).catch(() => {
        if (!life.signal.aborted) onPairStatus('Phone tone received. Using screen transfer.');
      });
    void direct.then(attempt => attempt?.start());
  }
  function listen() {
    micRetry.hidden = true;
    onPairStatus('Opening the kiosk microphone. Allow access if prompted.');
    void readyTone(packet, life.signal, heard, {
      cameraGroup,
      onListening: label => onPairStatus(label ? 'Listening for the phone on ' + label + '.' : 'Listening for the phone’s pairing tone.'),
      onUnavailable() {
        onPairStatus('Microphone unavailable. Allow microphone access on the kiosk for direct pairing.');
        micRetry.hidden = false;
      },
      onMessage: bytes => { void direct?.then(attempt => attempt?.answer(bytes)); },
    });
  }
  micRetry.addEventListener('click', listen);
  listen();
  return () => { life.abort(); clearTimeout(timer); micRetry.removeEventListener('click', listen); };
}
