# NitroCall — source code

Voice and screen sharing among friends, device to device, end-to-end encrypted. No account,
no media server, no telemetry, free and open source. Designed for 2 to 8 people (9–10
experimental). Overview, limits and third-party transparency: [repository README](../README.md).

The product is the **web version**: a single file (~2.4 MB), `NitroCall.html`, published at
<https://devtraldi.github.io/nitrocall/> (it also runs by double-clicking it in Chrome/Edge).
It works on desktop and phones, with nothing to install.

The source also keeps an **optional desktop shell** (Tauri 2, `src-tauri/`) that wraps the same
code — tray, anti-sleep, CPU load, file logging, auto-update. It speaks the same protocol, but
it isn't built or distributed; the sections about it below are for anyone who wants to.

## What's new in 6.1

- **Phones on mobile data connect reliably.** The first contact now waits (up to 3 s) for TURN
  credentials instead of racing them; if they arrive later, every pending attempt is retried
  immediately with TURN (was: next attempt 5–13 s later). A slot known to be taken shows up as
  "Someone in the room — connecting…" instead of "Just you", and after 25 s a notice points to
  ⋯ → Copy diagnostics. Failed ICE attempts log what each side offered (host/srflx/relay,
  IPv6, TURN or not) so a phone's diagnostics say exactly why it didn't connect.
- **Automatic security verification:** each side sends `HMAC(room key, DTLS security code)`
  over the gossip channel; matching codes = 🔒 on the chip; different codes (someone in the
  middle) = ⚠️. As strong as the room code/password.
- **Four-button bar** (mic, share, ⋯, leave); screen controls moved onto the self preview;
  quality, devices, noise, language and diagnostics in the ⋯ menu. Tapping a person opens a
  panel with verification, path (direct/bridge/TURN), latency and their volume (touch-friendly).
- **Room link:** tapping the room name copies `https://devtraldi.github.io/nitrocall/#sala=<code>`
  (always the public site, even from the app or a local file) with visible confirmation. The
  separate invite button is gone.
- Portuguese by default; iPhone "tap to hear" fallback if the browser blocks playback; a
  password mismatch now shows a notice on both sides.
- `tests/ux.mjs`: 46-step UX walkthrough in installed Chrome (desktop + emulated iPhone).

## What's new in 6.0

- **Last-resort TURN** (`src/webrtc/turn.ts` + `cloudflare/turn-worker/`): direct → friend
  bridge → TURN. TURN is only added as extra ICE candidates, and ICE always prefers the direct
  path; the e2e suite checks the selected ICE pair to prove nothing goes through TURN when a
  direct path works. Without a Worker configured (`DEFAULT_TURN_ENDPOINT = ""`) everything
  behaves like 5.0. The participant chip shows "via TURN" when a link goes through it.
- **Phones:** browsers on phones have no `getDisplayMedia`, so the button becomes **Camera**
  (rear by default, with "flip"), sent through the same path as a screen (bridges, tree, TURN).
  Fullscreen with the iPhone fallback (`webkitEnterFullscreen`) and landscape lock. When you
  leave the app, others see "left the tab"; when you come back, the mic is restarted if the OS
  killed it. Dedicated narrow-screen layout (compact header, scrollable participant strip,
  icon-only control bar, "⋯" menu).
- **Random names** (`src/names.ts`): a poker piece + a funny twist that needs no gender
  agreement in Portuguese, ~850 combinations per language; no repeats on the same device; if a
  generated name clashes with someone already in the room, the later arrival picks another one
  (`setName` over the gossip channel).
- **PT/EN** (`src/i18n.ts`): one dictionary with both languages side by side; detected from the
  browser language; switchable live (join screen and "⋯" menu). The 🩺 technical log stays in
  Portuguese (it's meant for the maintainer).
- **Minimal join screen:** room, name, Join; password and "start with Windows" under "Options".
- Names coming from other participants never go through `innerHTML` anymore (the security-code
  popover used to build HTML with the name).

## Run

```sh
npm install
npm run tauri dev      # desktop app in dev mode
npm run tauri build    # installer in src-tauri/target/release/bundle/{msi,nsis}
npm run build:web      # dist-web/NitroCall.html (+ NitroCall.html.sha256)
```

Before a `tauri build` after UI changes, run `cargo clean --release -p nitrocall` in
`src-tauri` (the build doesn't notice changes in `dist`).

## NitroCall.html (browser)

- Everything is embedded in the file: JS, CSS, logos and noise suppression (RNNoise in
  WebAssembly, loaded as `data:` because Chrome won't load worklets from other files on `file://`).
- **Strict CSP** inside the HTML: only the embedded scripts (by hash) run; `wasm-unsafe-eval`
  only allows compiling WebAssembly, never JS `eval`.
- What Rust does in the app, the browser does like this: CPU → Compute Pressure API;
  anti-sleep → Screen Wake Lock; tray → confirmation on closing the tab + an **always-on-top
  mini window** (🗗, mute and see who's talking); Ctrl+Shift+M with the tab focused; file log →
  📥 downloads the log; invites → `NitroCall.html#sala=<code>` (the `#` never leaves the device).
- The timers that keep the room alive run in a **Web Worker**, so a background tab doesn't
  delay state or reconnection.
- Each build announces its version and a source fingerprint in the room. If a friend has a
  newer version you get a notice; if they have **the same version built from different code**
  you get "⚠ different code". This catches version mix-ups, not a file crafted to deceive: to
  verify a file you received, compare its SHA-256 (`certutil -hashfile NitroCall.html SHA256`)
  with the published `NitroCall.html.sha256`.
- Differences from the app: closing the tab ends the call (Chrome asks first); Chrome asks for
  the microphone every time a local file is opened; use Chrome, Edge or Opera (Firefox/Safari
  don't send the PC's sound along with the screen).

## Test

```sh
npm run test:e2e                 # local PeerJS broker + local Nostr relay + local TURN + headless Chromium
PUBLIC_BROKER=1 npm run test:e2e # same scenarios against the public PeerJS server
ONLY=1 npm run test:e2e          # screen quality / codec scenarios only
FULL=1 npm run test:e2e          # includes the 10-person room
WEB_FILE=1 npm run test:e2e      # every scenario with NitroCall.html opened via file://
ONLY=mixed npm run test:e2e      # mixed room only (app + NitroCall.html)
ONLY=nat npm run test:e2e        # 2 people alone, no direct path → TURN; normal network never uses TURN
ONLY=v6 npm run test:e2e         # phone (camera, "left the tab", mic restart), names, TURN chip
TURN_ALL=1 npm run test:e2e      # every scenario with TURN credentials available
TURN_URL=https://… npm run test:e2e   # use a real credentials Worker instead of the local TURN
node tests/shots.mjs <dir>       # UI screenshots on iPhone SE, Pixel 7 and desktop (LANG_UI=en)
node tests/ux.mjs                # UX walkthrough in installed Chrome, desktop + iPhone (HEADLESS=1)
```

"Direct path impossible" is simulated for real at the ICE level: every `RTCPeerConnection` in
that browser is forced to `iceTransportPolicy: "relay"`, so without TURN there is no path at
all (like symmetric NAT/CGNAT on both sides). Every run builds `NitroCall.html` and ends with
the mixed room: app and HTML together, audio, screens with sound both ways, noise suppression
loaded under the CSP, version/build exchange, `#sala=` invites.

### Measured quality and stability (installed Chrome, opens windows)

```sh
npm run test:quality -- <name>               # lab: screen PSNR/SSIM with real tab capture
CHANNEL=chrome npm run test:stress           # emulated network: 5 multi-person scenarios
HOOKS='{"__NITRO_NO_HW__":["VP9"]}' npm run test:quality -- no-vp9   # PC without VP9 on the GPU
SWENC=1 npm run test:quality -- cpu-only      # PC without any GPU encoder
```

- **Lab** (`tests/quality/`): NitroCall.html shares, through Chrome's real picker, a tab with a
  moving photo, small scrolling text and a barcode with the frame number. Each received frame
  is compared with the same frame captured before the encoder (PSNR/SSIM, ±2 px alignment).
  It measures only encoder and network loss.
- **Stress** (`tests/stress.mjs` + `tests/netem.mjs`): a UDP proxy in the middle of each WebRTC
  link applies bandwidth, delay, jitter, burst loss, upload split among viewers and full
  outages. It measures screen fps, resolution and freezes, concealed audio samples (dropouts)
  and recovery time after an outage. 5.0 results: good Wi-Fi 1080p/29.7 fps/0% frozen/0.38%
  audio concealed; 12 Mbps upload to 3 viewers: 1080p/29.8 fps; bad 4G (6 Mbps, 70 ms, 2% burst
  loss): 1080p/30 fps/0.8% frozen/1.7% concealed; 4 s full outage: back in 3.3 s; two screens
  to 4 people: 1080p/28.9 fps.

Scenarios: join/leave/rejoin, share/switch/stop screen (with sound), two screens at once,
mute, frozen participant, abrupt close, automatic bridge between two who can't reach each
other, score-based bridge election, bridge handover without cutting audio, "no path" warning,
room password, quality levels and automatic adjustment, codecs (VP9, Opus 64k + RED), security
code, signaling server dying mid-call, friend-assisted signaling, screen distribution tree,
Nostr meeting point, last-resort TURN, phone camera, background tab, name clashes.

## How it works

### Own links, no server in the path
- The public PeerJS server is used **only** to reserve a slot in the room and for the first
  contact with each person. After that, **all** signaling (SDP/ICE, state, requests) goes
  over the control channel of the WebRTC link between the two devices.
- Each pair has **one** fixed-shape link: microphone, screen video, screen audio and a data
  channel. Starting, switching or stopping a screen is just `replaceTrack`; there's never any
  renegotiation. Viewers never see the screen vanish and come back.
- If the server dies mid-call, **nothing changes** for people already in the room: reconnection
  (ICE restart) and bridges keep going over the own channel. Only new arrivals wait for the
  server to come back — or use the emergency meeting point (below).
- **Assisted signaling**: if the server doesn't answer or direct contact fails, the connection
  offer goes through a mutual friend. The direct link is often born this way.
- The room name is never sent in clear to the server: the ID is a hash of the code.

### Emergency meeting point (Nostr)
- If the PeerJS server doesn't answer, the app looks for friends through **public Nostr relays**
  (free, many, ownerless). Each message becomes an ephemeral event **encrypted with the room
  key** (code + password): the relay only sees that "someone" posted something in a room
  identified by a hash.
- People already in the room keep a (cheap) subscription on those relays and only publish when
  needed.

### Automatic, score-based bridge
- When two friends can't reach each other directly (closed NAT on both sides), the lower slot
  of the pair picks, from the state "gossip", a friend who talks to both and asks them to relay
  audio and screen (Chromium decodes and re-encodes on the bridge's device).
- Every device publishes a **capacity score (0–100)** every second, computed from real data —
  reach (how many present people it has its own link with), latency, loss, estimated upload
  headroom, CPU usage (measured by Rust) and the bridge load it already carries. Score ≥ 40 =
  can bridge; ≥ 60 up to 3 pairs; ≥ 80 up to 4.
- The choice is re-evaluated every 2 s **with hysteresis**: the bridge only changes if another
  one is clearly better (+20) for three evaluations in a row, or if the current one loses
  capacity. During a handover the old bridge stays until the new one delivers audio
  (**make-before-break**). A bridge at its limit answers "busy" and the request goes elsewhere.
  If nobody has a good score but someone reaches both, it's used anyway: worse quality beats
  someone being isolated.
- **Last resort — TURN (6.0):** when there's no direct path and no friend can bridge (the classic
  case: two people alone in the room, both behind restrictive NAT), media goes through TURN,
  still end-to-end encrypted (DTLS-SRTP). Credentials come from a tiny Cloudflare Worker (see
  `cloudflare/turn-worker/`), valid for 4 h, shared for 15 min. The client drops port 53 URLs
  (browsers block/stall them) and keeps `turns:…:443`, which gets through corporate firewalls.
- On screen: whoever bridges sees a notice; the own chip says "can bridge" / "you bridge N";
  the room-health pill says "All connected (N)", "Connecting…" or "X and Y can't reach".

### Screen distribution tree
- In a mesh, the sharer sends one copy per viewer (9 friends at 1080p ≈ 22 Mbps of upload and 9
  encoders). When the sharer's upload or CPU can't keep up, before lowering quality the app
  picks **distributors** (friends with a high score) who receive one copy and forward it.
  It costs ~100–200 ms more for tree viewers; you get 1080p for everyone instead of 480p for
  everyone. Re-evaluated every 5 s, make-before-break; after a stable period it tries direct
  again.

### Audio above Discord free
- Microphone in Opus **64 kbps** with in-band FEC and **RED** (each packet also carries the
  previous frame): voice survives burst loss without dropouts.
- **AI noise suppression** (RNNoise, open source, WebAssembly in an AudioWorklet) between the
  mic and the call. 🧹 toggles it; if it fails to load, the raw mic is sent.
- Larger jitter buffer when loss goes above 3% (stability > latency).
- **Per-person volume** (hover the chip) and **output device** choice (headphones/speakers).
- Screen audio in stereo Opus 128 kbps without voice processing.

### Screen quality (video engine 5.0)
Measured with **real tab capture in installed Chrome** and PSNR/SSIM of every received frame
against the same captured frame (before the encoder):

| The sharer has… | 4.1 | 5.0 |
|---|---|---|
| VP9 on the GPU (Intel/AMD) | 36.6 dB, reduced to 1424x778 | **46.7 dB, 1080p30** (text 47 dB) |
| H.265 on the GPU (NVIDIA) | ~33 dB (VP9 on CPU, 19 fps) | **46.8 dB, 1080p30** |
| CPU only | ~33 dB, 19 fps | **38.2 dB, 1080p30** (VP8) |

46 dB is practically the original. What ruined the picture were automatic Chromium decisions,
now made by the app **before the first frame**:
- **High start bitrate** (`x-google-start-bitrate=4000` in the SDP): with the default ~300 kbps,
  the encoder picked a smaller resolution on the first frame (and sometimes swapped GPU for
  CPU) and never went back.
- **Maintain resolution** (`degradationPreference`): under pressure fps drops, not sharpness.
  Low per-viewer caps (weak link) still reduce resolution.
- **Codec this machine encodes on the GPU** (MediaCapabilities): VP9 through the negotiated path
  (keeps Intel/AMD on the GPU); without VP9 on the GPU, switch live (`encodings[].codec`, no
  renegotiation) to H.265 or H.264 on the GPU; with no GPU, VP8 (same sharpness as VP9 on CPU,
  but 30 fps). If Chromium falls back to CPU or the CPU can't keep up, it switches to the next.
- **Caps**: High up to 12 Mbps per viewer, Medium 2.5 Mbps (720p30), Low 800 kbps (480p20).
  WebRTC's bandwidth estimate and per-viewer caps (only on real loss) rule when the network
  can't cope. Chromium's "bandwidth limited" isn't a weak network (it shows at the start of
  every stream and when the encoder hits its own cap): it only counts after 20 s and with the
  estimate below what the level needs.
- **ℹ️ panel** on each screen: incoming resolution, fps and bitrate, codec, GPU/CPU decoding,
  freezes, loss, buffer, and what the sharer is sending (codec, GPU/CPU, QP, limitation).

### Security
- Audio and screen are end-to-end encrypted between devices (**DTLS-SRTP**, mandatory in
  WebRTC). The 🔒 pill turns on when every link is like that. Honest caveat: when a friend
  bridges, that hop goes through their device, which decodes and re-encodes — a friend in the
  room, not a third-party server. Through TURN, packets stay encrypted end to end.
- **Automatic verification** (6.1): each side derives a security code from both DTLS
  fingerprints and sends an HMAC of it keyed with the room key. Same code on both sides → 🔒 on
  the chip; different (someone in the middle, e.g. a malicious signaling server) → ⚠️. An
  attacker would need the room code and password to forge it.
- **Room password** (optional): anyone without it is rejected before any media.
- One-click strong room code (🎲, ~60 bits). Strict CSP, minimal permissions, no telemetry,
  no recording. Versions 3.x and 4.x+ don't mix (different protocol).

### Always-on bridge PC (desktop app)
- While in a call, Rust keeps Windows from sleeping (`SetThreadExecutionState`).
- Closing the window during a call only hides it in the **tray** (menu: show, mute, leave,
  quit). Global **Ctrl+Shift+M** to mute. "Start with Windows" option.
- `nitrocall://sala/<code>` invites (✉️ button) open the app with the code filled in.
- **Auto-update** (releases signed with minisign). Publishing releases: replace `OWNER` in the
  endpoint in `src-tauri/tauri.conf.json`; when building, pass the key by content
  (`export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/nitrocall.key)"`, empty password) to
  produce the `.sig` files; assemble `latest.json` (version, notes, url + signature of each
  installer) and attach it to the release with the installers. The private key never goes into
  the repository.

## Installer and SmartScreen
Without Authenticode signing, Windows shows "Unknown publisher" until the file builds
reputation. An MSI with consistent publisher metadata and per-user install reduces warnings,
but the real fix is signing: free for open-source projects at the
[SignPath Foundation](https://signpath.org/), or Azure Trusted Signing / an OV certificate.
With a certificate, set `bundle.windows.signCommand` (or `certificateThumbprint`) in
`tauri.conf.json`.

## Diagnostics
🩺 shows the live log (elections, bridge handovers, room health, codec); 📋 copies the log +
link state to send to the maintainer. The same log goes to
`%LOCALAPPDATA%\com.rafat.nitrocall\logs\nitrocall.log`. Log messages and code comments are in
Portuguese (the project started as a Brazilian friends' app); the UI is in English and
Portuguese.

Test hooks (browser only): `__NITRO_BLOCK_SLOTS__`, `__NITRO_BLOCK_BOOT__`,
`__NITRO_BLOCK_MEDIA__`, `__NITRO_CAP__`, `__NITRO_CODEC__`, `__NITRO_FAKE_LOSS__`,
`__NITRO_ADAPT__`, `__NITRO_FAKE_SCREEN__`, `window.__NITRO_DEBUG__()`.

## License
MIT (see [LICENSE](../LICENSE)). RNNoise (Xiph/Mozilla) and rnnoise-wasm (Jitsi) under their
own licenses (BSD/Apache-2.0).
