// Rádio de log (link com #debug=<token>): o aparelho transmite o próprio registro, os erros
// e um resumo do estado, cifrados com uma chave derivada do token, pelos relays Nostr
// públicos. Quem tem o token escuta ao vivo (tests/listen.mjs) — é assim que se vê o que
// acontece num iPhone/Android de verdade sem cabo nem ferramenta de desenvolvedor.
import { DEFAULT_RELAYS, NostrSignaling } from "./webrtc/nostr";
import { sha256Bytes, sha256Hex } from "./webrtc/hash";

export interface DebugRadio {
  log(line: string): void;
  state(data: unknown): void;
}

// Poucas mensagens, com muitas linhas: relays públicos limitam mensagens por IP (várias
// abas do mesmo celular transmitindo juntas perdiam linhas).
const FLUSH_MS = 4000;
const MAX_LINES_PER_EVENT = 120;
const MAX_QUEUE = 600;

export function debugTopic(token: string): string {
  return sha256Hex(`nitrocall-debug-topic|${token}`).slice(0, 32);
}

export function startDebugRadio(token: string, relays: string[] = DEFAULT_RELAYS): DebugRadio {
  // Três relays bastam; menos conexões abertas no celular (junto com as da sala).
  relays = relays.slice(0, 3);
  // Identificador do aparelho nesta sessão (várias pessoas podem usar o mesmo token).
  const dev = 1000 + Math.floor(Math.random() * 9000);
  const client = new NostrSignaling({
    relays,
    topic: debugTopic(token),
    key: sha256Bytes(`nitrocall-debug-key|${token}`),
    mySlot: () => dev,
    onMessage: () => {},
    onStatus: () => {},
  });
  const queue: unknown[] = [];
  let seq = 0;
  let sending = false;
  const push = (msg: unknown) => {
    queue.push(msg);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  };
  const flush = async () => {
    if (sending || queue.length === 0) return;
    sending = true;
    try {
      const lines = queue.filter((m) => typeof m === "string").slice(0, MAX_LINES_PER_EVENT) as string[];
      const other = queue.find((m) => typeof m !== "string");
      const batch = other ?? { t: "logs", lines };
      const ok = await client.send(0, { ...(batch as object), dev, seq });
      if (ok) {
        seq += 1;
        if (other) queue.splice(queue.indexOf(other), 1);
        else for (const l of lines) queue.splice(queue.indexOf(l), 1);
      }
    } catch {
      /* relays fora: tenta de novo no próximo ciclo */
    } finally {
      sending = false;
    }
  };
  void client.start().catch(() => {});
  setInterval(() => void flush(), FLUSH_MS);
  push({
    t: "hello",
    ua: navigator.userAgent,
    url: location.href.replace(/#.*$/, ""),
    lang: navigator.language,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    caps: {
      rtc: typeof RTCPeerConnection,
      gum: typeof navigator.mediaDevices?.getUserMedia,
      display: typeof navigator.mediaDevices?.getDisplayMedia,
      worklet: typeof AudioWorkletNode,
      worker: typeof Worker,
      wasm: typeof WebAssembly,
      bc: typeof BroadcastChannel,
    },
  });
  return {
    log: (line: string) => push(line.slice(0, 600)),
    state: (data: unknown) => {
      let text = "";
      try {
        text = JSON.stringify(data);
      } catch {
        text = String(data);
      }
      // Um só resumo de estado na fila (o mais novo substitui o antigo).
      const idx = queue.findIndex((m) => typeof m === "object" && (m as { t?: string }).t === "state");
      const msg = { t: "state", json: text.slice(0, 12_000) };
      if (idx >= 0) queue[idx] = msg;
      else push(msg);
    },
  };
}
