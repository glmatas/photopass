# PhotoPass

PhotoPass sends a photo from a kiosk browser to a visitor’s phone over an encrypted WebRTC data channel. Both devices need internet access. The phone can use mobile data. The kiosk needs a display and a camera that can see the phone screen.

## Publish on GitHub Pages

1. Put the contents of this folder at the root of a GitHub repository, with `index.html`, `app.js` and `vendor/` at the same level. Commit the files to `main`.
2. In the repository, open **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, select **main** and **/ (root)**, then save.
3. Once GitHub publishes the site, open its HTTPS address on the kiosk. Use the published address for a two-device test. A QR generated on localhost points the phone back to itself.

There is no build step. All JavaScript dependencies, including the QR reader, are bundled. [GitHub Pages publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Collect a photo

1. On the kiosk, choose the visitor’s JPEG, PNG or WebP and select **Pair a phone**. The limit is 32 MiB.
2. The visitor scans the kiosk QR with the phone’s standard camera and opens the link. The page displays a reply QR.
3. On the kiosk, select **Scan phone’s reply**, grant camera access and hold the phone screen up to the kiosk camera. Keep both pages open until the transfer finishes.
4. On the phone, select **Save photo** to download the original. On phones that support file sharing, **Share photo** also opens the system share sheet. On the kiosk, **Next visitor** clears the selection and pairing session.

If the booth already captures photos in the same page, its capture handler can start pairing using the original image blob:

```js
import { startPhotoSession } from './app.js';

// jpegBlob is the JPEG from the kiosk camera.
await startPhotoSession(new File([jpegBlob], 'Photo.jpg', { type: 'image/jpeg' }));
```

## What each service handles

GitHub Pages serves the static interface. The first QR carries the WebRTC offer in the URL fragment, which the browser keeps out of the HTTP request. The second QR carries the answer back to the kiosk. The front end uses Google’s public STUN endpoint (`stun:stun.l.google.com:19302`) to discover network addresses. The page displays a progress bar while the browsers exchange image data. The phone checks the file size and SHA-256 hash before offering to save it.

The app has no signaling backend, file uploads, TURN relay, or persistent photo store. A direct connection can fail on restrictive carrier or venue networks. In that case the interface reports the failure. Test on the venue connection with a phone on cellular before putting the kiosk into service. [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections) · [TURN and relay connectivity](https://webrtc.org/getting-started/turn-server)
