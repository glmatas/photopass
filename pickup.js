// The phone sends this small, session-specific packet only after its camera
// is running. The optical file stream operates independently of audio.
export function pickupPacket(id, nonce) {
  const fileId = Uint8Array.from(id.match(/../g), hex => parseInt(hex, 16));
  const session = Uint8Array.from(atob(nonce.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return Uint8Array.of(80, 80, 82, 1, ...fileId, ...session);
}

export async function readyTone(packet, signal, onReady, { onMessage, cameraGroup } = {}) {
  if (signal.aborted) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  const life = new AbortController();
  let context, modem, timeout, retry;
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
  }
  signal.addEventListener('abort', close, {once:true});
  try {
    context = new Context();
    timeout = setTimeout(close, onReady ? 12000 : 7000);
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
    // A blocked resume must never delay the camera or the display timer.
    const resumed = context.resume();
    resumed.catch(close);
    // A muted/blocked return path need not load a codec alongside QR decoding.
    // On the kiosk, opening the microphone can itself make playback eligible.
    if (!onReady) {
      await resumed;
      if (life.signal.aborted) return;
    }
    const {openSoundModem} = await import('./sound-modem.js?v=10');
    if (life.signal.aborted) return;
    modem = await openSoundModem({
      context, listen:Boolean(onReady), signal:life.signal, onError:close, cameraGroup,
      onPacket(bytes) {
        if (onReady && !life.signal.aborted && packet.length === bytes.length &&
            packet.every((value, i) => value === bytes[i])) onReady();
        else if (!life.signal.aborted) onMessage?.(bytes);
      },
    });
    if (onReady && !modem.listening) { close(); return; }
    await resumed;
    if (life.signal.aborted) return;
    if (onReady) { clearTimeout(timeout); return; }
    await modem.send(packet);
    if (life.signal.aborted) return;
    retry = setTimeout(() => { modem.send(packet).catch(() => {}).finally(close); }, 1000);
  } catch { close(); }
}

export function startPickupDisplay(transfer, packet, render, { file, cameraGroup }) {
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
  void readyTone(packet, life.signal, () => {
    stream(true);
    direct ??= import('./pickup-direct.js?v=10').then(({offerPickup}) =>
      life.signal.aborted ? undefined : offerPickup(file, packet, transfer, life.signal)).catch(() => undefined);
    void direct.then(attempt => attempt?.start());
  }, {cameraGroup, onMessage: bytes => { void direct?.then(attempt => attempt?.answer(bytes)); }});
  return () => { life.abort(); clearTimeout(timer); };
}
