// Nome aleatório de quem entra: peça de pôquer + um complemento engraçado. Em português
// o complemento não concorda em gênero ("de Pijama", "Sem Wi-Fi"), então qualquer par
// funciona. Não repete no mesmo aparelho até esgotar as combinações; na sala, quem
// chegou depois troca de nome se colidir (ver main.ts).
import { getLang, type Lang } from "./i18n";

const PIECES: Record<Lang, string[]> = {
  pt: [
    "Ás", "Coringa", "Blefe", "Valete", "Dama", "Rei", "Flush", "Straight", "Full House", "All-in",
    "Dealer", "Croupier", "Ficha", "Trinca", "Par de Ases", "Big Blind", "Small Blind", "River",
    "Flop", "Kicker", "Pote", "Baralho", "Royal Flush", "Quadra",
  ],
  en: [
    "Ace", "Joker", "Bluff", "Jack", "Queen", "King", "Flush", "Straight", "Full House", "All-In",
    "Dealer", "Chip", "Big Blind", "Small Blind", "River", "Flop", "Kicker", "Pot", "Deck",
    "Royal Flush", "Pocket Pair", "Wild Card", "Three of a Kind", "Four of a Kind",
  ],
};

const TWISTS: Record<Lang, string[]> = {
  pt: [
    "de Pijama", "Sem Wi-Fi", "de Chinelo", "no Modo Avião", "com Soluço", "de Segunda-feira",
    "Sem Café", "de Óculos Escuros", "Sem Bateria", "de Madrugada", "com Pressa", "no Micro-ondas",
    "de Férias", "que Esqueceu o Mic Aberto", "de Pantufa", "no Karaokê", "na Promoção",
    "do Churrasco", "de Plástico", "de Rodinha", "com Frio na Barriga", "Atrasado pro Jogo",
    "com Medo de Blefe", "com Wi-Fi do Vizinho", "na Chuva", "em Liberdade Condicional",
    "do Grupo da Família", "de Estimação", "no Vácuo", "com 1% de Bateria", "de Sunga",
    "com Cara de Paisagem", "do Paraguai", "sem Fichas", "em Modo Econômico", "com Fone Enrolado",
  ],
  en: [
    "in Pajamas", "Without Wi-Fi", "in Flip-Flops", "on Airplane Mode", "with Hiccups",
    "on a Monday", "Without Coffee", "in Sunglasses", "Out of Battery", "at 3 AM", "in a Hurry",
    "from the Microwave", "on Vacation", "Who Forgot to Mute", "in Slippers", "at Karaoke",
    "on Sale", "from the Barbecue", "Made of Plastic", "on Training Wheels", "with Stage Fright",
    "Running Late", "Afraid of Bluffs", "on the Neighbor's Wi-Fi", "in the Rain", "Out on Bail",
    "from the Family Group Chat", "with 1% Battery", "in a Speedo", "with a Poker Face",
    "Out of Chips", "in Low Power Mode", "with Tangled Earbuds", "Who Brought Snacks",
    "on Loan", "in Disguise",
  ],
};

const HISTORY_KEY = "nitrocall.nameHistory";
const HISTORY_MAX = 400;

function randomInt(n: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(name: string): void {
  try {
    const h = loadHistory().filter((x) => x !== name);
    h.push(name);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HISTORY_MAX)));
  } catch {
    /* sem armazenamento: só pode repetir */
  }
}

export function randomName(avoid: Iterable<string> = [], lang: Lang = getLang()): string {
  const taken = new Set([...loadHistory(), ...avoid].map((n) => n.toLowerCase()));
  const pieces = PIECES[lang];
  const twists = TWISTS[lang];
  const total = pieces.length * twists.length;
  // Ponto de partida aleatório e varre todas as combinações: acha uma livre se existir.
  const start = randomInt(total);
  const stride = 7919; // primo, espalha a varredura
  for (let i = 0; i < total; i++) {
    const k = (start + i * stride) % total;
    const name = `${pieces[Math.floor(k / twists.length)]} ${twists[k % twists.length]}`;
    if (name.length <= 40 && !taken.has(name.toLowerCase())) {
      remember(name);
      return name;
    }
  }
  // Tudo já usado neste aparelho: recomeça, só evitando os nomes da sala.
  const avoidRoom = new Set([...avoid].map((n) => n.toLowerCase()));
  for (let i = 0; i < 50; i++) {
    const name = `${pieces[randomInt(pieces.length)]} ${twists[randomInt(twists.length)]}`;
    if (!avoidRoom.has(name.toLowerCase())) return name;
  }
  return `${pieces[0]} ${randomInt(1000)}`;
}

// É um nome gerado por nós (em qualquer língua)? Serve para saber se podemos trocá-lo.
export function isGeneratedName(name: string): boolean {
  for (const lang of ["pt", "en"] as Lang[]) {
    for (const p of PIECES[lang]) {
      if (!name.startsWith(`${p} `)) continue;
      if (TWISTS[lang].includes(name.slice(p.length + 1))) return true;
    }
  }
  return false;
}
