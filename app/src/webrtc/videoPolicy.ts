// Política de vídeo da tela (5.0). Medido com captura real de aba no Chrome instalado
// (laboratório com PSNR contra o próprio quadro capturado, antes do encoder):
//
//   VP9 na GPU (Intel), 12 Mbps ........ 46,7 dB (texto 47,0) ← praticamente o original
//   VP9 na GPU, 6 Mbps ................. 43,6 dB
//   H.265 na GPU (NVIDIA), 6 Mbps ...... 43,2 dB
//   H.264 na GPU (NVIDIA), 6 Mbps ...... 41,3 dB
//   AV1 / VP9 na CPU, ~5 Mbps .......... 33 dB, e o VP9 na CPU nem segura 30 fps
//   Como era (4.1): VP9 na GPU reduzido para 1424x778 ... 36,6 dB (texto 34,0)
//
// O que estragava a imagem eram decisões automáticas do Chromium:
//  1. a banda estimada começa em ~300 kbps: o codificador escolhe uma resolução menor no
//     primeiro quadro (e com banda inicial baixa ainda troca a GPU pela CPU) e não volta;
//  2. "balanced" deixa o redimensionador por QP derrubar a resolução;
//  3. sem teto explícito, o máximo é calculado pela resolução atual.
// Aqui tudo isso é decidido antes do primeiro quadro: bitrate inicial alto no SDP, "manter
// resolução", teto por nível e um codec que ESTA máquina codifica na GPU.

declare global {
  interface Window {
    // Ganchos de teste/calibração.
    __NITRO_START_BR__?: number; // kbps
    __NITRO_DEG__?: RTCDegradationPreference;
    __NITRO_MAXBR__?: number; // bps (Alta)
    __NITRO_CODEC__?: string;
    __NITRO_NOCODECSET__?: boolean;
    // Finge que esta máquina não tem estes encoders de GPU (ex.: ["VP9"]).
    __NITRO_NO_HW__?: string[];
  }
}

// Bitrate inicial da estimativa de banda (kbps): alto o bastante para o primeiro quadro já
// sair em 1080p e na GPU. Se a rede não aguentar, a estimativa cai em ~1 s (perda/atraso).
export const START_KBPS_DEFAULT = 4000;

export function startKbps(): number {
  const v = Number(window.__NITRO_START_BR__);
  return Number.isFinite(v) && v > 0 ? v : START_KBPS_DEFAULT;
}

export function screenDegradation(): RTCDegradationPreference {
  return window.__NITRO_DEG__ ?? "maintain-resolution";
}

const VIDEO_CODECS = /^(VP8|VP9|AV1|H264|H265)$/i;

// Acrescenta x-google-start-bitrate aos codecs de vídeo de uma seção m=video do SDP.
export function mungeVideoSection(sec: string, kbps = startKbps()): string {
  const pts: string[] = [];
  for (const m of sec.matchAll(/^a=rtpmap:(\d+) ([A-Za-z0-9-]+)\/90000/gm)) {
    if (VIDEO_CODECS.test(m[2])) pts.push(m[1]);
  }
  let out = sec;
  for (const pt of pts) {
    const fmtpRe = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, "m");
    const m = fmtpRe.exec(out);
    if (m) {
      const params = m[1].split(";").filter((kv) => !kv.trim().startsWith("x-google-start-bitrate="));
      params.push(`x-google-start-bitrate=${Math.round(kbps)}`);
      out = out.replace(fmtpRe, `a=fmtp:${pt} ${params.join(";")}`);
    } else {
      const rtpRe = new RegExp(`^a=rtpmap:${pt} [^\\r\\n]*\\r?\\n`, "m");
      out = out.replace(rtpRe, (rtp) => `${rtp}a=fmtp:${pt} x-google-start-bitrate=${Math.round(kbps)}\r\n`);
    }
  }
  return out;
}

// Ordem de preferência para a tela: VP9 vai primeiro na negociação (o caminho negociado
// mantém a GPU da Intel/AMD); os outros entram por troca ao vivo (encodings[].codec), que
// no H.265/H.264 também usa a GPU. Trocar explicitamente PARA VP9 cai na CPU: por isso o
// VP9 só é usado pelo caminho negociado.
export const SEND_ORDER = ["VP9", "H265", "H264", "AV1"] as const;

// Quais codecs esta máquina codifica na GPU (MediaCapabilities, tipo "webrtc").
let hwProbe: Promise<Record<string, boolean>> | null = null;
let hwKnown: Record<string, boolean> | null = null;

export function probeHwEncoders(): Promise<Record<string, boolean>> {
  if (!hwProbe) {
    hwProbe = (async () => {
      const out: Record<string, boolean> = {};
      for (const name of SEND_ORDER) {
        try {
          const info = await navigator.mediaCapabilities.encodingInfo({
            type: "webrtc",
            video: { contentType: `video/${name}`, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 },
          });
          out[name] = !!(info.supported && info.powerEfficient);
        } catch {
          out[name] = false;
        }
      }
      for (const name of window.__NITRO_NO_HW__ ?? []) out[name.toUpperCase()] = false;
      hwKnown = out;
      return out;
    })();
  }
  return hwProbe;
}

export function hwEncoders(): Record<string, boolean> | null {
  return hwKnown;
}

export interface CodecChoice {
  name: string;
  // null = usar o codec negociado (VP9); senão, troca ao vivo para este.
  codec: RTCRtpCodec | null;
  expectHw: boolean;
}

function negotiated(sender: RTCRtpSender, name: string): RTCRtpCodec | null {
  let codecs: RTCRtpCodec[] = [];
  try {
    codecs = sender.getParameters().codecs ?? [];
  } catch {
    return null;
  }
  const want = `video/${name}`.toLowerCase();
  return codecs.find((x) => x.mimeType.toLowerCase() === want && (name !== "VP9" || !/profile-id=2/.test(x.sdpFmtpLine ?? ""))) ?? null;
}

// Escolhe o codec de envio da tela numa ligação. `skip` = codecs que já se mostraram ruins
// nesta máquina (caíram na CPU ou sobrecarregaram).
export function chooseSendCodec(sender: RTCRtpSender, skip: ReadonlySet<string> = new Set()): CodecChoice {
  if (window.__NITRO_NOCODECSET__) return { name: "VP9", codec: null, expectHw: false };
  const hw = hwKnown ?? {};
  const forced = window.__NITRO_CODEC__?.toUpperCase();
  if (forced && forced !== "VP9") {
    const c = negotiated(sender, forced);
    if (c) return { name: forced, codec: c, expectHw: !!hw[forced] };
  }
  for (const name of SEND_ORDER) {
    if (skip.has(name) || !hw[name]) continue;
    if (name === "VP9") return { name, codec: null, expectHw: true };
    const c = negotiated(sender, name);
    if (c) return { name, codec: c, expectHw: true };
  }
  // Sem GPU: na CPU, VP8 dá a mesma nitidez que o VP9 (36,8 dB a ~10 Mbps) e segura 30 fps,
  // enquanto o VP9 cai para ~19 fps. Depois H.264 (OpenH264, leve); VP9 por último.
  for (const name of SW_ORDER) {
    if (skip.has(name)) continue;
    const c = negotiated(sender, name);
    if (c) return { name, codec: c, expectHw: false };
  }
  return { name: "VP9", codec: null, expectHw: false };
}

const SW_ORDER = ["VP8", "H264"] as const;
