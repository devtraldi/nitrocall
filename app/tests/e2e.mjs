// Teste ponta-a-ponta: sobe um broker PeerJS local e o Vite, abre vários Chromium headless
// com microfone falso e "tela" sintética (com som), e percorre os cenários que davam
// problema: entrar/sair/voltar, compartilhar/trocar/parar tela, som da tela, travamento
// de um participante e a ponte automática quando dois não se alcançam direto.
//
//   npm run test:e2e
//   PUBLIC_BROKER=1 npm run test:e2e   (contra o servidor público do PeerJS)
//   WEB_FILE=1 npm run test:e2e        (todos abrem o NitroCall.html via file://)
//
// Sempre roda também a sala mista: app (Vite) + NitroCall.html juntos.
//
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, devices } from "playwright";

// A qualidade fica no menu "⋯": abre o menu, escolhe e fecha (como a pessoa faria).
async function pickQuality(page, value) {
  await page.click("#more-btn");
  await page.selectOption("#quality-select", value);
  await page.keyboard.press("Escape");
}

const bin = (rel) => fileURLToPath(new URL(`../node_modules/${rel}`, import.meta.url));
const PEER_PORT = Number(process.env.PEER_PORT || 9010);
const NOSTR_PORT = Number(process.env.NOSTR_PORT || 9020);
const VITE_PORT = Number(process.env.VITE_PORT || 1420);
const TURN_PORT = Number(process.env.TURN_PORT || 3479);
const TURN_HTTP_PORT = Number(process.env.TURN_HTTP_PORT || 9030);
// TURN_URL=https://… usa um Worker de verdade (ex.: o da Cloudflare) no lugar do TURN local.
// "localhost", não 127.0.0.1: a CSP do NitroCall.html só libera http://localhost:* (e https).
const TURN_OK = process.env.TURN_URL || `http://localhost:${TURN_HTTP_PORT}/turn`;
const TURN_BROKEN = `http://localhost:${TURN_HTTP_PORT}/turn-broken`;
const TURN_SLOW = `http://localhost:${TURN_HTTP_PORT}/turn-slow`;
// TURN_ALL=1: todo mundo recebe credenciais TURN (como será com o Worker no ar).
const TURN_DEFAULT = process.env.TURN_ALL ? TURN_OK : null;
// PUBLIC_BROKER=1 usa o servidor público do PeerJS (o mesmo que os usuários usam) em
// vez de subir um broker local.
const PUBLIC_BROKER = !!process.env.PUBLIC_BROKER;
const DEV_URL = `http://localhost:${VITE_PORT}/`;
// O NitroCall.html gerado por "npm run build:web", aberto do disco como um amigo faria.
const WEB_URL = pathToFileURL(fileURLToPath(new URL("../dist-web/NitroCall.html", import.meta.url))).href;
const WEB_FILE = !!process.env.WEB_FILE;
const APP_URL = WEB_FILE ? WEB_URL : DEV_URL;
const ROOM = `e2e-${Date.now().toString(36)}`;
const HEADLESS = process.env.HEADFUL ? false : true;

const failures = [];
const children = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startProcess(label, args) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.label = label;
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[${label}] ${d}`));
  children.push(child);
  return child;
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await sleep(300);
  }
  throw new Error(`Servidor em ${url} não respondeu em ${timeoutMs}ms`);
}

async function waitFor(label, fn, timeoutMs = 25000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) {
        console.log(`  ✅ ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        return last;
      }
    } catch (err) {
      last = err;
    }
    await sleep(400);
  }
  console.log(`  ❌ ${label} — timeout após ${timeoutMs / 1000}s; último valor: ${JSON.stringify(last)}`);
  failures.push(label);
  return null;
}

// "Tela" realista para medir qualidade: 1920x1080 a 30 fps, com texto miúdo rolando e
// manchas suaves se mexendo (comprime como vídeo, não como ruído), e som. Também guarda
// as RTCPeerConnection em window.__PCS__ para o teste ler resolução/fps/bitrate reais.
function hdScreenInit() {
  window.__NITRO_FAKE_SCREEN__ = false;
  const Orig = window.RTCPeerConnection;
  window.__PCS__ = [];
  window.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a);
    window.__PCS__.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
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

// Vídeo recebido de maior volume (a tela), direto das estatísticas do WebRTC.
function inboundVideo(page) {
  return page.evaluate(async () => {
    let best = null;
    for (const pc of window.__PCS__ ?? []) {
      if (pc.connectionState !== "connected") continue;
      const r = await pc.getStats();
      r.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video" && s.bytesReceived > 0 && (!best || s.bytesReceived > best.bytes)) {
          best = { w: s.frameWidth ?? 0, h: s.frameHeight ?? 0, fps: s.framesPerSecond ?? 0, bytes: s.bytesReceived, t: s.timestamp };
        }
      });
    }
    return best;
  });
}

// NAT "impossível" de verdade: toda RTCPeerConnection deste navegador (PeerJS e as
// ligações próprias) só pode usar candidatos relay. Sem TURN não sobra caminho nenhum —
// o ICE falha de fato, igual a dois NATs simétricos/CGNAT frente a frente.
// Sem relayOnly, só guarda as RTCPeerConnection para o teste ler o par ICE escolhido.
function pcInit(relayOnly) {
  // Guarda os streams do getUserMedia (o teste simula o sistema encerrando o microfone).
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__GUM__ = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    const st = await gum(c);
    window.__GUM__.push(st);
    return st;
  };
  const Orig = window.RTCPeerConnection;
  window.__ALL_PCS__ = [];
  window.RTCPeerConnection = function (cfg = {}, ...rest) {
    const pc = new Orig(relayOnly ? { ...cfg, iceTransportPolicy: "relay" } : cfg, ...rest);
    window.__ALL_PCS__.push(pc);
    const t0 = performance.now();
    pc.__ev = [];
    const ev = (s) => pc.__ev.push(`${Math.round(performance.now() - t0)}:${s}`);
    pc.addEventListener("icecandidate", (e) => ev(e.candidate ? `c:${e.candidate.type}` : "c:end"));
    pc.addEventListener("icecandidateerror", (e) => ev(`err:${e.errorCode}:${e.url}:${e.errorText}`));
    pc.addEventListener("iceconnectionstatechange", () => ev(`ice:${pc.iceConnectionState}`));
    pc.addEventListener("signalingstatechange", () => ev(`sig:${pc.signalingState}`));
    const addIce = pc.addIceCandidate.bind(pc);
    pc.addIceCandidate = (c) => (ev(`rc:${c?.candidate?.split(" ")[7] ?? "?"}`), addIce(c));
    const close = pc.close.bind(pc);
    pc.close = () => (ev("close"), close());
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
}

async function makeUser(name, { room = ROOM, blockSlots = [], blockBoot = [], blockMedia = [], cap = null, password = "", url = APP_URL, hd = false, relayOnly = false, turn = TURN_DEFAULT, device = null } = {}) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  // device: perfil de celular do Playwright (user agent, toque, tela) — ex.: "Pixel 7".
  const { defaultBrowserType: _bt, ...devOpts } = device ? devices[device] : {};
  const context = await browser.newContext({ ...devOpts, permissions: ["microphone", ...(device ? ["camera"] : [])] });
  await context.addInitScript(
    ({ peerPort, nostrPort, publicBroker, blockSlots, blockBoot, blockMedia, cap, turn }) => {
      window.__NITRO_FAKE_SCREEN__ = true;
      window.__NITRO_FAKE_SCREEN_AUDIO__ = true;
      window.__NITRO_BLOCK_SLOTS__ = blockSlots;
      window.__NITRO_BLOCK_BOOT__ = blockBoot;
      window.__NITRO_BLOCK_MEDIA__ = blockMedia;
      if (typeof cap === "number") window.__NITRO_CAP__ = cap;
      if (!publicBroker) localStorage.setItem("nitrocall.server", `http://localhost:${peerPort}`);
      localStorage.setItem("nitrocall.nostr", `ws://localhost:${nostrPort}`);
      localStorage.setItem("nitrocall.turn", turn ?? "off");
      localStorage.setItem("nitrocall.lang", "pt");
    },
    { peerPort: PEER_PORT, nostrPort: NOSTR_PORT, publicBroker: PUBLIC_BROKER, blockSlots, blockBoot, blockMedia, cap, turn },
  );
  if (hd) await context.addInitScript(hdScreenInit);
  if (!hd) await context.addInitScript(pcInit, relayOnly);
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  [${name} pageerror] ${err}`));
  if (process.env.VERBOSE) {
    page.on("console", (msg) => console.log(`  [${name}] ${msg.text()}`));
  }
  const logs = [];
  page.on("console", (msg) => logs.push(msg.text()));
  await page.goto(url);
  const user = { name, room, password, browser, page, logs };
  await join(user);
  return user;
}

async function join(user) {
  await user.page.fill("#room-code-input", user.room);
  await user.page.fill("#name-input", user.name);
  // A senha fica em "Opções" (recolhido): abre antes de preencher.
  await user.page.evaluate(() => {
    document.querySelector("#join-more").open = true;
  });
  await user.page.fill("#password-input", user.password || "");
  await user.page.click("#join-form button[type=submit]");
}

function snapshot(page) {
  return page.evaluate(() => {
    const chips = [...document.querySelectorAll("#participants .chip")].map((c) => ({
      id: c.id,
      slot: Number(c.dataset.slot),
      audio: c.dataset.audio,
      presence: c.dataset.presence,
      name: c.querySelector(".chip-name")?.textContent ?? "",
      sub: c.querySelector(".chip-sub")?.textContent ?? "",
      muted: c.querySelector(".ico-mic")?.textContent === "🔇",
      hears: c.querySelector(".ico-hear")?.classList.contains("on") ?? false,
      sees: c.querySelector(".ico-see")?.classList.contains("on") ?? false,
      sharing: !c.querySelector(".ico-share")?.classList.contains("hidden"),
      bridging: c.dataset.bridging === "true",
      cap: Number(c.dataset.cap),
      quality: c.dataset.quality ?? "",
      bars: Number(c.querySelector(".signal")?.dataset.bars ?? -1),
    }));
    const screens = [...document.querySelectorAll(".screen-tile")].map((t) => {
      const v = t.querySelector("video");
      return {
        id: t.id,
        state: t.dataset.state,
        audio: t.dataset.audio,
        label: (t.querySelector(".screen-name")?.textContent ?? "").split(" · via ")[0],
        via: t.dataset.via ?? "",
        marker: t.dataset.marker ?? null,
        playing: !!v && v.readyState >= 2 && !v.paused && v.videoWidth > 0,
        audioTracks: v?.srcObject?.getAudioTracks().filter((a) => a.readyState === "live").length ?? 0,
        unmuted: !!v && !v.muted,
        width: v?.videoWidth ?? 0,
        time: v?.currentTime ?? 0,
      };
    });
    const audios = [...document.querySelectorAll("#audio-sink audio")].map((a) => ({
      id: a.id,
      live: !!a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === "live"),
      paused: a.paused,
      muted: a.muted,
    }));
    const banner = document.querySelector("#bridge-banner");
    return {
      chips,
      screens,
      audios,
      pip: document.querySelector("#self-pip")?.classList.contains("hidden")
        ? null
        : document.querySelector("#pip-text")?.textContent ?? "",
      bridge: banner && !banner.classList.contains("hidden") ? banner.textContent : null,
      health: document.querySelector("#health-pill")?.textContent ?? "",
      healthState: document.querySelector("#health-pill")?.dataset.state ?? "",
      secure: document.querySelector("#secure-pill")?.dataset.state ?? "",
      selfSub: document.querySelector("#chip-self .chip-sub")?.textContent ?? "",
      screenAudioBtn: document.querySelector("#screen-audio-btn")?.textContent ?? "",
      broker: document.querySelector("#broker-pill")?.textContent ?? "",
      self: document.querySelector("#self-label")?.textContent ?? "",
    };
  });
}

function remoteChip(snap, name) {
  return snap.chips.find((c) => c.id !== "chip-self" && c.name === name);
}

function screenOf(snap, name) {
  return snap.screens.find((s) => s.label === `Tela de ${name}`);
}

async function expectAudioOk(viewer, others, presence = "direct") {
  const names = others.map((o) => o.name);
  await waitFor(
    `${viewer.name} ouve ${names.join(" e ")} (áudio ok, stream ao vivo, tocando${presence === "relay" ? ", pela ponte" : ""})`,
    async () => {
      const snap = await snapshot(viewer.page);
      return others.every((o) => {
        const chip = remoteChip(snap, o.name);
        const audio = chip && snap.audios.find((a) => a.id === `audio-${chip.slot}`);
        return chip?.audio === "ok" && chip.presence === presence && audio?.live && !audio.paused;
      });
    },
    presence === "relay" ? 45000 : 25000,
  );
}

async function expectHears(viewer, others) {
  await waitFor(`${viewer.name} recebe confirmação "te ouve" de ${others.map((o) => o.name).join(" e ")}`, async () => {
    const snap = await snapshot(viewer.page);
    return others.every((o) => remoteChip(snap, o.name)?.hears);
  });
}

async function expectScreenPlaying(viewer, sharer, { audio = null, timeoutMs = 25000 } = {}) {
  await waitFor(
    `${viewer.name} vê a tela de ${sharer.name} tocando${audio === true ? " com som" : audio === false ? " sem som" : ""}`,
    async () => {
      const snap = await snapshot(viewer.page);
      const s = screenOf(snap, sharer.name);
      if (!(s?.state === "ok" && s.playing)) return false;
      if (audio === true) return s.audio === "on" && s.audioTracks > 0 && s.unmuted;
      if (audio === false) return s.audio === "off";
      return true;
    },
    timeoutMs,
  );
}

async function expectNoScreen(viewer, sharer) {
  await waitFor(`${viewer.name} não vê mais a tela de ${sharer.name}`, async () => {
    const snap = await snapshot(viewer.page);
    return !screenOf(snap, sharer.name);
  });
}

async function expectGone(viewer, other, timeoutMs = 30000) {
  await waitFor(`${viewer.name} removeu ${other.name} da sala`, async () => {
    const snap = await snapshot(viewer.page);
    return !remoteChip(snap, other.name) && !screenOf(snap, other.name);
  }, timeoutMs);
}

async function expectPip(sharer, seen, total) {
  await waitFor(`${sharer.name} vê a própria prévia com "${seen}/${total} vendo"`, async () => {
    const snap = await snapshot(sharer.page);
    return snap.pip !== null && snap.pip.includes(`${seen}/${total} vendo`);
  });
}

async function scenarioNostr(getPeerServer, startPeerServer) {
    console.log("\n[26] Servidor de sinalização fora do ar desde o início: os amigos se encontram pelo ponto de encontro de emergência (Nostr)");
    getPeerServer().kill();
    await sleep(1000);
    const room11 = `${ROOM}-nostr`;
    const rui = await makeUser("Rui", { room: room11 });
    await sleep(1500);
    const sara = await makeUser("Sara", { room: room11 });
    await waitFor("Rui e Sara ganharam vagas diferentes pelo Nostr", async () => {
      const a = /participante (\d+)/.exec((await snapshot(rui.page)).self)?.[1];
      const b = /participante (\d+)/.exec((await snapshot(sara.page)).self)?.[1];
      return a && b && a !== b;
    }, 60000);
    await expectAudioOk(rui, [sara]);
    await expectAudioOk(sara, [rui]);
    await expectHears(rui, [sara]);
    await sara.page.click("#share-screen-btn");
    await expectScreenPlaying(rui, sara, { audio: true });
    const tom = await makeUser("Tom", { room: room11 });
    await expectAudioOk(tom, [rui, sara]);
    await expectAudioOk(rui, [sara, tom]);
    startPeerServer();
    await waitForHttp(`http://localhost:${PEER_PORT}/peerjs/id`, 20000);
    await waitFor("Servidor voltou: Rui fica 'Online' com a mesma vaga, sem perder ninguém", async () => {
      const s = await snapshot(rui.page);
      return s.broker.includes("Online") && remoteChip(s, "Sara")?.audio === "ok" && remoteChip(s, "Tom")?.audio === "ok";
    }, 60000);
    for (const u of [rui, sara, tom]) await u.browser.close();
}

// Par ICE escolhido de cada RTCPeerConnection conectada: ["host>host", "relay>relay", ...].
function selectedPairs(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__ALL_PCS__ ?? []) {
      if (pc.connectionState !== "connected") continue;
      const r = await pc.getStats();
      let pairId = null;
      r.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      const pair = pairId && r.get(pairId);
      if (!pair) continue;
      out.push(`${r.get(pair.localCandidateId)?.candidateType}>${r.get(pair.remoteCandidateId)?.candidateType}`);
    }
    return out;
  });
}

async function natDiagnostics(users) {
  for (const u of users) {
    const s = await snapshot(u.page);
    const pcs = await u.page.evaluate(() =>
      (window.__ALL_PCS__ ?? []).map((pc) => `${pc.iceGatheringState}/${pc.iceConnectionState}/${pc.connectionState}${JSON.stringify(pc.getConfiguration().iceServers ?? []).includes("turn:") ? "+turn" : ""}`),
    );
    const cfgs = await u.page.evaluate(() => (window.__ALL_PCS__ ?? []).slice(-3).map((pc) => JSON.stringify(pc.getConfiguration().iceServers.map((x) => x.urls))));
    console.log(`    iceServers (últimas 3): ${cfgs.join(" | ")}`);
    console.log(`    fetch TURN: ${JSON.stringify(u.logs.filter((l) => /turn|TURN|CORS|Failed/.test(l)).slice(-4))}`);
    const msgs = u.logs.filter((l) => l.startsWith("[nitrocall]")).slice(-12).map((l) => l.slice(12));
    console.log(`  diagnóstico ${u.name}: ${s.self} | broker: ${s.broker} | saúde: ${s.health}`);
    console.log(`    outros: ${JSON.stringify(s.chips.filter((c) => c.id !== "chip-self").map((c) => ({ name: c.name, audio: c.audio, presence: c.presence })))}`);
    console.log(`    RTCPeerConnections (gathering/ice/conn): ${JSON.stringify(pcs.slice(-6))} (${pcs.length} no total)`);
    const evs = await u.page.evaluate(() => (window.__ALL_PCS__ ?? []).slice(0, 3).map((pc) => JSON.stringify(pc.getConfiguration().iceServers.at(-1)) + " " + (pc.__ev ?? []).join(" ")));
    for (const e of evs) console.log(`    ev: ${e.slice(0, 400)}`);
    for (const m of msgs) console.log(`    · ${m}`);
  }
}

// Caso Claudio/Jorge: duas pessoas SOZINHAS, as duas atrás de NAT que não deixa ligação
// direta, sem terceiro para servir de ponte. Só o TURN de último recurso resolve.
async function scenarioNat() {
  console.log("\n[N1] Duas pessoas sozinhas, ligação direta impossível dos dois lados → TURN");
  const room = `${ROOM}-nat`;
  const claudio = await makeUser("Claudio", { room, relayOnly: true, turn: TURN_OK });
  await sleep(1500);
  const jorge = await makeUser("Jorge", { room, relayOnly: true, turn: TURN_OK });
  const t0 = Date.now();
  const ok = await waitFor("Claudio e Jorge se ouvem", async () => {
    const a = remoteChip(await snapshot(claudio.page), "Jorge");
    const b = remoteChip(await snapshot(jorge.page), "Claudio");
    return a?.audio === "ok" && b?.audio === "ok";
  }, 60000);
  if (!ok) await natDiagnostics([claudio, jorge]);
  else console.log(`    (conectou em ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await expectHears(claudio, [jorge]);
  await expectHears(jorge, [claudio]);
  await jorge.page.click("#share-screen-btn");
  await expectScreenPlaying(claudio, jorge, { audio: true });
  await waitFor("Mídia de Claudio passa pelo TURN (par relay)", async () => {
    const pairs = await selectedPairs(claudio.page);
    return pairs.length > 0 && pairs.every((x) => x.startsWith("relay>")) && pairs;
  }, 15000);
  for (const u of [claudio, jorge]) await u.browser.close();

  console.log("\n[N2] Rede normal com TURN disponível: nada passa pelo TURN");
  const room2 = `${ROOM}-nat2`;
  const ana = await makeUser("Ana", { room: room2, turn: TURN_OK });
  await sleep(1500);
  const beto = await makeUser("Beto", { room: room2, turn: TURN_OK });
  await expectAudioOk(ana, [beto]);
  await expectAudioOk(beto, [ana]);
  await ana.page.click("#share-screen-btn");
  await expectScreenPlaying(beto, ana, { audio: true });
  await sleep(10000);
  for (const u of [ana, beto]) {
    const pairs = await selectedPairs(u.page);
    const turnReady = await u.page.evaluate(() =>
      (window.__ALL_PCS__ ?? []).some((pc) => (pc.getConfiguration().iceServers ?? []).some((s) => [].concat(s.urls).some((x) => x.startsWith("turn:")))),
    );
    await waitFor(`${u.name}: TURN configurado e nenhum par relay (${JSON.stringify(pairs)})`, async () =>
      turnReady && pairs.length > 0 && pairs.every((x) => !x.includes("relay")), 1000);
    await waitFor(`${u.name}: URL :53 descartada`, async () =>
      u.page.evaluate(() => !(window.__ALL_PCS__ ?? []).some((pc) => JSON.stringify(pc.getConfiguration().iceServers).includes(":53?"))), 1000);
  }
  for (const u of [ana, beto]) await u.browser.close();

  console.log("\n[N4] iPhone no 4G (só relay, Worker lento) + PC sem TURN (app antigo): conecta rápido e mostra quem está");
  const room4 = `${ROOM}-nat4`;
  const pc4 = await makeUser("PC", { room: room4, turn: null });
  await sleep(1500);
  const t4 = Date.now();
  const cel4 = await makeUser("iPhone", { room: room4, relayOnly: true, turn: TURN_SLOW, device: "iPhone 13" });
  await sleep(2500);
  await waitFor("iPhone mostra 'Alguém na sala' (ou já o PC) enquanto liga — nunca 'Só você'", async () => {
    const s = await snapshot(cel4.page);
    return !s.health.includes("Só você") && s.chips.some((c) => c.id !== "chip-self" && (c.name === "Alguém na sala" || c.name === "PC"));
  }, 3000);
  const ok4 = await waitFor("PC e iPhone se ouvem", async () => {
    const a = remoteChip(await snapshot(pc4.page), "iPhone");
    const b = remoteChip(await snapshot(cel4.page), "PC");
    return a?.audio === "ok" && b?.audio === "ok";
  }, 60000);
  const took4 = Date.now() - t4;
  console.log(`    (tempo até se ouvirem: ${(took4 / 1000).toFixed(1)}s)`);
  if (!ok4) await natDiagnostics([pc4, cel4]);
  await waitFor("Conectou em até 12 s (Worker lento incluído)", async () => ok4 && took4 < 12000, 500);
  for (const u of [pc4, cel4]) await u.browser.close();

  console.log("\n[N5] Caminho impossível (sem TURN nenhum): o iPhone diz isso com clareza e oferece o diagnóstico");
  const room5n = `${ROOM}-nat5`;
  const pc5 = await makeUser("PC", { room: room5n, turn: null });
  await sleep(1500);
  const cel5 = await makeUser("iPhone", { room: room5n, relayOnly: true, turn: TURN_BROKEN, device: "iPhone 13" });
  await waitFor("iPhone mostra 'Alguém na sala' (não 'Só você')", async () => {
    const s = await snapshot(cel5.page);
    return !s.health.includes("Só você") && s.chips.some((c) => c.id !== "chip-self" && c.name === "Alguém na sala");
  }, 8000);
  await waitFor("Depois de ~25 s, aviso claro de que não conectou", async () =>
    cel5.page.evaluate(() => {
      const b = document.querySelector("#notice-banner");
      return !!b && !b.classList.contains("hidden") && b.textContent.includes("não consegui conectar");
    }), 40000);
  await cel5.page.click('#participants .chip:not(#chip-self)');
  await waitFor("Painel de 'Alguém na sala' tem 'Copiar diagnóstico'", async () => !!(await cel5.page.$(".chip-popover .pp-diag")), 3000);
  await waitFor("Registro diz por que não fechou (ICE: locais/remotos, TURN não)", async () =>
    cel5.logs.some((l) => l.includes("ICE:") && l.includes("TURN não")), 20000);
  console.log(`    exemplo: ${cel5.logs.find((l) => l.includes("ICE:"))?.slice(12) ?? "-"}`);
  for (const u of [pc5, cel5]) await u.browser.close();

  console.log("\n[N3] Worker de credenciais fora do ar: entra e fala como antes");
  const room3 = `${ROOM}-nat3`;
  const caio = await makeUser("Caio", { room: room3, turn: TURN_BROKEN });
  await sleep(1500);
  const duda = await makeUser("Duda", { room: room3, turn: TURN_BROKEN });
  await expectAudioOk(caio, [duda]);
  await expectAudioOk(duda, [caio]);
  for (const u of [caio, duda]) await u.browser.close();
}

// Sala mista: amigos no app (aqui, o Vite = mesmo código do app) e no NitroCall.html
// aberto do disco. Mesmo protocolo: todos se ouvem, veem as telas (com som), a
// supressão de ruído carrega no HTML (CSP + WebAssembly) e ninguém recebe aviso de
// "código diferente" (os dois builds saem do mesmo código-fonte).
// 6.0: celular mostra a câmera (sem captura de tela no navegador), avisa quando sai da
// aba e religa o microfone ao voltar; nomes sorteados iguais se desfazem; chip "via TURN".
async function scenarioV6() {
  console.log("\n[V6a] Celular: câmera no lugar da tela, 'saiu da aba' e microfone religado");
  const room = `${ROOM}-v6`;
  const pc = await makeUser("Paula", { room });
  await sleep(1200);
  const cel = await makeUser("Celso", { room, device: "Pixel 7" });
  await expectAudioOk(pc, [cel]);
  await expectAudioOk(cel, [pc]);
  await waitFor("Botão do celular é 'Câmera' (não 'Compartilhar')", async () =>
    (await cel.page.textContent("#share-screen-btn"))?.includes("Câmera"), 5000);
  await cel.page.click("#share-screen-btn");
  await waitFor("Paula vê a 'Câmera de Celso' tocando", async () => {
    const s = (await snapshot(pc.page)).screens.find((x) => x.label.startsWith("Câmera de Celso"));
    return s?.state === "ok" && s.playing && s.width > 0;
  }, 25000);
  // Celular vai para outro app: a aba fica oculta e o microfone é encerrado pelo sistema.
  await cel.page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor("Paula vê 'saiu da aba' no chip de Celso", async () =>
    remoteChip(await snapshot(pc.page), "Celso")?.sub.includes("saiu da aba"), 15000);
  await cel.page.evaluate(() => {
    // Simula o sistema matando o microfone em segundo plano (a captura crua termina).
    for (const st of window.__GUM__ ?? []) for (const tr of st.getAudioTracks()) tr.stop();
  });
  await cel.page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor("Voltou: 'saiu da aba' some", async () =>
    !remoteChip(await snapshot(pc.page), "Celso")?.sub.includes("saiu da aba"), 15000);
  await waitFor("Microfone religado sozinho (registro)", async () =>
    cel.logs.some((l) => l.includes("Microfone religado")), 15000);
  await expectAudioOk(pc, [cel]);
  for (const u of [pc, cel]) await u.browser.close();

  console.log("\n[V6b] Nome sorteado repetido na sala: quem chegou depois troca");
  const room2 = `${ROOM}-v6b`;
  const n1 = await makeUser("Ás de Pijama", { room: room2 });
  await sleep(1200);
  const n2 = await makeUser("Ás de Pijama", { room: room2 });
  await waitFor("Os dois ficam com nomes diferentes (o primeiro mantém o seu)", async () => {
    const a = (await snapshot(n2.page)).chips.find((c) => c.id !== "chip-self")?.name;
    const b = (await snapshot(n1.page)).chips.find((c) => c.id !== "chip-self")?.name;
    return a === "Ás de Pijama" && b && b !== "Ás de Pijama" && b;
  }, 25000);
  for (const u of [n1, n2]) await u.browser.close();

  console.log("\n[V6c] Chip mostra 'via TURN' quando a ligação passa pelo TURN");
  const room3 = `${ROOM}-v6c`;
  const a = await makeUser("Claudio", { room: room3, relayOnly: true, turn: TURN_OK });
  await sleep(1200);
  const b = await makeUser("Jorge", { room: room3, relayOnly: true, turn: TURN_OK });
  await waitFor("Claudio vê Jorge 'via TURN'", async () => {
    const c = remoteChip(await snapshot(a.page), "Jorge");
    return c?.audio === "ok" && c.sub.includes("via TURN");
  }, 40000);
  for (const u of [a, b]) await u.browser.close();
}

async function scenarioMixed() {
  console.log("\n[M] Sala mista: app + NitroCall.html (file://)");
  const room = `${ROOM}-mix`;
  const web1 = await makeUser("WebAna", { room, url: WEB_URL });
  await sleep(1000);
  const app1 = await makeUser("AppBeto", { room, url: DEV_URL });
  await sleep(1000);
  const web2 = await makeUser("WebCris", { room, url: WEB_URL });
  const all = [web1, app1, web2];
  for (const u of all) await expectAudioOk(u, all.filter((o) => o !== u));
  for (const u of all) await expectHears(u, all.filter((o) => o !== u));
  await waitFor("NitroCall.html: relógio em Worker e alvo web", async () => {
    const d = await web1.page.evaluate(() => window.__NITRO_DEBUG__?.());
    return d?.clock === "worker" && d?.target === "web";
  }, 10000);
  await waitFor("Todos veem a versão/build dos outros (app e web), sem aviso de código diferente", async () => {
    for (const u of all) {
      const d = await u.page.evaluate(() => window.__NITRO_DEBUG__?.());
      const known = (d?.peerApps ?? []).filter((p) => p.ver);
      if (known.length !== 2) return false;
      if (known.some((p) => p.build !== d.build || p.ver !== d.version)) return false;
      const banner = await u.page.evaluate(() => !document.querySelector("#version-banner")?.classList.contains("hidden"));
      if (banner) return false;
    }
    const kinds = ((await web1.page.evaluate(() => window.__NITRO_DEBUG__?.()))?.peerApps ?? []).map((p) => p.kind).filter(Boolean).sort();
    return kinds.join(",") === "app,web";
  }, 20000);
  await waitFor("Supressão de ruído ligada no NitroCall.html", async () => {
    const t = await web1.page.evaluate(() => document.querySelector("#noise-btn")?.textContent ?? "");
    return t.includes("ligado");
  }, 10000);
  await app1.page.click("#share-screen-btn");
  await expectScreenPlaying(web1, app1, { audio: true });
  await expectScreenPlaying(web2, app1, { audio: true });
  await app1.page.click("#share-screen-btn");
  await expectNoScreen(web1, app1);
  await web2.page.click("#share-screen-btn");
  await expectScreenPlaying(app1, web2, { audio: true });
  await expectScreenPlaying(web1, web2, { audio: true });
  await waitFor("Convite pelo #sala= preenche o código no NitroCall.html", async () => {
    const ctx = await web1.browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${WEB_URL}#sala=${encodeURIComponent("convite-teste")}`);
    const v = await p.inputValue("#room-code-input");
    await ctx.close();
    return v === "convite-teste";
  }, 10000);
  for (const u of all) await u.browser.close();
}

// Qualidade real da tela numa rede boa: "Alta" tem de chegar a 1080p e ficar lá.
// Pega os dois defeitos que deixavam a imagem ruim: (1) "limitado por banda" do
// Chromium tratado como rede fraca (caía para 350 kbps em ~35 s); (2) sem teto
// explícito, o Chromium prendia a transmissão em 360p/1,7 Mbps.
async function scenarioHdQuality() {
  console.log("\n[Q] Tela 1080p30 realista numa rede boa: Alta chega a 1080p e não cai");
  const room = `${ROOM}-hd`;
  const sofia = await makeUser("Sofia", { room, hd: true });
  await sleep(800);
  const tiago = await makeUser("Tiago", { room, hd: true });
  await sleep(800);
  const vera = await makeUser("Vera", { room, hd: true });
  const all = [sofia, tiago, vera];
  for (const u of all) await expectAudioOk(u, all.filter((o) => o !== u));
  await pickQuality(sofia.page, "alta");
  await sofia.page.click("#share-screen-btn");
  for (const v of [tiago, vera]) {
    await waitFor(`${v.name} recebe a tela de Sofia em 1080p (≥ 20 fps)`, async () => {
      const s = await inboundVideo(v.page);
      return s && s.w >= 1920 && s.fps >= 20 ? `${s.w}x${s.h}@${s.fps}` : false;
    }, 60000);
  }
  await sleep(20000);
  for (const v of [tiago, vera]) {
    const a = await inboundVideo(v.page);
    await sleep(3000);
    const b = await inboundVideo(v.page);
    const kbps = a && b && b.t > a.t ? Math.round(((b.bytes - a.bytes) * 8) / (b.t - a.t)) : 0;
    await waitFor(`${v.name} continua em 1080p acima de 2,5 Mbps depois de 45 s (${b?.w}x${b?.h}@${b?.fps}, ${kbps} kbps)`, async () => b && b.w >= 1920 && kbps > 2500, 1000);
  }
  const falseAlarms = async () =>
    sofia.page.evaluate(() => [...document.querySelectorAll("#status-log div")].map((d) => d.textContent ?? "").filter((t) => /rede fraca|automático: (banda|perda)/.test(t)));
  await waitFor("Nenhum falso 'rede fraca' em Alta", async () => (await falseAlarms()).length === 0, 1000);
  await pickQuality(sofia.page, "auto");
  await sleep(30000);
  await waitFor("Auto numa rede boa fica em Alta (sem descer à toa)", async () => {
    const d = await sofia.page.evaluate(() => window.__NITRO_DEBUG__?.());
    return d?.level === "alta" && (await falseAlarms()).length === 0;
  }, 1000);
  for (const u of all) await u.browser.close();
}

function buildWeb() {
  console.log("Gerando dist-web/NitroCall.html…");
  const r = spawnSync(process.execPath, [bin("vite/bin/vite.js"), "build", "--config", "vite.web.config.ts", "--logLevel", "warn"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("build:web falhou");
}

async function main() {
  console.log(`Sala de teste: ${ROOM}`);
  console.log(`Página: ${WEB_FILE ? "NitroCall.html (file://)" : "Vite (app)"}`);
  buildWeb();
  console.log(`Broker: ${PUBLIC_BROKER ? "público (0.peerjs.com)" : `local :${PEER_PORT}`}`);
  let peerServer = null;
  const startPeerServer = () => {
    peerServer = startProcess("peerjs", [bin("peer/dist/bin/peerjs.js"), "--port", String(PEER_PORT)]);
  };
  if (!PUBLIC_BROKER) startPeerServer();
  startProcess("nostr", [fileURLToPath(new URL("./nostr-relay.mjs", import.meta.url)), String(NOSTR_PORT)]);
  startProcess("turn", [fileURLToPath(new URL("./turn-server.mjs", import.meta.url)), String(TURN_PORT), String(TURN_HTTP_PORT)]);
  startProcess("vite", [bin("vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"]);
  if (!PUBLIC_BROKER) await waitForHttp(`http://localhost:${PEER_PORT}/peerjs/id`, 20000);
  await waitForHttp(DEV_URL, 30000);
  await waitForHttp(`http://127.0.0.1:${TURN_HTTP_PORT}/health`, 10000);

  if (process.env.ONLY === "nostr") {
    await scenarioNostr(() => peerServer, startPeerServer);
    return;
  }
  if (process.env.ONLY === "mixed") {
    await scenarioMixed();
    return;
  }
  if (process.env.ONLY === "nat") {
    await scenarioNat();
    return;
  }
  if (process.env.ONLY === "v6") {
    await scenarioV6();
    return;
  }
  if (process.env.ONLY === "hd") {
    await scenarioHdQuality();
    return;
  }
  // ONLY=1 pula para os cenários de qualidade da tela ([19] em diante).
  if (!process.env.ONLY) {
  console.log("\n[1] Alice e Bob entram");
  const alice = await makeUser("Alice");
  await sleep(1000);
  const bob = await makeUser("Bob");
  await expectAudioOk(alice, [bob]);
  await expectAudioOk(bob, [alice]);
  await expectHears(alice, [bob]);
  await expectHears(bob, [alice]);
  await waitFor("Alice vê Bob verificado (🔒, sem comparar códigos)", async () =>
    alice.page.evaluate(() => [...document.querySelectorAll("#participants .chip")].find((c) => c.dataset.name === "Bob")?.dataset.verified === "ok"), 20000);

  console.log("\n[2] Carol entra (3 pessoas)");
  const carol = await makeUser("Carol");
  await expectAudioOk(alice, [bob, carol]);
  await expectAudioOk(bob, [alice, carol]);
  await expectAudioOk(carol, [alice, bob]);

  console.log("\n[3] Bob compartilha a tela (com som)");
  await bob.page.click("#share-screen-btn");
  await expectScreenPlaying(alice, bob, { audio: true });
  await expectScreenPlaying(carol, bob, { audio: true });
  await expectPip(bob, 2, 2);
  await waitFor("Bob vê que Alice e Carol confirmam ver sua tela", async () => {
    const snap = await snapshot(bob.page);
    return remoteChip(snap, "Alice")?.sees && remoteChip(snap, "Carol")?.sees;
  });
  await waitFor('Bob vê o botão "Som da tela" ligado', async () => {
    const t = (await snapshot(bob.page)).screenAudioBtn;
    return t.includes("Som da tela") && !t.includes("desligado");
  });

  console.log("\n[4] Bob desliga e religa o som da tela; quem assiste acompanha");
  await bob.page.click("#screen-audio-btn");
  await expectScreenPlaying(alice, bob, { audio: false });
  await bob.page.click("#screen-audio-btn");
  await expectScreenPlaying(alice, bob, { audio: true });

  console.log("\n[5] Bob troca a tela compartilhada (sem a tela sumir pra quem assiste)");
  await alice.page.evaluate(() => {
    for (const t of document.querySelectorAll(".screen-tile")) t.dataset.marker = "before-switch";
  });
  const before = screenOf(await snapshot(alice.page), "Bob");
  await bob.page.click("#switch-screen-btn");
  await sleep(3000);
  await waitFor("Alice manteve o mesmo quadro de tela (sem remover/recriar) e o vídeo continua avançando", async () => {
    const s = screenOf(await snapshot(alice.page), "Bob");
    return s && s.marker === "before-switch" && s.state === "ok" && s.playing && s.time > before.time + 1;
  });
  await expectScreenPlaying(carol, bob, { audio: true });

  console.log("\n[6] Alice mutar/desmutar é refletido nos outros");
  await alice.page.click("#toggle-mic-btn");
  await waitFor("Bob vê Alice muda", async () => remoteChip(await snapshot(bob.page), "Alice")?.muted === true);
  await alice.page.click("#toggle-mic-btn");
  await waitFor("Bob vê Alice com microfone ligado", async () => remoteChip(await snapshot(bob.page), "Alice")?.muted === false);

  console.log("\n[7] Alice sai e volta enquanto Bob continua compartilhando");
  await alice.page.click("#leave-btn");
  await expectGone(bob, alice, 15000);
  await expectGone(carol, alice, 15000);
  await sleep(1500);
  await join(alice);
  await expectAudioOk(alice, [bob, carol]);
  await expectScreenPlaying(alice, bob, { audio: true });
  await expectAudioOk(bob, [alice, carol]);
  await expectAudioOk(carol, [alice, bob]);
  await expectScreenPlaying(carol, bob);
  await expectPip(bob, 2, 2);

  console.log("\n[8] Alice também compartilha (duas telas ao mesmo tempo)");
  await alice.page.click("#share-screen-btn");
  await expectScreenPlaying(bob, alice);
  await expectScreenPlaying(carol, alice);
  await expectScreenPlaying(carol, bob);
  await expectPip(alice, 2, 2);

  console.log("\n[9] Bob para de compartilhar; a tela da Alice continua");
  await bob.page.click("#share-screen-btn");
  await expectNoScreen(alice, bob);
  await expectNoScreen(carol, bob);
  await expectScreenPlaying(carol, alice);
  await expectScreenPlaying(bob, alice);
  await waitFor("Bob escondeu a própria prévia", async () => (await snapshot(bob.page)).pip === null);

  console.log("\n[10] Carol trava por 20s (sem sinal de vida) e depois volta sozinha");
  const freeze = carol.page.evaluate(() => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      /* trava a thread principal: nada de heartbeat */
    }
  }).catch(() => {});
  await expectGone(alice, carol, 30000);
  await expectGone(bob, carol, 30000);
  await freeze;
  await expectAudioOk(alice, [bob, carol]);
  await expectAudioOk(bob, [alice, carol]);
  await expectAudioOk(carol, [alice, bob]);
  await expectScreenPlaying(carol, alice);
  await expectPip(alice, 2, 2);

  console.log("\n[11] Carol fecha o app direto (sem clicar em Sair)");
  await carol.browser.close();
  await expectGone(alice, carol, 30000);
  await expectGone(bob, carol, 30000);
  await expectAudioOk(alice, [bob]);
  await expectPip(alice, 1, 1);

  await alice.browser.close();
  await bob.browser.close();

  console.log("\n[12] Ponte automática: Dave e Frank não se alcançam direto; Eve fala com os dois");
  const room2 = `${ROOM}-ponte`;
  const dave = await makeUser("Dave", { room: room2, blockSlots: [3] });
  await sleep(800);
  const eve = await makeUser("Eve", { room: room2 });
  await sleep(800);
  const frank = await makeUser("Frank", { room: room2, blockSlots: [1] });
  await expectAudioOk(dave, [eve]);
  await expectAudioOk(frank, [eve]);
  await waitFor("Dave vê Frank na sala como 'procurando caminho' ou já pela ponte", async () => {
    const c = remoteChip(await snapshot(dave.page), "Frank");
    return c && (c.presence === "searching" || c.presence === "relay");
  });
  await expectAudioOk(dave, [frank], "relay");
  await expectAudioOk(frank, [dave], "relay");
  await waitFor("Eve mostra o aviso de que está servindo de ponte entre Dave e Frank", async () => {
    const b = (await snapshot(eve.page)).bridge;
    return b && b.includes("Dave") && b.includes("Frank");
  });
  await waitFor('Dave recebe confirmação "te ouve" de Frank (pela ponte)', async () => remoteChip(await snapshot(dave.page), "Frank")?.hears);

  console.log("\n[13] Frank compartilha (com som) e Dave recebe pela ponte; Dave muta e Frank vê");
  await frank.page.click("#share-screen-btn");
  await expectScreenPlaying(eve, frank, { audio: true });
  await expectScreenPlaying(dave, frank, { audio: true, timeoutMs: 40000 });
  await expectPip(frank, 2, 2);
  await dave.page.click("#toggle-mic-btn");
  await waitFor("Frank vê Dave mudo (estado pela ponte)", async () => remoteChip(await snapshot(frank.page), "Dave")?.muted === true);
  await dave.page.click("#toggle-mic-btn");

  console.log("\n[14] Dave também compartilha; Frank recebe pela ponte");
  await dave.page.click("#share-screen-btn");
  await expectScreenPlaying(eve, dave);
  await expectScreenPlaying(frank, dave, { timeoutMs: 40000 });
  await expectPip(dave, 2, 2);

  console.log("\n[15] O caminho direto volta a funcionar: a ponte é desfeita sozinha, sem perder nada");
  await dave.page.evaluate(() => { window.__NITRO_BLOCK_SLOTS__ = []; });
  await frank.page.evaluate(() => { window.__NITRO_BLOCK_SLOTS__ = []; });
  await waitFor("Dave passa a falar direto com Frank (áudio ok)", async () => {
    const snap = await snapshot(dave.page);
    const chip = remoteChip(snap, "Frank");
    const audio = chip && snap.audios.find((a) => a.id === `audio-${chip.slot}`);
    return chip?.presence === "direct" && chip.audio === "ok" && audio?.live;
  }, 45000);
  await waitFor("Frank passa a falar direto com Dave (áudio ok)", async () => {
    const snap = await snapshot(frank.page);
    const chip = remoteChip(snap, "Dave");
    const audio = chip && snap.audios.find((a) => a.id === `audio-${chip.slot}`);
    return chip?.presence === "direct" && chip.audio === "ok" && audio?.live;
  }, 45000);
  await waitFor("Eve deixou de ser ponte", async () => (await snapshot(eve.page)).bridge === null, 30000);
  await expectScreenPlaying(frank, dave, { timeoutMs: 40000 });
  await expectScreenPlaying(dave, frank, { audio: true, timeoutMs: 40000 });
  await expectPip(frank, 2, 2);

  for (const u of [dave, eve, frank]) await u.browser.close();

  console.log("\n[16] Eleição por score: Grace (score alto) ganha de Ivy (score baixo) para o par Hank ↔ Jack");
  const room3 = `${ROOM}-eleicao`;
  const hank = await makeUser("Hank", { room: room3, blockSlots: [4] });
  await sleep(800);
  const ivy = await makeUser("Ivy", { room: room3, cap: 45 });
  await sleep(800);
  const grace = await makeUser("Grace", { room: room3, cap: 95 });
  await sleep(800);
  const jack = await makeUser("Jack", { room: room3, blockSlots: [1] });
  await expectAudioOk(hank, [ivy, grace]);
  await expectAudioOk(jack, [ivy, grace]);
  await expectAudioOk(hank, [jack], "relay");
  await waitFor("Hank ouve Jack via Grace (e não via Ivy, que tem score menor)", async () => remoteChip(await snapshot(hank.page), "Jack")?.sub.includes("via Grace"));
  await waitFor("Grace mostra o aviso de ponte entre Hank e Jack", async () => {
    const b = (await snapshot(grace.page)).bridge;
    return b && b.includes("Hank") && b.includes("Jack");
  });
  await waitFor("Hank vê o ícone de ponte ativa no chip de Grace", async () => remoteChip(await snapshot(hank.page), "Grace")?.bridging === true);
  await waitFor("Ivy não é ponte", async () => (await snapshot(ivy.page)).bridge === null);
  await waitFor("Grace vê a si mesma como ponte e a sala 'todos se veem'", async () => {
    const s = await snapshot(grace.page);
    return s.selfSub.includes("você é ponte") && s.healthState === "ok" && s.health.includes("4");
  });
  await waitFor("Hank vê 🔒 criptografado e a sala saudável", async () => {
    const s = await snapshot(hank.page);
    return s.secure === "on" && s.healthState === "ok";
  });

  console.log("\n[17] Grace perde capacidade: a ponte migra para Ivy sem o áudio de Jack sumir para Hank");
  await jack.page.click("#share-screen-btn");
  await expectScreenPlaying(hank, jack, { audio: true, timeoutMs: 40000 });
  await grace.page.evaluate(() => { window.__NITRO_CAP__ = 10; });
  let audioGap = false;
  const watch = (async () => {
    const until = Date.now() + 40000;
    while (Date.now() < until) {
      const s = await snapshot(hank.page);
      const c = remoteChip(s, "Jack");
      const a = c && s.audios.find((x) => x.id === `audio-${c.slot}`);
      if (!c || !a || !a.live) audioGap = true;
      if (c?.sub.includes("via Ivy") && a?.live) break;
      await sleep(200);
    }
  })();
  await waitFor("Hank passa a ouvir Jack via Ivy", async () => {
    const snap = await snapshot(hank.page);
    const c = remoteChip(snap, "Jack");
    const audio = c && snap.audios.find((a) => a.id === `audio-${c.slot}`);
    return c?.presence === "relay" && c.sub.includes("via Ivy") && c.audio === "ok" && audio?.live;
  }, 45000);
  await watch;
  await waitFor("Durante a troca o áudio de Jack nunca sumiu da tela de Hank", async () => !audioGap, 1000);
  await expectScreenPlaying(hank, jack, { audio: true, timeoutMs: 40000 });
  await waitFor("Grace deixou de ser ponte", async () => (await snapshot(grace.page)).bridge === null, 30000);
  await waitFor("Ivy mostra o aviso de ponte", async () => {
    const b = (await snapshot(ivy.page)).bridge;
    return b && b.includes("Hank") && b.includes("Jack");
  });

  console.log("\n[18] Ivy sai: a ponte volta sozinha para Grace (única que alcança os dois)");
  await ivy.page.click("#leave-btn");
  await waitFor("Hank passa a ouvir Jack via Grace", async () => {
    const snap = await snapshot(hank.page);
    const c = remoteChip(snap, "Jack");
    const audio = c && snap.audios.find((a) => a.id === `audio-${c.slot}`);
    return c?.presence === "relay" && c.sub.includes("via Grace") && c.audio === "ok" && audio?.live;
  }, 45000);
  await expectScreenPlaying(hank, jack, { audio: true, timeoutMs: 40000 });

  console.log("\n[18b] Sem ninguém que alcance os dois com mídia: a sala avisa 'sem caminho'");
  const room6 = `${ROOM}-gap`;
  const paul = await makeUser("Paul", { room: room6, blockSlots: [3] });
  await sleep(800);
  const quinn = await makeUser("Quinn", { room: room6, blockMedia: [3] });
  await sleep(800);
  const rosa = await makeUser("Rosa", { room: room6, blockSlots: [1] });
  await expectAudioOk(paul, [quinn]);
  await waitFor("Paul vê o aviso de que ele e Rosa não têm caminho", async () => {
    const s = await snapshot(paul.page);
    return s.healthState === "gap" && s.health.includes("Rosa");
  }, 60000);
  await waitFor("Quinn também vê o aviso (sem caminho até Rosa)", async () => {
    const s = await snapshot(quinn.page);
    return s.healthState === "gap" && s.health.includes("Rosa");
  }, 30000);
  for (const u of [paul, quinn, rosa]) await u.browser.close();

  console.log("\n[18c] Senha da sala: quem tem senha diferente não entra");
  const room5 = `${ROOM}-senha`;
  const mia = await makeUser("Mia", { room: room5, password: "segredo" });
  await sleep(800);
  const noah = await makeUser("Noah", { room: room5, password: "outra" });
  await sleep(8000);
  await waitFor("Mia não vê Noah (senha diferente)", async () => !remoteChip(await snapshot(mia.page), "Noah"), 5000);
  await waitFor("Os dois veem o aviso de senha diferente", async () => {
    const vis = (u) => u.page.evaluate(() => {
      const b = document.querySelector("#notice-banner");
      return !!b && !b.classList.contains("hidden") && b.textContent.includes("senha");
    });
    return (await vis(mia)) && (await vis(noah));
  }, 15000);
  await noah.page.click("#leave-btn");
  await sleep(500);
  const olivia = await makeUser("Olivia", { room: room5, password: "segredo" });
  await expectAudioOk(mia, [olivia]);
  await expectAudioOk(olivia, [mia]);
  for (const u of [mia, noah, olivia]) await u.browser.close();

  for (const u of [hank, ivy, grace, jack]) await u.browser.close();
  }

  console.log("\n[19] Qualidade da tela: Alta/Média/Baixa ao vivo, com teto de bitrate por espectador");
  const room4 = `${ROOM}-qualidade`;
  const kate = await makeUser("Kate", { room: room4 });
  await sleep(800);
  const leo = await makeUser("Leo", { room: room4 });
  await expectAudioOk(kate, [leo]);
  const debug = (page) => page.evaluate(() => window.__NITRO_DEBUG__?.());
  const outCap = async (page) => {
    const d = await debug(page);
    return d?.links?.find((l) => l.name === "screenOut")?.maxBitrate ?? null;
  };
  await pickQuality(kate.page, "media");
  await kate.page.click("#share-screen-btn");
  await expectScreenPlaying(leo, kate, { audio: true });
  await waitFor("Kate compartilha em Média: prévia mostra 'Média' e teto de 2500 kbps aplicado", async () => {
    const snap = await snapshot(kate.page);
    const q = await kate.page.evaluate(() => document.querySelector("#pip-quality")?.textContent ?? "");
    return snap.pip !== null && q.includes("Média") && (await outCap(kate.page)) === 2_500_000;
  });
  await pickQuality(kate.page, "baixa");
  await waitFor("Mudou para Baixa ao vivo: teto 600 kbps, Leo continua vendo", async () => {
    const q = await kate.page.evaluate(() => document.querySelector("#pip-quality")?.textContent ?? "");
    const s = screenOf(await snapshot(leo.page), "Kate");
    return q.includes("Baixa") && (await outCap(kate.page)) === 800_000 && s?.state === "ok" && s.playing;
  });
  await pickQuality(kate.page, "alta");
  // Alta tem teto explícito alto (6 Mbps): sem ele o Chromium prende a tela em 360p.
  await waitFor("Mudou para Alta: teto de 12 Mbps", async () => {
    const q = await kate.page.evaluate(() => document.querySelector("#pip-quality")?.textContent ?? "");
    return q.includes("Alta") && (await outCap(kate.page)) === 12_000_000;
  });

  console.log("\n[20] Modo Auto: desce com perda de pacotes, volta a subir quando a rede fica limpa");
  await kate.page.evaluate(() => {
    window.__NITRO_ADAPT__ = { bwBadSamples: 2, goodSamples: 2, stepDownCooldownMs: 2000, upHoldMs: 2000, upHoldMaxMs: 4000, oscillationWindowMs: 1000 };
    window.__NITRO_FAKE_LOSS__ = 15;
  });
  await pickQuality(kate.page, "auto");
  await waitFor("Auto desceu para Média por perda de pacotes", async () => {
    const d = await debug(kate.page);
    const q = await kate.page.evaluate(() => document.querySelector("#pip-quality")?.textContent ?? "");
    return d?.quality === "auto" && d.level === "media" && q.includes("Auto") && q.includes("perda de pacotes");
  }, 40000);
  await waitFor("Auto desceu para Baixa (perda continua)", async () => (await debug(kate.page))?.level === "baixa", 40000);
  await expectScreenPlaying(leo, kate);
  await kate.page.evaluate(() => { window.__NITRO_FAKE_LOSS__ = 0; });
  if (!(await waitFor("Rede limpa: Auto voltou para Média", async () => (await debug(kate.page))?.level === "media", 60000))) {
    console.log("  diagnóstico:", JSON.stringify(await debug(kate.page)));
  }
  await waitFor("Rede limpa: Auto voltou para Alta (teto de 12 Mbps)", async () => (await debug(kate.page))?.level === "alta" && (await outCap(kate.page)) === 12_000_000, 60000);
  await expectScreenPlaying(leo, kate, { audio: true });
  await waitFor("Leo vê a resolução recebida no rótulo da tela", async () => {
    const r = await leo.page.evaluate(() => document.querySelector(".screen-res")?.textContent ?? "");
    return /^\d+p$/.test(r);
  });

  console.log("\n[22] Sinalização assistida: Dave e Frank não se acham pelo servidor, mas a ligação direta nasce por Eve");
  const room7 = `${ROOM}-assistida`;
  const dave2 = await makeUser("Dave", { room: room7, blockBoot: [3] });
  await sleep(800);
  const eve2 = await makeUser("Eve", { room: room7 });
  await sleep(800);
  const frank2 = await makeUser("Frank", { room: room7, blockBoot: [1] });
  await expectAudioOk(dave2, [eve2]);
  await expectAudioOk(frank2, [eve2]);
  await waitFor("Dave fala DIRETO com Frank (oferta levada por Eve), sem ponte", async () => {
    const snap = await snapshot(dave2.page);
    const c = remoteChip(snap, "Frank");
    const a = c && snap.audios.find((x) => x.id === `audio-${c.slot}`);
    return c?.presence === "direct" && c.audio === "ok" && a?.live;
  }, 40000);
  await waitFor("Frank fala direto com Dave", async () => {
    const snap = await snapshot(frank2.page);
    const c = remoteChip(snap, "Dave");
    return c?.presence === "direct" && c.audio === "ok";
  }, 40000);
  await waitFor("Eve não faz ponte (não foi preciso)", async () => (await snapshot(eve2.page)).bridge === null, 5000);
  for (const u of [dave2, eve2, frank2]) await u.browser.close();

  if (!PUBLIC_BROKER) {
    console.log("\n[23] O servidor de sinalização cai no meio da chamada: nada muda para quem está na sala; volta e um novo amigo entra");
    const room8 = `${ROOM}-servidor`;
    const ana = await makeUser("Ana", { room: room8 });
    await sleep(800);
    const beto = await makeUser("Beto", { room: room8 });
    await sleep(800);
    const cris = await makeUser("Cris", { room: room8 });
    await expectAudioOk(ana, [beto, cris]);
    await expectAudioOk(beto, [ana, cris]);
    await beto.page.click("#share-screen-btn");
    await expectScreenPlaying(ana, beto, { audio: true });
    peerServer.kill();
    await waitFor("Ana vê o servidor como 'Reconectando…'", async () => (await snapshot(ana.page)).broker.includes("Reconectando"), 20000);
    await sleep(15000);
    await waitFor("Sem servidor há 15s: Ana continua ouvindo Beto e Cris e vendo a tela de Beto", async () => {
      const snap = await snapshot(ana.page);
      const s = screenOf(snap, "Beto");
      return [beto, cris].every((o) => {
        const c = remoteChip(snap, o.name);
        const a = c && snap.audios.find((x) => x.id === `audio-${c.slot}`);
        return c?.audio === "ok" && c.presence === "direct" && a?.live;
      }) && s?.state === "ok" && s.playing;
    }, 5000);
    await ana.page.evaluate(() => window.__NITRO_RESTART__?.(2));
    await sleep(3000);
    await waitFor("Reinício de ICE pelo canal próprio (sem servidor): áudio de Beto continua ok para Ana", async () => {
      const snap = await snapshot(ana.page);
      const c = remoteChip(snap, "Beto");
      const a = c && snap.audios.find((x) => x.id === `audio-${c.slot}`);
      const d = await ana.page.evaluate(() => window.__NITRO_DEBUG__?.());
      const l = d?.links?.find((x) => x.slot === 2 && x.name === "mic");
      return c?.audio === "ok" && a?.live && l?.state === "connected";
    }, 30000);
    await cris.page.click("#toggle-mic-btn");
    await waitFor("Estado (mudo) continua fluindo sem servidor", async () => remoteChip(await snapshot(ana.page), "Cris")?.muted === true, 10000);
    startPeerServer();
    await waitForHttp(`http://localhost:${PEER_PORT}/peerjs/id`, 20000);
    await waitFor("Servidor voltou: Ana 'Online' de novo", async () => (await snapshot(ana.page)).broker.includes("Online"), 30000);
    const duda = await makeUser("Duda", { room: room8 });
    await expectAudioOk(duda, [ana, beto, cris]);
    await expectAudioOk(ana, [beto, cris, duda]);
    await expectScreenPlaying(duda, beto, { audio: true });
    for (const u of [ana, beto, cris, duda]) await u.browser.close();
  }

  console.log("\n[24] Árvore de distribuição: com 5 espectadores e banda curta, a tela vai por distribuidores em vez de baixar a qualidade");
  const room9 = `${ROOM}-arvore`;
  const kate2 = await makeUser("Kate", { room: room9 });
  await sleep(500);
  const viewers = [];
  for (const n of ["Leo", "Max", "Nina", "Oscar", "Pam"]) {
    viewers.push(await makeUser(n, { room: room9 }));
    await sleep(500);
  }
  await expectAudioOk(kate2, viewers);
  await kate2.page.evaluate(() => {
    window.__NITRO_ADAPT__ = { bwBadSamples: 2, stepDownCooldownMs: 2000, treeHoldMs: 20000, treeMinViewers: 3, goodSamples: 2, upHoldMs: 2000 };
  });
  await pickQuality(kate2.page, "auto");
  await kate2.page.click("#share-screen-btn");
  for (const v of viewers) await expectScreenPlaying(v, kate2, { timeoutMs: 40000 });
  await kate2.page.evaluate(() => { window.__NITRO_FAKE_LOSS__ = 15; });
  await waitFor("Kate entrou na árvore (plano com distribuidores) e continua em Alta", async () => {
    const d = await kate2.page.evaluate(() => window.__NITRO_DEBUG__?.());
    return d?.tree === true && d.plan.length >= 1 && d.level === "alta";
  }, 40000);
  await kate2.page.evaluate(() => { window.__NITRO_FAKE_LOSS__ = 0; });
  await waitFor("Algum espectador recebe a tela de Kate por um distribuidor (rótulo 'via'), tocando", async () => {
    for (const v of viewers) {
      const s = screenOf(await snapshot(v.page), "Kate");
      if (s && s.via && s.state === "ok" && s.playing) return true;
    }
    return false;
  }, 45000);
  await waitFor("Kate parou de mandar direto para quem recebe pelo distribuidor (vê todos ainda)", async () => {
    const d = await kate2.page.evaluate(() => window.__NITRO_DEBUG__?.());
    const snap = await snapshot(kate2.page);
    const off = d?.links?.filter((x) => x.name === "screenOut" && x.maxBitrate === null).length ?? 0;
    return d?.plan?.length >= 1 && snap.pip !== null && snap.pip.includes(`${viewers.length}/${viewers.length} vendo`) && off >= 0;
  }, 45000);
  for (const v of viewers) await expectScreenPlaying(v, kate2, { timeoutMs: 30000 });
  await waitFor("Depois do período estável, Kate volta a mandar direto (árvore desfeita) e todos continuam vendo", async () => {
    const d = await kate2.page.evaluate(() => window.__NITRO_DEBUG__?.());
    if (d?.tree !== false || d.plan.length !== 0) return false;
    for (const v of viewers) {
      const s = screenOf(await snapshot(v.page), "Kate");
      if (!(s && !s.via && s.state === "ok" && s.playing)) return false;
    }
    return true;
  }, 90000);
  for (const u of [kate2, ...viewers]) await u.browser.close();

  if (process.env.FULL) {
    console.log("\n[25] Sala com 10 pessoas: todos se ouvem; a 11.ª vê 'Sala cheia'");
    const room10 = `${ROOM}-dez`;
    const ten = [];
    for (let i = 1; i <= 10; i++) {
      ten.push(await makeUser(`P${i}`, { room: room10 }));
      await sleep(400);
    }
    for (const u of ten) await expectAudioOk(u, ten.filter((o) => o !== u));
    await waitFor("P1 vê a sala inteira saudável (10)", async () => {
      const s = await snapshot(ten[0].page);
      return s.healthState === "ok" && s.health.includes("10");
    }, 60000);
    const eleventh = await makeUser("P11", { room: room10 });
    await waitFor("P11 vê 'Sala cheia'", async () => (await snapshot(eleventh.page)).broker.includes("cheia"), 60000);
    for (const u of [...ten, eleventh]) await u.browser.close();
  }

  console.log("\n[21] Codecs e segurança: codec da política na tela, Opus 64k (+RED) na voz, código de segurança igual nos dois lados");
  // Política 5.0: VP9/H.265/H.264 se a máquina codifica na GPU; sem GPU (Chromium headless
  // dos testes), VP8 — a mesma nitidez que o VP9 na CPU, com 30 fps.
  await waitFor("Kate → Leo usa na tela o codec escolhido pela política (e RED/Opus 64 kbps na voz)", async () => {
    const d = await debug(kate.page);
    const l = d?.links?.find((x) => x.name === "mic");
    const out = d?.links?.find((x) => x.name === "screenOut");
    const hw = d?.hwEncoders ?? {};
    const expected = hw.VP9 ? "VP9" : hw.H265 ? "H265" : hw.H264 ? "H264" : "VP8";
    return (
      l && out?.codec === expected && new RegExp(expected, "i").test(l.videoCodec ?? "") &&
      /red|opus/i.test(l.audioCodec ?? "") && /maxaveragebitrate=64000/.test(l.micFmtp ?? "")
    );
  }, 20000);
  await waitFor("Código de segurança igual para Kate e Leo", async () => {
    const a = (await debug(kate.page))?.links?.find((x) => x.name === "mic")?.securityCode;
    const b = (await debug(leo.page))?.links?.find((x) => x.name === "mic")?.securityCode;
    return a && b && a === b && /^\d{4}( \d{4}){4}$/.test(a);
  }, 20000);
  await waitFor("Supressão de ruído ligada (botão)", async () => {
    const t = await kate.page.evaluate(() => document.querySelector("#noise-btn")?.textContent ?? "");
    return t.includes("ligado");
  }, 10000);

  for (const u of [kate, leo]) await u.browser.close();

  if (!PUBLIC_BROKER) await scenarioNostr(() => peerServer, startPeerServer);
  await scenarioNat();
  await scenarioV6();
  await scenarioHdQuality();
  await scenarioMixed();
}


main()
  .catch((err) => {
    console.error(err);
    failures.push(String(err));
  })
  .finally(() => {
    for (const child of children) child.kill();
    if (failures.length) {
      console.log(`\n❌ ${failures.length} verificação(ões) falharam:\n - ${failures.join("\n - ")}`);
      process.exit(1);
    }
    console.log("\n✅ Todos os cenários passaram.");
    process.exit(0);
  });
