# PhotoPass

PhotoPass delivers the original kiosk photo to a phone. By default, the visitor opens a short pickup link and keeps the phone camera pointed at a moving square while the file arrives. Both devices can load the interface from the same static GitHub Pages site. A camera-free pickup uses the kiosk speaker and the phone microphone.

## Pick up a photo

1. On the kiosk, select **Take photo**. The pickup QR appears automatically. For an existing JPEG, PNG or WebP up to 32 MiB, choose the file and select **Show pickup code**.
2. On the phone, scan the QR, open the link and allow camera access. Keep the phone pointed at that same square. The photo appears automatically once the original file is verified.
3. To keep a copy, select **Save photo** or use the share sheet. The kiosk operator can select **Next visitor** when pickup is finished.

Allow the kiosk microphone during setup for the quickest start. PhotoPass prefers a microphone in the selected camera's device group. If the browser provides no group, it can pick a uniquely labelled Brio microphone or use the system input. Logitech lists two built-in microphones for the Brio 4K. [Brio 4K specifications](https://secure.logitech.com/content/dam/logitech/en/video-collaboration/pdf/brio-datasheet.pdf) · [Media Capture device groups](https://www.w3.org/TR/mediacapture-streams/)

Once the phone's rear camera is running, the page tries to play a short ready tone identifying this pickup. A matching reply starts the moving square immediately. The camera collects the photo while the browsers try a faster direct data channel. To pair, the kiosk briefly includes its connection offer in the moving square and the phone answers through its speaker. The first verified original appears on the phone. Guests grant only camera access and can hold the phone in the same position throughout.

If the phone is muted, its audio goes to headphones, or the kiosk cannot hear it, the moving square starts five seconds after the kiosk shows the opening QR. Once started, the square continues streaming until the operator ends the pickup or changes transfer mode. Late arrivals can scan the smaller pickup QR and aim at the moving square. In enlarged view, close the enlargement to see the pickup QR. If the reply is lost or a network blocks the direct channel, the camera keeps its collected data. The screen shows acquisition or transfer progress. Denied or disconnected cameras show recovery controls. Several visitors can collect the same optical stream while one uses a direct connection.

#### Browser audio compatibility

The visitor's phone uses audible PCM tones through Web Audio once camera capture starts. Chrome documents an active-capture autoplay exception. For iPhone Safari, WebKit documents an exception for media-stream-backed playback. A synthesized tone can still be blocked. Firefox for Android exposes autoplay controls, including a cellular-only restriction. Samsung Internet uses Chromium with its own release cycle and settings. PhotoPass tests the actual audio context on each phone and retries a suspended context on an ordinary tap. [Chrome](https://developer.chrome.com/blog/web-audio-autoplay/) · [WebKit](https://webkit.org/blog/7763/a-closer-look-into-webrtc/) · [Firefox for Android](https://support.mozilla.org/en-US/kb/playing-videos-firefox-android) · [Samsung Internet for Android](https://developer.samsung.com/browser/release-note/android-release-note.html)

A QR scanner's embedded browser can have different policies from the phone's main browser. Android WebView requires a gesture for media playback by default. On iOS the containing app can configure this requirement. If camera access is unavailable, the receiver directs the visitor to their main browser. [Android WebView](https://developer.android.com/reference/android/webkit/WebSettings#setMediaPlaybackRequiresUserGesture(boolean)) · [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/mediatypesrequiringuseractionforplayback)

The short link identifies the visitor’s photo. Each moving frame carries part of that file. Missed frames are recoverable, and the phone verifies the entire SHA-256 digest before saving. The kiosk can keep displaying the stream while several authorized viewers collect the same photo. A camera in view of an optical stream can read it.

### Speed and lighting

**High speed** is the default. Under **Kiosk options**, use **Enlarge square** if a phone has trouble resolving the grid. Keep all four corners in view. The phone reports which route delivered the verified photo, elapsed time from the live camera preview to verification, and average KB/s. Changing into or out of High speed restarts collection.

High speed targets 30 frames/s, with up to three independently checked 2,915-byte packets per frame. Brightness, warm/cool tint and green/magenta tint carry different packets. Brightness alone can deliver the entire file. A receiver backs off a color layer that repeatedly fails. Groups of up to 48 source packets use a systematic Cauchy erasure code over GF(256). Any 48 distinct valid rows recover a full group, including for a visitor who joins partway through the broadcast. For development, `node tests/light-repair.mjs` exercises this recovery through the 32 MiB file limit.

The density and refresh choices draw on Decimen's version-40 QR guidance. HiQ documents how lighting and interference between colors affect phone decoding. For a full-size high-speed frame, PhotoPass locates the brightness QR, samples each cell center in the same camera exposure and uses the three finder patterns to calibrate the colors. The high-speed packet format is specific to PhotoPass. All modes verify the original file with SHA-256. [Decimen transmission settings](https://github.com/bashalarmistalt/decimen-optical-transfer/blob/main/docs/user/sending.md) · [HiQ mobile color QR research](https://arxiv.org/abs/1704.06447) · [Erasure coding background](https://www.rfc-editor.org/rfc/rfc5510)

#### Reproduce the camera benchmark

From a development checkout with Node 24 and Google Chrome, install the optional test dependency with `npm install --no-save --package-lock=false playwright@1.57.0`. These commands time delivery of the same deterministic 2,300,000-byte textured JPEG. Two browser pages communicate through rendered pixels at the same 532-pixel camera footprint. The timer starts when the virtual camera points at the correct kiosk and ends after the saved download is verified.

```sh
node tests/optical-benchmark.mjs --field-size --fixed --textured --color
node tests/optical-benchmark.mjs --field-size --fixed --textured --fast
```

Add `--impaired` to both commands to hold one in five camera updates, apply a 0.4-pixel blur, and reduce contrast and saturation. Use `--gray` to remove color completely. For a venue measurement, send the same original in both modes using the same phone, kiosk, distance and lighting. Compare the elapsed times shown on the phone.

The following tests run the full pickup using digital speaker-to-microphone audio and camera pixels. They hold camera permission, send a wrong-session tone, grant permission, and verify the original bytes and released devices. The second command rejects the network handshake. The third closes an active direct channel after 160 KiB. The optical benchmark above runs with audio unavailable.

```sh
node tests/pickup-routes.mjs --brio
node tests/pickup-routes.mjs --break-rtc
node tests/pickup-routes.mjs --drop-rtc
node tests/pickup-routes.mjs --lose-answer
```

With Playwright's Firefox and WebKit engines installed, run `node tests/browser-autoplay.mjs` to report whether a fresh page actually starts a tone after camera capture. Desktop engine results are specific to that build and its media settings.

Under **Transfer speed**, **Four colors** uses a lower-density grid. Brightness carries the complete stream and a warm/cool layer carries a second packet. A checksum covers each color packet, and the receiver spends less time checking color after repeated misses. Switching between Four colors and Black and white keeps the phone's collected packets. **Larger squares** further reduces the density and restarts collection.

In Black and white, the display can send up to 24 frames per second carrying up to 1,433 file bytes each. Even perfect capture in this mode needs about five minutes for 10 MB, before recovery overhead. Actual time depends on focus, motion, reflections, camera frame rate and decoder speed. The page estimates remaining time from observed progress.

## Many kiosks, one receiver URL

Independent sessions can use the same receiver path without reserving a room. The pickup link’s URL fragment includes a 96-bit prefix of the photo digest and a fresh 48-bit random identifier. A kiosk accepts a ready tone only when both match. Each optical photo frame carries the photo identifier. A phone ignores frames for other photos and checks the complete digest before offering the file. The static host serves the application files. Photo data travels through the screen or an encrypted WebRTC channel. Public STUN assists the direct path.

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

For faster delivery on networks that permit a direct WebRTC connection, open **Kiosk options** and select **Pair for direct transfer**, or open the kiosk page with `?direct`. In this mode, scan the kiosk QR and turn the phone’s reply code toward the kiosk camera. The kiosk scans the reply automatically after a camera capture. The browsers use public STUN to discover network addresses and transfer the file over an encrypted data channel. A restrictive venue or carrier network can still prevent this connection. Screen transfer works independently of STUN and TURN. [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections)

## Camera-free pickup by sound

1. On the kiosk, take a photo or choose an existing file, open **Kiosk options** and select **Camera-free pickup by sound**. Turn on the kiosk speaker. Allow the kiosk microphone if available so it can hear the phone's reply.
2. On the phone, open the sound receiver address shown on the kiosk, or choose **Receive by sound** on the home page. Enter the six digits and tap **Start listening**. If the phone has a camera, **Scan instead of typing** fills in the code with one scan. Allow microphone access, hold the phone near the speaker and keep both pages open. [Open the sound receiver](https://glmatas.github.io/photopass/?listen)
3. The browsers exchange short tones and try a direct WebRTC transfer. When the network blocks the connection or the kiosk has no microphone, the kiosk speaker can send the complete original. Tap **Save photo** on the phone after verification. A one-way kiosk can keep playing until you select **Next visitor**.

The audio link uses Quiet's audible modem. In digital loopback a 1,024-byte packet occupies about 1.2 seconds. At that rate, 2.3 MB needs about 45 minutes of continuous audio before framing, recovery blocks, listening pauses and missed packets. Allow an hour or more for a photo of that size over sound alone. For a large photo, leave the moving square selected when a camera is available. Ambient noise and overlapping kiosks can interfere with reception. Each sound session uses a six-digit pickup code and a random session identifier. Someone who can record the acoustic file stream can recover the photo. The upstream revision and licenses are in `vendor/sound/`. [Quiet.js](https://github.com/quiet/quiet-js)

## Publish or run locally

Commit this folder’s contents, including the complete `vendor/` directory, to a repository. In **Settings → Pages**, publish the root of the branch. There is no build step, runtime CDN or application backend. A phone must be able to open the receiver’s HTTPS address. [GitHub Pages publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

For a local kiosk camera test with Python, run `python -m http.server 8080 --bind 127.0.0.1` from this folder and open `http://localhost:8080/`. For a separate phone, use a reachable receiver address as shown above.

The optical transport incorporates the pinned MIT-licensed Decimen v0.3.0 fountain-code implementation, QR rendering and a locally bundled ZXing decoder. Dependency notices are included in `vendor/`. [Decimen v0.3.0](https://github.com/bashalarmistalt/decimen-optical-transfer/tree/v0.3.0)
