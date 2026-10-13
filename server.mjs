// craft-ai-hub: one front door for the craft web apps. It lists them, proxies each one under
// /<app>/, and injects an AI assistant overlay (public/overlay.js) into their pages. The overlay's
// chat runs here on Claude Code and drives the app over MCP through the craft-mcp relay.
//
//   /                          launcher
//   /<app>/...                 the app (APPS), with the overlay injected into its HTML
//   /<app>/_assistant/session  a relay connection for the tab (craft-mcp /mint)
//   /<app>/_storage/...        cloud storage (craft-mcp /storage/<app>/...)
//   /_storage/...              sign-in and its callback, for every app
//   /_relay/...                craft-mcp itself: the tab's WebSocket and the MCP endpoints
//   /_hub/overlay.js, /_hub/chat
//
// Environment (see README.md):
//   APPS                     photocraft=http://photocraft:8080,vectorcraft=http://localhost:8082,...
//   RELAY_URL, MCP_KEY       craft-mcp's internal URL and its MCP_KEY (optional: no assistant)
//   CLAUDE_CODE_OAUTH_TOKEN  from `claude setup-token`; enables chat (CHAT_MODEL, CHAT_EFFORT optional)
//   BASIC_AUTH               user:password[,user:password...]
//   REQUIRE_SIGN_IN          "true": craft-mcp's OpenID Connect sign-in
//   PUBLIC_ORIGIN            https://<this host>, when the forwarded headers don't say it
//   PORT                     default 8080
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import zlib from "node:zlib";
import { chatEnabled, handleChat } from "./chat.mjs";

const CATALOG = {
  photocraft: ["PhotoCraft", "Image editing, Photoshop-style"],
  vectorcraft: ["VectorCraft", "Vector illustration, Illustrator-style"],
  lightcraft: ["LightCraft", "Photo library and developing, Lightroom-style"],
  filmcraft: ["FilmCraft", "Video editing, Premiere-style"],
  effectcraft: ["EffectCraft", "Motion graphics and effects"],
  designcraft: ["DesignCraft", "Graphic design and layout"],
  pdfcraft: ["PDFCraft", "PDF viewing and editing, Acrobat-style"],
  figcraft: ["FigCraft", "Interface design and prototyping"],
  gridcraft: ["GridCraft", "Spreadsheets, Excel-style"],
  cadcraft: ["CADCraft", "Computer-aided design and drafting"],
  deckcraft: ["DeckCraft", "Presentations, PowerPoint-style"],
  soundcraft: ["SoundCraft", "Audio recording and editing"],
  wordcraft: ["WordCraft", "Documents, Word-style"],
};

const APPS = new Map((process.env.APPS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
  const at = entry.indexOf("=");
  const name = entry.slice(0, at).trim();
  const [title, description] = CATALOG[name] ?? [name[0].toUpperCase() + name.slice(1), ""];
  return [name, { name, title, description, upstream: new URL(entry.slice(at + 1).trim()) }];
}));
if (!APPS.size) throw new Error("APPS is empty; e.g. APPS=photocraft=http://photocraft:8080");
for (const name of APPS.keys()) if (!/^[a-z0-9-]+$/.test(name) || name.startsWith("_")) throw new Error(`APPS: bad app name ${name}`);

const RELAY = process.env.RELAY_URL ? new URL(process.env.RELAY_URL) : null;
const SECRET = process.env.MCP_KEY ?? "";
const SIGN_IN = process.env.REQUIRE_SIGN_IN === "true";
if (SIGN_IN && !RELAY) throw new Error("REQUIRE_SIGN_IN needs RELAY_URL");
const USERS = (process.env.BASIC_AUTH ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
  if (pair.indexOf(":") < 1) throw new Error("BASIC_AUTH: expected user:password pairs");
  return Buffer.from(pair);
});
const origin = (req) => process.env.PUBLIC_ORIGIN?.replace(/\/$/, "")
  || `${String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]}://${String(req.headers["x-forwarded-host"] ?? req.headers.host).split(",")[0]}`;
const OVERLAY = readFileSync(new URL("./public/overlay.js", import.meta.url));

// A relay key (<expiry>.<nonce>.<signature>, signed with MCP_KEY by craft-mcp) that is still valid:
// chat only runs for a tab that holds one.
const validKey = (key) => {
  const [expiry, nonce, signature = ""] = key.split(".");
  const expected = createHmac("sha256", SECRET).update(`${expiry}.${nonce}`).digest("base64url").slice(0, 32);
  return Number(expiry) * 1000 >= Date.now() && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

// ---- proxying -------------------------------------------------------------------------------
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "x-gateway-secret"]);

function forward(req, res, target, { headers = {}, onResponse } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) out[k] = v;
  Object.assign(out, {
    host: target.host,
    "x-forwarded-host": req.headers.host ?? "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? "http",
    "x-forwarded-for": [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", "),
  }, headers);
  const up = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers: out }, (r) => {
    if (onResponse?.(r)) return;
    const h = { ...r.headers };
    for (const k of HOP) delete h[k];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on("error", (e) => {
    console.error(`proxy ${target.href}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("The app isn't reachable.");
    else res.destroy();
  });
  req.pipe(up);
}

// The app's HTML gets the overlay: craftHub settings first (craft-remote.js then leaves the UI to
// the overlay), the overlay script last.
function injectInto(app) {
  return (req, res) => (r) => {
    if (!/^text\/html/i.test(r.headers["content-type"] ?? "")) return false;
    const chunks = [];
    const enc = r.headers["content-encoding"];
    const body = enc === "gzip" ? r.pipe(zlib.createGunzip()) : enc === "br" ? r.pipe(zlib.createBrotliDecompress()) : enc === "deflate" ? r.pipe(zlib.createInflate()) : r;
    body.on("data", (c) => chunks.push(c));
    body.on("error", () => res.headersSent || res.writeHead(502).end());
    body.on("end", () => {
      const settings = JSON.stringify({ app: app.name, title: app.title, chat: chatEnabled && Boolean(RELAY) }).replace(/</g, "\\u003c");
      const html = Buffer.concat(chunks).toString("utf8")
        .replace(/<head(\s[^>]*)?>/i, (m) => `${m}<script>window.craftHub=${settings}</script>`)
        .replace(/<\/head>/i, '<script src="/_hub/overlay.js" defer></script></head>');
      const h = { ...r.headers, "content-length": Buffer.byteLength(html) };
      for (const k of [...HOP, "content-encoding", "etag"]) delete h[k];
      res.writeHead(r.statusCode, h).end(html);
    });
    return true;
  };
}

const relayUrl = (path, search = "") => new URL(path.replace(/^\/?/, "/") + search, RELAY);

// ---- sign-in ----------------------------------------------------------------------------------
const signedIn = new Map(); // cookie -> expiry of a positive check
async function isSignedIn(req) {
  if (!SIGN_IN) return true;
  const cookie = req.headers.cookie ?? "";
  if (!cookie.includes("craft_session=")) return false;
  if ((signedIn.get(cookie) ?? 0) > Date.now()) return true;
  const ok = await new Promise((resolve) => {
    const r = httpRequest(relayUrl("/session/check"), { headers: { cookie, "x-gateway-secret": SECRET } }, (res) => { res.resume(); resolve(res.statusCode === 204); });
    r.on("error", () => resolve(false));
    r.end();
  });
  if (ok) signedIn.set(cookie, Date.now() + 60_000);
  return ok;
}
const signInPage = (res) => res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(
  `<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="background:#1c1c1c">` +
  `<script>location.replace("/_storage/login?return=" + encodeURIComponent(location.pathname + location.search + location.hash))</script>`);

// craft-mcp's storage and sign-in for `app`; the callback comes back to this origin's /_storage/.
const storage = (req, res, app, rest, search) => forward(req, res, relayUrl(`/storage/${app}/${rest}`, search), {
  headers: { "x-gateway-secret": SECRET, "x-craft-origin": origin(req) },
});

// BASIC_AUTH: every route but /healthz and /_relay (MCP clients and the tab's WebSocket carry a
// relay key instead; claude.ai cannot send basic auth).
const basicOk = (req) => {
  if (!USERS.length) return true;
  const [scheme, value = ""] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic") return false;
  const given = Buffer.from(value, "base64");
  return USERS.some((u) => u.length === given.length && timingSafeEqual(u, given));
};
const askBasic = (res) => res.writeHead(401, { "www-authenticate": 'Basic realm="Craft apps", charset="UTF-8"', "content-type": "text/plain" }).end("Sign in to continue.");

// ---- launcher -------------------------------------------------------------------------------
const launcher = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Craft apps</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #17181b; color: #e6e6e8; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { margin: 0 0 4px; font-size: 26px; font-weight: 650; letter-spacing: -.01em; }
  .lede { margin: 0 0 32px; color: #9b9ca3; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  a.card { display: flex; gap: 14px; align-items: flex-start; padding: 16px; border-radius: 14px; background: #1f2024; border: 1px solid #2c2d33;
    color: inherit; text-decoration: none; transition: border-color .15s, transform .15s, background .15s; }
  a.card:hover, a.card:focus-visible { border-color: #4a6f99; background: #23252a; transform: translateY(-1px); outline: none; }
  .icon { flex: none; width: 44px; height: 44px; border-radius: 11px; display: grid; place-items: center; font-weight: 700; font-size: 18px; color: #fff; }
  .name { font-weight: 600; }
  .desc { color: #9b9ca3; font-size: 13px; }
  .note { margin-top: 32px; color: #74757c; font-size: 13px; }
  .note .spark { color: #d97757; }
</style></head>
<body><main>
  <h1>Craft apps</h1>
  <p class="lede">Pick an app to open it in this tab.</p>
  <div class="grid">${[...APPS.values()].map((a, i) => `
    <a class="card" href="/${esc(a.name)}/"><span class="icon" style="background:hsl(${(i * 47 + 200) % 360} 55% 42%)">${esc(a.title[0])}</span>
      <span><div class="name">${esc(a.title)}</div><div class="desc">${esc(a.description)}</div></span></a>`).join("")}
  </div>
  ${RELAY ? `<p class="note"><span class="spark">✦</span> Inside an app, the Ask AI button opens the assistant${chatEnabled ? "" : " (connect AI apps over MCP; in-app chat is not set up)"}.</p>` : ""}
</main></body></html>`;

// ---- server -----------------------------------------------------------------------------------
const readJson = async (req) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1 << 20) throw new Error("too large");
  }
  return JSON.parse(body || "{}");
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://hub");
    const path = url.pathname;
    if (path === "/healthz") return res.end("ok");
    if (path === "/_hub/overlay.js") {
      return res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(OVERLAY);
    }
    if (path.startsWith("/_relay/")) {
      if (!RELAY) return res.writeHead(404).end();
      return forward(req, res, relayUrl(path.slice("/_relay".length), url.search));
    }
    if (!basicOk(req)) return askBasic(res);
    if (path.startsWith("/_storage/")) {
      if (!RELAY) return res.writeHead(404).end();
      return storage(req, res, [...APPS.keys()][0], path.slice("/_storage/".length), url.search);
    }
    if (path === "/_hub/chat") {
      if (req.method !== "POST") return res.writeHead(405).end();
      if (!(await isSignedIn(req))) return json(res, 401, { error: "Sign in first." });
      if (!chatEnabled || !RELAY) return json(res, 503, { error: "Chat is not set up on this hub: it needs a Claude Code token (claude setup-token)." });
      const body = await readJson(req);
      const app = APPS.get(body.app);
      if (!app || typeof body.chat !== "string" || body.chat.length > 64) return res.writeHead(400).end();
      // The tab's public MCP URL (.../<key>/<app>/mcp) on the relay's internal address.
      const m = /\/([^/]+)\/([a-z0-9-]+)\/mcp$/.exec(String(body.mcp ?? ""));
      if (!m || m[2] !== app.name || !validKey(m[1])) return json(res, 403, { error: "This tab's assistant connection is not valid; reconnect it." });
      const mcpUrl = relayUrl(`/${m[1]}/${m[2]}/mcp`).href;
      return handleChat(res, body, { app: app.name, title: app.title, description: app.description, key: m[1], mcpUrl });
    }
    if (path === "/") {
      if (!(await isSignedIn(req))) return signInPage(res);
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(launcher());
    }

    const [, name, ...rest] = path.split("/");
    const app = APPS.get(name);
    if (!app) return res.writeHead(404, { "content-type": "text/plain" }).end("No such app.");
    if (!rest.length) return res.writeHead(301, { location: `/${name}/${url.search}` }).end();
    const sub = `/${rest.join("/")}`;

    if (sub.startsWith("/_storage/")) {
      if (!RELAY) return res.writeHead(404).end();
      return storage(req, res, name, sub.slice("/_storage/".length), url.search);
    }
    if (!(await isSignedIn(req))) return signInPage(res);
    if (sub === "/_assistant/session") {
      if (!RELAY || req.method !== "POST") return res.writeHead(404).end();
      return forward(req, res, relayUrl("/mint", `?app=${encodeURIComponent(name)}&hours=${encodeURIComponent(url.searchParams.get("hours") ?? "168")}`), {
        headers: { "x-gateway-secret": SECRET },
      });
    }
    return forward(req, res, new URL(sub + url.search, app.upstream), { onResponse: injectInto(app)(req, res) });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

// WebSockets: the tab's relay connection (/_relay/<key>/tab/<app>) and any the apps open.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://hub");
  let target;
  if (url.pathname.startsWith("/_relay/") && RELAY) target = relayUrl(url.pathname.slice("/_relay".length), url.search);
  else if (basicOk(req)) {
    const [, name, ...rest] = url.pathname.split("/");
    const app = APPS.get(name);
    if (app && rest.length) target = new URL(`/${rest.join("/")}${url.search}`, app.upstream);
  }
  if (!target) return socket.destroy();
  const headers = { ...req.headers, host: target.host };
  delete headers["x-gateway-secret"];
  const up = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers });
  up.on("upgrade", (r, upSocket, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
  });
  up.on("response", (r) => { socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`); });
  up.on("error", () => socket.destroy());
  up.end();
});

server.listen(Number(process.env.PORT) || 8080, () => {
  console.log(`craft-ai-hub: ${[...APPS.keys()].join(", ")}; relay ${RELAY ? RELAY.href : "off"}; chat ${chatEnabled && RELAY ? "on" : "off"}`);
});
