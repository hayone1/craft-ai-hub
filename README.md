# craft-ai-hub

A front door for the [storytold craft apps](https://github.com/storytold) (PhotoCraft,
VectorCraft, LightCraft, FilmCraft, EffectCraft and the rest) with an AI assistant built in.

- **Launcher**: one page that lists your apps.
- **Proxy**: serves every app under `/<app>/` from its own container, by URL or port.
- **Assistant overlay**: a chat on top of every app that collapses to an "Ask AI" button, floats
  (drag, resize) or docks to the side while the canvas makes room. The apps carry no chat code.
- **Chat on Claude Code**: replies come from Claude Code signed in with a Claude subscription
  (each person's own, or one shared by the hub), so you don't need an API key. Claude works on
  the document open in your tab.
- **Your own Claude Code too**: the overlay's Connect tab gives each tab its own MCP URL and a
  `claude mcp add` command, so a Claude Code session or a claude.ai connector can drive several
  tabs and apps at once.

Works from any browser, an iPad included: the app runs in the tab, Claude runs on the server.

## How it works

```
browser ──▶ craft-ai-hub ──▶ /<app>/        app containers (hayone/<app>:remote)
               │         ──▶ /_relay/…      craft-mcp: the tab's WebSocket and the MCP endpoints
               └─ chat: Claude Code ──MCP──▶ craft-mcp ──▶ app CLI ──▶ the user's tab
```

- [craft-mcp](https://github.com/hayone1/Docker_Images/tree/main/craft-mcp) relays MCP calls
  to the tab. Each browser mints its own signed, expiring relay key per app, and chats are tied
  to that key, so no two browsers or users share a session.
- The `:remote` app images (built in [hayone1/Docker_Images](https://github.com/hayone1/Docker_Images))
  add the page API and MCP connector the overlay uses. Apps without them still open from the
  launcher, without the assistant.

## Run it

Pick an example, copy its `.env.example` to `.env`, fill it in, and `docker compose up -d`:

| Example | For |
| --- | --- |
| [basic-auth](examples/basic-auth) | Trying it out: everything on one machine, user names and passwords in `BASIC_AUTH` |
| [caddy-https](examples/caddy-https) | Your own domain with automatic HTTPS (Caddy, Let's Encrypt) and basic auth |
| [oauth2-proxy](examples/oauth2-proxy) | Sign-in with your OpenID Connect provider (Google, Entra, Keycloak, Authentik, …) through [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) |
| [cloud-storage](examples/cloud-storage) | Sign-in through craft-mcp plus personal and shared cloud folders in an S3 bucket, for Open and Save |
| [external-apps](examples/external-apps) | Apps that already run elsewhere (other ports or servers): just the hub and the relay |
| [kubernetes](examples/kubernetes) | The hub, the relay and an app as Deployments, behind an Ingress |

Each one publishes only the front door; the apps and the relay stay on the private network.

## Claude accounts

Chat runs on Claude subscription tokens from Claude Code. Create one on any computer signed in
to Claude Code (Pro or Max plan):

```sh
claude setup-token
```

`CHAT_TOKENS` decides whose account a chat uses:

| `CHAT_TOKENS` | |
| --- | --- |
| `personal` | Everyone adds their own token in the overlay's **Account** tab. The default without a shared token. |
| `both` | Their own token if they added one, otherwise the hub's `CLAUDE_CODE_OAUTH_TOKEN`. The default with one. |
| `shared` | Everyone uses `CLAUDE_CODE_OAUTH_TOKEN`. |
| `off` | No in-app chat; the Connect tab still works. |

A personal token stays in that person's browser: the hub encrypts it (AES-GCM, `HUB_SECRET`) into
an HttpOnly cookie that only `/_hub/` receives, so neither the apps' scripts nor the hub's disk
ever hold it. People set it up once per browser, from a computer, and then chat from anywhere,
an iPad included.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `APPS` | (required) | `name=url` pairs: `photocraft=http://photocraft:8080,vectorcraft=http://localhost:8082`. Order is the launcher's. |
| `RELAY_URL` | | craft-mcp's internal URL. Without it there is no assistant. |
| `MCP_KEY` | | The same value craft-mcp has. craft-mcp's `PUBLIC_HOST` must be `<hub origin>/_relay`. |
| `CHAT_TOKENS` | `personal`, or `both` with a shared token | Whose Claude account chats use (see above). |
| `CLAUDE_CODE_OAUTH_TOKEN` | | The hub's shared token. |
| `HUB_SECRET` | derived from `MCP_KEY` | Encrypts personal tokens. Changing it signs every browser's token out. |
| `CHAT_MODEL`, `CHAT_EFFORT` | Claude Code's | Model and effort for chat. |
| `BASIC_AUTH` | | `user:password` pairs, comma separated. |
| `REQUIRE_SIGN_IN` | `false` | `true` signs people in through craft-mcp's own OpenID Connect client (its `AUTH_*` settings). |
| `PUBLIC_ORIGIN` | from the request | `https://<host>`, used for the sign-in callback. |
| `PORT` | `8080` | |

### Sign-in

Choose one:

- **An auth proxy (recommended)**: oauth2-proxy, Pomerium, Authelia, Cloudflare Access, or your
  ingress's auth. Let `/_relay/` through without sign-in: MCP clients and the tab's WebSocket
  authenticate with their relay key, and claude.ai connectors can't sign in.
- **`BASIC_AUTH`**: built in. `/_relay/` and `/healthz` stay open for the same reason.
- **`REQUIRE_SIGN_IN`**: if craft-mcp already signs people in for cloud storage, the hub can use
  that session. Register `<hub origin>/_storage/callback` with the provider.

Keep the hub private. Claude subscription tokens are for personal use: with a shared token, every
chat on the hub uses that one plan.

## Routes

| Path | |
| --- | --- |
| `/` | Launcher |
| `/<app>/…` | The app, with the overlay injected into its pages |
| `/<app>/_assistant/session` | Mints the tab's relay key (craft-mcp `/mint`) |
| `/<app>/_storage/…`, `/_storage/…` | craft-mcp cloud storage and its sign-in |
| `/_relay/…` | craft-mcp: the tab's WebSocket, `/<key>/<app>/mcp` |
| `/_hub/overlay.js`, `/_hub/chat`, `/_hub/token` | The overlay, its chat, and the person's own token |
| `/healthz` | Health check |

## Develop

```sh
npm install
APPS=photocraft=http://localhost:4101 node server.mjs
```

Node 22. No build step: `server.mjs` (proxy, launcher, auth), `chat.mjs` (Claude Code),
`public/overlay.js` (the overlay).

## License

[MIT](LICENSE). The craft apps themselves are © their authors under their own licenses
(MIT or Apache-2.0); see [storytold](https://github.com/storytold).
