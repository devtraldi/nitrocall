import {
  applyContentHint,
  canShareScreen,
  getCameraStream,
  getMicStream,
  getScreenStream,
  isMobile,
  listMicrophones,
  listOutputs,
  levelLabel,
  type ScreenQuality,
} from "./webrtc/media";
import { createNoisePipeline, type NoisePipeline } from "./webrtc/noise";
import * as native from "./tauri";
import { RoomManager, type PeerView, type SelfHealth } from "./webrtc/roomManager";
import { getAudioContext, playChime, watchSpeaking } from "./webrtc/audioLevel";
import { qualityOf } from "./webrtc/roomManager";
import * as ui from "./ui";
import { BUILD, IS_WEB, VERSION } from "./buildInfo";
import { closeMini, miniOpen, miniSupported, openMini, renderMini } from "./miniWindow";
import { applyStatic, getLang, onLangChange, setLang, t } from "./i18n";
import { isGeneratedName, randomName } from "./names";

const STORAGE = {
  room: "nitrocall.room",
  name: "nitrocall.name",
  password: "nitrocall.password",
  // Ponto de encontro próprio (sem UI; usado pelos testes e por quem souber o que faz).
  server: "nitrocall.server",
  // Relays Nostr (sem UI): lista separada por vírgula, ou "off".
  nostr: "nitrocall.nostr",
  // Worker de credenciais TURN (sem UI): URL, ou "off".
  turn: "nitrocall.turn",
  quality: "nitrocall.quality",
  noise: "nitrocall.noise",
  output: "nitrocall.output",
};

declare global {
  interface Window {
    __NITRO_DEBUG__?: () => Record<string, unknown> | null;
    __NITRO_RESTART__?: (slot: number) => boolean;
  }
}
const CHIME_GRACE_MS = 3000;
const MEDIA_KEEPALIVE_MS = 2000;

let room: RoomManager | null = null;
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let screenAudioOn = true;
let screenQuality: ScreenQuality = "auto";
let micMuted = false;
let rawMic: MediaStream | null = null;
let noise: NoisePipeline | null = null;
let noiseOn = true;
let selfHealth: SelfHealth | null = null;
let pendingUpdate: native.UpdateInfo | null = null;
let wakeLock: WakeLockSentinel | null = null;
let myName = "";
let mySlot = 0;
let joinedAt = 0;
let mediaKeepAlive: ReturnType<typeof setInterval> | null = null;
const speakingWatchers = new Map<string, () => void>();
const speakingNow = new Set<string>();
const peerViews = new Map<number, PeerView>();
let miniTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
// Avisos de versão já dados (por vaga), para não repetir a cada atualização do chip.
const versionNotes = new Map<number, string>();
// Compartilhando a câmera (celular) em vez da tela; qual câmera.
let sharingCamera = false;
let cameraFacing: "user" | "environment" = "environment";
// Rótulo atual do "Auto → …" da qualidade (para retraduzir).
let autoLevelText: string | null = null;

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sem armazenamento: só perde o preenchimento automático */
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function watchSpeakingFor(key: "self" | number, stream: MediaStream | null): void {
  const k = String(key);
  speakingWatchers.get(k)?.();
  speakingWatchers.delete(k);
  speakingNow.delete(k);
  if (!stream) {
    ui.setChipSpeaking(key, false);
    return;
  }
  speakingWatchers.set(
    k,
    watchSpeaking(stream, (speaking) => {
      ui.setChipSpeaking(key, speaking);
      if (speaking) speakingNow.add(k);
      else speakingNow.delete(k);
    }),
  );
}

// "4.1.0" > "4.0.2"? (só números; o resto é ignorado)
function newerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

// Alguém da sala com versão mais nova, ou com a mesma versão mas outro código (um
// arquivo modificado, ou gerado de outro código-fonte).
function checkPeerVersion(view: PeerView): void {
  const app = view.app;
  if (!app) return;
  let note = "";
  if (newerVersion(app.ver, VERSION)) {
    note = t(IS_WEB ? "ver.newerWeb" : "ver.newerApp", { name: view.name, v: app.ver, mine: VERSION });
  } else if (app.ver === VERSION && app.build && app.build !== BUILD) {
    note = t("ver.differentBuild", { name: view.name, v: VERSION, b1: app.build, b2: BUILD });
  }
  if (versionNotes.get(view.slot) === note) return;
  versionNotes.set(view.slot, note);
  if (note) ui.log(note);
  refreshVersionBanner();
}

function refreshVersionBanner(): void {
  const notes = [...versionNotes.entries()].filter(([slot, n]) => n && peerViews.has(slot)).map(([, n]) => n);
  ui.setVersionBanner(notes[0] ?? null);
}

function miniState() {
  return {
    room: ui.dom.roomCodeText().textContent ?? "",
    micMuted,
    people: [
      { key: "self", name: myName, muted: micMuted, speaking: speakingNow.has("self") && !micMuted, self: true },
      ...[...peerViews.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((v) => ({ key: String(v.slot), name: v.name, muted: v.muted, speaking: speakingNow.has(String(v.slot)), self: false })),
    ],
  };
}

async function toggleMini(): Promise<void> {
  if (miniOpen()) {
    closeMini();
    return;
  }
  const ok = await openMini(
    {
      toggleMic: () => ui.dom.toggleMicBtn().click(),
      leave: () => {
        if (room) leaveRoom();
      },
    },
    onMuteShortcut,
  );
  if (!ok) {
    ui.log(t("msg.miniFail"));
    return;
  }
  renderMini(miniState());
  if (!miniTimer) {
    miniTimer = setInterval(() => {
      if (!miniOpen()) return;
      renderMini(miniState());
    }, 250);
  }
}

// Ctrl+Shift+M: no app é global (Rust); no navegador, só com a aba (ou a mini-janela) em foco.
function onMuteShortcut(e: KeyboardEvent): void {
  if (!room || !e.ctrlKey || !e.shiftKey || e.altKey || e.code !== "KeyM") return;
  e.preventDefault();
  ui.dom.toggleMicBtn().click();
}

function renderSelfChip(): void {
  ui.upsertChip({
    slot: mySlot,
    name: myName,
    isSelf: true,
    muted: micMuted,
    sharing: !!screenStream,
    audio: "self",
    presence: "self",
    viaName: null,
    turn: false,
    away: false,
    bridging: (selfHealth?.load ?? 0) > 0,
    cap: selfHealth?.cap ?? 0,
    quality: selfHealth?.quality ?? null,
    hearsYou: false,
    seesYourScreen: false,
    iAmSharing: !!screenStream,
    rttMs: null,
    lossPct: null,
    jitterMs: null,
    securityCode: null,
    self: selfHealth,
  });
}

function renderPeerChip(view: PeerView): boolean {
  return ui.upsertChip({
    ...view,
    isSelf: false,
    iAmSharing: !!screenStream,
    quality: qualityOf(view.rttMs, view.lossPct, view.jitterMs),
    self: null,
  });
}

// Código de sala forte: 12 caracteres em grupos de 4 (~60 bits), sem letras ambíguas.
function generateRoomCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

function rerenderPeers(): void {
  for (const view of peerViews.values()) renderPeerChip(view);
}

function screenHasAudio(): boolean {
  return (screenStream?.getAudioTracks().length ?? 0) > 0;
}

function updateShareButtons(): void {
  const sharing = !!screenStream;
  const camera = !canShareScreen();
  const shareBtn = ui.dom.shareScreenBtn();
  ui.setIconButton(shareBtn, sharing ? t("ctl.stop") : camera ? t("ctl.camera") : t("ctl.share"));
  shareBtn.classList.toggle("active", sharing);
  const switchBtn = ui.dom.switchScreenBtn();
  switchBtn.classList.toggle("hidden", !sharing);
  ui.setIconButton(switchBtn, sharingCamera ? t("ctl.flip") : t("ctl.switch"));
  // Câmera: o som vai pelo microfone; não há "som da tela".
  ui.setScreenAudioButton(!sharing || sharingCamera ? "hidden" : !screenHasAudio() ? "none" : screenAudioOn ? "on" : "off");
  ui.setShareAudioLabel(
    !sharing ? "" : sharingCamera ? t("pip.camera") : !screenHasAudio() ? t("pip.noSound") : screenAudioOn ? t("pip.withSound") : t("pip.soundOff"),
  );
  ui.setStageEmptyMode(sharing);
  document.body.classList.toggle("sharing", sharing);
}

// Uma chamada (e principalmente uma ponte) não pode morrer porque o Windows dormiu.
async function requestWakeLock(): Promise<void> {
  if (!room || wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    /* sem permissão ou sem suporte: só perde a proteção contra o sono */
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release();
  wakeLock = null;
}

// Microfone → (RNNoise) → chamada. Se a supressão não carregar, vai o microfone cru.
async function buildMic(deviceId?: string): Promise<MediaStream> {
  const raw = await getMicStream(deviceId);
  const oldRaw = rawMic;
  const oldNoise = noise;
  rawMic = raw;
  noise = null;
  let stream = raw;
  if (noiseOn) {
    noise = await createNoisePipeline(raw);
    if (noise) stream = noise.stream;
  }
  oldNoise?.close();
  stopStream(oldRaw);
  ui.setNoiseButton(noise ? "on" : noiseOn ? "unavailable" : "off");
  return stream;
}

async function toggleNoise(): Promise<void> {
  noiseOn = !noiseOn;
  save(STORAGE.noise, noiseOn ? "1" : "0");
  if (noise) {
    noise.setEnabled(noiseOn);
    ui.setNoiseButton(noiseOn ? "on" : "off");
  } else if (noiseOn && rawMic) {
    noise = await createNoisePipeline(rawMic);
    if (noise && room) {
      localStream = noise.stream;
      room.replaceMicStream(noise.stream);
      watchSpeakingFor("self", noise.stream);
    }
    ui.setNoiseButton(noise ? "on" : "unavailable");
  } else {
    ui.setNoiseButton("off");
  }
  ui.log(noiseOn ? t("msg.noiseOn") : t("msg.noiseOff"));
}

async function refreshOutputList(): Promise<void> {
  let outs: MediaDeviceInfo[];
  try {
    outs = await listOutputs();
  } catch {
    return;
  }
  const saved = load(STORAGE.output);
  const current = outs.some((d) => d.deviceId === saved) ? saved : "";
  ui.setOutputOptions(outs, current);
  if (current) void ui.setOutputDevice(current);
}

function diagnosticsText(snap: Record<string, unknown> | null): string {
  const where = IS_WEB ? `navegador, ${location.protocol === "file:" ? "arquivo local" : location.host}` : "app";
  return `NitroCall ${VERSION} (${where}, build ${BUILD}) — diagnóstico ${new Date().toISOString()}\n${navigator.userAgent}\n\n${ui.getLogText()}\n\nESTADO:\n${JSON.stringify(snap, null, 1)}`;
}

// No navegador não há arquivo de registro no disco: 📥 baixa o registro guardado (que
// sobrevive a fechar a aba) junto com o estado atual das ligações.
function saveDiagnostics(): void {
  const snap = room?.debugSnapshot() ?? null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const text = `${diagnosticsText(snap)}\n\nREGISTRO GUARDADO:\n${native.webLogText()}`;
  native.downloadText(`nitrocall-registro-${stamp}.txt`, text);
  ui.log(t("msg.logSaved"));
}

function copyDiagnostics(): void {
  const snap = room?.debugSnapshot() ?? null;
  const text = diagnosticsText(snap);
  navigator.clipboard
    .writeText(text)
    .then(() => ui.log(t("msg.diagCopied")))
    .catch(() => ui.log(t("msg.copyFail")));
}

function copyInvite(): void {
  const code = ui.dom.roomCodeText().textContent?.trim() || ui.dom.roomCodeInput().value.trim();
  if (!code) return;
  let text = t("msg.inviteText", { code });
  let link: string | null = null;
  if (native.isTauri()) {
    text += `\n${t("msg.inviteApp", { link: native.inviteLink(code) })}`;
  } else if (IS_WEB) {
    link = native.webInviteLink(code);
    text += `\n${link ? t("msg.inviteLink", { link }) : t("msg.inviteFile")}`;
  }
  // Celular: a folha de compartilhar do sistema (WhatsApp etc.) é mais natural que copiar.
  if (isMobile() && typeof navigator.share === "function") {
    navigator
      .share({ text })
      .then(() => ui.log(t("msg.inviteShared")))
      .catch(() => {
        /* cancelado */
      });
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => ui.log(t("msg.inviteCopied")))
    .catch(() => ui.log(t("msg.copyFail")));
}

function updateMicButton(): void {
  ui.setIconButton(ui.dom.toggleMicBtn(), micMuted ? t("ctl.unmute") : t("ctl.mute"));
  ui.dom.toggleMicBtn().classList.toggle("active", micMuted);
}

async function refreshMicList(): Promise<void> {
  const select = ui.dom.micSelect();
  let mics: MediaDeviceInfo[];
  try {
    mics = await listMicrophones();
  } catch {
    return;
  }
  const current = localStream?.getAudioTracks()[0]?.getSettings().deviceId ?? "";
  select.innerHTML = "";
  mics.forEach((mic, i) => {
    const option = document.createElement("option");
    option.value = mic.deviceId;
    option.textContent = mic.label || t("ctl.micN", { n: i + 1 });
    option.selected = mic.deviceId === current;
    select.appendChild(option);
  });
  select.disabled = mics.length < 2;
}

function wireScreenEnded(stream: MediaStream): void {
  // Dispara quando o usuário clica em "Parar compartilhamento" na barra do próprio sistema.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (screenStream === stream) stopShare();
  });
}

// Celular (sem captura de tela no navegador): mostra a câmera pelo mesmo caminho da tela.
async function captureShare(): Promise<MediaStream> {
  if (canShareScreen()) return getScreenStream(screenQuality === "auto" ? "alta" : screenQuality);
  return getCameraStream(cameraFacing);
}

async function startShare(): Promise<void> {
  let stream: MediaStream;
  const camera = !canShareScreen();
  try {
    stream = await captureShare();
  } catch {
    ui.log(camera ? t("msg.cameraFail") : t("msg.shareCancelled"));
    return;
  }
  screenStream = stream;
  sharingCamera = camera;
  screenAudioOn = true;
  wireScreenEnded(stream);
  // Câmera: fluidez (já vem "motion"); tela: nitidez ou fluidez conforme o som.
  if (!camera) applyContentHint(stream);
  room?.startScreenShare(stream, screenQuality, camera);
  ui.setSelfPreview(stream);
  updateShareButtons();
  ui.setShareStatus(null);
  renderSelfChip();
  rerenderPeers();
  if (!camera && !screenHasAudio()) ui.log(t("msg.screenNoAudio"));
}

function stopShare(): void {
  const old = screenStream;
  screenStream = null;
  sharingCamera = false;
  room?.stopScreenShare();
  stopStream(old);
  ui.setSelfPreview(null);
  updateShareButtons();
  renderSelfChip();
  rerenderPeers();
}

async function switchShare(): Promise<void> {
  let stream: MediaStream;
  if (sharingCamera) cameraFacing = cameraFacing === "user" ? "environment" : "user";
  try {
    // Trocar de câmera: alguns celulares só abrem uma por vez, então a antiga sai antes.
    if (sharingCamera) stopStream(screenStream);
    stream = await captureShare();
  } catch {
    if (sharingCamera) stopShare();
    return;
  }
  const old = screenStream;
  screenStream = stream;
  screenAudioOn = true;
  wireScreenEnded(stream);
  room?.replaceScreenStream(stream);
  stopStream(old);
  ui.setSelfPreview(stream);
  updateShareButtons();
  ui.setShareStatus(null);
}

function readQuality(): ScreenQuality {
  const v = load(STORAGE.quality);
  return v === "alta" || v === "media" || v === "baixa" ? v : "auto";
}

function setQuality(quality: ScreenQuality): void {
  screenQuality = quality;
  save(STORAGE.quality, quality);
  ui.setQualitySelect(quality, null);
  room?.setScreenQuality(quality);
}

// Painel ℹ️: o que chega aqui (resolução, fps, bitrate, decodificador, travadas, perda) e
// o que quem compartilha está mandando (codec, encoder de GPU ou CPU, QP, limitação).
const mbps = (kbps: number) => `${(kbps / 1000).toLocaleString(getLang() === "en" ? "en-GB" : "pt-BR", { maximumFractionDigits: 1 })} Mbps`;
const LIMIT_LABEL: Record<string, string> = { bandwidth: "banda", cpu: "CPU", other: "outro" };

function refreshScreenStats(): void {
  if (!room) return;
  for (const slot of ui.openStatsSlots()) {
    const info = room.screenInfo(slot);
    const name = peerViews.get(slot)?.name ?? `Amigo ${slot}`;
    const lines: string[] = [];
    const rx = info?.rx;
    if (rx && rx.w) {
      lines.push(`Chegando: ${rx.w}×${rx.h} · ${Math.round(rx.fps)} fps · ${mbps(rx.kbps)}`);
      lines.push(`Codec ${rx.codec || "?"} · decodificando na ${rx.hw ? "GPU" : "CPU"}`);
      lines.push(`Travadas: ${rx.freezes} (${rx.freezeSec.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s) · perda ${rx.lossPct.toLocaleString("pt-BR")}% · buffer ${rx.jbMs ?? "?"} ms`);
    } else {
      lines.push("Chegando: aguardando a tela…");
    }
    const tx = info?.tx;
    if (tx) {
      lines.push(`${name} envia: ${tx.codec || "?"} na ${tx.hw ? "GPU" : "CPU"} · ${tx.w ?? "?"} px · ${tx.fps ?? "?"} fps${tx.qp !== null ? ` · QP ${tx.qp}` : ""}`);
      if (tx.limit && tx.limit !== "none") lines.push(`Limitado por: ${LIMIT_LABEL[tx.limit] ?? tx.limit}`);
    }
    if (info?.via) lines.push(`Chega via ${info.via}`);
    ui.setScreenStats(slot, lines);
  }
}

function toggleScreenAudio(): void {
  if (!screenStream || !screenHasAudio()) return;
  screenAudioOn = !screenAudioOn;
  room?.setScreenAudio(screenAudioOn);
  if (screenStream) applyContentHint(screenStream);
  updateShareButtons();
  ui.setShareStatus(null);
  ui.log(screenAudioOn ? t("msg.screenAudioOn") : t("msg.screenAudioOff"));
}

function leaveRoom(): void {
  room?.leave();
  room = null;
  noise?.close();
  noise = null;
  stopStream(rawMic);
  stopStream(localStream);
  stopStream(screenStream);
  rawMic = null;
  localStream = null;
  screenStream = null;
  sharingCamera = false;
  document.body.classList.remove("sharing");
  native.keepAwake(false);
  native.setInCall(false);
  for (const stop of speakingWatchers.values()) stop();
  speakingWatchers.clear();
  speakingNow.clear();
  peerViews.clear();
  versionNotes.clear();
  ui.setVersionBanner(null);
  closeMini();
  if (miniTimer) clearInterval(miniTimer);
  miniTimer = null;
  if (mediaKeepAlive) clearInterval(mediaKeepAlive);
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  mediaKeepAlive = null;
  mySlot = 0;
  selfHealth = null;
  releaseWakeLock();
  ui.resetCallUi();
  updateShareButtons();
  ui.dom.callView().classList.add("hidden");
  ui.dom.joinView().classList.remove("hidden");
}

async function joinRoom(): Promise<void> {
  const roomCode = ui.dom.roomCodeInput().value.trim();
  myName = ui.dom.nameInput().value.trim().slice(0, 40);
  const password = ui.dom.passwordInput().value;
  const server = load(STORAGE.server).trim();
  const nostrRaw = load(STORAGE.nostr).trim();
  const nostrRelays = nostrRaw === "off" ? [] : nostrRaw ? nostrRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const turnRaw = load(STORAGE.turn).trim();
  const turnEndpoint = turnRaw === "off" ? "" : turnRaw || undefined;
  if (!roomCode || !myName) return;
  save(STORAGE.room, roomCode);
  // Nome gerado não fica guardado: na próxima vez vem outro. Nome digitado, sim.
  save(STORAGE.name, isGeneratedName(myName) ? "" : myName);
  save(STORAGE.password, password);
  const joinError = ui.dom.joinError();
  joinError.classList.add("hidden");

  try {
    localStream = await buildMic();
  } catch (err) {
    joinError.textContent = t("join.micError");
    joinError.classList.remove("hidden");
    console.error(err);
    return;
  }
  // O clique em "Entrar" é o gesto do usuário que libera o áudio da página.
  getAudioContext();

  micMuted = false;
  mySlot = 0;
  selfHealth = null;
  joinedAt = Date.now();
  updateMicButton();
  updateShareButtons();
  ui.dom.roomCodeText().textContent = roomCode;
  ui.dom.selfLabel().textContent = t("call.youAre", { name: myName });
  ui.setBrokerPill("connecting");
  ui.dom.joinView().classList.add("hidden");
  ui.dom.callView().classList.remove("hidden");
  renderSelfChip();
  watchSpeakingFor("self", localStream);

  room = new RoomManager({
    roomCode,
    name: myName,
    localStream,
    server,
    password,
    systemLoad: native.systemLoad,
    nostrRelays,
    turnEndpoint,
    callbacks: {
      onStatus: ui.log,
      onSelf: (slot) => {
        mySlot = slot;
        ui.dom.selfLabel().textContent = t("call.youAreSlot", { name: myName, slot });
        renderSelfChip();
      },
      onBrokerState: ui.setBrokerPill,
      onPeerUpdate: (view) => {
        peerViews.set(view.slot, view);
        fixNameClash(view);
        const created = renderPeerChip(view);
        if (created && Date.now() - joinedAt > CHIME_GRACE_MS) playChime("join");
        checkPeerVersion(view);
        if (view.sharing) {
          ui.upsertScreenTile(
            view.slot,
            view.name,
            view.screen === "none" ? "waiting" : view.screen,
            view.screenAudio,
            view.screenViaName,
            view.screenCamera,
          );
        } else {
          ui.removeScreenTile(view.slot);
        }
      },
      onPeerRemoved: (slot, _name, cause) => {
        peerViews.delete(slot);
        versionNotes.delete(slot);
        refreshVersionBanner();
        ui.removeChip(slot);
        ui.removeScreenTile(slot);
        ui.removeRemoteAudio(slot);
        watchSpeakingFor(slot, null);
        if (cause === "left") playChime("leave");
      },
      onRemoteAudio: (slot, stream) => {
        ui.setRemoteAudio(slot, stream);
        watchSpeakingFor(slot, stream);
      },
      onRemoteScreen: (slot, stream) => {
        if (stream && !document.getElementById(`screen-${slot}`)) {
          const view = peerViews.get(slot);
          ui.upsertScreenTile(slot, view?.name ?? `#${slot}`, "ok", view?.screenAudio ?? false, null, view?.screenCamera ?? false);
        }
        ui.setScreenStream(slot, stream);
      },
      onShareStatus: ui.setShareStatus,
      onBridging: ui.setBridging,
      onRoomHealth: ui.setHealthPill,
      onSelfHealth: (h) => {
        selfHealth = h;
        ui.setSecurePill(h.secure);
        renderSelfChip();
      },
      onScreenLevel: (level, quality, reason) => {
        const label = levelLabel(level);
        autoLevelText = quality === "auto" ? label.split(" · ")[0] : null;
        ui.setQualitySelect(quality, autoLevelText);
        // O motivo vem do motor (em português); em inglês mostramos só o nível.
        const why = getLang() === "pt" && reason.startsWith("automático: ") ? ` (${reason.slice("automático: ".length)})` : "";
        ui.setShareQuality(quality === "auto" ? `${t("ctl.qAuto")} → ${label}${why}` : label);
      },
    },
  });
  // Diagnóstico (e testes): estado interno das ligações.
  window.__NITRO_DEBUG__ = () => room?.debugSnapshot() ?? null;
  window.__NITRO_RESTART__ = (slot: number) => room?.debugRestartIce(slot) ?? false;
  room.join();
  native.keepAwake(true);
  native.setInCall(true);
  ui.log(t("msg.joining", { room: roomCode, name: myName }));
  if (document.visibilityState === "hidden") room.setBackground(isMobile());
  void refreshMicList();
  void refreshOutputList();
  void requestWakeLock();
  mediaKeepAlive = setInterval(ui.ensureMediaPlaying, MEDIA_KEEPALIVE_MS);
  statsTimer = setInterval(refreshScreenStats, 1000);
}

// Nome aleatório igual ao de alguém que já estava na sala: quem chegou depois sorteia outro.
function fixNameClash(view: PeerView): void {
  if (!room || !mySlot || view.slot > mySlot) return;
  if (view.name.trim().toLowerCase() !== myName.trim().toLowerCase() || !isGeneratedName(myName)) return;
  myName = randomName([...peerViews.values()].map((v) => v.name));
  room.setName(myName);
  ui.dom.selfLabel().textContent = t("call.youAreSlot", { name: myName, slot: mySlot });
  renderSelfChip();
}

// Voltando ao app (celular): o sistema pode ter encerrado o microfone ou suspendido o
// áudio. Religa sem ninguém precisar sair e entrar de novo.
async function recoverMedia(): Promise<void> {
  if (!room) return;
  void getAudioContext().resume().catch(() => {});
  ui.ensureMediaPlaying();
  const track = rawMic?.getAudioTracks()[0];
  const out = localStream?.getAudioTracks()[0];
  if (track?.readyState === "live" && !track.muted && out?.readyState === "live") return;
  try {
    const deviceId = track?.getSettings().deviceId;
    const stream = await buildMic(deviceId || undefined);
    if (!room) {
      stopStream(stream);
      return;
    }
    localStream = stream;
    room.replaceMicStream(stream);
    watchSpeakingFor("self", stream);
    ui.log(t("msg.micBack"));
  } catch {
    /* sem permissão agora; tenta de novo na próxima volta */
  }
}

function renderJoinTexts(): void {
  ui.dom.buildInfo().textContent = `NitroCall ${VERSION} · ${IS_WEB ? t("build.web") : t("build.app")} · ${BUILD}`;
  const warn = IS_WEB && !native.isChromium() && !isMobile();
  ui.dom.browserWarning().textContent = warn ? t("join.browserWarn") : "";
  ui.dom.browserWarning().classList.toggle("hidden", !warn);
}

function onLanguageChanged(): void {
  renderJoinTexts();
  // Nome sorteado acompanha a língua (se ainda não entrou).
  if (!room && isGeneratedName(ui.dom.nameInput().value)) ui.dom.nameInput().value = randomName();
  updateMicButton();
  updateShareButtons();
  ui.setBrokerPill();
  ui.setHealthPill();
  ui.setSecurePill();
  ui.setNoiseButton();
  ui.setUpdateBanner();
  ui.setShareStatus();
  ui.setQualitySelect(screenQuality, autoLevelText);
  ui.relabelTiles();
  if (room) {
    ui.dom.selfLabel().textContent = mySlot ? t("call.youAreSlot", { name: myName, slot: mySlot }) : t("call.youAre", { name: myName });
    renderSelfChip();
    rerenderPeers();
  }
  void refreshMicList();
  void refreshOutputList();
}

function closeMore(): void {
  ui.dom.morePanel().classList.add("hidden");
  ui.dom.moreBtn().setAttribute("aria-expanded", "false");
}

function wireMoreMenu(): void {
  const btn = ui.dom.moreBtn();
  const panel = ui.dom.morePanel();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = panel.classList.toggle("hidden") === false;
    btn.setAttribute("aria-expanded", String(open));
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeMore);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMore();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  // A prévia da tela fica logo acima da barra de controles, seja ela de uma ou duas linhas.
  const controls = document.querySelector<HTMLElement>(".controls")!;
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--controls-h", `${controls.offsetHeight}px`);
  }).observe(controls);
  ui.dom.roomCodeInput().value = load(STORAGE.room);
  ui.dom.nameInput().value = load(STORAGE.name);
  ui.dom.passwordInput().value = load(STORAGE.password);
  // Convite pelo navegador: NitroCall.html#sala=<código> já preenche a sala.
  const applyHashInvite = () => {
    const code = native.parseHashInvite(location.hash);
    if (!code || room) return;
    ui.dom.roomCodeInput().value = code;
    ui.dom.nameInput().focus();
  };
  applyHashInvite();
  window.addEventListener("hashchange", applyHashInvite);
  applyStatic();
  renderJoinTexts();
  onLangChange(onLanguageChanged);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    b.addEventListener("click", () => setLang(b.dataset.lang === "en" ? "en" : "pt"));
  }
  // Nome: o digitado fica guardado; senão, um nome aleatório novo a cada visita.
  if (!ui.dom.nameInput().value) ui.dom.nameInput().value = randomName();
  ui.dom.genNameBtn().addEventListener("click", () => {
    ui.dom.nameInput().value = randomName();
  });
  if (ui.dom.passwordInput().value) ui.dom.joinMore().open = true;
  ui.dom.mobileNote().classList.toggle("hidden", canShareScreen());
  wireMoreMenu();
  noiseOn = load(STORAGE.noise) !== "0";
  ui.setNoiseButton(noiseOn ? "on" : "off");
  ui.setLogSink(native.appendLog);
  screenQuality = readQuality();
  ui.setQualitySelect(screenQuality, null);
  ui.dom.genRoomBtn().addEventListener("click", () => {
    ui.dom.roomCodeInput().value = generateRoomCode();
    ui.dom.roomCodeInput().focus();
  });

  ui.dom.joinForm().addEventListener("submit", (e) => {
    e.preventDefault();
    void joinRoom();
  });

  ui.dom.toggleMicBtn().addEventListener("click", () => {
    micMuted = !micMuted;
    room?.setMuted(micMuted);
    updateMicButton();
    renderSelfChip();
  });

  ui.dom.micSelect().addEventListener("change", async () => {
    const select = ui.dom.micSelect();
    const deviceId = select.value;
    if (!deviceId || !room) return;
    try {
      const stream = await buildMic(deviceId);
      localStream = stream;
      room.replaceMicStream(stream);
      watchSpeakingFor("self", stream);
      ui.log(t("msg.micSwitched", { name: select.selectedOptions[0]?.textContent ?? deviceId }));
    } catch (err) {
      ui.log(t("msg.micFail", { err: String((err as Error).message ?? err) }));
      void refreshMicList();
    }
  });

  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (room) {
      void refreshMicList();
      void refreshOutputList();
    }
  });
  ui.dom.outputSelect().addEventListener("change", async () => {
    const id = ui.dom.outputSelect().value;
    save(STORAGE.output, id);
    const ok = await ui.setOutputDevice(id);
    ui.log(ok ? t("msg.outputOk") : t("msg.outputFail"));
  });
  ui.dom.noiseBtn().addEventListener("click", () => void toggleNoise());
  ui.dom.diagCopyBtn().addEventListener("click", copyDiagnostics);
  ui.dom.inviteBtn().addEventListener("click", copyInvite);
  ui.dom.updateBtn().addEventListener("click", () => {
    if (!pendingUpdate) return;
    ui.dom.updateBtn().disabled = true;
    ui.dom.updateText().textContent = t("update.installing");
    pendingUpdate.install().catch(() => {
      ui.dom.updateBtn().disabled = false;
      ui.dom.updateText().textContent = t("update.failed");
    });
  });

  // Casca nativa: bandeja, atalho global, convite, iniciar com o Windows, atualização.
  void native.wireNativeEvents({
    onToggleMute: () => ui.dom.toggleMicBtn().click(),
    onLeave: () => {
      if (room) leaveRoom();
    },
    onHiddenToTray: () => ui.log(t("msg.tray")),
    onInvite: (code) => {
      if (room) return;
      ui.dom.roomCodeInput().value = code;
      ui.dom.nameInput().focus();
    },
  });
  void native.autostartGet().then((on) => {
    if (on === null) return;
    ui.dom.autostartLabel().classList.remove("hidden");
    ui.dom.autostartInput().checked = on;
    ui.dom.autostartInput().addEventListener("change", () => void native.autostartSet(ui.dom.autostartInput().checked));
  });
  void native.checkUpdate().then((u) => {
    pendingUpdate = u;
    ui.setUpdateBanner(u ? u.version : null);
  });

  ui.dom.shareScreenBtn().addEventListener("click", () => {
    if (screenStream) stopShare();
    else void startShare();
  });
  ui.dom.switchScreenBtn().addEventListener("click", () => void switchShare());
  ui.dom.screenAudioBtn().addEventListener("click", toggleScreenAudio);
  ui.dom.qualitySelect().addEventListener("change", () => {
    const v = ui.dom.qualitySelect().value;
    setQuality(v === "alta" || v === "media" || v === "baixa" ? v : "auto");
  });
  document.addEventListener("visibilitychange", () => {
    const visible = document.visibilityState === "visible";
    // Só no celular a troca de app corta o microfone; no PC trocar de aba não muda nada.
    if (isMobile()) room?.setBackground(!visible);
    if (visible) {
      void requestWakeLock();
      void recoverMedia();
    }
  });
  window.addEventListener("pageshow", () => void recoverMedia());
  ui.dom.selfPip().addEventListener("click", () => ui.dom.selfPip().classList.toggle("large"));

  ui.dom.diagBtn().addEventListener("click", () => {
    closeMore();
    const logEl = ui.dom.statusLog();
    logEl.classList.toggle("hidden");
    ui.dom.diagCopyBtn().classList.toggle("hidden", logEl.classList.contains("hidden"));
    if (IS_WEB) ui.dom.diagSaveBtn().classList.toggle("hidden", logEl.classList.contains("hidden"));
    logEl.scrollTop = logEl.scrollHeight;
  });

  ui.dom.copyRoomBtn().addEventListener("click", async () => {
    const code = ui.dom.roomCodeText().textContent ?? "";
    try {
      await navigator.clipboard.writeText(code);
      ui.log(t("msg.codeCopied", { code }));
    } catch {
      ui.log(t("msg.copyFail"));
    }
  });

  ui.dom.leaveBtn().addEventListener("click", leaveRoom);

  if (!IS_WEB) {
    // Libera a vaga no servidor mesmo se a janela for fechada sem clicar em "Sair".
    window.addEventListener("beforeunload", () => {
      room?.leave();
    });
  } else {
    // Navegador: não há bandeja. Fechar a aba derruba a chamada (e a ponte que este PC
    // faz para os amigos), então o Chrome pede confirmação; a vaga só é liberada
    // quando a página sai de fato.
    window.addEventListener("beforeunload", (e) => {
      if (!room) return;
      e.preventDefault();
      e.returnValue = "";
    });
    window.addEventListener("pagehide", () => {
      room?.leave();
    });
    document.addEventListener("keydown", onMuteShortcut);
    ui.dom.diagSaveBtn().addEventListener("click", saveDiagnostics);
    if (miniSupported() && !isMobile()) {
      ui.dom.miniBtn().classList.remove("hidden");
      ui.dom.miniBtn().addEventListener("click", () => void toggleMini());
    }
  }
});
