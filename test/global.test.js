"use strict";

/*
 * Tests for global.js - the plugin's global entry.
 *
 * The global entry runs with NO player (JavascriptPluginInstance.init(player:nil)
 * → isGlobal), so it can only use menu, standaloneWindow, utils, file,
 * preferences, console, http and global. It hosts the standalone Twitch browser
 * window and answers a new-player request from a player entry.
 *
 * The stub deliberately installs throwing accessors for every player-only API
 * (core, mpv, event, overlay, sidebar, playlist, subtitle, input): reading one
 * fails the test instead of silently degrading, which is how "works with no
 * player window" is verified rather than assumed.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "global.js"), "utf8");
const CONFIG_JS = require("../lib/config.js");
const HELIX_JS = require("../lib/helix.js");
const WEBVIEW_JS = require("../lib/webview.js");
const HOSTENV_JS = require("../lib/hostenv.js");
const MIGRATE_JS = require("../lib/migrate.js");
const LIB_BY_SPEC = {
  "./lib/config.js": CONFIG_JS,
  "./lib/helix.js": HELIX_JS,
  "./lib/webview.js": WEBVIEW_JS,
  "./lib/hostenv.js": HOSTENV_JS,
  "./lib/migrate.js": MIGRATE_JS
};
const PLAYER_APIS = ["core", "mpv", "event", "overlay", "sidebar", "playlist", "subtitle", "input"];
const VALIDATE = "https://id.twitch.tv/oauth2/validate";
const identityBody = () => JSON.stringify({ client_id: "cid", login: "me", user_id: "42", scopes: ["chat:read"] });
const micro = () => new Promise((r) => setImmediate(r));

function boot(options) {
  const opts = options || {};
  const calls = { posts: [], log: [], warn: [], http: [], playerAccess: [], menuItems: [], windowCalls: [], players: [], prefsSet: [], windowOpen: false };
  const handlers = { standalone: {}, global: {} };
  const files = opts.files || {};
  const prefs = Object.assign({ config_file: "", overlay_visible: false }, opts.prefs || {});
  const requireStub = (spec) => LIB_BY_SPEC[spec] || {};

  const iina = {
    console: { log: (m) => calls.log.push(String(m)), warn: (m) => calls.warn.push(String(m)) },
    menu: {
      item(title, action, options) { const item = { title, action, options }; calls.menuItems.push(item); return item; },
      addItem(item) { calls.menuItems.push({ added: item }); }
    },
    standaloneWindow: {
      /* IINA's JavascriptAPIStandaloneWindow.loadFile() ends with
       * `messageHub.clearListeners()`, so every listener the plugin registered
       * is gone by the time the page loads; simpleMode() does the same. The stub
       * models that, because a stub that keeps listeners hides a dead
       * page -> host path. */
      loadFile(p) { calls.windowCalls.push({ method: "loadFile", path: p }); handlers.standalone = {}; },
      simpleMode() { handlers.standalone = {}; },
      setProperty(p) { calls.windowCalls.push({ method: "setProperty", properties: p }); },
      setFrame(w, h, x, y) { calls.windowCalls.push({ method: "setFrame", w, h, x, y }); },
      open() { calls.windowCalls.push({ method: "open" }); calls.windowOpen = true; },
      isOpen() { return calls.windowOpen === true; },
      postMessage(name, data) { calls.posts.push({ name, data }); },
      onMessage(name, cb) { handlers.standalone[name] = cb; }
    },
    global: {
      onMessage(name, cb) { handlers.global[name] = cb; },
      createPlayerInstance(o) { calls.players.push(o); return calls.players.length; }
    },
    preferences: {
      get: (k) => (Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : undefined),
      set(k, v) { calls.prefsSet.push(k); prefs[k] = v; },
      sync() {}
    },
    file: {
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      read: (p) => files[p]
    },
    utils: {
      resolvePath: (p) => p === "@data/" && opts.dataPath ? opts.dataPath : p.replace(/^~\//, "/Users/stub/"),
      exec: () => Promise.resolve({ status: 0, stdout: "HOME=/Users/stub\n", stderr: "" }),
      keyChainRead: () => opts.keychain === undefined ? "keytok" : opts.keychain,
      open: () => true
    }
  };
  if (opts.http) {
    iina.http = { get(url, o) { calls.http.push({ url, headers: (o && o.headers) || {} }); return opts.http(url, o); } };
  }
  for (const api of PLAYER_APIS) {
    Object.defineProperty(iina, api, {
      get() { calls.playerAccess.push(api); throw new Error("the global entry must not touch iina." + api); }
    });
  }

  const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  const factory = new Function("iina", "require", "module", "exports", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    MAIN_SRC + "\n//# sourceURL=global.js");
  factory(iina, requireStub, { exports: {} }, {},
    (f, ms) => unref(setTimeout(f, ms)), (id) => clearTimeout(id),
    (f, ms) => unref(setInterval(f, ms)), (id) => clearInterval(id));
  return { calls, handlers, prefs, files };
}

async function ready(app) {
  await micro();
  await micro();
}

/* Opens the standalone window through its menu item, i.e. the path that runs
 * loadFile() and therefore clears/registers the listeners. */
function openWindow(app) {
  const item = app.calls.menuItems.filter((m) => m.title === "Open Twitch Window").pop();
  item.action();
}

test("the global entry opens the standalone window from its own menu item", async () => {
  const app = boot({});
  await ready(app);
  const item = app.calls.menuItems.find((m) => m.title === "Open Twitch Window");
  assert.ok(item, "the menu item exists");
  assert.equal(item.options.keyBinding, "Meta+Shift+W", "⌘⇧W (unused by IINA and by the per-player items)");

  item.action();
  assert.deepEqual(app.calls.windowCalls, [
    { method: "loadFile", path: "ui/standalone.html" },
    { method: "setProperty", properties: { title: "Twitch", resizable: true } },
    { method: "setFrame", w: 980, h: 760, x: null, y: null },
    { method: "open" }
  ]);
  assert.deepEqual(app.calls.playerAccess, [], "and it never touches a player API");
});

test("opening the window pushes the settings without any ready handshake", async () => {
  /* ui/standalone.html posts no "twt:ready"; the host must still deliver the
   * settings (its footer shows the token state from them). */
  const app = boot({});
  await ready(app);
  app.calls.posts.length = 0;
  const item = app.calls.menuItems.find((m) => m.title === "Open Twitch Window");
  item.action();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const first = app.calls.posts.filter((p) => p.name === "twt:settings");
  assert.ok(first.length >= 1, "settings are posted right after opening");
  assert.equal(first[0].data.channel, null);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(app.calls.posts.filter((p) => p.name === "twt:settings").length >= 2,
    "the ladder retries, because postMessage is a no-op until the document exists");
  assert.deepEqual(app.calls.playerAccess, []);
});

test("the standalone view gets its settings with channel: null", async () => {
  const app = boot({ files: { "/Users/stub/.config/twt/config.toml": '[twitch]\ntoken = "cfgtok"\n' } });
  await ready(app);
  openWindow(app);
  await micro();
  app.handlers.standalone["twt:ready"]({ href: "file:///repo/ui/standalone.html" });
  const settings = app.calls.posts.filter((p) => p.name === "twt:settings").pop();
  assert.ok(settings, "settings were posted");
  assert.equal(settings.data.channel, null, "there is no playing media here");
  assert.equal(settings.data.currentChannel, null);
  assert.equal(settings.data.channelSource, "none");
  assert.deepEqual(Object.keys(settings.data).sort(),
    ["channel", "channelNote", "channelSource", "currentChannel", "filters", "settings", "token"]);
  assert.deepEqual(app.calls.playerAccess, []);
});

test("the standalone proxy answers twt:twitch-get with path or url, and blocks the rest", async () => {
  const app = boot({
    files: { "/Users/stub/.config/twt/config.toml": '[twitch]\ntoken = "cfgtok"\n' },
    http: (url) => Promise.resolve({ statusCode: 200, text: url === VALIDATE ? identityBody() : JSON.stringify({ data: [1] }) })
  });
  await ready(app);
  openWindow(app);
  await micro();
  app.handlers.standalone["twt:ready"]({});

  app.handlers.standalone["twt:twitch-get"]({ id: "g1", path: "/helix/streams?first=1", url: "https://api.twitch.tv/helix/streams?first=1" });
  await micro(); await micro();
  app.handlers.standalone["twt:twitch-get"]({ id: "g2", url: "https://api.twitch.tv/helix/users?login=a" });
  await micro(); await micro();
  app.handlers.standalone["twt:twitch-get"]({ id: "g3", path: "/identity" });
  await micro(); await micro();

  const results = app.calls.posts.filter((p) => p.name === "twt:twitch-result").map((p) => p.data);
  assert.deepEqual(results.map((r) => r.id), ["g1", "g2", "g3"]);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
  }
  assert.deepEqual(app.calls.http.map((c) => c.url), [
    VALIDATE,
    "https://api.twitch.tv/helix/streams?first=1",
    "https://api.twitch.tv/helix/users?login=a"
  ], "one validate for the burst, then one Helix call per request (path and url both accepted)");
  assert.deepEqual(app.calls.http[1].headers, { "Client-Id": "cid", Authorization: "Bearer cfgtok" });
  assert.deepEqual(app.calls.http[2].headers, { "Client-Id": "cid", Authorization: "Bearer cfgtok" });
  assert.deepEqual(results[2].data, { userId: "42", login: "me", clientId: "cid", scopes: ["chat:read"] });

  const before = app.calls.http.length;
  for (const request of [
    { id: "b1", path: "/helix/users/follows" },
    { id: "b2", path: "https://api.twitch.tv/helix/users" },
    { id: "b3", url: "https://evil.com/helix/users" },
    { id: "b4", url: "https://api.twitch.tv/helix/chat/messages" },
    { id: "b5" }
  ]) {
    app.handlers.standalone["twt:twitch-get"](request);
    await micro();
  }
  assert.equal(app.calls.http.length, before, "a blocked request never reaches the network");
  const blocked = app.calls.posts.filter((p) => p.name === "twt:twitch-result").slice(-5).map((p) => p.data);
  assert.deepEqual(blocked.map((r) => r.error), ["blocked", "blocked", "blocked", "blocked", "blocked"]);
  assert.deepEqual(app.calls.playerAccess, []);
});

test("the standalone view opens a player window for both targets (createPlayerInstance is the only route)", async () => {
  const app = boot({});
  await ready(app);
  openWindow(app);
  await micro();
  app.handlers.standalone["twt:open"]({ url: "https://www.twitch.tv/someone", target: "current" });
  app.handlers.standalone["twt:open"]({ url: "https://twitch.tv/videos/123", target: "new" });
  assert.deepEqual(app.calls.players, [
    { url: "https://www.twitch.tv/someone", enablePlugins: true },
    { url: "https://twitch.tv/videos/123", enablePlugins: true }
  ], "with no player to switch, both targets create one - and with every plugin loaded, so IINA's yt-dlp plugin can resolve the URL");

  const before = app.calls.players.length;
  app.handlers.standalone["twt:open"]({ url: "https://evil.com/x", target: "current" });
  app.handlers.standalone["twt:open"]({ url: "http://www.twitch.tv/x", target: "new" });
  assert.equal(app.calls.players.length, before, "only twitch.tv URLs open");
  assert.deepEqual(app.calls.playerAccess, []);
});

test("the page's messages reach the host after the window is opened, and after a re-open", async () => {
  /* IINA's standaloneWindow.loadFile() ends with messageHub.clearListeners(), so
   * any listener registered at boot is gone before the page can post. This is
   * the regression: page -> host (twt:twitch-get / twt:open / twt:log) was dead
   * before 1.4.0 while host -> page worked. */
  const app = boot({
    files: { "/Users/stub/.config/twt/config.toml": '[twitch]\ntoken = "cfgtok"\n' },
    http: (url) => Promise.resolve({ statusCode: 200, text: url === VALIDATE ? identityBody() : JSON.stringify({ data: [1] }) })
  });
  await ready(app);
  openWindow(app);
  await micro();
  assert.equal(typeof app.handlers.standalone["twt:twitch-get"], "function", "registered after loadFile");
  assert.equal(typeof app.handlers.standalone["twt:open"], "function");
  assert.equal(typeof app.handlers.standalone["twt:log"], "function");

  app.handlers.standalone["twt:twitch-get"]({ id: "r1", path: "/helix/streams?first=1" });
  await micro(); await micro();
  const first = app.calls.posts.filter((p) => p.name === "twt:twitch-result").pop();
  assert.equal(first.data.id, "r1");
  assert.equal(first.data.ok, true);

  /* opening again loadFile()s again, which clears the listeners once more */
  app.calls.posts.length = 0;
  openWindow(app);
  await micro();
  app.handlers.standalone["twt:twitch-get"]({ id: "r2", path: "/helix/users?login=a" });
  await micro(); await micro();
  const second = app.calls.posts.filter((p) => p.name === "twt:twitch-result").pop();
  assert.equal(second.data.id, "r2", "the re-opened window answers too");
  assert.equal(second.data.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 60));   /* the ladder's first rung is a 0 ms timer */
  assert.ok(app.calls.posts.some((p) => p.name === "twt:settings"), "the settings ladder runs again on the re-open");
  assert.deepEqual(app.calls.playerAccess, []);
});

test("the player entry's new-window message still creates a player", async () => {
  const app = boot({});
  await ready(app);
  assert.equal(typeof app.handlers.global["twt:open-new-player"], "function");
  app.handlers.global["twt:open-new-player"]({ url: "https://www.twitch.tv/someone" });
  assert.deepEqual(app.calls.players, [{ url: "https://www.twitch.tv/someone", enablePlugins: true }]);
  app.handlers.global["twt:open-new-player"]({ url: "" });
  assert.equal(app.calls.players.length, 1, "an empty url is ignored");
});

test("the standalone host takes its token from the config, else the Keychain, and never logs it", async () => {
  const fromConfig = boot({
    files: { "/Users/stub/.config/twt/config.toml": '[twitch]\ntoken = "oauth:cfgtok"\n' },
    keychain: "keytok",
    http: (url) => Promise.resolve({ statusCode: 200, text: url === VALIDATE ? identityBody() : "{}" })
  });
  await ready(fromConfig);
  openWindow(fromConfig);
  await micro();
  fromConfig.handlers.standalone["twt:ready"]({});
  const settings = fromConfig.calls.posts.filter((p) => p.name === "twt:settings").pop();
  assert.equal(settings.data.token.source, "config", "the config token wins");
  assert.equal(settings.data.token.available, true);
  fromConfig.handlers.standalone["twt:twitch-get"]({ id: "c1", path: "/helix/users" });
  await micro();
  assert.equal(fromConfig.calls.http[1].headers.Authorization, "Bearer cfgtok", "the oauth: prefix is stripped");
  const logged = fromConfig.calls.log.concat(fromConfig.calls.warn).join("\n");
  assert.equal(/cfgtok|keytok/.test(logged), false, "no token in the log:\n" + logged);

  const fromKeychain = boot({ keychain: "keytok" });
  await ready(fromKeychain);
  openWindow(fromKeychain);
  await micro();
  fromKeychain.handlers.standalone["twt:ready"]({});
  assert.equal(fromKeychain.calls.posts.pop().data.token.source, "keychain");
  const noToken = boot({ keychain: "" });
  await ready(noToken);
  openWindow(noToken);
  await micro();
  noToken.handlers.standalone["twt:ready"]({});
  assert.deepEqual(noToken.calls.posts.pop().data.token, { available: false, source: "none" });
  assert.deepEqual(noToken.calls.playerAccess, []);
});

const windowOpens = (app) => app.calls.windowCalls.filter((c) => c.method === "open").length;

test("auto_open_browser opens the window once per launch", async () => {
  const app = boot({});
  await micro();
  assert.equal(typeof app.handlers.global["twt:auto-open-browser"], "function");
  assert.equal(windowOpens(app), 0);
  app.handlers.global["twt:auto-open-browser"]();
  assert.equal(windowOpens(app), 1, "the request opens the standalone window");
  app.handlers.global["twt:auto-open-browser"]();
  app.handlers.global["twt:auto-open-browser"]();
  assert.equal(windowOpens(app), 1, "a second player window booting does not open a second browser");
});

test("auto_open_browser leaves an already open window alone", async () => {
  const app = boot({});
  await micro();
  app.calls.menuItems.find((m) => m.title === "Open Twitch Window").action();
  assert.equal(windowOpens(app), 1, "the menu action opened the window");
  app.handlers.global["twt:auto-open-browser"]();
  assert.equal(windowOpens(app), 1, "the startup request does not re-open it");
  assert.equal(app.calls.log.some((m) => /already open/.test(m)), true);
});

const xmlPlist = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.keys(entries).map((k) => `<key>${k}</key><string>${entries[k]}</string>`).join("\n")}
</dict>
</plist>
`;

test("the 1.5.0 preferences are copied before the entry reads them", async () => {
  const LEGACY = "com.kdressler.iina-twitch-chat";
  const CURRENT = "com.kdressler.twitch-iina";
  const plugins = "/Users/stub/Library/Application Support/com.colliderli.iina/plugins";
  const app = boot({
    dataPath: `${plugins}/.data/${CURRENT}`,
    files: {
      [`${plugins}/.preferences/${LEGACY}.plist`]:
        xmlPlist({ config_file: "/tmp/cfg.toml", last_channel: "caedrel" })
    }
  });
  await micro();
  assert.deepEqual(app.calls.prefsSet, ["config_file", "last_channel", "migrated_from"]);
  assert.equal(app.prefs.config_file, "/tmp/cfg.toml");
  assert.equal(app.prefs.migrated_from, LEGACY);
  assert.equal(app.calls.log.some((m) => /migrated 2 preference/.test(m)), true,
    "the migration is logged with its key count");
});
