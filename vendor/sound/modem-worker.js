// PhotoPass adapter for the unmodified Quiet Emscripten build beside this file.
// The worker owns the encoder/decoder and its heap. Termination frees both.
const maxPacket = 1200;
const block = 4096;
let libraryReady;
const initialized = new Promise(resolve => { libraryReady = resolve; });
var Module = {
  locateFile: name => new URL(name, self.location.href).href,
  onRuntimeInitialized: () => libraryReady(),
};
importScripts('./quiet-emscripten.js');

let encoder, decoder, samplePtr, bytesPtr, rate, frameLength = maxPacket, txGain = 1;

function merge(base, extra) {
  const out = {...base};
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object'
      ? merge(base[key], value) : value;
  }
  return out;
}

// profile: undefined (default OFDM at the full 1200-byte frame), a quiet-profiles.json name, or
// {base, ...overrides} with nested objects deep-merged onto the base entry.
async function setup(hz, listen, spec, gain) {
  await initialized;
  const response = await fetch(new URL('./quiet-profiles.json', self.location.href));
  if (!response.ok) throw new Error('Sound profile could not be loaded.');
  const profiles = await response.json();
  let profile;
  if (spec === undefined || spec === null) profile = {...profiles['audible-7k-channel-0'], frame_length: maxPacket};
  else {
    const {base = 'audible-7k-channel-0', ...overrides} = typeof spec === 'string' ? {base: spec} : spec;
    if (!profiles[base]) throw new Error('Unknown sound profile ' + base + '.');
    profile = merge(profiles[base], overrides);
  }
  frameLength = Math.min(maxPacket, Number(profile.frame_length));
  profile.frame_length = frameLength;
  txGain = Number.isFinite(gain) && gain > 0 ? gain : 1;
  const config = Module.intArrayFromString(JSON.stringify({ photo: profile }));
  const name = Module.intArrayFromString('photo');
  function create(kind) {
    const opt = Module.ccall('quiet_' + kind + '_profile_str', 'number', ['array','array'], [config, name]);
    if (!opt) throw new Error('Sound profile could not be read.');
    try {
      const codec = Module['_quiet_' + kind + '_create'](opt, hz);
      if (!codec) throw new Error('The sound codec could not start.');
      return codec;
    } finally { Module._free(opt); }
  }
  rate = hz;
  encoder = create('encoder');
  if (listen) decoder = create('decoder');
  samplePtr = Module._malloc(block * 4);
  bytesPtr = Module._malloc(maxPacket);
  if (!samplePtr || !bytesPtr) throw new Error('The sound codec ran out of memory.');
}

function encode(bytes) {
  if (!encoder || !bytes.length || bytes.length > frameLength) throw new Error('Invalid sound packet size.');
  Module.HEAPU8.set(bytes, bytesPtr);
  if (Module._quiet_encoder_send(encoder, bytesPtr, bytes.length) !== bytes.length) throw new Error('Sound encoder is busy.');
  const chunks = [];
  let total = 0;
  for (;;) {
    const n = Module._quiet_encoder_emit(encoder, samplePtr, block);
    if (n <= 0) break;
    chunks.push(Module.HEAPF32.slice(samplePtr / 4, samplePtr / 4 + n));
    total += n;
    if (total > rate * 15) throw new Error('Sound packet is too long.');
  }
  if (!total) throw new Error('No sound was produced.');
  // Some audio routes mute the first 10 ms when a silent speaker starts.
  // Wake the route before the modem's synchronization symbols arrive, and
  // leave a short silent tail so the receiver can flush its filters.
  const lead = Math.ceil(rate * 0.04);
  const pcm = new Float32Array(lead + total + Math.ceil(rate * 0.025));
  for (let i = 0; i < lead; i++) {
    const envelope = Math.min(1, i / (rate * 0.004), (lead - 1 - i) / (rate * 0.004));
    pcm[i] = 0.05 * envelope * Math.sin(2 * Math.PI * 1800 * i / rate);
  }
  let offset = lead;
  let peak = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
    for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
  }
  // OFDM has a high crest factor. Lift this very quiet upstream profile to a
  // predictable peak without clipping or changing the relative carrier levels.
  if (peak > 0) {
    const gain = 0.72 / peak * txGain;
    for (let i = lead; i < lead + total; i++) pcm[i] *= gain;
  }
  return pcm;
}

function consume(input) {
  if (!decoder) return;
  for (let pos = 0; pos < input.length; pos += block) {
    const data = input.subarray(pos, pos + block);
    Module.HEAPF32.set(data, samplePtr / 4);
    Module._quiet_decoder_consume(decoder, samplePtr, data.length);
    for (;;) {
      const n = Module._quiet_decoder_recv(decoder, bytesPtr, maxPacket);
      if (n <= 0) break;
      const bytes = Module.HEAPU8.slice(bytesPtr, bytesPtr + n);
      self.postMessage({kind:'packet', bytes}, [bytes.buffer]);
    }
  }
}

self.onmessage = async ({data}) => {
  try {
    if (data.kind === 'init') {
      await setup(data.rate, data.listen, data.profile, data.txGain);
      self.postMessage({kind:'ready', maxPacket, frameLength});
    } else if (data.kind === 'encode') {
      const pcm = encode(data.bytes);
      self.postMessage({kind:'wave', id:data.id, pcm}, [pcm.buffer]);
    } else if (data.kind === 'consume') {
      consume(data.pcm);
      self.postMessage({kind:'consumed'});
    }
  } catch (error) {
    self.postMessage({kind:'error', id:data.id, message:error.message || String(error)});
  }
};
