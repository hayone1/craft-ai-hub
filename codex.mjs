// OpenAI Codex (the Codex SDK, which runs the codex CLI) for chat.mjs, signed in with the person's
// ChatGPT account. Codex gets the app's tools and nothing else: its shell, files, web search,
// plugins and sub-agents are switched off and it runs read-only in an empty folder.
//
// Sign-in: the hub runs `codex login --device-auth`, and the person opens the link it prints on
// any device (an iPad included) and enters the code; or they paste a computer's ~/.codex/auth.json.
// The sign-in is kept on disk (DATA_DIR) encrypted with a key that only their cookie holds, and is
// written back after each chat, since Codex refreshes it.
//
// Permissions: Codex can't ask mid-turn, so it reaches the app through the hub's own MCP endpoint
// (/_hub/mcp/<gate>, loopback only), which asks chat.mjs about every tools/call before passing it
// on to the relay.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Codex } from "@openai/codex-sdk";
import { cookieValue, keyFor, open, seal } from "./seal.mjs";

export const LABEL = "ChatGPT · Codex";
export const SHORT = "Codex";
// CODEX_MODELS (JSON [{value, label}]) replaces the menu. "" is Codex's default.
export const MODELS = process.env.CODEX_MODELS ? JSON.parse(process.env.CODEX_MODELS) : [
  { value: "", label: "Default" },
  { value: "gpt-6-luna", label: "GPT-6 Luna" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_MODEL = process.env.CODEX_MODEL || "";
export const DEFAULT_EFFORT = process.env.CODEX_EFFORT || undefined;

const PORT = Number(process.env.PORT) || 8080;
const DATA = process.env.DATA_DIR || join(tmpdir(), "craft-ai-hub");
const ACCOUNTS = join(DATA, "codex-accounts");
const HOMES = join(DATA, "codex-homes");
const WORKDIR = join(DATA, "codex-work");
for (const d of [ACCOUNTS, HOMES, WORKDIR]) mkdirSync(d, { recursive: true, mode: 0o700 });
const CODEX_JS = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");

// Everything Codex could use besides the app's MCP tools.
const OFF = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "multi_agent", "multi_agent_v2", "collaboration_modes",
  "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation", "view_image", "hooks", "memories",
  "goals", "sleep_tool", "tool_suggest", "default_mode_request_user_input", "request_permissions_tool"];

// The CLI's environment: none of the hub's own (its secrets stay out of reach).
const envFor = (home) => ({
  PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, LANG: process.env.LANG ?? "C.UTF-8",
  ...(process.platform === "win32" && { USERPROFILE: home, SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
});

// ---- accounts ---------------------------------------------------------------------------------
export const COOKIE = "craft_hub_codex";
const fileOf = (a) => join(ACCOUNTS, `${a.uid}.enc`);
export function accountOf(req) {
  const [uid = "", secret = ""] = open(cookieValue(req, COOKIE)).split(".");
  return /^[\w-]{20,}$/.test(uid) && secret ? { uid, key: keyFor(secret) } : null;
}
const readAuth = (a) => { try { return open(readFileSync(fileOf(a), "utf8"), a.key); } catch { return ""; } };
const saveAuth = (a, text) => writeFileSync(fileOf(a), seal(text, a.key), { mode: 0o600 });
export const signedIn = (req) => { const a = accountOf(req); return Boolean(a && readAuth(a)); };
export const validAuth = (text) => {
  try { const j = JSON.parse(text); return Boolean(j?.tokens?.refresh_token || j?.tokens?.access_token); } catch { return false; }
};
// Saves a sign-in under a new account; returns the cookie's value.
export function newAccount(text) {
  const uid = randomBytes(18).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  saveAuth({ uid, key: keyFor(secret) }, text);
  return seal(`${uid}.${secret}`);
}
export function removeAccount(req) {
  const a = accountOf(req);
  if (a) rmSync(fileOf(a), { force: true });
}

// ---- device-code sign-in ----------------------------------------------------------------------
const logins = new Map(); // id -> { proc, state: pending|done|failed, auth, error, until }
const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

export function startLogin() {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(DATA, "login-"));
    const proc = spawn(process.execPath, [CODEX_JS, "login", "--device-auth", "-c", 'cli_auth_credentials_store="file"'], { env: envFor(home), stdio: ["ignore", "pipe", "pipe"] });
    const id = randomBytes(18).toString("base64url");
    const login = { proc, state: "pending", until: Date.now() + 15 * 60_000 };
    let out = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Codex didn't start the sign-in.")); }, 30_000);
    const read = (chunk) => {
      out += plain(chunk.toString());
      const url = /https:\/\/\S+/.exec(out)?.[0];
      const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(out)?.[0];
      if (url && code && !login.url) {
        Object.assign(login, { url, code });
        clearTimeout(timer);
        logins.set(id, login);
        resolve({ id, url, code, expires: login.until });
      }
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", read);
    proc.on("exit", (status) => {
      clearTimeout(timer);
      let auth = "";
      try { auth = readFileSync(join(home, "auth.json"), "utf8"); } catch {}
      rmSync(home, { recursive: true, force: true });
      const last = out.trim().split("\n").filter((l) => l.trim() && !/^WARNING/.test(l)).at(-1)?.trim() ?? "";
      if (status === 0 && validAuth(auth)) Object.assign(login, { state: "done", auth });
      else Object.assign(login, { state: "failed", error: last || "The sign-in didn't finish." });
      if (!login.url) reject(new Error(login.error));
    });
  });
}

// The sign-in's state; once it is done or failed it is handed over once and forgotten.
export function takeLogin(id) {
  const login = logins.get(id);
  if (!login) return { state: "expired" };
  if (login.state === "pending") return { state: "pending" };
  logins.delete(id);
  return login.state === "done" ? { state: "done", auth: login.auth } : { state: "failed", error: login.error };
}

setInterval(() => {
  for (const [id, login] of logins) if (login.until < Date.now()) { login.proc.kill(); logins.delete(id); }
}, 60_000).unref();

// Sign-ins unused for 90 days (a browser that lost its cookie) and Codex sessions idle for a week
// (chats the hub forgot when it restarted) are removed.
const sweep = () => {
  for (const [dir, days] of [[ACCOUNTS, 90], [HOMES, 7]]) {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try { if (Date.now() - statSync(f).mtimeMs > days * 86400_000) rmSync(f, { recursive: true, force: true }); } catch {}
    }
  }
};
sweep();
setInterval(sweep, 86400_000).unref();

// ---- the permission gate between Codex and the relay ---------------------------------------------
const gates = new Map(); // id -> { mcpUrl, decide }

export async function handleGate(req, res, id) {
  const gate = gates.get(id);
  if (!gate) return res.writeHead(404).end();
  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
    let msg;
    try { msg = JSON.parse(body); } catch {}
    if (msg?.method === "tools/call") {
      const d = await gate.decide(String(msg.params?.name ?? ""), msg.params?.arguments ?? {});
      if (!d.allow) {
        const text = d.interrupt ? `${d.message} Stop and ask the user what to do instead.` : d.message;
        return res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: true } }));
      }
    }
  }
  const headers = {};
  for (const k of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) if (req.headers[k]) headers[k] = req.headers[k];
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const r = await fetch(gate.mcpUrl, { method: req.method, headers, body, signal: abort.signal }).catch(() => null);
  if (!r) return res.headersSent ? res.destroy() : res.writeHead(502).end();
  const out = {};
  for (const k of ["content-type", "mcp-session-id", "cache-control"]) if (r.headers.get(k)) out[k] = r.headers.get(k);
  res.writeHead(r.status, out);
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
}

// ---- chat -------------------------------------------------------------------------------------
const homeOf = (id) => join(HOMES, createHash("sha256").update(id).digest("hex").slice(0, 32));
export const forget = (id) => rmSync(homeOf(id), { recursive: true, force: true });

const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const resultText = (item) => item.error?.message
  ?? (item.result?.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export async function run({ id, chat, app, mcpUrl, auth: account, text, images, model, effort, thinking, system, emit, fail, decide, signal }) {
  const signIn = account && readAuth(account);
  if (!signIn) throw new Error("Sign in with ChatGPT again (Account tab).");
  const home = homeOf(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const authFile = join(home, "auth.json");
  writeFileSync(authFile, signIn, { mode: 0o600 });
  const gate = randomUUID();
  gates.set(gate, { mcpUrl, decide });
  const files = images.map((img, i) => {
    const f = join(home, `upload-${i}.${EXT[img.media_type]}`);
    writeFileSync(f, Buffer.from(img.data, "base64"));
    return f;
  });
  try {
    const codex = new Codex({
      env: envFor(home),
      config: {
        cli_auth_credentials_store: "file",
        features: Object.fromEntries(OFF.map((f) => [f, false])),
        developer_instructions: system,
        ...(thinking && { model_reasoning_summary: "auto" }),
        // Approved here: the gate asks (permission modes) before passing a call on.
        mcp_servers: { [app]: { url: `http://127.0.0.1:${PORT}/_hub/mcp/${gate}`, default_tools_approval_mode: "approve", tool_timeout_sec: 900 } },
      },
    });
    const options = {
      workingDirectory: WORKDIR, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never",
      webSearchMode: "disabled", networkAccessEnabled: false,
      ...(model && { model }), ...(effort && { modelReasoningEffort: effort }),
    };
    const thread = chat.session ? codex.resumeThread(chat.session, options) : codex.startThread(options);
    const input = files.length ? [...(text ? [{ type: "text", text }] : []), ...files.map((path) => ({ type: "local_image", path }))] : text;
    const { events } = await thread.runStreamed(input, { signal });
    let usage;
    const shown = new Set();
    let lastText = false;
    for await (const e of events) {
      const item = e.item;
      if (e.type === "thread.started") chat.session = e.thread_id;
      else if (item?.type === "mcp_tool_call") {
        if (!shown.has(item.id)) { shown.add(item.id); emit({ type: "tool", id: item.id, name: item.tool, input: item.arguments }); lastText = false; }
        if (e.type === "item.completed") emit({ type: "tool_result", id: item.id, text: clip(resultText(item)), isError: item.status === "failed" || Boolean(item.result?.isError) });
      } else if (e.type === "item.completed" && item?.type === "agent_message" && item.text) {
        emit({ type: "text", text: `${lastText ? "\n\n" : ""}${item.text}` });
        lastText = true;
      } else if (e.type === "item.completed" && item?.type === "reasoning" && thinking && item.text) {
        emit({ type: "thinking", text: item.text });
        lastText = false;
      } else if (e.type === "turn.completed") usage = e.usage;
      else if (e.type === "turn.failed") fail(e.error?.message || "Codex stopped with an error.");
      else if (e.type === "error") fail(e.message || "Codex stopped with an error.");
    }
    return { model: model || undefined, usage: usage && { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } };
  } finally {
    gates.delete(gate);
    // Codex refreshes the sign-in as it goes: keep the newest, then take it off the disk.
    try {
      const now = readFileSync(authFile, "utf8");
      if (now !== signIn && validAuth(now)) saveAuth(account, now);
      else utimesSync(fileOf(account), new Date(), new Date());
    } catch {}
    utimesSync(home, new Date(), new Date());
    rmSync(authFile, { force: true });
    for (const f of files) rmSync(f, { force: true });
  }
}
