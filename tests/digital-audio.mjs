// This adapter supplies PCM "air" between two top-level windows. The app must
// modulate, recognize, filter, reassemble and verify everything itself. A
// closeable silent sink and an intercepted getUserMedia prevent hardware use.
export function installDigitalAudio({ direct, noKioskMic = false }) {
  if (!navigator.mediaDevices || !window.AudioContext) return;
  const NativeAudio = window.AudioContext;
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
    return location.hash.startsWith('#L') ||
      query.has('listen') ||
      query.has('s') ||
      location.hash === '#listen'
      ? 'phone'
      : 'kiosk';
  };
  function silentContext(options = {}) {
    const ctx = new NativeAudio({ ...options, sinkId: { type: 'none' } });
    if (ctx.sinkId?.type !== 'none') {
      void ctx.close();
      throw Error('Digital audio tests require a silent sink.');
    }
    return ctx;
  }
  window.qaMakeBus = () => {
    if (window.qaBus) return window.qaBus;
    const ctx = silentContext({ sampleRate: 48000 });
    const kiosk = ctx.createMediaStreamDestination();
    const phone = ctx.createMediaStreamDestination();
    const transmit = [];
    const outputs = { kiosk: 0, phone: 0 };
    const sample = new Float32Array(512);
    const timer = setInterval(() => {
      for (const { owner, analyser } of transmit) {
        analyser.getFloatTimeDomainData(sample);
        if (sample.some((value) => Math.abs(value) > 0.002)) outputs[owner]++;
      }
    }, 25);
    window.qaBus = {
      outputs,
      async mic(owner) {
        await ctx.resume();
        return (owner === 'phone' ? phone : kiosk).stream.getAudioTracks()[0].clone();
      },
      plug(owner, stream) {
        const incoming = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        incoming.connect(analyser);
        analyser.connect(owner === 'kiosk' ? phone : kiosk);
        transmit.push({ owner, incoming, analyser });
        void ctx.resume();
      },
      async dispose() {
        clearInterval(timer);
        for (const line of [kiosk, phone]) for (const track of line.stream.getTracks()) track.stop();
        await ctx.close();
      },
    };
    return window.qaBus;
  };
  const bus = () => (role() === 'phone' && window.opener ? window.opener.qaMakeBus() : window.qaMakeBus());
  window.AudioContext = new Proxy(NativeAudio, {
    construct(target, [options]) {
      const ctx = silentContext(options);
      const capture = ctx.createMediaStreamDestination();
      Object.defineProperty(ctx, 'destination', { get: () => capture });
      qa.contexts.push(ctx);
      bus().plug(role(), capture.stream);
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
