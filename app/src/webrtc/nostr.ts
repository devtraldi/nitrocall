// Ponto de encontro de emergência: relays Nostr públicos (gratuitos, muitos, sem dono).
// Quando o servidor PeerJS não responde, os PCs se encontram por aqui: cada mensagem de
// sinalização vira um evento efêmero (o relay não guarda) cifrado com a chave da sala —
// o relay só vê que "alguém" publicou algo numa sala identificada por um hash.
//
// Uso: um cliente por sala; `send(toSlot, msg)` publica, `onMessage(fromSlot, msg)` recebe.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://nostr.mom",
];

// Kind efêmero (20000–29999): os relays retransmitem e não armazenam.
const KIND = 24242;
const RECONNECT_MS = 5_000;
const MAX_AGE_S = 60;

export interface NostrOptions {
  relays: string[];
  // Identificador da sala visível ao relay (hash, nunca o nome).
  topic: string;
  // Chave simétrica da sala (32 bytes) — derivada do código + senha.
  key: Uint8Array;
  mySlot: () => number;
  onMessage(fromSlot: number, msg: unknown): void;
  onStatus(message: string): void;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class NostrSignaling {
  private readonly opts: NostrOptions;
  private readonly secret: Uint8Array;
  private readonly pubkey: string;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Set<string>();
  private aesKey: CryptoKey | null = null;
  private readonly subId = bytesToHex(randomBytes(8));
  private closed = false;
  private connectedCount = 0;

  constructor(opts: NostrOptions) {
    this.opts = opts;
    this.secret = randomBytes(32);
    this.pubkey = bytesToHex(schnorr.getPublicKey(this.secret));
  }

  get connected(): number {
    return this.connectedCount;
  }

  async start(): Promise<void> {
    this.aesKey = await crypto.subtle.importKey("raw", this.opts.key as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    for (const url of this.opts.relays) this.connect(url);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {
        /* já fechado */
      }
    }
    this.sockets.clear();
  }

  private connect(url: string): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect(url);
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      this.connectedCount += 1;
      const since = Math.floor(Date.now() / 1000) - MAX_AGE_S;
      ws.send(JSON.stringify(["REQ", this.subId, { kinds: [KIND], "#h": [this.opts.topic], since }]));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data.length > 200_000) return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg[0] !== "EVENT" || msg[1] !== this.subId) return;
      void this.handleEvent(msg[2] as Partial<NostrEvent>);
    };
    ws.onclose = () => {
      if (this.sockets.get(url) === ws) {
        this.sockets.delete(url);
        this.connectedCount = Math.max(0, this.connectedCount - 1);
      }
      this.scheduleReconnect(url);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignora */
      }
    };
  }

  private scheduleReconnect(url: string): void {
    if (this.closed || this.timers.has(url)) return;
    this.timers.set(
      url,
      setTimeout(() => {
        this.timers.delete(url);
        this.connect(url);
      }, RECONNECT_MS),
    );
  }

  private async handleEvent(ev: Partial<NostrEvent>): Promise<void> {
    if (!ev || typeof ev.id !== "string" || typeof ev.content !== "string" || ev.pubkey === this.pubkey) return;
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > 5000) this.seen.clear();
    const age = Math.floor(Date.now() / 1000) - Number(ev.created_at ?? 0);
    if (Math.abs(age) > MAX_AGE_S * 2) return;
    const to = Number(ev.tags?.find((t) => t[0] === "t")?.[1]);
    const from = Number(ev.tags?.find((t) => t[0] === "f")?.[1]);
    if (!Number.isInteger(from) || from < 1) return;
    if (to !== 0 && to !== this.opts.mySlot()) return;
    let plain: unknown;
    try {
      plain = await this.decrypt(ev.content);
    } catch {
      return; // outra sala, ou lixo
    }
    this.opts.onMessage(from, plain);
  }

  // to = 0 → todos da sala (usado para o "olá" da reserva de vaga).
  async send(to: number, msg: unknown): Promise<boolean> {
    if (this.closed || !this.aesKey) return false;
    const content = await this.encrypt(msg);
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [
      ["h", this.opts.topic],
      ["t", String(to)],
      ["f", String(this.opts.mySlot())],
      ["expiration", String(created_at + MAX_AGE_S)],
    ];
    const serialized = JSON.stringify([0, this.pubkey, created_at, KIND, tags, content]);
    const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
    const sig = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(serialized)), this.secret));
    const event: NostrEvent = { id, pubkey: this.pubkey, created_at, kind: KIND, tags, content, sig };
    const payload = JSON.stringify(["EVENT", event]);
    let sent = false;
    for (const ws of this.sockets.values()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
        sent = true;
      } catch {
        /* relay caiu; outro leva */
      }
    }
    return sent;
  }

  private async encrypt(msg: unknown): Promise<string> {
    const iv = randomBytes(12);
    const data = new TextEncoder().encode(JSON.stringify(msg));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, this.aesKey!, data as BufferSource));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return b64(out);
  }

  private async decrypt(content: string): Promise<unknown> {
    const bytes = unb64(content);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, this.aesKey!, ct as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain));
  }
}
