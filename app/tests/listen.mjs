// Ouve o rádio de log dos aparelhos (link com #debug=<token>): mostra ao vivo o registro, os
// erros e o estado de cada iPhone/Android que abrir o link com o mesmo token.
//   node tests/listen.mjs <token>            (relays Nostr públicos)
//   RELAYS=ws://localhost:9020 node tests/listen.mjs <token>
//   OUT=arquivo.log  → também grava tudo em arquivo
import { createDecipheriv, createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("uso: node tests/listen.mjs <token>");
  process.exit(1);
}
const RELAYS = (process.env.RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://nostr.mom")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = process.env.OUT || "";
const sha = (s) => createHash("sha256").update(s, "utf8").digest();
const TOPIC = sha(`nitrocall-debug-topic|${TOKEN}`).toString("hex").slice(0, 32);
const KEY = sha(`nitrocall-debug-key|${TOKEN}`);
const KIND = 24242;
const seen = new Set();
const devices = new Map();

function out(line) {
  console.log(line);
  if (OUT) appendFileSync(OUT, `${line}\n`);
}

function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

function label(dev) {
  const d = devices.get(dev);
  return d ? `[${dev} ${d}]` : `[${dev}]`;
}

function shortUa(ua) {
  const os = /iPhone OS ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, ".") ? `iOS ${/iPhone OS ([\d_]+)/.exec(ua)[1].replace(/_/g, ".")}`
    : /iPad|Macintosh.*Mobile/.test(ua) ? "iPadOS"
    : /Android ([\d.]+)/.exec(ua)?.[1] ? `Android ${/Android ([\d.]+)/.exec(ua)[1]}`
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : "?";
  const br = /CriOS/.test(ua) ? "Chrome iOS" : /FxiOS/.test(ua) ? "Firefox iOS" : /EdgiOS|EdgA|Edg\//.test(ua) ? "Edge"
    : /Brave/.test(ua) ? "Brave" : /SamsungBrowser/.test(ua) ? "Samsung" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "?";
  return `${br} · ${os}`;
}

function handle(ev) {
  if (!ev || seen.has(ev.id)) return;
  seen.add(ev.id);
  let msg;
  try {
    msg = decrypt(ev.content);
  } catch {
    return;
  }
  const dev = msg.dev;
  const time = new Date().toLocaleTimeString("pt-BR", { hour12: false });
  if (msg.t === "hello") {
    devices.set(dev, shortUa(msg.ua || ""));
    out(`${time} ${label(dev)} ▶ conectou: ${msg.ua}`);
    out(`${time} ${label(dev)}   tela ${msg.screen} · recursos ${JSON.stringify(msg.caps)}`);
  } else if (msg.t === "logs") {
    for (const l of msg.lines || []) out(`${time} ${label(dev)} ${l.replace(/^\S+Z /, "")}`);
  } else if (msg.t === "state") {
    out(`${time} ${label(dev)} ⓢ estado: ${msg.json}`);
  } else {
    out(`${time} ${label(dev)} ${JSON.stringify(msg)}`);
  }
}

function connect(url) {
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(() => connect(url), 5000);
    return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify(["REQ", `listen-${Math.random().toString(36).slice(2, 8)}`, { kinds: [KIND], "#h": [TOPIC], since: Math.floor(Date.now() / 1000) - 120 }]));
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m[0] === "EVENT") handle(m[2]);
    } catch {
      /* ignora */
    }
  };
  ws.onclose = () => setTimeout(() => connect(url), 5000);
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignora */
    }
  };
}

out(`ouvindo o token "${TOKEN}" (tópico ${TOPIC}) em ${RELAYS.length} relay(s)… Ctrl+C para sair`);
for (const r of RELAYS) connect(r);
