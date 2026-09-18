// Constantes definidas no build (vite.config.ts / vite.web.config.ts).
declare const __NITRO_VERSION__: string;
// Impressão curta do código-fonte deste build (iguais = mesmo código).
declare const __NITRO_BUILD__: string;
// "app" = casca Tauri (ou dev); "web" = NitroCall.html no navegador.
declare const __NITRO_TARGET__: "app" | "web";

// Worklet de supressão de ruído empacotado num único módulo (só no build web).
declare module "virtual:noise-worklet" {
  const code: string;
  export default code;
}
