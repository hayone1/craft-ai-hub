// craft-ai-hub's assistant overlay, injected into every app page the hub serves: a chat window that
// collapses to an "Ask AI" button, floats (drag, resize) or docks to the right edge with the app's
// canvas making room. Chat runs in craft-ai-hub (POST /_hub/chat), where Claude Code or OpenAI Codex
// drives the app over MCP through the craft-mcp relay. The "Connect" tab hands the same connection to an external
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

      header { display: flex; align-items: center; gap: 2px; padding: 6px 6px 6px 12px; border-bottom: 1px solid #2e2e2e; background: #242424; user-select: none; }
      .win.float header { cursor: move; }
      header .name { font-weight: 600; margin-right: 6px; white-space: nowrap; }
      .tabs { display: flex; gap: 2px; margin: 0 auto 0 6px; min-width: 0; overflow: hidden; }
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

      .composer { position: relative; padding: 10px; border-top: 1px solid #2e2e2e; }
      .box { display: flex; flex-direction: column; gap: 6px; border: 1px solid #3a3a3a; border-radius: 12px; background: #181818; padding: 8px 8px 6px 10px; }
      .box:focus-within { border-color: #d97757aa; }
      .box.drop { border-color: #4aa0f5; background: #1b2430; }
      textarea { width: 100%; resize: none; border: none; outline: none; background: none; color: #e3e3e3; max-height: 200px; padding: 2px 0; }
      .bar { display: flex; align-items: center; gap: 6px; }
      .bar .fill { flex: 1; }
      .chip { border: 1px solid #343434; background: #232323; color: #cfcfcf; border-radius: 999px; padding: 3px 10px; font-size: 12px; white-space: nowrap; }
      .chip { display: inline-flex; align-items: center; gap: 5px; }
      .chip svg { width: 14px; height: 14px; }
      .chip.mode-edit { color: #e6b450; border-color: #4a3f22; }
      .chip.mode-bypass { color: #f08a7a; border-color: #5a2a24; }
      .opt.mode { display: flex; gap: 12px; align-items: flex-start; padding: 8px 10px; }
      .opt.mode svg { flex: none; margin-top: 2px; color: #bdbdbd; }
      .opt.mode > span:nth-child(2) { flex: 1; }
      .opt.mode .tick { color: #e3e3e3; align-self: center; }
      .modes-h { display: flex; justify-content: space-between; align-items: center; text-transform: none; letter-spacing: 0; font-size: 12px; }
      kbd { font: 11px ui-monospace, Menlo, Consolas, monospace; border: 1px solid #444; border-radius: 4px; padding: 0 4px; color: #bbb; }
      .effort { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 4px; padding: 8px 10px 6px; border-top: 1px solid #333; }
      .effort input { flex: 0 0 120px; width: 120px; accent-color: #4aa0f5; padding: 0; border: none; }
      .chip.mode-plan { color: #7fb2ff; border-color: #24364f; }
      .timer { color: #8a8a8a; font-size: 11px; font-variant-numeric: tabular-nums; }
      .send.primary { border-radius: 999px; width: 30px; height: 30px; padding: 0; background: #d97757; border-color: #d97757; }
      .send.primary:hover:not(:disabled) { background: #e58a6c; }
      .attachments { display: flex; gap: 6px; flex-wrap: wrap; }
      .att { position: relative; }
      .att img, .thumbs img { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; border: 1px solid #333; display: block; }
      .att .x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; padding: 0; border-radius: 50%; font-size: 12px; line-height: 1; }
      .thumbs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
      .menu, .slash { position: absolute; z-index: 5; min-width: 220px; max-width: calc(100% - 16px); max-height: calc(100% - 70px); overflow-y: auto; padding: 4px;
        background: #262626; border: 1px solid #3a3a3a; border-radius: 10px; box-shadow: 0 10px 30px #000a; }
      .slash { left: 10px; right: 10px; bottom: calc(100% - 4px); max-height: 240px; }
      .mh { color: #8a8a8a; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px 2px; }
      .opt { display: block; width: 100%; text-align: left; border: none; background: none; padding: 6px 10px; border-radius: 6px; }
      .opt:hover { background: #333; } .opt.on { background: #2d3b4d; }
      .opt.check { display: flex; gap: 8px; align-items: center; cursor: pointer; margin-top: 4px; }
      .opt code { font-family: ui-monospace, Menlo, Consolas, monospace; color: #e3e3e3; }
      .opt.check input { flex: none; width: auto; }
      .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
      .seg { display: flex; gap: 2px; padding: 2px 6px 4px; flex-wrap: wrap; }
      .seg button { padding: 3px 8px; font-size: 12px; border-radius: 5px; }
      .seg button.on { background: #2d3b4d; border-color: #3d5c80; }
      .card { align-self: stretch; border: 1px solid #2f2f2f; border-radius: 8px; background: #1b1b1b; font-size: 12px; }
      .card summary { cursor: pointer; padding: 5px 9px; color: #a9a9a9; list-style: none; display: flex; gap: 6px; align-items: center; }
      .card summary::-webkit-details-marker { display: none; }
      .card summary::before { content: "▸"; color: #666; } .card[open] summary::before { content: "▾"; }
      .card .sect { color: #777; font-size: 11px; padding: 2px 9px 0; }
      .card pre { margin: 4px 9px 8px; padding: 6px 8px; background: #141414; border-radius: 6px; overflow: auto; max-height: 220px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .card pre, .card code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
      .card.think .md { padding: 0 10px 8px; color: #9a9a9a; font-style: italic; }
      .card.tool .ico { width: 12px; text-align: center; }
      .card.perm { padding: 8px 10px; border-color: #5a4628; background: #221d14; }
      .card.perm pre { margin: 6px 0; }
      .card.perm .row { margin-top: 6px; }
      .meta { align-self: flex-end; color: #6f6f6f; font-size: 11px; white-space: pre-wrap; }
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
      .account section + section { margin-top: 18px; padding-top: 14px; border-top: 1px solid #2e2e2e; }
      .code { font: 600 20px/1.2 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .08em; color: #fff; }
      .account textarea { margin-top: 8px; min-height: 70px; border: 1px solid #3a3a3a; border-radius: 6px; background: #1b1b1b; padding: 6px 8px;
        font: 11px ui-monospace, monospace; color: #cfcfcf; }
      .account details summary { cursor: pointer; color: #9a9a9a; font-size: 12px; margin-top: 10px; }
    </style>
    <button class="fab" aria-label="Open the AI assistant"><span class="spark">✦</span><span>Ask AI</span><span class="dot"></span></button>
    <section class="win" role="dialog" aria-label="AI assistant" hidden>
      <div class="grip" aria-hidden="true"></div>
      <header>
        <span class="dot" title="Connection"></span>
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="chat">Chat</button>
          <button role="tab" data-tab="connect">Connect</button>
          <button role="tab" data-tab="account">Account</button>
        </div>
        <button class="icon" data-act="home" title="All apps">⌂</button>
        <button class="icon" data-act="history" title="Chats">☰</button>
        <button class="icon" data-act="new" title="New chat">＋</button>
        <button class="icon" data-act="dock" title="Dock to the side">⇥</button>
        <button class="icon" data-act="close" title="Minimize">—</button>
      </header>
      <div class="body chat">
        <div class="log" aria-live="polite"></div>
        <div class="composer">
          <div class="slash" hidden></div>
          <div class="box">
            <div class="attachments" hidden></div>
            <textarea rows="1" placeholder="Ask ${title} AI to do something… (/ for commands)" aria-label="Message"></textarea>
            <div class="bar">
              <button class="icon" data-act="attach" title="Attach images">＋</button>
              <input type="file" accept="image/*" multiple hidden>
              <button class="chip" data-menu="model" title="Model and effort"></button>
              <span class="timer"></span>
              <span class="fill"></span>
              <button class="chip" data-menu="permission" title="Permissions"></button>
              <button class="primary send" title="Send">↑</button>
            </div>
          </div>
          <div class="hint"><span>Enter to send · Shift+Enter for a new line</span><span class="status"></span></div>
        </div>
      </div>
      <div class="body connect" hidden></div>
      <div class="body account connect" hidden></div>
      <div class="menu" role="menu" hidden></div>
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
    $('[data-tab="account"]').hidden = !hub.chat || !PROVIDERS.some((p) => p.id === "codex" || hub.tokens !== "shared");
    $('[data-act="new"]').hidden = ui.tab !== "chat";
    $('[data-act="history"]').hidden = ui.tab !== "chat";
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
        else if (lines.length === 1 && /^#{1,4} /.test(lines[0])) out.push(`<p><strong>${inline(lines[0].replace(/^#+ /, ""))}</strong></p>`);
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

  // Settings for the next message, like Claude Code's composer: agent and model, effort, thinking,
  // permission mode. Each provider (Claude, Codex) has its own models and efforts.
  const PROVIDERS = hub.providers?.length ? hub.providers : [{ id: "claude", label: "Claude", short: "Claude", models: [{ value: "", label: "Default" }], efforts: [] }];
  const providerOf = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  // Line icons for the modes menu.
  const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const MODES = {
    ask: ["Manual", "{who} asks for approval before each change to the document.", svg('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 5.5v-1a1.5 1.5 0 0 1 3 0V12M14 5.5a1.5 1.5 0 0 1 3 0V12M17 8.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 14a1.5 1.5 0 0 1 2.4-1.8L8 14"/>')],
    edit: ["Edit automatically", "{who} edits straight away, and asks before closing, deleting or saving over things.", svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>')],
    plan: ["Plan", "{who} looks at the document and presents a plan before editing.", svg('<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h3"/>')],
    bypass: ["Bypass permissions", "{who} never asks for approval, even before steps that lose work.", svg('<path d="M4 7h11a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h11"/><path d="m17 16 3 3-3 3"/>')],
  };
  const cfg = Object.assign({ provider: PROVIDERS[0].id, model: "", effort: "", permission: "ask", thinking: true }, load("craftHubChatCfg"));
  if (!MODES[cfg.permission]) cfg.permission = cfg.permission === "auto" ? "bypass" : "ask";
  if (providerOf(cfg.provider).id !== cfg.provider) Object.assign(cfg, { provider: PROVIDERS[0].id, model: "", effort: "" });
  const saveCfg = () => { keep("craftHubChatCfg", cfg); renderBar(); };
  const P = () => providerOf(cfg.provider);
  const MODELS = () => P().models;
  const EFFORTS = () => P().efforts;

  // Chats in this browser, newest first: [{ id, title, updated, items }]. Items:
  //   user {text, images: n, thumbs?}  assistant {text}  thinking {text, open}
  //   tool {id, name, input, result, isError, done, open}  permission {id, name, input, answer}
  //   meta {text}  error {text}
  const CHATS_STORE = `craftHubChats:${app}`;
  let chats = load(CHATS_STORE) ?? [];
  const legacy = load(CHAT_STORE);
  if (legacy?.items?.length && !chats.some((c) => c.id === legacy.id)) chats.unshift({ id: legacy.id, title: legacy.items.find((i) => i.role === "user")?.text ?? "Chat", updated: Date.now(), items: legacy.items });
  keep(CHAT_STORE, null);
  let chat = chats[0]?.items.length ? chats[0] : { id: crypto.randomUUID(), title: "", updated: Date.now(), items: [] };
  let running = null;
  let started = 0;
  let pending = []; // images attached to the next message: { media_type, data, url }

  const persistChats = () => {
    chat.updated = Date.now();
    chats = [chat, ...chats.filter((c) => c.id !== chat.id)].filter((c) => c.items.length).slice(0, 30);
    // Image data stays out of storage; the transcript keeps a count.
    keep(CHATS_STORE, chats.map((c) => ({ ...c, items: c.items.slice(-300).map(({ thumbs, ...i }) => i) })));
  };

  const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const pretty = (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
  const label = (value) => MODELS().find((m) => m.value === value)?.label ?? (value || "Default");
  const modeText = (desc) => desc.replace("{who}", P().short);
  // Another agent can't pick up this chat: switching starts a new one.
  function setProvider(id, model = "") {
    if (id !== cfg.provider) {
      Object.assign(cfg, { provider: id, effort: "" });
      if (chat.items.length) newChat();
    }
    cfg.model = model;
    saveCfg();
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  let frame = 0;
  const renderLog = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawLog(); }); };
  function drawLog() {
    if (!chat.items.length && !running) {
      log.innerHTML = `<div class="empty"><div class="spark">✦</div><h3>What should we do in ${esc(title)}?</h3>
        <div>${PROVIDERS.length > 1 ? `${esc(P().short)} works` : "The assistant works"} on what's open in this tab. Paste or drop images to show it something.</div>
        <div class="chips">${SUGGEST.map((s) => `<button>${esc(s)}</button>`).join("")}</div></div>`;
      for (const b of log.querySelectorAll(".chips button")) b.onclick = () => send(b.textContent);
      return;
    }
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = chat.items.map((m, i) => {
      switch (m.role) {
        case "user":
          return `<div class="msg user">${m.thumbs?.length ? `<div class="thumbs">${m.thumbs.map((u) => `<img src="${u}" alt="">`).join("")}</div>`
            : m.images ? `<div class="muted">🖼 ${m.images} image${m.images > 1 ? "s" : ""}</div>` : ""}${esc(m.text)}</div>`;
        case "thinking":
          return `<details class="card think" data-i="${i}"${m.open ? " open" : ""}><summary>Thinking</summary><div class="md">${markdown(m.text)}</div></details>`;
        case "tool":
          return `<details class="card tool" data-i="${i}"${m.open ? " open" : ""}><summary><span class="ico">${m.done ? (m.isError ? "✕" : "✓") : "…"}</span><code>${esc(m.name)}</code></summary>
            <div class="sect">Input</div><pre>${esc(pretty(m.input))}</pre>${m.done ? `<div class="sect">Result</div><pre class="${m.isError ? "err" : ""}">${esc(m.result || "(empty)")}</pre>` : ""}</details>`;
        case "permission":
          return `<div class="card perm" data-i="${i}"><div><strong>Allow <code>${esc(m.name)}</code>?</strong></div>
            <pre>${esc(pretty(m.input))}</pre>
            ${m.answer ? `<div class="muted">${{ allow: "Allowed", always: "Allowed for this chat", deny: "Declined" }[m.answer]}</div>`
              : `<div class="row"><button class="primary" data-answer="allow">Allow</button><button data-answer="always">Always allow</button><button data-answer="deny">Deny</button></div>`}</div>`;
        case "meta":
          return `<div class="meta">${esc(m.text)}</div>`;
        case "error":
          return `<div class="msg err">${esc(m.text)}</div>`;
        default:
          return `<div class="msg assistant md">${markdown(m.text)}</div>`;
      }
    }).join("") + (running ? `<div class="busy"><i></i><i></i><i></i></div>` : "");
    if (stick) log.scrollTop = log.scrollHeight;
  }
  // Keep cards open or closed across redraws.
  log.addEventListener("toggle", (e) => { const m = chat.items[e.target.dataset?.i]; if (m) m.open = e.target.open; }, true);
  log.addEventListener("click", (e) => {
    const b = e.target.closest("[data-answer]");
    if (!b) return;
    const m = chat.items[b.closest("[data-i]").dataset.i];
    m.answer = b.dataset.answer;
    renderLog();
    fetch("/_hub/chat/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app, chat: chat.id, mcp: A?.session?.mcp, id: m.id, allow: m.answer !== "deny", always: m.answer === "always" }),
    }).catch(() => {});
  });

  // ---- composer bar: model and effort, permission mode, attachments, timer
  function renderBar() {
    $('[data-menu="model"]').textContent = `${PROVIDERS.length > 1 ? `${P().short} · ` : ""}${label(cfg.model)}${cfg.effort ? ` · ${cap(cfg.effort)}` : ""}`;
    $('[data-menu="permission"]').innerHTML = `${MODES[cfg.permission][2]}<span>${MODES[cfg.permission][0]}</span>`;
    $('[data-menu="permission"]').className = `chip mode-${cfg.permission}`;
    $(".attachments").innerHTML = pending.map((p, i) => `<span class="att"><img src="${p.url}" alt=""><button class="x" data-drop="${i}" title="Remove">×</button></span>`).join("");
    $(".attachments").hidden = !pending.length;
    sendBtn.textContent = running ? "■" : "↑";
    sendBtn.title = running ? "Stop" : "Send";
  }
  $(".attachments").addEventListener("click", (e) => {
    const i = e.target.dataset.drop;
    if (i !== undefined) { pending.splice(Number(i), 1); renderBar(); }
  });

  const menu = $(".menu");
  const closeMenu = () => { menu.hidden = true; };
  // Opens above the anchor (composer chips), or below it (header buttons).
  function openMenu(anchor, html, wire, below = false) {
    menu.innerHTML = html;
    menu.hidden = false;
    const box = anchor.getBoundingClientRect();
    const frame = $(".win").getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(box.left - frame.left, frame.width - menu.offsetWidth - 8))}px`;
    menu.style.top = below ? `${box.bottom - frame.top + 6}px` : "auto";
    menu.style.bottom = below ? "auto" : `${frame.bottom - box.top + 6}px`;
    wire(menu);
  }
  root.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !e.composedPath().some((n) => n === menu || n?.dataset?.menu)) closeMenu();
  });
  $('[data-menu="model"]').onclick = (e) => {
    if (!menu.hidden) return closeMenu();
    openMenu(e.currentTarget, `
      ${PROVIDERS.map((p) => `<div class="mh">${esc(PROVIDERS.length > 1 ? p.label : "Model")}</div>
        ${p.models.map((m) => `<button class="opt${p.id === cfg.provider && m.value === cfg.model ? " on" : ""}" data-provider="${esc(p.id)}" data-model="${esc(m.value)}">${esc(m.label)}</button>`).join("")}`).join("")}
      <label class="opt check"><input type="checkbox" ${cfg.thinking ? "checked" : ""} data-thinking> Show thinking</label>`, (m) => {
      for (const b of m.querySelectorAll("[data-model]")) b.onclick = () => { setProvider(b.dataset.provider, b.dataset.model); closeMenu(); };
      m.querySelector("[data-thinking]").onchange = (x) => { cfg.thinking = x.target.checked; saveCfg(); };
    });
  };
  $('[data-menu="permission"]').onclick = (e) => {
    if (!menu.hidden) return closeMenu();
    // Effort (Auto, then each level) is a slider under the modes, as in Claude Code's menu.
    const levels = ["", ...EFFORTS()];
    const at = Math.max(0, levels.indexOf(cfg.effort));
    openMenu(e.currentTarget, `<div class="mh modes-h"><span>Modes</span><span class="keys"><kbd>⇧</kbd> + <kbd>tab</kbd> to switch</span></div>
      ${Object.entries(MODES).map(([k, [name, desc, icon]]) =>
        `<button class="opt mode${k === cfg.permission ? " on" : ""}" data-mode="${k}">${icon}<span><div>${name}</div><div class="muted">${modeText(desc)}</div></span>${k === cfg.permission ? '<span class="tick">✓</span>' : ""}</button>`).join("")}
      ${EFFORTS().length ? `<div class="effort"><span>Effort <span class="muted" data-effort-label>(${at ? cap(levels[at]) : "Auto"})</span></span>
        <input type="range" min="0" max="${levels.length - 1}" step="1" value="${at}" aria-label="Effort"></div>` : ""}`, (m) => {
      for (const b of m.querySelectorAll("[data-mode]")) b.onclick = () => { cfg.permission = b.dataset.mode; saveCfg(); closeMenu(); };
      const range = m.querySelector('input[type="range"]');
      if (range) range.oninput = () => {
        cfg.effort = levels[range.value];
        m.querySelector("[data-effort-label]").textContent = `(${cfg.effort ? cap(cfg.effort) : "Auto"})`;
        saveCfg();
      };
    });
  };
  $('[data-act="history"]').onclick = (e) => {
    if (!menu.hidden) return closeMenu();
    const list = [chat, ...chats.filter((c) => c.id !== chat.id)].filter((c) => c.items.length);
    openMenu(e.currentTarget, `<div class="mh">Chats</div><button class="opt" data-chat="">＋ New chat</button>
      ${list.map((c) => `<button class="opt${c.id === chat.id ? " on" : ""}" data-chat="${c.id}"><div class="ellipsis">${esc(c.title || "Chat")}</div>
        <div class="muted">${new Date(c.updated).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</div></button>`).join("") || `<div class="muted" style="padding:6px 10px">No earlier chats.</div>`}`, (m) => {
      for (const b of m.querySelectorAll("[data-chat]")) b.onclick = () => {
        closeMenu();
        if (!b.dataset.chat) return newChat();
        if (running) return;
        chat = chats.find((c) => c.id === b.dataset.chat) ?? chat;
        if (chat.provider && chat.provider !== cfg.provider && PROVIDERS.some((p) => p.id === chat.provider)) Object.assign(cfg, { provider: chat.provider, model: "", effort: "" });
        saveCfg();
        renderLog();
      };
    }, true);
  };
  const fileInput = $('input[type="file"]');
  $('[data-act="attach"]').onclick = () => fileInput.click();
  fileInput.onchange = () => { addImages([...fileInput.files]); fileInput.value = ""; };

  // Images go to the agent as base64; big ones are scaled down to 1600 px first.
  async function addImages(files) {
    for (const f of files.filter((x) => x.type.startsWith("image/")).slice(0, 8 - pending.length)) {
      const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
      const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = url; });
      let out = url;
      if (img && (Math.max(img.width, img.height) > 1600 || f.size > 3 << 20)) {
        const k = 1600 / Math.max(img.width, img.height, 1600);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL("image/jpeg", 0.88);
      }
      const [, media_type, data] = /^data:([^;]+);base64,(.*)$/.exec(out) ?? [];
      if (data) pending.push({ media_type, data, url: out });
    }
    renderBar();
  }
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addImages(files); }
  });
  const box = $(".box");
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
  box.addEventListener("dragleave", () => box.classList.remove("drop"));
  box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("drop"); addImages([...(e.dataTransfer?.files ?? [])]); });

  let tick = 0;
  const setRunning = (r) => {
    running = r;
    clearInterval(tick);
    const timer = $(".timer");
    if (r) {
      started = Date.now();
      tick = setInterval(() => { timer.textContent = `${Math.round((Date.now() - started) / 1000)}s`; }, 500);
    }
    timer.textContent = "";
    renderBar();
    renderLog();
  };

  async function newChat() {
    running?.abort();
    const old = chat.id;
    if (chat.items.length) persistChats();
    chat = { id: crypto.randomUUID(), title: "", updated: Date.now(), items: [] };
    renderLog();
    if (A?.session) fetch("/_hub/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app, chat: old, mcp: A.session.mcp, reset: true }) }).catch(() => {});
    input.focus();
  }

  // Slash commands handled here; any other /command goes to the agent (e.g. Claude Code's /compact).
  const ALL_MODELS = PROVIDERS.flatMap((p) => p.models.filter((m) => m.value).map((m) => ({ ...m, provider: p.id })));
  const COMMANDS = [
    ["/clear", "Start a new chat"],
    ["/model", "Set the model: " + ALL_MODELS.map((m) => m.label.toLowerCase().replace(/\s+/g, "")).join(", ")],
    ["/effort", "Set the effort: auto, " + [...new Set(PROVIDERS.flatMap((p) => p.efforts))].join(", ")],
    ["/mode", "Permissions: ask, edit, plan, bypass (or Shift+Tab)"],
    ["/thinking", "Show or hide thinking: on, off"],
    ["/compact", "Summarize the chat so far to free up context"],
    ["/help", "List these commands"],
  ];
  function command(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").toLowerCase();
    const note = (t) => { chat.items.push({ role: "meta", text: t }); renderLog(); };
    switch (cmd) {
      case "/clear": case "/new": newChat(); return true;
      case "/model": {
        const m = ALL_MODELS.find((x) => x.label.toLowerCase().replace(/\s+/g, "") === arg.replace(/\s+/g, "") || x.value === arg || (arg && x.label.toLowerCase().startsWith(arg)));
        if (!m) { note(`Models: ${ALL_MODELS.map((x) => x.label).join(", ")}`); return true; }
        setProvider(m.provider, m.value); note(`Model: ${m.label}`); return true;
      }
      case "/effort":
        if (arg !== "auto" && !EFFORTS().includes(arg)) { note(`Effort: auto, ${EFFORTS().join(", ")}`); return true; }
        cfg.effort = arg === "auto" ? "" : arg; saveCfg(); note(`Effort: ${cap(arg)}`); return true;
      case "/mode": case "/permissions":
        if (!MODES[arg]) { note("Modes: ask, edit, plan, bypass"); return true; }
        cfg.permission = arg; saveCfg(); note(MODES[arg][0]); return true;
      case "/thinking":
        cfg.thinking = arg ? arg !== "off" : !cfg.thinking; saveCfg(); note(`Thinking ${cfg.thinking ? "shown" : "hidden"}`); return true;
      case "/help":
        note(COMMANDS.map(([c, d]) => `${c}  ${d}`).join("\n")); return true;
      default: return false;
    }
  }
  const slash = $(".slash");
  function renderSlash() {
    const v = input.value;
    const show = /^\/\S*$/.test(v);
    const list = show ? COMMANDS.filter(([c]) => c.startsWith(v)) : [];
    slash.hidden = !list.length;
    slash.innerHTML = list.map(([c, d]) => `<button class="opt" data-cmd="${c}"><code>${c}</code> <span class="muted">${esc(d)}</span></button>`).join("");
    for (const b of slash.querySelectorAll("[data-cmd]")) b.onclick = () => { input.value = `${b.dataset.cmd} `; input.focus(); renderSlash(); };
  }

  async function send(text) {
    text = text.trim();
    if ((!text && !pending.length) || running) return;
    input.value = "";
    grow();
    renderSlash();
    if (text.startsWith("/") && !pending.length && command(text)) return;
    const images = pending;
    pending = [];
    chat.items.push({ role: "user", text, images: images.length, thumbs: images.map((p) => p.url) });
    if (!chat.title) chat.title = text.slice(0, 80) || "Images";
    chat.provider ??= cfg.provider;
    const controller = new AbortController();
    setRunning(controller);
    const tools = new Map();
    try {
      if (!hub.chat) throw new Error("chat is off on this hub; use the Connect tab with Claude or Claude Code");
      if (chat.provider !== cfg.provider) throw new Error(`this chat is with ${providerOf(chat.provider).short}; start a new chat to use ${P().short}`);
      await connected();
      const r = await fetch("/_hub/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app, chat: chat.id, text, mcp: A.session.mcp, provider: chat.provider,
          images: images.map(({ media_type, data }) => ({ media_type, data })),
          model: cfg.model, effort: cfg.effort, permission: cfg.permission, thinking: cfg.thinking,
        }),
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
          if (ev.type === "text" || ev.type === "thinking") {
            const role = ev.type === "text" ? "assistant" : "thinking";
            if (current?.role !== role) chat.items.push((current = { role, text: "" }));
            current.text += ev.text;
          } else if (ev.type === "tool") {
            current = null;
            const m = { role: "tool", id: ev.id, name: ev.name, input: ev.input };
            tools.set(ev.id, m);
            chat.items.push(m);
          } else if (ev.type === "tool_result") {
            const m = tools.get(ev.id);
            if (m) Object.assign(m, { result: ev.text, isError: ev.isError, done: true });
          } else if (ev.type === "permission") {
            current = null;
            chat.items.push({ role: "permission", id: ev.id, name: ev.name, input: ev.input });
            if (ui.mode === "closed") setMode(ui.lastMode ?? "float");
          } else if (ev.type === "error") {
            current = null;
            chat.items.push({ role: "error", text: ev.error });
          } else if (ev.type === "done") {
            const known = ALL_MODELS.find((m) => ev.model?.startsWith(m.value));
            const parts = [known ? known.label : ev.model?.replace(/^claude-/, ""),
              ev.usage && `${short(ev.usage.input)} in · ${short(ev.usage.output)} out`, `${(ev.ms / 1000).toFixed(1)}s`].filter(Boolean);
            chat.items.push({ role: "meta", text: parts.join(" · ") });
          }
          renderLog();
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") chat.items.push({ role: "error", text: `Couldn't reach the assistant: ${e.message}` });
      else chat.items.push({ role: "meta", text: "Stopped" });
    } finally {
      for (const m of chat.items) if (m.role === "permission" && !m.answer) m.answer = "deny";
      persistChats();
      setRunning(null);
    }
  }

  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  input.addEventListener("input", () => { grow(); renderSlash(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    if (e.key === "Escape") { if (running) running.abort(); else if (!menu.hidden) closeMenu(); else $('[data-act="close"]').click(); }
    if (e.key === "Tab" && !slash.hidden) { e.preventDefault(); slash.querySelector("[data-cmd]")?.click(); }
    else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const keys = Object.keys(MODES);
      cfg.permission = keys[(keys.indexOf(cfg.permission) + 1) % keys.length];
      saveCfg();
    }
  });
  sendBtn.onclick = () => (running ? running.abort() : send(input.value));
  renderBar();

  // ---- account (whose Claude and ChatGPT plans chats run on) ---------------------------------
  let codexLogin = null; // { id, url, code } while a ChatGPT sign-in is waiting
  let codexPoll = 0;
  async function renderAccount(message = "", codexMessage = "") {
    const r = await fetch("/_hub/token", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (!r) { accountView.innerHTML = `<div class="err">Couldn't reach the hub.</div>`; return; }
    const note = (m) => (m ? `<div class="${m.startsWith("!") ? "err" : "muted"}" style="margin-top:8px">${esc(m.replace(/^!/, ""))}</div>` : "");
    const has = (id) => PROVIDERS.some((p) => p.id === id);
    const fallback = r.shared ? "Without one, chats use this hub's shared Claude account." : "Chat needs one.";
    const claude = !has("claude") || r.tokens === "shared" ? "" : `<section>
      <h2>Your Claude account</h2>
      ${r.personal
        ? `<div class="muted">Claude chats run on your own Claude plan. The token is stored encrypted in this browser only.</div>
           <div class="links"><button class="link" data-remove>Remove my token</button></div>`
        : `<div class="muted">Chat with Claude on your own Claude plan (Pro or Max). ${fallback}</div>
           <ol class="muted steps">
             <li>On a computer with <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a>, run <code>claude setup-token</code> and sign in.</li>
             <li>Paste the token it prints here. It is stored encrypted in this browser only, and never shown again.</li>
           </ol>
           <div class="row"><input type="password" placeholder="sk-ant-oat01-…" aria-label="Claude Code token" autocomplete="off" data-claude><button class="primary" data-save>Save</button></div>`}
      ${note(message)}</section>`;
    const codex = !has("codex") ? "" : `<section>
      <h2>Your ChatGPT account</h2>
      ${r.codex
        ? `<div class="muted">Codex chats run on your own ChatGPT plan. Your sign-in is kept encrypted on the hub, under a key only this browser holds.</div>
           <div class="links"><button class="link" data-codex-out>Sign out</button></div>`
        : codexLogin
          ? `<div class="muted">Open this page on any device, sign in to ChatGPT and enter the code:</div>
             <div class="row"><a href="${esc(codexLogin.url)}" target="_blank" rel="noopener">${esc(codexLogin.url.replace(/^https:\/\//, ""))}</a></div>
             <div class="row"><span class="code">${esc(codexLogin.code)}</span><button data-copy-code>Copy</button></div>
             <div class="muted" style="margin-top:8px">Waiting for you to finish… The code expires in 15 minutes. If ChatGPT refuses it, turn on device code sign-in for Codex in ChatGPT's security settings.</div>
             <div class="links"><button class="link" data-codex-cancel>Cancel</button></div>`
          : `<div class="muted">Chat with Codex on your own ChatGPT plan (Plus, Pro, Business, …).</div>
             <div class="row"><button class="primary" data-codex-in>Sign in with ChatGPT</button></div>
             <details><summary>Or paste auth.json from a computer</summary>
               <div class="muted" style="margin-top:6px">After <code>codex login</code>, copy <code>~/.codex/auth.json</code> here.</div>
               <textarea aria-label="Codex auth.json" spellcheck="false" data-codex-json></textarea>
               <div class="row"><button data-codex-save>Save</button></div></details>`}
      ${note(codexMessage)}</section>`;
    accountView.innerHTML = claude + codex;
    const back = () => { ui.tab = "chat"; layout(); input.focus(); };
    accountView.querySelector("[data-remove]")?.addEventListener("click", async () => {
      await fetch("/_hub/token", { method: "DELETE" });
      renderAccount("Removed.");
    });
    accountView.querySelector("[data-save]")?.addEventListener("click", async () => {
      const token = accountView.querySelector("[data-claude]").value.trim();
      const s = await fetch("/_hub/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const err = s.ok ? null : (await s.json().catch(() => ({}))).error ?? `the hub answered ${s.status}`;
      if (err) return renderAccount(`!${err}`);
      back();
    });
    accountView.querySelector("[data-codex-in]")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const s = await fetch("/_hub/codex/login", { method: "POST" }).then((x) => x.json()).catch(() => ({ error: "Couldn't reach the hub." }));
      if (s.error || !s.url) return renderAccount("", `!${s.error ?? "The sign-in didn't start."}`);
      codexLogin = s;
      clearInterval(codexPoll);
      codexPoll = setInterval(async () => {
        const st = await fetch(`/_hub/codex/login?id=${encodeURIComponent(codexLogin?.id ?? "")}`, { cache: "no-store" }).then((x) => x.json()).catch(() => ({ state: "pending" }));
        if (st.state === "pending") return;
        clearInterval(codexPoll);
        codexLogin = null;
        if (st.state === "done") { renderAccount("", "Signed in."); if (cfg.provider !== "codex") setProvider("codex"); }
        else renderAccount("", `!${st.state === "expired" ? "The sign-in expired. Try again." : st.error}`);
      }, 3000);
      renderAccount();
    });
    accountView.querySelector("[data-copy-code]")?.addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(codexLogin.code); e.currentTarget.textContent = "Copied"; } catch {}
    });
    accountView.querySelector("[data-codex-cancel]")?.addEventListener("click", () => { clearInterval(codexPoll); codexLogin = null; renderAccount(); });
    accountView.querySelector("[data-codex-out]")?.addEventListener("click", async () => {
      await fetch("/_hub/codex", { method: "DELETE" });
      renderAccount("", "Signed out.");
    });
    accountView.querySelector("[data-codex-save]")?.addEventListener("click", async () => {
      const auth = accountView.querySelector("[data-codex-json]").value.trim();
      const s = await fetch("/_hub/codex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth }) });
      const err = s.ok ? null : (await s.json().catch(() => ({}))).error ?? `the hub answered ${s.status}`;
      if (err) return renderAccount("", `!${err}`);
      if (cfg.provider !== "codex") setProvider("codex");
      back();
    });
  }

  // ---- connect (external MCP clients) -----------------------------------------------------
  let error = "";
  let chatgptSteps = false; // stay shown when the tab is drawn again (a connection's state changes)
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
    const id = `${app}-${session.mcp.split("/").at(-3).split(".")[1].slice(0, 6).toLowerCase()}`;
    const cmd = `claude mcp add --transport http ${id} ${session.mcp}`;
    const codexCmd = `codex mcp add ${id} --url ${session.mcp}`;
    const claude = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(title)}&connectorUrl=${encodeURIComponent(session.mcp)}`;
    connectView.innerHTML = `
      <h2>Use ${esc(title)} from an AI app</h2>
      <div class="muted">${STATUS[state]} · expires in ${until(session.expires)}. Keep this tab open while the assistant works.</div>
      <div class="clients">
        <div class="client"><span>Claude</span><button class="primary" data-open="${esc(claude)}">Add to Claude</button></div>
        <div class="client"><span>Claude Code</span><button data-copy-cmd="${esc(cmd)}">Copy command</button></div>
        <div class="client"><span>ChatGPT</span><button data-chatgpt>Copy URL</button></div>
        <div class="client"><span>Codex</span><button data-copy-cmd="${esc(codexCmd)}">Copy command</button></div>
        <div class="client off" aria-disabled="true"><span>Gemini</span><button disabled>Coming soon</button></div>
      </div>
      <ol class="muted steps" data-chatgpt-steps${chatgptSteps ? "" : " hidden"}>
        <li>In ChatGPT on the web, open Settings › Apps › Advanced settings and turn on Developer mode.</li>
        <li>Choose Create app, name it ${esc(title)}, paste the URL (copied) as the MCP server URL and pick No authentication.</li>
        <li>In a chat, pick ${esc(title)} from the + menu (Developer mode) and ask away.</li>
      </ol>
      <div class="muted" style="margin-top:12px">Server URL, for any MCP client. Anyone with it can use this tab, so share it with no one.</div>
      <div class="row"><input readonly value="${esc(session.mcp)}" aria-label="MCP server URL"><button data-copy>Copy</button></div>
      <div class="links"><button class="link" data-new>New URL</button><button class="link" data-off>Disconnect</button></div>`;
    connectView.querySelector("[data-open]").onclick = (e) => window.open(e.currentTarget.dataset.open, "_blank", "noopener");
    for (const b of connectView.querySelectorAll("[data-copy-cmd]")) b.onclick = async (e) => {
      try { await navigator.clipboard.writeText(e.currentTarget.dataset.copyCmd); e.currentTarget.textContent = "Copied"; } catch { e.currentTarget.textContent = "Copy failed"; }
    };
    // ChatGPT has no link that adds a connector: copy the URL and show the steps.
    connectView.querySelector("[data-chatgpt]").onclick = async (e) => {
      try { await navigator.clipboard.writeText(session.mcp); e.currentTarget.textContent = "Copied"; } catch { e.currentTarget.textContent = "Copy failed"; }
      chatgptSteps = true;
      connectView.querySelector("[data-chatgpt-steps]").hidden = false;
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
