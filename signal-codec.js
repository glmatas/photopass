import { deflateSync, inflateSync } from './vendor/qr-codecs.js';

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxSDP = 65536;
const marker = '\x1e';
const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A packet stores the exact line layout separately from high-entropy values.
// Compression can then match an entire run of SDP lines in this v2 dictionary.
// Unrecognized lines, field values, spellings and line endings remain literal.
const beforeCandidates = [
  'v=0', 'o=- ~8 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
];
const host = 'a=candidate:~4 1 udp 2113937151 ~U.local ~2 typ host generation 0 network-cost 999';
const srflx = 'a=candidate:~4 1 udp ~4 ~I ~2 typ srflx raddr ~I rport ~2 generation 0 network-cost 999';
const afterCandidates = [
  'a=ice-ufrag:~B', 'a=ice-pwd:~B', 'a=ice-options:trickle', 'a=fingerprint:sha-256 ~F',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
];
const dictionary = utf8.encode([
  ...beforeCandidates, host, ...afterCandidates,
  ...beforeCandidates, host, srflx, ...afterCandidates,
  'a=setup:active', 'a=setup:passive', 'a=end-of-candidates',
  'a=candidate:~4 1 udp ~4 ~6 ~2 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:~4 1 tcp ~4 ~U.local 9 typ host tcptype active generation 0',
  'a=candidate:0 1 UDP ~4 ~U.local ~2 typ host', 'c=IN IP4 ~I', 'c=IN IP6 ~6',
  'a=msid-semantic:WMS *', 'a=group:BUNDLE sdparta_0', 'a=mid:sdparta_0',
  'a=ice-options:trickle renomination', 'a=sendrecv', 'a=max-message-size:1073741823',
  'a=max-message-size:65536', 'a=ice-lite', 'm=application ~2 UDP/DTLS/SCTP webrtc-datachannel',
].join('\r\n').replaceAll('~', marker));

function requireValue(ok) {
  if (!ok) throw new Error('Invalid photo pairing packet.');
}

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
const uuidText = bytes => hex(bytes).replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');

// ICE credentials are sequences of alphabet symbols, not necessarily canonical
// Base64 strings. Pack all six bits of every character (even the last one).
function packCredential(value) {
  const bytes = [value.length];
  let acc = 0, bits = 0;
  for (const char of value) {
    acc = (acc << 6) | base64.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  if (bits) bytes.push((acc << (8 - bits)) & 255);
  return bytes;
}

function unpackCredential(reader) {
  const length = reader.byte();
  const bytes = reader.take(Math.ceil(length * 6 / 8));
  let text = '', acc = 0, bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6 && text.length < length) {
      bits -= 6;
      text += base64[(acc >> bits) & 63];
    }
  }
  return text;
}

function writeLength(target, value) {
  while (value >= 128) {
    target.push((value & 127) | 128);
    value >>>= 7;
  }
  target.push(value);
}

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  take(n) {
    requireValue(this.pos + n <= this.bytes.length);
    const start = this.pos;
    this.pos += n;
    return this.bytes.subarray(start, this.pos);
  }
  byte() { return this.take(1)[0]; }
  length() {
    let value = 0;
    for (let shift = 0; shift <= 14; shift += 7) {
      const b = this.byte();
      value += (b & 127) << shift;
      if (!(b & 128)) return value;
    }
    throw new Error('Invalid pairing length.');
  }
}

function ipv6Text(bytes) {
  const groups = hex(bytes).match(/.{4}/g);
  return new URL('http://[' + groups.join(':') + ']').hostname.slice(1, -1);
}

function ipv6Bytes(address) {
  if (!/^[0-9a-f:]+$/.test(address) || !address.includes(':')) return;
  const halves = address.split('::');
  if (halves.length > 2) return;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing) || [...left, ...right].some(g => !/^[0-9a-f]{1,4}$/.test(g))) return;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  const bytes = fromHex(groups.map(g => g.padStart(4, '0')).join(''));
  if (ipv6Text(bytes) === address) return bytes;
}

function layoutFor(sdp, values) {
  function field(code, bytes) {
    values.push(...bytes);
    return marker + code;
  }
  function integer(text, size) {
    if (!/^[1-9][0-9]{1,19}$/.test(text)) return text;
    const value = BigInt(text);
    if (value >= 1n << BigInt(size * 8)) return text;
    return field(String(size), fromHex(value.toString(16).padStart(size * 2, '0')));
  }
  function address(text) {
    if (text.endsWith('.local') && uuid.test(text.slice(0, -6))) {
      return field('U', fromHex(text.slice(0, -6).replaceAll('-', ''))) + '.local';
    }
    if (text === '0.0.0.0' || text === '127.0.0.1') return text;
    const octets = text.split('.');
    if (octets.length === 4 && octets.every(n => /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) < 256)) {
      return field('I', octets.map(Number));
    }
    const v6 = ipv6Bytes(text);
    return v6 ? field('6', v6) : text;
  }
  function line(body) {
    if (body.startsWith('o=')) return body.replace(/^(o=\S+ )(\d+)(?= )/, (_, prefix, id) => prefix + integer(id, 8));
    if (body.startsWith('m=application ')) return body.replace(/^m=application (\d+)/, (_, port) => 'm=application ' + integer(port, 2));
    if (body.startsWith('c=IN ')) return body.replace(/^(c=IN IP[46] )(\S+)$/, (_, prefix, ip) => prefix + address(ip));
    if (body.startsWith('a=ice-')) {
      return body.replace(/^(a=ice-(?:pwd|ufrag):)([A-Za-z0-9+/]{1,255})$/, (_, prefix, value) => prefix + field('B', packCredential(value)));
    }
    if (body.startsWith('a=fingerprint:sha-256 ')) {
      return body.replace(/^(a=fingerprint:sha-256 )((?:[A-F0-9]{2}:){31}[A-F0-9]{2})$/, (_, prefix, fp) => prefix + field('F', fromHex(fp.replaceAll(':', ''))));
    }
    if (body.startsWith('a=candidate:')) {
      return body.replace(/^(a=candidate:)(\S+) (\d+) (\S+) (\d+) (\S+) (\d+)(.*)$/, (_, prefix, f, component, transport, priority, ip, port, tail) => {
        // Read fields left-to-right so value bytes follow their markers in the layout.
        const first = prefix + integer(f, 4) + ' ' + component + ' ' + transport + ' ';
        const rank = priority === '2113937151' ? priority : integer(priority, 4);
        const endpoint = address(ip) + ' ' + integer(port, 2);
        return first + rank + ' ' + endpoint + tail.replace(/ (raddr|rport) (\S+)/g,
          (match, key, value) => ' ' + key + ' ' + (key === 'raddr' ? address(value) : integer(value, 2)));
      });
    }
    return body;
  }
  return sdp.replaceAll(marker, marker + '!').split('\n').map(raw => {
    const cr = raw.endsWith('\r');
    return line(cr ? raw.slice(0, -1) : raw) + (cr ? '\r' : '');
  }).join('\n');
}

function unpackField(code, reader) {
  switch (code) {
    case '!': return marker;
    case 'U': return uuidText(reader.take(16));
    case 'B': return unpackCredential(reader);
    case 'F': return hex(reader.take(32)).toUpperCase().match(/../g).join(':');
    case 'I': return reader.take(4).join('.');
    case '6': return ipv6Text(reader.take(16));
    case '2': case '4': case '8': return BigInt('0x' + hex(reader.take(Number(code)))).toString();
    default: throw new Error('Unknown pairing field.');
  }
}

export function encodeCompact(description, session) {
  const { type, sdp } = description ?? {};
  requireValue((type === 'offer' || type === 'answer') && typeof sdp === 'string' && /^v=0\r?\n/.test(sdp) &&
    sdp.length <= maxSDP && typeof session === 'string' && session.length && session.length <= 128);
  const original = utf8.encode(sdp);
  requireValue(original.length <= maxSDP && fromUtf8.decode(original) === sdp && fromUtf8.decode(utf8.encode(session)) === session);
  const values = [];
  const layout = utf8.encode(layoutFor(sdp, values));
  const compressed = deflateSync(layout, { dictionary, level: 9 });
  const payload = Uint8Array.from(values);
  const zippedValues = deflateSync(payload, { level: 6 });
  const useZip = zippedValues.length < payload.length;
  const header = [(type === 'answer' ? 1 : 0) | (useZip ? 2 : 0)];
  if (uuid.test(session)) {
    header.push(0, ...fromHex(session.replaceAll('-', '')));
  } else {
    const label = utf8.encode(session);
    writeLength(header, label.length);
    header.push(...label);
  }
  writeLength(header, compressed.length);
  const data = useZip ? zippedValues : payload;
  const bytes = new Uint8Array(header.length + compressed.length + data.length);
  bytes.set(header);
  bytes.set(compressed, header.length);
  bytes.set(data, header.length + compressed.length);
  return bytes;
}

export function decodeCompact(bytes, type) {
  requireValue(bytes instanceof Uint8Array && bytes.length <= 100000);
  const packet = new Reader(bytes);
  const flags = packet.byte();
  requireValue(flags <= 3 && type === (flags & 1 ? 'answer' : 'offer'));
  const length = packet.length();
  requireValue(length <= 512);
  const session = length ? fromUtf8.decode(packet.take(length)) : uuidText(packet.take(16));
  requireValue(session.length > 0 && session.length <= 128);
  const compressed = packet.take(packet.length());
  // Escaped marker bytes can at most double the size of a literal layout.
  const layout = fromUtf8.decode(inflateSync(compressed, { dictionary, out: new Uint8Array(maxSDP * 2 + 1) }));
  const payload = bytes.subarray(packet.pos);
  const data = new Reader(flags & 2 ? inflateSync(payload, { out: new Uint8Array(maxSDP + 1) }) : payload);
  const pieces = layout.split(marker);
  let sdp = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    sdp += unpackField(pieces[i][0], data) + pieces[i].slice(1);
    requireValue(sdp.length <= maxSDP);
  }
  requireValue(data.pos === data.bytes.length && /^v=0\r?\n/.test(sdp) && utf8.encode(sdp).length <= maxSDP);
  return { description: { type, sdp }, session };
}
