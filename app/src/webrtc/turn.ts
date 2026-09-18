// TURN de último recurso: quando dois PCs não conseguem ligação direta (NAT simétrico/CGNAT
// dos dois lados) e não há um amigo para servir de ponte, a mídia passa por um TURN.
//
// A chave do TURN não pode ficar no app (qualquer um a leria). Um Worker minúsculo guarda a
// chave e devolve credenciais temporárias; ele não vê sala, nome, áudio nem vídeo.
// O TURN entra só como candidato a mais no ICE, que sempre prefere o caminho direto
// (host/srflx têm prioridade maior que relay): quando o direto funciona, nada passa por ele.

// Worker de credenciais (cloudflare/turn-worker). "" = sem TURN (direto + ponte, como na 5.0).
export const DEFAULT_TURN_ENDPOINT = "https://nitrocall-turn.devtraldi.workers.dev";

const FETCH_TIMEOUT_MS = 5_000;
const RETRY_MS = 30_000;
// Renova antes de expirar (fração da validade).
const RENEW_AT = 0.75;
const DEFAULT_TTL_S = 6 * 3600;

type IceServerLike = { urls?: unknown; username?: unknown; credential?: unknown };

function asList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((u): u is string => typeof u === "string");
  return [];
}

// Aceita {iceServers: {...}} ou {iceServers: [...]} (formatos da API da Cloudflare) e
// descarta a porta 53, que os navegadores bloqueiam/estouram tempo.
export function parseIceServers(body: unknown): RTCIceServer[] {
  const raw = (body as { iceServers?: unknown } | null)?.iceServers;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as IceServerLike[];
  const out: RTCIceServer[] = [];
  for (const s of list) {
    const urls = asList(s?.urls).filter((u) => /^(turns?|stun):/i.test(u) && !/:53(\?|$)/.test(u));
    if (!urls.some((u) => /^turns?:/i.test(u))) continue;
    if (typeof s.username !== "string" || typeof s.credential !== "string") continue;
    out.push({ urls, username: s.username, credential: s.credential });
  }
  return out;
}

export class TurnCredentials {
  private servers: RTCIceServer[] = [];
  private renewAt = 0;
  private retryAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly endpoint: string) {}

  get enabled(): boolean {
    return !!this.endpoint;
  }

  // Servidores TURN válidos agora (pode ser vazio). Dispara renovação em segundo plano.
  current(): RTCIceServer[] {
    if (this.enabled && Date.now() >= this.renewAt && Date.now() >= this.retryAt) void this.refresh();
    return this.servers;
  }

  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(this.endpoint, { method: "POST", signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ttl?: unknown };
      const servers = parseIceServers(body);
      if (servers.length === 0) throw new Error("resposta sem TURN");
      const ttl = typeof body.ttl === "number" && body.ttl > 60 ? body.ttl : DEFAULT_TTL_S;
      this.servers = servers;
      this.renewAt = Date.now() + ttl * 1000 * RENEW_AT;
      this.retryAt = 0;
    } catch {
      // Sem TURN por enquanto: o app segue como antes (direto + ponte por amigo).
      this.retryAt = Date.now() + RETRY_MS;
      if (Date.now() >= this.renewAt) this.servers = [];
    } finally {
      clearTimeout(timer);
    }
  }
}
