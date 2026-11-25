# PhotoPass

PhotoPass delivers the original kiosk photo to a phone through its camera. The visitor opens a short pickup link and keeps the phone pointed at the moving square while the file arrives. Both devices can load the interface from the same static GitHub Pages site. The default transfer works across networks that block WebRTC.

## Pick up a photo

1. Open the kiosk page, allow camera access and select **Take photo**. Alternatively, choose an existing JPEG, PNG or WebP up to 32 MiB.
2. On the phone, scan **Scan to open** with the normal camera. Open the link and allow the page to use the rear camera.
3. Keep the whole moving square in view until the phone verifies the file. Select **Save photo**, or use the share sheet. On the kiosk, select **Next visitor** when the phone is finished.

The short link identifies the visitor’s photo. Each moving frame carries part of that file. Missed frames are recoverable, and the phone verifies the entire SHA-256 digest before saving. The kiosk can keep displaying the stream while several authorized viewers collect the same photo. A camera in view of an optical stream can read it.

### Speed and lighting

Allow several minutes for a 10 MB original. The standard setting can display up to 24 frames per second carrying up to 1,433 file bytes each. Even perfect capture needs about five minutes for 10 MB, before recovery overhead. Actual time depends on focus, motion, reflections, camera frame rate and decoder speed. The page estimates remaining time from observed progress.

**Enlarge moving code** fills more of the screen. Keep all four corners in view. **Use larger squares** also reduces the density and speed of the frames for cameras that struggle to focus. Changing square size restarts collection of the same photo. Keep both screens open until the phone shows the save button.

## Many kiosks, one receiver URL

Any number of independent sessions can use the same receiver path without reserving a room. A 96-bit prefix of the photo digest travels in the pickup link’s URL fragment and in every optical frame. A phone ignores frames for other photos, then checks the complete digest. The static host serves the application files. Photo data travels from the kiosk screen to the phone camera.

When several installations use a centrally hosted receiver, pass its HTTPS address to the kiosk’s existing capture handler:

```js
import { startPhotoSession } from './app.js';

await startPhotoSession(
  new File([jpegBlob], 'Photo.jpg', { type: 'image/jpeg' }),
  { receiverURL: 'https://glmatas.github.io/photopass/' }
);
```

The capture handler runs in a page with the PhotoPass interface. Omit the option to use the kiosk page’s own address. Concurrent sessions need no project-specific account, relay or credentials. Static host traffic and hosting limits still apply. [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

## Optional direct transfer

For faster delivery on networks that permit a direct WebRTC connection, select **Use direct transfer instead** on the kiosk, or open the kiosk page with `?direct`. In this mode, scan the kiosk QR and turn the phone’s reply code toward the kiosk camera. The kiosk scans the reply automatically after a camera capture. The browsers use public STUN to discover network addresses and transfer the file over an encrypted data channel. A restrictive venue or carrier network can still prevent this connection. Screen transfer works independently of STUN and TURN. [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections)

## Publish or run locally

Commit this folder’s contents, including the complete `vendor/` directory, to a repository. In **Settings → Pages**, publish the root of the branch. There is no build step, runtime CDN or application backend. A phone must be able to open the receiver’s HTTPS address. [GitHub Pages publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

For a local kiosk camera test with Python, run `python -m http.server 8080 --bind 127.0.0.1` from this folder and open `http://localhost:8080/`. For a separate phone, use a reachable receiver address as shown above.

The optical transport incorporates the pinned MIT-licensed Decimen v0.3.0 fountain-code implementation, QR rendering and a locally bundled ZXing decoder. Dependency notices are included in `vendor/`. [Decimen v0.3.0](https://github.com/bashalarmistalt/decimen-optical-transfer/tree/v0.3.0)
