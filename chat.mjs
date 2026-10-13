// Chat for the overlay: POST /_hub/chat runs Claude Code (the Claude Agent SDK), signed in with a
// subscription token from `claude setup-token`: the person's own (server.mjs keeps it in their
// browser) or the hub's shared CLAUDE_CODE_OAUTH_TOKEN. Its only tools are the app's, reached over
// MCP through the craft-mcp relay, which carries them to the user's tab.
//
//   request   {"app", "chat": "<id>", "mcp": "<the tab's MCP URL>", "text", "images"?: [{media_type, data}],
//              "model"?, "effort"?, "permission"?: "ask"|"edit"|"plan"|"bypass", "thinking"?: bool}
//             or {"app", "chat", "reset": true}
//   response  NDJSON lines:
//             {"type":"text","text"}  {"type":"thinking","text"}
//             {"type":"tool","id","name","input"}  {"type":"tool_result","id","text","isError"}
//             {"type":"permission","id","name","input"}   (ask mode: answer with POST /_hub/chat/permission)
//             {"type":"done","usage","ms","model"}  {"type":"error","error"}
//
// Each chat maps to a Claude Code session, resumed on the next message and forgotten when idle.
// Chats are scoped to the tab's relay key, which each browser mints for itself.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const IDLE_MS = 24 * 3600_000;
const ASK_MS = 10 * 60_000;
const WORKDIR = join(tmpdir(), "craft-ai-hub-chat");
mkdirSync(WORKDIR, { recursive: true });

// The model menu; CHAT_MODELS (JSON [{value, label}]) replaces it. "" is Claude Code's default.
export const MODELS = process.env.CHAT_MODELS ? JSON.parse(process.env.CHAT_MODELS) : [
  { value: "", label: "Default" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-fable-5-1", label: "Fable 5.1" },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const system = (app, title, description, plan) => `You are the AI assistant built into ${title}${description ? ` (${description})` : ""}, \
running in the user's browser tab. You act on the document open in that tab through the ${app} tools. \
Inspect the current state before changing it, make the changes the user asks for, then say briefly what you did. \
Ask when a request is ambiguous. Keep replies short: the chat is a small panel next to the canvas. Use Markdown sparingly.${plan ? `

Plan mode is on: you may only inspect the document. Do not change it. Propose a numbered plan of the changes \
you would make, and tell the user to switch to another mode to carry it out.` : ""}`;

// Tools that only look: allowed in plan mode, without asking in ask mode.
// Steps that lose work or leave the document: "edit" mode still asks before these.
const RISKY = /(^|[_.])(delete|remove|close|clear|reset|discard|revert|overwrite|quit|save|export|open|new)([_.]|$)/i;
const READ_ONLY = /(^|[_.])(list|get|inspect|info|state|status|describe|read|query|search|find|count|export_data_sets|schema|help)([_.]|$)/i;

const CLAUDE_ERRORS = {
  rate_limit: "The Claude plan's usage limit was reached.",
  authentication_failed: "Claude didn't accept the token. Create a new one with `claude setup-token`.",
};

const chats = new Map(); // key/app/chat -> { session, busy, seen, always: Set, asks: Map }

const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const resultText = (content) => (typeof content === "string" ? content
  : (content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"));

// key: the tab's relay key; mcpUrl: its MCP endpoint on the relay's internal address; token: the
// Claude Code token this chat runs on.
export async function handleChat(res, body, { app, title, description, key, mcpUrl, token }) {
  const id = `${key}/${app}/${body.chat}`;
  if (body.reset) {
    chats.delete(id);
    return res.writeHead(204).end();
  }
  const text = String(body.text ?? "").trim();
  const images = (Array.isArray(body.images) ? body.images : []).filter((i) => IMAGE_TYPES.has(i?.media_type) && typeof i.data === "string").slice(0, 8);
  if (!text && !images.length) return res.writeHead(400).end();
  const model = MODELS.some((m) => m.value === body.model) ? body.model : process.env.CHAT_MODEL || "";
  const effort = EFFORTS.includes(body.effort) ? body.effort : process.env.CHAT_EFFORT || undefined;
  const permission = { auto: "bypass" }[body.permission] ?? (["ask", "edit", "plan", "bypass"].includes(body.permission) ? body.permission : "ask");

  let chat = chats.get(id);
  if (chat?.busy) return res.writeHead(409).end();
  if (!chat) chats.set(id, (chat = { always: new Set(), asks: new Map() }));
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

  const short = (name) => name.replace(`mcp__${app}__`, "");
  const canUseTool = async (name, input, { signal }) => {
    const tool = short(name);
    if (permission === "plan") {
      return READ_ONLY.test(tool) ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Plan mode: don't change the document; describe this step in the plan instead." };
    }
    if (permission === "bypass" || READ_ONLY.test(tool) || chat.always.has(tool) || (permission === "edit" && !RISKY.test(tool))) return { behavior: "allow", updatedInput: input };
    const ask = randomUUID();
    emit({ type: "permission", id: ask, name: tool, input });
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ allow: false, timeout: true }), ASK_MS);
      const done = (a) => { clearTimeout(timer); chat.asks.delete(ask); resolve(a); };
      chat.asks.set(ask, done);
      signal.addEventListener("abort", () => done({ allow: false }), { once: true });
    });
    if (answer.always) chat.always.add(tool);
    return answer.allow ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: answer.timeout ? "Nobody answered the permission request." : "The user declined this step.", interrupt: !answer.timeout };
  };

  const content = [
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    ...(text ? [{ type: "text", text }] : []),
  ];
  const prompt = images.length
    ? (async function* () { yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null }; })()
    : text;

  try {
    const run = query({
      prompt,
      options: {
        cwd: WORKDIR,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
        systemPrompt: system(app, title, description, permission === "plan"),
        ...(model && { model }),
        ...(effort && { effort }),
        ...(body.thinking && { thinking: { type: "adaptive", display: "summarized" } }),
        // No built-in tools (files, shell, web): only the app's own.
        tools: [],
        mcpServers: { [app]: { type: "http", url: mcpUrl, timeout: 120_000 } },
        canUseTool,
        permissionMode: "default",
        settingSources: [],
        includePartialMessages: true,
        ...(chat.session && { resume: chat.session }),
        abortController,
      },
    });
    let usage;
    let usedModel;
    for await (const m of run) {
      if (m.session_id) chat.session = m.session_id;
      if (m.type === "system" && m.subtype === "init") usedModel = m.model;
      if (m.type === "stream_event") {
        const e = m.event;
        if (e.type === "content_block_delta" && e.delta.type === "text_delta") emit({ type: "text", text: e.delta.text });
        if (e.type === "content_block_delta" && e.delta.type === "thinking_delta" && e.delta.thinking) emit({ type: "thinking", text: e.delta.thinking });
      } else if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "tool_use") emit({ type: "tool", id: block.id, name: short(block.name), input: block.input });
        }
        if (m.error) fail(CLAUDE_ERRORS[m.error] ?? `Claude error: ${m.error}`);
      } else if (m.type === "user" && Array.isArray(m.message?.content)) {
        for (const block of m.message.content) {
          if (block.type === "tool_result") emit({ type: "tool_result", id: block.tool_use_id, text: clip(resultText(block.content)), isError: Boolean(block.is_error) });
        }
      } else if (m.type === "result") {
        usage = m.usage;
        if (m.is_error) fail(m.errors?.join("\n") || (m.subtype === "error_max_turns" ? "Stopped after too many steps." : "Claude Code stopped with an error."));
      }
    }
    if (!failed) {
      emit({
        type: "done",
        ms: Date.now() - started,
        model: usedModel,
        usage: usage && { input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), output: usage.output_tokens ?? 0 },
      });
    }
  } catch (e) {
    if (!abortController.signal.aborted) {
      console.error(`chat ${app}: ${e}`);
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
  for (const [id, chat] of chats) if (!chat.busy && now - chat.seen > IDLE_MS) chats.delete(id);
}, 60_000).unref();
