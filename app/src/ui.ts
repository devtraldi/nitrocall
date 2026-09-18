import type { BrokerState, Quality, RoomHealth, SelfHealth, ShareStatus } from "./webrtc/roomManager";
import { getLang, t } from "./i18n";

const MAX_LOG_LINES = 300;

export interface ChipModel {
  slot: number;
  name: string;
  isSelf: boolean;
  muted: boolean;
  sharing: boolean;
  audio: "self" | "connecting" | "ok" | "degraded";
  presence: "self" | "direct" | "relay" | "searching";
  viaName: string | null;
  // A mídia passa pelo TURN (último recurso).
  turn: boolean;
  // Saiu da aba/app no celular.
  away: boolean;
  // Está fazendo ponte para alguém agora; score de capacidade de ponte (0–100).
  bridging: boolean;
  cap: number;
  quality: Quality;
  hearsYou: boolean;
  seesYourScreen: boolean;
  iAmSharing: boolean;
  rttMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  securityCode: string | null;
  // Só no chip próprio: o que o app mediu sobre este PC.
  self: SelfHealth | null;
}

// Volume por pessoa (só pra você), lembrado pelo nome.
const personVolumes = new Map<number, number>();

function volumeKey(name: string): string {
  return `nitrocall.vol.${name.trim().toLowerCase()}`;
}

function loadVolume(name: string): number {
  try {
    const v = Number(localStorage.getItem(volumeKey(name)));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
}

function applyPersonVolume(slot: number): void {
  const audio = document.getElementById(`audio-${slot}`) as HTMLAudioElement | null;
  if (audio) audio.volume = personVolumes.get(slot) ?? 1;
}

export function setPersonVolume(slot: number, name: string, volume: number): void {
  personVolumes.set(slot, volume);
  try {
    localStorage.setItem(volumeKey(name), String(volume));
  } catch {
    /* sem armazenamento */
  }
  applyPersonVolume(slot);
}

function qLabel(q: NonNullable<Quality>): string {
  return t(`q.${q}`);
}

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Elemento ${selector} não encontrado`);
  return node;
}

export const dom = {
  joinView: () => el<HTMLElement>("#join-view"),
  callView: () => el<HTMLElement>("#call-view"),
  joinForm: () => el<HTMLFormElement>("#join-form"),
  joinError: () => el<HTMLElement>("#join-error"),
  roomCodeInput: () => el<HTMLInputElement>("#room-code-input"),
  nameInput: () => el<HTMLInputElement>("#name-input"),
  passwordInput: () => el<HTMLInputElement>("#password-input"),
  genRoomBtn: () => el<HTMLButtonElement>("#gen-room-btn"),
  genNameBtn: () => el<HTMLButtonElement>("#gen-name-btn"),
  joinMore: () => el<HTMLDetailsElement>("#join-more"),
  mobileNote: () => el<HTMLElement>("#mobile-note"),
  moreBtn: () => el<HTMLButtonElement>("#more-btn"),
  morePanel: () => el<HTMLElement>("#more-panel"),
  outputRow: () => el<HTMLElement>("#output-row"),
  healthPill: () => el<HTMLElement>("#health-pill"),
  securePill: () => el<HTMLElement>("#secure-pill"),
  roomCodeText: () => el<HTMLElement>("#room-code-text"),
  copyRoomBtn: () => el<HTMLButtonElement>("#copy-room-btn"),
  selfLabel: () => el<HTMLElement>("#self-label"),
  brokerPill: () => el<HTMLElement>("#broker-pill"),
  participants: () => el<HTMLElement>("#participants"),
  bridgeBanner: () => el<HTMLElement>("#bridge-banner"),
  screens: () => el<HTMLElement>("#screens"),
  stageEmpty: () => el<HTMLElement>("#stage-empty"),
  statusLog: () => el<HTMLElement>("#status-log"),
  toggleMicBtn: () => el<HTMLButtonElement>("#toggle-mic-btn"),
  micSelect: () => el<HTMLSelectElement>("#mic-select"),
  shareScreenBtn: () => el<HTMLButtonElement>("#share-screen-btn"),
  switchScreenBtn: () => el<HTMLButtonElement>("#switch-screen-btn"),
  screenAudioBtn: () => el<HTMLButtonElement>("#screen-audio-btn"),
  qualitySelect: () => el<HTMLSelectElement>("#quality-select"),
  pipQuality: () => el<HTMLElement>("#pip-quality"),
  diagBtn: () => el<HTMLButtonElement>("#diag-btn"),
  diagCopyBtn: () => el<HTMLButtonElement>("#diag-copy-btn"),
  outputSelect: () => el<HTMLSelectElement>("#output-select"),
  noiseBtn: () => el<HTMLButtonElement>("#noise-btn"),
  inviteBtn: () => el<HTMLButtonElement>("#invite-btn"),
  autostartLabel: () => el<HTMLElement>("#autostart-label"),
  autostartInput: () => el<HTMLInputElement>("#autostart-input"),
  updateBanner: () => el<HTMLElement>("#update-banner"),
  updateText: () => el<HTMLElement>("#update-text"),
  updateBtn: () => el<HTMLButtonElement>("#update-btn"),
  leaveBtn: () => el<HTMLButtonElement>("#leave-btn"),
  selfPip: () => el<HTMLElement>("#self-pip"),
  selfPipVideo: () => el<HTMLVideoElement>("#self-pip video"),
  pipText: () => el<HTMLElement>("#pip-text"),
  audioSink: () => el<HTMLElement>("#audio-sink"),
  browserWarning: () => el<HTMLElement>("#browser-warning"),
  buildInfo: () => el<HTMLElement>("#build-info"),
  versionBanner: () => el<HTMLElement>("#version-banner"),
  diagSaveBtn: () => el<HTMLButtonElement>("#diag-save-btn"),
  miniBtn: () => el<HTMLButtonElement>("#mini-btn"),
};

const logLines: string[] = [];
let logSink: ((line: string) => void) | null = null;

export function setLogSink(fn: ((line: string) => void) | null): void {
  logSink = fn;
}

export function getLogText(): string {
  return logLines.join("\n");
}

export function log(message: string): void {
  const stamp = new Date().toISOString();
  logLines.push(`${stamp} ${message}`);
  while (logLines.length > 2000) logLines.shift();
  logSink?.(`${stamp} ${message}`);
  const box = dom.statusLog();
  const line = document.createElement("div");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString(getLang() === "en" ? "en-GB" : "pt-BR", { hour12: false });
  line.appendChild(time);
  line.appendChild(document.createTextNode(message));
  box.appendChild(line);
  while (box.childElementCount > MAX_LOG_LINES) box.firstElementChild?.remove();
  box.scrollTop = box.scrollHeight;
  console.log(`[nitrocall] ${message}`);
}

let brokerState: BrokerState = "connecting";

// Botão com ícone + rótulo: no celular só o ícone aparece (o rótulo segue no texto do
// botão para leitores de tela e fica como dica).
export function setIconButton(btn: HTMLElement, text: string): void {
  const i = text.indexOf(" ");
  const icon = i > 0 ? text.slice(0, i) : "";
  const label = i > 0 ? text.slice(i + 1) : text;
  btn.replaceChildren();
  if (icon) {
    const ico = document.createElement("span");
    ico.className = "ico-part";
    ico.textContent = `${icon} `;
    btn.appendChild(ico);
  }
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = label;
  btn.appendChild(lbl);
  btn.setAttribute("aria-label", label);
}

export function setBrokerPill(state: BrokerState = brokerState): void {
  brokerState = state;
  const pill = dom.brokerPill();
  pill.className = `pill pill-${state}`;
  pill.textContent = t(`broker.${state}`);
}

// ----------------------------------------------------------------------------
// Participantes
// ----------------------------------------------------------------------------

function avatarHue(slot: number): number {
  return (slot * 67 + 200) % 360;
}

function chipSubText(m: ChipModel): string {
  if (m.isSelf) {
    const s = m.self;
    const parts: string[] = [];
    if (m.muted) parts.push(t("chip.selfMuted"));
    if (s?.quality) parts.push(t("chip.selfConn", { q: qLabel(s.quality) }));
    if (s && s.load > 0) parts.push(t(s.load === 1 ? "chip.selfBridgeOne" : "chip.selfBridgeMany", { n: s.load }));
    else if (s && s.capMax > 0) parts.push(t("chip.canBridge"));
    else if (s && s.quality) parts.push(t("chip.noBridge"));
    return parts.length ? parts.join(" · ") : t("chip.yourMic");
  }
  if (m.presence === "searching") return t("chip.searching");
  const via =
    m.presence === "relay" && m.viaName ? t("chip.via", { name: m.viaName }) : m.turn ? t("chip.viaTurn") : "";
  if (m.away) return `${t("chip.away")}${via}`;
  if (m.audio === "connecting") return `${t("chip.audioConnecting")}${via}`;
  if (m.audio === "degraded") return `${t("chip.audioReconnecting")}${via}`;
  const q = m.quality ? t("chip.audioQ", { q: qLabel(m.quality) }) : t("chip.audioOk");
  if (m.muted) return `${t("chip.muted")}${via}`;
  return `${m.hearsYou ? `${q}${t("chip.hearsYou")}` : q}${via}`;
}

function signalBars(m: ChipModel): number {
  if (m.isSelf) return m.self?.quality ? { otima: 4, boa: 3, fraca: 2, ruim: 1 }[m.self.quality] : 0;
  if (m.presence === "searching" || m.audio !== "ok") return 0;
  return m.quality ? { otima: 4, boa: 3, fraca: 2, ruim: 1 }[m.quality] : 3;
}

export function upsertChip(m: ChipModel): boolean {
  const list = dom.participants();
  const id = m.isSelf ? "chip-self" : `chip-${m.slot}`;
  let chip = document.getElementById(id);
  const created = !chip;
  if (!chip) {
    chip = document.createElement("div");
    chip.id = id;
    chip.className = "chip";
    chip.innerHTML =
      `<div class="avatar"></div>` +
      `<div class="chip-body"><div class="chip-name"></div><div class="chip-sub"></div></div>` +
      `<div class="chip-icons">` +
      `<span class="ico ico-mic"></span>` +
      `<span class="ico ico-hear">👂</span>` +
      `<span class="ico ico-see">👁️</span>` +
      `<span class="ico ico-share">🖥️</span>` +
      `<span class="ico ico-bridge">🌉</span>` +
      `<span class="signal" title=""><i></i><i></i><i></i><i></i></span>` +
      (m.isSelf ? "" : `<span class="chip-volume">🔉<input type="range" min="10" max="100" value="100" /></span>`) +
      `</div>`;
    if (!m.isSelf) {
      const slider = chip.querySelector<HTMLInputElement>(".chip-volume input")!;
      const initial = loadVolume(m.name);
      personVolumes.set(m.slot, initial);
      slider.value = String(Math.round(initial * 100));
      slider.addEventListener("input", () => setPersonVolume(m.slot, m.name, Number(slider.value) / 100));
      slider.addEventListener("click", (e) => e.stopPropagation());
      chip.addEventListener("click", () => toggleSecurityPopover(chip!));
    }
    if (m.isSelf) list.prepend(chip);
    else {
      // mantém ordenado por número de participante, com "você" sempre primeiro
      const after = [...list.querySelectorAll<HTMLElement>(".chip:not(#chip-self)")].find(
        (c) => Number(c.dataset.slot) > m.slot,
      );
      if (after) list.insertBefore(chip, after);
      else list.appendChild(chip);
    }
  }
  chip.dataset.slot = String(m.slot);
  chip.dataset.audio = m.presence === "searching" ? "connecting" : m.audio;
  chip.dataset.presence = m.presence;
  chip.dataset.turn = String(m.turn);
  chip.dataset.away = String(m.away);
  chip.dataset.bridging = String(m.bridging);
  chip.dataset.cap = String(m.cap);
  chip.dataset.security = m.securityCode ?? "";
  chip.dataset.name = m.name;
  chip.dataset.quality = m.isSelf ? (m.self?.quality ?? "") : (m.quality ?? "");
  chip.title = m.away
    ? t("chip.awayTitle", { name: m.name })
    : m.presence === "relay" && m.viaName
      ? t("chip.relayTitle", { name: m.name, via: m.viaName })
      : m.turn
        ? t("chip.turnTitle", { name: m.name })
        : m.presence === "searching"
          ? t("chip.searchingTitle", { name: m.name })
          : "";
  const vol = chip.querySelector<HTMLElement>(".chip-volume");
  if (vol) vol.title = t("chip.volumeTitle");
  chip.querySelector<HTMLElement>(".ico-share")!.title = t("chip.shareTitle");
  chip.querySelector<HTMLElement>(".ico-bridge")!.title = t("chip.bridgeTitle");
  const avatar = chip.querySelector<HTMLElement>(".avatar")!;
  avatar.style.setProperty("--hue", String(avatarHue(m.slot || 0)));
  avatar.textContent = (m.name.trim()[0] ?? "?").toUpperCase();
  const nameEl = chip.querySelector<HTMLElement>(".chip-name")!;
  nameEl.textContent = m.name;
  if (m.isSelf) {
    const you = document.createElement("span");
    you.className = "you";
    you.textContent = t("chip.you");
    nameEl.appendChild(you);
  }
  chip.querySelector<HTMLElement>(".chip-sub")!.textContent = chipSubText(m);

  const mic = chip.querySelector<HTMLElement>(".ico-mic")!;
  mic.textContent = m.muted ? "🔇" : "🎤";
  mic.title = m.muted ? t("chip.micOff") : t("chip.micOn");
  mic.className = `ico ico-mic on${m.muted ? " mic-off" : ""}`;
  mic.classList.toggle("hidden", m.presence === "searching");

  const hear = chip.querySelector<HTMLElement>(".ico-hear")!;
  hear.classList.toggle("hidden", m.isSelf || m.presence === "searching");
  hear.classList.toggle("on", m.hearsYou);
  hear.title = m.hearsYou ? t("chip.hearOn") : t("chip.hearOff");

  const see = chip.querySelector<HTMLElement>(".ico-see")!;
  see.classList.toggle("hidden", m.isSelf || !m.iAmSharing || m.presence === "searching");
  see.classList.toggle("on", m.seesYourScreen);
  see.title = m.seesYourScreen ? t("chip.seeOn") : t("chip.seeOff");

  const share = chip.querySelector<HTMLElement>(".ico-share")!;
  share.classList.toggle("hidden", !m.sharing);
  share.classList.add("on");

  const bridge = chip.querySelector<HTMLElement>(".ico-bridge")!;
  const bridging = m.isSelf ? (m.self?.load ?? 0) > 0 : m.bridging;
  bridge.classList.toggle("hidden", !bridging);
  bridge.classList.add("on");

  const signal = chip.querySelector<HTMLElement>(".signal")!;
  signal.dataset.bars = String(signalBars(m));
  const capText = m.isSelf ? (m.self ? t("chip.capText", { n: m.self.cap }) : "") : t("chip.capText", { n: m.cap });
  signal.title = m.isSelf
    ? t("chip.selfSignal", { q: m.self?.quality ? `: ${qLabel(m.self.quality)}` : "", cap: capText })
    : m.rttMs === null
      ? t("chip.measuring")
      : t("chip.signal", {
          rtt: m.rttMs,
          loss: m.lossPct !== null ? t("chip.loss", { n: m.lossPct }) : "",
          jit: m.jitterMs !== null ? t("chip.jitter", { n: m.jitterMs }) : "",
          cap: capText,
        });
  return created;
}

let lastHealth: RoomHealth = { state: "connecting", total: 1, capable: 0, gaps: [] };

export function setHealthPill(h: RoomHealth = lastHealth): void {
  lastHealth = h;
  const pill = dom.healthPill();
  pill.dataset.state = h.state;
  const capable = t(h.capable === 1 ? "health.capOne" : "health.capMany", { n: h.capable });
  if (h.state === "ok") {
    pill.textContent = h.total <= 1 ? t("health.alone") : t("health.all", { n: h.total });
    pill.title = h.total <= 1 ? t("health.aloneTitle") : t("health.allTitle", { n: h.total, cap: capable });
  } else if (h.state === "connecting") {
    pill.textContent = t("health.connecting");
    pill.title = t("health.connectingTitle", { cap: capable });
  } else {
    const g = h.gaps[0];
    const more = h.gaps.length > 1 ? ` (+${h.gaps.length - 1})` : "";
    pill.textContent = t("health.gap", { a: g.a, b: g.b, more });
    pill.title =
      h.gaps.map((x) => t(x.noBridge ? "health.gapNoBridge" : "health.gapSearching", { a: x.a, b: x.b })).join("\n") +
      `\n${capable}.`;
  }
}

let lastSecure: boolean | null = null;

export function setSecurePill(secure: boolean | null = lastSecure): void {
  lastSecure = secure;
  const pill = dom.securePill();
  pill.dataset.state = secure === null ? "pending" : secure ? "on" : "pending";
  pill.textContent = secure ? t("secure.on") : "🔒";
  pill.title = secure ? t("secure.onTitle") : t("secure.pendingTitle");
}

function toggleSecurityPopover(chip: HTMLElement): void {
  const existing = chip.querySelector(".chip-popover");
  for (const p of document.querySelectorAll(".chip-popover")) p.remove();
  if (existing) return;
  const pop = document.createElement("div");
  pop.className = "chip-popover";
  const code = chip.dataset.security;
  const name = chip.dataset.name ?? "";
  // Nomes vêm dos outros participantes: sempre como texto, nunca como HTML.
  const title = document.createElement("strong");
  const hint = document.createElement("span");
  hint.className = "hint";
  if (code) {
    title.textContent = t("sec.title", { name });
    const c = document.createElement("code");
    c.textContent = code;
    hint.textContent = t("sec.hint", { name });
    pop.append(title, c, hint);
  } else {
    title.textContent = t("sec.pendingTitle");
    hint.textContent = t("sec.pending", { name });
    pop.append(title, hint);
  }
  pop.addEventListener("click", (e) => e.stopPropagation());
  chip.appendChild(pop);
  setTimeout(() => {
    document.addEventListener("click", () => pop.remove(), { once: true });
  }, 0);
}

export function setChipSpeaking(key: "self" | number, speaking: boolean): void {
  document.getElementById(key === "self" ? "chip-self" : `chip-${key}`)?.classList.toggle("speaking", speaking);
}

export function removeChip(slot: number): void {
  document.getElementById(`chip-${slot}`)?.remove();
}

export function setBridging(pairs: [string, string][]): void {
  const banner = dom.bridgeBanner();
  if (pairs.length === 0) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  const list = pairs.map(([a, b]) => t("bridge.and", { a, b })).join("; ");
  banner.textContent = t("bridge.banner", { list });
  banner.classList.remove("hidden");
}

// ----------------------------------------------------------------------------
// Telas
// ----------------------------------------------------------------------------

const screenVolumes = new Map<number, { muted: boolean; volume: number }>();
// Modo ausente: tudo o que chega fica silenciado, inclusive o que ainda vai chegar.
let outputMuted = false;

function refreshScreenCount(): void {
  const screens = dom.screens();
  const count = screens.childElementCount;
  screens.dataset.count = String(Math.min(count, 10));
  dom.stageEmpty().classList.toggle("hidden", count > 0);
}

let stageSharing = false;

export function setStageEmptyMode(iAmSharing: boolean = stageSharing): void {
  stageSharing = iAmSharing;
  const empty = dom.stageEmpty();
  empty.querySelector(".stage-empty-title")!.textContent = iAmSharing ? t("stage.sharing") : t("stage.empty");
  empty.querySelector(".hint")!.textContent = iAmSharing ? t("stage.sharingHint") : t("stage.emptyHint");
}

function applyScreenVolume(slot: number, tile: HTMLElement): void {
  const prefs = screenVolumes.get(slot) ?? { muted: false, volume: 1 };
  const video = tile.querySelector("video")!;
  video.muted = outputMuted || prefs.muted;
  video.volume = prefs.volume;
  const btn = tile.querySelector<HTMLButtonElement>(".screen-mute-btn")!;
  btn.textContent = prefs.muted || prefs.volume === 0 ? "🔇" : "🔊";
  btn.title = prefs.muted ? t("screen.unmute") : t("screen.mute");
  tile.querySelector<HTMLInputElement>(".screen-volume")!.value = String(Math.round(prefs.volume * 100));
}

export function upsertScreenTile(
  slot: number,
  name: string,
  state: "waiting" | "ok" | "degraded",
  hasAudio: boolean,
  viaName: string | null = null,
  camera = false,
): void {
  const screens = dom.screens();
  let tile = document.getElementById(`screen-${slot}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.id = `screen-${slot}`;
    tile.className = "screen-tile";
    tile.innerHTML =
      `<video autoplay playsinline></video>` +
      `<div class="screen-waiting"><div><div class="spinner"></div><div class="waiting-text"></div></div></div>` +
      `<div class="screen-label"><span class="screen-name"></span><span class="screen-res"></span><span class="screen-audio-ico">🔊</span></div>` +
      `<div class="screen-audio"><button type="button" class="btn screen-mute-btn">🔊</button>` +
      `<input type="range" class="screen-volume" min="0" max="100" value="100" /></div>` +
      `<button type="button" class="btn fullscreen-btn"></button>` +
      `<button type="button" class="btn info-btn">ℹ️</button>` +
      `<div class="screen-stats hidden"></div>`;
    const video = tile.querySelector("video")!;
    applySink(video);
    const res = tile.querySelector<HTMLElement>(".screen-res")!;
    video.addEventListener("resize", () => {
      res.textContent = video.videoHeight ? `${video.videoHeight}p` : "";
    });
    const fsTile = tile;
    const goFullscreen = () => enterFullscreen(fsTile, video);
    tile.querySelector(".fullscreen-btn")!.addEventListener("click", goFullscreen);
    const statsBox = tile.querySelector<HTMLElement>(".screen-stats")!;
    tile.querySelector(".info-btn")!.addEventListener("click", () => {
      statsBox.classList.toggle("hidden");
      statsOpen.set(slot, !statsBox.classList.contains("hidden"));
    });
    if (statsOpen.get(slot)) statsBox.classList.remove("hidden");
    video.addEventListener("dblclick", goFullscreen);
    const currentTile = tile;
    tile.querySelector(".screen-mute-btn")!.addEventListener("click", () => {
      const prefs = screenVolumes.get(slot) ?? { muted: false, volume: 1 };
      screenVolumes.set(slot, { ...prefs, muted: !prefs.muted });
      applyScreenVolume(slot, currentTile);
    });
    tile.querySelector<HTMLInputElement>(".screen-volume")!.addEventListener("input", (e) => {
      const volume = Number((e.target as HTMLInputElement).value) / 100;
      const prefs = screenVolumes.get(slot) ?? { muted: false, volume: 1 };
      screenVolumes.set(slot, { muted: volume === 0 ? prefs.muted : false, volume });
      applyScreenVolume(slot, currentTile);
    });
    applyScreenVolume(slot, tile);
    screens.appendChild(tile);
    refreshScreenCount();
  }
  tile.dataset.state = state;
  tile.dataset.audio = hasAudio ? "on" : "off";
  tile.dataset.via = viaName ?? "";
  tile.dataset.camera = String(camera);
  tile.dataset.name = name;
  labelTile(tile);
}

function labelTile(tile: HTMLElement): void {
  const name = tile.dataset.name ?? "";
  const viaName = tile.dataset.via ?? "";
  const camera = tile.dataset.camera === "true";
  tile.querySelector<HTMLElement>(".screen-name")!.textContent =
    t(camera ? "screen.camOf" : "screen.of", { name }) + (viaName ? t("screen.via", { name: viaName }) : "");
  tile.querySelector<HTMLElement>(".waiting-text")!.textContent = t("screen.receiving", { name });
  tile.querySelector<HTMLElement>(".screen-res")!.title = t("screen.res");
  tile.querySelector<HTMLElement>(".screen-audio-ico")!.title = t("screen.hasAudio");
  tile.querySelector<HTMLElement>(".screen-volume")!.title = t("screen.volume");
  tile.querySelector<HTMLElement>(".fullscreen-btn")!.textContent = t("screen.fullscreen");
  tile.querySelector<HTMLElement>(".info-btn")!.title = t("screen.info");
  tile.querySelector<HTMLElement>(".screen-label")!.dataset.reconnecting = t("screen.reconnecting");
  applyScreenVolume(Number(tile.id.replace("screen-", "")), tile);
}

// Tela cheia: no Android/desktop, o bloco inteiro (com rótulo e som); no iPhone só o
// vídeo tem tela cheia (webkitEnterFullscreen), que é o que o Safari deixa.
function enterFullscreen(tile: HTMLElement, video: HTMLVideoElement): void {
  const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  const lockLandscape = () => {
    // Celular em pé com tela deitada: gira para paisagem na tela cheia (se o sistema deixar).
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (o?.lock && video.videoWidth > video.videoHeight) o.lock("landscape").catch(() => {});
  };
  const fallback = () => {
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    else log(t("msg.fullscreenFail"));
  };
  if (typeof tile.requestFullscreen === "function") tile.requestFullscreen().then(lockLandscape, fallback);
  else fallback();
}

export function relabelTiles(): void {
  for (const tile of dom.screens().querySelectorAll<HTMLElement>(".screen-tile")) labelTile(tile);
}

// Painel ℹ️ por tela: quais estão abertos e o texto de cada um.
const statsOpen = new Map<number, boolean>();

export function openStatsSlots(): number[] {
  return [...statsOpen.entries()].filter(([slot, on]) => on && document.getElementById(`screen-${slot}`)).map(([slot]) => slot);
}

export function setScreenStats(slot: number, lines: string[]): void {
  const box = document.querySelector<HTMLElement>(`#screen-${slot} .screen-stats`);
  if (!box) return;
  box.replaceChildren(
    ...lines.map((l) => {
      const d = document.createElement("div");
      d.textContent = l;
      return d;
    }),
  );
}

export function setScreenStream(slot: number, stream: MediaStream | null): void {
  const video = document.querySelector<HTMLVideoElement>(`#screen-${slot} video`);
  if (!video) return;
  if (video.srcObject !== stream) video.srcObject = stream;
  if (stream) video.play().catch(() => {});
}

export function removeScreenTile(slot: number): void {
  const tile = document.getElementById(`screen-${slot}`);
  if (!tile) return;
  const video = tile.querySelector("video");
  if (video) video.srcObject = null;
  tile.remove();
  refreshScreenCount();
}

// ----------------------------------------------------------------------------
// Áudio remoto (elementos invisíveis; a UI dos participantes é feita por chips)
// ----------------------------------------------------------------------------

let currentSink = "";

// Onde ouvir (fones ou caixas): vale para as vozes e para o som das telas.
export async function setOutputDevice(deviceId: string): Promise<boolean> {
  currentSink = deviceId;
  let ok = true;
  const media = [...dom.audioSink().querySelectorAll("audio"), ...dom.screens().querySelectorAll("video")];
  for (const m of media) {
    const el = m as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== "function") continue;
    try {
      await el.setSinkId(deviceId);
    } catch {
      ok = false;
    }
  }
  return ok;
}

function applySink(el: HTMLMediaElement): void {
  const m = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (currentSink && typeof m.setSinkId === "function") m.setSinkId(currentSink).catch(() => {});
}

export function setOutputOptions(devices: MediaDeviceInfo[], current: string): void {
  const select = dom.outputSelect();
  select.innerHTML = "";
  devices.forEach((d, i) => {
    const option = document.createElement("option");
    option.value = d.deviceId;
    option.textContent = t("ctl.output", { label: d.label || t("ctl.outputN", { n: i + 1 }) });
    option.selected = d.deviceId === current;
    select.appendChild(option);
  });
  dom.outputRow().classList.toggle("hidden", devices.length < 2);
}

let noiseState: "on" | "off" | "unavailable" = "on";

export function setNoiseButton(state: "on" | "off" | "unavailable" = noiseState): void {
  noiseState = state;
  const btn = dom.noiseBtn();
  btn.classList.toggle("active", state === "on");
  btn.disabled = state === "unavailable";
  btn.textContent = state === "on" ? t("ctl.noiseOn") : state === "off" ? t("ctl.noiseOff") : t("ctl.noise");
  btn.title = state === "unavailable" ? t("ctl.noiseUnavailable") : t("ctl.noiseTitle");
}

// Aviso de versão/arquivo diferente entre os amigos (sem botão: no navegador a
// atualização é pegar o NitroCall.html novo).
export function setVersionBanner(text: string | null): void {
  const banner = dom.versionBanner();
  banner.classList.toggle("hidden", !text);
  banner.textContent = text ?? "";
}

let updateVersion: string | null = null;

export function setUpdateBanner(version: string | null = updateVersion): void {
  updateVersion = version;
  const banner = dom.updateBanner();
  banner.classList.toggle("hidden", !version);
  if (version) dom.updateText().textContent = t("update.available", { v: version });
}

export function setRemoteAudio(slot: number, stream: MediaStream | null): void {
  const sink = dom.audioSink();
  let audio = document.getElementById(`audio-${slot}`) as HTMLAudioElement | null;
  if (!audio) {
    audio = document.createElement("audio");
    audio.id = `audio-${slot}`;
    audio.autoplay = true;
    sink.appendChild(audio);
    applySink(audio);
    applyPersonVolume(slot);
  }
  audio.muted = outputMuted;
  if (audio.srcObject !== stream) audio.srcObject = stream;
  if (stream) audio.play().catch(() => {});
}

export function setOutputMuted(on: boolean): void {
  outputMuted = on;
  for (const audio of dom.audioSink().querySelectorAll("audio")) audio.muted = on;
  for (const tile of dom.screens().querySelectorAll<HTMLElement>(".screen-tile")) {
    applyScreenVolume(Number(tile.id.replace("screen-", "")), tile);
  }
}

export function removeRemoteAudio(slot: number): void {
  const audio = document.getElementById(`audio-${slot}`) as HTMLAudioElement | null;
  if (!audio) return;
  audio.srcObject = null;
  audio.remove();
}

// Autoplay pode pausar um elemento (foco, políticas, troca de dispositivo de saída);
// nunca deixamos um stream válido parado.
export function ensureMediaPlaying(): void {
  const media = [
    ...dom.audioSink().querySelectorAll("audio"),
    ...dom.screens().querySelectorAll("video"),
  ];
  for (const m of media) {
    if (m.srcObject && m.paused) m.play().catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Prévia da própria tela e botões de compartilhamento
// ----------------------------------------------------------------------------

export function setSelfPreview(stream: MediaStream | null): void {
  const pip = dom.selfPip();
  const video = dom.selfPipVideo();
  video.srcObject = stream;
  pip.classList.toggle("hidden", !stream);
  if (stream) video.play().catch(() => {});
}

let shareAudioLabel = "";
let lastShareStatus: ShareStatus | null = null;

export function setShareAudioLabel(label: string): void {
  shareAudioLabel = label;
}

export function setShareStatus(status: ShareStatus | null = lastShareStatus): void {
  lastShareStatus = status;
  const text = dom.pipText();
  const s = shareAudioLabel ? ` · ${shareAudioLabel}` : "";
  if (!status) text.textContent = t("pip.sharing", { s });
  else if (status.total === 0) text.textContent = t("pip.nobody", { s });
  else if (status.seen === status.total) text.textContent = t("pip.seenAll", { seen: status.seen, total: status.total, s });
  else text.textContent = t("pip.seen", { seen: status.seen, total: status.total, s });
}

export function setShareQuality(text: string): void {
  dom.pipQuality().textContent = text;
}

export function setQualitySelect(quality: string, autoLevelLabel: string | null): void {
  const select = dom.qualitySelect();
  select.value = quality;
  const auto = select.querySelector<HTMLOptionElement>('option[value="auto"]')!;
  auto.textContent = autoLevelLabel ? `${t("ctl.qAuto")} → ${autoLevelLabel}` : t("ctl.qAuto");
}

let screenAudioState: "hidden" | "none" | "on" | "off" = "hidden";

export function setScreenAudioButton(state: "hidden" | "none" | "on" | "off" = screenAudioState): void {
  screenAudioState = state;
  const btn = dom.screenAudioBtn();
  btn.classList.toggle("hidden", state === "hidden");
  btn.disabled = state === "none";
  btn.classList.toggle("active", state === "off");
  if (state === "none") {
    btn.textContent = t("ctl.screenAudioNone");
    btn.title = t("ctl.screenAudioNoneTitle");
  } else if (state === "on") {
    btn.textContent = t("ctl.screenAudioOn");
    btn.title = t("ctl.screenAudioOnTitle");
  } else {
    btn.textContent = t("ctl.screenAudioOff");
    btn.title = t("ctl.screenAudioOffTitle");
  }
}

export function resetCallUi(): void {
  dom.participants().innerHTML = "";
  for (const tile of [...dom.screens().children]) {
    const video = tile.querySelector("video");
    if (video) video.srcObject = null;
  }
  dom.screens().innerHTML = "";
  refreshScreenCount();
  for (const audio of dom.audioSink().querySelectorAll("audio")) audio.srcObject = null;
  dom.audioSink().innerHTML = "";
  dom.statusLog().innerHTML = "";
  setSelfPreview(null);
  setBridging([]);
  setShareAudioLabel("");
  setScreenAudioButton("hidden");
  setOutputMuted(false);
  setHealthPill({ state: "connecting", total: 1, capable: 0, gaps: [] });
  setSecurePill(null);
  for (const p of document.querySelectorAll(".chip-popover")) p.remove();
  personVolumes.clear();
  setShareQuality("");
  dom.selfPip().classList.remove("large");
}
