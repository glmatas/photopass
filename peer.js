const TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const MAX_BYTES = 32 * 1024 * 1024;
const CHUNK = 16 * 1024;
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
const GATHER_MS = 8000;
const EXTRA_GATHER_MS = 8000;
const IDLE_MS = 60000;
const UNREACHABLE = "A direct connection could not be established. The mobile or venue network may block it.";

function requireSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) {
    throw new Error("Choose a photo between 1 byte and 32 MiB.");
  }
}

function detectedType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new Error("Choose a JPEG, PNG, or WebP photo.");
}

function photoName(name, type) {
  const leaf = String(name || "Photo").split(/[\\/]/).pop();
  const stem = leaf.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N} ._-]/gu, "_")
    .replace(/^[. ]+|[. ]+$/g, "").slice(0, 90);
  return (stem || "Photo") + "." + TYPES.get(type);
}

async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}

function checkDescription(description, type) {
  const sdp = description?.sdp;
  if (description?.type !== type || typeof sdp !== "string" || sdp.length > 65536 ||
      !/^m=application /m.test(sdp) || /^m=(?!application )/m.test(sdp)) {
    throw new Error("This pairing code does not contain the expected photo-transfer details.");
  }
  return { type, sdp };
}

// Some browsers emit a candidate before exposing it in localDescription. A QR
// is a single exchange, so include event-only candidates for this data section.
function gatheredDescription(session) {
  const desc = session.pc.localDescription;
  if (!desc) throw new Error("The browser has not prepared its connection details.");
  const eol = desc.sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = desc.sdp.split(eol);
  const start = lines.findIndex(line => line.startsWith("m=application "));
  if (start < 0) throw new Error("The browser did not create a photo data channel.");
  const nextMedia = lines.findIndex((line, i) => i > start && line.startsWith("m="));
  const end = nextMedia < 0 ? lines.length : nextMedia;
  const section = lines.slice(start, end);
  const mid = section.find(line => line.startsWith("a=mid:"))?.slice(6);
  const ufrag = (section.find(line => line.startsWith("a=ice-ufrag:")) ||
    lines.slice(0, start).find(line => line.startsWith("a=ice-ufrag:")))?.slice(12);
  const mediaIndex = lines.slice(0, start).filter(line => line.startsWith("m=")).length;
  // The username fragment may be present only in the event's serialization.
  const key = line => line.replace(/ ufrag \S+/gi, "").trim();
  const known = new Set(section.filter(line => line.startsWith("a=candidate:")).map(key));
  const additions = [];
  for (const candidate of session.candidates) {
    if ((candidate.sdpMid != null && mid != null && candidate.sdpMid !== mid) ||
        (candidate.sdpMLineIndex != null && candidate.sdpMLineIndex !== mediaIndex) ||
        (candidate.usernameFragment && ufrag && candidate.usernameFragment !== ufrag)) continue;
    const raw = candidate.candidate;
    if (typeof raw !== "string" || !raw.startsWith("candidate:") || /[\r\n]/.test(raw)) continue;
    const line = "a=" + raw.trim();
    if (!known.has(key(line))) { additions.push(line); known.add(key(line)); }
  }
  if (!additions.length) return { type: desc.type, sdp: desc.sdp };
  const marker = section.findIndex(line => line === "a=end-of-candidates" || !line);
  lines.splice(marker < 0 ? end : start + marker, 0, ...additions);
  return { type: desc.type, sdp: lines.join(eol) };
}

function gather(session) {
  const { pc, signal } = session;
  return new Promise((resolve, reject) => {
    let timer, completionTimer;
    function finish() {
      clearTimeout(timer);
      clearTimeout(completionTimer);
      pc.removeEventListener("icecandidate", changed);
      pc.removeEventListener("icegatheringstatechange", changed);
      pc.onicecandidate = null;
      signal.removeEventListener("abort", finish);
      if (signal.aborted) return reject(new Error("Transfer canceled."));
      try {
        const desc = gatheredDescription(session);
        // An answerer can initiate checks against the offer even when its own
        // browser exposes no candidates (peer-reflexive discovery, RFC 8863 §3.1).
        if (session.role === "sender" && !/^a=candidate:/m.test(desc.sdp)) {
          throw new Error("The browser could not find a network address for pairing.");
        }
        resolve(desc);
      } catch (error) {
        reject(error);
      }
    }
    function changed() {
      if (pc.iceGatheringState === "complete" || session.gatheringEnded) {
        // Let the final queued candidate event update the SDP or event list.
        completionTimer ??= setTimeout(finish, 60);
      }
    }
    if (session.quickGather) timer = setTimeout(finish, 3500);
    else timer = setTimeout(() => {
      const hasMapped = / typ (?:srflx|prflx)\b/i.test(pc.localDescription?.sdp || "") ||
        session.candidates.some(c => / typ (?:srflx|prflx)\b/i.test(c.candidate));
      if (hasMapped) finish();
      else timer = setTimeout(finish, EXTRA_GATHER_MS);
    }, GATHER_MS);
    pc.addEventListener("icecandidate", changed);
    pc.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
    else changed();
  });
}

function waitForBuffer(session) {
  const { channel, signal } = session;
  return new Promise((resolve, reject) => {
    function check() {
      if (!signal.aborted && channel.readyState === "open" && channel.bufferedAmount > LOW_WATER) return;
      channel.removeEventListener("bufferedamountlow", check);
      channel.removeEventListener("close", check);
      signal.removeEventListener("abort", check);
      if (signal.aborted || channel.readyState !== "open") reject(new Error("Transfer interrupted."));
      else resolve();
    }
    channel.addEventListener("bufferedamountlow", check);
    channel.addEventListener("close", check);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

export class PhotoPeer {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.session = null;
  }

  close() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    clearTimeout(s.timer);
    clearTimeout(s.disconnectTimer);
    s.controller.abort();
    s.pc.onicecandidate = null;
    s.channel?.close();
    s.pc.close();
  }

  // A short field-diagnosis code: connection states and candidate counts.
  // Candidate kinds: h4/h6 = raw IPv4/IPv6 host, hm = mDNS host, s = server
  // reflexive, p = peer reflexive, r = relay; a trailing t marks TCP.
  describe() {
    const pc = this.session?.pc;
    if (!pc) return "";
    const kinds = sdp => {
      const counts = {};
      for (const [, transport, address, type] of (sdp || "").matchAll(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\w+)/gim)) {
        const kind = (type === "host" ? (address.endsWith(".local") ? "hm" : address.includes(":") ? "h6" : "h4") : type[0]) +
          (/^tcp$/i.test(transport) ? "t" : "");
        counts[kind] = (counts[kind] || 0) + 1;
      }
      return Object.entries(counts).map(([kind, n]) => kind + "=" + n).join(" ") || "none";
    };
    return "ice " + pc.iceConnectionState + ", dtls " + (pc.sctp?.transport?.state ?? "-") +
      ", local " + kinds(pc.localDescription?.sdp) + ", remote " + kinds(pc.remoteDescription?.sdp);
  }

  _fail(s, message) {
    if (this.session !== s || s.phase === "done") return;
    const phase = s.phase === "pairing" ? "pairing" : "transfer";
    const detail = this.describe();
    this.close();
    this.callbacks.onFailure?.(message, phase, detail);
  }

  _deadline(s, ms, message) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this._fail(s, message), ms);
  }

  _start(role) {
    this.close();
    if (!globalThis.RTCPeerConnection || !globalThis.crypto?.subtle) {
      throw new Error("Open this page in a WebRTC-capable browser over HTTPS or localhost.");
    }
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ] });
    const controller = new AbortController();
    const s = { pc, role, controller, signal: controller.signal, phase: "pairing", candidates: [] };
    this.session = s;
    pc.onicecandidate = event => {
      if (event.candidate === null) s.gatheringEnded = true;
      else if (event.candidate?.candidate) s.candidates.push(event.candidate);
    };
    const networkChanged = () => {
      if (this.session !== s || s.phase === "done") return;
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === "failed" || pc.iceConnectionState === "failed") {
        return this._fail(s, s.phase === "pairing" ? UNREACHABLE : "The direct connection was lost during the photo transfer.");
      }
      // A transient disconnect before the kiosk receives the reply is covered
      // by the pairing deadline; it does not start a transfer-stall timer.
      if (s.phase !== "pairing" && (state === "disconnected" || pc.iceConnectionState === "disconnected")) {
        s.disconnectTimer ??= setTimeout(() => this._fail(s, "The connection was interrupted."), 12000);
      } else {
        clearTimeout(s.disconnectTimer);
        s.disconnectTimer = null;
      }
    };
    pc.onconnectionstatechange = networkChanged;
    pc.oniceconnectionstatechange = networkChanged;
    return s;
  }

  async offer(file, { quickGather = false } = {}) {
    requireSize(file?.size);
    const s = this._start("sender");
    s.quickGather = quickGather;
    try {
      const type = detectedType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
      s.file = file;
      s.type = type;
      s.name = photoName(file.name, type);
      this._channel(s, s.pc.createDataChannel("photo-v1", { ordered: true }));
      await s.pc.setLocalDescription(await s.pc.createOffer());
      const desc = await gather(s);
      this._deadline(s, 180000, "This pairing code expired. Start a new session for this visitor.");
      return desc;
    } catch (error) {
      if (this.session === s) this.close();
      throw error;
    }
  }

  async answer(offer, { quickGather = false } = {}) {
    const remote = checkDescription(offer, "offer");
    const s = this._start("receiver");
    s.quickGather = quickGather;
    try {
      s.pc.ondatachannel = event => {
        if (this.session !== s || s.channel || event.channel.label !== "photo-v1") return event.channel.close();
        this._channel(s, event.channel);
      };
      await s.pc.setRemoteDescription(remote);
      await s.pc.setLocalDescription(await s.pc.createAnswer());
      const desc = await gather(s);
      if (s.phase === "pairing") this._deadline(s, 180000, "Pairing timed out. Start again at the kiosk.");
      return desc;
    } catch (error) {
      if (this.session === s) this.close();
      throw error;
    }
  }

  async accept(answer) {
    const s = this.session;
    if (!s || s.role !== "sender") throw new Error("Prepare a photo on the kiosk first.");
    await s.pc.setRemoteDescription(checkDescription(answer, "answer"));
    if (this.session === s && s.phase === "pairing") {
      this._deadline(s, 45000, UNREACHABLE);
      this.callbacks.onState?.("Connecting directly…");
    }
  }

  _channel(s, channel) {
    s.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    const opened = () => {
      if (this.session !== s || s.phase !== "pairing") return;
      s.phase = s.role === "sender" ? "sending" : "waiting";
      this._deadline(s, IDLE_MS, "The transfer stopped responding.");
      this.callbacks.onState?.(s.role === "sender" ? "Sending photo…" : "Receiving photo…");
      if (s.role === "sender") this._send(s).catch(e => this._fail(s, e.message));
    };
    channel.onopen = opened;
    channel.onclose = () => this._fail(s, s.phase === "pairing" ? UNREACHABLE : "The other device closed the connection.");
    channel.onerror = () => this._fail(s, s.phase === "pairing" ? UNREACHABLE : "The data connection was interrupted.");
    channel.onmessage = event => {
      if (this.session !== s || s.phase === "done") return;
      this._receive(s, event.data).catch(e => this._fail(s, e.message));
    };
    if (channel.readyState === "open") opened();
  }

  async _send(s) {
    const bytes = await s.file.arrayBuffer();
    s.hash = await digest(bytes);
    if (this.session !== s) return;
    s.channel.send(JSON.stringify({ kind: "photo", name: s.name, type: s.type, size: bytes.byteLength, hash: s.hash }));
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
      if (s.channel.bufferedAmount >= HIGH_WATER) await waitForBuffer(s);
      if (this.session !== s) return;
      const size = Math.min(CHUNK, bytes.byteLength - i);
      s.channel.send(new Uint8Array(bytes, i, size));
      this._deadline(s, IDLE_MS, "The transfer stopped responding.");
      this.callbacks.onProgress?.((i + size) / bytes.byteLength);
    }
    s.phase = "awaiting-ack";
    s.channel.send(JSON.stringify({ kind: "end" }));
    this.callbacks.onState?.("Waiting for photo verification…");
  }

  async _receive(s, data) {
    if (typeof data !== "string") {
      if (s.phase !== "receiving" || !(data instanceof ArrayBuffer) ||
          data.byteLength !== Math.min(CHUNK, s.meta.size - s.received) || !data.byteLength) {
        throw new Error("The photo arrived with an invalid chunk.");
      }
      s.parts.push(data);
      s.received += data.byteLength;
      this._deadline(s, IDLE_MS, "The transfer stopped responding.");
      this.callbacks.onProgress?.(s.received / s.meta.size);
      return;
    }
    if (data.length > 2048) throw new Error("The transfer details were invalid.");
    const m = JSON.parse(data);
    if (s.phase === "awaiting-ack" && m?.kind === "ack" && m.hash === s.hash) {
      s.phase = "done";
      clearTimeout(s.timer);
      this.callbacks.onSent?.();
      return;
    }
    if (s.phase === "waiting" && m?.kind === "photo") {
      requireSize(m.size);
      if (!TYPES.has(m.type) || typeof m.name !== "string" || !/^[0-9a-f]{64}$/.test(m.hash)) {
        throw new Error("The sender provided invalid photo details.");
      }
      s.phase = "receiving";
      s.meta = m;
      s.parts = [];
      s.received = 0;
      return;
    }
    if (s.phase !== "receiving" || m?.kind !== "end" || s.received !== s.meta.size) {
      throw new Error("The photo transfer was incomplete.");
    }
    s.phase = "verifying";
    this.callbacks.onState?.("Verifying photo…");
    const blob = new Blob(s.parts, { type: s.meta.type });
    s.parts = null;
    const bytes = await blob.arrayBuffer();
    const type = detectedType(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)));
    if (type !== s.meta.type || await digest(bytes) !== s.meta.hash) {
      throw new Error("The photo failed its integrity check. Start a new transfer.");
    }
    if (this.session !== s) return;
    s.channel.send(JSON.stringify({ kind: "ack", hash: s.meta.hash }));
    s.phase = "done";
    clearTimeout(s.timer);
    this.callbacks.onPhoto?.(blob, photoName(s.meta.name, type), s.meta.hash);
  }
}
