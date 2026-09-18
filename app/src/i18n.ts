// PT/EN. Um dicionário só, com as duas línguas lado a lado, para nunca ficarem fora de
// sincronia. {x} = variável. O registro técnico (🩺) fica em português: é para quem
// cuida do app diagnosticar.

export type Lang = "pt" | "en";

const LANG_KEY = "nitrocall.lang";

const M = {
  // Entrada
  "join.tagline": ["Voz e tela entre amigos. Direto, criptografado, sem conta.", "Voice and screen with friends. Direct, encrypted, no account."],
  "join.room": ["Sala", "Room"],
  "join.roomPh": ["ex: poker-sexta", "e.g. friday-poker"],
  "join.genRoom": ["Gerar um código de sala difícil de adivinhar", "Generate a hard-to-guess room code"],
  "join.name": ["Seu nome", "Your name"],
  "join.genName": ["Outro nome aleatório", "Another random name"],
  "join.options": ["Opções", "Options"],
  "join.password": ["Senha da sala (opcional)", "Room password (optional)"],
  "join.passwordPh": ["todos usam a mesma", "everyone uses the same one"],
  "join.autostart": ["Iniciar com o Windows (na bandeja)", "Start with Windows (in the tray)"],
  "join.enter": ["Entrar", "Join"],
  "join.about": ["Sobre", "About"],
  "join.micError": [
    "Não consegui acessar o microfone. Verifique a permissão do navegador ou do app.",
    "Couldn't access the microphone. Check the browser or app permission.",
  ],
  "join.browserWarn": [
    "Use o Chrome ou o Edge: só neles o som do PC vai junto com a tela.",
    "Use Chrome or Edge: only they send your PC's sound along with the screen.",
  ],
  "join.mobileNote": [
    "No celular: voz, ver as telas e mostrar a câmera. Compartilhar a tela do celular não é possível pelo navegador.",
    "On a phone: voice, watching screens and showing your camera. Browsers can't share a phone's screen.",
  ],
  "build.web": ["navegador", "browser"],
  "build.app": ["app", "app"],

  // Cabeçalho da chamada
  "call.copyRoom": ["Copiar o código da sala", "Copy the room code"],
  "call.invite": ["Convite", "Invite"],
  "call.inviteTitle": ["Copiar um convite para mandar aos amigos", "Copy an invite to send to friends"],
  "call.youAre": ["você é {name}", "you are {name}"],
  "call.youAreSlot": ["você é {name} · participante {slot}", "you are {name} · participant {slot}"],
  "broker.connecting": ["Conectando…", "Connecting…"],
  "broker.connected": ["Online", "Online"],
  "broker.reconnecting": ["Reconectando…", "Reconnecting…"],
  "broker.full": ["Sala cheia", "Room full"],
  "broker.failed": ["Sem servidor", "No server"],
  "health.title": ["Saúde da sala", "Room health"],
  "health.alone": ["✓ Só você", "✓ Just you"],
  "health.aloneTitle": ["Ninguém mais na sala ainda.", "Nobody else in the room yet."],
  "health.all": ["✓ Todos se veem ({n})", "✓ All connected ({n})"],
  "health.allTitle": ["{n} pessoas, todas com caminho entre si. {cap}.", "{n} people, all reachable. {cap}."],
  "health.connecting": ["⏳ Ligando…", "⏳ Connecting…"],
  "health.connectingTitle": ["Ainda ligando alguém. {cap}.", "Still connecting someone. {cap}."],
  "health.gap": ["⚠️ {a} e {b} sem caminho{more}", "⚠️ {a} and {b} can't reach{more}"],
  "health.gapNoBridge": ["{a} e {b} não se alcançam: ninguém na sala consegue fazer ponte", "{a} and {b} can't reach each other: nobody can bridge them"],
  "health.gapSearching": ["{a} e {b} não se alcançam: procurando ponte", "{a} and {b} can't reach each other: looking for a bridge"],
  "health.capOne": ["{n} pode ser ponte", "{n} can bridge"],
  "health.capMany": ["{n} podem ser ponte", "{n} can bridge"],
  "secure.on": ["🔒 Criptografado", "🔒 Encrypted"],
  "secure.onTitle": [
    "Áudio e tela vão criptografados de ponta a ponta (DTLS-SRTP), sem servidor de mídia. Quando um amigo faz ponte, o trecho passa pelo PC dele (que decodifica e recodifica). Pelo TURN, os pacotes passam cifrados: o TURN não consegue ver nem ouvir nada.",
    "Audio and screen are end-to-end encrypted (DTLS-SRTP), with no media server. When a friend bridges, that hop goes through their PC (which decodes and re-encodes). Through TURN the packets stay encrypted: TURN can't see or hear anything.",
  ],
  "secure.pendingTitle": ["Criptografia obrigatória em toda ligação; aguardando as ligações abrirem.", "Encryption is mandatory on every link; waiting for links to open."],

  // Chips
  "chip.you": [" (você)", " (you)"],
  "chip.selfMuted": ["microfone mudo", "mic muted"],
  "chip.selfConn": ["sua conexão: {q}", "your connection: {q}"],
  "chip.selfBridgeOne": ["🌉 você é ponte para {n} par", "🌉 you bridge {n} pair"],
  "chip.selfBridgeMany": ["🌉 você é ponte para {n} pares", "🌉 you bridge {n} pairs"],
  "chip.canBridge": ["pode ser ponte", "can bridge"],
  "chip.noBridge": ["não faz ponte", "doesn't bridge"],
  "chip.yourMic": ["seu microfone", "your mic"],
  "chip.searching": ["sem caminho ainda, procurando…", "no path yet, searching…"],
  "chip.via": [" · via {name}", " · via {name}"],
  "chip.viaTurn": [" · via TURN", " · via TURN"],
  "chip.audioConnecting": ["conectando áudio…", "connecting audio…"],
  "chip.audioReconnecting": ["reconectando áudio…", "reconnecting audio…"],
  "chip.audioQ": ["áudio {q}", "audio {q}"],
  "chip.audioOk": ["áudio ok", "audio ok"],
  "chip.muted": ["mudo", "muted"],
  "chip.hearsYou": [" · te ouve", " · hears you"],
  "chip.away": ["saiu da aba", "left the tab"],
  "chip.awayTitle": [
    "{name} saiu do app/aba no celular. O sistema pode cortar o microfone dele(a) até voltar.",
    "{name} switched away on their phone. The system may cut their mic until they come back.",
  ],
  "chip.relayTitle": ["Sem conexão direta com {name}; o áudio e a tela passam por {via}.", "No direct connection with {name}; audio and screen go through {via}."],
  "chip.turnTitle": [
    "Sem caminho direto nem ponte até {name}: a ligação passa pelo TURN (servidor de repasse), ainda criptografada de ponta a ponta.",
    "No direct path or bridge to {name}: the link goes through TURN (a relay server), still end-to-end encrypted.",
  ],
  "chip.searchingTitle": [
    "{name} está na sala, mas ainda não há caminho até ele(a). Procurando um amigo que sirva de ponte…",
    "{name} is in the room but there's no path to them yet. Looking for a friend to bridge…",
  ],
  "chip.hearTitle": ["Confirmou que está te ouvindo", "Confirmed they can hear you"],
  "chip.hearOn": ["Está te ouvindo", "Hears you"],
  "chip.hearOff": ["Ainda não confirmou que te ouve", "Hasn't confirmed hearing you yet"],
  "chip.seeTitle": ["Confirmou que está vendo sua tela", "Confirmed they see your screen"],
  "chip.seeOn": ["Está vendo sua tela", "Sees your screen"],
  "chip.seeOff": ["Ainda não confirmou que vê sua tela", "Hasn't confirmed seeing your screen yet"],
  "chip.shareTitle": ["Compartilhando a tela", "Sharing their screen"],
  "chip.bridgeTitle": ["Está fazendo ponte para amigos que não se alcançam direto", "Bridging friends who can't reach each other directly"],
  "chip.volumeTitle": ["Volume desta pessoa (só pra você)", "This person's volume (just for you)"],
  "chip.micOn": ["Microfone ligado", "Mic on"],
  "chip.micOff": ["Microfone mudo", "Mic muted"],
  "chip.capText": [" · capacidade de ponte {n}/100", " · bridge capacity {n}/100"],
  "chip.selfSignal": ["Sua conexão{q}{cap}", "Your connection{q}{cap}"],
  "chip.measuring": ["Medindo qualidade…", "Measuring quality…"],
  "chip.signal": ["Latência {rtt} ms{loss}{jit}{cap}", "Latency {rtt} ms{loss}{jit}{cap}"],
  "chip.loss": [" · perda {n}%", " · loss {n}%"],
  "chip.jitter": [" · jitter {n} ms", " · jitter {n} ms"],
  "q.otima": ["ótima", "great"],
  "q.boa": ["boa", "good"],
  "q.fraca": ["fraca", "weak"],
  "q.ruim": ["ruim", "bad"],
  "sec.title": ["Código de segurança com {name}", "Security code with {name}"],
  "sec.hint": [
    "Peça a {name} para tocar no seu nome e ler o código. Se for igual, ninguém está no meio da ligação de vocês.",
    "Ask {name} to tap your name and read the code. If it matches, nobody is in the middle of your call.",
  ],
  "sec.pendingTitle": ["Código de segurança", "Security code"],
  "sec.pending": ["Aparece quando a ligação direta com {name} estiver de pé.", "Shows up once the direct link with {name} is up."],
  "bridge.banner": [
    "🌉 Seu aparelho é a ponte entre {list} (eles não conseguem se ligar direto). Usa um pouco mais da sua internet; se outro amigo tiver condições melhores, a ponte muda sozinha.",
    "🌉 Your device is bridging {list} (they can't connect directly). It uses a bit more of your internet; if a friend has a better setup, the bridge moves automatically.",
  ],
  "bridge.and": ["{a} e {b}", "{a} and {b}"],

  // Palco / telas
  "stage.empty": ["Ninguém está compartilhando.", "Nobody is sharing."],
  "stage.emptyHint": ["Quando alguém compartilhar, aparece aqui.", "When someone shares, it shows up here."],
  "stage.sharing": ["Você está compartilhando; a prévia está no canto.", "You're sharing; the preview is in the corner."],
  "stage.sharingHint": ["As telas dos outros aparecem aqui.", "Other people's screens show up here."],
  "screen.of": ["Tela de {name}", "{name}'s screen"],
  "screen.camOf": ["Câmera de {name}", "{name}'s camera"],
  "screen.via": [" · via {name}", " · via {name}"],
  "screen.receiving": ["Recebendo a tela de {name}…", "Receiving {name}'s screen…"],
  "screen.reconnecting": [" · reconectando…", " · reconnecting…"],
  "screen.res": ["Resolução recebida", "Received resolution"],
  "screen.hasAudio": ["Esta tela vem com som", "This screen has sound"],
  "screen.volume": ["Volume desta tela (só pra você)", "This screen's volume (just for you)"],
  "screen.unmute": ["Ouvir o som desta tela", "Hear this screen's sound"],
  "screen.mute": ["Silenciar o som desta tela (só pra você)", "Mute this screen (just for you)"],
  "screen.fullscreen": ["⛶ Tela cheia", "⛶ Fullscreen"],
  "screen.info": ["Qualidade desta tela, ao vivo", "This screen's live quality"],

  // Controles
  "ctl.mute": ["🎤 Mutar", "🎤 Mute"],
  "ctl.unmute": ["🔇 Ativar mic", "🔇 Unmute"],
  "ctl.share": ["🖥️ Compartilhar", "🖥️ Share"],
  "ctl.camera": ["📷 Câmera", "📷 Camera"],
  "ctl.stop": ["🛑 Parar", "🛑 Stop"],
  "ctl.switch": ["🔄 Trocar tela", "🔄 Switch screen"],
  "ctl.flip": ["🔄 Virar câmera", "🔄 Flip camera"],
  "ctl.leave": ["Sair", "Leave"],
  "ctl.more": ["Mais opções", "More options"],
  "ctl.micSelect": ["Microfone", "Microphone"],
  "ctl.outputSelect": ["Onde ouvir (fones ou caixas)", "Where to listen (headphones or speakers)"],
  "ctl.noiseTitle": [
    "Supressão de ruído por IA (RNNoise): tira ventilador, teclado, rua. Desligue se a sua voz ficar estranha.",
    "AI noise suppression (RNNoise): removes fans, typing, street. Turn off if your voice sounds odd.",
  ],
  "ctl.noise": ["🧹 Ruído", "🧹 Noise"],
  "ctl.noiseOn": ["🧹 Ruído: ligado", "🧹 Noise: on"],
  "ctl.noiseOff": ["🧹 Ruído: desligado", "🧹 Noise: off"],
  "ctl.noiseUnavailable": ["A supressão de ruído não carregou neste aparelho; o microfone vai cru.", "Noise suppression didn't load on this device; the mic goes raw."],
  "ctl.qualityTitle": [
    "Auto: ajusta sozinho se a internet ou o aparelho não aguentarem. Alta = 1080p. Média = 720p. Baixa = 480p. Pode mudar durante o compartilhamento.",
    "Auto: adjusts by itself if the internet or device can't keep up. High = 1080p. Medium = 720p. Low = 480p. Can change while sharing.",
  ],
  "ctl.qualityAria": ["Qualidade da tela compartilhada", "Shared screen quality"],
  "ctl.qAuto": ["Auto", "Auto"],
  "ctl.qAlta": ["Alta (1080p)", "High (1080p)"],
  "ctl.qMedia": ["Média (720p)", "Medium (720p)"],
  "ctl.qBaixa": ["Baixa (480p)", "Low (480p)"],
  "ctl.diag": ["🩺 Registro técnico", "🩺 Technical log"],
  "ctl.diagCopy": ["📋 Copiar diagnóstico", "📋 Copy diagnostics"],
  "ctl.diagSave": ["📥 Baixar registro", "📥 Download log"],
  "ctl.mini": ["🗗 Mini-janela", "🗗 Mini window"],
  "ctl.miniTitle": ["Mini-janela sempre por cima: ver quem fala e mutar enquanto usa outro programa", "Always-on-top mini window: see who's talking and mute while using another app"],
  "ctl.language": ["Idioma", "Language"],
  "ctl.screenAudioNone": ["🔇 Sem som", "🔇 No sound"],
  "ctl.screenAudioNoneTitle": [
    "Esta captura veio sem som. Para transmitir o som (YouTube, jogo), escolha \"Tela inteira\" e marque \"Compartilhar áudio do sistema\". Use fones para evitar eco.",
    "This capture has no sound. To send sound (YouTube, games), pick \"Entire screen\" and tick \"Share system audio\". Use headphones to avoid echo.",
  ],
  "ctl.screenAudioOn": ["🔊 Som da tela", "🔊 Screen sound"],
  "ctl.screenAudioOnTitle": ["O som do seu PC vai junto com a tela. Clique para silenciar.", "Your PC's sound goes with the screen. Click to mute it."],
  "ctl.screenAudioOff": ["🔇 Som da tela desligado", "🔇 Screen sound off"],
  "ctl.screenAudioOffTitle": ["Clique para voltar a transmitir o som do seu PC junto com a tela.", "Click to send your PC's sound with the screen again."],
  "ctl.output": ["🔈 {label}", "🔈 {label}"],
  "ctl.outputN": ["Saída {n}", "Output {n}"],
  "ctl.micN": ["Microfone {n}", "Microphone {n}"],

  // Prévia da própria tela
  "pip.title": ["Prévia do que você está transmitindo (toque pra ampliar)", "Preview of what you're sending (tap to enlarge)"],
  "pip.sharing": ["Você está compartilhando{s}", "You're sharing{s}"],
  "pip.nobody": ["Compartilhando · ninguém na sala ainda{s}", "Sharing · nobody in the room yet{s}"],
  "pip.seenAll": ["Compartilhando · {seen}/{total} vendo ✓{s}", "Sharing · {seen}/{total} watching ✓{s}"],
  "pip.seen": ["Compartilhando · {seen}/{total} vendo…{s}", "Sharing · {seen}/{total} watching…{s}"],
  "pip.withSound": ["com som", "with sound"],
  "pip.noSound": ["sem som", "no sound"],
  "pip.soundOff": ["som desligado", "sound off"],
  "pip.camera": ["câmera", "camera"],

  // Faixas
  "update.available": ["Nova versão do NitroCall ({v}) disponível.", "New NitroCall version ({v}) available."],
  "update.now": ["Atualizar agora", "Update now"],
  "update.installing": ["Baixando e instalando a atualização…", "Downloading and installing the update…"],
  "update.failed": ["A atualização falhou; tente de novo mais tarde.", "The update failed; try again later."],
  "ver.newerWeb": ["{name} está com a versão {v} (a sua é {mine}). Recarregue a página.", "{name} has version {v} (yours is {mine}). Reload the page."],
  "ver.newerApp": ["{name} está com a versão {v} (a sua é {mine}). Atualize o NitroCall.", "{name} has version {v} (yours is {mine}). Update NitroCall."],
  "ver.differentBuild": [
    "⚠ {name} usa um NitroCall {v} com código diferente do seu ({b1} × {b2}). Confira se os dois pegaram da mesma fonte.",
    "⚠ {name} runs NitroCall {v} built from different code than yours ({b1} × {b2}). Check you both got it from the same source.",
  ],

  // Mensagens (aparecem no registro)
  "msg.joining": ["Entrando na sala \"{room}\" como {name}...", "Joining room \"{room}\" as {name}..."],
  "msg.inviteText": ["Entra na minha sala do NitroCall: código \"{code}\"", "Join my NitroCall room: code \"{code}\""],
  "msg.inviteApp": ["Se já tiver o app: {link}", "If you have the app: {link}"],
  "msg.inviteLink": ["Abra no navegador: {link}", "Open in your browser: {link}"],
  "msg.inviteFile": ["Abra o NitroCall.html no Chrome ou no Edge (ou o app) e use esse código.", "Open NitroCall.html in Chrome or Edge (or the app) and use this code."],
  "msg.inviteCopied": ["Convite copiado; cole no WhatsApp para os amigos.", "Invite copied; paste it to your friends."],
  "msg.inviteShared": ["Convite enviado.", "Invite shared."],
  "msg.copyFail": ["Não consegui copiar.", "Couldn't copy."],
  "msg.codeCopied": ["Código \"{code}\" copiado.", "Code \"{code}\" copied."],
  "msg.diagCopied": ["Diagnóstico copiado; cole numa mensagem para quem cuida do app.", "Diagnostics copied; paste it in a message to whoever maintains the app."],
  "msg.logSaved": ["Registro baixado; mande o arquivo para quem cuida do app.", "Log downloaded; send the file to whoever maintains the app."],
  "msg.miniFail": ["Não consegui abrir a mini-janela (precisa de Chrome ou Edge atualizado).", "Couldn't open the mini window (needs an up-to-date Chrome or Edge)."],
  "msg.noiseOn": ["Supressão de ruído ligada.", "Noise suppression on."],
  "msg.noiseOff": ["Supressão de ruído desligada.", "Noise suppression off."],
  "msg.shareCancelled": ["Compartilhamento cancelado.", "Sharing cancelled."],
  "msg.cameraFail": ["Não consegui abrir a câmera. Verifique a permissão.", "Couldn't open the camera. Check the permission."],
  "msg.screenNoAudio": [
    "Tela sem som. Para transmitir o som do PC, escolha \"Tela inteira\" e marque \"Compartilhar áudio do sistema\".",
    "Screen without sound. To send your PC's sound, pick \"Entire screen\" and tick \"Share system audio\".",
  ],
  "msg.screenAudioOn": ["Som da tela ligado.", "Screen sound on."],
  "msg.screenAudioOff": ["Som da tela desligado.", "Screen sound off."],
  "msg.micSwitched": ["Microfone trocado para \"{name}\".", "Microphone switched to \"{name}\"."],
  "msg.micFail": ["Não consegui usar esse microfone: {err}", "Couldn't use that microphone: {err}"],
  "msg.micBack": ["Microfone religado ao voltar para o app.", "Microphone restarted on returning to the app."],
  "msg.outputOk": ["Saída de áudio trocada.", "Audio output switched."],
  "msg.outputFail": ["Não consegui usar essa saída de áudio em todos os sons.", "Couldn't use that output for every sound."],
  "msg.tray": ["Janela escondida na bandeja; a chamada continua. Clique no ícone para voltar.", "Window hidden in the tray; the call continues. Click the icon to come back."],
  "msg.fullscreenFail": ["Este aparelho não deixou abrir em tela cheia.", "This device didn't allow fullscreen."],

  // Mini-janela
  "mini.room": ["Sala {room}", "Room {room}"],
} satisfies Record<string, [string, string]>;

export type Key = keyof typeof M;

function detect(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "pt" || saved === "en") return saved;
  } catch {
    /* sem armazenamento */
  }
  return (navigator.language || "pt").toLowerCase().startsWith("pt") ? "pt" : "en";
}

let lang: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  const pair = M[key];
  let s = pair[lang === "en" ? 1 : 0];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  applyStatic();
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): void {
  listeners.add(fn);
}

// Textos fixos do HTML: data-i18n (texto), data-i18n-title, data-i18n-placeholder,
// data-i18n-aria.
export function applyStatic(root: ParentNode = document): void {
  document.documentElement.lang = lang === "en" ? "en" : "pt-BR";
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n as Key);
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle as Key);
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria as Key));
  for (const el of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder as Key);
  for (const el of root.querySelectorAll<HTMLButtonElement>("[data-lang]")) el.classList.toggle("on", el.dataset.lang === lang);
}
