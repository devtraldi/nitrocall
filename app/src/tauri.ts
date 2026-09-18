// Camada de plataforma. No app, fala com a casca nativa (Tauri/Rust). No navegador
// (NitroCall.html, testes) usa o que o Chromium oferece no lugar, ou vira no-op: a
// chamada em si nunca depende do Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// No navegador, a CPU vem da Compute Pressure API (Chromium 125+), que diz o quanto a
// máquina está apertada em quatro níveis; convertemos para a escala 0–100 do Rust.
const PRESSURE_LOAD: Record<string, number> = { nominal: 25, fair: 50, serious: 80, critical: 95 };
let pressure: number | null = null;
let pressureStarted = false;

interface PressureRecordLike {
  state: string;
}

function startPressure(): void {
  if (pressureStarted) return;
  pressureStarted = true;
  const Ctor = (window as unknown as { PressureObserver?: new (cb: (r: PressureRecordLike[]) => void) => { observe(src: string, o?: object): Promise<void> } }).PressureObserver;
  if (!Ctor) return;
  try {
    const obs = new Ctor((records) => {
      const last = records[records.length - 1];
      if (last) pressure = PRESSURE_LOAD[last.state] ?? null;
    });
    void obs.observe("cpu", { sampleInterval: 2000 }).catch(() => {});
  } catch {
    /* sem Compute Pressure: o score usa só as estatísticas de envio */
  }
}

export async function systemLoad(): Promise<number | null> {
  if (!isTauri()) {
    startPressure();
    return pressure;
  }
  try {
    const r = await invoke<{ cpu: number; mem: number }>("system_load");
    return typeof r?.cpu === "number" ? r.cpu : null;
  } catch {
    return null;
  }
}

export function keepAwake(on: boolean): void {
  if (!isTauri()) return;
  void invoke("keep_awake", { on }).catch(() => {});
}

export function setInCall(on: boolean): void {
  if (!isTauri()) return;
  void invoke("set_in_call", { on }).catch(() => {});
}

// No navegador não há arquivo de registro: guardamos as últimas linhas no próprio
// navegador (sobrevive a fechar a aba) e o botão 📥 baixa tudo como .txt.
const WEB_LOG_KEY = "nitrocall.log";
const WEB_LOG_MAX_LINES = 3000;
let webLog: string[] | null = null;
let webLogSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadWebLog(): string[] {
  if (webLog) return webLog;
  try {
    webLog = (localStorage.getItem(WEB_LOG_KEY) ?? "").split("\n").filter(Boolean);
  } catch {
    webLog = [];
  }
  return webLog;
}

export function appendLog(line: string): void {
  if (isTauri()) {
    void invoke("append_log", { line }).catch(() => {});
    return;
  }
  const log = loadWebLog();
  log.push(`${new Date().toISOString()} ${line.replace(/[\r\n]+/g, " ").slice(0, 4000)}`);
  if (log.length > WEB_LOG_MAX_LINES) log.splice(0, log.length - WEB_LOG_MAX_LINES);
  if (webLogSaveTimer) return;
  webLogSaveTimer = setTimeout(() => {
    webLogSaveTimer = null;
    try {
      localStorage.setItem(WEB_LOG_KEY, log.join("\n"));
    } catch {
      /* sem espaço: fica só na memória */
    }
  }, 2000);
}

export function webLogText(): string {
  return loadWebLog().join("\n");
}

// Entrega um texto como arquivo baixado (registro, diagnóstico).
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function logPath(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("log_path");
  } catch {
    return null;
  }
}

export interface NativeEvents {
  onToggleMute(): void;
  onLeave(): void;
  onHiddenToTray(): void;
  onInvite(roomCode: string): void;
}

// Eventos da bandeja, do atalho global (Ctrl+Shift+M) e do link de convite.
export async function wireNativeEvents(ev: NativeEvents): Promise<void> {
  if (!isTauri()) return;
  try {
    await listen("nitro:toggle-mute", () => ev.onToggleMute());
    await listen("nitro:leave", () => ev.onLeave());
    await listen("nitro:hidden-to-tray", () => ev.onHiddenToTray());
    const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
    const handle = (urls: string[] | null) => {
      for (const u of urls ?? []) {
        const code = parseInvite(u);
        if (code) ev.onInvite(code);
      }
    };
    await onOpenUrl(handle);
    handle(await getCurrent());
  } catch {
    /* sem eventos nativos */
  }
}

// nitrocall://sala/<código>  ou  nitrocall://sala?c=<código>
export function parseInvite(url: string): string | null {
  const m = /^nitrocall:\/\/sala\/?\/?([^/?#]+)/i.exec(url) ?? /[?&]c=([^&#]+)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim().slice(0, 60) || null;
  } catch {
    return null;
  }
}

export function inviteLink(roomCode: string): string {
  return `nitrocall://sala/${encodeURIComponent(roomCode.trim())}`;
}

// Convite pelo navegador: o código vai depois do "#", que nunca sai do PC (nem para o
// site, na versão online). Aceita #sala=<código> e #c=<código>.
export function parseHashInvite(hash: string): string | null {
  const m = /^#(?:sala|c)=([^&]+)/i.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim().slice(0, 60) || null;
  } catch {
    return null;
  }
}

// Endereço desta página com o código da sala (só faz sentido online: num arquivo local o
// caminho é diferente em cada PC).
export function webInviteLink(roomCode: string): string | null {
  if (location.protocol !== "https:") return null;
  return `${location.origin}${location.pathname}#sala=${encodeURIComponent(roomCode.trim())}`;
}

// Chromium (Chrome, Edge, Opera, Brave) é o único navegador em que tudo foi testado: som
// do sistema na tela, VP9/RED, AudioWorklet, Compute Pressure.
export function isChromium(): boolean {
  const brands = (navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /chromium/i.test(b.brand));
}

export async function autostartGet(): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return await isEnabled();
  } catch {
    return null;
  }
}

export async function autostartSet(on: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { enable, disable } = await import("@tauri-apps/plugin-autostart");
    if (on) await enable();
    else await disable();
  } catch {
    /* sem autostart */
  }
}

export interface UpdateInfo {
  version: string;
  install(): Promise<void>;
}

// Atualização automática (releases assinadas). Qualquer falha é silenciosa: o app não
// pode deixar de funcionar porque o servidor de releases não respondeu.
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 8000 });
    if (!update) return null;
    return {
      version: update.version,
      async install() {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}
