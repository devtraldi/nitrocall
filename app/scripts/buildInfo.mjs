// Constantes de build compartilhadas pelo app (vite.config.ts) e pelo NitroCall.html
// (vite.web.config.ts). BUILD é uma impressão do código-fonte: app e HTML gerados do
// mesmo código têm o mesmo BUILD, e a sala avisa quando alguém usa um arquivo diferente.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function sourceFingerprint() {
  const files = [
    ...walk(join(root, "src"), []),
    join(root, "public", "noise-worklet.js"),
    join(root, "public", "rnnoise-sync.js"),
    join(root, "index.html"),
  ];
  const h = createHash("sha256");
  for (const f of files) {
    // Fim de linha não conta (CRLF/LF conforme o checkout).
    const text = readFileSync(f).toString("latin1").replace(/\r\n/g, "\n");
    h.update(relative(root, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(text, "latin1");
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

export function version() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export function buildDefines(target) {
  return {
    __NITRO_VERSION__: JSON.stringify(version()),
    __NITRO_BUILD__: JSON.stringify(sourceFingerprint()),
    __NITRO_TARGET__: JSON.stringify(target),
  };
}
