// The phone sends this small, session-specific packet only after its camera
// is running. The optical file stream operates independently of audio.
export function pickupPacket(id, nonce) {
  const fileId = Uint8Array.from(id.match(/../g), hex => parseInt(hex, 16));
  const session = Uint8Array.from(atob(nonce.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return Uint8Array.of(80, 80, 82, 1, ...fileId, ...session);
}

export async function readyTone(packet, signal, onReady, {
  onMessage, cameraGroup, onListening, onUnavailable, outputContext, pairingChirp, onWaitingForTap, onPlayed, gaps,
} = {}) {
  if (signal.aborted) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) { onUnavailable?.(new Error('This browser cannot run the pairing audio.')); return; }
  const life = new AbortController();
  let context, modem, timeout, retry, resumeTimer, awaitingOutput = false;
  const unlock = () => { if (context?.state === 'suspended') context.resume().catch(() => {}); };
  function close() {
    clearTimeout(timeout);
    clearTimeout(retry);
    clearTimeout(resumeTimer);
    signal.removeEventListener('abort', close);
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
    if (life.signal.aborted) return;
    life.abort();
    if (context && !outputContext && context.state !== 'closed') context.close().catch(() => {});
  }
  function unavailable(error) {
    if (signal.aborted || life.signal.aborted) return;
    close();
    if (onWaitingForTap && (error?.name === 'NotAllowedError' || (awaitingOutput && !error))) onWaitingForTap();
    else onUnavailable?.(error);
  }
  signal.addEventListener('abort', close, {once:true});
  try {
    context = outputContext || new Context();
    timeout = setTimeout(unavailable, onReady ? 45000 : 7500);
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
    // A blocked resume must never delay the camera or the display timer.
    const resumed = context.resume();
    resumed.catch(unavailable);
    // A muted/blocked return path need not load a codec alongside QR decoding.
    // On the kiosk, opening the microphone can itself make playback eligible.
    if (!onReady) {
      awaitingOutput = true;
      if (onWaitingForTap) resumeTimer = setTimeout(onWaitingForTap, 900);
      await resumed;
      awaitingOutput = false;
      clearTimeout(resumeTimer);
      if (life.signal.aborted) return;
    }
    const {openSoundModem, pairingProfile} = await import('./sound-modem.js?v=14');
    if (life.signal.aborted) return;
    modem = await openSoundModem({
      context, listen:Boolean(onReady), signal:life.signal, onError:unavailable, cameraGroup, micTimeoutMs:40000, profile:pairingProfile,
      onPacket(bytes) {
        if (onReady && !life.signal.aborted && packet.length === bytes.length &&
            packet.every((value, i) => value === bytes[i])) onReady();
        else if (!life.signal.aborted) onMessage?.(bytes);
      },
    });
    if (onReady && !modem.listening) { unavailable(modem.listenError); return; }
    await resumed;
    if (life.signal.aborted) return;
    if (onReady) { clearTimeout(timeout); onListening?.(modem.inputLabel); return; }
    // Setup is done; a long packet (the answer is about 5 s of audio) must not trip the setup timeout.
    clearTimeout(timeout);
    await modem.send(packet, {pairingChirp});
    if (life.signal.aborted) return;
    onPlayed?.();
    // Replay after 1 s as before. The ready tone, which has no other trigger, plays 3 times in total
    // (the third 3 s later) so a missed first play never needs a tap. The answer plays twice.
    // Aborting the tone (the answer replaces the ready packet) cancels any pending replay.
    gaps ??= pairingChirp ? [1000, 3000] : [1000];
    let replays = 0;
    const replay = () => {
      retry = setTimeout(() => {
        modem.send(packet, {pairingChirp}).catch(() => {}).finally(() => {
          if (life.signal.aborted) return;
          if (++replays < gaps.length) replay(); else close();
        });
      }, gaps[replays]);
    };
    replay();
  } catch (error) { unavailable(error); }
}

export function phonePairing(ready, signal, status, retry) {
  const Context = window.AudioContext || window.webkitAudioContext;
  const canPair = Boolean(globalThis.RTCPeerConnection && Context);
  let packet = ready, tone, timer, idle, speaker, previousType;
  function show(message, canRetry = false) {
    status.textContent = message;
    status.hidden = !canPair || !message;
    retry.hidden = !canPair || !canRetry;
  }
  function cancelBurst() {
    clearTimeout(timer);
    tone?.abort();
  }
  function releaseSpeaker() {
    clearTimeout(idle);
    cancelBurst();
    if (speaker && speaker.state !== 'closed') speaker.close().catch(() => {});
    speaker = undefined;
    try {
      if (previousType && navigator.audioSession.type === 'playback') navigator.audioSession.type = previousType;
    } catch { /* The browser may withdraw access to its audio session. */ }
    previousType = undefined;
  }
  // Each message names the pairing phase that stopped, for field diagnosis.
  const stopped = {
    offer: 'Keep scanning. No pairing offer was read from the kiosk yet.',
    reply: 'Keep scanning. The kiosk did not connect after the pairing reply.',
    network: 'Keep scanning. The direct network connection failed.',
    dropped: 'Keep scanning. The direct connection dropped.',
    start: 'Keep scanning. This phone could not prepare a direct connection.',
  };
  function offerRetry(reason, code = '') {
    if (signal.aborted) return;
    show((stopped[reason] || 'Keep scanning.') + ' To retry direct pairing, use the phone speaker with media volume up.' + code, true);
  }
  function play(bytes) {
    if (signal.aborted || !bytes || !Context) return;
    cancelBurst();
    packet = bytes;
    tone = new AbortController();
    // Select media volume before the first resume, including on a fresh QR visit.
    // Reuse an unlocked context for the answer when the browser required a tap.
    if (!speaker) {
      try {
        const session = navigator.audioSession;
        if (session?.type && session.type !== 'playback') {
          previousType = session.type;
          session.type = 'playback';
        }
      } catch { /* Audio Session is optional. */ }
      try { speaker = new Context(); }
      catch { releaseSpeaker(); offerRetry(); return; }
    }
    // The ready tone repeats for about 7 s; the reply's outcome comes from the connection itself.
    const isReady = bytes === ready;
    clearTimeout(idle);
    idle = setTimeout(releaseSpeaker, 30000);
    show(bytes === ready ? 'Trying direct pairing…' : 'Sending the pairing reply…');
    void readyTone(bytes, tone.signal, undefined, {
      outputContext:speaker, pairingChirp:bytes === ready,
      onWaitingForTap:() => show('Sound hasn’t started. Tap Play pairing tone, or keep scanning.', true),
      onPlayed() {
        show(isReady ? 'Pairing tone played. Waiting for the kiosk…' : 'Pairing reply played. Connecting…');
        if (isReady) timer = setTimeout(() => offerRetry('offer'), 8000);
      },
      onUnavailable:() => offerRetry(),
    });
  }
  function retryFromTap() {
    play(packet);
  }
  retry.addEventListener('click', retryFromTap);
  signal.addEventListener('abort', () => {
    releaseSpeaker();
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
    direct(active, reason, code) {
      releaseSpeaker();
      packet = ready;
      if (active) show('');
      else offerRetry(reason, code);
    },
  };
}

export function startPickupDisplay(transfer, packet, render, { file, cameraGroup, onPairStatus, micRetry, immediate, confirmed, onMessage }) {
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
  // A visitor who already tried QR pairing is waiting, so start at once.
  const timer = setTimeout(() => stream(false), immediate ? 0 : 5000);
  function heard() {
    stream(true);
    direct ??= import('./pickup-direct.js?v=15').then(({offerPickup}) =>
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
      onUnavailable(error) {
        const isWindows = /Win/i.test(navigator.userAgentData?.platform || navigator.platform);
        let message;
        if (error?.name === 'NotAllowedError' && /by system|operating system/i.test(error.message)) {
          message = isWindows
            ? 'Windows blocked the microphone. In Settings > Privacy & security > Microphone, turn on desktop app access, then retry.'
            : 'The operating system blocked the microphone. Allow microphone access for this browser in system settings, then retry.';
        } else if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
          message = 'Microphone access was denied. Allow the microphone for this site in the kiosk browser, then retry.';
        } else if (error?.name === 'NotFoundError') {
          message = 'The kiosk browser found no microphone. Connect the webcam or microphone, then retry.';
        } else if (error?.name === 'NotReadableError') {
          message = 'The browser could not open the kiosk microphone. Check the selected input and close any app holding it, then retry.';
        } else {
          message = error?.message || 'The kiosk audio input did not start. Check the microphone and retry.';
        }
        onPairStatus(message);
        micRetry.hidden = false;
      },
      onMessage: bytes => { onMessage?.(bytes); void direct?.then(attempt => attempt?.answer(bytes)); },
    });
  }
  micRetry.addEventListener('click', listen);
  listen();
  if (confirmed) heard();
  return () => { life.abort(); clearTimeout(timer); micRetry.removeEventListener('click', listen); };
}

// The phone's reply in QR pairing: the same bytes as its reply QR, played
// three times. Without a user gesture most phones block sound, so a tap on
// the button (or anywhere on the page) starts it; the QR never waits for it.
export function replyTone(bytes, signal, status, button) {
  const Context = window.AudioContext || window.webkitAudioContext;
  let speaker, tone, previousType;
  function show(message, canRetry = false) {
    status.textContent = message;
    status.hidden = !message;
    button.hidden = !canRetry;
  }
  function stop() {
    tone?.abort();
    tone = undefined;
  }
  function play() {
    if (signal.aborted || !Context) return;
    stop();
    tone = new AbortController();
    if (!speaker) {
      try {
        const session = navigator.audioSession;
        if (session?.type && session.type !== 'playback') {
          previousType = session.type;
          session.type = 'playback';
        }
      } catch { /* Audio Session is optional. */ }
      try { speaker = new Context(); } catch { show('This browser cannot play the pairing tone. Show the code instead.'); return; }
    }
    show('Playing the pairing tone…');
    void readyTone(bytes, tone.signal, undefined, {
      outputContext: speaker, gaps: [1000, 5000],
      onWaitingForTap: () => show('Sound is off. Tap Play pairing tone, or just show the code.', true),
      onPlayed: () => show('Pairing tone played. You can play it again.', true),
      onUnavailable: () => show('The pairing tone could not play. Show the code instead.', true),
    });
  }
  button.addEventListener('click', play);
  signal.addEventListener('abort', () => {
    stop();
    button.removeEventListener('click', play);
    if (speaker && speaker.state !== 'closed') speaker.close().catch(() => {});
    try {
      if (previousType && navigator.audioSession.type === 'playback') navigator.audioSession.type = previousType;
    } catch { /* The browser may withdraw access to its audio session. */ }
    show('');
  }, { once: true });
  if (Context) play();
  else show('');
}
