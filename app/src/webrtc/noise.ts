import { getAudioContext } from "./audioLevel";
import { noiseWorkletUrl } from "./workletSource";

// Supressão de ruído por IA (RNNoise em WebAssembly, num AudioWorklet) entre o
// microfone e a chamada. Se algo falhar (worklet indisponível, wasm não carrega), a
// chamada segue com o microfone cru: nunca pode impedir a conversa.

export interface NoisePipeline {
  // Stream a enviar (mono, limpo). O track original continua vivo por trás.
  stream: MediaStream;
  setEnabled(on: boolean): void;
  close(): void;
}

let workletLoaded: Promise<boolean> | null = null;

async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  if (!workletLoaded) {
    workletLoaded = noiseWorkletUrl()
      .then((url) => ctx.audioWorklet.addModule(url))
      .then(() => true)
      .catch(() => false);
  }
  return workletLoaded;
}

export async function createNoisePipeline(source: MediaStream): Promise<NoisePipeline | null> {
  if (!source.getAudioTracks().length) return null;
  const ctx = getAudioContext();
  if (!(await ensureWorklet(ctx))) return null;
  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, "nitro-noise", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
  } catch {
    return null;
  }
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    node.port.onmessage = (ev) => {
      if (ev.data?.t === "ready") {
        clearTimeout(timer);
        resolve(!!ev.data.ok);
      }
    };
  });
  const src = ctx.createMediaStreamSource(source);
  const dest = ctx.createMediaStreamDestination();
  src.connect(node);
  node.connect(dest);
  if (!(await ready)) {
    src.disconnect();
    node.disconnect();
    return null;
  }
  return {
    stream: dest.stream,
    setEnabled(on: boolean) {
      node.port.postMessage({ enabled: on });
    },
    close() {
      try {
        src.disconnect();
        node.disconnect();
      } catch {
        /* já desligado */
      }
      for (const t of dest.stream.getTracks()) t.stop();
    },
  };
}
