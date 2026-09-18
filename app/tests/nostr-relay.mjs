// Relay Nostr mínimo (NIP-01) para os testes: EVENT/REQ/CLOSE, sem verificar assinatura
// e sem persistência além da memória. Simula os relays públicos que o NitroCall usa como
// ponto de encontro de emergência quando o servidor PeerJS está fora do ar.
//
//   node tests/nostr-relay.mjs [porta]
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] || process.env.NOSTR_PORT || 9020);
const wss = new WebSocketServer({ port });
const events = [];
const MAX_EVENTS = 5000;

function matches(ev, filter) {
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.ids && !filter.ids.some((id) => ev.id.startsWith(id))) return false;
  if (filter.authors && !filter.authors.some((a) => ev.pubkey.startsWith(a))) return false;
  if (typeof filter.since === "number" && ev.created_at < filter.since) return false;
  if (typeof filter.until === "number" && ev.created_at > filter.until) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (!k.startsWith("#")) continue;
    const tag = k.slice(1);
    const values = ev.tags.filter((t) => t[0] === tag).map((t) => t[1]);
    if (!v.some((x) => values.includes(x))) return false;
  }
  return true;
}

wss.on("connection", (ws) => {
  const subs = new Map();
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type, a, ...rest] = msg;
    if (type === "EVENT" && a && typeof a === "object") {
      const ev = a;
      if (typeof ev.id !== "string" || typeof ev.kind !== "number") return;
      const ephemeral = ev.kind >= 20000 && ev.kind < 30000;
      if (!ephemeral) {
        events.push(ev);
        while (events.length > MAX_EVENTS) events.shift();
      }
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      for (const client of wss.clients) {
        if (client.readyState !== 1) continue;
        for (const [subId, filters] of client.subs ?? []) {
          if (filters.some((f) => matches(ev, f))) client.send(JSON.stringify(["EVENT", subId, ev]));
        }
      }
    } else if (type === "REQ" && typeof a === "string") {
      const filters = rest.filter((f) => f && typeof f === "object");
      subs.set(a, filters);
      ws.subs = subs;
      for (const ev of events) {
        if (filters.some((f) => matches(ev, f))) ws.send(JSON.stringify(["EVENT", a, ev]));
      }
      ws.send(JSON.stringify(["EOSE", a]));
    } else if (type === "CLOSE" && typeof a === "string") {
      subs.delete(a);
    }
  });
});

console.log(`nostr-relay: ws://localhost:${port}`);
