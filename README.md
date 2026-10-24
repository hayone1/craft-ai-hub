# craft-ai-hub

A front door for the [storytold craft apps](https://github.com/storytold) (PhotoCraft,
VectorCraft, LightCraft, FilmCraft, EffectCraft and the rest) with an AI assistant built in.

- **Launcher**: one page that lists your apps.
- **Proxy**: serves every app under `/<app>/` from its own container, by URL or port.
- **Assistant overlay**: a chat on top of every app that collapses to an "Ask AI" button, floats
  (drag, resize) or docks to the side while the canvas makes room. The apps carry no chat code.
- **Chat on Claude Code or OpenAI Codex**: replies come from Claude Code signed in with a Claude
  subscription (each person's own, or one shared by the hub), or from Codex signed in with the
  person's ChatGPT account, so you don't need an API key. The agent works on the document open in
  your tab, with the app's tools and nothing else.
- **A full chat composer**, like Claude Code's: pick the agent, model and effort, show or hide
  thinking, choose a mode (Manual, Edit automatically, Plan, Bypass permissions; Shift+Tab cycles), attach
  or paste images, stop a reply, expand each tool call's input and result, see tokens and time per
  turn, switch between earlier chats, and use slash commands (`/model`, `/effort`, `/mode`,
  `/clear`, `/compact`, `/help`).
- **Your own Claude Code too**: the overlay's Connect tab gives each tab its own MCP URL and a
  `claude mcp add` command, so a Claude Code session or a claude.ai connector can drive several
  tabs and apps at once.

Works from any browser, an iPad included: the app runs in the tab, Claude runs on the server.

## How it works

```
browser ──▶ craft-ai-hub ──▶ /<app>/        app containers (hayone/<app>:remote)
               │         ──▶ /_relay/…      craft-mcp: the tab's WebSocket and the MCP endpoints
               └─ chat: Claude Code or Codex ──MCP──▶ craft-mcp ──▶ app CLI ──▶ the user's tab
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

## Accounts

`CHAT_PROVIDERS` (default `claude,codex`) lists the agents the composer offers. The model menu
groups their models; picking another agent's model starts a new chat.

### Claude

Claude chats run on Claude subscription tokens from Claude Code. Create one on any computer signed in
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

### ChatGPT (Codex)

Codex chats run on each person's own ChatGPT plan. In the overlay's **Account** tab:

- **Sign in with ChatGPT**: the hub starts Codex's device-code sign-in and shows a link and a
  code. Open the link on any device (the iPad you're on works), sign in and enter the code. If
  ChatGPT refuses the code, turn on device code sign-in for Codex in ChatGPT's security settings.
- **Or paste `auth.json`**: after `codex login` on a computer, paste `~/.codex/auth.json`.

The sign-in is kept in `DATA_DIR`, encrypted with a key that only that browser's HttpOnly cookie
holds, so the disk alone can't open it. Codex refreshes it as it goes, and the hub keeps the
newest copy. Mount a volume at `DATA_DIR` (`/data` in the image) to keep sign-ins and Codex's
chat sessions across restarts; sign-ins unused for 90 days are removed.

Codex runs with its shell, file edits, web search, plugins, browser and sub-agents switched off,
read-only in an empty folder and with none of the hub's environment, so the app's MCP tools are
all it can use. It reaches them through the hub (`/_hub/mcp/…`, from the hub itself only), which
applies the permission mode before each call.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `APPS` | (required) | `name=url` pairs: `photocraft=http://photocraft:8080,vectorcraft=http://localhost:8082`. Order is the launcher's. |
| `RELAY_URL` | | craft-mcp's internal URL. Without it there is no assistant. |
| `MCP_KEY` | | The same value craft-mcp has. craft-mcp's `PUBLIC_HOST` must be `<hub origin>/_relay`. |
| `CHAT_TOKENS` | `personal`, or `both` with a shared token | Whose Claude account chats use (see above). |
| `CLAUDE_CODE_OAUTH_TOKEN` | | The hub's shared token. |
| `HUB_SECRET` | derived from `MCP_KEY` | Encrypts personal tokens and ChatGPT sign-ins. Changing it signs every browser out. |
| `CHAT_PROVIDERS` | `claude,codex` | The agents chat offers, in the menu's order. |
| `CHAT_MODEL`, `CHAT_EFFORT` | Claude Code's | Claude's defaults when the composer leaves them on Default and Auto. |
| `CHAT_MODELS` | Opus, Sonnet, Haiku 5.5, Fable 5.1 | Claude's model menu, as JSON `[{"value": "<model id>", "label": "<name>"}]`. |
| `CODEX_MODEL`, `CODEX_EFFORT` | Codex's | Codex's defaults. |
| `CODEX_MODELS` | GPT-6 Luna, GPT-5.6 Terra, GPT-5.6 Luna | Codex's model menu, same JSON. |
| `DATA_DIR` | `/data` in the image | ChatGPT sign-ins (encrypted) and Codex sessions. |
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
| `/_hub/overlay.js`, `/_hub/chat`, `/_hub/chat/permission`, `/_hub/token` | The overlay, its chat and permission answers, and the person's own Claude token |
| `/_hub/codex`, `/_hub/codex/login` | The person's ChatGPT sign-in (device code or `auth.json`) |
| `/_hub/mcp/<gate>` | Codex's MCP connection to the tab, from the hub itself only |
| `/healthz` | Health check |

## Develop

```sh
npm install
APPS=photocraft=http://localhost:4101 node server.mjs
```

Node 22. No build step: `server.mjs` (proxy, launcher, auth), `chat.mjs` (chat and permission
modes), `claude.mjs` (Claude Code), `codex.mjs` (Codex and ChatGPT sign-in), `seal.mjs`
(encryption), `public/overlay.js` (the overlay).

## License

[MIT](LICENSE). The craft apps themselves are © their authors under their own licenses
(MIT or Apache-2.0); see [storytold](https://github.com/storytold).
