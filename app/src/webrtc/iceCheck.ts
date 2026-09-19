// Cada motor valida a lista de servidores ICE do seu jeito: o WebKit (todo navegador do
// iPhone/iPad) recusa na hora, com exceção, o que o Chrome aceita calado — e aí nenhuma
// ligação é criada. Aqui a lista é testada no próprio aparelho: se o motor recusar, testamos
// endereço por endereço e ficamos só com os aceitos, anotando no registro o que caiu e por quê.

export type IceReject = (url: string, why: string) => void;

// Por lista (endereços + formato das credenciais): quais endereços de cada servidor ficam.
// As credenciais mudam a cada renovação, mas o formato não: o resultado vale para as novas.
const decided = new Map<string, string[][]>();
// Hook de teste: finge que este motor recusa endereços que casem com o padrão (simula o WebKit).
declare global {
  interface Window {
    __NITRO_ICE_REJECT__?: string;
  }
}

function errText(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  return `${e?.name ?? "Erro"}: ${e?.message ?? String(err)}`.slice(0, 160);
}

function urlsOf(s: RTCIceServer): string[] {
  return Array.isArray(s.urls) ? s.urls : [s.urls];
}

// Tenta criar (e fechar) uma ligação só para ver se o motor aceita a configuração.
function probe(servers: RTCIceServer[]): string | null {
  const reject = typeof window !== "undefined" ? window.__NITRO_ICE_REJECT__ : undefined;
  if (reject) {
    const re = new RegExp(reject);
    const bad = servers.flatMap(urlsOf).find((u) => re.test(u));
    if (bad) return `SyntaxError: (simulado) recusado: ${bad}`;
  }
  try {
    const pc = new RTCPeerConnection({ iceServers: servers });
    pc.close();
    return null;
  } catch (err) {
    return errText(err);
  }
}

function listKey(servers: RTCIceServer[]): string {
  return servers
    .map((s) => `${urlsOf(s).join(",")}#${String(s.username ?? "").length}/${String(s.credential ?? "").length}`)
    .join(";");
}

function apply(servers: RTCIceServer[], keep: string[][]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  servers.forEach((s, i) => {
    if (keep[i]?.length) out.push({ ...s, urls: keep[i] });
  });
  return out;
}

export function acceptedIceServers(servers: RTCIceServer[], onReject: IceReject): RTCIceServer[] {
  if (typeof RTCPeerConnection === "undefined" || servers.length === 0) return servers;
  const key = listKey(servers);
  const known = decided.get(key);
  if (known) return apply(servers, known);
  if (probe(servers) === null) {
    decided.set(key, servers.map(urlsOf));
    return servers;
  }
  // A lista inteira foi recusada: endereço por endereço.
  const keep: string[][] = servers.map((s) =>
    urlsOf(s).filter((url) => {
      const why = probe([{ ...s, urls: [url] }]);
      if (why !== null) onReject(url, why);
      return why === null;
    }),
  );
  let result = apply(servers, keep);
  // Aceitos um a um, mas não juntos (limite de quantidade?): o maior conjunto que passa.
  if (result.length && probe(result) !== null) {
    const minimal: string[][] = servers.map(() => []);
    servers.forEach((_s, i) => {
      for (const url of keep[i]) {
        const trial = minimal.map((u) => [...u]);
        trial[i].push(url);
        if (probe(apply(servers, trial)) === null) minimal[i].push(url);
      }
    });
    onReject("(combinação)", `lista reduzida a ${minimal.flat().length} endereço(s)`);
    keep.splice(0, keep.length, ...minimal);
    result = apply(servers, keep);
  }
  decided.set(key, keep);
  return result;
}
