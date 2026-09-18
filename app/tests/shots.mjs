// Capturas da interface em celular e desktop (entrada e chamada com tela compartilhada).
//   node tests/shots.mjs [pasta]   (padrão: ./shots)   LANG_UI=en para inglês
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const OUT = process.argv[2] || "shots";
const LANG = process.env.LANG_UI || "pt";
mkdirSync(OUT, { recursive: true });
const bin = (rel) => fileURLToPath(new URL(`../node_modules/${rel}`, import.meta.url));
const PEER_PORT = 9110;
const VITE_PORT = 1520;
const URL_ = `http://localhost:${VITE_PORT}/`;
const kids = [
  spawn(process.execPath, [bin("peer/dist/bin/peerjs.js"), "--port", String(PEER_PORT)], { stdio: "ignore" }),
  spawn(process.execPath, [bin("vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"], { stdio: "ignore" }),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(u) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(u)).ok) return;
    } catch {
      /* subindo */
    }
    await sleep(300);
  }
  throw new Error(`sem resposta: ${u}`);
}

const ROOM = `shots-${Date.now().toString(36)}`;
const PROFILES = {
  iphoneSE: { ...devices["iPhone SE"] },
  pixel7: { ...devices["Pixel 7"] },
  desktop: { viewport: { width: 1366, height: 768 } },
};

async function open(profile, name, { share = false } = {}) {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const { defaultBrowserType: _d, ...ctxOpts } = PROFILES[profile];
  const context = await browser.newContext({ ...ctxOpts, permissions: ["microphone", "camera"] });
  await context.addInitScript(
    ({ port, lang }) => {
      window.__NITRO_FAKE_SCREEN__ = true;
      window.__NITRO_FAKE_SCREEN_AUDIO__ = true;
      localStorage.setItem("nitrocall.server", `http://localhost:${port}`);
      localStorage.setItem("nitrocall.nostr", "off");
      localStorage.setItem("nitrocall.turn", "off");
      localStorage.setItem("nitrocall.lang", lang);
    },
    { port: PEER_PORT, lang: LANG },
  );
  const page = await context.newPage();
  await page.goto(URL_);
  await sleep(800);
  await page.screenshot({ path: `${OUT}/${profile}-1-entrada.png`, fullPage: true });
  await page.fill("#room-code-input", ROOM);
  if (name) await page.fill("#name-input", name);
  await page.click("#join-form button[type=submit]");
  if (share) {
    await sleep(2500);
    await page.click("#share-screen-btn");
  }
  return { browser, page, profile };
}

try {
  await waitHttp(`http://localhost:${PEER_PORT}/peerjs/id`);
  await waitHttp(URL_);
  const host = await open("desktop", "Rafael", { share: true });
  const others = [await open("iphoneSE", "Claudio"), await open("pixel7", "Jorge", { share: true })];
  await sleep(9000);
  for (const u of [host, ...others]) await u.page.screenshot({ path: `${OUT}/${u.profile}-2-chamada.png`, fullPage: true });
  for (const u of [host, ...others]) await u.browser.close();
  console.log(`capturas em ${OUT}/`);
} finally {
  for (const k of kids) k.kill();
}
