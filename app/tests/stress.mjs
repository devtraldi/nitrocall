// Estresse de rede: várias pessoas com o NitroCall.html, rede emulada (banda, atraso,
// variação, perda em rajada, upload dividido, quedas totais) e métricas do que a pessoa
// sente: travadas e fps da tela, resolução, cortes de áudio (amostras ocultadas pelo
// decodificador) e tempo para voltar depois de uma queda.
//
//   node tests/stress.mjs                 (todos os cenários, Chromium do Playwright)
//   CHANNEL=chrome node tests/stress.mjs  (Chrome instalado: encoders de hardware)
//   ONLY=queda node tests/stress.mjs
//
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startNetem } from "./netem.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const bin = (rel) => fileURLToPath(new URL(`../node_modules/${rel}`, import.meta.url));
const PEER_PORT = Number(process.env.PEER_PORT || 9130);
const WEB_URL = pathToFileURL(fileURLToPath(new URL("../dist-web/NitroCall.html", import.meta.url))).href;
const CHANNEL = process.env.CHANNEL || undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const kids = [];

// Tela sintética realista 1920x1080@30 (igual à do e2e) + registro das RTCPeerConnection.
function hdScreenInit() {
  window.__NITRO_FAKE_SCREEN__ = false;
  const Orig = window.RTCPeerConnection;
  window.__PCS__ = [];
  const W = function (...a) {
    const pc = new Orig(...a);
    window.__PCS__.push(pc);
    return pc;
  };
  W.prototype = Orig.prototype;
  Object.setPrototypeOf(W, Orig);
  window.RTCPeerConnection = W;
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement("canvas");
    c.width = 1920;
    c.height = 1080;
    const g = c.getContext("2d");
    const small = document.createElement("canvas");
    small.width = small.height = 24;
    const sg = small.getContext("2d");
    const img = sg.createImageData(24, 24);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = v;
      img.data[i + 1] = (v * 7) % 255;
      img.data[i + 2] = 255 - v;
      img.data[i + 3] = 255;
    }
    sg.putImageData(img, 0, 0);
    let f = 0;
    const draw = () => {
      f++;
      const grd = g.createLinearGradient(0, 0, 1920, 1080);
      grd.addColorStop(0, `hsl(${f % 360} 60% 30%)`);
      grd.addColorStop(1, `hsl(${(f + 180) % 360} 60% 20%)`);
      g.fillStyle = grd;
      g.fillRect(0, 0, 1920, 1080);
      g.fillStyle = "#fff";
      g.font = "16px monospace";
      for (let y = 0; y < 60; y++) g.fillText(`linha ${y + f} — o rato roeu a roupa do rei de roma ${(y * 7919 + f) % 10007}`, 20, (y * 20 + f * 2) % 1080);
      for (let k = 0; k < 6; k++) g.drawImage(small, 0, 0, 24, 24, (f * (5 + k * 3) + k * 300) % 1700, 200 + k * 120 + Math.sin(f / 10 + k) * 60, 420, 420);
    };
    setInterval(draw, 33);
    draw();
    const s = c.captureStream(30);
    const ac = new AudioContext();
    const o = ac.createOscillator();
    const d = ac.createMediaStreamDestination();
    o.connect(d);
    o.start();
    s.addTrack(d.stream.getAudioTracks()[0]);
    return s;
  };
}

let userCount = 0;
async function makeUser(net, name, room) {
  userCount++;
  const browser = await chromium.launch({
    channel: CHANNEL,
    headless: !CHANNEL,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--window-size=900,600",
      // Aqui se testa a rede, não o estrangulamento de janelas escondidas.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      `--window-position=${40 + userCount * 30},${40 + userCount * 30}`,
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  await net.attach(context, name);
  await context.addInitScript(({ port }) => {
    localStorage.setItem("nitrocall.server", `http://localhost:${port}`);
    localStorage.setItem("nitrocall.nostr", "off");
  }, { port: PEER_PORT });
  await context.addInitScript(hdScreenInit);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [${name} pageerror] ${e}`));
  await page.goto(WEB_URL);
  await page.fill("#room-code-input", room);
  await page.fill("#name-input", name);
  await page.click("#join-form button[type=submit]");
  return { name, browser, page };
}

// Estatísticas de recepção de uma pessoa: telas (vídeo) e áudios que chegam.
function readRx(page) {
  return page.evaluate(async () => {
    const video = [];
    const audio = [];
    for (const pc of window.__PCS__ ?? []) {
      if (pc.connectionState !== "connected") continue;
      const r = await pc.getStats();
      r.forEach((s) => {
        if (s.type !== "inbound-rtp") return;
        const key = `${pc.__id ?? (pc.__id = Math.random().toString(36).slice(2, 7))}:${s.ssrc}`;
        if (s.kind === "video" && s.bytesReceived > 50_000) {
          video.push({ key, w: s.frameWidth ?? 0, fps: s.framesPerSecond ?? 0, frames: s.framesDecoded ?? 0, freezes: s.freezeCount ?? 0, freezeDur: s.totalFreezesDuration ?? 0, bytes: s.bytesReceived, t: s.timestamp });
        }
        if (s.kind === "audio" && (s.totalSamplesReceived ?? 0) > 48_000) {
          audio.push({ key, total: s.totalSamplesReceived, concealed: (s.concealedSamples ?? 0) - (s.silentConcealedSamples ?? 0), events: s.concealmentEvents ?? 0, t: s.timestamp });
        }
      });
    }
    return { video, audio };
  });
}

// Janela entre duas leituras: pior tela e pior áudio.
function windowMetrics(a, b) {
  const out = { fps: null, w: null, frozenPct: 0, freezes: 0, kbps: 0, concealPct: 0, cuts: 0, screens: 0, audios: 0 };
  for (const v of b.video) {
    const p = a.video.find((x) => x.key === v.key);
    if (!p || v.t <= p.t) continue;
    out.screens++;
    const dt = (v.t - p.t) / 1000;
    const fps = (v.frames - p.frames) / dt;
    out.fps = out.fps === null ? fps : Math.min(out.fps, fps);
    out.w = out.w === null ? v.w : Math.min(out.w, v.w);
    out.frozenPct = Math.max(out.frozenPct, (100 * (v.freezeDur - p.freezeDur)) / dt);
    out.freezes += v.freezes - p.freezes;
    out.kbps = Math.max(out.kbps, ((v.bytes - p.bytes) * 8) / (v.t - p.t));
  }
  for (const x of b.audio) {
    const p = a.audio.find((y) => y.key === x.key);
    if (!p || x.total <= p.total) continue;
    out.audios++;
    out.concealPct = Math.max(out.concealPct, (100 * (x.concealed - p.concealed)) / (x.total - p.total));
    out.cuts += x.events - p.events;
  }
  return out;
}

const fmt = (m) =>
  `tela ${m.w ?? "-"}px ${m.fps === null ? "-" : m.fps.toFixed(0)}fps ${Math.round(m.kbps)}kbps travada ${m.frozenPct.toFixed(1)}% | áudio oculto ${m.concealPct.toFixed(2)}% cortes ${m.cuts}`;

function check(label, ok, detail) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// Um cenário: monta a sala, aplica o perfil de rede, compartilha, mede em janelas.
async function scenario({ name, users, sharers, setup, secs = 60, warm = 20, events = [], expect }) {
  console.log(`\n[${name}]`);
  const net = await startNetem();
  setup(net);
  const room = `st-${name}-${Date.now().toString(36)}`.replace(/[^a-z0-9-]/gi, "");
  const us = [];
  for (const n of users) {
    us.push(await makeUser(net, n, room));
    await sleep(700);
  }
  await sleep(8000);
  for (const s of sharers) {
    const u = us.find((x) => x.name === s);
    await u.page.selectOption("#quality-select", "alta");
    await u.page.click("#share-screen-btn");
  }
  const viewers = us.filter((u) => !sharers.includes(u.name) || sharers.length > 1);
  const t0 = Date.now();
  let last = await Promise.all(viewers.map((v) => readRx(v.page)));
  const windows = [];
  const pending = [...events].sort((a, b) => a.at - b.at);
  while (Date.now() - t0 < secs * 1000) {
    await sleep(2000);
    const el = (Date.now() - t0) / 1000;
    while (pending.length && pending[0].at <= el) {
      const ev = pending.shift();
      console.log(`  → ${ev.label} (t=${el.toFixed(0)}s)`);
      ev.run(net);
    }
    const now = await Promise.all(viewers.map((v) => readRx(v.page)));
    const per = now.map((n, i) => windowMetrics(last[i], n));
    last = now;
    // Pior entre todos os espectadores.
    const worst = per.reduce(
      (w, m) => ({
        fps: m.fps === null ? w.fps : w.fps === null ? m.fps : Math.min(w.fps, m.fps),
        w: m.w === null ? w.w : w.w === null ? m.w : Math.min(w.w, m.w),
        frozenPct: Math.max(w.frozenPct, m.frozenPct),
        freezes: w.freezes + m.freezes,
        kbps: w.kbps === 0 ? m.kbps : Math.min(w.kbps, m.kbps || w.kbps),
        concealPct: Math.max(w.concealPct, m.concealPct),
        cuts: w.cuts + m.cuts,
        screens: w.screens + m.screens,
      }),
      { fps: null, w: null, frozenPct: 0, freezes: 0, kbps: 0, concealPct: 0, cuts: 0, screens: 0 },
    );
    windows.push({ t: el, ...worst });
    if (process.env.VERBOSE) console.log(`    t=${el.toFixed(0)}s ${fmt(worst)}`);
  }
  const steady = windows.filter((w) => w.t > warm && !events.some((e) => w.t > e.at && w.t < e.at + (e.recoverS ?? 0)));
  const agg = {
    fpsMin: Math.min(...steady.map((w) => w.fps ?? 0)),
    fpsAvg: steady.reduce((s, w) => s + (w.fps ?? 0), 0) / Math.max(1, steady.length),
    wMin: Math.min(...steady.map((w) => w.w ?? 0)),
    frozenAvg: steady.reduce((s, w) => s + w.frozenPct, 0) / Math.max(1, steady.length),
    concealAvg: steady.reduce((s, w) => s + w.concealPct, 0) / Math.max(1, steady.length),
    concealMax: Math.max(...steady.map((w) => w.concealPct)),
    kbpsAvg: steady.reduce((s, w) => s + w.kbps, 0) / Math.max(1, steady.length),
  };
  console.log(
    `  regime: tela ≥${agg.wMin}px, fps médio ${agg.fpsAvg.toFixed(1)} (mín ${agg.fpsMin.toFixed(0)}), ${Math.round(agg.kbpsAvg)} kbps, travada ${agg.frozenAvg.toFixed(1)}% | áudio oculto médio ${agg.concealAvg.toFixed(2)}% (pior janela ${agg.concealMax.toFixed(2)}%)`,
  );
  expect(agg, windows, check);
  for (const u of us) await u.browser.close();
  net.close();
  return { agg, windows };
}

// Tempo até voltar ao normal depois de um evento em `at` segundos.
function recoveryTime(windows, at, ok) {
  const after = windows.filter((w) => w.t > at);
  const back = after.find((w) => ok(w));
  return back ? back.t - at : Infinity;
}

async function main() {
  const r = spawnSync(process.execPath, [bin("vite/bin/vite.js"), "build", "--config", "vite.web.config.ts", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error("build:web falhou");
  kids.push(spawn(process.execPath, [bin("peer/dist/bin/peerjs.js"), "--port", String(PEER_PORT)], { stdio: "ignore" }));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${PEER_PORT}/peerjs/id`)).ok) break;
    } catch {}
    await sleep(300);
  }
  const only = process.env.ONLY;
  const all = [
    {
      name: "wifi-bom",
      users: ["Ana", "Beto", "Caio"],
      sharers: ["Ana"],
      setup: (net) => net.setProfile("*", "*", { rateKbps: 40_000, delayMs: 8, jitterMs: 4, lossPct: 0.2 }),
      expect: (a, _w, ok) => {
        ok("Wi-Fi bom: tela em 1080p", a.wMin >= 1900, `${a.wMin}px`);
        ok("Wi-Fi bom: fps ≥ 24", a.fpsAvg >= 24, a.fpsAvg.toFixed(1));
        ok("Wi-Fi bom: tela quase nunca trava (< 1%)", a.frozenAvg < 1, `${a.frozenAvg.toFixed(2)}%`);
        ok("Wi-Fi bom: áudio sem cortes (< 0,5% oculto)", a.concealAvg < 0.5, `${a.concealAvg.toFixed(2)}%`);
      },
    },
    {
      name: "upload-casa",
      users: ["Ana", "Beto", "Caio", "Duda"],
      sharers: ["Ana"],
      // Upload de 12 Mbps dividido entre os 3 que assistem (mais áudio), download folgado.
      setup: (net) => {
        net.setProfile("*", "*", { rateKbps: 50_000, delayMs: 15, jitterMs: 5, lossPct: 0.3 });
        net.setProfile("Ana", "*", { rateKbps: 12_000, sharedUp: true, queueMs: 250 });
      },
      expect: (a, _w, ok) => {
        ok("Upload 12 Mbps p/ 3: tela ≥ 1280px", a.wMin >= 1280, `${a.wMin}px`);
        ok("Upload 12 Mbps p/ 3: fps ≥ 20", a.fpsAvg >= 20, a.fpsAvg.toFixed(1));
        ok("Upload 12 Mbps p/ 3: travada < 2%", a.frozenAvg < 2, `${a.frozenAvg.toFixed(2)}%`);
        ok("Upload 12 Mbps p/ 3: áudio < 1% oculto", a.concealAvg < 1, `${a.concealAvg.toFixed(2)}%`);
      },
    },
    {
      name: "4g-ruim",
      users: ["Ana", "Beto"],
      sharers: ["Ana"],
      // 6 Mbps, 70 ms, variação de 30 ms, 2% de perda em rajadas de 3 pacotes.
      setup: (net) => net.setProfile("*", "*", { rateKbps: 6_000, delayMs: 70, jitterMs: 30, lossPct: 2, burstLen: 3, queueMs: 300 }),
      expect: (a, _w, ok) => {
        ok("4G ruim: fps ≥ 15", a.fpsAvg >= 15, a.fpsAvg.toFixed(1));
        ok("4G ruim: travada < 5%", a.frozenAvg < 5, `${a.frozenAvg.toFixed(2)}%`);
        ok("4G ruim: áudio < 2% oculto", a.concealAvg < 2, `${a.concealAvg.toFixed(2)}%`);
      },
    },
    {
      name: "queda",
      users: ["Ana", "Beto", "Caio"],
      sharers: ["Ana"],
      secs: 75,
      setup: (net) => net.setProfile("*", "*", { rateKbps: 30_000, delayMs: 10, jitterMs: 4, lossPct: 0.2 }),
      events: [
        { at: 35, label: "rede de Ana cai por 4 s", recoverS: 12, run: (net) => { net.setProfile("Ana", "*", { down: true }); net.setProfile("*", "Ana", { down: true }); setTimeout(() => { net.setProfile("Ana", "*", { down: false }); net.setProfile("*", "Ana", { down: false }); }, 4000); } },
      ],
      expect: (a, w, ok) => {
        const rec = recoveryTime(w, 39, (x) => (x.fps ?? 0) >= 15 && x.concealPct < 5);
        ok("Queda de 4 s: tela e áudio voltam em ≤ 8 s", rec <= 8, `${rec} s`);
        ok("Queda de 4 s: fora da queda, fps ≥ 24", a.fpsAvg >= 24, a.fpsAvg.toFixed(1));
      },
    },
    {
      name: "duas-telas",
      users: ["Ana", "Beto", "Caio", "Duda"],
      sharers: ["Ana", "Beto"],
      setup: (net) => net.setProfile("*", "*", { rateKbps: 40_000, delayMs: 12, jitterMs: 4, lossPct: 0.2 }),
      expect: (a, _w, ok) => {
        ok("Duas telas: todas ≥ 1280px", a.wMin >= 1280, `${a.wMin}px`);
        ok("Duas telas: fps ≥ 20", a.fpsAvg >= 20, a.fpsAvg.toFixed(1));
        ok("Duas telas: áudio < 1% oculto", a.concealAvg < 1, `${a.concealAvg.toFixed(2)}%`);
      },
    },
  ];
  for (const s of all) {
    if (only && !only.split(",").includes(s.name)) continue;
    await scenario(s);
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures.push(String(e));
  })
  .finally(() => {
    for (const k of kids) k.kill();
    if (failures.length) {
      console.log(`\n❌ ${failures.length} falha(s):\n - ${failures.join("\n - ")}`);
      process.exit(1);
    }
    console.log("\n✅ Estresse: todas as metas batidas.");
    process.exit(0);
  });
