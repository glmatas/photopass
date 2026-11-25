var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// work/decimen-v03/shared/protocol.ts
var HEADER_LEN = 20;
var MAX_FILE_BYTES = 64 * 1024 * 1024;
var MAX_FILE_LABEL = `${MAX_FILE_BYTES / 1024 / 1024} MB`;
var FILE_HEADER_LEN = 49;
var MAGIC0 = 209;
var MAGIC1 = 12;
var FILE_MAGIC = new Uint8Array([68, 67, 70, 50]);
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
async function digest(bytes) {
  const stableBytes = Uint8Array.from(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes));
}
async function gzipAsync(bytes) {
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
async function gunzipAsync(bytes, maxBytes) {
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = inflated.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The recovered file expands past its declared length.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function safeFileName(name) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "transfer.bin" : cleaned;
}
var PRECOMPRESSED_TYPES = /* @__PURE__ */ new Set([
  "application/gzip",
  "application/java-archive",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-brotli",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-lzma",
  "application/x-rar-compressed",
  "application/x-xz",
  "application/x-zip-compressed",
  "application/zip",
  "application/zstd"
]);
var COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/;
var COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/;
function isPrecompressedType(type) {
  const media = type.split(";")[0].trim().toLowerCase();
  if (media.startsWith("video/")) return true;
  if (media.startsWith("image/")) return !COMPRESSIBLE_IMAGES.test(media);
  if (media.startsWith("audio/")) return !COMPRESSIBLE_AUDIO.test(media);
  if (media.startsWith("application/vnd.openxmlformats-officedocument.")) return true;
  if (media.startsWith("application/vnd.oasis.opendocument.")) return true;
  if (media.endsWith("+zip")) return true;
  return PRECOMPRESSED_TYPES.has(media);
}
async function packFile(name, type, bytes) {
  if (bytes.length === 0) throw new Error("Choose a non-empty file.");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Files are limited to ${MAX_FILE_LABEL} in this browser build.`);
  }
  const nameBytes = textEncoder.encode(safeFileName(name));
  const typeBytes = textEncoder.encode(type || "application/octet-stream");
  if (nameBytes.length > 65535 || typeBytes.length > 65535) {
    throw new Error("The file name or media type is too long.");
  }
  const tryGzip = bytes.length >= 768 && !isPrecompressedType(type);
  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    tryGzip ? gzipAsync(bytes) : Promise.resolve(void 0)
  ]);
  const useGzip = compressed !== void 0 && compressed.length + 64 < bytes.length;
  const transmitted = useGzip ? compressed : bytes;
  const compression = useGzip ? "gzip" : "none";
  const out = new Uint8Array(
    FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length
  );
  const view = new DataView(out.buffer);
  out.set(FILE_MAGIC, 0);
  view.setUint8(4, useGzip ? 1 : 0);
  view.setUint16(5, nameBytes.length, true);
  view.setUint16(7, typeBytes.length, true);
  view.setUint32(9, bytes.length, true);
  view.setUint32(13, transmitted.length, true);
  out.set(sha256, 17);
  out.set(nameBytes, FILE_HEADER_LEN);
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
  out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);
  return {
    container: out,
    compression,
    originalSize: bytes.length,
    transmittedSize: transmitted.length
  };
}
async function unpackFile(container) {
  if (container.length < FILE_HEADER_LEN) throw new Error("The recovered file header is incomplete.");
  for (let i = 0; i < FILE_MAGIC.length; i++) {
    if (container[i] !== FILE_MAGIC[i]) throw new Error("The recovered file header is invalid.");
  }
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(4);
  if (compressionByte > 1) throw new Error("The recovered file uses unsupported compression.");
  const compression = compressionByte === 1 ? "gzip" : "none";
  const nameLength = view.getUint16(5, true);
  const typeLength = view.getUint16(7, true);
  const fileLength = view.getUint32(9, true);
  const transmittedLength = view.getUint32(13, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  if (fileLength === 0 || fileLength > MAX_FILE_BYTES || transmittedLength === 0 || transmittedLength > MAX_FILE_BYTES || dataOffset + transmittedLength !== container.length) {
    throw new Error("The recovered file length does not match its header.");
  }
  const transmitted = container.slice(dataOffset);
  if (compression === "gzip") {
    if (transmitted.length < 18) throw new Error("The recovered gzip payload is incomplete.");
    const trailer = new DataView(
      transmitted.buffer,
      transmitted.byteOffset + transmitted.byteLength - 4,
      4
    );
    if (trailer.getUint32(0, true) !== fileLength) {
      throw new Error("The gzip payload length does not match its file header.");
    }
  }
  const bytes = compression === "gzip" ? await gunzipAsync(transmitted, fileLength) : transmitted;
  if (bytes.length !== fileLength) {
    throw new Error("The decompressed file length does not match its header.");
  }
  return {
    name: safeFileName(
      textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))
    ),
    type: textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) || "application/octet-stream",
    sha256: container.slice(17, 49),
    bytes,
    compression,
    transmittedSize: transmittedLength
  };
}
async function verifyFile(file) {
  const actual = await digest(file.bytes);
  return actual.every((value, index) => value === file.sha256[index]);
}
function packFrame(h, block) {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}
function parseFrame(bytes) {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    sessionId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    k: dv.getUint16(8, true),
    blockLen: dv.getUint16(10, true),
    totalLen: dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true)
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}
function streamIdentity(h) {
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}`;
}
function fnv1a(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function splitmix32(seed) {
  let s = seed | 0;
  return () => {
    s = s + 2654435769 | 0;
    let t = s ^ s >>> 16;
    t = Math.imul(t, 569420461);
    t ^= t >>> 15;
    t = Math.imul(t, 1935289751);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

// work/decimen-v03/shared/fountain.ts
var LN2 = 0.6931471805599453;
function dlog(x) {
  let e = 0;
  let m = x;
  while (m >= 1.5) {
    m /= 2;
    e++;
  }
  while (m < 0.75) {
    m *= 2;
    e--;
  }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 1; n <= 21; n += 2) {
    sum += term / n;
    term *= z2;
  }
  return e * LN2 + 2 * sum;
}
var SOLITON_C = 0.1;
var SOLITON_DELTA = 0.5;
function solitonCdf(k) {
  const cdf = new Float64Array(k);
  if (k === 1) {
    cdf[0] = 1;
    return cdf;
  }
  const R = Math.max(1, SOLITON_C * dlog(k / SOLITON_DELTA) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / R));
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * k);
    else if (d === spike) tau = R * Math.max(0, dlog(R / SOLITON_DELTA)) / k;
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let i = 0; i < k; i++) cdf[i] = cdf[i] / total;
  cdf[k - 1] = 1;
  return cdf;
}
function frameSeed(sessionId, seq) {
  let h = Math.imul(sessionId + 1, 2654435761) ^ seq + 2246822507 | 0;
  h = Math.imul(h ^ h >>> 13, 3266489909);
  return h ^ h >>> 16 | 0;
}
function frameIndices(k, cdf, sessionId, seq) {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const u = rnd() * 2 ** -32;
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (cdf[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  const d = Math.min(k, lo + 1);
  if (d > k >> 3) {
    const scratch = new Uint32Array(k);
    for (let i = 0; i < k; i++) scratch[i] = i;
    const out = new Array(d);
    for (let i = 0; i < d; i++) {
      const j = i + rnd() % (k - i);
      const t = scratch[i];
      scratch[i] = scratch[j];
      scratch[j] = t;
      out[i] = scratch[i];
    }
    return out;
  }
  const set = /* @__PURE__ */ new Set();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}
function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i] ^ src[i]) >>> 0;
}
var LTEncoder = class {
  constructor(payload, blockLen, sessionId) {
    this.blockLen = blockLen;
    this.sessionId = sessionId;
    __publicField(this, "k");
    __publicField(this, "words");
    __publicField(this, "blocks");
    __publicField(this, "cdf");
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.k; b++) {
      const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
      bytes.set(src, b * this.words * 4);
    }
    this.cdf = solitonCdf(this.k);
  }
  encode(seq) {
    const idx = frameIndices(this.k, this.cdf, this.sessionId, seq);
    const out = new Uint32Array(this.words);
    for (const b of idx) {
      const off = b * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w] ^ this.blocks[off + w]) >>> 0;
    }
    return new Uint8Array(out.buffer, 0, this.blockLen);
  }
};
var LTDecoder = class {
  constructor(k, blockLen, sessionId, totalLen) {
    this.k = k;
    this.blockLen = blockLen;
    this.sessionId = sessionId;
    this.totalLen = totalLen;
    __publicField(this, "words");
    __publicField(this, "cdf");
    __publicField(this, "solved");
    __publicField(this, "byBlock", /* @__PURE__ */ new Map());
    __publicField(this, "seen", /* @__PURE__ */ new Set());
    __publicField(this, "solvedCount", 0);
    __publicField(this, "framesNew", 0);
    __publicField(this, "framesDup", 0);
    this.words = Math.ceil(blockLen / 4);
    this.cdf = solitonCdf(k);
    this.solved = new Array(k).fill(null);
  }
  get isComplete() {
    return this.solvedCount >= this.k;
  }
  addFrame(seq, block) {
    if (this.seen.has(seq)) {
      this.framesDup++;
      return;
    }
    this.seen.add(seq);
    this.framesNew++;
    if (this.isComplete) return;
    const idx = new Set(frameIndices(this.k, this.cdf, this.sessionId, seq));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) {
        xorInto(words, s);
        idx.delete(b);
      }
    }
    if (idx.size === 0) return;
    if (idx.size === 1) {
      this.resolve(idx.values().next().value, words);
      return;
    }
    const pf = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.byBlock.set(b, set);
      }
      set.add(pf);
    }
  }
  /** Peeling cascade: solve a block, reduce every frame waiting on it, repeat.
   * Note for progress UX: this cascade back-loads — blocks solved hockey-
   * sticks near the end while frame ARRIVAL is linear. Show frames collected,
   * not blocks solved, or your progress bar will look stalled then teleport. */
  resolve(b0, w0) {
    const queue = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop();
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }
  assemble() {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * this.blockLen;
      const len = Math.min(this.blockLen, this.totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b].buffer, 0, len), start);
    }
    return out;
  }
};
export {
  HEADER_LEN,
  LTDecoder,
  LTEncoder,
  fnv1a,
  packFile,
  packFrame,
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile
};
