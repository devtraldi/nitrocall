// Roteiro de UX no Chrome instalado (janelas de verdade): percorre a interface como uma
// pessoa faria e confere cada resultado. Celular emulado (iPhone) no mesmo roteiro.
//   node tests/ux.mjs            (HEADLESS=1 para não abrir janelas)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const bin = (rel) => fileURLToPath(new URL(`../node_modules/${rel}`, import.meta.url));
const PEER_PORT = 9210;
const VITE_PORT = 1620;
const APP = `http://localhost:${VITE_PORT}/`;
const ROOM = `ux-${Date.now().toString(36)}`;
const HEADLESS = !!process.env.HEADLESS;
const kids = [
  spawn(process.execPath, [bin("peer/dist/bin/peerjs.js"), "--port", String(PEER_PORT)], { stdio: "ignore" }),
  spawn(process.execPath, [bin("vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"], { stdio: "ignore" }),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
let checks = 0;

async function waitHttp(u) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(u)).ok) return;
    } catch {
      /* subindo */
    }
    await sleep(300);
  }
  throw new Error(`sem resposta: ${u}`);
}

async function check(label, fn, timeoutMs = 10000) {
  checks += 1;
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await fn();
      if (last) {
        console.log(`  ✅ ${label}`);
        return last;
      }
    } catch (err) {
      last = String(err).slice(0, 160);
    }
    await sleep(250);
  }
  console.log(`  ❌ ${label} — último valor: ${JSON.stringify(last)}`);
  failures.push(label);
  return null;
}

async function person(name, { device = null, fresh = true } = {}) {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: HEADLESS,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--lang=en-US"],
  });
  const { defaultBrowserType: _d, ...dev } = device ? devices[device] : { viewport: { width: 1280, height: 760 } };
  const context = await browser.newContext({
    ...dev,
    locale: "en-US",
    permissions: ["microphone", "camera", "clipboard-read", "clipboard-write"],
  });
  await context.addInitScript(
    ({ port }) => {
      window.__NITRO_FAKE_SCREEN__ = true;
      window.__NITRO_FAKE_SCREEN_AUDIO__ = true;
      localStorage.setItem("nitrocall.server", `http://localhost:${port}`);
      localStorage.setItem("nitrocall.nostr", "off");
      localStorage.setItem("nitrocall.turn", "off");
    },
    { port: PEER_PORT },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { name, browser, context, page, errors, fresh };
}

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? "", sel);
const visible = (page, sel) => page.isVisible(sel);

try {
  await waitHttp(`http://localhost:${PEER_PORT}/peerjs/id`);
  await waitHttp(APP);

  console.log("\n[U1] Entrada: português por padrão (navegador em inglês), nome sorteado, opções recolhidas");
  const ana = await person("Ana");
  await ana.page.goto(APP);
  await check("Textos em PT mesmo com o navegador em inglês", async () => (await text(ana.page, "#join-form button[type=submit]")) === "Entrar");
  const n1 = await check("Nome sorteado preenchido", async () => (await ana.page.inputValue("#name-input")).trim());
  await ana.page.click("#gen-name-btn");
  await check("🎲 troca o nome", async () => {
    const n2 = await ana.page.inputValue("#name-input");
    return n2 && n2 !== n1;
  });
  await check("Senha escondida em 'Opções'", async () => !(await visible(ana.page, "#password-input")));
  await ana.page.click("#join-more summary");
  await check("'Opções' abre a senha", async () => visible(ana.page, "#password-input"));
  await ana.page.click("#join-more summary");
  await check("Sem botão de convite na tela", async () => !(await ana.page.$("#invite-btn")));
  await ana.page.click('[data-lang="en"]');
  await check("Troca para EN ao vivo", async () => (await text(ana.page, "#join-form button[type=submit]")) === "Join");
  await ana.page.click('[data-lang="pt"]');
  await ana.page.fill("#room-code-input", ROOM);
  await ana.page.fill("#name-input", "Ana");
  await ana.page.click("#join-form button[type=submit]");

  console.log("\n[U2] Na chamada: 4 botões, link da sala copiado com confirmação");
  await check("Barra com 4 botões (mic, compartilhar, ⋯, sair)", async () => {
    const ids = await ana.page.evaluate(() =>
      [...document.querySelectorAll(".controls > button, .controls > .more-wrap > button")]
        .filter((b) => b.getBoundingClientRect().width > 0)
        .map((b) => b.id),
    );
    return JSON.stringify(ids) === JSON.stringify(["toggle-mic-btn", "share-screen-btn", "more-btn", "leave-btn"]) && ids;
  });
  await check("'Online' não aparece quando está tudo bem", async () => !(await visible(ana.page, "#broker-pill")) && (await text(ana.page, "#broker-pill")) === "Online");
  await ana.page.click("#copy-room-btn");
  const link = await check("Clique no nome da sala copia o LINK completo", async () => {
    const clip = await ana.page.evaluate(() => navigator.clipboard.readText());
    // Fora do site (aqui, localhost) o link é sempre o do site público.
    return clip === `https://devtraldi.github.io/nitrocall/#sala=${ROOM}` && clip;
  });
  await check("O botão confirma '✓ Link copiado'", async () => (await text(ana.page, "#copy-feedback")).includes("Link copiado"), 3000);
  await check("Aviso no topo explica o que fazer com o link", async () => (await visible(ana.page, "#toast")) && (await text(ana.page, "#toast")).includes("WhatsApp"), 3000);
  await check("Confirmação some sozinha", async () => (await text(ana.page, "#copy-feedback")) === "", 5000);

  console.log("\n[U3] Quem recebe o link: sala preenchida, só tocar em Entrar; verificação automática");
  const bia = await person("Bia");
  // Mesmo link, mas servido localmente (o site público é outra versão).
  await bia.page.goto(`${APP}#sala=${ROOM}`);
  await check("Link abre com a sala preenchida", async () => (await bia.page.inputValue("#room-code-input")) === ROOM);
  await bia.page.fill("#name-input", "Bia");
  await bia.page.click("#join-form button[type=submit]");
  await check("Ana e Bia se ouvem", async () => {
    const a = await ana.page.evaluate(() => [...document.querySelectorAll("#participants .chip")].find((c) => c.dataset.name === "Bia")?.dataset.audio);
    const b = await bia.page.evaluate(() => [...document.querySelectorAll("#participants .chip")].find((c) => c.dataset.name === "Ana")?.dataset.audio);
    return a === "ok" && b === "ok";
  }, 30000);
  await check("Cadeado de verificado aparece no chip (sem comparar códigos)", async () =>
    ana.page.evaluate(() => [...document.querySelectorAll("#participants .chip")].find((c) => c.dataset.name === "Bia")?.dataset.verified === "ok"), 20000);
  await ana.page.click('#participants .chip[data-name="Bia"]');
  await check("Painel da pessoa diz 'Conexão verificada' e tem volume", async () => {
    const t = await text(ana.page, ".chip-popover");
    return t.includes("Conexão verificada") && (await ana.page.$(".chip-popover input[type=range]")) && t;
  });
  await ana.page.fill(".chip-popover input[type=range]", "40");
  await check("Volume da Bia vai para 40% (só para a Ana)", async () =>
    ana.page.evaluate(() => {
      const chip = [...document.querySelectorAll("#participants .chip")].find((c) => c.dataset.name === "Bia");
      return Math.abs((document.getElementById(`audio-${chip.dataset.slot}`)?.volume ?? 1) - 0.4) < 0.01;
    }));
  await ana.page.mouse.click(5, 300);
  await check("Painel fecha ao tocar fora", async () => !(await ana.page.$(".chip-popover")));

  console.log("\n[U4] Menu ⋯: opções no lugar, idioma, diagnóstico");
  await ana.page.click("#more-btn");
  await check("Menu abre", async () => visible(ana.page, "#more-panel"));
  await check("Menu mostra quem você é", async () => (await text(ana.page, "#self-label")).includes("participante"));
  await check("Qualidade da tela no menu (PC)", async () => visible(ana.page, "#quality-select"));
  const noiseBefore = await text(ana.page, "#noise-btn");
  await ana.page.click("#noise-btn");
  await check("Ruído liga/desliga pelo menu", async () => (await text(ana.page, "#noise-btn")) !== noiseBefore);
  await ana.page.click("#noise-btn");
  await ana.page.click('#more-panel [data-lang="en"]');
  await check("EN ao vivo na chamada (botões e status)", async () =>
    (await text(ana.page, "#leave-btn")) === "Leave" && (await text(ana.page, "#health-pill")).includes("connected"));
  await ana.page.click('#more-panel [data-lang="pt"]');
  await check("Volta para PT", async () => (await text(ana.page, "#leave-btn")) === "Sair");
  await ana.page.click("#diag-copy-btn");
  await check("Copiar diagnóstico copia registro + estado (com TURN e ICE)", async () => {
    const clip = await ana.page.evaluate(() => navigator.clipboard.readText());
    return clip.includes("ESTADO") && clip.includes('"turn"') && clip.length > 500;
  });
  await check("Menu fecha depois de uma ação", async () => !(await visible(ana.page, "#more-panel")));
  await ana.page.click("#more-btn");
  await ana.page.keyboard.press("Escape");
  await check("Esc fecha o menu", async () => !(await visible(ana.page, "#more-panel")));

  console.log("\n[U5] Compartilhar: controles na própria prévia");
  await ana.page.click("#share-screen-btn");
  await check("Prévia aparece com 🔄 e 🔊", async () => (await visible(ana.page, "#switch-screen-btn")) && (await visible(ana.page, "#screen-audio-btn")));
  await check("Bia vê a tela da Ana", async () =>
    bia.page.evaluate(() => {
      const v = document.querySelector(".screen-tile video");
      return !!v && v.videoWidth > 0 && !v.paused;
    }), 20000);
  await ana.page.click("#screen-audio-btn");
  await check("🔊 desliga o som da tela (sem ampliar a prévia)", async () =>
    (await text(ana.page, "#screen-audio-btn")).includes("desligado") && !(await ana.page.evaluate(() => document.querySelector("#self-pip").classList.contains("large"))));
  await ana.page.click("#screen-audio-btn");
  await ana.page.click("#self-pip video");
  await check("Tocar na prévia amplia (e os botões mostram o texto)", async () =>
    ana.page.evaluate(() => document.querySelector("#self-pip").classList.contains("large") && getComputedStyle(document.querySelector("#screen-audio-btn .lbl")).display !== "none"));
  await ana.page.click("#self-pip video");
  await bia.page.click(".screen-tile .fullscreen-btn");
  await check("Tela cheia na tela recebida", async () => bia.page.evaluate(() => !!document.fullscreenElement), 5000);
  await bia.page.keyboard.press("Escape");
  await ana.page.click("#share-screen-btn");
  await check("Parar tira a prévia e a tela da Bia", async () =>
    !(await visible(ana.page, "#self-pip")) && !(await bia.page.$(".screen-tile")), 15000);

  console.log("\n[U6] Celular (iPhone): câmera, virar, barra que cabe na tela");
  const cel = await person("Cel", { device: "iPhone 13" });
  await cel.page.goto(`${APP}#sala=${ROOM}`);
  await check("Aviso de celular na entrada", async () => visible(cel.page, "#mobile-note"));
  await cel.page.fill("#name-input", "Cel");
  await cel.page.click("#join-form button[type=submit]");
  await check("Sem rolagem lateral no celular", async () => cel.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 8000);
  await check("Botão é 'Câmera'", async () => (await text(cel.page, "#share-screen-btn")).includes("Câmera"));
  await check("Barra cabe numa linha", async () =>
    cel.page.evaluate(() => {
      const mids = [...document.querySelectorAll(".controls .ctl")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => {
        const r = b.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      return mids.length === 4 && Math.max(...mids) - Math.min(...mids) < 8;
    }));
  await cel.page.click("#share-screen-btn");
  await check("Ana vê a 'Câmera de Cel'", async () =>
    ana.page.evaluate(() => [...document.querySelectorAll(".screen-name")].some((n) => n.textContent.startsWith("Câmera de Cel"))), 20000);
  await check("Prévia do celular tem 🔄 (virar câmera) e não tem 🔊", async () =>
    (await visible(cel.page, "#switch-screen-btn")) && !(await visible(cel.page, "#screen-audio-btn")));
  await cel.page.click("#switch-screen-btn");
  await check("Virar câmera mantém a transmissão", async () =>
    ana.page.evaluate(() => [...document.querySelectorAll(".screen-tile")].some((t) => t.querySelector(".screen-name")?.textContent.startsWith("Câmera de Cel") && t.dataset.state === "ok")), 20000);
  await cel.page.click("#more-btn");
  await check("Menu do celular sem 'qualidade da tela' e sem mini-janela", async () =>
    (await visible(cel.page, "#more-panel")) && !(await visible(cel.page, "#quality-select")) && !(await visible(cel.page, "#mini-btn")));
  await cel.page.keyboard.press("Escape");
  await cel.page.click("#leave-btn");
  await check("Sair volta para a entrada com a sala preenchida", async () =>
    (await visible(cel.page, "#join-view")) && (await cel.page.inputValue("#room-code-input")) === ROOM);

  console.log("\n[U7] Erros de página");
  for (const u of [ana, bia, cel]) await check(`${u.name}: nenhum erro de JavaScript`, async () => u.errors.length === 0 || (console.log(u.errors), false), 500);
  for (const u of [ana, bia, cel]) await u.browser.close();
} catch (err) {
  console.error(err);
  failures.push(String(err));
} finally {
  for (const k of kids) k.kill();
  console.log(failures.length ? `\n❌ ${failures.length}/${checks} falharam:\n - ${failures.join("\n - ")}` : `\n✅ UX: ${checks} verificações passaram.`);
  process.exit(failures.length ? 1 : 0);
}
