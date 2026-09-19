import { IS_WEB } from "../buildInfo";

// Relógio dos timers que mantêm a sala viva (estado a cada 1 s, estatísticas, religação
// ao servidor). Numa aba de navegador em segundo plano o Chrome atrasa os timers da
// página (até 1 por minuto depois de 5 min); os de um Web Worker não sofrem isso. No
// app (Tauri) continua o setInterval de sempre.
//
// O Worker pode não funcionar num navegador (bloqueado, ou morto sem avisar): se ele não
// der sinal logo depois de ligado, todos os timers passam para o setInterval da página.
// Antes, um Worker que falhava depois de criado deixava o relógio parado para sempre — a
// sala só andava quando algum evento a "cutucava".

type Stop = () => void;

interface Timer {
  ms: number;
  fn: () => void;
  pageTimer: ReturnType<typeof setInterval> | null;
}

const WATCHDOG_MS = 2_500;

let worker: Worker | null = null;
let mode: "worker" | "page" | "worker→page" = "worker";
let fallbackReason = "";
let nextId = 1;
let ticks = 0;
let workerAlive = false;
const timers = new Map<number, Timer>();
let onFallback: ((reason: string) => void) | null = null;

const WORKER_CODE = `
const timers = new Map();
onmessage = (e) => {
  const m = e.data;
  if (m.op === "start") timers.set(m.id, setInterval(() => postMessage(m.id), m.ms));
  else if (m.op === "stop") { clearInterval(timers.get(m.id)); timers.delete(m.id); }
};`;

function run(fn: () => void): void {
  ticks += 1;
  fn();
}

// Passa todos os timers para a página (e não volta mais para o Worker nesta sessão).
function fallBack(reason: string): void {
  if (mode !== "worker") return;
  mode = worker ? "worker→page" : "page";
  fallbackReason = reason;
  try {
    worker?.terminate();
  } catch {
    /* já morto */
  }
  worker = null;
  for (const t of timers.values()) {
    if (!t.pageTimer) t.pageTimer = setInterval(() => run(t.fn), t.ms);
  }
  onFallback?.(reason);
}

function getWorker(): Worker | null {
  if (!IS_WEB || mode !== "worker") return null;
  if (worker) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_CODE], { type: "text/javascript" })));
    worker.onmessage = (e: MessageEvent<number>) => {
      workerAlive = true;
      const t = timers.get(e.data);
      if (t && !t.pageTimer) run(t.fn);
    };
    worker.onerror = () => fallBack("o Web Worker falhou");
  } catch (err) {
    worker = null;
    mode = "page";
    fallbackReason = `sem Web Worker (${(err as Error)?.message ?? err})`;
  }
  return worker;
}

export function clockKind(): string {
  if (!IS_WEB) return "page";
  getWorker();
  return fallbackReason ? `${mode} (${fallbackReason})` : mode;
}

// Quantas vezes algum timer já disparou (diagnóstico: relógio batendo ou parado).
export function clockTicks(): number {
  return ticks;
}

export function onClockFallback(fn: (reason: string) => void): void {
  onFallback = fn;
}

export function every(ms: number, fn: () => void): Stop {
  const id = nextId++;
  const t: Timer = { ms, fn, pageTimer: null };
  timers.set(id, t);
  const w = getWorker();
  if (!w) {
    t.pageTimer = setInterval(() => run(fn), ms);
  } else {
    w.postMessage({ op: "start", id, ms });
    // O Worker tem de dar sinal: senão, relógio da página.
    setTimeout(() => {
      if (!workerAlive && timers.has(id)) fallBack(`o Web Worker não deu sinal em ${WATCHDOG_MS / 1000} s`);
    }, Math.max(WATCHDOG_MS, ms * 2 + 500));
  }
  return () => {
    timers.delete(id);
    if (t.pageTimer) clearInterval(t.pageTimer);
    worker?.postMessage({ op: "stop", id });
  };
}
