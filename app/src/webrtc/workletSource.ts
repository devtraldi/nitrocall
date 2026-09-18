// De onde o AudioWorklet de supressão de ruído é carregado. No app (e no dev) ele é um
// arquivo servido junto da página; o build web troca este módulo por workletSource.web.ts.
export async function noiseWorkletUrl(): Promise<string> {
  return "/noise-worklet.js";
}
