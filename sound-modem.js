const maxPacketSize = 1200;
const worklets = new WeakMap();
const aborted = () => new DOMException('Sound transfer stopped.', 'AbortError');

function loadWorklet(context) {
  if (!worklets.has(context)) {
    const url = new URL('./vendor/sound/capture-worklet.js', import.meta.url);
    worklets.set(context, context.audioWorklet.addModule(url));
  }
  return worklets.get(context);
}

// The caller owns and resumes the AudioContext inside a tap. Each modem owns
// its worker, capture tracks, and scheduled speaker source.
export async function openSoundModem({ context, listen = false, onPacket, onError, signal, micTimeoutMs = 8000, cameraGroup }) {
  if (signal?.aborted) throw aborted();
  if (!context || context.state === 'closed') throw new Error('Sound playback is unavailable.');
  const worker = new Worker(new URL('./vendor/sound/modem-worker.js', import.meta.url));
  const life = new AbortController();
  let stream, input, capture, mute;
  let closed = false, opened = false, listening = false, listenError;
  let queued = 0, ticket = 0;
  let readyResolve, readyReject, playbackCancel;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const encoding = new Map();
  let sendQueue = Promise.resolve();

  function releaseInput() {
    listening = false;
    if (capture?.port) { capture.port.onmessage = null; capture.port.close(); }
    if (capture && 'onaudioprocess' in capture) capture.onaudioprocess = null;
    input?.disconnect(); capture?.disconnect(); mute?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    stream = input = capture = mute = undefined;
  }
  function close() {
    if (closed) return;
    closed = true;
    life.abort();
    signal?.removeEventListener('abort', close);
    releaseInput();
    playbackCancel?.(aborted());
    readyReject(aborted());
    for (const pending of encoding.values()) pending.reject(aborted());
    encoding.clear();
    worker.terminate();
  }
  function failed(error) {
    if (closed) return;
    readyReject(error);
    const notify = opened;
    close();
    if (notify) onError?.(error);
  }
  signal?.addEventListener('abort', close, { once: true });
  worker.onerror = event => failed(new Error(event.message || 'The local sound modem stopped.'));
  worker.onmessage = ({data}) => {
    if (closed) return;
    if (data.kind === 'ready') { clearTimeout(timer); readyResolve(); }
    if (data.kind === 'consumed') queued = Math.max(0, queued - 1);
    if (data.kind === 'packet') onPacket?.(data.bytes);
    if (data.kind === 'wave' || data.kind === 'error') {
      const call = encoding.get(data.id);
      if (call) {
        encoding.delete(data.id);
        if (data.kind === 'wave') call.resolve(data.pcm);
        else call.reject(new Error(data.message));
      } else if (data.kind === 'error') failed(new Error(data.message));
    }
  };

  function requestInput() {
    if (!listen || !navigator.mediaDevices?.getUserMedia) return Promise.resolve();
    return new Promise(resolve => {
      let decided = false;
      function finish(tracks, error) {
        if (decided || closed) tracks?.getTracks().forEach(track => track.stop());
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        life.signal.removeEventListener('abort', cancel);
        if (!closed) stream = tracks;
        listenError = error;
        resolve();
      }
      const cancel = () => finish(undefined, aborted());
      const timer = setTimeout(() => finish(stream, new Error('Microphone permission timed out.')), micTimeoutMs);
      life.signal.addEventListener('abort', cancel, { once: true });
      const audio = { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (cameraGroup) audio.groupId = { ideal: cameraGroup };
      navigator.mediaDevices.getUserMedia({video:false, audio}).then(async first => {
        if (cameraGroup === undefined || closed || decided) return finish(first);
        // Labels and groups may only become visible after mic permission. Keep
        // the working input unless the camera's microphone opens successfully.
        stream = first;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId && !['default','communications'].includes(d.deviceId));
          const candidates = inputs.filter(d => cameraGroup ? d.groupId === cameraGroup : /\bbrio\b/i.test(d.label));
          const track = first.getAudioTracks()[0];
          if (!closed && !decided && candidates.length === 1 &&
              track?.getSettings?.().deviceId !== candidates[0].deviceId &&
              !(cameraGroup && track?.getSettings?.().groupId === cameraGroup)) {
            const preferred = await navigator.mediaDevices.getUserMedia({video:false, audio:{...audio, deviceId:{exact:candidates[0].deviceId}}});
            if (closed || decided) { preferred.getTracks().forEach(t => t.stop()); return; }
            first.getTracks().forEach(t => t.stop());
            return finish(preferred);
          }
        } catch { /* The default mic also works if a webcam is unplugged. */ }
        if (!decided) finish(first);
      }, error => finish(undefined, error));
    });
  }
  function samples(pcm) {
    // A slow decoder can miss a packet; bound latency and memory rather than
    // replaying old microphone audio after the visitor has left.
    if (closed || queued >= 20) return;
    queued++;
    worker.postMessage({kind:'consume', pcm}, [pcm.buffer]);
  }
  async function connectInput() {
    if (!stream || closed) return;
    input = context.createMediaStreamSource(stream);
    if (context.audioWorklet && globalThis.AudioWorkletNode) {
      try {
        await loadWorklet(context);
        if (closed) return;
        capture = new AudioWorkletNode(context, 'photopass-audio-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        });
        capture.port.onmessage = ({data}) => samples(data);
      } catch { /* Older WebViews can still capture through ScriptProcessor. */ }
    }
    if (closed) return;
    if (!capture) {
      capture = context.createScriptProcessor(2048, 1, 1);
      capture.onaudioprocess = event => samples(event.inputBuffer.getChannelData(0).slice());
    }
    mute = context.createGain();
    mute.gain.value = 0;
    input.connect(capture); capture.connect(mute); mute.connect(context.destination);
    listening = true;
    const track = stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => {
      if (closed || !listening) return;
      releaseInput();
      listenError = new Error('The microphone disconnected.');
      onError?.(listenError);
    }, { once: true });
  }

  async function transmit(bytes, pairingChirp) {
    if (closed) throw aborted();
    if (context.state !== 'running') throw new Error('Sound playback paused. Tap to start sound again.');
    const id = ++ticket;
    const pcm = await new Promise((resolve, reject) => {
      encoding.set(id, {resolve, reject});
      worker.postMessage({kind:'encode', id, bytes}, [bytes.buffer]);
    });
    if (closed) throw aborted();
    const rate = context.sampleRate;
    const cueSamples = pairingChirp ? Math.round(0.14 * rate) : 0;
    const prefix = pairingChirp ? cueSamples + Math.round(0.015 * rate) : 0;
    const audio = context.createBuffer(1, prefix + pcm.length, rate);
    if (pairingChirp) {
      // An audible 900–1500 Hz sweep identifies the ready signal on small speakers.
      const samples = audio.getChannelData(0);
      for (let i = 0; i < cueSamples; i++) {
        const t = i / rate;
        const fade = Math.min(1, i / (0.01 * rate), (cueSamples - 1 - i) / (0.01 * rate));
        samples[i] = 0.22 * fade * Math.sin(2 * Math.PI * t * (900 + 300 * i / cueSamples));
      }
    }
    audio.copyToChannel(pcm, 0, prefix);
    const speaker = context.createBufferSource();
    speaker.buffer = audio;
    speaker.connect(context.destination);
    await new Promise((resolve, reject) => {
      let tail, timer;
      function finish(error) {
        clearTimeout(tail); clearTimeout(timer);
        playbackCancel = undefined;
        speaker.onended = null;
        if (error) { try { speaker.stop(); } catch { /* Source already ended. */ } }
        speaker.disconnect();
        if (error) reject(error); else resolve();
      }
      playbackCancel = finish;
      speaker.onended = () => {
        // Some hardware still has rendered samples queued after the graph ends.
        const delay = Math.min(400, 1000 * (context.outputLatency || 0));
        if (delay > 0) tail = setTimeout(finish, delay); else finish();
      };
      timer = setTimeout(() => finish(new Error('Sound playback was interrupted.')), audio.duration * 1000 + 5000);
      try { speaker.start(); } catch (error) { finish(error); }
    });
  }

  function send(bytes, {pairingChirp = false} = {}) {
    if (closed) return Promise.reject(aborted());
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maxPacketSize) {
      return Promise.reject(new Error('Sound packets must contain 1–1,200 bytes.'));
    }
    const copy = bytes.slice();
    const sent = sendQueue.then(() => transmit(copy, pairingChirp));
    sendQueue = sent.catch(() => {});
    return sent;
  }
  const timer = setTimeout(() => failed(new Error('The local sound modem did not load.')), 20000);
  try {
    worker.postMessage({kind:'init', rate:context.sampleRate, listen:Boolean(listen)});
    await Promise.all([ready, requestInput()]);
    try { await connectInput(); }
    catch (error) { listenError = error; releaseInput(); }
    if (closed) throw aborted();
    opened = true;
    return {send, close, maxPacketSize, get listening() {return listening;}, get listenError() {return listenError;},
      get inputLabel() {return stream?.getAudioTracks()[0]?.label;}};
  } catch (error) {
    close();
    throw error;
  } finally { clearTimeout(timer); }
}
