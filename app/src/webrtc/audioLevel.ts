const SPEAKING_THRESHOLD = 14; // escala 0-255, ajustado empiricamente pra voz normal de mic
const POLL_MS = 80;

let sharedCtx: AudioContext | null = null;

// Um único AudioContext para todos os medidores e sons da UI: cada AudioContext custa
// uma thread de áudio, e criar um por participante é desperdício.
export function getAudioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

export function watchSpeaking(stream: MediaStream, onChange: (speaking: boolean) => void): () => void {
  if (stream.getAudioTracks().length === 0) return () => {};

  const audioCtx = getAudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  let speaking = false;

  const timer = setInterval(() => {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const v of data) sum += v;
    const isSpeaking = sum / data.length > SPEAKING_THRESHOLD;
    if (isSpeaking !== speaking) {
      speaking = isSpeaking;
      onChange(speaking);
    }
  }, POLL_MS);

  return () => {
    clearInterval(timer);
    if (speaking) onChange(false);
    source.disconnect();
    analyser.disconnect();
  };
}

export function playChime(kind: "join" | "leave"): void {
  try {
    const ctx = getAudioContext();
    const notes = kind === "join" ? [523, 784] : [659, 440];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.2);
    });
  } catch {
    /* som é só um detalhe; nunca pode quebrar a chamada */
  }
}
