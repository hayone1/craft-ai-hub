# craft-ai-hub

A front door for the [storytold craft apps](https://github.com/storytold) (PhotoCraft,
VectorCraft, LightCraft, FilmCraft, EffectCraft and the rest) with an AI assistant built in.

- **Launcher**: one page that lists your apps.
- **Proxy**: serves every app under `/<app>/` from its own container, by URL or port.
- **Assistant overlay**: a chat on top of every app that collapses to an "Ask AI" button, floats
  (drag, resize) or docks to the side while the canvas makes room. The apps carry no chat code.
- **Chat on Claude Code**: replies come from Claude Code signed in with your Claude subscription,
  so you don't need an API key. Claude works on the document open in your tab.
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

| Example | Sign-in |
| --- | --- |
| [examples/basic-auth](examples/basic-auth) | User names and passwords in `BASIC_AUTH` |
| [examples/oauth2-proxy](examples/oauth2-proxy) | Your OpenID Connect provider (Google, Entra, Keycloak, …) through [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) |

Both run the hub, craft-mcp and five apps, and publish only the front door.

For in-app chat, create a token on any computer signed in to Claude Code and set it as
`CLAUDE_CODE_OAUTH_TOKEN`:

```sh
claude setup-token
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `APPS` | (required) | `name=url` pairs: `photocraft=http://photocraft:8080,vectorcraft=http://localhost:8082`. Order is the launcher's. |
| `RELAY_URL` | | craft-mcp's internal URL. Without it there is no assistant. |
| `MCP_KEY` | | The same value craft-mcp has. craft-mcp's `PUBLIC_HOST` must be `<hub origin>/_relay`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | | Turns in-app chat on. |
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

Keep the hub private. The chat token is your personal Claude subscription: every chat on the
hub uses your plan, and Anthropic allows that only for your own use.

## Routes

| Path | |
| --- | --- |
| `/` | Launcher |
| `/<app>/…` | The app, with the overlay injected into its pages |
| `/<app>/_assistant/session` | Mints the tab's relay key (craft-mcp `/mint`) |
| `/<app>/_storage/…`, `/_storage/…` | craft-mcp cloud storage and its sign-in |
| `/_relay/…` | craft-mcp: the tab's WebSocket, `/<key>/<app>/mcp` |
| `/_hub/overlay.js`, `/_hub/chat` | The overlay and its chat |
| `/healthz` | Health check |

## Develop

```sh
npm install
APPS=photocraft=http://localhost:4101 node server.mjs
```

Node 22. No build step: `server.mjs` (proxy, launcher, auth), `chat.mjs` (Claude Code),
`public/overlay.js` (the overlay).
