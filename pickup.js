// The phone sends this small, session-specific packet only after its camera
// is running. The optical file stream operates independently of audio.
export function pickupPacket(id, nonce) {
  const fileId = Uint8Array.from(id.match(/../g), hex => parseInt(hex, 16));
  const session = Uint8Array.from(atob(nonce.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return Uint8Array.of(80, 80, 82, 1, ...fileId, ...session);
}

export async function readyTone(packet, signal, onReady) {
  if (signal.aborted) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  const life = new AbortController();
  let context, modem, timeout, retry;
  function close() {
    clearTimeout(timeout);
    clearTimeout(retry);
    signal.removeEventListener('abort', close);
    if (life.signal.aborted) return;
    life.abort();
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }
  signal.addEventListener('abort', close, {once:true});
  try {
    context = new Context();
    timeout = setTimeout(close, onReady ? 12000 : 7000);
    // A blocked resume must never delay the camera or the display timer.
    const resumed = context.resume();
    resumed.catch(close);
    const {openSoundModem} = await import('./sound-modem.js');
    if (life.signal.aborted) return;
    modem = await openSoundModem({
      context, listen:Boolean(onReady), signal:life.signal, onError:close,
      onPacket(bytes) {
        if (onReady && !life.signal.aborted && packet.length === bytes.length &&
            packet.every((value, i) => value === bytes[i])) onReady();
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

export function startPickupDisplay(transfer, packet, render) {
  const life = new AbortController();
  let timer;
  function waitForPhone(ms) {
    if (life.signal.aborted) return;
    clearTimeout(timer);
    transfer.pause();
    render(false);
    timer = setTimeout(() => stream(false), ms);
  }
  function stream(confirmed) {
    if (life.signal.aborted) return;
    clearTimeout(timer);
    transfer.start();
    if (life.signal.aborted) return;
    render(true, confirmed);
    // A muted phone can join on the timed stream. Showing its URL again at
    // the same spot lets a later arrival scan without an operator reset.
    timer = setTimeout(() => waitForPhone(3500), confirmed ? 120000 : 16000);
  }
  waitForPhone(8000);
  void readyTone(packet, life.signal, () => stream(true));
  return () => { life.abort(); clearTimeout(timer); };
}
