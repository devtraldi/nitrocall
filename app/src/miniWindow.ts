import { getLang, t } from "./i18n";
// Mini-janela sempre por cima (Document Picture-in-Picture, Chromium 116+). No navegador
// não existe bandeja nem atalho global: com ela dá para ver quem está falando e mutar
// enquanto se usa outro programa. Fechar a mini-janela não afeta a chamada.

export interface MiniPerson {
  key: string;
  name: string;
  muted: boolean;
  speaking: boolean;
  self: boolean;
}

export interface MiniState {
  room: string;
  micMuted: boolean;
  people: MiniPerson[];
}

export interface MiniActions {
  toggleMic(): void;
  leave(): void;
}

interface DocumentPiP {
  requestWindow(opts: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}

function api(): DocumentPiP | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null;
}

export function miniSupported(): boolean {
  return !!api();
}

let win: Window | null = null;
let lastKey = "";

export function miniOpen(): boolean {
  return !!win && !win.closed;
}

export async function openMini(actions: MiniActions, onKey: (e: KeyboardEvent) => void): Promise<boolean> {
  const pip = api();
  if (!pip) return false;
  if (miniOpen()) return true;
  try {
    win = await pip.requestWindow({ width: 280, height: 340 });
  } catch {
    win = null;
    return false;
  }
  const doc = win.document;
  // Mesmas cores/fontes da janela principal.
  const style = doc.createElement("style");
  style.textContent = [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((r) => r.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
  doc.head.appendChild(style);
  doc.title = "NitroCall";
  doc.body.className = "mini-body";
  doc.body.innerHTML = `
    <div class="mini">
      <div class="mini-room"></div>
      <ul class="mini-people"></ul>
      <div class="mini-actions">
        <button type="button" class="btn mini-mic"></button>
        <button type="button" class="btn danger mini-leave"></button>
      </div>
    </div>`;
  doc.querySelector<HTMLButtonElement>(".mini-mic")!.addEventListener("click", actions.toggleMic);
  doc.querySelector<HTMLButtonElement>(".mini-leave")!.addEventListener("click", actions.leave);
  doc.addEventListener("keydown", onKey);
  win.addEventListener("pagehide", () => {
    win = null;
    lastKey = "";
  });
  lastKey = "";
  return true;
}

export function closeMini(): void {
  win?.close();
  win = null;
  lastKey = "";
}

export function renderMini(state: MiniState): void {
  if (!miniOpen()) return;
  const key = JSON.stringify([state, getLang()]);
  if (key === lastKey) return;
  lastKey = key;
  const doc = win!.document;
  doc.querySelector(".mini-room")!.textContent = t("mini.room", { room: state.room });
  doc.querySelector(".mini-leave")!.textContent = t("ctl.leave");
  const mic = doc.querySelector<HTMLButtonElement>(".mini-mic")!;
  mic.textContent = state.micMuted ? t("ctl.unmute") : t("ctl.mute");
  mic.classList.toggle("active", state.micMuted);
  const list = doc.querySelector(".mini-people")!;
  list.innerHTML = "";
  for (const p of state.people) {
    const li = doc.createElement("li");
    li.className = `mini-person${p.speaking ? " speaking" : ""}`;
    const dot = doc.createElement("span");
    dot.className = "mini-dot";
    const name = doc.createElement("span");
    name.className = "mini-name";
    name.textContent = p.self ? `${p.name}${t("chip.you")}` : p.name;
    li.append(dot, name);
    if (p.muted) {
      const m = doc.createElement("span");
      m.textContent = "🔇";
      li.appendChild(m);
    }
    list.appendChild(li);
  }
}
