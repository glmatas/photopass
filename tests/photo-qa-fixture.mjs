// Use a valid JPEG with legal comment segments to reach an exact file size.
// Each image has visibly different pixels, a different name and a distinct hash.
export async function choosePhoto(options) {
  const index = typeof options === 'number' ? options : options.index;
  const size = typeof options === 'number' ? 10_000_000 : options.size;
  const canvas = document.createElement('canvas');
  const textured = options.textured && size > 2_000_000;
  canvas.width = textured ? 2048 : 320 + index;
  canvas.height = textured ? 1536 : 240;
  const context = canvas.getContext('2d');
  context.fillStyle = ['#245847', '#8e3929', '#325e9d', '#c7b45b'][index];
  context.fillRect(0, 0, canvas.width, canvas.height);
  let seed = 123456789;
  function noise() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 24;
  }
  if (textured) {
    const image = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i+=4) {
      image.data[i] = noise(); image.data[i+1] = noise(); image.data[i+2] = noise(); image.data[i+3] = 255;
    }
    context.putImageData(image,0,0);
  }
  context.fillStyle = '#fff';
  context.font = '32px sans-serif';
  context.fillText('Kiosk ' + (index + 1), 36, 70);
  const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', textured ? 0.80 : undefined));
  if (jpeg.size > size) throw Error('Fixture is larger than its target size.');
  const original = new Uint8Array(await jpeg.arrayBuffer());
  const parts = [original.slice(0, 2)];
  let remaining = size - original.length;
  while (remaining > 0) {
    let length = Math.min(remaining, 65000);
    if (remaining > length && remaining - length < 4) length -= 4;
    const segment = new Uint8Array(length).fill(index + 1);
    if (textured) for(let j=4;j<length;j++) segment[j]=noise();
    segment.set([255, 254, (length - 2) >> 8, (length - 2) & 255]);
    parts.push(segment);
    remaining -= length;
  }
  parts.push(original.slice(2));
  const file = new File(parts, 'Portrait-' + (index + 1) + '.jpg', { type: 'image/jpeg' });
  const selection = new DataTransfer();
  selection.items.add(file);
  const input = document.getElementById('file-input');
  input.files = selection.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return { name: file.name, size, width: canvas.width, hash: Array.from(new Uint8Array(bytes)).join(',') };
}

export async function savedPhoto() {
  const link = document.getElementById('save-link');
  const image = document.getElementById('received-image');
  await image.decode();
  const bytes = await (await fetch(link.href)).arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return { name: link.download, size: bytes.byteLength, width: image.naturalWidth, hash: Array.from(new Uint8Array(hash)).join(',') };
}
