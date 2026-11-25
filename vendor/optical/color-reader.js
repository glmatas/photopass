import './reader-worker.js';

// The same ZXing worker can read the second QR after projecting warm and
// cool colors to grayscale. Neutral surroundings become the white quiet zone.
const read = self.onmessage;
self.onmessage = event => {
  const rgba = new Uint8ClampedArray(event.data.buf);
  for (let i = 0; i < rgba.length; i += 4) {
    const value = rgba[i + 2] - rgba[i] > 10 ? 0 : 255;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
  }
  return read(event);
};
