// Build do NitroCall.html: o app inteiro (JS, CSS, logos e a supressão de ruído) num único
// arquivo, que abre com duplo clique no Chrome/Edge (file://) ou hospedado em qualquer
// site estático. Mesmo código e mesmo protocolo do app instalado.
import { build, defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildDefines } from "./scripts/buildInfo.mjs";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const OUT_NAME = "NitroCall.html";
const WORKLET_ID = "virtual:noise-worklet";

// Troca os módulos que dependem de arquivos separados pelas versões embutidas.
function webPlatform(): Plugin {
  return {
    name: "nitro-web-platform",
    enforce: "pre",
    resolveId(source) {
      if (source === "./workletSource") return here("./src/webrtc/workletSource.web.ts");
      if (source === WORKLET_ID) return "\0" + WORKLET_ID;
      return null;
    },
    async load(id) {
      if (id !== "\0" + WORKLET_ID) return null;
      // Worklet + RNNoise (wasm embutido) num módulo ES só, exportado como texto.
      const out = await build({
        configFile: false,
        logLevel: "warn",
        build: {
          write: false,
          minify: true,
          target: "chrome120",
          lib: { entry: here("./public/noise-worklet.js"), formats: ["es"], fileName: "noise-worklet" },
        },
      });
      const outputs = Array.isArray(out) ? out : [out];
      const chunk = outputs
        .flatMap((o) => ("output" in o ? o.output : []))
        .find((c) => c.type === "chunk");
      if (!chunk || chunk.type !== "chunk") throw new Error("worklet não empacotou");
      return `export default ${JSON.stringify(chunk.code)};`;
    },
  };
}

// CSP estrita no próprio HTML (não há servidor para mandar cabeçalhos): só os scripts
// embutidos neste arquivo (por hash) rodam. data: é o worklet de ruído (ver
// workletSource.web.ts); blob: é o relógio em Worker.
function cspAndName(): Plugin {
  return {
    name: "nitro-web-csp",
    enforce: "post",
    generateBundle(_opts, bundle) {
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") throw new Error("index.html não encontrado no bundle");
      let source = String(html.source);
      // O Vite não embute <link rel="icon">: vira data URI aqui (o arquivo tem de ir sozinho).
      source = source.replace(/<link rel="icon" type="image\/png" href="\.\/([^"]+)"/g, (all, file: string) => {
        const asset = bundle[file];
        if (!asset || asset.type !== "asset") return all;
        delete bundle[file];
        return `<link rel="icon" type="image/png" href="data:image/png;base64,${Buffer.from(asset.source as Uint8Array).toString("base64")}"`;
      });
      if (/href="\.\//.test(source)) throw new Error("arquivo externo sobrou no HTML");
      const hashes: string[] = [];
      source = source.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (all, attrs: string, body: string) => {
        if (/\ssrc=/.test(attrs)) throw new Error("script externo sobrou no HTML");
        hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
        return all;
      });
      const csp = [
        "default-src 'none'",
        // wasm-unsafe-eval: só compilar WebAssembly (RNNoise); eval de JS continua proibido.
        `script-src ${hashes.join(" ")} data: 'wasm-unsafe-eval'`,
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "media-src blob: mediastream:",
        "font-src data:",
        "worker-src blob:",
        "connect-src https://0.peerjs.com wss://0.peerjs.com ws://localhost:* http://localhost:* wss://*:* https://*:*",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      source = source.replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
      delete bundle["index.html"];
      this.emitFile({ type: "asset", fileName: OUT_NAME, source });
      // Impressão do arquivo final, para publicar junto e conferir o que circula no WhatsApp
      // (certutil -hashfile NitroCall.html SHA256).
      const digest = createHash("sha256").update(source, "utf8").digest("hex");
      this.emitFile({ type: "asset", fileName: `${OUT_NAME}.sha256`, source: `${digest}  ${OUT_NAME}\n` });
    },
  };
}

export default defineConfig({
  base: "./",
  define: buildDefines("web"),
  // noise-worklet.js / rnnoise-sync.js vão embutidos; nada de arquivos soltos.
  publicDir: false,
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "chrome120",
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 10_000,
  },
  plugins: [webPlatform(), viteSingleFile({ removeViteModuleLoader: true }), cspAndName()],
});
