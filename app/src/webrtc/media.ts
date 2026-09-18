import { getLang } from "../i18n";
declare global {
  interface Window {
    // Hooks de teste: geram uma "tela" sintética (com ou sem som) em vez de abrir o
    // seletor do sistema (getDisplayMedia não funciona em navegadores headless).
    __NITRO_FAKE_SCREEN__?: boolean;
    __NITRO_FAKE_SCREEN_AUDIO__?: boolean;
  }
}

export async function getMicStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export async function listOutputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audiooutput");
}

// Dica ao codificador: tela com som (vídeo, jogo) prioriza fluidez; sem som (texto,
// slides) prioriza nitidez. Muda ao vivo, sem renegociar.
export function applyContentHint(stream: MediaStream): void {
  const video = stream.getVideoTracks()[0] as (MediaStreamTrack & { contentHint?: string }) | undefined;
  if (!video) return;
  const withAudio = stream.getAudioTracks().some((t) => t.readyState === "live" && t.enabled);
  try {
    video.contentHint = withAudio ? "motion" : "detail";
  } catch {
    /* navegador sem suporte */
  }
}

let fakeScreenCount = 0;

function fakeScreenStream(): MediaStream {
  fakeScreenCount += 1;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;
  const hue = (fakeScreenCount * 97) % 360;
  let frame = 0;
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${hue} 60% 25%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 40px sans-serif";
    ctx.fillText(`tela falsa #${fakeScreenCount}`, 40, 120);
    ctx.font = "28px sans-serif";
    ctx.fillText(`frame ${frame}`, 40, 200);
  };
  draw();
  const timer = setInterval(draw, 100);
  const stream = canvas.captureStream(10);
  stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer));
  if (window.__NITRO_FAKE_SCREEN_AUDIO__) {
    const audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 440 + fakeScreenCount * 110;
    const dest = audioCtx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }
  return stream;
}

export type ScreenLevel = "alta" | "media" | "baixa";
export type ScreenQuality = "auto" | ScreenLevel;

export interface LevelSpec {
  width: number;
  height: number;
  frameRate: number;
  // Teto de bitrate por espectador (cada um recebe um fluxo próprio). null = padrão do
  // Chromium, que calcula o máximo pela resolução ATUAL (1,7 Mbps em 360p, 2,5 Mbps em
  // 1080p): a transmissão começa pequena enquanto a banda é estimada e nunca junta bitrate
  // para voltar a 1080p. Por isso "Alta" tem um teto explícito e alto; a rede de verdade
  // continua mandando (estimativa de banda do WebRTC + tetos por espectador).
  maxBitrate: number | null;
  nominalBitrate: number;
  label: string;
}

export const SCREEN_LEVELS: Record<ScreenLevel, LevelSpec> = {
  // Medido (5.0): VP9 na GPU a 12 Mbps ≈ 46,7 dB (praticamente o original); a 6 Mbps 43,6.
  alta: { width: 1920, height: 1080, frameRate: 30, maxBitrate: 12_000_000, nominalBitrate: 2_500_000, label: "Alta · 1080p30" },
  media: { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000, nominalBitrate: 1_500_000, label: "Média · 720p30" },
  baixa: { width: 854, height: 480, frameRate: 20, maxBitrate: 800_000, nominalBitrate: 600_000, label: "Baixa · 480p20" },
};

export const LEVEL_ORDER: ScreenLevel[] = ["baixa", "media", "alta"];

// Muda a resolução/fps da captura já em andamento, sem reabrir o seletor de tela nem
// renegociar. Streams sintéticas (canvas) podem não aceitar; aí só valem os tetos de
// bitrate.
export async function applyScreenLevel(stream: MediaStream, level: ScreenLevel): Promise<boolean> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return false;
  const spec = SCREEN_LEVELS[level];
  try {
    await track.applyConstraints({
      width: { max: spec.width },
      height: { max: spec.height },
      frameRate: { max: spec.frameRate },
    });
    return true;
  } catch {
    return false;
  }
}

export async function getScreenStream(level: ScreenLevel = "alta"): Promise<MediaStream> {
  const stream = await captureScreen(level);
  applyContentHint(stream);
  return stream;
}

async function captureScreen(level: ScreenLevel): Promise<MediaStream> {
  if (window.__NITRO_FAKE_SCREEN__) return fakeScreenStream();
  const spec = SCREEN_LEVELS[level];
  // Som do sistema (YouTube, jogo): o seletor do Chromium mostra a opção "compartilhar
  // áudio" quando se escolhe a tela inteira. Sem processamento de voz, para música
  // chegar limpa; restrictOwnAudio tenta tirar da captura o que o próprio NitroCall
  // toca (as vozes dos amigos), evitando eco.
  const audio: MediaTrackConstraints & Record<string, unknown> = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    restrictOwnAudio: true,
  };
  const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: {
      width: { ideal: spec.width },
      height: { ideal: spec.height },
      frameRate: { ideal: spec.frameRate },
    },
    audio,
    systemAudio: "include",
    surfaceSwitching: "include",
    selfBrowserSurface: "exclude",
  };
  return navigator.mediaDevices.getDisplayMedia(constraints);
}

// Celular/tablet: pelo navegador não há captura de tela (getDisplayMedia não existe no
// Android nem no iPhone/iPad). userAgentData.mobile quando existe; senão o user agent.
export function isMobile(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean" && uaData.mobile) return true;
  // iPad com iPadOS se apresenta como Mac; o toque denuncia.
  const iPad = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  return iPad || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function canShareScreen(): boolean {
  if (isMobile()) return false;
  return !!window.__NITRO_FAKE_SCREEN__ || typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

// Câmera do celular no lugar da tela: 720p30, traseira por padrão (mostrar algo).
export async function getCameraStream(facing: "user" | "environment"): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { contentHint?: string }) | undefined;
  if (track) {
    try {
      track.contentHint = "motion";
    } catch {
      /* sem suporte */
    }
  }
  return stream;
}

const LEVEL_NAMES = { pt: { alta: "Alta", media: "Média", baixa: "Baixa" }, en: { alta: "High", media: "Medium", baixa: "Low" } };

export function levelLabel(level: ScreenLevel): string {
  const spec = SCREEN_LEVELS[level];
  return `${LEVEL_NAMES[getLang()][level]} · ${spec.height}p${spec.frameRate}`;
}
