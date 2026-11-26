// This adapter supplies PCM "air" between two top-level windows. The app must
// modulate, recognize, filter, reassemble and verify everything itself. An
// intercepted getUserMedia prevents microphone use, and every context's
// destination is replaced by a capture node, so no app audio reaches a speaker.
// Audio moves as exact PCM blocks: an AudioWorklet taps each context's output
// and a jitter-buffered worklet replays it into the listener's graph. Chained
// MediaStream hops between contexts drop blocks under CPU load, which corrupts
// the long pairing frames.
export function installDigitalAudio({ direct, noKioskMic = false }) {
  if (!navigator.mediaDevices || !window.AudioContext) return;
  const NativeAudio = window.AudioContext;
  const rate = 48000;
  const qa = (window.qaAudio = {
    camera: 0,
    mic: 0,
    contexts: [],
    inputs: [],
    pcs: [],
    sent: 0,
    received: 0,
    opened: 0,
  });
  const role = () => {
    const query = new URLSearchParams(location.search);
    return location.hash.startsWith('#L') || location.hash.startsWith('#2') ||
      query.has('listen') ||
      query.has('s') ||
      location.hash === '#listen'
      ? 'phone'
      : 'kiosk';
  };
  // qa-tap sends each non-silent output block, stamped with its frame, straight
  // to every qa-mic on the other device over MessagePorts, so neither page's
  // main thread sits on the audio path. qa-mic starts a burst after 0.4 s of
  // buffering and counts any block that arrives too late to stay contiguous.
  const worklets = URL.createObjectURL(new Blob([`
    class Tap extends AudioWorkletProcessor {
      constructor() {
        super();
        this.links = []; this.loud = 0;
        this.port.onmessage = ({data}) => this.links.push(data);
      }
      process(inputs) {
        const x = inputs[0] && inputs[0][0];
        if (!x || !x.some(v => v !== 0)) return true;
        for (const {link, id} of this.links) link.postMessage({id, frame: currentFrame, x: x.slice()});
        if (x.some(v => Math.abs(v) > 0.002) && this.loud++ % 16 === 0) this.port.postMessage('loud');
        return true;
      }
    }
    class Mic extends AudioWorkletProcessor {
      constructor() {
        super();
        this.queue = []; this.offset = 0; this.held = 0; this.waited = -1; this.ends = {}; this.playing = false;
        this.port.onmessage = ({data}) => { data.onmessage = ({data: block}) => this.take(block); };
      }
      take({id, frame, x}) {
        const contiguous = this.ends[id] === frame;
        this.ends[id] = frame + x.length;
        if (!this.playing && this.waited < 0 && contiguous) this.port.postMessage('late');
        this.queue.push(x); this.held += x.length;
        if (!this.playing && this.waited < 0) this.waited = 0;
      }
      process(inputs, outputs) {
        const out = outputs[0][0], buffer = ${Math.round(0.4 * rate)};
        if (!this.playing) {
          if (this.waited < 0) return true;
          if (this.waited < buffer && this.held < buffer) { this.waited += out.length; return true; }
          this.playing = true;
        }
        let i = 0;
        while (i < out.length && this.queue.length) {
          const head = this.queue[0], n = Math.min(out.length - i, head.length - this.offset);
          out.set(head.subarray(this.offset, this.offset + n), i);
          i += n; this.offset += n; this.held -= n;
          if (this.offset === head.length) { this.queue.shift(); this.offset = 0; }
        }
        if (!this.queue.length) { this.playing = false; this.waited = -1; }
        return true;
      }
    }
    registerProcessor('qa-tap', Tap);
    registerProcessor('qa-mic', Mic);
  `], { type: 'text/javascript' }));
  // The caller must launch the browser with --mute-audio as a second guard.
  window.qaMakeBus = () => {
    if (window.qaBus) return window.qaBus;
    // This context only mints live microphone tracks; it carries no audio.
    const ctx = new NativeAudio({ sampleRate: rate });
    const lines = { kiosk: ctx.createMediaStreamDestination(), phone: ctx.createMediaStreamDestination() };
    const taps = [], ears = [];
    const outputs = { kiosk: 0, phone: 0 };
    let late = 0, ids = 0;
    function link(tap, ear) {
      const { port1, port2 } = new MessageChannel();
      ear.node.port.postMessage(port2, [port2]);
      tap.node.port.postMessage({ link: port1, id: tap.id }, [port1]);
    }
    window.qaBus = {
      outputs,
      get late() { return late; },
      async mic(owner) {
        await ctx.resume();
        const track = lines[owner].stream.getAudioTracks()[0].clone();
        Object.defineProperty(track, 'qaOwner', { value: owner });
        return track;
      },
      tap(owner, node) {
        const tap = { owner, node, id: ++ids };
        node.port.onmessage = () => outputs[owner]++;
        taps.push(tap);
        for (const ear of ears) if (ear.owner !== owner) link(tap, ear);
      },
      listen(owner, node) {
        const ear = { owner, node };
        node.port.onmessage = () => late++;
        ears.push(ear);
        for (const tap of taps) if (tap.owner !== owner) link(tap, ear);
      },
      async dispose() {
        for (const line of Object.values(lines)) for (const track of line.stream.getTracks()) track.stop();
        await ctx.close();
      },
    };
    return window.qaBus;
  };
  const bus = () => (role() === 'phone' && window.opener ? window.opener.qaMakeBus() : window.qaMakeBus());
  window.AudioContext = new Proxy(NativeAudio, {
    construct(target, [options]) {
      const ctx = new NativeAudio({ ...options, sampleRate: options?.sampleRate ?? rate });
      if (ctx.sampleRate !== rate) throw Error('Digital audio tests use 48 kHz contexts.');
      const owner = role();
      const capture = ctx.createGain();
      Object.defineProperty(ctx, 'destination', { get: () => capture });
      const loaded = ctx.audioWorklet.addModule(worklets);
      const tapped = loaded.then(() => {
        if (ctx.state === 'closed') return;
        const tap = new AudioWorkletNode(ctx, 'qa-tap', {
          numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        });
        bus().tap(owner, tap);
        capture.connect(tap);
        // A MediaStream sink keeps the tap rendering without any speaker output.
        tap.connect(ctx.createMediaStreamDestination());
      }, () => {});
      // Nothing can play before the tap listens: the app awaits resume() first.
      const nativeResume = ctx.resume.bind(ctx);
      ctx.resume = () => tapped.then(nativeResume);
      const nativeSource = ctx.createMediaStreamSource.bind(ctx);
      ctx.createMediaStreamSource = (stream) => {
        const track = stream.getAudioTracks()[0];
        if (!track?.qaOwner) return nativeSource(stream);
        const input = ctx.createGain();
        loaded.then(() => {
          if (ctx.state === 'closed' || track.readyState === 'ended') return;
          const mic = new AudioWorkletNode(ctx, 'qa-mic', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
          mic.connect(input);
          bus().listen(track.qaOwner, mic);
        }, () => {});
        return input;
      };
      qa.contexts.push(ctx);
      return ctx;
    },
  });
  if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext;
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      if (constraints.video) {
        qa.camera++;
        throw new DOMException(
          'This kiosk imports a file. No physical camera is available.',
          'NotAllowedError',
        );
      }
      if (!constraints.audio) throw Error('Unexpected media request');
      qa.mic++;
      if (noKioskMic && role() === 'kiosk')
        throw new DOMException('No virtual microphone installed on this kiosk.', 'NotFoundError');
      const track = await bus().mic(role());
      qa.inputs.push(track);
      return new MediaStream([track]);
    },
  });
  if (!direct) {
    Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: true });
    if ('webkitRTCPeerConnection' in window) window.webkitRTCPeerConnection = undefined;
    return;
  }
  function count(channel) {
    channel.addEventListener('open', () => qa.opened++);
    const send = channel.send.bind(channel);
    const byteLength = (value) => (typeof value === 'string' ? 0 : value?.byteLength || value?.size || 0);
    channel.send = (data) => {
      qa.sent += byteLength(data);
      return send(data);
    };
    channel.addEventListener('message', (event) => {
      qa.received += byteLength(event.data);
    });
    return channel;
  }
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(target, params) {
      const pc = new target(...params);
      qa.pcs.push(pc);
      const make = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (...params) => count(make(...params));
      pc.addEventListener('datachannel', (event) => count(event.channel));
      return pc;
    },
  });
}
