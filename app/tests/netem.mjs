// Emulador de rede para os testes: um "NAT" UDP que fica no meio de cada ligação WebRTC
// e aplica banda, atraso, variação de atraso, perda (inclusive em rajada) e quedas totais.
//
// Como entra no caminho: cada página troca os candidatos ICE remotos (host/udp) pelo
// endereço de um proxy local (ver netemInitScript). O proxy repassa para o candidato
// real a partir de um socket próprio; as respostas voltam pelo mesmo caminho. Os
// candidatos srflx/relay/tcp remotos são descartados, então não sobra caminho direto.
//
//   const net = await startNetem();
//   await net.attach(context, "Ana");          // antes de abrir a página
//   net.setProfile("Ana", "Bia", { rateKbps: 3000, delayMs: 40, lossPct: 1 });
//   net.setProfile("*", "*", { ... });         // padrão para todos os pares
//
import dgram from "node:dgram";

const DEFAULT_PROFILE = { rateKbps: 0, delayMs: 0, jitterMs: 0, lossPct: 0, burstLen: 1, queueMs: 400, down: false };

// Um sentido de um enlace: fila FIFO com taxa (serialização), atraso fixo + variação,
// perda aleatória (em rajadas de burstLen pacotes) e descarte quando a fila passa de
// queueMs (como um roteador doméstico).
class Pipe {
  constructor(getProfile) {
    this.getProfile = getProfile;
    this.nextFree = 0;
    this.lastDeliver = 0;
    this.burstLeft = 0;
    this.stats = { in: 0, out: 0, lost: 0, qdrop: 0, bytes: 0 };
  }

  push(buf, deliver) {
    const p = this.getProfile();
    const now = performance.now();
    this.stats.in++;
    if (p.down) {
      this.stats.lost++;
      return;
    }
    if (this.burstLeft > 0) {
      this.burstLeft--;
      this.stats.lost++;
      return;
    }
    if (p.lossPct > 0 && Math.random() * 100 < p.lossPct / Math.max(1, p.burstLen)) {
      this.burstLeft = Math.max(0, (p.burstLen || 1) - 1);
      this.stats.lost++;
      return;
    }
    let at = now;
    if (p.rateKbps > 0) {
      const ser = (buf.length * 8) / p.rateKbps; // ms
      const start = Math.max(now, this.nextFree);
      if (start - now > p.queueMs) {
        this.stats.qdrop++;
        return;
      }
      this.nextFree = start + ser;
      at = this.nextFree;
    }
    at += p.delayMs + (p.jitterMs > 0 ? Math.random() * p.jitterMs : 0);
    // Sem reordenar: variação de atraso vira atraso, como na maioria das filas reais.
    at = Math.max(at, this.lastDeliver);
    this.lastDeliver = at;
    this.stats.out++;
    this.stats.bytes += buf.length;
    schedule(at, () => deliver(buf));
  }
}

// Agendador com fila ordenada: um timer só para o próximo evento.
const queue = [];
let timer = null;
function schedule(at, fn) {
  let i = queue.length;
  while (i > 0 && queue[i - 1].at > at) i--;
  queue.splice(i, 0, { at, fn });
  arm();
}
function arm() {
  if (timer || !queue.length) return;
  const wait = Math.max(0, queue[0].at - performance.now());
  timer = setTimeout(run, wait < 1 ? 0 : wait);
}
function run() {
  timer = null;
  const now = performance.now() + 0.5;
  while (queue.length && queue[0].at <= now) queue.shift().fn();
  arm();
}

export async function startNetem() {
  const profiles = new Map(); // "de>para" → perfil (usuários ou "*")
  const portOwner = new Map(); // porta local de um candidato → usuário
  const proxies = new Map(); // "viewer|ip:port" → proxy
  const all = [];
  const shared = new Map(); // usuário → fila única do upload dele
  const sharedPipe = (from) => {
    let p = shared.get(from);
    if (!p) {
      p = new Pipe(() => profileFor(from, "*"));
      shared.set(from, p);
    }
    return p;
  };

  const profileFor = (from, to) => ({
    ...DEFAULT_PROFILE,
    ...(profiles.get("*>*") ?? {}),
    ...(profiles.get(`${from}>*`) ?? {}),
    ...(profiles.get(`*>${to}`) ?? {}),
    ...(profiles.get(`${from}>${to}`) ?? {}),
  });

  // Proxy que representa o candidato (ip:port) de `owner` para `viewer`.
  async function makeProxy(viewer, ip, port) {
    const key = `${viewer}|${ip}:${port}`;
    if (proxies.has(key)) return proxies.get(key).port;
    // O proxy escuta no MESMO IP do candidato (o Chromium não manda para 127.0.0.1 a partir
    // de um socket preso ao IP da rede local).
    const front = dgram.createSocket("udp4");
    await new Promise((r) => front.bind(0, ip, r));
    const px = { port: front.address().port, front, egress: new Map(), viewer, target: { ip, port } };
    const owner = () => portOwner.get(port) ?? "?";
    // viewer → owner e owner → viewer. Com `sharedUp` no perfil de quem envia, todo o
    // tráfego que sai dele passa por UMA fila (o upload da casa, dividido entre todos).
    const up = new Pipe(() => profileFor(viewer, owner()));
    const down = new Pipe(() => profileFor(owner(), viewer));
    const pipeFor = (from, to, own) => (profileFor(from, to).sharedUp ? sharedPipe(from) : own);
    px.pipes = { up, down };
    front.on("message", (msg, rinfo) => {
      const src = `${rinfo.address}:${rinfo.port}`;
      let eg = px.egress.get(src);
      if (!eg) {
        const s = dgram.createSocket("udp4");
        eg = { s, ready: new Promise((r) => s.bind(0, "0.0.0.0", r)) };
        px.egress.set(src, eg);
        s.on("message", (back) => pipeFor(owner(), viewer, down).push(back, (b) => front.send(b, rinfo.port, rinfo.address)));
        s.on("error", () => {});
      }
      pipeFor(viewer, owner(), up).push(msg, (b) => eg.ready.then(() => eg.s.send(b, port, ip)));
    });
    front.on("error", () => {});
    proxies.set(key, px);
    all.push(px);
    return px.port;
  }

  return {
    setProfile(from, to, profile) {
      profiles.set(`${from}>${to}`, { ...(profiles.get(`${from}>${to}`) ?? {}), ...profile });
    },
    clearProfiles() {
      profiles.clear();
    },
    stats() {
      const out = {};
      const add = (k, s) => {
        const t = (out[k] ??= { in: 0, out: 0, lost: 0, qdrop: 0, bytes: 0 });
        for (const f of Object.keys(t)) t[f] += s[f];
      };
      for (const px of all) {
        const o = portOwner.get(px.target.port) ?? "?";
        add(`${px.viewer}>${o}`, px.pipes.up.stats);
        add(`${o}>${px.viewer}`, px.pipes.down.stats);
      }
      return out;
    },
    // Liga um contexto do Playwright ao emulador (antes de abrir páginas).
    async attach(context, user) {
      await context.exposeBinding("__netemMap", async (_src, ip, port) => makeProxy(user, ip, Number(port)));
      await context.exposeBinding("__netemLocal", async (_src, port) => {
        portOwner.set(Number(port), user);
      });
      await context.addInitScript(netemInitScript);
    },
    close() {
      for (const px of all) {
        try {
          px.front.close();
        } catch {}
        for (const eg of px.egress.values()) {
          try {
            eg.s.close();
          } catch {}
        }
      }
    },
  };
}

// Roda dentro da página: registra as portas dos candidatos locais e troca os candidatos
// remotos pelos proxies do emulador.
function netemInitScript() {
  const Orig = window.RTCPeerConnection;
  if (!Orig || Orig.__netem) return;
  const parse = (line) => {
    const m = /candidate:\S+ \d+ (udp|tcp) \d+ (\S+) (\d+) typ (\S+)/i.exec(line);
    return m ? { proto: m[1].toLowerCase(), ip: m[2], port: Number(m[3]), typ: m[4] } : null;
  };
  async function rewrite(line) {
    const c = parse(line);
    if (!c) return line;
    if (c.proto !== "udp" || c.typ !== "host" || c.ip.endsWith(".local") || c.ip.includes(":")) return null;
    const port = await window.__netemMap(c.ip, c.port);
    return line.replace(` ${c.ip} ${c.port} typ `, ` ${c.ip} ${port} typ `);
  }
  async function rewriteSdp(sdp) {
    const out = [];
    for (const l of sdp.split("\r\n")) {
      if (l.startsWith("a=candidate:")) {
        const r = await rewrite(l.slice(2));
        if (r) out.push("a=" + r);
      } else out.push(l);
    }
    return out.join("\r\n");
  }
  function Wrapped(...a) {
    const pc = new Orig(...a);
    pc.addEventListener("icecandidate", (e) => {
      const c = e.candidate && parse(e.candidate.candidate);
      if (c && c.typ === "host") void window.__netemLocal(c.port);
    });
    return pc;
  }
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  Wrapped.__netem = true;
  const origAdd = Orig.prototype.addIceCandidate;
  Orig.prototype.addIceCandidate = async function (cand, ...rest) {
    if (cand && cand.candidate) {
      const r = await rewrite(cand.candidate);
      if (!r) return;
      cand = { candidate: r, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex, usernameFragment: cand.usernameFragment };
    }
    return origAdd.call(this, cand, ...rest);
  };
  const origSrd = Orig.prototype.setRemoteDescription;
  Orig.prototype.setRemoteDescription = async function (desc, ...rest) {
    if (desc && desc.sdp && desc.sdp.includes("a=candidate:")) desc = { type: desc.type, sdp: await rewriteSdp(desc.sdp) };
    return origSrd.call(this, desc, ...rest);
  };
  window.RTCPeerConnection = Wrapped;
}
