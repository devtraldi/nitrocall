<p align="center">
  <img src="assets/logo.png" alt="Nitro Poker Club" width="160" />
</p>

<h1 align="center">NitroCall</h1>

<p align="center">
  <b>Voice and screen with friends. Device to device, encrypted, no account.</b><br />
  Built for small groups (2 to 8 people). Free, no ads, no tracking, open source.
</p>

<p align="center">
  <a href="https://devtraldi.github.io/nitrocall/"><b>▶ Open NitroCall</b></a> ·
  <a href="README.pt-BR.md">Português</a>
</p>

---

## Why this exists

A group of friends, the **Nitro Poker Club**, wanted one simple thing: to talk and see each
other's screens (a game, a YouTube video with sound) without creating accounts, installing
anything heavy, paying for a subscription, or handing their conversations to a company.

Big tools solve this by routing everything through their own servers. NitroCall does the
opposite: **the friends' own devices are the infrastructure.** The page is a static file. Once
it's open, GitHub is out of the picture: audio and screen go straight from one device to
another.

There is no commercial intent. No paid tier, no ads, no data collection, no "pro version".
The project is, and will stay, free and open.

## What it does

- 🎙️ **Voice** in Opus 64 kbps with loss protection and AI noise suppression (RNNoise).
- 🖥️ **Screen sharing up to 1080p30, with your PC's sound** (video, games, music), with
  automatic quality adjustment when someone's internet can't keep up.
- 📱 **Phones:** join from the browser, talk, listen, watch screens in fullscreen, and show
  your **camera** (rear or front).
- 🔒 **End-to-end encryption** (DTLS-SRTP, mandatory in WebRTC), plus a per-person,
  Signal-style security code to confirm nobody is in the middle.
- 🌉 **Never without a path.** NitroCall tries, in order:
  1. **direct** between the two devices;
  2. **a friend in the room as a bridge**, picked automatically by connection quality;
  3. **TURN**, a relay server, only when there's no direct path and no friend who can bridge.
     Media stays encrypted: TURN forwards packets it cannot open.
- 🎲 **No sign-up:** pick a room code and the app gives you a funny random name
  ("Pocket Pair Without Wi-Fi", "Joker in Pajamas"…). You can change it.
- 🌎 **English and Portuguese.**
- 💻 Also available as a **Windows app** (Tauri) with a tray icon, global mute shortcut and
  auto-update. App and website join the same rooms.

## How it works (no jargon)

```
  You open the link ──► GitHub serves the page (~2.4 MB, once)
                             │
                             ▼
  Devices find each other at a public "meeting point" (PeerJS; backup: Nostr)
                             │
                             ▼
  The call goes DIRECT between devices (WebRTC)           ← almost always
         or through a FRIEND in the room acting as bridge ← when two can't reach each other
         or through TURN, still encrypted                 ← last resort
```

An hour-long call does **not** use an hour of our server. GitHub only serves the file; the
call's bandwidth is carried by the participants themselves, like a phone call between two
phones.

## Transparency: third parties and what each one sees

"No server" means **no media server and no server of ours storing data**. To find each other,
NitroCall relies on free public services:

| Service | Used for | What it sees |
|---|---|---|
| GitHub Pages | serving the page | that someone opened the site (like any website) |
| PeerJS (0.peerjs.com) | meeting point: reserving your slot in the room | an identifier derived from the room code (hash), IPs |
| Public Nostr relays | backup meeting point if PeerJS is down | signaling messages encrypted with the room key |
| STUN (Google/Cloudflare) | each device learning its own public address | your IP |
| TURN (Cloudflare) + Worker | last-resort relay | IPs and encrypted packets; it **cannot** hear or see anything |

The room code lives after the `#` in invite links and is never sent to GitHub.

## Honest limits

- **Designed for 2 to 8 people.** 9–10 works but is experimental: whoever shares a screen
  sends one copy per viewer (or to friends who redistribute it), and home upload runs out.
- **Phones can't share their own screen from a browser.** Neither Android nor iPhone allow it
  for websites; NitroCall offers the camera instead.
- **iPhone in the background:** iOS cuts any website's microphone when you switch apps.
  NitroCall tells the others ("left the tab") and restarts your mic when you come back.
- **TURN depends on a third-party service** with a free quota (1,000 GB/month). If it ever
  goes away, NitroCall keeps working with direct links and friend bridges.
- Best on desktop **Chrome or Edge** (they send your PC's sound along with the screen).

## Built with Claude: a 100% "vibe coding" project

To be upfront: **this project was written together with [Claude](https://claude.ai) by
Anthropic, using [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (CLI).**
I decided what I wanted, tested it with real friends, complained about what was bad and set
the direction; Claude wrote practically all of the code, the automated tests and the docs, and
helped investigate every problem (NAT, codecs, GPUs, screen quality).

NitroCall is part of my **learning roadmap** for Anthropic's tools: Claude Code, agents,
AI-driven testing, and how to build something real and useful with them. If you're learning
the same, feel free to read the history, borrow ideas and open issues.

## Running or changing it

Source code, tests (multi-browser end-to-end, an image-quality lab and a network emulator)
and build instructions live in [`app/`](app/). The optional TURN credentials Worker is in
[`app/cloudflare/turn-worker/`](app/cloudflare/turn-worker/).

## License

[MIT](LICENSE). Use it, copy it, change it, share it.

---

<sub>Nitro Poker Club · made among friends, for friends.</sub>
