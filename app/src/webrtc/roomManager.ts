import Peer, { type DataConnection, type PeerJSOption } from "peerjs";
import { applyScreenLevel, LEVEL_ORDER, SCREEN_LEVELS, type ScreenLevel, type ScreenQuality } from "./media";
import { sha256Bytes, sha256Hex } from "./hash";
import { DEFAULT_RELAYS, NostrSignaling } from "./nostr";
import { DEFAULT_TURN_ENDPOINT, TurnCredentials } from "./turn";
import { clockKind, every } from "./clock";
import { chooseSendCodec, hwEncoders, mungeVideoSection, probeHwEncoders, screenDegradation } from "./videoPolicy";
import { BUILD, TARGET, VERSION } from "../buildInfo";

declare global {
  interface Window {
    // Hooks de teste. BLOCK_SLOTS: fingir que não há caminho nenhum com estas vagas (nem
    // pelo servidor, nem por um amigo) → ponte automática. BLOCK_BOOT: só o servidor de
    // sinalização falha com estas vagas; a ligação direta ainda pode nascer por um amigo.
    __NITRO_BLOCK_SLOTS__?: number[];
    __NITRO_BLOCK_BOOT__?: number[];
    // BLOCK_MEDIA: o bootstrap funciona, mas a ligação própria (mídia) nunca fecha com
    // estas vagas — simula ICE falhando entre dois PCs.
    __NITRO_BLOCK_MEDIA__?: number[];
    __NITRO_FAKE_LOSS__?: number;
    __NITRO_ADAPT__?: Partial<typeof ADAPT_DEFAULTS>;
    // Força o score de capacidade de ponte deste participante (0–100).
    __NITRO_CAP__?: number;
    // Codec de vídeo da tela ("VP9" | "VP8" | "H264" | "AV1"); padrão VP9 com fallback.
    __NITRO_CODEC__?: string;
  }
}

// Ajuste automático da qualidade da tela: desce rápido quando a rede/PC não aguenta,
// sobe devagar quando fica limpo, e segura mais tempo a cada vez que oscila.
const ADAPT_DEFAULTS = {
  bwBadSamples: 2, // amostras (3s cada) com perda/banda ruim antes de descer
  cpuBadSamples: 4, // CPU limitada é comum e transitória: exige mais amostras
  goodSamples: 20, // ~60s limpos antes de tentar subir
  stepDownCooldownMs: 12_000,
  upHoldMs: 60_000,
  upHoldMaxMs: 600_000,
  oscillationWindowMs: 90_000,
  // Árvore de distribuição da tela: mínimo de espectadores para valer a pena, tempo em
  // árvore antes de tentar voltar ao direto (dobra a cada volta que falha).
  treeMinViewers: 3,
  treeHoldMs: 300_000,
  treeHoldMaxMs: 3_600_000,
};
const PLAN_INTERVAL_MS = 5_000;
const DIST_LEASE_MS = 6_000;
const DIST_LEASE_SEND_MS = 2_000;
// Quantos espectadores quem compartilha continua servindo direto além dos distribuidores.
const TREE_DIRECT_EXTRA = 2;
const DIST_CAP_MIN = 60;
// Tetos por espectador quando só aquela ligação sofre (download fraco de um amigo, ou
// uma ponte): null = sem teto.
const LINK_CAPS: (number | null)[] = [null, 1_200_000, 600_000, 350_000];
const LINK_BAD_SAMPLES = 2;
const LINK_GOOD_SAMPLES = 20;
const LINK_STEP_DOWN_COOLDOWN_MS = 12_000;
const LINK_STEP_UP_COOLDOWN_MS = 60_000;

function adapt(): typeof ADAPT_DEFAULTS {
  return { ...ADAPT_DEFAULTS, ...(window.__NITRO_ADAPT__ ?? {}) };
}

export const MAX_SLOTS = 10;
const ALL_SLOTS = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1);

const TICK_MS = 1000;
// Cada participante manda o seu estado a cada tick pelo canal de controle; se ficarmos
// este tempo sem receber nada, o participante é dado como ausente e tudo é refeito.
const PEER_STALE_MS = 12_000;
const BOOT_CONNECT_TIMEOUT_MS = 8_000;
// Ao entrar, espera as credenciais do TURN (no máximo isto) antes do primeiro contato: numa
// rede móvel (CGNAT) o contato sem TURN falha e a próxima tentativa só viria segundos depois.
const TURN_WAIT_MS = 3_000;
// Vaga ocupada (o servidor recusou o nosso pedido dela) mas ainda sem caminho: mostramos
// "procurando" por este tempo, a menos que o servidor diga que a vaga esvaziou.
const OCCUPIED_SHOW_MS = 90_000;
// Tempo para uma ligação própria (RTCPeerConnection) chegar a "connected" antes de ser
// refeita.
const PC_SETUP_TIMEOUT_MS = 15_000;
// ICE "disconnected" é frequentemente transitório (troca de rede, wifi oscilando);
// só reiniciamos o ICE se persistir.
const ICE_DISCONNECTED_GRACE_MS = 6_000;
const ICE_RESTART_MIN_INTERVAL_MS = 5_000;
const MAX_ICE_RESTARTS = 2;
const EMPTY_SLOT_POLL_MS = 5_000;
const LOST_PEER_RETRY_MS = 1_500;
const MAX_BACKOFF_MS = 8_000;
const NEED_REQUEST_INTERVAL_MS = 4_000;
const ASSIST_RETRY_MS = 8_000;
const SCREEN_WAIT_BEFORE_ASK_MS = 2_500;
const STATS_INTERVAL_MS = 3_000;
const AUDIO_STALL_MS = 10_000;
const BROKER_OPEN_TIMEOUT_MS = 15_000;
const BROKER_RECONNECT_MS = 3_000;
// Sem canal direto com alguém por este tempo → procurar um amigo que fale com os dois
// e usá-lo como ponte. A tentativa direta continua em paralelo; se um dia ligar, a
// ponte é desfeita sozinha.
const RELAY_AFTER_MS = 10_000;
const RELAY_LEASE_MS = 6_000;
const RELAY_LEASE_SEND_MS = 2_000;
const RELAY_RETRY_MS = 3_000;
const MAX_MSG_BYTES = 64_000;
// Eleição dinâmica da ponte: score recalculado a cada 2s; só trocamos de ponte se outra
// for claramente melhor por várias avaliações seguidas (trocar = religar mídia).
const CAP_INTERVAL_MS = 2_000;
const ELECT_INTERVAL_MS = 2_000;
const CAP_BRIDGE_MIN = 40;
const SWITCH_MARGIN = 20;
const SWITCH_CONFIRMS = 3;
// Ao trocar de ponte, a antiga continua até a nova entregar áudio (ou este prazo).
const VIA_PREV_MS = 6_000;
const BUSY_MS = 30_000;
const CPU_LIMIT_MEMORY_MS = 10_000;
// Tempo para a estimativa de banda do Chromium subir depois que a tela (ou a ligação)
// começa; antes disso "limitado por banda" é normal e não indica rede fraca.
const BWE_WARMUP_MS = 20_000;
// Conferência do encoder da tela depois de escolhido: caiu na CPU? CPU no limite?
const ENCODER_CHECK_MS = 6_000;
const ENCODER_CPU_MS = 15_000;
// Tela recodificada por uma ponte ou distribuidor: mesmo teto da "Alta" (ver media.ts).
const RELAY_SCREEN_CAP = SCREEN_LEVELS.alta.maxBitrate;
// Ponto de encontro de emergência (Nostr): alguém visto por lá conta como canal direto por
// este tempo; o estado vai por lá só a cada 5 s (relays públicos não são para 1 msg/s).
const NOSTR_STALE_MS = 30_000;
const NOSTR_STATE_MS = 5_000;
const NOSTR_CLAIM_WAIT_MS = 3_000;
const NOSTR_HELLO_MAX = 12;

// STUN público (gratuito) para cada PC descobrir o próprio endereço na internet.
const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

// Opus do microfone: 64 kbps (o padrão do Chromium é ~32; o Discord usa 64) com FEC em
// banda e, quando o navegador tem, RED (cada pacote leva também o quadro anterior):
// a voz aguenta perda em rajada sem cortar.
const MIC_OPUS_FMTP = "useinbandfec=1;maxaveragebitrate=64000;stereo=0;sprop-stereo=0";
// (4.x) marcava "este PC só aguenta VP8" para sempre; a 5.0 limpa isso ao entrar.
const CODEC_FALLBACK_KEY = "nitrocall.codecFallback";
// Perda no áudio recebido acima disto → buffer de jitter maior (estabilidade > latência).
const JITTER_TARGET_LOSS_PCT = 3;
const JITTER_TARGET_MS = 150;
// Som da tela (música/vídeo): estéreo, 128 kbps, sem processamento de voz.
const SCREEN_OPUS_FMTP = "useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000";

export function roomHash(roomCode: string): string {
  const norm = roomCode.trim().toLowerCase().replace(/\s+/g, "-");
  return sha256Hex(`nitrocall-v4|${norm}`).slice(0, 20);
}

export function peerId(hash: string, slot: number): string {
  return `nc4-${hash}-${slot}`;
}

function slotFromPeerId(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : -1;
}

function validSlot(slot: unknown): slot is number {
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= MAX_SLOTS;
}

// Diagnóstico de ICE ao vivo: quando uma ligação falha, o navegador já a fechou e as
// estatísticas vêm vazias. Guardamos, enquanto ela tenta, que caminhos cada lado ofereceu,
// os erros de STUN/TURN e os estados — é o que explica por que um celular não conecta.
interface IceTrace {
  local: Record<string, number>;
  remote: Record<string, number>;
  errors: string[];
  states: string[];
  v6: boolean;
}
const iceTraces = new WeakMap<RTCPeerConnection, IceTrace>();

function traceIce(pc: RTCPeerConnection | null | undefined): void {
  if (!pc || iceTraces.has(pc)) return;
  const tr: IceTrace = { local: {}, remote: {}, errors: [], states: [], v6: false };
  iceTraces.set(pc, tr);
  pc.addEventListener("icecandidate", (e) => {
    const c = e.candidate;
    if (!c?.candidate) return;
    const type = c.type ?? /typ (\w+)/.exec(c.candidate)?.[1] ?? "?";
    tr.local[type] = (tr.local[type] ?? 0) + 1;
    if ((c.address ?? "").includes(":")) tr.v6 = true;
  });
  pc.addEventListener("icecandidateerror", (e) => {
    const ev = e as RTCPeerConnectionIceErrorEvent;
    const where = ev.url ? `@${ev.url.split("?")[0]}` : "";
    const item = `${ev.errorCode}${where}`;
    if (tr.errors.length < 6 && !tr.errors.includes(item)) tr.errors.push(item);
  });
  pc.addEventListener("iceconnectionstatechange", () => {
    if (tr.states.length < 8) tr.states.push(pc.iceConnectionState);
  });
  const add = pc.addIceCandidate.bind(pc);
  pc.addIceCandidate = ((cand?: RTCIceCandidateInit | null) => {
    const type = cand?.candidate ? /typ (\w+)/.exec(cand.candidate)?.[1] : undefined;
    if (type) tr.remote[type] = (tr.remote[type] ?? 0) + 1;
    return add(cand as RTCIceCandidateInit);
  }) as typeof pc.addIceCandidate;
}

function iceSummary(pc: RTCPeerConnection): string | null {
  const tr = iceTraces.get(pc);
  if (!tr) return null;
  const count = (m: Record<string, number>) => ["host", "srflx", "prflx", "relay"].map((k) => `${k} ${m[k] ?? 0}`).join(", ");
  return (
    `estados: ${tr.states.join(">") || pc.iceConnectionState}; locais: ${count(tr.local)}${tr.v6 ? ", IPv6" : ""}; ` +
    `remotos: ${count(tr.remote)}${tr.errors.length ? `; erros: ${tr.errors.join(" ")}` : ""}`
  );
}

function directBlocked(slot: number): boolean {
  return !!window.__NITRO_BLOCK_SLOTS__?.includes(slot);
}

function bootBlocked(slot: number): boolean {
  return directBlocked(slot) || !!window.__NITRO_BLOCK_BOOT__?.includes(slot);
}

function mediaBlocked(slot: number): boolean {
  return directBlocked(slot) || !!window.__NITRO_BLOCK_MEDIA__?.includes(slot);
}

// Aceita "host", "host:porta", "http://host:porta/caminho" ou "https://...".
// Sem esquema explícito, redes locais ficam sem TLS e o resto usa TLS.
export function parseServer(input: string): Partial<PeerJSOption> | null {
  const raw = input.trim();
  if (!raw) return null;
  const hasScheme = /^https?:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  const secure = hasScheme ? url.protocol === "https:" : !isLocal;
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  return { host: url.hostname, port, path: url.pathname || "/", secure };
}

// Cada ligação tem sempre a mesma forma: [0] microfone, [1] vídeo da tela, [2] som da
// tela. Nunca renegociamos: começar/trocar/parar a tela é só replaceTrack.
const TX_MIC = 0;
const TX_SCREEN_V = 1;
const TX_SCREEN_A = 2;

// Ajusta o Opus por m-line: [0] voz, [2] som da tela. Aplicado ao que geramos (oferta e
// resposta); o codificador do outro lado obedece ao que está no SDP que recebe.
function mungeSdp(sdp: string): string {
  const sections = sdp.split(/(?=^m=)/m);
  return sections
    .map((sec, i) => {
      // Vídeo da tela: bitrate inicial alto (ver videoPolicy.ts).
      if (i - 1 === TX_SCREEN_V && /^m=video/.test(sec)) return mungeVideoSection(sec);
      if (i === 0 || !/^m=audio/.test(sec)) return sec;
      const idx = i - 1;
      const extra = idx === TX_MIC ? MIC_OPUS_FMTP : idx === TX_SCREEN_A ? SCREEN_OPUS_FMTP : null;
      if (!extra) return sec;
      const opus = /^a=rtpmap:(\d+) opus\/48000\/2/m.exec(sec);
      if (!opus) return sec;
      const pt = opus[1];
      const fmtpRe = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, "m");
      const m = fmtpRe.exec(sec);
      const merged = new Map<string, string>();
      for (const kv of (m ? m[1] : "").split(";")) {
        const [k, v] = kv.split("=");
        if (k) merged.set(k.trim(), (v ?? "").trim());
      }
      for (const kv of extra.split(";")) {
        const [k, v] = kv.split("=");
        merged.set(k, v);
      }
      const line = `a=fmtp:${pt} ${[...merged].map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";")}`;
      if (m) return sec.replace(fmtpRe, line);
      return sec.replace(/^a=rtpmap:\d+ opus\/48000\/2[^\r\n]*\r?\n/m, (rtp) => `${rtp}${line}\r\n`);
    })
    .join("");
}

function preferredVideoCodec(): string {
  const forced = window.__NITRO_CODEC__;
  if (forced) return forced.toUpperCase();
  return "VP9";
}

// Ordem de codecs por transceiver, sem renegociar depois: vídeo da tela prefere VP9
// (mais nítido para conteúdo de tela ao mesmo bitrate; VP8 se a CPU não aguentou),
// microfone prefere RED+Opus quando existir.
function applyCodecPreferences(tx: RTCRtpTransceiver[]): void {
  const video = tx[TX_SCREEN_V];
  const mic = tx[TX_MIC];
  try {
    const caps = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const want = preferredVideoCodec();
    const first = caps.filter((c) => c.mimeType.toUpperCase() === `VIDEO/${want}`);
    const rest = caps.filter((c) => c.mimeType.toUpperCase() !== `VIDEO/${want}`);
    if (first.length && typeof video.setCodecPreferences === "function") video.setCodecPreferences([...first, ...rest]);
  } catch {
    /* mantém a ordem padrão */
  }
  try {
    const caps = RTCRtpReceiver.getCapabilities("audio")?.codecs ?? [];
    const red = caps.filter((c) => c.mimeType.toLowerCase() === "audio/red");
    const opus = caps.filter((c) => c.mimeType.toLowerCase() === "audio/opus");
    const rest = caps.filter((c) => !/^audio\/(red|opus)$/i.test(c.mimeType));
    if (red.length && opus.length && typeof mic.setCodecPreferences === "function") mic.setCodecPreferences([...red, ...opus, ...rest]);
  } catch {
    /* mantém a ordem padrão */
  }
}

interface ScreenState {
  active: boolean;
  gen: number;
  audio: boolean;
  // É a câmera (celular sem captura de tela), não a tela. Opcional: antes da 6.0 não vinha.
  cam?: boolean;
  // Árvore de distribuição (só de quem compartilha): [espectador, distribuidor].
  plan?: [number, number][];
}

interface StateMsg {
  t: "state";
  name: string;
  muted: boolean;
  screen: ScreenState;
  // O remetente ouve o destinatário / vê a tela do destinatário. É a confirmação
  // ponta-a-ponta que mostramos na UI ("te ouve", "vê sua tela").
  hears: boolean;
  sees: boolean;
  // Vagas com quem o remetente tem canal direto, e os nomes que conhece. É a "fofoca"
  // que permite descobrir quem pode servir de ponte e quem existe na sala mesmo sem
  // caminho direto até ele.
  links: number[];
  roster: [number, string][];
  // Vagas que o remetente alcança por uma ponte (para a saúde da sala).
  vias: number[];
  // Capacidade de servir de ponte (0–100), quantos pares já serve e quantos aceita.
  cap: number;
  load: number;
  capMax: number;
  // Por onde o remetente está recebendo a tela do destinatário: 0 = direto, senão a vaga
  // do distribuidor (quem compartilha usa isto para parar de enviar direto).
  screenVia: number;
  // Prova de que o remetente conhece a chave da sala (código + senha opcional).
  auth: string;
  // Versão, impressão do build e forma de entrega (app instalado ou NitroCall.html).
  // Opcionais: a 4.0.0 não manda.
  ver?: string;
  build?: string;
  kind?: "app" | "web";
  // A pessoa saiu da aba/app (celular): o sistema pode cortar o microfone dela. (6.0+)
  bg?: boolean;
  // Verificação automática do código de segurança (6.1): assinatura, com a chave da sala,
  // do código DTLS que o remetente vê nesta ligação. Se alguém estiver no meio, os códigos
  // dos dois lados diferem e ele não consegue forjar a assinatura sem a chave da sala.
  sv?: string;
  // Envio da nossa tela para o destinatário (painel ℹ️ dele): codec, encoder, hardware,
  // largura, fps, QP e limitação.
  stx?: { codec: string; enc: string; hw: boolean; w: number | null; fps: number | null; qp: number | null; lim: string | null };
}

// "Não estou recebendo o seu áudio/tela": quem envia reaplica os tracks e, se a
// ligação estiver doente, reinicia o ICE.
interface NeedMsg {
  t: "need";
  kind: "mic" | "screen";
}

interface SdpDesc {
  type: RTCSdpType;
  sdp: string;
}

// Sinalização da ligação própria entre nós dois. gen identifica a ligação: uma
// mensagem de uma geração antiga nunca mexe na que a substituiu.
interface SdpMsg {
  t: "sdp";
  gen: number;
  d: SdpDesc;
}

interface IceMsg {
  t: "ice";
  gen: number;
  c: RTCIceCandidateInit;
}

// Quem responde (vaga maior) pede a quem oferece (vaga menor) para reiniciar o ICE ou
// refazer a ligação.
interface RestartMsg {
  t: "restart";
  gen: number;
}

type InnerMsg = StateMsg | NeedMsg | SdpMsg | IceMsg | RestartMsg;

interface FwdMsg {
  t: "fwd";
  to?: number;
  from?: number;
  msg: InnerMsg;
}

interface RelayLeaseMsg {
  t: "relay-lease";
  target: number;
}

interface RelayCancelMsg {
  t: "relay-cancel";
  target: number;
}

// A ponte pedida está no limite: quem pediu procura outra.
interface RelayBusyMsg {
  t: "relay-busy";
  target: number;
}

// Quem compartilha pede a um distribuidor que repasse a sua tela a estes espectadores.
interface DistLeaseMsg {
  t: "dist-lease";
  viewers: number[];
}

// Quem compartilha repassa ao distribuidor o "não estou recebendo" de um espectador.
interface DistNeedMsg {
  t: "dist-need";
  viewer: number;
}

// Sinalização de uma ligação de retransmissão (ponte → destino) que carrega a mídia
// de `from`.
interface RelaySdpMsg {
  t: "rsdp";
  from: number;
  gen: number;
  d: SdpDesc;
  // "screen": só a tela de `from` (árvore de distribuição); ausente = ponte (tudo).
  k?: "screen";
}

interface RelayIceMsg {
  t: "rice";
  from: number;
  gen: number;
  c: RTCIceCandidateInit;
}

interface RelayCloseMsg {
  t: "rclose";
  from: number;
}

// Só pelo Nostr: reserva de vaga sem servidor. "hello" = quero esta vaga; "taken" = ela
// está ocupada, e estas são as vagas que conheço.
interface HelloMsg {
  t: "hello";
  slot: number;
  tok: string;
}

interface TakenMsg {
  t: "taken";
  slots: number[];
}

type Msg =
  | InnerMsg
  | FwdMsg
  | RelayLeaseMsg
  | RelayCancelMsg
  | RelayBusyMsg
  | DistLeaseMsg
  | DistNeedMsg
  | RelaySdpMsg
  | RelayIceMsg
  | RelayCloseMsg;

export type BrokerState = "connecting" | "connected" | "reconnecting" | "full" | "failed";

export interface PeerView {
  slot: number;
  name: string;
  muted: boolean;
  sharing: boolean;
  screenAudio: boolean;
  // O que compartilha é a câmera (celular), não a tela.
  screenCamera: boolean;
  // Saiu da aba/app (celular): o microfone pode estar cortado pelo sistema.
  away: boolean;
  hearsYou: boolean;
  seesYourScreen: boolean;
  presence: "direct" | "relay" | "searching";
  // Ainda não sabemos o nome (vaga ocupada, sem contato): a UI mostra "Alguém".
  unnamed: boolean;
  via: number | null;
  viaName: string | null;
  // A tela desta pessoa chega por um distribuidor (árvore), e quem é.
  screenVia: number | null;
  screenViaName: string | null;
  // Está servindo de ponte para alguém agora / score de capacidade de ponte.
  bridging: boolean;
  cap: number;
  audio: "connecting" | "ok" | "degraded";
  screen: "none" | "waiting" | "ok" | "degraded";
  // A mídia desta ligação passa pelo TURN (último recurso: nem direto nem ponte).
  turn: boolean;
  rttMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  // Verificação automática: "ok" = os dois lados veem o mesmo código (ninguém no meio);
  // "mismatch" = diferentes (alguém pode estar no meio); "pending" = ainda verificando;
  // null = sem ligação própria (chega por ponte).
  verified: "ok" | "mismatch" | "pending" | null;
  // Igual nos dois lados quando ninguém está no meio da ligação (compare em voz).
  securityCode: string | null;
  // Versão/build/forma de entrega que a pessoa anunciou (null = não anunciou, ex.: 4.0.0).
  app: { ver: string; build: string; kind: "app" | "web" } | null;
}

export type Quality = "otima" | "boa" | "fraca" | "ruim" | null;

export function qualityOf(rttMs: number | null, lossPct: number | null, jitterMs: number | null): Quality {
  if (rttMs === null && lossPct === null) return null;
  const rtt = rttMs ?? 0;
  const loss = lossPct ?? 0;
  const jit = jitterMs ?? 0;
  if (loss <= 1 && rtt <= 80 && jit <= 15) return "otima";
  if (loss <= 3 && rtt <= 150 && jit <= 30) return "boa";
  if (loss <= 8 && rtt <= 300) return "fraca";
  return "ruim";
}

export interface RoomHealth {
  state: "ok" | "connecting" | "gap";
  total: number;
  capable: number;
  // Pares que não se alcançam (nomes), e se existe alguém capaz de fazer ponte para eles.
  gaps: { a: string; b: string; noBridge: boolean }[];
}

export interface SelfHealth {
  cap: number;
  capMax: number;
  load: number;
  quality: Quality;
  secure: boolean;
}

export interface ShareStatus {
  seen: number;
  total: number;
}

export interface RoomCallbacks {
  onStatus(message: string): void;
  // Alguém na sala usa outra senha (ou versão incompatível): ninguém se ouve até corrigir.
  onAuthMismatch?(slot: number): void;
  onSelf(slot: number, id: string): void;
  onBrokerState(state: BrokerState): void;
  onPeerUpdate(view: PeerView): void;
  // "left": o outro saiu/caiu. "reset": fomos nós que saímos ou reiniciámos a sessão.
  onPeerRemoved(slot: number, name: string, cause: "left" | "reset"): void;
  onRemoteAudio(slot: number, stream: MediaStream | null): void;
  onRemoteScreen(slot: number, stream: MediaStream | null): void;
  onShareStatus(status: ShareStatus | null): void;
  // Pares para os quais estamos servindo de ponte, como nomes.
  onBridging(pairs: [string, string][]): void;
  onRoomHealth(health: RoomHealth): void;
  onSelfHealth(health: SelfHealth): void;
  // Nível efetivo da tela compartilhada (muda sozinho no modo Auto).
  onScreenLevel(level: ScreenLevel, quality: ScreenQuality, reason: string): void;
}

// Uma ligação WebRTC nossa (par direto ou retransmissão), sempre com a mesma forma.
interface Conn {
  gen: number;
  pc: RTCPeerConnection;
  offerer: boolean;
  createdAt: number;
  ctrl: RTCDataChannel | null;
  tx: RTCRtpTransceiver[] | null;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  micStream: MediaStream | null;
  screenStream: MediaStream | null;
  queue: Promise<void>;
  dead: boolean;
  everConnected: boolean;
  disconnectedSince: number;
  restarts: number;
  lastRestartAt: number;
  // Recepção
  bytesIn: number;
  bytesInChangedAt: number;
  packetsLost: number;
  packetsReceived: number;
  rttMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  stalled: boolean;
  dtls: string | null;
  // Código de segurança do par (das impressões DTLS dos dois lados).
  securityCode: string | null;
  jitterTargetOn: boolean;
  // Codecs em uso (dos stats): para o diagnóstico e os testes.
  audioCodec: string | null;
  videoCodec: string | null;
  // Envio de tela: estatísticas e teto de bitrate por ligação.
  bytesSent: number;
  sendLossPct: number | null;
  // Par ICE escolhido usa candidato relay (TURN).
  viaTurn?: boolean;
  limitation: string | null;
  availOut: number | null;
  capLevel: number;
  capApplied: number | null | undefined;
  capBad: number;
  capGood: number;
  capStepAt: number;
  // Sender da tela já preparado (codec, degradação, teto) antes do primeiro quadro.
  screenPrep?: "pending" | "done";
  // Codec escolhido para a tela nesta ligação e o que o codificador está usando de fato.
  codecApplied?: string;
  codecExpectHw?: boolean;
  codecChosenAt?: number;
  encoderImpl?: string;
  encoderHw?: boolean;
  sendFps?: number | null;
  sendWidth?: number | null;
  sendQp?: number | null;
  qpSum?: number;
  framesEncoded?: number;
  // Tela recebida por esta ligação (o que a pessoa vê de fato).
  rxVideo?: ScreenRxStats;
}

export interface ScreenRxStats {
  w: number;
  h: number;
  fps: number;
  kbps: number;
  codec: string;
  decoder: string;
  hw: boolean;
  freezes: number;
  freezeSec: number;
  lossPct: number;
  jbMs: number | null;
  bytes: number;
  lost: number;
  recv: number;
  t: number;
}

// O que o painel ℹ️ de uma tela mostra: recepção (aqui) + envio (anunciado por quem manda).
export interface ScreenInfo {
  rx: ScreenRxStats | null;
  tx: { codec: string; encoder: string; hw: boolean; w: number | null; fps: number | null; qp: number | null; limit: string | null } | null;
  via: string | null;
}

interface RemotePeer {
  slot: number;
  boot: DataConnection | null;
  bootOpenAt: number;
  pendingBoot: { conn: DataConnection; at: number; turn: boolean } | null;
  // Quando soubemos que a vaga está ocupada (ao procurar a nossa), 0 = não sabemos.
  occupiedAt: number;
  state: StateMsg | null;
  lastSeenAt: number;
  everPresent: boolean;
  conn: Conn | null;
  connGen: number;
  nextConnAt: number;
  // Mídia deste participante que chega por pontes (chave = vaga da ponte). Durante uma
  // troca de ponte as duas coexistem até a nova entregar áudio.
  relayIns: Map<number, Conn>;
  // Tela deste participante chegando por distribuidores (chave = vaga do distribuidor).
  distIns: Map<number, Conn>;
  viaPrev: number | null;
  viaPrevUntil: number;
  nextElectAt: number;
  betterCount: number;
  busyUntil: Map<number, number>;
  knownSince: number;
  authed: boolean;
  authBadAt: number;
  nostrSeenAt: number;
  nostrStateAt: number;
  nextBootAt: number;
  firstBootAt: number;
  bootFailures: number;
  nextAssistAt: number;
  lastRestartAskAt: number;
  lastNeedMicAt: number;
  lastNeedScreenAt: number;
  screenActiveSince: number;
  via: number | null;
  leaseSentAt: number;
  nextRelayAt: number;
  lastView: string;
  micEmitted: MediaStream | null;
  screenEmitted: MediaStream | null;
}

interface RelayPair {
  a: number;
  b: number;
  leaseUntil: number;
  jobs: Map<string, Conn>;
  nextAt: Map<string, number>;
}

// Somos distribuidor da tela de `sharer` para estes espectadores.
interface DistLease {
  sharer: number;
  leaseUntil: number;
  viewers: Set<number>;
  jobs: Map<number, Conn>;
  nextAt: Map<number, number>;
  gens: Map<number, number>;
}

export interface RoomOptions {
  roomCode: string;
  name: string;
  localStream: MediaStream;
  server?: string;
  // Senha opcional da sala: quem não a tiver não é aceito.
  password?: string;
  // Uso de CPU (0–100) deste PC, se o app souber medir (Tauri); null = desconhecido.
  systemLoad?: () => Promise<number | null>;
  // Relays Nostr para o ponto de encontro de emergência; [] desliga.
  nostrRelays?: string[];
  // Worker de credenciais TURN (último recurso quando não há caminho direto); "" desliga.
  turnEndpoint?: string;
  callbacks: RoomCallbacks;
}

// Código de segurança (estilo Signal): as duas impressões DTLS em ordem fixa → SHA-256 →
// 20 dígitos em grupos de 4. Os dois lados calculam o mesmo; se alguém estivesse no meio
// (um servidor de sinalização malicioso), os códigos seriam diferentes.
export function securityCodeFor(fpA: string, fpB: string): string {
  const [a, b] = [fpA, fpB].map((f) => f.replace(/[^0-9a-f]/gi, "").toLowerCase()).sort();
  const hex = sha256Hex(`nitrocall-safety|${a}|${b}`);
  const digits = hex.replace(/[a-f]/g, (ch) => String("abcdef".indexOf(ch))).slice(0, 20);
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function pairKey(x: number, y: number): string {
  return x < y ? `${x}-${y}` : `${y}-${x}`;
}

function jobKey(from: number, to: number): string {
  return `${from}>${to}`;
}

export class RoomManager {
  private peer: Peer | null = null;
  private mySlot = -1;
  private readonly hash: string;
  private name: string;
  private readonly callbacks: RoomCallbacks;
  private readonly serverOpts: Partial<PeerJSOption> | null;
  private readonly authKey: string;
  private readonly systemLoad: (() => Promise<number | null>) | null;
  private readonly nostrRelays: string[];
  private readonly turn: TurnCredentials;
  private nostr: NostrSignaling | null = null;
  private readonly nostrTok = Math.random().toString(36).slice(2, 12);
  private nostrClaim: { slot: number; taken: Set<number>; hellos: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  // Quem anunciou que quer uma vaga recentemente (para dois entrando ao mesmo tempo).
  private recentHellos = new Map<number, { tok: string; at: number }>();
  private localStream: MediaStream;
  private muted = false;
  // Capacidade de ponte deste PC (0–100), suavizada, e o que ela permite.
  private cap = 0;
  private capMax = 0;
  private lastCapAt = 0;
  private cpuLoad: number | null = null;
  private cpuLimitedAt = 0;
  private screenStartedAt = 0;
  // Codecs que esta máquina não aguentou (CPU/qualidade): não são mais escolhidos.
  private codecSkip = new Set<string>();
  private lastHealthKey = "";
  private lastSelfHealthKey = "";
  private screen: { stream: MediaStream; gen: number } | null = null;
  private screenIsCamera = false;
  private turnSettled = false;
  private turnGateUntil = 0;
  private turnLogged = "";
  private background = false;
  private screenGen = 0;
  private screenQuality: ScreenQuality = "auto";
  private screenLevel: ScreenLevel = "alta";
  private adaptState = {
    bwBad: 0,
    cpuBad: 0,
    good: 0,
    lastStepAt: 0,
    lastStepUpAt: 0,
    // Multiplica o tempo de espera antes de subir; dobra a cada oscilação.
    upHoldFactor: 1,
    dropAt: 0,
  };
  private peers = new Map<number, RemotePeer>();
  private relays = new Map<string, RelayPair>();
  // Árvore de distribuição da nossa tela (espectador → distribuidor) e o seu estado.
  private plan = new Map<number, number>();
  private tree = { on: false, since: 0, holdFactor: 1, lastExitAt: 0, nextPlanAt: 0, leaseSentAt: 0 };
  // Telas que distribuímos para outros (chave = quem compartilha).
  private dists = new Map<number, DistLease>();
  private ignoredConns = new WeakSet<object>();
  private tickTimer: (() => void) | null = null;
  private statsTimer: (() => void) | null = null;
  private brokerTimer: (() => void) | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private brokerDownSince = 0;
  private lastBrokerErrorAt = 0;
  private readonly genBase = Math.floor(Math.random() * 1_000_000) * 1000;
  private genCounter = 0;
  private lastShareStatus = "";
  private lastBridging = "";
  private left = false;
  private readonly onOnline = () => this.networkChanged("rede voltou");

  constructor(opts: RoomOptions) {
    this.hash = roomHash(opts.roomCode);
    this.name = opts.name;
    this.localStream = opts.localStream;
    this.callbacks = opts.callbacks;
    this.serverOpts = opts.server ? parseServer(opts.server) : null;
    this.authKey = sha256Hex(`nitrocall-v4-key|${opts.roomCode.trim().toLowerCase()}|${opts.password ?? ""}`);
    this.systemLoad = opts.systemLoad ?? null;
    this.nostrRelays = opts.nostrRelays ?? DEFAULT_RELAYS;
    this.turn = new TurnCredentials(opts.turnEndpoint ?? DEFAULT_TURN_ENDPOINT);
    try {
      localStorage.removeItem(CODEC_FALLBACK_KEY);
    } catch {
      /* sem armazenamento */
    }
    // Descobre cedo quais codecs esta máquina codifica na GPU (a tela usa na hora).
    void probeHwEncoders().catch(() => null);
  }

  private securityMac(code: string): string {
    return sha256Hex(`${this.authKey}|sec|${code}`).slice(0, 24);
  }

  private verification(p: RemotePeer): PeerView["verified"] {
    const c = p.conn;
    if (!c || !this.usable(c)) return null;
    if (!c.securityCode || !p.state?.sv) return "pending";
    return p.state.sv === this.securityMac(c.securityCode) ? "ok" : "mismatch";
  }

  private authFor(from: number, to: number): string {
    return sha256Hex(`${this.authKey}|${from}>${to}`).slice(0, 24);
  }

  get slot(): number {
    return this.mySlot;
  }

  join(): void {
    this.left = false;
    // Credenciais em paralelo com o servidor de sinalização; os contatos esperam por elas
    // até TURN_WAIT_MS (ver reconcileBoot).
    this.turnGateUntil = Date.now() + TURN_WAIT_MS;
    this.turn.onChange = () => this.onTurnChange();
    void this.turn.refresh().finally(() => {
      this.turnSettled = true;
      this.kick();
    });
    this.callbacks.onBrokerState("connecting");
    window.addEventListener("online", this.onOnline);
    this.startNostr();
    this.claimSlot(1);
  }

  // Escuta (barata) nos relays desde o início: se um amigo não conseguir o servidor, ele
  // nos encontra por aqui. Publicamos só quando é preciso.
  private startNostr(): void {
    if (this.nostr || this.nostrRelays.length === 0) return;
    if (typeof crypto === "undefined" || !crypto.subtle || typeof WebSocket === "undefined") return;
    const client = new NostrSignaling({
      relays: this.nostrRelays,
      topic: sha256Hex(`nitrocall-nostr-topic|${this.hash}`).slice(0, 32),
      key: sha256Bytes(`nitrocall-nostr-key|${this.authKey}`),
      mySlot: () => (this.mySlot !== -1 ? this.mySlot : (this.nostrClaim?.slot ?? -1)),
      onMessage: (from, msg) => this.handleNostr(from, msg),
      onStatus: (m) => this.callbacks.onStatus(m),
    });
    this.nostr = client;
    client.start().catch(() => {
      this.nostr = null;
    });
  }

  leave(): void {
    this.left = true;
    window.removeEventListener("online", this.onOnline);
    this.stopTimers();
    if (this.nostrClaim?.timer) clearTimeout(this.nostrClaim.timer);
    this.nostrClaim = null;
    this.nostr?.close();
    this.nostr = null;
    for (const pair of this.relays.values()) this.teardownRelay(pair);
    this.relays.clear();
    for (const lease of this.dists.values()) this.teardownDist(lease);
    this.dists.clear();
    for (const p of this.peers.values()) this.peerLost(p, "saída", /* quiet */ true);
    this.peers.clear();
    this.peer?.destroy();
    this.peer = null;
    this.mySlot = -1;
    this.callbacks.onShareStatus(null);
    this.callbacks.onBridging([]);
  }

  // Nome aleatório que colidiu com o de alguém na sala: troca e avisa todos.
  setName(name: string): void {
    this.name = name.slice(0, 40);
    this.broadcastState();
  }

  // Aba/app em segundo plano (celular): avisamos os outros, que mostram "saiu da aba".
  setBackground(bg: boolean): void {
    if (this.background === bg) return;
    this.background = bg;
    this.broadcastState();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
    this.broadcastState();
  }

  // Troca o microfone em todas as ligações sem renegociar (replaceTrack).
  replaceMicStream(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !this.muted;
    this.localStream = stream;
    this.syncLocalTracks();
    this.kick();
  }

  startScreenShare(stream: MediaStream, quality: ScreenQuality = this.screenQuality, camera = false): void {
    this.screenIsCamera = camera;
    this.screenGen += 1;
    this.screen = { stream, gen: this.screenGen };
    this.screenStartedAt = Date.now();
    this.screenQuality = quality;
    this.screenLevel = quality === "auto" ? "alta" : quality;
    this.adaptState = {
      bwBad: 0,
      cpuBad: 0,
      good: 0,
      lastStepAt: Date.now(),
      lastStepUpAt: 0,
      upHoldFactor: 1,
      dropAt: 0,
    };
    this.callbacks.onStatus(
      `Compartilhamento iniciado (geração ${this.screenGen}${this.screenHasAudio() ? ", com som" : ""}, ` +
        `qualidade ${quality === "auto" ? "automática" : SCREEN_LEVELS[this.screenLevel].label}).`,
    );
    this.callbacks.onScreenLevel(this.screenLevel, this.screenQuality, "início");
    this.plan.clear();
    this.tree = { on: false, since: 0, holdFactor: 1, lastExitAt: 0, nextPlanAt: 0, leaseSentAt: 0 };
    this.syncLocalTracks();
    this.broadcastState();
    this.kick();
  }

  // Auto: mantém o nível atual e deixa o ajuste automático agir. Fixo: aplica já, ao
  // vivo, sem reabrir o seletor de tela.
  setScreenQuality(quality: ScreenQuality): void {
    this.screenQuality = quality;
    // Escolha manual = recomeçar sem os tetos por espectador (se a rede de alguém
    // continuar ruim de verdade, o teto volta sozinho).
    for (const p of this.peers.values()) {
      if (!p.conn) continue;
      p.conn.capLevel = 0;
      p.conn.capBad = 0;
      p.conn.capGood = 0;
      p.conn.capApplied = undefined;
    }
    if (quality !== "auto") {
      this.applyLevel(quality, "escolha manual");
    } else {
      this.adaptState.lastStepAt = Date.now();
      this.adaptState.bwBad = 0;
      this.adaptState.cpuBad = 0;
      this.adaptState.good = 0;
      this.callbacks.onScreenLevel(this.screenLevel, quality, "modo automático");
    }
  }

  private applyLevel(level: ScreenLevel, reason: string): void {
    this.screenLevel = level;
    if (this.screen) {
      void applyScreenLevel(this.screen.stream, level).then((ok) => {
        if (!ok) this.callbacks.onStatus("A captura não aceitou mudar de resolução; valem só os tetos de bitrate.");
      });
      for (const p of this.peers.values()) {
        if (p.conn) p.conn.capApplied = undefined;
      }
    }
    this.callbacks.onStatus(`Qualidade da tela: ${SCREEN_LEVELS[level].label} (${reason}).`);
    this.callbacks.onScreenLevel(level, this.screenQuality, reason);
    this.kick();
  }

  // Teste: força um reinício de ICE com uma vaga (só quem oferece).
  debugRestartIce(slot: number): boolean {
    const p = this.peers.get(slot);
    if (!p?.conn || !p.conn.offerer) return false;
    p.conn.pc.restartIce();
    return true;
  }

  debugSnapshot(): Record<string, unknown> {
    const links: Record<string, unknown>[] = [];
    for (const p of this.peers.values()) {
      const c = p.conn;
      if (c) {
        links.push({
          slot: p.slot,
          name: "mic",
          state: c.pc.connectionState,
          gen: c.gen,
          rttMs: c.rttMs,
          lossPct: c.lossPct,
          audioCodec: c.audioCodec,
          videoCodec: c.videoCodec,
          securityCode: c.securityCode,
          dtls: c.dtls,
          ice: iceSummary(c.pc),
          viaTurn: !!c.viaTurn,
          micFmtp: /a=fmtp:\d+ ([^\r\n]*maxaveragebitrate[^\r\n]*)/.exec(c.pc.remoteDescription?.sdp ?? "")?.[1] ?? null,
        });
        if (p.state?.screen.active) links.push({ slot: p.slot, name: "screenIn", state: c.pc.connectionState });
        if (this.screen) {
          const sender = c.tx?.[TX_SCREEN_V].sender;
          links.push({
            slot: p.slot,
            name: "screenOut",
            state: c.pc.connectionState,
            maxBitrate: sender?.getParameters().encodings?.[0]?.maxBitrate ?? null,
            capLevel: c.capLevel,
            sendLossPct: c.sendLossPct,
            limitation: c.limitation,
            codec: c.codecApplied ?? null,
            negotiated: (() => {
              try {
                return [...new Set((c.tx?.[TX_SCREEN_V]?.sender.getParameters().codecs ?? []).map((x) => x.mimeType.split("/")[1]))];
              } catch {
                return [];
              }
            })(),
            encoder: c.encoderImpl ? `${c.encoderImpl}${c.encoderHw ? " [HW]" : ""}` : null,
            sendFps: c.sendFps ?? null,
            sendWidth: c.sendWidth ?? null,
            sendQp: c.sendQp ?? null,
          });
        }
      }
      for (const [via, r] of p.relayIns) links.push({ slot: p.slot, name: "relayIn", state: r.pc.connectionState, via });
    }
    return {
      mySlot: this.mySlot,
      version: VERSION,
      build: BUILD,
      target: TARGET,
      clock: clockKind(),
      hwEncoders: hwEncoders(),
      codecSkip: [...this.codecSkip],
      cpuLoad: this.cpuLoad,
      turn: this.turn.status(),
      peerApps: [...this.peers.values()].map((p) => ({ slot: p.slot, ver: p.state?.ver ?? null, build: p.state?.build ?? null, kind: p.state?.kind ?? null })),
      cap: this.cap,
      capMax: this.capMax,
      load: this.relays.size,
      quality: this.screenQuality,
      level: this.screenLevel,
      relays: [...this.relays.keys()],
      plan: [...this.plan],
      tree: this.tree.on,
      dists: [...this.dists.values()].map((d) => ({ sharer: d.sharer, viewers: [...d.viewers], jobs: [...d.jobs.keys()] })),
      links,
    };
  }

  // Trocar a janela/tela compartilhada: mesma ligação, só o track muda. Quem assiste não
  // vê a tela sumir e voltar.
  replaceScreenStream(stream: MediaStream): void {
    if (!this.screen) {
      this.startScreenShare(stream);
      return;
    }
    this.screen = { stream, gen: this.screen.gen };
    this.screenStartedAt = Date.now();
    this.syncLocalTracks();
    this.callbacks.onStatus("Tela compartilhada trocada.");
    this.broadcastState();
    this.kick();
  }

  setScreenAudio(enabled: boolean): void {
    for (const track of this.screen?.stream.getAudioTracks() ?? []) track.enabled = enabled;
    this.broadcastState();
  }

  screenHasAudio(): boolean {
    return (this.screen?.stream.getAudioTracks().length ?? 0) > 0;
  }

  stopScreenShare(): void {
    if (!this.screen) return;
    this.screen = null;
    this.plan.clear();
    this.tree.on = false;
    this.syncLocalTracks();
    this.callbacks.onStatus("Compartilhamento encerrado.");
    this.broadcastState();
    this.kick();
  }

  // ---------------------------------------------------------------------------
  // Broker (servidor de sinalização): só para reservar a vaga e o primeiro contato.
  // ---------------------------------------------------------------------------

  private iceServers(): RTCIceServer[] {
    return [...STUN_SERVERS, ...this.turn.current()];
  }

  private peerOptions(): PeerJSOption {
    // O PeerJS lê config a cada conexão nova: o getter entrega o TURN que chegar depois.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      ...(this.serverOpts ?? {}),
      config: {
        get iceServers() {
          return self.iceServers();
        },
      },
    };
  }

  private claimSlot(slot: number): void {
    if (this.left) return;
    if (slot > MAX_SLOTS) {
      this.callbacks.onBrokerState("full");
      this.callbacks.onStatus(
        `Sala cheia (máximo ${MAX_SLOTS} pessoas). Se alguém acabou de sair, aguarde ~1 minuto: ` +
          "o servidor demora a liberar a vaga de quem fechou o app sem clicar em Sair.",
      );
      return;
    }

    const id = peerId(this.hash, slot);
    const candidate = new Peer(id, this.peerOptions());

    candidate.on("open", () => {
      if (this.left) {
        candidate.destroy();
        return;
      }
      const firstOpen = this.mySlot === -1;
      this.peer = candidate;
      this.mySlot = slot;
      this.brokerDownSince = 0;
      this.callbacks.onBrokerState("connected");
      for (const s of ALL_SLOTS) {
        if (s !== slot) this.getPeer(s).nextBootAt = 0;
      }
      if (firstOpen) {
        this.callbacks.onSelf(slot, id);
        this.callbacks.onStatus(`Você é o participante ${slot}. Procurando os outros...`);
        this.startTimers();
      } else {
        this.callbacks.onStatus("Reconectado ao servidor de sinalização.");
      }
      this.kick();
    });

    candidate.on("connection", (conn) => {
      if (this.peer !== candidate) {
        conn.close();
        return;
      }
      const slotFrom = slotFromPeerId(conn.peer);
      if (!validSlot(slotFrom) || slotFrom === this.mySlot || bootBlocked(slotFrom)) {
        conn.close();
        return;
      }
      const p = this.getPeer(slotFrom);
      traceIce(conn.peerConnection as RTCPeerConnection | null);
      conn.on("open", () => {
        if (this.left || this.peer !== candidate) {
          conn.close();
          return;
        }
        this.adoptBoot(p, conn, /* outgoing */ false);
      });
    });

    candidate.on("call", (call) => {
      // Versão antiga (3.x) ou cliente desconhecido: não falamos mais por aqui.
      call.close();
    });

    candidate.on("disconnected", () => {
      if (candidate.destroyed || this.peer !== candidate || this.left) return;
      if (!this.brokerDownSince) this.brokerDownSince = Date.now();
      this.callbacks.onBrokerState("reconnecting");
      this.callbacks.onStatus(
        "Perdi o servidor de sinalização (a chamada continua; só entradas novas esperam). Reconectando...",
      );
      this.ensureBrokerReconnect(candidate);
    });

    candidate.on("close", () => {
      if (this.peer !== candidate || this.left) return;
      // O objeto morreu (destroy interno): recriamos com a mesma vaga; as ligações
      // próprias já feitas continuam vivas.
      this.callbacks.onStatus("Conexão com o servidor de sinalização encerrada; reabrindo com a mesma vaga...");
      this.peer = null;
      this.callbacks.onBrokerState("reconnecting");
      setTimeout(() => {
        if (!this.left && !this.peer) this.reclaimSameSlot(slot);
      }, BROKER_RECONNECT_MS);
    });

    candidate.on("error", (err) => {
      const type = (err as { type?: string }).type ?? "";
      const message = (err as Error).message ?? String(err);
      switch (type) {
        case "unavailable-id":
          if (this.peer === candidate) {
            // Aconteceu ao reconectar: o servidor ainda segura o nosso ID antigo.
            this.callbacks.onStatus("Servidor ainda segura nossa vaga antiga; tentando de novo...");
            this.ensureBrokerReconnect(candidate);
          } else if (this.mySlot === -1) {
            candidate.destroy();
            // Alguém está nesta vaga: mesmo antes de conseguirmos contato, a sala não está vazia.
            this.getPeer(slot).occupiedAt = Date.now();
            this.claimSlot(slot + 1);
          } else {
            // Reabrindo a nossa própria vaga depois de um "close": o servidor ainda a
            // segura. Tentamos de novo daqui a pouco, sem mexer nas ligações.
            candidate.destroy();
            setTimeout(() => {
              if (!this.left && !this.peer) this.reclaimSameSlot(slot);
            }, BROKER_RECONNECT_MS);
          }
          return;
        case "peer-unavailable": {
          const match = /Could not connect to peer (.+)$/.exec(message);
          if (match) this.handlePeerUnavailable(slotFromPeerId(match[1]));
          return;
        }
        case "network":
        case "socket-error":
        case "socket-closed":
        case "server-error":
          if (Date.now() - this.lastBrokerErrorAt > 30_000) this.callbacks.onStatus(`Servidor de sinalização: ${message}`);
          this.lastBrokerErrorAt = Date.now();
          return;
        default:
          this.callbacks.onStatus(`Erro (${type || "desconhecido"}): ${message}`);
      }
    });

    setTimeout(() => {
      if (this.left || candidate.destroyed || candidate.open || this.peer === candidate) return;
      if (this.mySlot !== -1) {
        // Reabertura da nossa vaga que não respondeu: tenta de novo, sem mexer nas ligações.
        candidate.destroy();
        if (!this.peer) setTimeout(() => !this.left && !this.peer && this.reclaimSameSlot(slot), BROKER_RECONNECT_MS);
        return;
      }
      candidate.destroy();
      this.callbacks.onBrokerState("failed");
      this.callbacks.onStatus(
        `Sem resposta do servidor de sinalização em ${BROKER_OPEN_TIMEOUT_MS / 1000}s. ` +
          (this.nostr ? "Procurando os amigos pelo ponto de encontro de emergência (Nostr)... " : "") +
          "Tentando o servidor de novo em seguida.",
      );
      this.claimSlotNostr();
      setTimeout(() => {
        if (this.left || this.peer) return;
        if (this.mySlot === -1) this.callbacks.onBrokerState("connecting");
        this.claimSlot(this.mySlot === -1 ? 1 : this.mySlot);
      }, BROKER_RECONNECT_MS * 3);
    }, BROKER_OPEN_TIMEOUT_MS);
  }

  private reclaimSameSlot(slot: number): void {
    if (this.left || this.peer) return;
    this.claimSlot(slot);
  }

  private ensureBrokerReconnect(candidate: Peer): void {
    if (this.brokerTimer) return;
    this.brokerTimer = every(BROKER_RECONNECT_MS, () => {
      if (this.left || this.peer !== candidate || candidate.destroyed) {
        this.stopBrokerTimer();
        return;
      }
      if (!candidate.disconnected) {
        this.stopBrokerTimer();
        return;
      }
      try {
        candidate.reconnect();
      } catch (err) {
        this.callbacks.onStatus(`Falha ao reconectar: ${(err as Error).message ?? err}`);
      }
    });
  }

  private stopBrokerTimer(): void {
    this.brokerTimer?.();
    this.brokerTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Ponto de encontro de emergência (Nostr)
  // ---------------------------------------------------------------------------

  private nostrOpen(p: RemotePeer): boolean {
    return !!this.nostr && Date.now() - p.nostrSeenAt < NOSTR_STALE_MS;
  }

  // Reserva de vaga sem servidor: anuncio a vaga que quero; quem já está na sala responde
  // com as vagas ocupadas; escolho a menor livre. Sem resposta em 3 s, fico com ela.
  private claimSlotNostr(): void {
    if (this.left || !this.nostr || this.mySlot !== -1 || this.nostrClaim) return;
    const now = Date.now();
    const taken = new Set<number>();
    for (const [slot, h] of this.recentHellos) if (now - h.at < NOSTR_STALE_MS) taken.add(slot);
    let slot = 1;
    while (taken.has(slot) && slot <= MAX_SLOTS) slot += 1;
    this.nostrClaim = { slot, taken, hellos: 0, timer: null };
    this.sendHello();
  }

  private sendHello(): void {
    const claim = this.nostrClaim;
    if (!claim || !this.nostr || this.left) return;
    if (claim.timer) clearTimeout(claim.timer);
    claim.hellos += 1;
    void this.nostr.send(0, { t: "hello", slot: claim.slot, tok: this.nostrTok } satisfies HelloMsg);
    claim.timer = setTimeout(() => this.settleClaim(), NOSTR_CLAIM_WAIT_MS);
  }

  private settleClaim(): void {
    const claim = this.nostrClaim;
    if (!claim || this.left) return;
    if (this.mySlot !== -1) {
      this.nostrClaim = null;
      return;
    }
    if (claim.taken.has(claim.slot)) {
      let s = 1;
      while (claim.taken.has(s)) s += 1;
      if (s > MAX_SLOTS || claim.hellos >= NOSTR_HELLO_MAX) {
        this.nostrClaim = null;
        this.callbacks.onBrokerState("full");
        this.callbacks.onStatus(`Sala cheia (máximo ${MAX_SLOTS} pessoas), pelo ponto de encontro de emergência.`);
        return;
      }
      claim.slot = s;
      this.sendHello();
      return;
    }
    const slot = claim.slot;
    const known = [...claim.taken];
    this.nostrClaim = null;
    this.mySlot = slot;
    const now = Date.now();
    for (const s of known) {
      if (s === slot) continue;
      const q = this.getPeer(s);
      q.nostrSeenAt = now;
      q.lastSeenAt = now;
      q.everPresent = true;
    }
    this.callbacks.onSelf(slot, peerId(this.hash, slot));
    this.callbacks.onStatus(
      `Você é o participante ${slot} (pelo ponto de encontro de emergência; ${known.length ? `${known.length} amigo(s) já na sala` : "ninguém respondeu ainda"}).`,
    );
    this.startTimers();
    this.kick();
  }

  private handleNostr(from: number, raw: unknown): void {
    if (this.left || !raw || typeof raw !== "object") return;
    const msg = raw as Partial<Msg | HelloMsg | TakenMsg> & { t?: string };
    const now = Date.now();
    if (msg.t === "hello") {
      const m = msg as Partial<HelloMsg>;
      if (!validSlot(m.slot) || typeof m.tok !== "string") return;
      if (this.mySlot !== -1) {
        // Já estou na sala: digo quais vagas conheço ocupadas.
        const slots = new Set<number>([this.mySlot]);
        for (const p of this.peers.values()) if (this.present(p) || p.state) slots.add(p.slot);
        void this.nostr?.send(m.slot, { t: "taken", slots: [...slots] } satisfies TakenMsg);
        return;
      }
      this.recentHellos.set(m.slot, { tok: m.tok, at: now });
      const claim = this.nostrClaim;
      if (claim && m.slot === claim.slot && m.tok !== this.nostrTok) {
        // Dois entrando ao mesmo tempo na mesma vaga: o de token maior cede; o de token
        // menor avisa que a vaga é dele.
        if (this.nostrTok > m.tok) {
          claim.taken.add(claim.slot);
          this.settleClaim();
        } else {
          void this.nostr?.send(m.slot, { t: "taken", slots: [claim.slot] } satisfies TakenMsg);
        }
      }
      return;
    }
    if (msg.t === "taken") {
      const m = msg as Partial<TakenMsg>;
      const claim = this.nostrClaim;
      if (!claim || !Array.isArray(m.slots)) return;
      for (const s of m.slots) if (validSlot(s)) claim.taken.add(s);
      if (claim.taken.has(claim.slot)) this.settleClaim();
      return;
    }
    if (this.mySlot === -1 || !validSlot(from) || from === this.mySlot) return;
    const p = this.getPeer(from);
    p.nostrSeenAt = now;
    if (!p.everPresent) p.everPresent = true;
    this.handleMessage(p, msg);
    this.kick();
  }

  private brokerReady(): boolean {
    return !!this.peer && this.peer.open && !this.peer.disconnected;
  }

  private startTimers(): void {
    if (this.tickTimer) return;
    this.tickTimer = every(TICK_MS, () => this.tick());
    this.statsTimer = every(STATS_INTERVAL_MS, () => void this.sampleStats());
  }

  private stopTimers(): void {
    this.tickTimer?.();
    this.statsTimer?.();
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.tickTimer = null;
    this.statsTimer = null;
    this.kickTimer = null;
    this.stopBrokerTimer();
  }

  // Um tick antecipado, coalescido, para reagir a eventos sem esperar o próximo segundo.
  private kick(): void {
    if (this.kickTimer || !this.tickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.tick();
    }, 50);
  }

  // A rede mudou (wifi → cabo, voltou do sono): reinicia o ICE de tudo o que estiver
  // doente sem esperar a graça.
  private networkChanged(reason: string): void {
    if (this.left) return;
    this.callbacks.onStatus(`Rede mudou (${reason}); verificando as ligações.`);
    for (const p of this.peers.values()) {
      if (p.conn && p.conn.pc.connectionState !== "connected") p.conn.disconnectedSince = 1;
    }
    this.kick();
  }

  // ---------------------------------------------------------------------------
  // Reconciliação: a cada segundo compara o estado desejado com o real e corrige.
  // ---------------------------------------------------------------------------

  private tick(): void {
    if (this.left || this.mySlot === -1) return;
    const now = Date.now();
    const brokerReady = this.brokerReady();
    if (now - this.lastCapAt >= CAP_INTERVAL_MS) {
      this.lastCapAt = now;
      this.computeCap(now);
    }
    for (const slot of ALL_SLOTS) {
      if (slot === this.mySlot) continue;
      const p = this.getPeer(slot);
      this.reconcilePresence(p, now);
      this.reconcileBoot(p, now, brokerReady);
      this.reconcileConn(p, now);
      this.reconcileRelayChoice(p, now);
      if (this.present(p)) {
        this.sendState(p);
        this.reconcileMedia(p, now);
      }
      this.emitView(p, now);
    }
    this.reconcileRelays(now);
    this.reconcilePlan(now);
    this.reconcileDists(now);
    this.emitShareStatus();
    this.emitRoomHealth(now);
    this.emitSelfHealth();
  }

  // ---------------------------------------------------------------------------
  // Árvore de distribuição da tela
  // ---------------------------------------------------------------------------

  // Quem compartilha decide quem recebe direto e quem recebe por um distribuidor (amigo com
  // score alto que já recebe a nossa tela direto). Entra-se na árvore quando o Auto iria
  // baixar a qualidade por banda/CPU (ver adaptShare); sai-se depois de um período estável.
  private reconcilePlan(now: number): void {
    if (!this.screen) {
      if (this.plan.size) this.plan.clear();
      return;
    }
    const cfg = adapt();
    if (this.tree.on) {
      const hold = Math.min(cfg.treeHoldMaxMs, cfg.treeHoldMs * this.tree.holdFactor);
      if (now - this.tree.since > hold && this.adaptState.bwBad === 0 && this.adaptState.cpuBad === 0) {
        this.tree.on = false;
        this.tree.lastExitAt = now;
        this.plan.clear();
        this.callbacks.onStatus("ÁRVORE: período estável; tentando enviar a tela direto a todos de novo.");
        this.syncLocalTracks();
        this.broadcastState();
        return;
      }
    }
    if (!this.tree.on) {
      if (this.plan.size) {
        this.plan.clear();
        this.syncLocalTracks();
      }
      return;
    }
    if (now >= this.tree.nextPlanAt) {
      this.tree.nextPlanAt = now + PLAN_INTERVAL_MS;
      this.computePlan();
    }
    if (now - this.tree.leaseSentAt >= DIST_LEASE_SEND_MS) {
      this.tree.leaseSentAt = now;
      const byDist = new Map<number, number[]>();
      for (const [viewer, dist] of this.plan) byDist.set(dist, [...(byDist.get(dist) ?? []), viewer]);
      for (const [dist, viewers] of byDist) {
        const d = this.peers.get(dist);
        if (d && this.directOpen(d)) this.sendDirect(d, { t: "dist-lease", viewers });
      }
    }
    // Parar de mandar direto a quem já recebe pelo distribuidor (e voltar se deixou de receber).
    this.syncLocalTracks();
  }

  // Escolhe o menor número de distribuidores (os de maior score) capaz de servir quem não
  // cabe no envio direto; mantém atribuições válidas para não religar à toa.
  private computePlan(): void {
    const viewers = [...this.peers.values()].filter((p) => this.ctrlOpen(p) && p.state);
    const score = (q: RemotePeer) => (q.state?.cap ?? 0) - 10 * (q.state?.load ?? 0);
    const candidates = viewers
      .filter((q) => (q.state?.cap ?? 0) >= DIST_CAP_MIN && (q.state?.load ?? 0) < (q.state?.capMax ?? 0))
      .sort((a, b) => score(b) - score(a) || a.slot - b.slot);
    const next = new Map<number, number>();
    const capOf = (d: RemotePeer) => Math.max(1, ((d.state?.capMax ?? 0) - (d.state?.load ?? 0)) * 2);
    // Quantos distribuidores: o mínimo cuja capacidade cobre quem não vai direto.
    let dists: RemotePeer[] = [];
    for (let k = 1; k <= candidates.length; k++) {
      dists = candidates.slice(0, k);
      const toServe = viewers.length - k - TREE_DIRECT_EXTRA;
      if (toServe <= dists.reduce((sum, d) => sum + capOf(d), 0)) break;
    }
    if (dists.length === 0 || viewers.length - dists.length - TREE_DIRECT_EXTRA <= 0) {
      this.applyPlan(next);
      return;
    }
    const capacity = new Map<number, number>();
    for (const d of dists) capacity.set(d.slot, capOf(d));
    const distSlots = new Set(dists.map((d) => d.slot));
    const rest = viewers.filter((v) => !distSlots.has(v.slot));
    // Mantém as atribuições atuais que continuam válidas (menos troca = menos religação).
    for (const v of rest) {
      const cur = this.plan.get(v.slot);
      if (cur !== undefined && capacity.has(cur) && this.peers.get(cur)?.state?.links.includes(v.slot) && (capacity.get(cur) ?? 0) > 0) {
        next.set(v.slot, cur);
        capacity.set(cur, capacity.get(cur)! - 1);
      }
    }
    // Os primeiros continuam direto; os demais vão para os distribuidores, por rodízio.
    let extra = TREE_DIRECT_EXTRA;
    for (const v of rest) {
      if (next.has(v.slot)) continue;
      if (extra > 0) {
        extra -= 1;
        continue;
      }
      const d = dists.find((c) => (capacity.get(c.slot) ?? 0) > 0 && c.state?.links.includes(v.slot));
      if (!d) continue; // fica direto
      next.set(v.slot, d.slot);
      capacity.set(d.slot, capacity.get(d.slot)! - 1);
    }
    this.applyPlan(next);
  }

  private applyPlan(next: Map<number, number>): void {
    const before = JSON.stringify([...this.plan]);
    const after = JSON.stringify([...next]);
    if (before === after) return;
    this.plan = next;
    const desc = [...next].map(([v, d]) => `${this.peerName(this.getPeer(v))} via ${this.peerName(this.getPeer(d))}`).join(", ");
    this.callbacks.onStatus(`ÁRVORE: ${next.size ? desc : "todos direto"}.`);
    this.broadcastState();
  }

  // Entra na árvore em vez de baixar a qualidade, se houver com quem distribuir.
  private tryEnterTree(now: number, reason: string): boolean {
    if (this.tree.on) return false;
    const cfg = adapt();
    const viewers = [...this.peers.values()].filter((p) => this.ctrlOpen(p) && p.state);
    if (viewers.length < cfg.treeMinViewers) return false;
    const hasDist = viewers.some((q) => (q.state?.cap ?? 0) >= DIST_CAP_MIN && (q.state?.load ?? 0) < (q.state?.capMax ?? 0));
    if (!hasDist) return false;
    if (this.tree.lastExitAt && now - this.tree.lastExitAt < cfg.oscillationWindowMs) {
      this.tree.holdFactor = Math.min(this.tree.holdFactor * 2, Math.max(1, cfg.treeHoldMaxMs / cfg.treeHoldMs));
    }
    this.tree.on = true;
    this.tree.since = now;
    this.tree.nextPlanAt = 0;
    this.tree.leaseSentAt = 0;
    this.callbacks.onStatus(`ÁRVORE: ${reason}; distribuindo a tela por amigos antes de baixar a qualidade.`);
    this.computePlan();
    return true;
  }

  // Lado do distribuidor: para cada espectador do aluguel, uma ligação nossa (só tela) com
  // os tracks da tela de quem compartilha como fonte.
  private reconcileDists(now: number): void {
    for (const [sharerSlot, lease] of this.dists) {
      const sharer = this.peers.get(sharerSlot);
      const src = sharer?.conn && this.usable(sharer.conn) ? sharer.conn : null;
      if (lease.leaseUntil <= now || !sharer || !this.directOpen(sharer) || !sharer.state?.screen.active) {
        this.teardownDist(lease);
        this.dists.delete(sharerSlot);
        continue;
      }
      for (const [viewer, job] of lease.jobs) {
        if (!lease.viewers.has(viewer)) {
          this.closeConn(job);
          lease.jobs.delete(viewer);
          const v = this.peers.get(viewer);
          if (v) this.sendDirect(v, { t: "rclose", from: sharerSlot });
        }
      }
      if (!src) continue;
      const tracks = [null, src.tx![TX_SCREEN_V].receiver.track, src.tx![TX_SCREEN_A].receiver.track];
      for (const viewer of lease.viewers) {
        const v = this.peers.get(viewer);
        if (!v || !this.ctrlOpen(v)) continue;
        let job = lease.jobs.get(viewer) ?? null;
        if (job) {
          const cs = job.pc.connectionState;
          if (cs === "disconnected" && !job.disconnectedSince) job.disconnectedSince = now;
          if (cs === "connected") job.disconnectedSince = 0;
          const dead =
            job.dead ||
            cs === "failed" ||
            cs === "closed" ||
            (cs !== "connected" && !job.everConnected && now - job.createdAt > PC_SETUP_TIMEOUT_MS) ||
            (cs === "disconnected" && job.disconnectedSince && now - job.disconnectedSince > ICE_DISCONNECTED_GRACE_MS);
          if (dead) {
            this.closeConn(job);
            lease.jobs.delete(viewer);
            lease.nextAt.set(viewer, now + LOST_PEER_RETRY_MS);
            this.sendDirect(v, { t: "rclose", from: sharerSlot });
            job = null;
          }
        }
        if (job) {
          this.syncConnTracks(job, tracks);
          this.ensureCap(job, RELAY_SCREEN_CAP);
          continue;
        }
        if (now < (lease.nextAt.get(viewer) ?? 0)) continue;
        const gen = 1_000_000 + (lease.gens.get(viewer) ?? 0) + 1;
        lease.gens.set(viewer, gen - 1_000_000);
        const c = this.newConn(gen, /* offerer */ true, now);
        c.pc.addTransceiver("audio", { direction: "inactive" });
        c.pc.addTransceiver(tracks[1]!, { direction: "sendonly" });
        c.pc.addTransceiver(tracks[2]!, { direction: "sendonly" });
        this.setTransceivers(c);
        if (c.tx) applyCodecPreferences(c.tx);
        // A tela já entra junto: política de vídeo antes do primeiro quadro.
        c.screenPrep = "done";
        void this.prepareScreenSender(c);
        c.pc.onicecandidate = (ev) => {
          if (lease.jobs.get(viewer) !== c || c.dead || !ev.candidate) return;
          this.sendDirect(v, { t: "rice", from: sharerSlot, gen: c.gen, c: ev.candidate.toJSON() });
        };
        c.pc.onconnectionstatechange = () => {
          if (c.pc.connectionState === "connected") c.everConnected = true;
          this.kick();
        };
        c.pc.onnegotiationneeded = () => {
          c.queue = c.queue
            .then(async () => {
              if (lease.jobs.get(viewer) !== c || c.dead) return;
              const offer = await c.pc.createOffer();
              offer.sdp = mungeSdp(offer.sdp ?? "");
              await c.pc.setLocalDescription(offer);
              if (lease.jobs.get(viewer) !== c || c.dead) return;
              this.sendDirect(v, { t: "rsdp", from: sharerSlot, gen: c.gen, k: "screen", d: { type: offer.type, sdp: offer.sdp } });
            })
            .catch(() => {
              c.dead = true;
            });
        };
        lease.jobs.set(viewer, c);
      }
    }
  }

  private teardownDist(lease: DistLease): void {
    for (const [viewer, job] of lease.jobs) {
      this.closeConn(job);
      const v = this.peers.get(viewer);
      if (v) this.sendDirect(v, { t: "rclose", from: lease.sharer });
    }
    lease.jobs.clear();
  }

  // ---------------------------------------------------------------------------
  // Capacidade de ponte (score dinâmico) e saúde da sala
  // ---------------------------------------------------------------------------

  private capMaxFor(cap: number): number {
    return cap >= 80 ? 4 : cap >= 60 ? 3 : cap >= CAP_BRIDGE_MIN ? 1 : 0;
  }

  // Score 0–100 com dados reais: alcance (canal próprio com quantos dos presentes),
  // latência, perda, folga de upload estimada, CPU, e a carga de ponte que já temos.
  private computeCap(now: number): void {
    if (this.systemLoad) {
      void this.systemLoad().then((v) => {
        this.cpuLoad = typeof v === "number" && Number.isFinite(v) ? v : null;
      }).catch(() => {});
    }
    let presentCount = 0;
    let linked = 0;
    const rtts: number[] = [];
    let worstLoss = 0;
    let bestAvail: number | null = null;
    for (const p of this.peers.values()) {
      if (!this.present(p) && !p.state) continue;
      presentCount += 1;
      if (this.ctrlOpen(p)) linked += 1;
      const c = p.conn;
      if (c && this.usable(c)) {
        if (c.rttMs !== null) rtts.push(c.rttMs);
        worstLoss = Math.max(worstLoss, c.lossPct ?? 0, c.sendLossPct ?? 0);
        if (c.availOut !== null) bestAvail = bestAvail === null ? c.availOut : Math.max(bestAvail, c.availOut);
        if (c.limitation === "cpu") this.cpuLimitedAt = now;
      }
    }
    let raw = 0;
    raw += presentCount === 0 ? 40 : Math.round((40 * linked) / presentCount);
    rtts.sort((a, b) => a - b);
    const rtt = rtts.length ? rtts[Math.floor(rtts.length / 2)] : null;
    raw += rtt === null ? 15 : rtt <= 40 ? 20 : rtt <= 80 ? 15 : rtt <= 150 ? 8 : 0;
    raw += worstLoss <= 0.5 ? 15 : worstLoss <= 2 ? 10 : worstLoss <= 5 ? 4 : 0;
    raw += bestAvail === null ? 8 : bestAvail >= 8_000_000 ? 15 : bestAvail >= 4_000_000 ? 10 : bestAvail >= 2_000_000 ? 5 : 0;
    raw += this.cpuLoad === null ? 7 : this.cpuLoad <= 50 ? 10 : this.cpuLoad <= 75 ? 5 : 0;
    if (now - this.cpuLimitedAt < CPU_LIMIT_MEMORY_MS) raw -= 15;
    raw -= 10 * this.relays.size;
    if (typeof window.__NITRO_CAP__ === "number") raw = window.__NITRO_CAP__;
    raw = Math.max(0, Math.min(100, raw));
    const smoothed = this.cap > 0 ? this.cap * 0.5 + raw * 0.5 : raw;
    const cap = Math.round(smoothed / 5) * 5;
    if (cap !== this.cap) {
      this.cap = cap;
      this.capMax = this.capMaxFor(cap);
    }
  }

  private emitRoomHealth(now: number): void {
    const nameOf = (slot: number) => (slot === this.mySlot ? this.name : this.peerName(this.getPeer(slot)));
    const members: number[] = [this.mySlot];
    const reach = new Map<number, Set<number>>();
    const mine = new Set<number>();
    for (const p of this.peers.values()) {
      const occupied = p.occupiedAt > 0 && now - p.occupiedAt < OCCUPIED_SHOW_MS;
      const known = this.present(p) || !!p.state || this.gossipName(p.slot) !== null || occupied;
      if (!known) {
        p.knownSince = 0;
        continue;
      }
      if (!p.knownSince) p.knownSince = now;
      members.push(p.slot);
      if (this.micIncoming(p)) mine.add(p.slot);
      if (p.state) reach.set(p.slot, new Set([...p.state.links, ...p.state.vias]));
    }
    reach.set(this.mySlot, mine);
    let capable = this.cap >= CAP_BRIDGE_MIN ? 1 : 0;
    for (const p of this.peers.values()) if (p.state && members.includes(p.slot) && p.state.cap >= CAP_BRIDGE_MIN) capable += 1;
    const gaps: RoomHealth["gaps"] = [];
    let connecting = false;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const ok = reach.get(a)?.has(b) || reach.get(b)?.has(a);
        if (ok) continue;
        const ageA = a === this.mySlot ? Infinity : now - this.getPeer(a).knownSince;
        const ageB = b === this.mySlot ? Infinity : now - this.getPeer(b).knownSince;
        if (Math.min(ageA, ageB) < RELAY_AFTER_MS + 10_000) {
          connecting = true;
          continue;
        }
        // Alguém alcança os dois e tem capacidade de ponte?
        let noBridge = true;
        for (const m of members) {
          if (m === a || m === b) continue;
          const r = reach.get(m);
          const cap = m === this.mySlot ? this.cap : (this.getPeer(m).state?.cap ?? 0);
          if (r?.has(a) && r.has(b) && cap >= CAP_BRIDGE_MIN) noBridge = false;
        }
        gaps.push({ a: nameOf(a), b: nameOf(b), noBridge });
      }
    }
    const health: RoomHealth = {
      state: gaps.length ? "gap" : connecting ? "connecting" : "ok",
      total: members.length,
      capable,
      gaps,
    };
    const key = JSON.stringify(health);
    if (key === this.lastHealthKey) return;
    this.lastHealthKey = key;
    if (gaps.length) {
      const g = gaps[0];
      this.callbacks.onStatus(`SAÚDE: ${g.a} e ${g.b} sem caminho${g.noBridge ? " (ninguém na sala consegue fazer ponte)" : ""}.`);
    }
    this.callbacks.onRoomHealth(health);
  }

  private emitSelfHealth(): void {
    const rtts: number[] = [];
    let loss: number | null = null;
    let jitter: number | null = null;
    let anyConn = false;
    let allDtls = true;
    for (const p of this.peers.values()) {
      const c = p.conn;
      if (!c || !this.usable(c)) continue;
      anyConn = true;
      if (c.rttMs !== null) rtts.push(c.rttMs);
      loss = Math.max(loss ?? 0, c.lossPct ?? 0, c.sendLossPct ?? 0);
      jitter = Math.max(jitter ?? 0, c.jitterMs ?? 0);
      if (c.dtls !== "connected") allDtls = false;
    }
    const rtt = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
    const health: SelfHealth = {
      cap: this.cap,
      capMax: this.capMax,
      load: this.relays.size,
      quality: anyConn ? qualityOf(rtt, loss, jitter) : null,
      secure: anyConn && allDtls,
    };
    const key = JSON.stringify(health);
    if (key === this.lastSelfHealthKey) return;
    this.lastSelfHealthKey = key;
    this.callbacks.onSelfHealth(health);
  }

  // Aplica o teto de bitrate do vídeo numa ligação de saída (setParameters, sem
  // renegociar). Teto = o menor entre o do nível escolhido e o desta ligação.
  private ensureCap(c: Conn, levelCap: number | null): void {
    const linkCap = LINK_CAPS[c.capLevel] ?? null;
    const desired = levelCap === null ? linkCap : linkCap === null ? levelCap : Math.min(levelCap, linkCap);
    if (c.capApplied === desired) return;
    const sender = c.tx?.[TX_SCREEN_V]?.sender;
    if (!sender || !sender.track) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) return;
    for (const enc of params.encodings) {
      if (desired === null) delete enc.maxBitrate;
      else enc.maxBitrate = desired;
    }
    // Teto alto: manter a resolução (nitidez; sob aperto cai o fps, não a imagem). Teto
    // baixo de uma ligação fraca: reduzir a resolução é melhor que 2 quadros por segundo.
    const degradation: RTCDegradationPreference =
      desired === null || desired >= 3_000_000 ? screenDegradation() : desired >= 1_000_000 ? "balanced" : "maintain-framerate";
    (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = degradation;
    sender
      .setParameters(params)
      .then(() => {
        c.capApplied = desired;
      })
      .catch(() => {
        /* tenta de novo no próximo tick */
      });
  }

  private getPeer(slot: number): RemotePeer {
    let p = this.peers.get(slot);
    if (!p) {
      p = {
        slot,
        boot: null,
        bootOpenAt: 0,
        pendingBoot: null,
        occupiedAt: 0,
        state: null,
        lastSeenAt: 0,
        everPresent: false,
        conn: null,
        connGen: 0,
        nextConnAt: 0,
        relayIns: new Map(),
        distIns: new Map(),
        viaPrev: null,
        viaPrevUntil: 0,
        nextElectAt: 0,
        betterCount: 0,
        busyUntil: new Map(),
        knownSince: 0,
        authed: false,
        authBadAt: 0,
        nostrSeenAt: 0,
        nostrStateAt: 0,
        nextBootAt: 0,
        firstBootAt: 0,
        bootFailures: 0,
        nextAssistAt: 0,
        lastRestartAskAt: 0,
        lastNeedMicAt: 0,
        lastNeedScreenAt: 0,
        screenActiveSince: 0,
        via: null,
        leaseSentAt: 0,
        nextRelayAt: 0,
        lastView: "",
        micEmitted: null,
        screenEmitted: null,
      };
      this.peers.set(slot, p);
    }
    return p;
  }

  private peerName(p: RemotePeer): string {
    return p.state?.name || this.gossipName(p.slot) || `Amigo ${p.slot}`;
  }

  private gossipName(slot: number): string | null {
    for (const q of this.peers.values()) {
      if (!this.directOpen(q) || !q.state) continue;
      const entry = q.state.roster.find(([s]) => s === slot);
      if (entry?.[1]) return entry[1];
    }
    return null;
  }

  private ctrlOpen(p: RemotePeer): boolean {
    return p.conn?.ctrl?.readyState === "open" && !p.conn.dead;
  }

  private bootOpen(p: RemotePeer): boolean {
    return !!p.boot?.open;
  }

  // Canal direto (nosso, o de bootstrap do servidor, ou o ponto de encontro de emergência)
  // aberto com este participante.
  private directOpen(p: RemotePeer): boolean {
    return this.ctrlOpen(p) || this.bootOpen(p) || this.nostrOpen(p);
  }

  private present(p: RemotePeer): boolean {
    return this.directOpen(p) || !!p.via;
  }

  // Canal direto de verdade (próprio ou bootstrap), por onde dá para encaminhar e pedir
  // ponte; o ponto de encontro de emergência não serve para isso.
  private realDirect(p: RemotePeer): boolean {
    return this.ctrlOpen(p) || this.bootOpen(p);
  }

  // Alguém com canal direto conosco e, pela fofoca, com `p`: serve para levar mensagens
  // (sinalização assistida) e como candidato a ponte.
  private helperFor(p: RemotePeer): RemotePeer | null {
    if (p.via) {
      const bridge = this.peers.get(p.via);
      if (bridge && this.realDirect(bridge)) return bridge;
    }
    let best: RemotePeer | null = null;
    for (const q of this.peers.values()) {
      if (q.slot === p.slot || !this.realDirect(q) || !q.state?.links.includes(p.slot)) continue;
      if (!best || q.slot < best.slot) best = q;
    }
    return best;
  }

  private reconcilePresence(p: RemotePeer, now: number): void {
    if (p.boot) {
      const pc = p.boot.peerConnection as RTCPeerConnection | null;
      const cs = pc?.connectionState;
      if (!p.boot.open || !pc || cs === "failed" || cs === "closed") {
        this.ignoredConns.add(p.boot);
        p.boot.close();
        p.boot = null;
        p.nextBootAt = now + LOST_PEER_RETRY_MS;
      }
    }
    if (p.pendingBoot && now - p.pendingBoot.at > BOOT_CONNECT_TIMEOUT_MS) this.failPendingBoot(p, now);
    const wasPresent = this.present(p) || !!p.state;
    if (wasPresent && now - p.lastSeenAt > PEER_STALE_MS) {
      if (p.via && !this.directOpen(p)) this.relayLost(p, "sem sinal de vida pela ponte");
      else this.peerLost(p, "sem sinal de vida");
      return;
    }
    // Canal de controle próprio morreu e não há bootstrap para refazer: o outro saiu.
    if (p.conn?.dead && !this.bootOpen(p) && !p.via && p.everPresent && !this.helperFor(p)) {
      this.peerLost(p, "ligação encerrada");
    }
  }

  private reconcileBoot(p: RemotePeer, now: number, brokerReady: boolean): void {
    if (p.boot || p.pendingBoot) return;
    // Com o canal próprio aberto o servidor não é mais necessário para este par.
    if (this.ctrlOpen(p)) return;
    if (!brokerReady || now < p.nextBootAt) return;
    if (this.turn.enabled && !this.turnSettled && now < this.turnGateUntil) return;
    if (!p.firstBootAt) p.firstBootAt = now;
    if (bootBlocked(p.slot)) {
      p.nextBootAt = now + EMPTY_SLOT_POLL_MS;
      return;
    }
    this.connectBoot(p, now);
  }

  private connectBoot(p: RemotePeer, now: number): void {
    if (!this.peer) return;
    const conn = this.peer.connect(peerId(this.hash, p.slot), {
      serialization: "json",
      reliable: true,
    });
    if (!conn) {
      p.nextBootAt = now + LOST_PEER_RETRY_MS;
      return;
    }
    p.pendingBoot = { conn, at: now, turn: this.turn.current().length > 0 };
    traceIce(conn.peerConnection as RTCPeerConnection | null);
    conn.on("open", () => {
      if (p.pendingBoot?.conn === conn) p.pendingBoot = null;
      if (this.left || this.ignoredConns.has(conn)) {
        conn.close();
        return;
      }
      this.adoptBoot(p, conn, /* outgoing */ true);
    });
    const fail = () => {
      if (p.pendingBoot?.conn === conn) this.failPendingBoot(p, Date.now());
    };
    conn.on("error", fail);
    conn.on("close", fail);
  }

  private failPendingBoot(p: RemotePeer, now: number): void {
    if (p.pendingBoot) {
      const pc = p.pendingBoot.conn.peerConnection as RTCPeerConnection | null;
      // Só para quem sabemos que está na sala (vaga vazia não é falha).
      if (pc && (p.occupiedAt || p.everPresent)) void this.logIceFailure(`contato com ${this.peerName(p)}`, pc, p.pendingBoot.turn);
      this.ignoredConns.add(p.pendingBoot.conn);
      p.pendingBoot.conn.close();
      p.pendingBoot = null;
    }
    p.bootFailures += 1;
    const base = p.everPresent ? LOST_PEER_RETRY_MS : EMPTY_SLOT_POLL_MS;
    const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(p.bootFailures - 1, 3));
    p.nextBootAt = now + delay + Math.random() * 500;
  }

  // Credenciais TURN chegaram (ou foram renovadas): quem ainda não tem caminho tenta de novo
  // já, agora com o TURN, em vez de esperar o próximo intervalo.
  private onTurnChange(): void {
    const st = this.turn.status();
    const line = st.state === "ok" ? `TURN: credenciais prontas (${st.urls} endereços).` : `TURN: sem credenciais (${st.error || st.state}).`;
    if (line !== this.turnLogged) {
      this.turnLogged = line;
      this.callbacks.onStatus(line);
    }
    if (st.state !== "ok" || this.left) return;
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (this.present(p)) continue;
      if (p.pendingBoot && !p.pendingBoot.turn) {
        this.ignoredConns.add(p.pendingBoot.conn);
        p.pendingBoot.conn.close();
        p.pendingBoot = null;
      }
      if (p.occupiedAt || p.everPresent || p.bootFailures > 0) {
        p.nextBootAt = now;
        p.bootFailures = 0;
      }
    }
    this.kick();
  }

  // Resumo do ICE de uma ligação que não fechou: que caminhos cada lado ofereceu, erros de
  // STUN/TURN e se havia TURN. É o que diz, pelo diagnóstico, por que um celular não liga.
  private async logIceFailure(what: string, pc: RTCPeerConnection, hadTurn: boolean): Promise<void> {
    const live = iceSummary(pc);
    if (live) {
      this.callbacks.onStatus(`ICE: ${what} não fechou (${live}; TURN ${hadTurn ? "sim" : "não"}).`);
      return;
    }
    try {
      const count = (m: Map<string, number>) => ["host", "srflx", "prflx", "relay"].map((k) => `${k} ${m.get(k) ?? 0}`).join(", ");
      const local = new Map<string, number>();
      const remote = new Map<string, number>();
      let pairs = 0;
      let v6 = false;
      const report = await pc.getStats();
      report.forEach((st: Record<string, unknown>) => {
        const type = String(st.candidateType ?? "");
        if (st.type === "local-candidate") {
          local.set(type, (local.get(type) ?? 0) + 1);
          if (String(st.address ?? st.ip ?? "").includes(":")) v6 = true;
        } else if (st.type === "remote-candidate") remote.set(type, (remote.get(type) ?? 0) + 1);
        else if (st.type === "candidate-pair") pairs += 1;
      });
      this.callbacks.onStatus(
        `ICE: ${what} não fechou (${pc.iceConnectionState}/${pc.iceGatheringState}; locais: ${count(local)}${v6 ? ", IPv6" : ""}; ` +
          `remotos: ${count(remote)}; pares ${pairs}; TURN ${hadTurn ? "sim" : "não"}).`,
      );
    } catch {
      /* ligação já fechada */
    }
  }

  private handlePeerUnavailable(slot: number): void {
    const p = this.peers.get(slot);
    if (!p) return;
    p.occupiedAt = 0;
    if (p.pendingBoot) this.failPendingBoot(p, Date.now());
  }

  // Convenção para ficar com um único canal por par quando os dois lados ligam ao mesmo
  // tempo: vale o canal iniciado pela vaga de número menor.
  private adoptBoot(p: RemotePeer, conn: DataConnection, outgoing: boolean): void {
    const now = Date.now();
    if (p.boot && p.boot !== conn) {
      const keepNew = this.mySlot < p.slot ? outgoing : !outgoing;
      if (!keepNew) {
        this.ignoredConns.add(conn);
        conn.close();
        return;
      }
      const old = p.boot;
      this.ignoredConns.add(old);
      old.close();
    }
    const isNew = p.boot !== conn;
    p.boot = conn;
    p.bootOpenAt = now;
    p.lastSeenAt = now;
    p.bootFailures = 0;
    if (isNew) {
      conn.on("data", (raw) => {
        if (p.boot !== conn || this.ignoredConns.has(conn)) return;
        this.handleMessage(p, raw);
      });
      conn.on("close", () => {
        if (this.ignoredConns.has(conn) || p.boot !== conn) return;
        p.boot = null;
        p.nextBootAt = Date.now() + LOST_PEER_RETRY_MS;
        this.kick();
      });
      conn.on("error", () => {
        if (this.ignoredConns.has(conn) || p.boot !== conn) return;
        p.boot = null;
        p.nextBootAt = Date.now() + LOST_PEER_RETRY_MS;
        this.kick();
      });
    }
    this.onDirectOpen(p, "boot");
  }

  private onDirectOpen(p: RemotePeer, how: "boot" | "ctrl"): void {
    p.occupiedAt = 0;
    const first = !p.everPresent;
    p.everPresent = true;
    if (how === "ctrl" && p.via) {
      // Caminho direto apareceu: a ponte deixa de ser necessária.
      this.callbacks.onStatus(`Conexão direta com ${this.peerName(p)} estabelecida; dispensando a ponte.`);
      this.cancelLease(p);
    }
    if (first) this.callbacks.onStatus(`Participante ${p.slot} presente. Ligando áudio...`);
    this.sendState(p);
    this.kick();
  }

  // ---------------------------------------------------------------------------
  // Ligação própria por par (forma fixa; sinalizada pelo canal de controle)
  // ---------------------------------------------------------------------------

  private newConn(gen: number, offerer: boolean, now: number): Conn {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    traceIce(pc);
    return {
      gen,
      pc,
      offerer,
      createdAt: now,
      ctrl: null,
      tx: null,
      pendingIce: [],
      remoteSet: false,
      micStream: null,
      screenStream: null,
      queue: Promise.resolve(),
      dead: false,
      everConnected: false,
      disconnectedSince: 0,
      restarts: 0,
      lastRestartAt: 0,
      bytesIn: 0,
      bytesInChangedAt: now,
      packetsLost: 0,
      packetsReceived: 0,
      rttMs: null,
      lossPct: null,
      jitterMs: null,
      stalled: false,
      dtls: null,
      securityCode: null,
      jitterTargetOn: false,
      audioCodec: null,
      videoCodec: null,
      bytesSent: 0,
      sendLossPct: null,
      limitation: null,
      availOut: null,
      capLevel: 0,
      capApplied: undefined,
      capBad: 0,
      capGood: 0,
      capStepAt: now,
    };
  }

  private closeConn(c: Conn): void {
    c.dead = true;
    try {
      c.ctrl?.close();
    } catch {
      /* já fechado */
    }
    try {
      c.pc.close();
    } catch {
      /* já fechada */
    }
  }

  private setTransceivers(c: Conn): void {
    const tx = c.pc.getTransceivers();
    if (tx.length < 3) return;
    c.tx = tx.slice(0, 3);
    c.micStream = new MediaStream([c.tx[TX_MIC].receiver.track]);
    c.screenStream = new MediaStream([c.tx[TX_SCREEN_V].receiver.track, c.tx[TX_SCREEN_A].receiver.track]);
  }

  private localTracks(): (MediaStreamTrack | null)[] {
    return [
      this.localStream.getAudioTracks()[0] ?? null,
      this.screen?.stream.getVideoTracks()[0] ?? null,
      this.screen?.stream.getAudioTracks()[0] ?? null,
    ];
  }

  // Para um espectador que já confirma receber a nossa tela pelo distribuidor, paramos de
  // mandar direto (é aí que a árvore poupa upload e CPU).
  private localTracksFor(p: RemotePeer): (MediaStreamTrack | null)[] {
    const tracks = this.localTracks();
    const dist = this.plan.get(p.slot);
    if (dist !== undefined && p.state?.screenVia === dist) {
      tracks[TX_SCREEN_V] = null;
      tracks[TX_SCREEN_A] = null;
    }
    return tracks;
  }

  // Garante que cada sender envia o track local atual (replaceTrack, sem renegociar).
  private syncConnTracks(c: Conn, tracks: (MediaStreamTrack | null)[]): void {
    if (!c.tx || c.dead) return;
    tracks.forEach((track, i) => {
      const t = c.tx![i];
      if (!t) return;
      const live = track && track.readyState === "live" ? track : null;
      if (t.sender.track === live) return;
      if (i === TX_SCREEN_V && live && c.screenPrep !== "done") {
        // Primeiro quadro da tela nesta ligação: codec, "manter resolução" e teto ANTES
        // de o codificador começar (depois ele já terá escolhido uma resolução menor).
        if (c.screenPrep === "pending") return;
        c.screenPrep = "pending";
        void this.prepareScreenSender(c).finally(() => {
          c.screenPrep = "done";
          if (!c.dead && t.sender.track !== live && live.readyState === "live") {
            t.sender.replaceTrack(live).catch(() => {});
          }
        });
        return;
      }
      t.sender.replaceTrack(live).catch(() => {
        /* tenta no próximo tick */
      });
      if (i === TX_SCREEN_V) c.capApplied = undefined;
    });
  }

  // Teto de bitrate do nível atual para uma ligação (sem tetos por espectador).
  private levelCap(): number | null {
    const hook = Number(window.__NITRO_MAXBR__);
    if (this.screenLevel === "alta" && Number.isFinite(hook) && hook > 0) return hook;
    return SCREEN_LEVELS[this.screenLevel].maxBitrate;
  }

  private async prepareScreenSender(c: Conn): Promise<void> {
    const sender = c.tx?.[TX_SCREEN_V]?.sender;
    if (!sender) return;
    await probeHwEncoders().catch(() => null);
    try {
      // Escolher ANTES de pegar os parâmetros: chooseSendCodec lê getParameters(), e cada
      // leitura invalida a anterior (transactionId) para o setParameters.
      const choice = chooseSendCodec(sender, this.codecSkip);
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference };
      if (!params.encodings?.length) return;
      const cap = this.relayOrLevelCap(c);
      // Câmera (celular, rede móvel): cai a resolução antes do fps; tela: mantém a nitidez.
      params.degradationPreference = this.screenIsCamera ? "balanced" : screenDegradation();
      for (const enc of params.encodings as (RTCRtpEncodingParameters & { codec?: RTCRtpCodec })[]) {
        if (cap === null) delete enc.maxBitrate;
        else enc.maxBitrate = cap;
        if (choice.codec) enc.codec = choice.codec;
        else delete enc.codec;
      }
      await sender.setParameters(params);
      c.capApplied = cap;
      c.codecApplied = choice.name;
      c.codecExpectHw = choice.expectHw;
      c.codecChosenAt = Date.now();
    } catch {
      /* segue com o padrão do navegador; ensureCap tenta de novo */
    }
  }

  // O encoder que o Chromium escolheu não é o esperado (caiu na CPU) ou a CPU não
  // aguenta: marca o codec como ruim nesta máquina e troca ao vivo para o próximo que
  // codifique na GPU. Sem renegociar: é só setParameters.
  private checkEncoder(c: Conn, now: number): void {
    if (!c.codecChosenAt || !c.encoderImpl || now - c.codecChosenAt < ENCODER_CHECK_MS) return;
    const cur = c.codecApplied || "VP9";
    const fellToCpu = !!c.codecExpectHw && c.encoderHw === false;
    const cpuBound = c.limitation === "cpu" && now - c.codecChosenAt > ENCODER_CPU_MS;
    if (!fellToCpu && !cpuBound) return;
    if (this.codecSkip.has(cur)) return;
    this.codecSkip.add(cur);
    const sender = c.tx?.[TX_SCREEN_V]?.sender;
    if (!sender) return;
    const next = chooseSendCodec(sender, this.codecSkip);
    if (next.name === cur) return;
    const why = fellToCpu ? `${cur} caiu na CPU` : `a CPU não está aguentando ${cur}`;
    this.callbacks.onStatus(`Tela: ${why}; trocando para ${next.name}${next.expectHw ? " na GPU" : ""}.`);
    try {
      const params = sender.getParameters();
      for (const enc of params.encodings as (RTCRtpEncodingParameters & { codec?: RTCRtpCodec })[]) {
        if (next.codec) enc.codec = next.codec;
        else delete enc.codec;
      }
      void sender.setParameters(params).then(() => {
        c.codecApplied = next.name;
        c.codecExpectHw = next.expectHw;
        c.codecChosenAt = Date.now();
      }).catch(() => {});
    } catch {
      /* tenta de novo na próxima amostra */
    }
  }

  // Ligações de ponte/distribuição recodificam a tela de outro: teto da Alta.
  private relayOrLevelCap(c: Conn): number | null {
    for (const p of this.peers.values()) if (p.conn === c) return this.levelCap();
    return RELAY_SCREEN_CAP;
  }

  private syncLocalTracks(): void {
    for (const p of this.peers.values()) {
      if (p.conn) this.syncConnTracks(p.conn, this.localTracksFor(p));
    }
  }

  private createPairConn(p: RemotePeer, gen: number, now: number): Conn {
    const c = this.newConn(gen, /* offerer */ true, now);
    c.pc.addTransceiver("audio", { direction: "sendrecv" });
    c.pc.addTransceiver("video", { direction: "sendrecv" });
    c.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.setTransceivers(c);
    if (c.tx) applyCodecPreferences(c.tx);
    this.syncConnTracks(c, this.localTracks());
    c.ctrl = c.pc.createDataChannel("ctrl", { negotiated: true, id: 0 });
    this.wireCtrl(p, c);
    this.wirePairConn(p, c);
    c.pc.onnegotiationneeded = () => {
      c.queue = c.queue.then(() => this.makeOffer(p, c)).catch(() => {});
    };
    return c;
  }

  private wireCtrl(p: RemotePeer, c: Conn): void {
    const ch = c.ctrl!;
    ch.onopen = () => {
      if (p.conn !== c || c.dead) return;
      this.onDirectOpen(p, "ctrl");
    };
    ch.onmessage = (ev) => {
      if (p.conn !== c || c.dead) return;
      if (typeof ev.data !== "string" || ev.data.length > MAX_MSG_BYTES) return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleMessage(p, msg);
    };
    ch.onclose = () => {
      if (p.conn !== c || c.dead) return;
      c.dead = true;
      this.kick();
    };
  }

  private wirePairConn(p: RemotePeer, c: Conn): void {
    c.pc.onicecandidate = (ev) => {
      if (p.conn !== c || c.dead || !ev.candidate) return;
      this.send(p, { t: "ice", gen: c.gen, c: ev.candidate.toJSON() });
    };
    c.pc.onconnectionstatechange = () => {
      if (p.conn !== c) return;
      if (c.pc.connectionState === "connected") {
        c.everConnected = true;
        c.disconnectedSince = 0;
        c.restarts = 0;
        c.stalled = false;
      }
      this.kick();
    };
  }

  private async makeOffer(p: RemotePeer, c: Conn): Promise<void> {
    if (p.conn !== c || c.dead || c.pc.signalingState === "closed") return;
    try {
      const offer = await c.pc.createOffer();
      if (p.conn !== c || c.dead) return;
      offer.sdp = mungeSdp(offer.sdp ?? "");
      await c.pc.setLocalDescription(offer);
      if (p.conn !== c || c.dead) return;
      this.send(p, { t: "sdp", gen: c.gen, d: { type: offer.type, sdp: offer.sdp } });
    } catch (err) {
      this.callbacks.onStatus(`Falha ao preparar a ligação com ${this.peerName(p)}: ${(err as Error).message ?? err}`);
      c.dead = true;
      this.kick();
    }
  }

  private reconcileConn(p: RemotePeer, now: number): void {
    if (mediaBlocked(p.slot)) {
      if (p.conn) this.dropConn(p, "sem caminho direto (teste)");
      return;
    }
    const c = p.conn;
    if (c) {
      const cs = c.pc.connectionState;
      if (c.dead || cs === "closed") {
        this.dropConn(p);
        p.nextConnAt = now + LOST_PEER_RETRY_MS;
      } else if (cs === "failed") {
        this.recoverConn(p, c, now, "ligação falhou");
      } else if (cs === "disconnected") {
        if (!c.disconnectedSince) c.disconnectedSince = now;
        else if (now - c.disconnectedSince > ICE_DISCONNECTED_GRACE_MS) this.recoverConn(p, c, now, "ligação interrompida");
      } else if (cs !== "connected") {
        c.disconnectedSince = 0;
        if (now - c.createdAt > PC_SETUP_TIMEOUT_MS) this.recoverConn(p, c, now, "ligação não completou");
      } else {
        c.disconnectedSince = 0;
        if (c.stalled) this.recoverConn(p, c, now, "áudio parou de chegar");
      }
      return;
    }
    if (this.mySlot > p.slot) {
      // Respondemos: quem oferece é a vaga menor. Se temos como falar com ele e nada
      // chega, pedimos que (re)faça a ligação.
      const sig = this.bootOpen(p) ? now - p.bootOpenAt > 3_000 : this.nostrOpen(p);
      if (sig && now - p.lastRestartAskAt > ASSIST_RETRY_MS && now >= p.nextConnAt) {
        p.lastRestartAskAt = now;
        this.send(p, { t: "restart", gen: 0 });
      }
      return;
    }
    if (now < p.nextConnAt) return;
    if (this.bootOpen(p) || this.nostrOpen(p)) {
      this.startPairConn(p, now);
    } else if (now >= p.nextAssistAt && this.helperFor(p)) {
      // Sinalização assistida: a oferta vai por um amigo em comum.
      p.nextAssistAt = now + ASSIST_RETRY_MS;
      this.startPairConn(p, now);
    }
  }

  private startPairConn(p: RemotePeer, now: number): void {
    // Geração única por sessão: uma oferta de uma sessão nova nunca é confundida com a
    // ligação antiga que o outro lado ainda não percebeu que morreu.
    p.connGen = this.genBase + ++this.genCounter;
    p.conn = this.createPairConn(p, p.connGen, now);
  }

  private recoverConn(p: RemotePeer, c: Conn, now: number, reason: string): void {
    if (c.offerer) {
      if (c.restarts < MAX_ICE_RESTARTS && now - c.lastRestartAt > ICE_RESTART_MIN_INTERVAL_MS) {
        c.restarts += 1;
        c.lastRestartAt = now;
        c.disconnectedSince = now;
        c.stalled = false;
        this.callbacks.onStatus(`${this.peerName(p)}: ${reason}; reiniciando o ICE.`);
        try {
          c.pc.restartIce();
        } catch {
          /* cai no refazer abaixo na próxima volta */
        }
        return;
      }
      this.callbacks.onStatus(`${this.peerName(p)}: ${reason}; refazendo a ligação.`);
      this.dropConn(p, undefined, /* failed */ true);
      p.nextConnAt = now + LOST_PEER_RETRY_MS;
      return;
    }
    if (now - p.lastRestartAskAt > ICE_RESTART_MIN_INTERVAL_MS) {
      p.lastRestartAskAt = now;
      c.disconnectedSince = now;
      c.stalled = false;
      this.send(p, { t: "restart", gen: c.gen });
    }
    if (c.pc.connectionState === "failed" && now - c.createdAt > PC_SETUP_TIMEOUT_MS * 2) {
      this.dropConn(p, undefined, /* failed */ true);
    }
  }

  private dropConn(p: RemotePeer, reason?: string, failed = false): void {
    const c = p.conn;
    if (!c) return;
    p.conn = null;
    this.closeConn(c);
    if (reason) this.callbacks.onStatus(`${this.peerName(p)}: ${reason}.`);
    if (failed && this.screen) this.adaptState.dropAt = Date.now();
    this.emitStreams(p);
  }

  private handleSdp(p: RemotePeer, msg: SdpMsg): void {
    if (mediaBlocked(p.slot)) return;
    const now = Date.now();
    if (msg.d.type === "offer") {
      if (this.mySlot < p.slot) return; // só a vaga maior responde
      let c = p.conn;
      if (!c || c.dead || msg.gen !== c.gen) {
        if (c) this.dropConn(p);
        p.connGen = msg.gen;
        c = this.newConn(msg.gen, /* offerer */ false, now);
        c.ctrl = c.pc.createDataChannel("ctrl", { negotiated: true, id: 0 });
        p.conn = c;
        this.wireCtrl(p, c);
        this.wirePairConn(p, c);
      }
      const conn = c;
      conn.queue = conn.queue
        .then(async () => {
          if (p.conn !== conn || conn.dead) return;
          await conn.pc.setRemoteDescription({ type: "offer", sdp: msg.d.sdp });
          if (p.conn !== conn || conn.dead) return;
          conn.remoteSet = true;
          for (const cand of conn.pendingIce) await conn.pc.addIceCandidate(cand).catch(() => {});
          conn.pendingIce = [];
          if (!conn.tx) {
            this.setTransceivers(conn);
            const tx: RTCRtpTransceiver[] = conn.tx ?? [];
            for (const t of tx) t.direction = "sendrecv";
            if (tx.length) applyCodecPreferences(tx);
          }
          this.syncConnTracks(conn, this.localTracks());
          const answer = await conn.pc.createAnswer();
          answer.sdp = mungeSdp(answer.sdp ?? "");
          await conn.pc.setLocalDescription(answer);
          if (p.conn !== conn || conn.dead) return;
          this.send(p, { t: "sdp", gen: conn.gen, d: { type: answer.type, sdp: answer.sdp } });
        })
        .catch((err) => {
          this.callbacks.onStatus(`Falha ao responder a ligação de ${this.peerName(p)}: ${(err as Error).message ?? err}`);
          conn.dead = true;
          this.kick();
        });
      return;
    }
    // Resposta à nossa oferta.
    const c = p.conn;
    if (!c || !c.offerer || msg.gen !== c.gen) return;
    c.queue = c.queue
      .then(async () => {
        if (p.conn !== c || c.dead || c.pc.signalingState !== "have-local-offer") return;
        await c.pc.setRemoteDescription({ type: "answer", sdp: msg.d.sdp });
        c.remoteSet = true;
        for (const cand of c.pendingIce) await c.pc.addIceCandidate(cand).catch(() => {});
        c.pendingIce = [];
      })
      .catch((err) => {
        this.callbacks.onStatus(`Falha ao completar a ligação com ${this.peerName(p)}: ${(err as Error).message ?? err}`);
        c.dead = true;
        this.kick();
      });
  }

  private handleIce(p: RemotePeer, msg: IceMsg): void {
    const c = p.conn;
    if (!c || msg.gen !== c.gen || !msg.c) return;
    this.addIce(c, msg.c);
  }

  private addIce(c: Conn, cand: RTCIceCandidateInit): void {
    if (!c.remoteSet) {
      if (c.pendingIce.length < 200) c.pendingIce.push(cand);
      return;
    }
    c.queue = c.queue.then(() => c.pc.addIceCandidate(cand).catch(() => {}));
  }

  private handleRestart(p: RemotePeer, msg: RestartMsg): void {
    if (this.mySlot > p.slot) return; // só quem oferece reinicia
    const now = Date.now();
    const c = p.conn;
    if (c && msg.gen === c.gen && c.pc.connectionState === "connected") {
      if (now - c.lastRestartAt > ICE_RESTART_MIN_INTERVAL_MS) {
        c.lastRestartAt = now;
        c.restarts += 1;
        try {
          c.pc.restartIce();
        } catch {
          /* ignora */
        }
      }
      return;
    }
    if (c && now - c.createdAt < PC_SETUP_TIMEOUT_MS) return; // ainda ligando
    this.dropConn(p);
    p.nextConnAt = 0;
    this.kick();
  }

  // ---------------------------------------------------------------------------
  // Mensagens
  // ---------------------------------------------------------------------------

  // Manda pelo melhor caminho: canal próprio, bootstrap do servidor, ou um amigo em
  // comum (mensagens de sinalização e estado; nunca uma "fwd" dentro de outra).
  private send(p: RemotePeer, msg: Msg): boolean {
    if (this.ctrlOpen(p)) {
      try {
        p.conn!.ctrl!.send(JSON.stringify(msg));
        return true;
      } catch {
        /* canal fechando */
      }
    }
    if (p.boot?.open) {
      try {
        void p.boot.send(msg);
        return true;
      } catch {
        /* canal fechando; o reconcile trata */
      }
    }
    if (msg.t === "fwd" || msg.t === "relay-lease" || msg.t === "relay-cancel" || msg.t === "rsdp" || msg.t === "rice" || msg.t === "rclose") {
      return false;
    }
    const helper = this.helperFor(p);
    if (helper && this.sendDirect(helper, { t: "fwd", to: p.slot, msg: msg as InnerMsg })) return true;
    if (this.nostr && this.nostrOpen(p)) {
      const now = Date.now();
      if (msg.t === "state") {
        if (now - p.nostrStateAt < NOSTR_STATE_MS) return true;
        p.nostrStateAt = now;
      }
      void this.nostr.send(p.slot, msg);
      return true;
    }
    return false;
  }

  private sendDirect(p: RemotePeer, msg: Msg): boolean {
    if (this.ctrlOpen(p)) {
      try {
        p.conn!.ctrl!.send(JSON.stringify(msg));
        return true;
      } catch {
        /* ignora */
      }
    }
    if (p.boot?.open) {
      try {
        void p.boot.send(msg);
        return true;
      } catch {
        /* ignora */
      }
    }
    return false;
  }

  // Ligação usável: já conectou alguma vez e não morreu. Uma queda transitória
  // ("disconnected") não troca a stream que a UI está tocando.
  private usable(c: Conn | null): c is Conn {
    if (!c || c.dead || !c.tx) return false;
    const cs = c.pc.connectionState;
    return cs === "connected" || (c.everConnected && cs !== "failed" && cs !== "closed");
  }

  private micIncoming(p: RemotePeer): Conn | null {
    if (this.usable(p.conn)) return p.conn;
    if (p.via !== null) {
      const r = p.relayIns.get(p.via) ?? null;
      if (this.usable(r)) return r;
    }
    for (const r of p.relayIns.values()) if (this.usable(r)) return r;
    return null;
  }

  private isRelayed(p: RemotePeer, c: Conn | null): boolean {
    return !!c && c !== p.conn;
  }

  private hearing(p: RemotePeer): boolean {
    const c = this.micIncoming(p);
    return !!c && !!c.tx && !c.tx[TX_MIC].receiver.track.muted && !c.stalled;
  }

  private seeing(p: RemotePeer): boolean {
    if (!p.state?.screen.active) return false;
    const c = this.screenIncoming(p);
    return !!c && !!c.tx && !c.tx[TX_SCREEN_V].receiver.track.muted;
  }

  // Por onde a tela de `p` chega: pelo distribuidor que o plano dele indica (se já entrega
  // quadros), senão pela ligação direta/ponte. A troca é sem buraco: o direto fica até o
  // distribuidor entregar.
  private screenIncoming(p: RemotePeer): Conn | null {
    const dist = this.plannedDistFor(p);
    if (dist !== null) {
      const d = p.distIns.get(dist) ?? null;
      if (this.usable(d) && !d.tx![TX_SCREEN_V].receiver.track.muted) return d;
    }
    return this.micIncoming(p);
  }

  private plannedDistFor(p: RemotePeer): number | null {
    const entry = p.state?.screen.plan?.find(([viewer]) => viewer === this.mySlot);
    return entry ? entry[1] : null;
  }

  private screenViaFor(p: RemotePeer): number {
    const c = this.screenIncoming(p);
    if (!c) return 0;
    for (const [dist, d] of p.distIns) if (d === c) return dist;
    return 0;
  }

  private distLoad(): number {
    let n = 0;
    for (const d of this.dists.values()) n += d.viewers.size;
    return n;
  }

  private sendState(p: RemotePeer): void {
    // links = com quem a ligação própria está de pé (serve para ponte e para levar
    // mensagens); roster = todos com quem há algum canal direto.
    const links: number[] = [];
    const roster: [number, string][] = [];
    for (const q of this.peers.values()) {
      if (!this.directOpen(q)) continue;
      if (this.ctrlOpen(q)) links.push(q.slot);
      roster.push([q.slot, this.peerName(q)]);
    }
    const vias: number[] = [];
    for (const q of this.peers.values()) if (q.via && !this.ctrlOpen(q) && this.micIncoming(q)) vias.push(q.slot);
    this.send(p, {
      t: "state",
      name: this.name,
      muted: this.muted,
      screen: this.screen
        ? {
            active: true,
            gen: this.screen.gen,
            audio: this.screen.stream.getAudioTracks().some((t) => t.enabled && t.readyState === "live"),
            ...(this.screenIsCamera ? { cam: true } : {}),
            ...(this.plan.size ? { plan: [...this.plan] } : {}),
          }
        : { active: false, gen: this.screenGen, audio: false },
      hears: this.hearing(p),
      sees: this.seeing(p),
      links,
      roster,
      vias,
      cap: this.cap,
      load: this.relays.size + this.distLoad(),
      capMax: this.capMax,
      screenVia: this.screenViaFor(p),
      auth: this.authFor(this.mySlot, p.slot),
      ...(p.conn && this.usable(p.conn) && p.conn.securityCode ? { sv: this.securityMac(p.conn.securityCode) } : {}),
      ver: VERSION,
      build: BUILD,
      kind: TARGET,
      ...(this.background ? { bg: true } : {}),
      ...(this.screen && p.conn?.encoderImpl
        ? {
            stx: {
              codec: p.conn.videoCodec?.split("/")[1] ?? p.conn.codecApplied ?? "",
              enc: p.conn.encoderImpl.slice(0, 80),
              hw: !!p.conn.encoderHw,
              w: p.conn.sendWidth ?? null,
              fps: p.conn.sendFps === null || p.conn.sendFps === undefined ? null : Math.round(p.conn.sendFps),
              qp: p.conn.sendQp ?? null,
              lim: p.conn.limitation,
            },
          }
        : {}),
    });
  }

  private broadcastState(): void {
    for (const p of this.peers.values()) {
      if (this.present(p)) this.sendState(p);
    }
  }

  private handleMessage(p: RemotePeer, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const now = Date.now();
    p.lastSeenAt = now;
    const msg = raw as Partial<Msg> & { t?: string };
    switch (msg.t) {
      case "state":
      case "need":
      case "sdp":
      case "ice":
      case "restart":
        this.handleInner(p, msg as Partial<InnerMsg>, now, p.slot);
        break;
      case "fwd":
        this.handleFwd(p, msg as Partial<FwdMsg>, now);
        break;
      case "relay-lease": {
        const target = (msg as Partial<RelayLeaseMsg>).target;
        if (!validSlot(target) || target === this.mySlot || target === p.slot) break;
        const key = pairKey(p.slot, target);
        let pair = this.relays.get(key);
        if (!pair && this.relays.size >= Math.max(1, this.capMax)) {
          // No limite: quem pediu procura outra ponte. (Sempre aceitamos ao menos uma:
          // pior qualidade é melhor do que deixar alguém isolado.)
          this.sendDirect(p, { t: "relay-busy", target });
          break;
        }
        if (!pair) {
          pair = { a: Math.min(p.slot, target), b: Math.max(p.slot, target), leaseUntil: 0, jobs: new Map(), nextAt: new Map() };
          this.relays.set(key, pair);
          this.callbacks.onStatus(
            `${this.peerName(p)} pediu ponte até ${this.peerName(this.getPeer(target))}: retransmitindo entre os dois.`,
          );
        }
        pair.leaseUntil = now + RELAY_LEASE_MS;
        break;
      }
      case "relay-cancel": {
        const target = (msg as Partial<RelayCancelMsg>).target;
        if (!validSlot(target)) break;
        const pair = this.relays.get(pairKey(p.slot, target));
        if (pair) {
          this.teardownRelay(pair);
          this.relays.delete(pairKey(p.slot, target));
        }
        break;
      }
      case "relay-busy": {
        const target = (msg as Partial<RelayBusyMsg>).target;
        if (!validSlot(target)) break;
        const t = this.getPeer(target);
        t.busyUntil.set(p.slot, now + BUSY_MS);
        if (t.via === p.slot && !this.micIncoming(t)) {
          t.via = null;
          t.leaseSentAt = 0;
          t.nextElectAt = 0;
          this.callbacks.onStatus(`${this.peerName(p)} está no limite como ponte; procurando outra para ${this.peerName(t)}.`);
        }
        break;
      }
      case "rsdp":
        this.handleRelaySdp(p, msg as Partial<RelaySdpMsg>, now);
        break;
      case "dist-lease": {
        const m = msg as Partial<DistLeaseMsg>;
        const viewers = Array.isArray(m.viewers) ? m.viewers.filter((v) => validSlot(v) && v !== this.mySlot && v !== p.slot) : [];
        let lease = this.dists.get(p.slot);
        if (!lease) {
          lease = { sharer: p.slot, leaseUntil: 0, viewers: new Set(), jobs: new Map(), nextAt: new Map(), gens: new Map() };
          this.dists.set(p.slot, lease);
          this.callbacks.onStatus(`ÁRVORE: ${this.peerName(p)} pediu que este PC repasse a tela dele para ${viewers.length} amigo(s).`);
        }
        lease.leaseUntil = now + DIST_LEASE_MS;
        lease.viewers = new Set(viewers);
        break;
      }
      case "dist-need": {
        const viewer = (msg as Partial<DistNeedMsg>).viewer;
        const lease = this.dists.get(p.slot);
        if (!validSlot(viewer) || !lease) break;
        const job = lease.jobs.get(viewer);
        if (job && now - job.createdAt >= PC_SETUP_TIMEOUT_MS) {
          this.closeConn(job);
          lease.jobs.delete(viewer);
          lease.nextAt.set(viewer, now + LOST_PEER_RETRY_MS);
        }
        break;
      }
      case "rice": {
        const m = msg as Partial<RelayIceMsg>;
        if (!validSlot(m.from) || !m.c) break;
        if (m.from === this.mySlot) break;
        const origin = this.getPeer(m.from);
        const c = origin.relayIns.get(p.slot);
        if (c && c.gen === m.gen) this.addIce(c, m.c);
        const dc = origin.distIns.get(p.slot);
        if (dc && dc.gen === m.gen) this.addIce(dc, m.c);
        // Do outro lado: candidato do destino para uma retransmissão nossa.
        const pair = this.relayPairWith(p.slot, m.from);
        const job = pair?.jobs.get(jobKey(m.from, p.slot));
        if (job && job.gen === m.gen) this.addIce(job, m.c);
        const dj = this.dists.get(m.from)?.jobs.get(p.slot);
        if (dj && dj.gen === m.gen) this.addIce(dj, m.c);
        break;
      }
      case "rclose": {
        const m = msg as Partial<RelayCloseMsg>;
        if (!validSlot(m.from)) break;
        const origin = this.getPeer(m.from);
        const r = origin.relayIns.get(p.slot);
        if (r) {
          this.closeConn(r);
          origin.relayIns.delete(p.slot);
        }
        const dr = origin.distIns.get(p.slot);
        if (dr) {
          this.closeConn(dr);
          origin.distIns.delete(p.slot);
        }
        if (r || dr) this.emitStreams(origin);
        break;
      }
    }
  }

  private handleInner(p: RemotePeer, msg: Partial<InnerMsg>, now: number, fromSlot: number): void {
    switch (msg.t) {
      case "state": {
        const m = msg as Partial<StateMsg>;
        if (String(m.auth ?? "") !== this.authFor(p.slot, this.mySlot)) {
          this.rejectPeer(p, now);
          break;
        }
        p.authed = true;
        const prev = p.state;
        p.state = {
          t: "state",
          name: String(m.name ?? "").slice(0, 40),
          muted: !!m.muted,
          screen: {
            active: !!m.screen?.active,
            gen: Number(m.screen?.gen) || 0,
            audio: !!m.screen?.audio,
            cam: m.screen?.cam === true,
            plan: Array.isArray(m.screen?.plan)
              ? m.screen.plan
                  .filter((e): e is [number, number] => Array.isArray(e) && validSlot(e[0]) && validSlot(e[1]))
                  .slice(0, MAX_SLOTS)
              : undefined,
          },
          hears: !!m.hears,
          sees: !!m.sees,
          links: Array.isArray(m.links) ? m.links.filter(validSlot).slice(0, MAX_SLOTS) : [],
          roster: Array.isArray(m.roster)
            ? m.roster
                .filter((e): e is [number, string] => Array.isArray(e) && validSlot(e[0]))
                .map(([s, n]) => [s, String(n ?? "").slice(0, 40)] as [number, string])
                .slice(0, MAX_SLOTS)
            : [],
          vias: Array.isArray(m.vias) ? m.vias.filter(validSlot).slice(0, MAX_SLOTS) : [],
          cap: Math.max(0, Math.min(100, Number(m.cap) || 0)),
          load: Math.max(0, Math.min(MAX_SLOTS, Number(m.load) || 0)),
          capMax: Math.max(0, Math.min(MAX_SLOTS, Number(m.capMax) || 0)),
          screenVia: validSlot(m.screenVia) ? m.screenVia : 0,
          auth: "",
          ver: typeof m.ver === "string" ? m.ver.slice(0, 20) : undefined,
          build: typeof m.build === "string" ? m.build.slice(0, 16) : undefined,
          kind: m.kind === "web" ? "web" : m.kind === "app" ? "app" : undefined,
          bg: m.bg === true,
          sv: typeof m.sv === "string" ? m.sv.slice(0, 32) : undefined,
          stx:
            m.stx && typeof m.stx === "object"
              ? {
                  codec: String(m.stx.codec ?? "").slice(0, 12),
                  enc: String(m.stx.enc ?? "").slice(0, 80),
                  hw: m.stx.hw === true,
                  w: Number.isFinite(Number(m.stx.w)) ? Number(m.stx.w) : null,
                  fps: Number.isFinite(Number(m.stx.fps)) ? Number(m.stx.fps) : null,
                  qp: Number.isFinite(Number(m.stx.qp)) ? Number(m.stx.qp) : null,
                  lim: typeof m.stx.lim === "string" ? m.stx.lim.slice(0, 12) : null,
                }
              : undefined,
        };
        const s = p.state.screen;
        if (s.active && (!prev?.screen.active || prev.screen.gen !== s.gen)) {
          p.screenActiveSince = now;
        }
        if (!prev) this.callbacks.onStatus(`${p.state.name || `Amigo ${p.slot}`} entrou${p.via && !this.directOpen(p) ? " (pela ponte)" : ""}.`);
        break;
      }
      case "need": {
        const kind = (msg as Partial<NeedMsg>).kind;
        if (kind !== "mic" && kind !== "screen") break;
        if (kind === "screen" && this.plan.has(p.slot)) {
          // Este espectador recebe a nossa tela por um distribuidor: é ele quem refaz.
          const dist = this.peers.get(this.plan.get(p.slot)!);
          if (dist && this.directOpen(dist)) this.sendDirect(dist, { t: "dist-need", viewer: p.slot });
        }
        const c = p.conn;
        if (!c || c.dead) break;
        // Reaplica os tracks; se a ligação estiver de pé mas nada chega, reinicia o ICE.
        this.syncConnTracks(c, this.localTracks());
        if (kind === "mic" && c.pc.connectionState === "connected" && now - c.createdAt > PC_SETUP_TIMEOUT_MS) {
          this.recoverConn(p, c, now, "o outro lado não recebe o áudio");
        }
        break;
      }
      case "sdp": {
        const m = msg as Partial<SdpMsg>;
        if (!p.authed) break;
        if (!m.d || typeof m.d.sdp !== "string" || (m.d.type !== "offer" && m.d.type !== "answer")) break;
        if (!Number.isInteger(m.gen) || (m.gen as number) < 1 || m.d.sdp.length > MAX_MSG_BYTES) break;
        this.handleSdp(p, { t: "sdp", gen: m.gen as number, d: { type: m.d.type, sdp: m.d.sdp } });
        break;
      }
      case "ice": {
        const m = msg as Partial<IceMsg>;
        if (!m.c || typeof m.c !== "object" || !Number.isInteger(m.gen)) break;
        this.handleIce(p, { t: "ice", gen: m.gen as number, c: m.c });
        break;
      }
      case "restart": {
        const m = msg as Partial<RestartMsg>;
        this.handleRestart(p, { t: "restart", gen: Number(m.gen) || 0 });
        break;
      }
    }
    void fromSlot;
  }

  // Senha errada (ou versão incompatível): não aceitamos nada deste participante por um
  // tempo, e avisamos uma vez.
  private rejectPeer(p: RemotePeer, now: number): void {
    if (now - p.authBadAt > 60_000) {
      this.callbacks.onStatus(`Participante ${p.slot} recusado: senha da sala diferente (ou versão antiga do NitroCall).`);
      this.callbacks.onAuthMismatch?.(p.slot);
    }
    p.authBadAt = now;
    p.authed = false;
    this.peerLost(p, "senha diferente", /* quiet */ true);
    p.nextBootAt = now + 30_000;
    p.nextConnAt = now + 30_000;
  }

  private handleFwd(p: RemotePeer, msg: Partial<FwdMsg>, now: number): void {
    const inner = msg.msg;
    if (!inner || typeof inner !== "object") return;
    if (validSlot(msg.to)) {
      if (msg.to === this.mySlot) return;
      // Somos o intermediário entre p e msg.to.
      if (inner.t === "need") {
        // Pedido de refazer uma retransmissão nossa (to não recebe a mídia de p... ou seja,
        // p não recebe a mídia de msg.to que passa por nós).
        const pair = this.relays.get(pairKey(p.slot, msg.to));
        const job = pair?.jobs.get(jobKey(msg.to, p.slot));
        if (pair && job && now - job.createdAt >= PC_SETUP_TIMEOUT_MS) {
          this.closeConn(job);
          pair.jobs.delete(jobKey(msg.to, p.slot));
          pair.nextAt.set(jobKey(msg.to, p.slot), now + LOST_PEER_RETRY_MS);
        }
        return;
      }
      const target = this.peers.get(msg.to);
      if (target && this.directOpen(target)) this.sendDirect(target, { t: "fwd", from: p.slot, msg: inner });
      return;
    }
    if (validSlot(msg.from) && msg.from !== this.mySlot) {
      // Mensagem de msg.from entregue por p.
      const origin = this.getPeer(msg.from);
      if (directBlocked(origin.slot) && inner.t !== "state") return;
      if (!this.directOpen(origin) && !origin.via && (inner.t === "state" || inner.t === "need")) {
        // Estado chegando por alguém: esse alguém é a ponte que nos serve.
        origin.via = p.slot;
      }
      origin.lastSeenAt = now;
      this.handleInner(origin, inner as Partial<InnerMsg>, now, p.slot);
    }
  }

  private peerLost(p: RemotePeer, reason: string, quiet = false): void {
    const wasPresent = this.present(p) || !!p.state;
    const name = this.peerName(p);
    if (p.boot) {
      this.ignoredConns.add(p.boot);
      p.boot.close();
      p.boot = null;
    }
    if (p.pendingBoot) {
      this.ignoredConns.add(p.pendingBoot.conn);
      p.pendingBoot.conn.close();
      p.pendingBoot = null;
    }
    if (p.conn) {
      this.closeConn(p.conn);
      p.conn = null;
    }
    for (const r of p.relayIns.values()) this.closeConn(r);
    p.relayIns.clear();
    for (const r of p.distIns.values()) this.closeConn(r);
    p.distIns.clear();
    this.plan.delete(p.slot);
    for (const [sharer, lease] of this.dists) {
      if (sharer === p.slot) {
        this.teardownDist(lease);
        this.dists.delete(sharer);
      } else if (lease.jobs.has(p.slot)) {
        this.closeConn(lease.jobs.get(p.slot)!);
        lease.jobs.delete(p.slot);
      }
    }
    p.state = null;
    p.via = null;
    p.viaPrev = null;
    p.betterCount = 0;
    p.authed = false;
    p.nostrSeenAt = 0;
    p.bootFailures = 0;
    p.firstBootAt = 0;
    p.nextBootAt = Date.now() + LOST_PEER_RETRY_MS;
    p.nextConnAt = Date.now() + LOST_PEER_RETRY_MS;
    // Quem dependia desta pessoa como ponte também fica sem caminho.
    for (const q of this.peers.values()) {
      if (q.via === p.slot) this.relayLost(q, `a ponte (${name}) saiu`, quiet);
    }
    for (const [key, pair] of this.relays) {
      if (pair.a === p.slot || pair.b === p.slot) {
        this.teardownRelay(pair);
        this.relays.delete(key);
      }
    }
    this.emitStreams(p);
    if (wasPresent || p.lastView) {
      p.lastView = "";
      this.callbacks.onPeerRemoved(p.slot, name, quiet ? "reset" : "left");
      if (!quiet) this.callbacks.onStatus(`${name} saiu (${reason}).`);
    }
  }

  private relayLost(p: RemotePeer, reason: string, quiet = false): void {
    if (!p.via) return;
    const name = this.peerName(p);
    this.cancelLease(p);
    if (!this.directOpen(p)) p.state = null;
    p.nextRelayAt = Date.now() + RELAY_RETRY_MS;
    this.emitStreams(p);
    if (!this.directOpen(p)) {
      p.lastView = "";
      this.callbacks.onPeerRemoved(p.slot, name, quiet ? "reset" : "left");
      if (!quiet) this.callbacks.onStatus(`${name} ficou fora de alcance (${reason}).`);
    }
  }

  // ---------------------------------------------------------------------------
  // Ponte automática (quando dois participantes não se alcançam direto)
  // ---------------------------------------------------------------------------

  private cancelLease(p: RemotePeer): void {
    for (const via of [p.via, p.viaPrev]) {
      if (via === null) continue;
      const bridge = this.peers.get(via);
      if (bridge && this.directOpen(bridge) && this.mySlot < p.slot) this.sendDirect(bridge, { t: "relay-cancel", target: p.slot });
    }
    p.via = null;
    p.viaPrev = null;
    p.leaseSentAt = 0;
    p.betterCount = 0;
    for (const r of p.relayIns.values()) this.closeConn(r);
    p.relayIns.clear();
    this.emitStreams(p);
  }

  // Fim de uma troca de ponte: a antiga é dispensada quando a nova já entrega áudio (ou
  // quando o prazo acaba).
  private settleViaPrev(p: RemotePeer, now: number): void {
    if (p.viaPrev === null) return;
    const next = p.via !== null ? (p.relayIns.get(p.via) ?? null) : null;
    if (!(this.usable(next) && !next.tx![TX_MIC].receiver.track.muted) && now < p.viaPrevUntil) return;
    const old = p.viaPrev;
    p.viaPrev = null;
    const bridge = this.peers.get(old);
    if (bridge && this.directOpen(bridge) && this.mySlot < p.slot) this.sendDirect(bridge, { t: "relay-cancel", target: p.slot });
    const r = p.relayIns.get(old);
    if (r) {
      this.closeConn(r);
      p.relayIns.delete(old);
    }
    this.emitStreams(p);
    this.callbacks.onStatus(`TROCA concluída: ${this.peerName(p)} agora chega por ${p.via !== null ? this.peerName(this.getPeer(p.via)) : "caminho direto"}.`);
  }

  // A vaga de número menor do par escolhe a ponte e renova o "aluguel" a cada 2s; a
  // maior só aceita o que chega. Candidata = quem tem ligação própria comigo e, pela
  // fofoca, com o outro. Escolha por score (capacidade − carga), com histerese: só
  // trocamos se outra for claramente melhor por várias avaliações seguidas, e a antiga
  // fica até a nova entregar áudio.
  private reconcileRelayChoice(p: RemotePeer, now: number): void {
    if (this.ctrlOpen(p)) return;
    if (this.mySlot > p.slot) return;
    if (!p.via && this.directOpen(p)) return;
    if (!p.firstBootAt || now - p.firstBootAt < RELAY_AFTER_MS || now < p.nextRelayAt) return;
    this.settleViaPrev(p, now);
    if (p.via !== null && now - p.leaseSentAt >= RELAY_LEASE_SEND_MS) {
      const cur = this.peers.get(p.via);
      if (cur) this.sendDirect(cur, { t: "relay-lease", target: p.slot });
      p.leaseSentAt = now;
    }
    if (now < p.nextElectAt) return;
    p.nextElectAt = now + ELECT_INTERVAL_MS;
    const score = (q: RemotePeer) => (q.state?.cap ?? 0) - 10 * (q.state?.load ?? 0);
    let best: RemotePeer | null = null;
    let bestAny: RemotePeer | null = null;
    let current: RemotePeer | null = null;
    for (const q of this.peers.values()) {
      if (!this.realDirect(q) || !q.state?.links.includes(p.slot)) continue;
      if (q.slot === p.via) current = q;
      if ((p.busyUntil.get(q.slot) ?? 0) > now && q.slot !== p.via) continue;
      const eligible = q.state.cap >= CAP_BRIDGE_MIN && (q.state.load < q.state.capMax || q.slot === p.via);
      if (!bestAny || score(q) > score(bestAny) || (score(q) === score(bestAny) && q.slot < bestAny.slot)) bestAny = q;
      if (eligible && (!best || score(q) > score(best) || (score(q) === score(best) && q.slot < best.slot))) best = q;
    }
    const choice = best ?? bestAny;
    if (!choice) {
      if (p.via !== null) this.relayLost(p, "ninguém mais fala com esse participante");
      return;
    }
    if (p.via === null) {
      p.via = choice.slot;
      p.lastSeenAt = now;
      p.betterCount = 0;
      this.sendDirect(choice, { t: "relay-lease", target: p.slot });
      p.leaseSentAt = now;
      this.callbacks.onStatus(
        `ELEIÇÃO: sem caminho direto até ${this.peerName(p)}; ponte = ${this.peerName(choice)} (score ${score(choice)}` +
          `${best ? "" : ", abaixo do mínimo, mas é quem alcança os dois"}).`,
      );
      return;
    }
    if (choice.slot === p.via) {
      p.betterCount = 0;
      return;
    }
    const curScore = current ? score(current) : -1000;
    const curBad = !current || (current.state?.cap ?? 0) < CAP_BRIDGE_MIN;
    if (!curBad && score(choice) < curScore + SWITCH_MARGIN) {
      p.betterCount = 0;
      return;
    }
    p.betterCount += 1;
    if (!curBad && p.betterCount < SWITCH_CONFIRMS) return;
    // Troca: a nova ponte entra em paralelo; a antiga é dispensada em settleViaPrev.
    if (p.viaPrev !== null && p.viaPrev !== choice.slot) {
      const r = p.relayIns.get(p.viaPrev);
      if (r) {
        this.closeConn(r);
        p.relayIns.delete(p.viaPrev);
      }
      const old = this.peers.get(p.viaPrev);
      if (old && this.directOpen(old)) this.sendDirect(old, { t: "relay-cancel", target: p.slot });
    }
    p.viaPrev = p.via;
    p.viaPrevUntil = now + VIA_PREV_MS;
    p.via = choice.slot;
    p.betterCount = 0;
    p.lastSeenAt = now;
    this.sendDirect(choice, { t: "relay-lease", target: p.slot });
    p.leaseSentAt = now;
    this.callbacks.onStatus(
      `TROCA: ponte para ${this.peerName(p)} ${current ? this.peerName(current) : "?"} (score ${curScore}) → ` +
        `${this.peerName(choice)} (score ${score(choice)})${curBad ? ", a atual perdeu capacidade" : ""}.`,
    );
  }

  private relayPairWith(x: number, y: number): RelayPair | null {
    return this.relays.get(pairKey(x, y)) ?? null;
  }

  private reconcileRelays(now: number): void {
    const bridging: [string, string][] = [];
    for (const [key, pair] of this.relays) {
      const pa = this.peers.get(pair.a);
      const pb = this.peers.get(pair.b);
      const directBetween = !!pa?.state?.links.includes(pair.b) || !!pb?.state?.links.includes(pair.a);
      if (pair.leaseUntil <= now || !pa || !pb || !this.directOpen(pa) || !this.directOpen(pb) || directBetween) {
        this.teardownRelay(pair);
        this.relays.delete(key);
        continue;
      }
      this.ensureRelayJob(pair, pa, pb, now);
      this.ensureRelayJob(pair, pb, pa, now);
      bridging.push([this.peerName(pa), this.peerName(pb)]);
    }
    const key = JSON.stringify(bridging);
    if (key !== this.lastBridging) {
      this.lastBridging = key;
      this.callbacks.onBridging(bridging);
    }
  }

  // Encaminha a mídia que recebemos de `from` para `to`: uma ligação nossa (forma fixa)
  // com os tracks recebidos de `from` como fonte. O Chromium decodifica e recodifica —
  // custa CPU e upload de quem faz a ponte, mas não exige servidor.
  private ensureRelayJob(pair: RelayPair, from: RemotePeer, to: RemotePeer, now: number): void {
    const key = jobKey(from.slot, to.slot);
    const src = from.conn && !from.conn.dead && from.conn.tx ? from.conn : null;
    let job = pair.jobs.get(key) ?? null;
    if (job) {
      const cs = job.pc.connectionState;
      const dead =
        job.dead ||
        cs === "failed" ||
        cs === "closed" ||
        (cs !== "connected" && now - job.createdAt > PC_SETUP_TIMEOUT_MS) ||
        (cs === "disconnected" && job.disconnectedSince && now - job.disconnectedSince > ICE_DISCONNECTED_GRACE_MS);
      if (cs === "disconnected" && !job.disconnectedSince) job.disconnectedSince = now;
      if (cs === "connected") job.disconnectedSince = 0;
      if (dead) {
        this.closeConn(job);
        pair.jobs.delete(key);
        pair.nextAt.set(key, now + LOST_PEER_RETRY_MS);
        this.sendDirect(to, { t: "rclose", from: from.slot });
        job = null;
      }
    }
    if (!src) return;
    const tracks = [src.tx![TX_MIC].receiver.track, src.tx![TX_SCREEN_V].receiver.track, src.tx![TX_SCREEN_A].receiver.track];
    if (job) {
      this.syncConnTracks(job, tracks);
      this.ensureCap(job, RELAY_SCREEN_CAP);
      return;
    }
    if (now < (pair.nextAt.get(key) ?? 0)) return;
    const c = this.newConn((pair.nextAt.get(`${key}#gen`) ?? 0) + 1, /* offerer */ true, now);
    pair.nextAt.set(`${key}#gen`, c.gen);
    for (const track of tracks) c.pc.addTransceiver(track, { direction: "sendonly" });
    this.setTransceivers(c);
    if (c.tx) applyCodecPreferences(c.tx);
    c.screenPrep = "done";
    void this.prepareScreenSender(c);
    c.pc.onicecandidate = (ev) => {
      if (pair.jobs.get(key) !== c || c.dead || !ev.candidate) return;
      this.sendDirect(to, { t: "rice", from: from.slot, gen: c.gen, c: ev.candidate.toJSON() });
    };
    c.pc.onconnectionstatechange = () => this.kick();
    c.pc.onnegotiationneeded = () => {
      c.queue = c.queue
        .then(async () => {
          if (pair.jobs.get(key) !== c || c.dead) return;
          const offer = await c.pc.createOffer();
          offer.sdp = mungeSdp(offer.sdp ?? "");
          await c.pc.setLocalDescription(offer);
          if (pair.jobs.get(key) !== c || c.dead) return;
          this.sendDirect(to, { t: "rsdp", from: from.slot, gen: c.gen, d: { type: offer.type, sdp: offer.sdp } });
        })
        .catch(() => {
          c.dead = true;
        });
    };
    pair.jobs.set(key, c);
  }

  private teardownRelay(pair: RelayPair): void {
    for (const [key, job] of pair.jobs) {
      this.closeConn(job);
      const to = Number(key.split(">")[1]);
      const from = Number(key.split(">")[0]);
      const target = this.peers.get(to);
      if (target) this.sendDirect(target, { t: "rclose", from });
    }
    pair.jobs.clear();
  }

  // Lado do destino: a ponte `p` nos oferece (ou responde sobre) a mídia de `from`.
  private handleRelaySdp(p: RemotePeer, msg: Partial<RelaySdpMsg>, now: number): void {
    if (!validSlot(msg.from) || msg.from === this.mySlot || !msg.d || typeof msg.d.sdp !== "string") return;
    if (!Number.isInteger(msg.gen) || msg.d.sdp.length > MAX_MSG_BYTES) return;
    const gen = msg.gen as number;
    const from = msg.from;
    if (msg.d.type === "answer") {
      const pair = this.relayPairWith(p.slot, from);
      let job = pair?.jobs.get(jobKey(from, p.slot)) ?? null;
      if (!job || job.gen !== gen) job = this.dists.get(from)?.jobs.get(p.slot) ?? null;
      if (!job || job.gen !== gen) return;
      job.queue = job.queue
        .then(async () => {
          if (job.dead || job.pc.signalingState !== "have-local-offer") return;
          await job.pc.setRemoteDescription({ type: "answer", sdp: msg.d!.sdp });
          job.remoteSet = true;
          for (const cand of job.pendingIce) await job.pc.addIceCandidate(cand).catch(() => {});
          job.pendingIce = [];
        })
        .catch(() => {
          job.dead = true;
        });
      return;
    }
    if (msg.d.type !== "offer") return;
    const origin = this.getPeer(from);
    if (msg.k === "screen") {
      this.handleDistOffer(p, origin, gen, msg.d.sdp, now);
      return;
    }
    if (this.ctrlOpen(origin)) return; // já temos caminho direto; a ponte vai expirar
    if (this.mySlot < origin.slot) {
      // Nós escolhemos a ponte: só aceitamos a atual ou a anterior (durante a troca).
      if (origin.via !== p.slot && origin.viaPrev !== p.slot) return;
    } else if (origin.via !== p.slot) {
      // A vaga menor trocou de ponte: a nova entra em paralelo e a antiga sai quando a
      // nova entregar áudio.
      if (origin.via !== null) {
        origin.viaPrev = origin.via;
        origin.viaPrevUntil = now + VIA_PREV_MS;
      }
      origin.via = p.slot;
    }
    origin.lastSeenAt = Math.max(origin.lastSeenAt, now);
    let c = origin.relayIns.get(p.slot) ?? null;
    if (!c || c.gen !== gen || c.dead) {
      if (c) this.closeConn(c);
      c = this.newConn(gen, /* offerer */ false, now);
      origin.relayIns.set(p.slot, c);
      const conn = c;
      conn.pc.onicecandidate = (ev) => {
        if (origin.relayIns.get(p.slot) !== conn || conn.dead || !ev.candidate) return;
        this.sendDirect(p, { t: "rice", from, gen, c: ev.candidate.toJSON() });
      };
      conn.pc.onconnectionstatechange = () => {
        if (conn.pc.connectionState === "connected") conn.everConnected = true;
        this.kick();
      };
    }
    const conn = c;
    conn.queue = conn.queue
      .then(async () => {
        if (origin.relayIns.get(p.slot) !== conn || conn.dead) return;
        await conn.pc.setRemoteDescription({ type: "offer", sdp: msg.d!.sdp });
        if (!conn.tx) this.setTransceivers(conn);
        const answer = await conn.pc.createAnswer();
        answer.sdp = mungeSdp(answer.sdp ?? "");
        await conn.pc.setLocalDescription(answer);
        conn.remoteSet = true;
        for (const cand of conn.pendingIce) await conn.pc.addIceCandidate(cand).catch(() => {});
        conn.pendingIce = [];
        if (origin.relayIns.get(p.slot) !== conn || conn.dead) return;
        this.sendDirect(p, { t: "rsdp", from, gen, d: { type: answer.type, sdp: answer.sdp } });
      })
      .catch(() => {
        conn.dead = true;
      });
  }

  // ---------------------------------------------------------------------------
  // Mídia: o que mostrar ao usuário e o que pedir ao outro lado
  // ---------------------------------------------------------------------------

  // Lado do espectador: o distribuidor `p` nos oferece a tela de `origin`.
  private handleDistOffer(p: RemotePeer, origin: RemotePeer, gen: number, sdp: string, now: number): void {
    if (!this.directOpen(p)) return;
    let c = origin.distIns.get(p.slot) ?? null;
    if (!c || c.gen !== gen || c.dead) {
      if (c) this.closeConn(c);
      c = this.newConn(gen, /* offerer */ false, now);
      origin.distIns.set(p.slot, c);
      const conn = c;
      conn.pc.onicecandidate = (ev) => {
        if (origin.distIns.get(p.slot) !== conn || conn.dead || !ev.candidate) return;
        this.sendDirect(p, { t: "rice", from: origin.slot, gen, c: ev.candidate.toJSON() });
      };
      conn.pc.onconnectionstatechange = () => {
        if (conn.pc.connectionState === "connected") conn.everConnected = true;
        this.kick();
      };
    }
    const conn = c;
    conn.queue = conn.queue
      .then(async () => {
        if (origin.distIns.get(p.slot) !== conn || conn.dead) return;
        await conn.pc.setRemoteDescription({ type: "offer", sdp });
        if (!conn.tx) this.setTransceivers(conn);
        const answer = await conn.pc.createAnswer();
        answer.sdp = mungeSdp(answer.sdp ?? "");
        await conn.pc.setLocalDescription(answer);
        conn.remoteSet = true;
        for (const cand of conn.pendingIce) await conn.pc.addIceCandidate(cand).catch(() => {});
        conn.pendingIce = [];
        if (origin.distIns.get(p.slot) !== conn || conn.dead) return;
        this.sendDirect(p, { t: "rsdp", from: origin.slot, gen, k: "screen", d: { type: answer.type, sdp: answer.sdp } });
      })
      .catch(() => {
        conn.dead = true;
      });
  }

  private reconcileMedia(p: RemotePeer, now: number): void {
    if (p.conn) {
      this.syncConnTracks(p.conn, this.localTracksFor(p));
      if (this.screen) this.ensureCap(p.conn, this.levelCap());
    }
    const planned = this.plannedDistFor(p);
    for (const [dist, d] of p.distIns) {
      const cs = d.pc.connectionState;
      const broken = d.dead || cs === "failed" || cs === "closed" || (cs !== "connected" && !d.everConnected && now - d.createdAt > PC_SETUP_TIMEOUT_MS);
      if (broken || dist !== planned || !p.state?.screen.active) {
        this.closeConn(d);
        p.distIns.delete(dist);
      }
    }
    for (const [via, r] of p.relayIns) {
      const cs = r.pc.connectionState;
      const stale = via !== p.via && via !== p.viaPrev;
      const broken = r.dead || cs === "failed" || cs === "closed" || (cs !== "connected" && !r.everConnected && now - r.createdAt > PC_SETUP_TIMEOUT_MS);
      if (broken || stale) {
        this.closeConn(r);
        p.relayIns.delete(via);
      }
    }
    if (this.mySlot > p.slot) this.settleViaPrev(p, now);
    this.emitStreams(p);
    // Pedidos: "não estou recebendo" (só com a ligação de pé há tempo e nada chegando).
    const c = this.micIncoming(p);
    if (c && !p.state?.muted && now - c.createdAt > PC_SETUP_TIMEOUT_MS && now - p.lastNeedMicAt > NEED_REQUEST_INTERVAL_MS) {
      if (c.tx![TX_MIC].receiver.track.muted || c.stalled) {
        this.send(p, { t: "need", kind: "mic" });
        p.lastNeedMicAt = now;
      }
    }
    const want = p.state?.screen;
    const sc = this.screenIncoming(p);
    if (want?.active && now - p.screenActiveSince > SCREEN_WAIT_BEFORE_ASK_MS && now - p.lastNeedScreenAt > NEED_REQUEST_INTERVAL_MS) {
      if (!sc || sc.tx![TX_SCREEN_V].receiver.track.muted) {
        if (now - p.screenActiveSince > SCREEN_WAIT_BEFORE_ASK_MS * 2) {
          this.send(p, { t: "need", kind: "screen" });
          p.lastNeedScreenAt = now;
        }
      }
    }
  }

  // Entrega à UI as streams certas (direto tem prioridade sobre a ponte).
  private emitStreams(p: RemotePeer): void {
    const c = this.micIncoming(p);
    const mic = c?.micStream ?? null;
    if (mic !== p.micEmitted) {
      p.micEmitted = mic;
      this.callbacks.onRemoteAudio(p.slot, mic);
      if (mic) this.callbacks.onStatus(`Áudio de ${this.peerName(p)} conectado${this.isRelayed(p, c) ? " (pela ponte)" : ""}.`);
    }
    const sc = p.state?.screen.active ? this.screenIncoming(p) : null;
    const screen = sc?.screenStream ?? null;
    if (screen !== p.screenEmitted) {
      p.screenEmitted = screen;
      this.callbacks.onRemoteScreen(p.slot, screen);
      if (screen) {
        const via = this.screenViaFor(p);
        this.callbacks.onStatus(
          `Tela de ${this.peerName(p)} recebida${via ? ` (pelo distribuidor ${this.peerName(this.getPeer(via))})` : this.isRelayed(p, sc) ? " (pela ponte)" : ""}.`,
        );
      }
    }
  }

  private emitView(p: RemotePeer, now: number): void {
    let presence: PeerView["presence"];
    if (this.directOpen(p)) presence = "direct";
    else if (p.via) presence = "relay";
    else if (this.gossipName(p.slot) !== null) presence = "searching";
    else if (p.occupiedAt && now - p.occupiedAt < OCCUPIED_SHOW_MS && now - p.authBadAt > 60_000) presence = "searching";
    else {
      if (p.lastView) {
        p.lastView = "";
        this.callbacks.onPeerRemoved(p.slot, this.peerName(p), "reset");
      }
      return;
    }
    const c = this.micIncoming(p);
    const live = p.conn && !p.conn.dead ? p.conn : (p.via !== null ? p.relayIns.get(p.via) : undefined) ?? null;
    const cs = live?.pc.connectionState;
    let audio: PeerView["audio"];
    if (c && this.hearing(p)) audio = "ok";
    else if (c && now - c.createdAt <= PC_SETUP_TIMEOUT_MS) audio = "connecting";
    else if (!live || cs === "connecting" || cs === "new") audio = "connecting";
    else audio = "degraded";
    const sharing = presence !== "searching" && !!p.state?.screen.active;
    let screen: PeerView["screen"];
    if (!sharing) screen = "none";
    else if (this.seeing(p)) screen = "ok";
    else if (!c || now - p.screenActiveSince <= PC_SETUP_TIMEOUT_MS) screen = "waiting";
    else screen = "degraded";
    const bridge = p.via ? this.peers.get(p.via) : null;
    const screenVia = sharing ? this.screenViaFor(p) : 0;
    const view: PeerView = {
      slot: p.slot,
      name: this.peerName(p),
      muted: p.state?.muted ?? false,
      sharing,
      screenAudio: sharing && (p.state?.screen.audio ?? false),
      screenCamera: sharing && (p.state?.screen.cam ?? false),
      away: p.state?.bg ?? false,
      hearsYou: p.state?.hears ?? false,
      seesYourScreen: p.state?.sees ?? false,
      presence,
      unnamed: !p.state?.name && this.gossipName(p.slot) === null,
      via: presence === "relay" ? p.via : null,
      viaName: presence === "relay" && bridge ? this.peerName(bridge) : null,
      screenVia: screenVia || null,
      screenViaName: screenVia ? this.peerName(this.getPeer(screenVia)) : null,
      bridging: (p.state?.load ?? 0) > 0,
      cap: p.state?.cap ?? 0,
      audio,
      screen,
      turn: !!live?.viaTurn,
      rttMs: c?.rttMs ?? null,
      lossPct: c?.lossPct ?? null,
      jitterMs: c?.jitterMs ?? null,
      securityCode: p.conn && this.usable(p.conn) ? p.conn.securityCode : null,
      verified: this.verification(p),
      app: p.state?.ver ? { ver: p.state.ver, build: p.state.build ?? "", kind: p.state.kind ?? "app" } : null,
    };
    const key = JSON.stringify(view);
    if (key === p.lastView) return;
    p.lastView = key;
    this.callbacks.onPeerUpdate(view);
  }

  private emitShareStatus(): void {
    let key = "";
    let status: ShareStatus | null = null;
    if (this.screen) {
      let total = 0;
      let seen = 0;
      for (const p of this.peers.values()) {
        if (!this.present(p)) continue;
        total += 1;
        if (p.state?.sees) seen += 1;
      }
      status = { seen, total };
      key = `${seen}/${total}`;
    }
    if (key === this.lastShareStatus) return;
    this.lastShareStatus = key;
    this.callbacks.onShareStatus(status);
  }

  // ---------------------------------------------------------------------------
  // Estatísticas (a cada 3s): qualidade, áudio parado, ajuste da tela
  // ---------------------------------------------------------------------------

  private async sampleStats(): Promise<void> {
    if (this.left) return;
    for (const pair of this.relays.values()) {
      for (const job of pair.jobs.values()) await this.sampleConn(job, null, /* outgoingOnly */ true);
    }
    for (const lease of this.dists.values()) {
      for (const job of lease.jobs.values()) await this.sampleConn(job, null, /* outgoingOnly */ true);
    }
    for (const p of this.peers.values()) {
      if (p.conn && !p.conn.dead) await this.sampleConn(p.conn, p, false);
      for (const r of p.relayIns.values()) if (!r.dead) await this.sampleConn(r, p, false);
      for (const d of p.distIns.values()) if (!d.dead) await this.sampleRxVideo(d);
    }
    this.adaptShare(Date.now());
  }

  private async sampleRxVideo(c: Conn): Promise<void> {
    if (c.pc.connectionState !== "connected") return;
    try {
      this.readRxVideo(c, await c.pc.getStats());
    } catch {
      /* ligação fechando */
    }
  }

  // Tela recebida nesta ligação: resolução, fps, bitrate, decodificador, travadas, perda.
  private readRxVideo(c: Conn, report: RTCStatsReport): void {
    const codecs = new Map<string, string>();
    let best: Record<string, unknown> | null = null;
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === "codec" && typeof s.id === "string" && typeof s.mimeType === "string") codecs.set(s.id, s.mimeType);
      if (s.type === "inbound-rtp" && s.kind === "video" && Number(s.bytesReceived ?? 0) > 0) {
        if (!best || Number(s.bytesReceived) > Number(best.bytesReceived)) best = s;
      }
    });
    const s = best as Record<string, unknown> | null;
    if (!s) return;
    const prev = c.rxVideo;
    const t = Number(s.timestamp ?? Date.now());
    const bytes = Number(s.bytesReceived ?? 0);
    const lost = Math.max(0, Number(s.packetsLost ?? 0));
    const recv = Number(s.packetsReceived ?? 0);
    const dLost = prev ? lost - prev.lost : 0;
    const dRecv = prev ? recv - prev.recv : 0;
    const emitted = Number(s.jitterBufferEmittedCount ?? 0);
    c.rxVideo = {
      w: Number(s.frameWidth ?? 0),
      h: Number(s.frameHeight ?? 0),
      fps: Number(s.framesPerSecond ?? 0),
      kbps: prev && t > prev.t ? Math.round(((bytes - prev.bytes) * 8) / (t - prev.t)) : 0,
      codec: (codecs.get(String(s.codecId ?? "")) ?? "").split("/")[1] ?? "",
      decoder: String(s.decoderImplementation ?? ""),
      hw: s.powerEfficientDecoder === true,
      freezes: Number(s.freezeCount ?? 0),
      freezeSec: Number(s.totalFreezesDuration ?? 0),
      lossPct: dLost + dRecv > 0 ? Math.round((1000 * dLost) / (dLost + dRecv)) / 10 : prev?.lossPct ?? 0,
      jbMs: emitted > 0 ? Math.round((1000 * Number(s.jitterBufferDelay ?? 0)) / emitted) : null,
      bytes,
      lost,
      recv,
      t,
    };
  }

  // Painel ℹ️ de uma tela: o que chega aqui e o que quem compartilha diz que está mandando.
  screenInfo(slot: number): ScreenInfo | null {
    const p = this.peers.get(slot);
    if (!p) return null;
    const via = this.screenViaFor(p);
    const src = via ? p.distIns.get(via) : p.via !== null && !this.directOpen(p) ? p.relayIns.get(p.via) : p.conn;
    const tx = p.state?.stx ?? null;
    return {
      rx: src?.rxVideo ?? null,
      tx: tx
        ? { codec: tx.codec, encoder: tx.enc, hw: tx.hw, w: tx.w, fps: tx.fps, qp: tx.qp, limit: tx.lim }
        : null,
      via: via ? this.peerName(this.getPeer(via)) : p.via !== null && !this.directOpen(p) ? this.peerName(this.getPeer(p.via)) : null,
    };
  }

  private async sampleConn(c: Conn, p: RemotePeer | null, outgoingOnly: boolean): Promise<void> {
    if (c.pc.connectionState !== "connected" || !c.tx) return;
    let report: RTCStatsReport;
    try {
      report = await c.pc.getStats();
    } catch {
      return;
    }
    if (this.left || c.dead) return;
    const now = Date.now();
    const micMid = c.tx[TX_MIC].mid;
    let bytesIn = 0;
    let lost = 0;
    let received = 0;
    let jitter: number | null = null;
    let rtt: number | null = null;
    let bytesSent = 0;
    let sendLoss: number | null = null;
    let limitation: string | null = null;
    let avail: number | null = null;
    let pairLocal: string | null = null;
    let pairRemote: string | null = null;
    let localCert: string | null = null;
    let remoteCert: string | null = null;
    const certs = new Map<string, string>();
    const codecs = new Map<string, string>();
    let audioCodecId: string | null = null;
    let videoCodecId: string | null = null;
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === "codec" && typeof s.id === "string" && typeof s.mimeType === "string") codecs.set(s.id, s.mimeType);
      if ((s.type === "outbound-rtp" || s.type === "inbound-rtp") && typeof s.codecId === "string") {
        if (s.kind === "audio" && (s.mid === undefined || s.mid === micMid)) audioCodecId = s.codecId;
        if (s.kind === "video") videoCodecId = s.codecId;
      }
      if (s.type === "inbound-rtp") {
        bytesIn += Number(s.bytesReceived ?? 0);
        if (s.kind === "audio" && (s.mid === undefined || s.mid === micMid)) {
          lost += Number(s.packetsLost ?? 0);
          received += Number(s.packetsReceived ?? 0);
          if (typeof s.jitter === "number") jitter = Math.round(s.jitter * 1000);
        }
      } else if (s.type === "outbound-rtp" && s.kind === "video") {
        bytesSent += Number(s.bytesSent ?? 0);
        const reason = String(s.qualityLimitationReason ?? "none");
        if (reason !== "none") limitation = reason;
        if (Number(s.framesEncoded ?? 0) > 0) {
          c.encoderImpl = String(s.encoderImplementation ?? "");
          c.encoderHw = s.powerEfficientEncoder === true;
          c.sendFps = typeof s.framesPerSecond === "number" ? s.framesPerSecond : null;
          c.sendWidth = typeof s.frameWidth === "number" ? s.frameWidth : null;
          const frames = Number(s.framesEncoded);
          const qpSum = Number(s.qpSum ?? 0);
          if (c.framesEncoded !== undefined && frames > c.framesEncoded) c.sendQp = Math.round((qpSum - (c.qpSum ?? 0)) / (frames - c.framesEncoded));
          c.framesEncoded = frames;
          c.qpSum = qpSum;
        }
      } else if (s.type === "remote-inbound-rtp" && s.kind === "video" && typeof s.fractionLost === "number") {
        sendLoss = Math.max(sendLoss ?? 0, Math.round(s.fractionLost * 100));
      } else if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
        if (typeof s.currentRoundTripTime === "number") rtt = Math.round(s.currentRoundTripTime * 1000);
        if (typeof s.availableOutgoingBitrate === "number") avail = s.availableOutgoingBitrate;
        if (typeof s.localCandidateId === "string") pairLocal = s.localCandidateId;
        if (typeof s.remoteCandidateId === "string") pairRemote = s.remoteCandidateId;
      } else if (s.type === "transport" && typeof s.dtlsState === "string") {
        c.dtls = s.dtlsState;
        if (typeof s.localCertificateId === "string") localCert = s.localCertificateId;
        if (typeof s.remoteCertificateId === "string") remoteCert = s.remoteCertificateId;
      } else if (s.type === "certificate" && typeof s.id === "string" && typeof s.fingerprint === "string") {
        certs.set(s.id, s.fingerprint);
      }
    });
    if (!outgoingOnly) this.readRxVideo(c, report);
    if (rtt !== null) c.rttMs = rtt;
    // Caminho da mídia: algum lado usando candidato "relay" = passando pelo TURN.
    if (pairLocal || pairRemote) {
      const type = (id: string | null) => (id ? (report.get(id) as { candidateType?: string } | undefined)?.candidateType : undefined);
      c.viaTurn = type(pairLocal) === "relay" || type(pairRemote) === "relay";
    }
    if (audioCodecId) c.audioCodec = codecs.get(audioCodecId) ?? c.audioCodec;
    if (videoCodecId) c.videoCodec = codecs.get(videoCodecId) ?? c.videoCodec;
    if (!c.securityCode && localCert && remoteCert) {
      const a = certs.get(localCert);
      const b = certs.get(remoteCert);
      if (a && b) c.securityCode = securityCodeFor(a, b);
    }
    if (!outgoingOnly) {
      if (bytesIn !== c.bytesIn) {
        c.bytesIn = bytesIn;
        c.bytesInChangedAt = now;
      }
      const dLost = lost - c.packetsLost;
      const dRecv = received - c.packetsReceived;
      c.packetsLost = lost;
      c.packetsReceived = received;
      if (dLost + dRecv > 0) c.lossPct = Math.round((100 * dLost) / (dLost + dRecv));
      c.jitterMs = jitter;
      // Perda alta no áudio recebido: buffer de jitter maior (estabilidade > latência).
      const wantJitter = (c.lossPct ?? 0) > JITTER_TARGET_LOSS_PCT;
      if (wantJitter !== c.jitterTargetOn) {
        c.jitterTargetOn = wantJitter;
        const rcv = c.tx[TX_MIC].receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
        if ("jitterBufferTarget" in rcv) {
          try {
            rcv.jitterBufferTarget = wantJitter ? JITTER_TARGET_MS : null;
          } catch {
            /* sem suporte */
          }
        }
      }
      const remoteMuted = p?.state?.muted ?? false;
      const track = c.tx[TX_MIC].receiver.track;
      if (p && track.muted && !remoteMuted && now - c.bytesInChangedAt > AUDIO_STALL_MS && now - c.createdAt > AUDIO_STALL_MS) {
        if (!c.stalled) {
          c.stalled = true;
          this.callbacks.onStatus(`Áudio de ${this.peerName(p)} parou de chegar; verificando a ligação.`);
          this.kick();
        }
      }
    }
    if (!this.screen && !outgoingOnly) return;
    if (p && typeof window.__NITRO_FAKE_LOSS__ === "number") sendLoss = window.__NITRO_FAKE_LOSS__;
    c.bytesSent = bytesSent;
    c.sendLossPct = sendLoss;
    c.limitation = limitation;
    c.availOut = avail;
    this.checkEncoder(c, now);

    // Teto por ligação: só quando esta ligação em particular sofre de verdade (perda
    // medida pelo outro lado, ou estimativa de banda abaixo do teto atual).
    const linkNeed = Math.min(LINK_CAPS[c.capLevel] ?? Infinity, SCREEN_LEVELS[this.screenLevel].nominalBitrate);
    const netLimited = this.networkLimited(c, now, linkNeed);
    const bad = (sendLoss ?? 0) >= 8 || netLimited;
    const good = (sendLoss ?? 0) <= 2 && !netLimited;
    c.capBad = bad ? c.capBad + 1 : 0;
    c.capGood = good ? c.capGood + 1 : 0;
    if (bad && c.capBad >= LINK_BAD_SAMPLES && c.capLevel < LINK_CAPS.length - 1 && now - c.capStepAt > LINK_STEP_DOWN_COOLDOWN_MS) {
      c.capLevel += 1;
      c.capStepAt = now;
      c.capBad = 0;
      this.callbacks.onStatus(
        `Tela para ${p ? this.peerName(p) : "ligação em ponte"}: rede fraca, limitando a ${Math.round((LINK_CAPS[c.capLevel] ?? 0) / 1000)} kbps.`,
      );
    } else if (good && c.capGood >= LINK_GOOD_SAMPLES && c.capLevel > 0 && now - c.capStepAt > LINK_STEP_UP_COOLDOWN_MS) {
      c.capLevel -= 1;
      c.capStepAt = now;
      c.capGood = 0;
    }
  }

  // "Limitado por banda" sozinho NÃO é rede fraca: o Chromium diz isso nos primeiros
  // segundos de toda transmissão (a estimativa de banda ainda está subindo) e sempre que
  // o codificador bate num teto que nós mesmos pusemos. Tratar isso como rede fraca
  // derrubava "Alta" para 350 kbps em ~35 s mesmo numa rede perfeita. Só conta depois do
  // aquecimento e com a estimativa de banda abaixo do que o nível/teto pede.
  private networkLimited(c: Conn, now: number, need: number): boolean {
    if (c.limitation !== "bandwidth" || c.availOut === null) return false;
    const since = this.screen ? Math.max(this.screenStartedAt, c.createdAt) : c.createdAt;
    if (now - since < BWE_WARMUP_MS) return false;
    return c.availOut < need * 0.7;
  }

  // Ajuste automático do nível da captura (vale para todos os espectadores): reage a
  // perda/banda/CPU e a quedas da transmissão; sobe de novo só depois de um período
  // limpo, e segura mais tempo se oscilar.
  private adaptShare(now: number): void {
    if (!this.screen) return;
    const conns: Conn[] = [];
    for (const p of this.peers.values()) {
      if (p.conn && !p.conn.dead && p.conn.pc.connectionState === "connected") conns.push(p.conn);
    }
    // (5.0) CPU no limite não prende mais o PC em VP8: checkEncoder troca ao vivo para um
    // codec que esta máquina faça na GPU.
    if (this.screenQuality !== "auto") return;
    const cfg = adapt();
    const st = this.adaptState;
    const idx = LEVEL_ORDER.indexOf(this.screenLevel);
    const dropped = st.dropAt > st.lastStepAt;
    // Só as ligações que ainda recebem a tela direto contam (as outras vão pela árvore).
    const direct = conns.filter((c) => !!c.tx?.[TX_SCREEN_V].sender.track);
    conns.length = 0;
    conns.push(...direct);
    if (conns.length > 0) {
      const spec = SCREEN_LEVELS[this.screenLevel];
      let worstLoss = 0;
      let anyBw = false;
      let anyCpu = false;
      for (const l of conns) {
        worstLoss = Math.max(worstLoss, l.sendLossPct ?? 0);
        if (this.networkLimited(l, now, spec.nominalBitrate)) anyBw = true;
        if (l.limitation === "cpu") anyCpu = true;
      }
      const bwBad = worstLoss >= 8 || anyBw;
      st.bwBad = bwBad ? st.bwBad + 1 : 0;
      st.cpuBad = anyCpu ? st.cpuBad + 1 : 0;
      const next = LEVEL_ORDER[idx + 1];
      const good = worstLoss <= 2 && !anyBw;
      st.good = good ? st.good + 1 : 0;
      if (idx > 0 && now - st.lastStepAt > cfg.stepDownCooldownMs) {
        const reason =
          dropped ? "queda da transmissão" :
          st.bwBad >= cfg.bwBadSamples ? (worstLoss >= 8 ? `perda de pacotes ${worstLoss}%` : "banda insuficiente") :
          st.cpuBad >= cfg.cpuBadSamples ? "PC sobrecarregado" : null;
        if (reason) {
          if (reason !== "queda da transmissão" && this.tryEnterTree(now, reason)) {
            st.lastStepAt = now;
            st.bwBad = 0;
            st.cpuBad = 0;
            st.good = 0;
            return;
          }
          if (now - st.lastStepUpAt < cfg.oscillationWindowMs) {
            st.upHoldFactor = Math.min(st.upHoldFactor * 2, Math.max(1, cfg.upHoldMaxMs / cfg.upHoldMs));
          }
          st.lastStepAt = now;
          st.bwBad = 0;
          st.cpuBad = 0;
          st.good = 0;
          this.applyLevel(LEVEL_ORDER[idx - 1], `automático: ${reason}`);
          return;
        }
      }
      const upHoldMs = Math.min(cfg.upHoldMaxMs, cfg.upHoldMs * st.upHoldFactor);
      if (next && st.good >= cfg.goodSamples && now - st.lastStepAt > upHoldMs) {
        st.lastStepAt = now;
        st.lastStepUpAt = now;
        st.good = 0;
        this.applyLevel(next, "automático: rede estável");
      }
    } else if (dropped && idx > 0 && now - st.lastStepAt > cfg.stepDownCooldownMs) {
      st.lastStepAt = now;
      this.applyLevel(LEVEL_ORDER[idx - 1], "automático: queda da transmissão");
    }
  }
}
