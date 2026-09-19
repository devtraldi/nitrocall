// Laboratório ao vivo: bots (Chromium) entram numa sala do site publicado pelo modo bot, e um
// painel mostra, a cada 5 s, quem cada bot vê/ouve. Junto com o rádio de log
// (tests/listen.mjs) dá para acompanhar um iPhone/Android de verdade entrando na mesma sala.
//   SITE=https://devtraldi.github.io/nitrocall/teste/ ROOM=teste-ios BOTS=2 TOKEN=abc node tests/live.mjs
//   RELAY=1 → um dos bots só consegue relay (como 4G/CGNAT); CAM=1 → o 1º bot mostra câmera
import { chromium } from "playwright";

const SITE = process.env.SITE || "https://devtraldi.github.io/nitrocall/teste/";
const ROOM = process.env.ROOM || `teste-${Date.now().toString(36)}`;
const BOTS = Number(process.env.BOTS || 2);
const TOKEN = process.env.TOKEN || "";
const RELAY = !!process.env.RELAY;
const CAM = !!process.env.CAM;
const MINUTES = Number(process.env.MINUTES || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function relayOnlyInit() {
  const O = window.RTCPeerConnection;
  window.RTCPeerConnection = function (c = {}, ...r) {
    return new O({ ...c, iceTransportPolicy: "relay" }, ...r);
  };
  window.RTCPeerConnection.prototype = O.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, O);
}

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const bots = [];
for (let i = 1; i <= BOTS; i++) {
  const name = `Bot ${i}${RELAY && i === BOTS ? " (4G)" : ""}`;
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
  if (RELAY && i === BOTS) await ctx.addInitScript(relayOnlyInit);
  const page = await ctx.newPage();
  const params = new URLSearchParams({ sala: ROOM, bot: name });
  if (TOKEN) params.set("debug", TOKEN);
  if (CAM && i === 1) params.set("cam", "1");
  await page.goto(`${SITE}?v=${Date.now()}#${params.toString().replace(/\+/g, "%20")}`);
  bots.push({ name, page });
  await sleep(1500);
}
console.log(`sala "${ROOM}" · ${BOTS} bot(s) em ${SITE}`);
console.log(`link para o celular: ${SITE}#sala=${ROOM}${TOKEN ? `&debug=${TOKEN}` : ""}`);

const until = Date.now() + MINUTES * 60_000;
let last = "";
while (Date.now() < until) {
  const rows = [];
  for (const b of bots) {
    const view = await b.page
      .evaluate(() => ({
        me: document.querySelector("#self-label")?.textContent ?? "",
        health: document.querySelector("#health-pill")?.textContent ?? "",
        chips: [...document.querySelectorAll("#participants .chip:not(#chip-self)")].map(
          (c) => `${c.dataset.name}:${c.dataset.audio}/${c.dataset.presence}${c.dataset.turn === "true" ? "/TURN" : ""}${c.dataset.verified === "ok" ? "/🔒" : ""}`,
        ),
      }))
      .catch(() => null);
    rows.push(`${b.name} [${view?.health ?? "?"}] ${view?.chips.join("  ") || "(ninguém)"}`);
  }
  const text = rows.join("\n");
  if (text !== last) {
    console.log(`\n${new Date().toLocaleTimeString("pt-BR", { hour12: false })}\n${text}`);
    last = text;
  }
  await sleep(5000);
}
await browser.close();
