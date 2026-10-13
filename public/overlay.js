// craft-ai-hub's assistant overlay, injected into every app page the hub serves: a chat window that
// collapses to an "Ask AI" button, floats (drag, resize) or docks to the right edge with the app's
// canvas making room. Chat runs in craft-ai-hub (POST /_hub/chat), where Claude Code drives the app
// over MCP through the craft-mcp relay. The "Connect" tab hands the same connection to an external
// MCP client.
//
// The connection itself belongs to the app page (craft-remote.js in the remote images), which
// exposes it as window.craftAssistant. Apps without it get the launcher link and a notice.
(() => {
  const hub = window.craftHub;
  const app = hub.app;
  const title = hub.title;
  const UI_STORE = "craftHubUI";
  const CHAT_STORE = `craftHubChat:${app}`;
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) ?? null; } catch { return null; } };
  const keep = (k, v) => { try { v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k); } catch {} };

  // ---- the app's relay connection ---------------------------------------------------------
  let A = null; // window.craftAssistant
  let state = "off";
  const onState = new Set();
  const attach = () => {
    A = window.craftAssistant ?? null;
    if (!A) return false;
    A.onChange((s) => setState(s));
    setState(A.state);
    return true;
  };
  // Resolves once the tab is connected to the relay (creating a connection if there is none).
  async function connected() {
    if (!A) throw new Error(`${title} in this hub has no assistant support (it needs the remote image)`);
    if (!A.session) await A.connect(168);
    if (state === "replaced") A.reconnect();
    if (state === "on") return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { onState.delete(check); reject(new Error("couldn't connect this tab")); }, 15000);
      const check = () => { if (state === "on") { clearTimeout(t); onState.delete(check); resolve(); } };
      onState.add(check);
    });
  }

  // ---- layout -----------------------------------------------------------------------------
  const ui = Object.assign({ mode: "closed", tab: "chat", x: null, y: null, w: 380, h: 520, dockW: 380 }, load(UI_STORE));
  const persistUi = () => keep(UI_STORE, ui);

  // Docked: the page body (which the app's absolutely positioned canvas fills) gives up the panel's width.
  const pageStyle = document.createElement("style");
  pageStyle.textContent = "html.craft-docked body { position: relative !important; width: calc(100% - var(--craft-dock, 380px)) !important; }";
  document.head.append(pageStyle);

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
      [hidden] { display: none !important; }
      strong { font-weight: 600; } em { font-style: italic; }
      button { border: 1px solid #3a3a3a; border-radius: 6px; background: #2c2c2c; color: inherit; padding: 6px 10px; cursor: pointer; }
      button:hover:not(:disabled) { background: #353535; }
      button:disabled { opacity: .5; cursor: default; }
      button.primary { background: #2d8ceb; border-color: #2d8ceb; color: #fff; }
      button.primary:hover:not(:disabled) { background: #4aa0f5; }
      button.icon { border: none; background: none; padding: 4px 6px; color: #aaa; border-radius: 5px; font-size: 15px; line-height: 1; }
      button.icon:hover { background: #333; color: #eee; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #777; flex: none; }
      .on .dot { background: #3c3; } .connecting .dot { background: #e0a000; } .replaced .dot, .expired .dot { background: #c33; }

      .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; border-radius: 999px; border: 1px solid #3a3a3a; background: #232323f2; color: #e8e8e8; box-shadow: 0 4px 16px #0008; }
      .fab .spark { color: #d97757; font-size: 15px; }

      .win { position: fixed; z-index: 2147483000; display: flex; flex-direction: column; color: #e3e3e3; background: #1f1f1f;
        border: 1px solid #383838; box-shadow: 0 12px 40px #000a; overflow: hidden; }
      .win.float { border-radius: 12px; resize: both; min-width: 300px; min-height: 320px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
      .win.dock { top: 0; right: 0; bottom: 0; border-width: 0 0 0 1px; box-shadow: none; }
      .grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 1; }
      .win.float .grip { display: none; }

      header { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid #2e2e2e; background: #242424; user-select: none; }
      .win.float header { cursor: move; }
      header .name { font-weight: 600; margin-right: 6px; white-space: nowrap; }
      .tabs { display: flex; gap: 2px; margin-right: auto; }
      .tabs button { border: none; background: none; padding: 4px 8px; color: #9a9a9a; border-radius: 5px; }
      .tabs button[aria-selected="true"] { background: #333; color: #eee; }

      .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .msg { max-width: 92%; overflow-wrap: anywhere; }
      .msg.user { align-self: flex-end; background: #2d3b4d; padding: 7px 11px; border-radius: 12px 12px 3px 12px; white-space: pre-wrap; }
      .msg.assistant { align-self: stretch; max-width: 100%; }
      .msg.assistant p { margin: 0 0 6px; } .msg.assistant p:last-child { margin-bottom: 0; }
      .msg.assistant ul, .msg.assistant ol { margin: 0 0 6px; padding-left: 20px; }
      .msg.assistant pre { margin: 6px 0; padding: 8px; background: #151515; border: 1px solid #2e2e2e; border-radius: 6px; overflow-x: auto; }
      .msg.assistant code, .msg.assistant pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
      .msg.assistant :not(pre) > code { background: #2a2a2a; padding: 1px 4px; border-radius: 4px; }
      .msg.assistant a { color: #6cb4ff; }
      .tool { align-self: flex-start; display: flex; align-items: center; gap: 6px; color: #9a9a9a; font-size: 12px; padding: 3px 8px; border: 1px solid #2f2f2f; border-radius: 999px; }
      .tool code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
      .err { color: #f07070; }
      .busy { color: #9a9a9a; font-size: 12px; display: flex; gap: 4px; align-items: center; }
      .busy i { width: 5px; height: 5px; border-radius: 50%; background: #888; animation: b 1s infinite ease-in-out; }
      .busy i:nth-child(2) { animation-delay: .15s; } .busy i:nth-child(3) { animation-delay: .3s; }
      @keyframes b { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

      .empty { margin: auto 0; text-align: center; color: #9a9a9a; padding: 0 12px; }
      .empty .spark { color: #d97757; font-size: 22px; }
      .empty h3 { margin: 6px 0 4px; color: #e3e3e3; font-size: 15px; font-weight: 600; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 12px; }
      .chips button { border-radius: 999px; font-size: 12px; padding: 5px 10px; color: #cfcfcf; }

      .composer { padding: 10px; border-top: 1px solid #2e2e2e; }
      .box { display: flex; align-items: flex-end; gap: 6px; border: 1px solid #3a3a3a; border-radius: 10px; background: #181818; padding: 6px 6px 6px 10px; }
      .box:focus-within { border-color: #4a6f99; }
      textarea { flex: 1; resize: none; border: none; outline: none; background: none; color: #e3e3e3; max-height: 160px; padding: 4px 0; }
      .send { border-radius: 8px; padding: 5px 10px; }
      .hint { color: #777; font-size: 11px; margin-top: 6px; display: flex; justify-content: space-between; }

      .connect { padding: 14px; overflow-y: auto; }
      h2 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
      .muted { color: #9a9a9a; font-size: 12px; }
      .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
      select { border: 1px solid #3a3a3a; border-radius: 6px; background: #2c2c2c; color: inherit; padding: 6px 10px; }
      .clients { display: grid; gap: 6px; margin-top: 12px; }
      .client { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border: 1px solid #333; border-radius: 8px; }
      .client.off { opacity: .5; }
      input { flex: 1; min-width: 0; border: 1px solid #3a3a3a; border-radius: 6px; background: #1b1b1b; color: #cfcfcf; padding: 6px 8px; font-family: ui-monospace, monospace; font-size: 11px; }
      .links { display: flex; justify-content: space-between; margin-top: 12px; }
      .steps { margin: 10px 0 0; padding-left: 18px; } .steps li { margin-bottom: 4px; }
      .steps code { white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; background: #2a2a2a; padding: 1px 4px; border-radius: 4px; }
      .account a { color: #6cb4ff; }
      .link { background: none; border: none; padding: 0; color: #9a9a9a; text-decoration: underline; }
    </style>
    <button class="fab" aria-label="Open the AI assistant"><span class="spark">✦</span><span>Ask AI</span><span class="dot"></span></button>
    <section class="win" role="dialog" aria-label="AI assistant" hidden>
      <div class="grip" aria-hidden="true"></div>
      <header>
        <span class="dot"></span><span class="name">AI assistant</span>
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="chat">Chat</button>
          <button role="tab" data-tab="connect">Connect</button>
          <button role="tab" data-tab="account">Account</button>
        </div>
        <button class="icon" data-act="home" title="All apps">⌂</button>
        <button class="icon" data-act="new" title="New chat">＋</button>
        <button class="icon" data-act="dock" title="Dock to the side">⇥</button>
        <button class="icon" data-act="close" title="Minimize">—</button>
      </header>
      <div class="body chat">
        <div class="log" aria-live="polite"></div>
        <div class="composer">
          <div class="box">
            <textarea rows="1" placeholder="Ask ${title} AI to do something…" aria-label="Message"></textarea>
            <button class="primary send" title="Send">↑</button>
          </div>
          <div class="hint"><span>Enter to send · Shift+Enter for a new line</span><span class="status"></span></div>
        </div>
      </div>
      <div class="body connect" hidden></div>
      <div class="body account connect" hidden></div>
    </section>`;
  const $ = (s) => root.querySelector(s);
  const fab = $(".fab");
  const win = $(".win");
  const log = $(".log");
  const input = $("textarea");
  const sendBtn = $(".send");
  const connectView = $(".body.connect:not(.account)");
  const accountView = $(".body.account");
  const chatView = $(".body.chat");

  let relayout = false;
  function layout() {
    const open = ui.mode !== "closed";
    fab.hidden = open;
    win.hidden = !open;
    win.className = `win ${ui.mode === "dock" ? "dock" : "float"} ${state}`;
    document.documentElement.classList.toggle("craft-docked", ui.mode === "dock");
    if (ui.mode === "dock") {
      win.style.cssText = `width:${ui.dockW}px`;
      document.documentElement.style.setProperty("--craft-dock", `${ui.dockW}px`);
    } else if (open) {
      const w = Math.min(ui.w, innerWidth - 16);
      const h = Math.min(ui.h, innerHeight - 16);
      const x = Math.min(Math.max(8, ui.x ?? innerWidth - w - 16), innerWidth - w - 8);
      const y = Math.min(Math.max(8, ui.y ?? innerHeight - h - 16), innerHeight - h - 8);
      win.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    }
    const dockBtn = $('[data-act="dock"]');
    dockBtn.textContent = ui.mode === "dock" ? "⧉" : "⇥";
    dockBtn.title = ui.mode === "dock" ? "Float" : "Dock to the side";
    for (const b of root.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
    chatView.hidden = ui.tab !== "chat";
    connectView.hidden = ui.tab !== "connect";
    accountView.hidden = ui.tab !== "account";
    $('[data-tab="account"]').hidden = !hub.chat || hub.tokens === "shared";
    $('[data-act="new"]').hidden = ui.tab !== "chat";
    // The app sizes its canvas from the window; tell it the space changed.
    relayout = true;
    dispatchEvent(new Event("resize"));
    relayout = false;
    if (open && ui.tab === "connect") renderConnect();
    if (open && ui.tab === "account") renderAccount();
    persistUi();
  }
  const setMode = (mode) => {
    ui.mode = mode;
    layout();
    if (mode !== "closed" && ui.tab === "chat") input.focus();
  };

  fab.onclick = () => setMode(ui.lastMode ?? "float");
  $('[data-act="close"]').onclick = () => { ui.lastMode = ui.mode; setMode("closed"); };
  $('[data-act="dock"]').onclick = () => setMode(ui.mode === "dock" ? "float" : "dock");
  $('[data-act="new"]').onclick = () => newChat();
  $('[data-act="home"]').onclick = () => { location.href = "/"; };
  for (const b of root.querySelectorAll("[data-tab]")) b.onclick = () => { ui.tab = b.dataset.tab; layout(); };

  // Drag the floating window by its header.
  $("header").addEventListener("pointerdown", (e) => {
    if (ui.mode !== "float" || e.target.closest("button")) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const header = e.currentTarget;
    header.setPointerCapture(e.pointerId);
    const move = (m) => {
      ui.x = Math.min(Math.max(0, m.clientX - dx), innerWidth - r.width);
      ui.y = Math.min(Math.max(0, m.clientY - dy), innerHeight - 40);
      win.style.left = `${ui.x}px`;
      win.style.top = `${ui.y}px`;
    };
    const up = () => { header.removeEventListener("pointermove", move); header.removeEventListener("pointerup", up); persistUi(); };
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
  });
  // Resize the docked panel by its left edge.
  $(".grip").addEventListener("pointerdown", (e) => {
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const move = (m) => {
      ui.dockW = Math.round(Math.min(Math.max(280, innerWidth - m.clientX), innerWidth * 0.6));
      win.style.width = `${ui.dockW}px`;
      document.documentElement.style.setProperty("--craft-dock", `${ui.dockW}px`);
      dispatchEvent(new Event("resize"));
    };
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); persistUi(); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  // The floating window's own resize handle (CSS resize).
  new ResizeObserver(() => {
    if (ui.mode !== "float" || win.hidden) return;
    ui.w = win.offsetWidth;
    ui.h = win.offsetHeight;
    persistUi();
  }).observe(win);
  addEventListener("resize", () => { if (!relayout && ui.mode === "float") layout(); });

  const STATUS = { unsupported: "No assistant support", off: "Not connected", connecting: "Connecting…", on: "Connected", replaced: "In use in another tab", expired: "Connection expired" };
  function setState(s) {
    state = A ? s : "unsupported";
    fab.className = `fab ${state}`;
    fab.title = `AI assistant: ${STATUS[state]}`;
    win.classList.remove("off", "connecting", "on", "replaced", "expired");
    win.classList.add(state);
    $(".status").textContent = state === "on" ? "" : STATUS[state];
    for (const f of [...onState]) f();
    if (!win.hidden && ui.tab === "connect") renderConnect();
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const until = (t) => {
    const h = Math.round((t - Date.now()) / 3600000);
    return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} hours` : "less than an hour";
  };

  // ---- chat -------------------------------------------------------------------------------
  // Minimal Markdown: fenced code, inline code, bold, italics, links, lists, paragraphs.
  function markdown(src) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    const parts = src.split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (i % 2) return out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`);
      for (const block of part.split(/\n{2,}/)) {
        const lines = block.split("\n").filter((l) => l.trim());
        if (!lines.length) continue;
        if (lines.every((l) => /^\s*[-*] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`);
        else if (lines.every((l) => /^\s*\d+\. /.test(l))) out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\. /, ""))}</li>`).join("")}</ol>`);
        else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
      }
    });
    return out.join("");
  }

  const SUGGEST = {
    photocraft: ["What's in the open document?", "Add a new layer named Background", "Increase the contrast a little"],
    vectorcraft: ["Describe the artboard", "Draw a blue circle in the center", "List the layers"],
    lightcraft: ["What photo is selected?", "Warm up this photo slightly", "Make it black and white"],
    filmcraft: ["Summarize the timeline", "Add a title at the start", "How long is the sequence?"],
    effectcraft: ["Describe the composition", "Add a fade-in to the first layer", "List the layers"],
  }[app] ?? ["What can you do here?"];

  // Display transcript: [{role:"user"|"assistant"|"tool"|"error", text}]. The model's own history lives in craft-mcp.
  let chat = load(CHAT_STORE);
  if (!chat?.id) chat = { id: crypto.randomUUID(), items: [] };
  let running = null;

  function renderLog() {
    if (!chat.items.length && !running) {
      log.innerHTML = `<div class="empty"><div class="spark">✦</div><h3>What should we do in ${esc(title)}?</h3>
        <div>The assistant works on what's open in this tab.</div>
        <div class="chips">${SUGGEST.map((s) => `<button>${esc(s)}</button>`).join("")}</div></div>`;
      for (const b of log.querySelectorAll(".chips button")) b.onclick = () => send(b.textContent);
      return;
    }
    log.innerHTML = chat.items.map((m) =>
      m.role === "user" ? `<div class="msg user">${esc(m.text)}</div>`
      : m.role === "tool" ? `<div class="tool">⚙ <code>${esc(m.text)}</code></div>`
      : m.role === "error" ? `<div class="msg err">${esc(m.text)}</div>`
      : `<div class="msg assistant">${markdown(m.text)}</div>`).join("")
      + (running ? `<div class="busy"><i></i><i></i><i></i></div>` : "");
    log.scrollTop = log.scrollHeight;
  }
  const persistChat = () => keep(CHAT_STORE, { ...chat, items: chat.items.slice(-200) });
  const setRunning = (r) => {
    running = r;
    sendBtn.textContent = r ? "■" : "↑";
    sendBtn.title = r ? "Stop" : "Send";
    renderLog();
  };

  async function newChat() {
    running?.abort();
    const old = chat.id;
    chat = { id: crypto.randomUUID(), items: [] };
    persistChat();
    renderLog();
    if (A?.session) fetch("/_hub/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app, chat: old, mcp: A?.session?.mcp, reset: true }) }).catch(() => {});
    input.focus();
  }

  async function send(text) {
    text = text.trim();
    if (!text || running) return;
    input.value = "";
    grow();
    chat.items.push({ role: "user", text });
    const controller = new AbortController();
    setRunning(controller);
    try {
      if (!hub.chat) throw new Error("chat is off on this hub; use the Connect tab with Claude or Claude Code");
      await connected();
      const r = await fetch("/_hub/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app, chat: chat.id, text, mcp: A.session.mcp }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        if (body?.needToken) { ui.tab = "account"; layout(); }
        throw new Error(body?.error ?? (r.status === 409 ? "The assistant is still answering." : `the server answered ${r.status}`));
      }
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let current = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "text") {
            if (!current) chat.items.push((current = { role: "assistant", text: "" }));
            current.text += ev.text;
          } else if (ev.type === "tool") {
            current = null;
            chat.items.push({ role: "tool", text: ev.name });
          } else if (ev.type === "error") {
            chat.items.push({ role: "error", text: ev.error });
          }
          renderLog();
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") chat.items.push({ role: "error", text: `Couldn't reach the assistant: ${e.message}` });
    } finally {
      persistChat();
      setRunning(null);
    }
  }

  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    if (e.key === "Escape") $('[data-act="close"]').click();
  });
  sendBtn.onclick = () => (running ? running.abort() : send(input.value));

  // ---- account (whose Claude plan chats run on) -------------------------------------------
  async function renderAccount(message = "") {
    const r = await fetch("/_hub/token", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (!r) { accountView.innerHTML = `<div class="err">Couldn't reach the hub.</div>`; return; }
    const fallback = r.shared ? "Without one, chats use this hub's shared Claude account." : "Chat needs one.";
    accountView.innerHTML = `
      <h2>Your Claude account</h2>
      ${r.personal
        ? `<div class="muted">Chats run on your own Claude plan. The token is stored encrypted in this browser only.</div>
           <div class="links"><button class="link" data-remove>Remove my token</button></div>`
        : `<div class="muted">Chat on your own Claude plan (Pro or Max). ${fallback}</div>
           <ol class="muted steps">
             <li>On a computer with <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a>, run <code>claude setup-token</code> and sign in.</li>
             <li>Paste the token it prints here. It is stored encrypted in this browser only, and never shown again.</li>
           </ol>
           <div class="row"><input type="password" placeholder="sk-ant-oat01-…" aria-label="Claude Code token" autocomplete="off"><button class="primary" data-save>Save</button></div>`}
      ${message ? `<div class="${message.startsWith("!") ? "err" : "muted"}" style="margin-top:8px">${esc(message.replace(/^!/, ""))}</div>` : ""}`;
    accountView.querySelector("[data-remove]")?.addEventListener("click", async () => {
      await fetch("/_hub/token", { method: "DELETE" });
      renderAccount("Removed.");
    });
    accountView.querySelector("[data-save]")?.addEventListener("click", async () => {
      const token = accountView.querySelector("input").value.trim();
      const s = await fetch("/_hub/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const err = s.ok ? null : (await s.json().catch(() => ({}))).error ?? `the hub answered ${s.status}`;
      if (err) return renderAccount(`!${err}`);
      ui.tab = "chat";
      layout();
      input.focus();
    });
  }

  // ---- connect (external MCP clients) -----------------------------------------------------
  let error = "";
  function renderConnect() {
    if (!A) {
      connectView.innerHTML = `<h2>Use ${esc(title)} from an AI app</h2>
        <div class="muted">This app is served without assistant support. Use its remote image to connect AI apps to it.</div>`;
      return;
    }
    const session = A.session;
    if (!session || state === "expired") {
      connectView.innerHTML = `
        <h2>Use ${esc(title)} from an AI app</h2>
        <div class="muted">Let Claude or another MCP client work in this tab. The work runs here, on this device.</div>
        <div class="row">
          <select aria-label="Connection lasts"><option value="24">For 1 day</option><option value="168" selected>For 7 days</option><option value="720">For 30 days</option></select>
          <button class="primary">${state === "expired" ? "Reconnect" : "Connect"}</button>
        </div>
        ${error ? `<div class="err" style="margin-top:8px">${esc(error)}</div>` : ""}`;
      connectView.querySelector(".primary").onclick = async () => {
        error = "";
        try { await A.connect(connectView.querySelector("select").value); } catch (e) { error = `Couldn't create a connection: ${e.message}`; }
        renderConnect();
      };
      return;
    }
    // One name per tab, so Claude Code can drive several tabs (and apps) at once.
    const cmd = `claude mcp add --transport http ${app}-${session.mcp.split("/").at(-3).split(".")[1].slice(0, 6).toLowerCase()} ${session.mcp}`;
    const claude = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(title)}&connectorUrl=${encodeURIComponent(session.mcp)}`;
    connectView.innerHTML = `
      <h2>Use ${esc(title)} from an AI app</h2>
      <div class="muted">${STATUS[state]} · expires in ${until(session.expires)}. Keep this tab open while the assistant works.</div>
      <div class="clients">
        <div class="client"><span>Claude</span><button class="primary" data-open="${esc(claude)}">Add to Claude</button></div>
        <div class="client"><span>Claude Code</span><button data-copy-cmd="${esc(cmd)}">Copy command</button></div>
        <div class="client off" aria-disabled="true"><span>ChatGPT</span><button disabled>Coming soon</button></div>
        <div class="client off" aria-disabled="true"><span>Gemini</span><button disabled>Coming soon</button></div>
      </div>
      <div class="muted" style="margin-top:12px">Server URL, for any MCP client. Anyone with it can use this tab, so share it with no one.</div>
      <div class="row"><input readonly value="${esc(session.mcp)}" aria-label="MCP server URL"><button data-copy>Copy</button></div>
      <div class="links"><button class="link" data-new>New URL</button><button class="link" data-off>Disconnect</button></div>`;
    connectView.querySelector("[data-open]").onclick = (e) => window.open(e.currentTarget.dataset.open, "_blank", "noopener");
    connectView.querySelector("[data-copy-cmd]").onclick = async (e) => {
      try { await navigator.clipboard.writeText(e.currentTarget.dataset.copyCmd); e.currentTarget.textContent = "Copied"; } catch { e.currentTarget.textContent = "Copy failed"; }
    };
    connectView.querySelector("[data-copy]").onclick = async (e) => {
      const field = connectView.querySelector("input");
      try { await navigator.clipboard.writeText(field.value); } catch { field.select(); document.execCommand("copy"); }
      e.currentTarget.textContent = "Copied";
    };
    connectView.querySelector("[data-new]").onclick = () => { A.disconnect(); renderConnect(); };
    connectView.querySelector("[data-off]").onclick = () => { A.disconnect(); renderConnect(); };
  }

  // egui handles keys and pointers on the whole page; keep them inside the assistant.
  for (const type of ["keydown", "keyup", "keypress", "paste", "copy", "cut", "pointerdown", "pointerup", "pointermove", "wheel", "contextmenu"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  const mount = () => { document.body.append(host); renderLog(); layout(); };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount();
  // craft-remote.js runs first in the remote images; give a slow page a moment anyway.
  if (!attach()) {
    setState("unsupported");
    let tries = 0;
    const t = setInterval(() => { if (attach() || ++tries > 20) clearInterval(t); }, 250);
  }
})();
