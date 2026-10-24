// Claude Code (the Claude Agent SDK) for chat.mjs, signed in with a subscription token from
// `claude setup-token`: the person's own (server.mjs keeps it in their browser) or the hub's shared
// CLAUDE_CODE_OAUTH_TOKEN.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const WORKDIR = join(tmpdir(), "craft-ai-hub-chat");
mkdirSync(WORKDIR, { recursive: true });

export const LABEL = "Claude";
export const SHORT = "Claude";
// The model menu; CHAT_MODELS (JSON [{value, label}]) replaces it. "" is Claude Code's default.
export const MODELS = process.env.CHAT_MODELS ? JSON.parse(process.env.CHAT_MODELS) : [
  { value: "", label: "Default" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-fable-5-1", label: "Fable 5.1" },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_MODEL = process.env.CHAT_MODEL || "";
export const DEFAULT_EFFORT = process.env.CHAT_EFFORT || undefined;

const ERRORS = {
  rate_limit: "The Claude plan's usage limit was reached.",
  authentication_failed: "Claude didn't accept the token. Create a new one with `claude setup-token`.",
};

const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const resultText = (content) => (typeof content === "string" ? content
  : (content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"));

export async function run({ chat, app, mcpUrl, auth: token, text, images, model, effort, thinking, system, emit, fail, decide, signal }) {
  const short = (name) => name.replace(`mcp__${app}__`, "");
  const canUseTool = async (name, input, { signal: toolSignal }) => {
    const d = await decide(short(name), input, toolSignal);
    return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.message, interrupt: d.interrupt };
  };
  const content = [
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    ...(text ? [{ type: "text", text }] : []),
  ];
  const prompt = images.length
    ? (async function* () { yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null }; })()
    : text;
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const stream = query({
    prompt,
    options: {
      cwd: WORKDIR,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      systemPrompt: system,
      ...(model && { model }),
      ...(effort && { effort }),
      ...(thinking && { thinking: { type: "adaptive", display: "summarized" } }),
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
  let used;
  for await (const m of stream) {
    if (m.session_id) chat.session = m.session_id;
    if (m.type === "system" && m.subtype === "init") used = m.model;
    if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") emit({ type: "text", text: e.delta.text });
      if (e.type === "content_block_delta" && e.delta.type === "thinking_delta" && e.delta.thinking) emit({ type: "thinking", text: e.delta.thinking });
    } else if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "tool_use") emit({ type: "tool", id: block.id, name: short(block.name), input: block.input });
      }
      if (m.error) fail(ERRORS[m.error] ?? `Claude error: ${m.error}`);
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result") emit({ type: "tool_result", id: block.tool_use_id, text: clip(resultText(block.content)), isError: Boolean(block.is_error) });
      }
    } else if (m.type === "result") {
      usage = m.usage;
      if (m.is_error) fail(m.errors?.join("\n") || (m.subtype === "error_max_turns" ? "Stopped after too many steps." : "Claude Code stopped with an error."));
    }
  }
  return {
    model: used,
    usage: usage && { input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), output: usage.output_tokens ?? 0 },
  };
}
