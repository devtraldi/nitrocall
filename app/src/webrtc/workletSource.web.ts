// NitroCall.html aberto do disco (file://): o Chromium não carrega worklets de outros
// arquivos nem de blob: (origem "null"), mas aceita data:. O worklet + RNNoise vão
// empacotados num módulo só, embutido no HTML.
import code from "virtual:noise-worklet";

export async function noiseWorkletUrl(): Promise<string> {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:text/javascript;base64,${btoa(bin)}`;
}
