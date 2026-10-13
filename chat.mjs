// Chat for the overlay: POST /_hub/chat runs Claude Code (the Claude Agent SDK), signed in with a
// subscription token from `claude setup-token`: the person's own (server.mjs keeps it in their
// browser) or the hub's shared CLAUDE_CODE_OAUTH_TOKEN. Its only tools are the app's, reached over
// MCP through the craft-mcp relay, which carries them to the user's tab.
//
//   request   {"app", "chat": "<id>", "mcp": "<the tab's MCP URL>", "text"}   or   {"app", "chat", "reset": true}
//   response  NDJSON lines: {"type":"text","text"} {"type":"tool","name"} {"type":"done"} {"type":"error","error"}
//
// Each chat maps to a Claude Code session, resumed on the next message and forgotten when idle.
// Chats are scoped to the tab's relay key, which each browser mints for itself.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const IDLE_MS = 60 * 60_000;
const WORKDIR = join(tmpdir(), "craft-ai-hub-chat");
mkdirSync(WORKDIR, { recursive: true });

const system = (app, title, description) => `You are the AI assistant built into ${title}${description ? ` (${description})` : ""}, \
running in the user's browser tab. You act on the document open in that tab through the ${app} tools. \
Inspect the current state before changing it, make the changes the user asks for, then say briefly what you did. \
Ask when a request is ambiguous. Keep replies short: the chat is a small panel next to the canvas. Use Markdown sparingly.`;

const CLAUDE_ERRORS = {
  rate_limit: "The Claude plan's usage limit was reached.",
  authentication_failed: "Claude didn't accept the token. Create a new one with `claude setup-token`.",
};

const chats = new Map(); // key/app/chat -> { session, busy, seen }

// key: the tab's relay key; mcpUrl: its MCP endpoint on the relay's internal address; token: the
// Claude Code token this chat runs on.
export async function handleChat(res, body, { app, title, description, key, mcpUrl, token }) {
  if (!key) return res.writeHead(400).end();
  const id = `${key}/${app}/${body.chat}`;
  if (body.reset) {
    chats.delete(id);
    return res.writeHead(204).end();
  }
  const text = String(body.text ?? "").trim();
  if (!text) return res.writeHead(400).end();
  let chat = chats.get(id);
  if (chat?.busy) return res.writeHead(409).end();
  if (!chat) chats.set(id, (chat = {}));
  chat.busy = true;
  chat.seen = Date.now();

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  const emit = (event) => res.writableEnded || res.destroyed || res.write(`${JSON.stringify(event)}\n`);
  // One failure tends to surface several times (the message, the result, the exception): report it once.
  let failed = false;
  const fail = (error) => { if (!failed) emit({ type: "error", error }); failed = true; };
  const abortController = new AbortController();
  res.on("close", () => abortController.abort());

  try {
    const run = query({
      prompt: text,
      options: {
        cwd: WORKDIR,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
        systemPrompt: system(app, title, description),
        ...(process.env.CHAT_MODEL && { model: process.env.CHAT_MODEL }),
        ...(process.env.CHAT_EFFORT && { effort: process.env.CHAT_EFFORT }),
        // No built-in tools (files, shell, web): only the app's own.
        tools: [],
        mcpServers: { [app]: { type: "http", url: mcpUrl, timeout: 120_000 } },
        allowedTools: [`mcp__${app}__*`],
        permissionMode: "dontAsk",
        settingSources: [],
        includePartialMessages: true,
        ...(chat.session && { resume: chat.session }),
        abortController,
      },
    });
    for await (const m of run) {
      if (m.session_id) chat.session = m.session_id;
      if (m.type === "stream_event") {
        const e = m.event;
        if (e.type === "content_block_delta" && e.delta.type === "text_delta") emit({ type: "text", text: e.delta.text });
      } else if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "tool_use") emit({ type: "tool", name: block.name.replace(`mcp__${app}__`, "") });
        }
        if (m.error) fail(CLAUDE_ERRORS[m.error] ?? `Claude error: ${m.error}`);
      } else if (m.type === "result" && m.is_error) {
        fail(m.errors?.join("\n") || (m.subtype === "error_max_turns" ? "Stopped after too many steps." : "Claude Code stopped with an error."));
      }
    }
    if (!failed) emit({ type: "done" });
  } catch (e) {
    if (!abortController.signal.aborted) {
      console.error(`chat ${app}: ${e}`);
      fail(String(e?.message ?? e).replace(/^Claude Code returned an error result: /, ""));
    }
  } finally {
    chat.busy = false;
    chat.seen = Date.now();
    res.end();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, chat] of chats) if (!chat.busy && now - chat.seen > IDLE_MS) chats.delete(id);
}, 60_000).unref();
