// NitroCall — TURN credentials Worker (Cloudflare).
//
// NitroCall's only piece of "server", and only for the rare case where two devices can't get
// a direct link nor a friend bridge. It:
//   - keeps the TURN key (the app is public; the key can't live in it);
//   - hands out TEMPORARY credentials (a few hours);
//   - never receives rooms, names, audio or video; stores nothing; has no database.
// Media relayed by TURN stays end-to-end encrypted (DTLS-SRTP): TURN only forwards packets it
// cannot open.
//
// Secrets (wrangler secret put): TURN_KEY_ID, TURN_KEY_API_TOKEN.
// Optional: EXTRA_ORIGINS (comma-separated), DISABLED="1" (kill switch),
// LIMITER binding (per-IP rate limit; see wrangler.toml).

const TTL_S = 4 * 3600; // credential lifetime
const SHARE_MS = 15 * 60 * 1000; // the same credential is served to everyone for up to 15 min

// Who may ask from a browser: the site, NitroCall.html opened from disk ("null") and the app.
const ALLOWED = new Set([
  "https://devtraldi.github.io",
  "null",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
]);

let cache = null; // { iceServers, until, expiresAt }

function corsFor(origin, env) {
  const extra = String(env.EXTRA_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ALLOWED.has(origin) && !extra.includes(origin)) return null;
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

// Two API endpoints (the newer returns a ready list; the older, a single object).
async function freshCredentials(env) {
  const keyId = String(env.TURN_KEY_ID ?? "").trim();
  const token = String(env.TURN_KEY_API_TOKEN ?? "").trim();
  if (!keyId || !token) throw new Error("missing TURN_KEY_ID/TURN_KEY_API_TOKEN secrets");
  let last = "";
  for (const path of ["generate-ice-servers", "generate"]) {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_S }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.iceServers) return data.iceServers;
      last = `${path}: response without iceServers`;
      continue;
    }
    // Cloudflare's message helps diagnose problems (it doesn't contain the secrets).
    last = `${path}: cloudflare ${res.status} ${(await res.text()).slice(0, 200)}`;
  }
  throw new Error(last);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") ?? "";
    const cors = corsFor(origin, env);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: cors ? 204 : 403,
        headers: { ...(cors ?? {}), "Access-Control-Allow-Methods": "POST", "Access-Control-Max-Age": "86400" },
      });
    }
    if (req.method !== "POST") return new Response("NitroCall TURN credentials: use POST.\n", { status: 405 });
    if (!cors) return new Response("origin not allowed\n", { status: 403 });
    if (env.DISABLED === "1") return new Response("disabled\n", { status: 503, headers: cors });

    if (env.LIMITER) {
      const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return new Response("slow down\n", { status: 429, headers: cors });
    }

    const now = Date.now();
    if (!cache || now >= cache.until) {
      try {
        const iceServers = await freshCredentials(env);
        cache = { iceServers, until: now + SHARE_MS, expiresAt: now + TTL_S * 1000 };
      } catch (err) {
        return new Response(`upstream error: ${err.message}\n`, { status: 502, headers: cors });
      }
    }
    // Remaining lifetime of the cached credential (the app renews before it ends).
    const ttl = Math.floor((cache.expiresAt - now) / 1000);
    return new Response(JSON.stringify({ iceServers: cache.iceServers, ttl }), {
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
};
