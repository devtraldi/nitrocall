# TURN credentials Worker

NitroCall tries, in order:

1. **Direct** between devices (the vast majority of calls).
2. **A friend in the room as a bridge**, when two people can't reach each other directly.
3. **TURN**, only when there's no direct path **and** nobody can bridge. The typical case is
   two people alone in a room, both behind restrictive NAT (carrier-grade NAT, corporate or
   university networks).

This Worker makes step 3 possible without putting the TURN key inside the app, which is
public. It returns temporary credentials (4 h) and nothing else. It never sees the room,
names, audio or video, and stores nothing.

## Cost

- **Cloudflare TURN:** 1,000 GB/month free, then US$0.05/GB. Since TURN is only used in the rare
  case above, a group of friends is expected to stay far below that.
- **Workers:** the free plan covers 100k requests/day. Each person makes about 1 request when
  joining and 1 every 3 h.
- **Recommended:** set up a usage/billing alert in the Cloudflare dashboard. If anything looks
  off, `npx wrangler secret put DISABLED` with the value `1` turns the Worker off immediately;
  the app keeps working with direct links and friend bridges only.

## Deploy (once, ~10 minutes)

1. Create a free account at <https://dash.cloudflare.com>.
2. In the dashboard: **Realtime → TURN Server → Create**. Copy the **Turn Token ID** and the
   **API Token**.
3. In this folder:

   ```sh
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put TURN_KEY_ID           # paste the Turn Token ID at the prompt
   npx wrangler secret put TURN_KEY_API_TOKEN    # paste the API Token at the prompt
   ```

   Type the commands exactly as written; paste the values **only** at the `Enter a secret
   value` prompt, never on the command line (the secret's name would become the token).
4. The deploy prints the URL, e.g. `https://nitrocall-turn.<your-subdomain>.workers.dev`. Put it
   in `DEFAULT_TURN_ENDPOINT` (`src/webrtc/turn.ts`) and rebuild the app and the site. If you
   host your own copy, also add your site's origin to `ALLOWED` in `src/index.js` (or the
   `EXTRA_ORIGINS` variable).

Manual check (should answer JSON with `iceServers`):

```sh
curl -X POST -H "Origin: https://devtraldi.github.io" https://nitrocall-turn.<your-subdomain>.workers.dev
```

Other origins get `403`; `GET` gets `405`.

## Your own TURN (without Cloudflare)

Point `DEFAULT_TURN_ENDPOINT` (or the `nitrocall.turn` localStorage key) at any service that
answers `POST` with `{"iceServers": [...], "ttl": seconds}`. With nothing configured, the app
works like before: direct links and friend bridges.
