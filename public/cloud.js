// Cloud storage in the apps' File › Open and Save, injected into every app page the gateway serves.
// The folders come from craft-mcp's storage (this gateway's _storage/, next to the page) and go to
// the app as storage places (window.craftStoragePlaces, which craft-storage.js in the remote images
// lists). Signed in: one place per folder. Not signed in: one place that signs in when opened.
// Without craft-mcp's storage settings, nothing is added.
(() => {
  const api = (action, params = {}, init) =>
    fetch(`_storage/${action}?${new URLSearchParams(params)}`, { credentials: "same-origin", cache: "no-store", ...init });
  const getJson = async (action, params, init) => {
    const r = await api(action, params, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || `the server answered ${r.status}`), { status: r.status });
    return body;
  };
  let config = { enabled: false };
  let ours = []; // ids of the places this script added

  // Replace this script's places, keeping the ones others lent (an editor's workspace, say).
  const put = (places) => {
    const others = (Array.isArray(window.craftStoragePlaces) ? window.craftStoragePlaces : []).filter((p) => !ours.includes(p.id));
    window.craftStoragePlaces = [...others, ...places];
    ours = places.map((p) => p.id);
  };

  // A request failed because the session ended: show the sign-in place again.
  const guard = async (work) => {
    try {
      return await work();
    } catch (e) {
      if (e.status === 401) { await refresh(); throw new Error(`Sign in to ${config.name} again.`); }
      throw e;
    }
  };

  const folder = (root) => ({
    id: root.id,
    group: config.name,
    name: root.name,
    readOnly: root.readOnly === true,
    list: (path) => guard(() => getJson("list", { root: root.id, path })),
    read: (path) => guard(async () => {
      const r = await api("file", { root: root.id, path });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `the server answered ${r.status}`), { status: r.status });
      }
      return new Uint8Array(await r.arrayBuffer());
    }),
    write: (path, bytes) => guard(() => getJson("file", { root: root.id, path }, { method: "PUT", body: bytes })),
    mkdir: (path) => guard(() => getJson("folder", { root: root.id, path }, { method: "POST" })),
  });

  const signIn = () => new Promise((resolve) => {
    const w = window.open("_storage/login", "craft-sign-in", "width=520,height=680");
    const done = (e) => {
      if (e.origin !== location.origin || e.data?.type !== "craft-storage-sign-in") return;
      window.removeEventListener("message", done);
      clearInterval(poll);
      resolve(e.data.ok ? null : e.data.message || "The sign-in failed.");
    };
    window.addEventListener("message", done);
    const poll = setInterval(() => {
      if (w && !w.closed) return;
      clearInterval(poll);
      window.removeEventListener("message", done);
      resolve(null);
    }, 800);
  });

  // Opening this place signs in; the folders then take its place in the dialog's list.
  const signInPlace = () => ({
    id: "cloud-sign-in",
    group: config.name,
    name: `Sign in with ${config.signIn}`,
    readOnly: true,
    list: async () => {
      const failed = await signIn();
      if (failed) throw new Error(failed);
      await refresh();
      throw new Error(config.user ? `Signed in. Pick a folder under ${config.name}.` : "The sign-in didn't finish.");
    },
    read: async () => { throw new Error(`Sign in to ${config.name} first.`); },
    write: async () => { throw new Error(`Sign in to ${config.name} first.`); },
    mkdir: async () => { throw new Error(`Sign in to ${config.name} first.`); },
  });

  async function refresh() {
    config = await getJson("config").catch(() => ({ enabled: false }));
    if (!config.enabled) return put([]);
    put(config.user ? (config.user.roots ?? []).map(folder) : [signInPlace()]);
  }
  refresh();
})();
