// Supressão de ruído por IA (RNNoise, código aberto) rodando na thread de áudio.
// O microfone entra aqui depois do cancelamento de eco/ganho do Chromium e sai limpo
// para a chamada. Latência: um quadro de 10 ms.
import createRNNWasmModuleSync from "./rnnoise-sync.js";

const FRAME = 480; // RNNoise trabalha em quadros de 10 ms a 48 kHz

class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.ok = false;
    try {
      this.mod = createRNNWasmModuleSync();
      this.state = this.mod._rnnoise_create(0);
      this.ptr = this.mod._malloc(FRAME * 4);
      this.ok = !!this.state && !!this.ptr;
    } catch (err) {
      this.ok = false;
      this.port.postMessage({ t: "error", message: String(err) });
    }
    this.inBuf = new Float32Array(FRAME);
    this.inLen = 0;
    // Fila de saída: até 2 quadros processados esperando para serem entregues.
    this.outBuf = new Float32Array(FRAME * 4);
    this.outStart = 0;
    this.outEnd = 0;
    this.port.onmessage = (ev) => {
      if (ev.data && typeof ev.data.enabled === "boolean") this.enabled = ev.data.enabled;
    };
    this.port.postMessage({ t: "ready", ok: this.ok });
  }

  processFrame() {
    const heap = this.mod.HEAPF32;
    const off = this.ptr >> 2;
    for (let i = 0; i < FRAME; i++) heap[off + i] = this.inBuf[i] * 32768;
    this.mod._rnnoise_process_frame(this.state, this.ptr, this.ptr);
    for (let i = 0; i < FRAME; i++) {
      this.outBuf[this.outEnd % this.outBuf.length] = heap[off + i] / 32768;
      this.outEnd++;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const out = output[0];
    const inp = input && input.length > 0 ? input[0] : null;
    if (!this.enabled || !this.ok || !inp) {
      // Passa direto (mono).
      if (inp) out.set(inp);
      else out.fill(0);
      return true;
    }
    for (let i = 0; i < inp.length; i++) {
      this.inBuf[this.inLen++] = inp[i];
      if (this.inLen === FRAME) {
        this.processFrame();
        this.inLen = 0;
      }
    }
    for (let i = 0; i < out.length; i++) {
      if (this.outStart < this.outEnd) {
        out[i] = this.outBuf[this.outStart % this.outBuf.length];
        this.outStart++;
      } else {
        out[i] = 0; // ainda enchendo o primeiro quadro (10 ms)
      }
    }
    return true;
  }
}

registerProcessor("nitro-noise", NoiseProcessor);
