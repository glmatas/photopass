// Rectify a version-40 color plane using the brightness QR's four corners
// in this capture. Each output module is a decision at the center of a cell.
const size = 177, margin = 4, scale = 3;
export function sampleColor(input, w, h, quad, green) {
  const {topLeft:p, topRight:q, bottomRight:r, bottomLeft:s} = quad;
  const dx = q.x - r.x, dy = q.y - r.y, ex = s.x - r.x, ey = s.y - r.y;
  const tx = p.x - q.x + r.x - s.x, ty = p.y - q.y + r.y - s.y;
  const determinant = dx * ey - dy * ex;
  if (Math.abs(determinant) < 1) return;
  const g = (tx * ey - ty * ex) / determinant, j = (dx * ty - dy * tx) / determinant;
  const ax = q.x - p.x + g * q.x, bx = s.x - p.x + j * s.x;
  const ay = q.y - p.y + g * q.y, by = s.y - p.y + j * s.y;
  const values = new Float32Array(size * size);
  function opponent(i) {
    return green ? input[i] + input[i + 2] - 2 * input[i + 1] : input[i + 2] - input[i];
  }
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, inv = 1 / (1 + g * u + j * v);
      const fx = (ax * u + bx * v + p.x) * inv - 0.5, fy = (ay * u + by * v + p.y) * inv - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < 0 || iy < 0 || ix + 1 >= w || iy + 1 >= h) return;
      const i = (iy * w + ix) * 4, k = i + w * 4, a = fx - ix, b = fy - iy;
      values[y * size + x] = (1 - b) * ((1 - a) * opponent(i) + a * opponent(i + 4))
        + b * ((1 - a) * opponent(k) + a * opponent(k + 4));
    }
  }
  // The known black and white rings in the three finder patterns estimate
  // the color split after white balance and the camera's color processing.
  let dark = 0, light = 0;
  for (const [ox, oy] of [[0,0],[size-7,0],[0,size-7]]) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      const val = values[(oy + y) * size + ox + x];
      if (d === 2) light += val; else dark += val;
    }
  }
  const threshold = (dark / 99 + light / 48) / 2;
  const side = (size + 2 * margin) * scale;
  const rgba = new Uint8ClampedArray(side * side * 4);
  const pixels = new Uint32Array(rgba.buffer);
  pixels.fill(0xffffffff);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = size * y + x;
    let value = values[i];
    if (x && y && x + 1 < size && y + 1 < size) {
      const neighbors = values[i-1] + values[i+1] + values[i-size] + values[i+size];
      value += 0.7 * (value - neighbors * 0.25);
    }
    if (value <= threshold) continue;
    let out = ((y + margin) * side + x + margin) * scale;
    for (let n = 0; n < scale; n++, out += side) pixels.fill(0xff000000, out, out + scale);
  }
  return {buf:rgba.buffer, w:side, h:side};
}
