// Separate overlapping requests on the same preview, including permission
// prompts that outlive a switch to another camera.
const previews = new WeakMap();

export async function openCapture(video, deviceId, signal) {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    throw new Error('Camera access requires HTTPS and a browser that supports video capture.');
  }

  previews.get(video)?.stop();
  let stream;
  let stopped = false;
  function stop() {
    stopped = true;
    signal?.removeEventListener('abort', stop);
    if (previews.get(video)?.stop === stop) previews.delete(video);
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
      video.hidden = true;
    }
  }
  previews.set(video, { stop });
  signal?.addEventListener('abort', stop, { once: true });
  const selection = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'user' } };
  const constraints = { width: { ideal: 2560 }, height: { ideal: 1920 }, ...selection };
  try {
    if (signal?.aborted) throw new DOMException('Camera request canceled.', 'AbortError');
    try {
      stream = await media.getUserMedia({ audio: false, video: constraints });
    } catch (error) {
      if (stopped || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
      // A previously selected device may have been unplugged.
      stream = await media.getUserMedia({ audio: false, video: true });
    }
    if (stopped) throw new DOMException('Camera selection changed.', 'AbortError');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    video.hidden = false;
    await video.play();

    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error('The camera is no longer available.');
    const actualId = track.getSettings?.().deviceId || '';
    let devices = [];
    if (media.enumerateDevices) {
      try {
        devices = (await media.enumerateDevices()).filter(device => device.kind === 'videoinput');
      } catch { /* The active camera still works if enumeration is restricted. */ }
    }
    if (stopped || video.srcObject !== stream) throw new DOMException('Camera selection changed.', 'AbortError');
    return { stop, deviceId: actualId, devices };
  } catch (error) {
    stop();
    throw error;
  }
}

export async function takePhoto(video) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error('Wait for the camera preview, then take the photo.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('The browser could not capture this photo.');
  // Drawing the native frame preserves camera orientation regardless of preview CSS.
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.96));
  if (!blob?.size || blob.type !== 'image/jpeg') throw new Error('The browser could not save a JPEG. Try again.');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new File([blob], 'Photo-' + timestamp + '.jpg', { type: 'image/jpeg' });
}
