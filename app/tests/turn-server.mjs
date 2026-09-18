// TURN local para os testes + endpoint que imita o Worker de credenciais.
//   node tests/turn-server.mjs <porta TURN> <porta HTTP>
// POST /turn        → {iceServers, ttl} como o Worker (inclui uma URL :53 que o app deve descartar)
// POST /turn-broken → 500 (Worker fora do ar)
import http from "node:http";
import os from "node:os";
import Turn from "node-turn";

const TURN_PORT = Number(process.argv[2] || 3479);
const HTTP_PORT = Number(process.argv[3] || 9030);
const USER = "nitro";
const PASS = "e2e-secret";
// IP da rede local, não 127.0.0.1: com o microfone liberado o Chrome amarra os sockets do
// ICE aos IPs das placas de rede, e dali o loopback não responde.
const IP =
  Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";

const server = new Turn({
  listeningPort: TURN_PORT,
  listeningIps: [IP],
  relayIps: [IP],
  authMech: "long-term",
  credentials: { [USER]: PASS },
  debugLevel: "OFF",
});
server.start();

const httpServer = http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    // /turn-slow: o Worker demora (rede móvel ruim): as primeiras ligações saem sem TURN.
    if (req.url === "/turn" || req.url === "/turn-slow") {
      const delay = req.url === "/turn-slow" ? 4000 : 0;
      const body = JSON.stringify({
          iceServers: {
            urls: [`turn:${IP}:${TURN_PORT}?transport=udp`, `turn:${IP}:53?transport=udp`],
            username: USER,
            credential: PASS,
          },
          ttl: 3600,
        });
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      }, delay);
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(500).end("fora do ar");
  })
  .listen(HTTP_PORT, "127.0.0.1", () => console.log(`turn ${IP}:${TURN_PORT} / http :${HTTP_PORT}`));
// Mesmo serviço em ::1 (navegadores tentam "localhost" pelo IPv6 primeiro).
http.createServer((req, res) => httpServer.emit("request", req, res)).listen(HTTP_PORT, "::1").on("error", () => {});
