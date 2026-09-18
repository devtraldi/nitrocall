// Bots de carga: N contas entram numa sala real (broker público) compartilhando um
// vídeo animado (bola quicando + relógio + contador), com mic mudo.
//   node tests/bots.mjs            (sala "nitro", 9 bots)
//   ROOM=x BOTS=4 PASSWORD=y W=640 H=360 FPS=15 node tests/bots.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOM = process.env.ROOM || "nitro";
const BOTS = Number(process.env.BOTS || 9);
const PASSWORD = process.env.PASSWORD || "";
const W = Number(process.env.W || 640), H = Number(process.env.H || 360), FPS = Number(process.env.FPS || 15);
const PORT = Number(process.env.VITE_PORT || 1420);
const URL_ = `http://localhost:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
for (let i = 0; i < 100; i++) { try { if ((await fetch(URL_)).ok) break; } catch {} await sleep(300); }

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=IntensiveWakeUpThrottling"],
});
const bots = [];
for (let i = 1; i <= BOTS; i++) {
  const name = `Bot ${i}`;
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  await ctx.addInitScript(({ i, W, H, FPS }) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const g = c.getContext("2d"); const hue = (i * 40) % 360;
      let x = 50, y = 50, dx = 7 + i, dy = 5 + i / 2, f = 0;
      setInterval(() => {
        f++; x += dx; y += dy;
        if (x < 30 || x > W - 30) dx = -dx; if (y < 30 || y > H - 30) dy = -dy;
        g.fillStyle = `hsl(${(hue + f) % 360} 55% 22%)`; g.fillRect(0, 0, W, H);
        g.fillStyle = "#ffd400"; g.beginPath(); g.arc(x, y, 28, 0, 7); g.fill();
        g.fillStyle = "#fff"; g.font = `bold ${H / 8}px sans-serif`; g.fillText(`BOT ${i}`, 20, H / 6);
        g.font = `${H / 12}px monospace`; g.fillText(new Date().toLocaleTimeString("pt-BR") + `  #${f}`, 20, H - 20);
      }, 1000 / FPS);
      return c.captureStream(FPS);
    };
  }, { i, W, H, FPS });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] ${e}`));
  await page.goto(URL_);
  await page.fill("#room-code-input", ROOM);
  await page.fill("#name-input", name);
  await page.fill("#password-input", PASSWORD);
  await page.click("#join-form button[type=submit]");
  bots.push({ name, page });
  console.log(`${name} entrando…`);
  await sleep(1500);
}

const status = (p) => p.evaluate(() => ({
  broker: document.querySelector("#broker-pill")?.textContent ?? "",
  health: document.querySelector("#health-pill")?.textContent ?? "",
  inCall: !!document.querySelector("#share-screen-btn") && document.querySelector("#share-screen-btn").offsetParent !== null,
  peers: [...document.querySelectorAll("#participants .chip")].filter((c) => c.id !== "chip-self").map((c) => `${c.querySelector(".chip-name")?.textContent}:${c.dataset.audio}`),
}));

for (const b of bots) {
  for (let t = 0; t < 60; t++) { const s = await status(b.page); if (s.inCall) break; await sleep(500); }
  try { await b.page.click("#toggle-mic-btn", { timeout: 5000 }); } catch {}
  try { await b.page.click("#share-screen-btn", { timeout: 5000 }); console.log(`${b.name} compartilhando`); } catch (e) { console.log(`${b.name} não conseguiu compartilhar: ${e.message.split("\n")[0]}`); }
}

const stop = async () => { await browser.close().catch(() => {}); vite.kill(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
for (;;) {
  const s = await status(bots[0].page).catch((e) => ({ err: String(e) }));
  console.log(new Date().toLocaleTimeString("pt-BR"), JSON.stringify(s));
  await sleep(15000);
}
