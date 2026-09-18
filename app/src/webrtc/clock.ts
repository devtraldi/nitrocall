import { IS_WEB } from "../buildInfo";

// Relógio dos timers que mantêm a sala viva (estado a cada 1 s, estatísticas, religação
// ao servidor). Numa aba de navegador em segundo plano o Chrome atrasa os timers da
// página (até 1 por minuto depois de 5 min); os de um Web Worker não sofrem isso. No
// app (Tauri) continua o setInterval de sempre.

type Stop = () => void;

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const handlers = new Map<number, () => void>();

const WORKER_CODE = `
const timers = new Map();
onmessage = (e) => {
  const m = e.data;
  if (m.op === "start") timers.set(m.id, setInterval(() => postMessage(m.id), m.ms));
  else if (m.op === "stop") { clearInterval(timers.get(m.id)); timers.delete(m.id); }
};`;

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_CODE], { type: "text/javascript" })));
    worker.onmessage = (e: MessageEvent<number>) => handlers.get(e.data)?.();
    worker.onerror = () => {
      workerFailed = true;
    };
  } catch {
    workerFailed = true;
  }
  return worker;
}

export function clockKind(): "worker" | "page" {
  return IS_WEB && getWorker() ? "worker" : "page";
}

export function every(ms: number, fn: () => void): Stop {
  const w = IS_WEB ? getWorker() : null;
  if (!w) {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
  const id = nextId++;
  handlers.set(id, fn);
  w.postMessage({ op: "start", id, ms });
  return () => {
    handlers.delete(id);
    w.postMessage({ op: "stop", id });
  };
}
