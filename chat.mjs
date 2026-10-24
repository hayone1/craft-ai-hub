// Chat for the overlay: POST /_hub/chat runs an agent whose only tools are the app's, reached over
// MCP through the craft-mcp relay, which carries them to the user's tab. Two providers:
//   claude  Claude Code (claude.mjs), on a token from `claude setup-token`
//   codex   OpenAI Codex (codex.mjs), on a ChatGPT sign-in
//
//   request   {"app", "chat": "<id>", "mcp": "<the tab's MCP URL>", "text", "images"?: [{media_type, data}],
//              "provider"?, "model"?, "effort"?, "permission"?: "ask"|"edit"|"plan"|"bypass", "thinking"?: bool}
//             or {"app", "chat", "reset": true}
//   response  NDJSON lines:
//             {"type":"text","text"}  {"type":"thinking","text"}
//             {"type":"tool","id","name","input"}  {"type":"tool_result","id","text","isError"}
//             {"type":"permission","id","name","input"}   (ask mode: answer with POST /_hub/chat/permission)
//             {"type":"done","usage","ms","model"}  {"type":"error","error"}
//
// Each chat maps to the provider's session, resumed on the next message and forgotten when idle.
// Chats are scoped to the tab's relay key, which each browser mints for itself.
import { randomUUID } from "node:crypto";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";

const IDLE_MS = 24 * 3600_000;
const ASK_MS = 10 * 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const RUNNERS = { claude, codex };

// CHAT_PROVIDERS: which agents the composer offers, in its order.
const wanted = (process.env.CHAT_PROVIDERS ?? "claude,codex").split(",").map((s) => s.trim()).filter(Boolean);
for (const p of wanted) if (!RUNNERS[p]) throw new Error(`CHAT_PROVIDERS: unknown provider ${p} (claude, codex)`);
export const PROVIDERS = wanted.map((id) => ({ id, label: RUNNERS[id].LABEL, short: RUNNERS[id].SHORT, models: RUNNERS[id].MODELS, efforts: RUNNERS[id].EFFORTS }));

export const system = (app, title, description, plan) => `You are the AI assistant built into ${title}${description ? ` (${description})` : ""}, \
running in the user's browser tab. You act on the document open in that tab through the ${app} tools, and you have no other tools. \
Inspect the current state before changing it, make the changes the user asks for, then say briefly what you did. \
Ask when a request is ambiguous. Keep replies short: the chat is a small panel next to the canvas. Use Markdown sparingly.${plan ? `

Plan mode is on: you may only inspect the document. Do not change it. Propose a numbered plan of the changes \
you would make, and tell the user to switch to another mode to carry it out.` : ""}`;

// Tools that only look: allowed in plan mode, without asking in ask mode.
// Steps that lose work or leave the document: "edit" mode still asks before these.
const RISKY = /(^|[_.])(delete|remove|close|clear|reset|discard|revert|overwrite|quit|save|export|open|new)([_.]|$)/i;
const READ_ONLY = /(^|[_.])(list|get|inspect|info|state|status|describe|read|query|search|find|count|export_data_sets|schema|help)([_.]|$)/i;

const chats = new Map(); // key/app/chat -> { provider, session, busy, seen, always: Set, asks: Map }

// key: the tab's relay key; mcpUrl: its MCP endpoint on the relay's internal address;
// auth: what the provider signs in with (claude: a token; codex: the person's account).
export async function handleChat(res, body, { app, title, description, key, mcpUrl, provider, auth }) {
  const id = `${key}/${app}/${body.chat}`;
  if (body.reset) {
    const old = chats.get(id);
    chats.delete(id);
    if (old?.provider) RUNNERS[old.provider].forget?.(id);
    return res.writeHead(204).end();
  }
  const runner = RUNNERS[provider];
  const text = String(body.text ?? "").trim();
  const images = (Array.isArray(body.images) ? body.images : []).filter((i) => IMAGE_TYPES.has(i?.media_type) && typeof i.data === "string").slice(0, 8);
  if (!text && !images.length) return res.writeHead(400).end();
  const model = runner.MODELS.some((m) => m.value === body.model) ? body.model : runner.DEFAULT_MODEL;
  const effort = runner.EFFORTS.includes(body.effort) ? body.effort : runner.DEFAULT_EFFORT;
  const permission = { auto: "bypass" }[body.permission] ?? (["ask", "edit", "plan", "bypass"].includes(body.permission) ? body.permission : "ask");

  let chat = chats.get(id);
  if (chat?.busy) return res.writeHead(409).end();
  // A chat stays with one provider: switching starts its session afresh.
  if (chat && chat.provider !== provider) { RUNNERS[chat.provider].forget?.(id); chat = null; }
  if (!chat) chats.set(id, (chat = { provider, always: new Set(), asks: new Map() }));
  chat.busy = true;
  chat.seen = Date.now();

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  const emit = (event) => res.writableEnded || res.destroyed || res.write(`${JSON.stringify(event)}\n`);
  // One failure tends to surface several times (the message, the result, the exception): report it once.
  let failed = false;
  const fail = (error) => { if (!failed) emit({ type: "error", error }); failed = true; };
  const abortController = new AbortController();
  res.on("close", () => abortController.abort());
  const started = Date.now();

  // Whether the agent may call `tool` now: { allow } or { allow: false, message, interrupt }.
  const decide = async (tool, input, signal = abortController.signal) => {
    if (permission === "plan") {
      return READ_ONLY.test(tool) ? { allow: true }
        : { allow: false, message: "Plan mode: don't change the document; describe this step in the plan instead." };
    }
    if (permission === "bypass" || READ_ONLY.test(tool) || chat.always.has(tool) || (permission === "edit" && !RISKY.test(tool))) return { allow: true };
    const ask = randomUUID();
    emit({ type: "permission", id: ask, name: tool, input });
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ allow: false, timeout: true }), ASK_MS);
      const done = (a) => { clearTimeout(timer); chat.asks.delete(ask); resolve(a); };
      chat.asks.set(ask, done);
      signal.addEventListener("abort", () => done({ allow: false }), { once: true });
    });
    if (answer.always) chat.always.add(tool);
    return answer.allow ? { allow: true }
      : { allow: false, message: answer.timeout ? "Nobody answered the permission request." : "The user declined this step.", interrupt: !answer.timeout };
  };

  try {
    const { usage, model: used } = await runner.run({
      id, chat, app, mcpUrl, auth, text, images, model, effort, thinking: Boolean(body.thinking), permission,
      system: system(app, title, description, permission === "plan"), emit, fail, decide, signal: abortController.signal,
    });
    if (!failed && !abortController.signal.aborted) emit({ type: "done", ms: Date.now() - started, model: used, usage });
  } catch (e) {
    if (!abortController.signal.aborted) {
      console.error(`chat ${provider} ${app}: ${e}`);
      fail(String(e?.message ?? e).replace(/^Claude Code returned an error result: /, ""));
    }
  } finally {
    for (const done of chat.asks.values()) done({ allow: false });
    chat.busy = false;
    chat.seen = Date.now();
    res.end();
  }
}

// The overlay's answer to a permission request: {"app", "chat", "mcp", "id", "allow", "always"}.
export function answerPermission(res, body, { app, key }) {
  const done = chats.get(`${key}/${app}/${body.chat}`)?.asks.get(String(body.id));
  if (!done) return res.writeHead(404).end();
  done({ allow: Boolean(body.allow), always: Boolean(body.allow && body.always) });
  return res.writeHead(204).end();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, chat] of chats) {
    if (chat.busy || now - chat.seen <= IDLE_MS) continue;
    chats.delete(id);
    RUNNERS[chat.provider].forget?.(id);
  }
}, 60_000).unref();
