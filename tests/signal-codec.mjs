// Round-trips realistic pairing descriptions through the compact codec and
// checks that every ICE candidate survives byte for byte.
import assert from 'node:assert/strict';
import { decodeCompact, encodeCompact } from '../signal-codec.js';

const fingerprint = 'E4:5B:2A:F4:26:BD:BE:DC:81:21:AE:95:C8:25:8B:D1:31:03:3C:C7:99:7C:D8:02:D3:F9:E4:D5:78:3B:03:F4';
function sdp(setup, candidates, { origin = '4216477741168224783', eol = '\r\n' } = {}) {
  return [
    'v=0',
    `o=- ${origin} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...candidates.map(c => 'a=candidate:' + c),
    'a=ice-ufrag:ys/y',
    'a=ice-pwd:Tqt/wAAxzKhMAm53WM3tpTaV',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 ' + fingerprint,
    'a=setup:' + setup,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join(eol);
}

const chrome = [
  '652861253 1 udp 2113937151 192.168.1.23 50912 typ host generation 0 network-cost 999',
  '1876313031 1 udp 2113939711 2a02:8108:1240:4b00:1d2f:ec41:9a7:3c1e 50913 typ host generation 0 network-cost 999',
  '2999745851 1 udp 2113937151 1cb9aa39-3c3a-4e2f-b63d-42c9115a8cfe.local 50914 typ host generation 0 network-cost 999',
  '842163049 1 udp 1677729535 84.15.180.7 50912 typ srflx raddr 192.168.1.23 rport 50912 generation 0 network-cost 999',
  '842163050 1 udp 1677729535 84.15.180.7 61002 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  '3115346519 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-cost 999',
];
const safari = [
  '1407371391 1 udp 2122260223 10.0.0.42 63002 typ host generation 0 network-id 1 network-cost 10',
  '2427813895 1 udp 2122197247 fe80::1c3a:7cff:fe10:2b1d 49821 typ host generation 0 network-id 2 network-cost 10',
  '2427813896 1 udp 2122197247 2001:db8::7 49822 typ host generation 0 network-id 2 network-cost 10',
  '3405651147 1 udp 1686052607 100.64.12.9 63002 typ srflx raddr 10.0.0.42 rport 63002 generation 0 network-id 1 network-cost 10',
  '4051937285 1 udp 1685987071 2a00:1450:4001:82b::200e 49821 typ srflx raddr :: rport 0 generation 0 network-id 2 network-cost 900',
];
const odd = [
  '1 1 UDP 2130706431 172.17.0.1 40000 typ host',
  '2 1 udp 1845501695 203.0.113.9 40001 typ prflx raddr 172.17.0.1 rport 40000',
  '3 1 udp 41885439 198.51.100.20 3478 typ relay raddr 203.0.113.9 rport 40001',
  '4 1 tcp 1518214911 192.168.0.5 9 typ host tcptype passive',
  'abcd+/xyz 1 udp 2113937151 0.0.0.0 0 typ host',
];

const cases = [
  ['offer', sdp('actpass', chrome)],
  ['answer', sdp('active', chrome)],
  ['answer', sdp('active', safari)],
  ['answer', sdp('active', odd)],
  ['answer', sdp('active', chrome, { origin: '0' })],
  ['answer', sdp('active', safari, { eol: '\n' })],
  ['answer', sdp('active', [])],
];
for (const [type, text] of cases) {
  for (const session of ['a1b2c3d4', '6f1c2d6e-4d8c-4f5a-9e2b-1c3d4e5f6a7b']) {
    const bytes = encodeCompact({ type, sdp: text }, session);
    const back = decodeCompact(bytes, type);
    assert.equal(back.session, session);
    assert.equal(back.description.sdp, text, 'The codec must reproduce the SDP exactly.');
    const lines = s => s.split(/\r?\n/).filter(l => l.startsWith('a=candidate:'));
    assert.deepEqual(lines(back.description.sdp), lines(text));
  }
}
const sizes = cases.map(([type, text]) => encodeCompact({ type, sdp: text }, 'a1b2c3d4').length);
console.log('PASS signal codec round trip. Compact sizes (bytes):', sizes.join(', '));

// The phone trims its reply before encoding; it must keep every UDP candidate.
const { trimAnswer } = await import('../pickup-direct.js');
for (const list of [chrome, safari, odd]) {
  const text = sdp('active', list);
  const trimmed = trimAnswer(text);
  const udp = s => s.split(/\r?\n/).filter(l => /^a=candidate:\S+ \d+ udp /i.test(l))
    .map(l => l.replace(/(?: (?:generation|network-id|network-cost) \d+)+$/, ''));
  assert.deepEqual(udp(trimmed), udp(text));
  assert(!/^a=candidate:\S+ \d+ tcp /im.test(trimmed), 'TCP candidates are dropped when UDP ones exist.');
  assert.match(trimmed, /^o=- 0 2 IN IP4 /m);
  assert.equal(decodeCompact(encodeCompact({ type: 'answer', sdp: trimmed }, 'a1b2c3d4'), 'answer').description.sdp, trimmed);
}
const tcpOnly = sdp('active', [odd[3]]);
assert.match(trimAnswer(tcpOnly), /tcptype passive/, 'A TCP-only reply keeps its candidates.');
console.log('PASS reply trimming. Compact sizes before -> after:', [chrome, safari].map(list => {
  const text = sdp('active', list);
  return encodeCompact({ type: 'answer', sdp: text }, 'a1b2c3d4').length + ' -> ' + encodeCompact({ type: 'answer', sdp: trimAnswer(text) }, 'a1b2c3d4').length;
}).join(', '));
