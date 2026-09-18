// Laboratório de qualidade da tela: captura REAL de aba com o Chrome instalado (o
// NitroCall.html compartilha a aba "NitroVideo", com foto em movimento + texto miúdo +
// código de barras com o número do quadro) e PSNR/SSIM de cada quadro recebido contra o
// MESMO quadro capturado antes do encoder (a perda medida é só a do encoder e da rede).
// Abre janelas do Chrome. Fundo: quadro de "Big Buck Bunny" (c) Blender Foundation, CC-BY 3.0.
//   npm run test:quality -- <tag>
//   env: CODEC=VP9|AV1|H264|H265|VP8  MAXBR=6000000  SWENC=1 (sem encoder de hardware)
//        DEG=maintain-resolution|balanced|maintain-framerate  HINT=detail|motion|text
//        WARM=20 (s)  SAMPLES=8  QUALITY=alta  APP_URL=...  VIEWPORT=1920x1046
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");
const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]$/, "");
// Quadros de exemplo (recebido/referência) para olhar: pasta temporária por padrão.
const OUT_DIR = process.env.LAB_OUT || tmpdir();
const TAG = process.argv[2] || "lab";
const E = process.env;
const WARM = Number(E.WARM || 20);
const SAMPLES = Number(E.SAMPLES || 8);
const PEER_PORT = 9110;
const APP = E.APP_URL || pathToFileURL(ROOT + "/dist-web/NitroCall.html").href;
// Servido por HTTP local: o canvas do laboratório pode ser lido (referência exata).
const LAB_PORT = 9120;
const LAB = `http://localhost:${LAB_PORT}/lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const http = await import("node:http");
const { readFileSync: rfs } = await import("node:fs");
const labServer = http.createServer((req, res) => {
  const f = decodeURIComponent((req.url || "/").split(/[?#]/)[0]).replace(/^\/+/, "");
  try {
    const body = rfs(`${HERE}/${f}`);
    res.writeHead(200, { "content-type": f.endsWith(".png") ? "image/png" : "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => labServer.listen(LAB_PORT, "127.0.0.1", r));
const kids = [spawn(process.execPath, [ROOT + "/node_modules/peer/dist/bin/peerjs.js", "--port", String(PEER_PORT)], { stdio: "ignore" })];
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://localhost:${PEER_PORT}/peerjs/id`)).ok) break;
  } catch {}
  await sleep(300);
}
const room = "lab-" + Date.now().toString(36);
const hooks = { ...(E.CODEC ? { __NITRO_CODEC__: E.CODEC } : {}), ...JSON.parse(E.HOOKS || "{}") };

function init({ port, hooks }) {
  localStorage.setItem("nitrocall.server", `http://localhost:${port}`);
  localStorage.setItem("nitrocall.nostr", "off");
  localStorage.removeItem("nitrocall.codecFallback");
  Object.assign(window, hooks);
  const Orig = window.RTCPeerConnection;
  window.__PCS__ = [];
  window.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a);
    window.__PCS__.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
}

async function user(name, sender, pos) {
  const args = ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", `--window-position=${pos}`];
  if (sender) {
    args.push("--auto-select-tab-capture-source-by-title=NitroVideo", "--window-size=1936,1200");
    if (E.SWENC) args.push("--disable-accelerated-video-encode");
  } else {
    args.push("--use-fake-ui-for-media-stream", "--window-size=1280,800");
  }
  const browser = await chromium.launch({ channel: "chrome", headless: false, args });
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: null });
  await ctx.addInitScript(init, { port: PEER_PORT, hooks });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(name, "pageerror", String(e)));
  await page.goto(APP);
  await page.fill("#room-code-input", room);
  await page.fill("#name-input", name);
  await page.click("#join-form button[type=submit]");
  return { name, browser, ctx, page };
}

const sender = await user("Pai", true, "0,0");
const viewer = await user("Filho", false, "700,300");
const vtab = await sender.ctx.newPage();
await vtab.goto(LAB);
await vtab.waitForFunction(() => window.__ready === true);
const dims = await vtab.evaluate(() => window.__dims);
await sleep(4000);
await sender.page.bringToFront();
await sender.page.selectOption("#quality-select", E.QUALITY || "alta");
await sender.page.click("#share-screen-btn");
await sleep(1500);
await vtab.bringToFront();

// Buffer de quadros BRUTOS da captura (antes do encoder), indexados pelo código de barras:
// a referência de cada quadro recebido é o mesmo quadro capturado.
await sender.page.evaluate(async ({ W }) => {
  let track = null;
  for (const pc of window.__PCS__) for (const sn of pc.getSenders()) if (sn.track?.kind === "video" && sn.track.readyState === "live") track = sn.track;
  if (!track) throw new Error("sem track de tela");
  const proc = new MediaStreamTrackProcessor({ track: track.clone() });
  const reader = proc.readable.getReader();
  const bar = new OffscreenCanvas(700, 60);
  const bg = bar.getContext("2d", { willReadFrequently: true });
  const buf = new Map();
  window.__rawFrame = async (n) => {
    const bm = buf.get(n);
    if (!bm) return null;
    const c = new OffscreenCanvas(bm.width, bm.height);
    c.getContext("2d").drawImage(bm, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(s);
  };
  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try {
        const s = frame.displayWidth / W;
        bg.drawImage(frame, 0, 0, Math.round(700 * s), Math.round(60 * s), 0, 0, 700, 60);
        let n = 0;
        for (let b = 0; b < 24; b++) {
          const d = bg.getImageData(24 * (b + 1) + 11, 23, 3, 3).data;
          let l = 0;
          for (let i = 0; i < d.length; i += 4) l += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (l / 9 > 128) n |= 1 << b;
        }
        if (!buf.has(n)) {
          buf.set(n, await createImageBitmap(frame));
          while (buf.size > 45) {
            const k = buf.keys().next().value;
            buf.get(k)?.close();
            buf.delete(k);
          }
        }
      } finally {
        frame.close();
      }
    }
  })();
}, { W: dims.W });

// Variações aplicadas direto no remetente (depois que o app configurou tudo).
async function tweak() {
  await sender.page.evaluate(async ({ maxbr, deg, hint }) => {
    for (const pc of window.__PCS__) {
      for (const sn of pc.getSenders()) {
        if (sn.track?.kind !== "video") continue;
        if (hint) sn.track.contentHint = hint;
        const p = sn.getParameters();
        if (!p.encodings?.length) continue;
        if (maxbr) p.encodings[0].maxBitrate = maxbr;
        if (deg) p.degradationPreference = deg;
        await sn.setParameters(p).catch((e) => console.log("setParameters", String(e)));
      }
    }
  }, { maxbr: Number(E.MAXBR || 0), deg: E.DEG || "", hint: E.HINT || "" });
}

async function stats(page, dir) {
  return page.evaluate(async (dir) => {
    const res = [];
    for (const pc of window.__PCS__) {
      if (pc.connectionState !== "connected") continue;
      const r = await pc.getStats();
      const codecs = new Map();
      r.forEach((s) => s.type === "codec" && codecs.set(s.id, s.mimeType));
      r.forEach((s) => {
        if (s.kind !== "video") return;
        if (dir === "out" && s.type === "outbound-rtp" && s.bytesSent > 0) {
          res.push({ w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, lim: s.qualityLimitationReason, enc: (s.encoderImplementation || "") + (s.powerEfficientEncoder ? "[HW]" : ""), qpSum: s.qpSum, frames: s.framesEncoded, bytes: s.bytesSent, t: s.timestamp, codec: codecs.get(s.codecId) });
        }
        if (dir === "in" && s.type === "inbound-rtp" && s.bytesReceived > 0) {
          res.push({ w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesReceived, t: s.timestamp, freezes: s.freezeCount, freezeDur: s.totalFreezesDuration, frames: s.framesDecoded, qpSum: s.qpSum });
        }
      });
    }
    return res.sort((a, b) => b.bytes - a.bytes)[0] ?? null;
  }, dir);
}

const prev = {};
function rate(key, s) {
  const p = prev[key];
  prev[key] = s;
  if (!p || !s || s.t <= p.t) return { kbps: 0, qp: null };
  return { kbps: Math.round(((s.bytes - p.bytes) * 8) / (s.t - p.t)), qp: s.frames > p.frames && s.qpSum !== undefined ? Math.round((s.qpSum - p.qpSum) / (s.frames - p.frames)) : null };
}

const series = [];
async function sample(label) {
  const o = await stats(sender.page, "out");
  const i = await stats(viewer.page, "in");
  const ro = rate("o", o);
  const ri = rate("i", i);
  const row = { o, i, ro, ri };
  series.push(row);
  if (E.VERBOSE) console.log(`  [${label}] OUT ${o?.w}x${o?.h}@${o?.fps} ${ro.kbps}kbps qp${ro.qp} ${o?.lim} | IN ${i?.w}x${i?.h}@${i?.fps} freezes=${i?.freezes}`);
  return row;
}

await sleep(2500);
await tweak();
const t0 = Date.now();
while (Date.now() - t0 < WARM * 1000) {
  await sleep(3000);
  await sample(`aquecendo ${Math.round((Date.now() - t0) / 1000)}s`);
  await tweak();
}

// Coleta de quadros no receptor (resolução nativa) + número do quadro pelo código de barras.
const frames = [];
for (let k = 0; k < SAMPLES; k++) {
  await sleep(1500);
  await sample(`coleta ${k}`);
  const f = await viewer.page.evaluate(({ W }) => {
    const v = [...document.querySelectorAll("#screens video")].find((x) => x.videoWidth > 0);
    if (!v) return null;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext("2d");
    g.drawImage(v, 0, 0);
    const s = v.videoWidth / W;
    const BAR = 24;
    let n = 0;
    for (let b = 0; b < 24; b++) {
      const x = Math.round((BAR * (b + 1) + BAR / 2) * s);
      const y = Math.round(BAR * s);
      const d = g.getImageData(x - 1, y - 1, 3, 3).data;
      let lum = 0;
      for (let i = 0; i < d.length; i += 4) lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum / 9 > 128) n |= 1 << b;
    }
    return { n, w: v.videoWidth, h: v.videoHeight, png: c.toDataURL("image/png") };
  }, { W: dims.W });
  if (f) {
    // Referência exata do quadro n, desenhada no próprio Chrome que captura.
    f.ref = await sender.page.evaluate((n) => window.__rawFrame(n), f.n);
    if (f.ref) frames.push(f);
    else console.log(`  quadro ${f.n} fora do buffer do remetente`);
  }
}

// Métricas (só a matemática roda num Chromium à parte).
const ref = await chromium.launch({ headless: true });
const rp = await ref.newPage({ viewport: { width: 400, height: 300 } });
const results = [];
for (const [k, f] of frames.entries()) {
  const refPng = f.ref;
  const m = await rp.evaluate(async ({ a, b }) => {
    // Referência = o mesmo quadro capturado (antes do encoder), no tamanho da captura; o
    // recebido (que pode ter vindo reduzido) é ampliado para esse tamanho.
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const W = ia.naturalWidth;
    const H = ia.naturalHeight;
    const lumOf = (img, isRef) => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      if (isRef) g.drawImage(img, 0, 0, W, H, 0, 0, W, H);
      else g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const y = new Float32Array(W * H);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) y[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return y;
    };
    const ya = lumOf(ia, true), yb0 = lumOf(ib, false);
    // Alinhamento: a captura de aba pode vir deslocada 1-2 px (borda da janela). Procura o
    // deslocamento (dx, dy) que minimiza o erro numa amostra e compara com ele.
    let best = { dx: 0, dy: 0, e: Infinity };
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      let e = 0;
      for (let y = 80; y < H - 8; y += 3) for (let x = 8; x < W - 8; x += 3) {
        const d = ya[y * W + x] - yb0[(y + dy) * W + x + dx];
        e += d * d;
      }
      if (e < best.e) best = { dx, dy, e };
    }
    const yb = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const yy = Math.min(H - 1, Math.max(0, y + best.dy)), xx = Math.min(W - 1, Math.max(0, x + best.dx));
      yb[y * W + x] = yb0[yy * W + xx];
    }
    // Ignora a faixa do código de barras.
    const skip = (x, y) => (y < 60 && x < 700) || x < 3 || y < 3 || x >= W - 3 || y >= H - 3;
    let se = 0, cnt = 0;
    let seText = 0, cntText = 0;
    const tx0 = Math.round(W * 0.52), ty0 = Math.round(H * 0.08), tx1 = tx0 + Math.round(W * 0.44), ty1 = ty0 + Math.round(H * 0.5);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (skip(x, y)) continue;
      const e = ya[y * W + x] - yb[y * W + x];
      se += e * e;
      cnt++;
      if (x >= tx0 && x < tx1 && y >= ty0 && y < ty1) { seText += e * e; cntText++; }
    }
    const psnr = (s, n) => 10 * Math.log10((255 * 255) / Math.max(1e-9, s / n));
    // SSIM em blocos 8x8 (luma).
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let ss = 0, nb = 0;
    for (let by = 64; by + 8 <= H; by += 8) for (let bx = 0; bx + 8 <= W; bx += 8) {
      let ma = 0, mb = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { ma += ya[(by + y) * W + bx + x]; mb += yb[(by + y) * W + bx + x]; }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const a = ya[(by + y) * W + bx + x] - ma, b = yb[(by + y) * W + bx + x] - mb;
        va += a * a; vb += b * b; cov += a * b;
      }
      va /= 63; vb /= 63; cov /= 63;
      ss += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      nb++;
    }
    return { psnr: psnr(se, cnt), psnrText: psnr(seText, cntText), ssim: ss / nb, shift: `${best.dx},${best.dy}` };
  }, { a: refPng, b: f.png });
  results.push({ n: f.n, w: f.w, h: f.h, ...m });
  if (k === 0 || k === frames.length - 1) {
    writeFileSync(`${OUT_DIR}/lab-${TAG}-rx${k}.png`, Buffer.from(f.png.split(",")[1], "base64"));
    writeFileSync(`${OUT_DIR}/lab-${TAG}-ref${k}.png`, Buffer.from(refPng.split(",")[1], "base64"));
  }
}
await ref.close();

const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const tail = series.slice(-SAMPLES);
const o = tail[tail.length - 1]?.o;
const inb = tail[tail.length - 1]?.i;
const summary = {
  tag: TAG,
  cfg: { CODEC: E.CODEC || "(app)", MAXBR: E.MAXBR || "(app)", SWENC: !!E.SWENC, DEG: E.DEG || "(app)", HINT: E.HINT || "(app)" },
  enc: `${o?.codec} ${o?.enc}`,
  sent: `${o?.w}x${o?.h}@${o?.fps}`,
  kbps: Math.round(avg(tail.map((r) => r.ro.kbps))),
  qp: Math.round(avg(tail.map((r) => r.ro.qp ?? 0))),
  lim: o?.lim,
  recv: `${inb?.w}x${inb?.h}@${inb?.fps}`,
  freezes: inb?.freezes,
  psnr: +avg(results.map((r) => r.psnr)).toFixed(2),
  psnrMin: +Math.min(...results.map((r) => r.psnr)).toFixed(2),
  psnrText: +avg(results.map((r) => r.psnrText)).toFixed(2),
  ssim: +avg(results.map((r) => r.ssim)).toFixed(4),
  frames: results.map((r) => `${r.n}:${r.w}x${r.h}:${r.psnr.toFixed(1)}@${r.shift}`).join(" "),
};
console.log("RESULT " + JSON.stringify(summary));
if (E.DEBUGSNAP) {
  const d = await sender.page.evaluate(() => window.__NITRO_DEBUG__?.());
  const log = await sender.page.evaluate(() => [...document.querySelectorAll("#status-log div")].map((x) => x.textContent).filter((t) => /Tela|codec|CODEC|GPU|CPU/.test(t ?? "")));
  console.log("DEBUG", JSON.stringify({ hw: d?.hwEncoders, skip: d?.codecSkip, links: (d?.links ?? []).filter((l) => l.negotiated).map((l) => ({ slot: l.slot, name: l.name, codec: l.codec, negotiated: l.negotiated, encoder: l.encoder })) }), "LOG", JSON.stringify(log));
}
await sender.browser.close();
await viewer.browser.close();
for (const k of kids) k.kill();
process.exit(0);

