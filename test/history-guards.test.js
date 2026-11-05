/* Regression tests for the remote-history path in main.js.
 *
 * The crash this guards against: IINA's require() force-unwraps
 * `pluginInstance.currentFile` (JavascriptPolyfill closure #5), which is nil in
 * any timer/promise callback, so requiring a module lazily from the remote
 * history callback trapped (SIGTRAP). The libs must be required exactly once, at
 * module load, and every late callback must be generation- and teardown-guarded.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const CONFIG_JS = require("../lib/config.js");
const IRC_JS = require("../lib/irc.js");
const HELIX_JS = require("../lib/helix.js");
const WEBVIEW_JS = require("../lib/webview.js");
const HOSTENV_JS = require("../lib/hostenv.js");
const MIGRATE_JS = require("../lib/migrate.js");
/* the libs main.js requires at module load, by spec */
const LIB_BY_SPEC = {
  "./lib/config.js": CONFIG_JS,
  "./lib/irc.js": IRC_JS,
  "./lib/helix.js": HELIX_JS,
  "./lib/webview.js": WEBVIEW_JS,
  "./lib/hostenv.js": HOSTENV_JS,
  "./lib/migrate.js": MIGRATE_JS
};
const MANIFEST_SRC = fs.readFileSync(path.join(ROOT, "Info.json"), "utf8");
const MANIFEST = JSON.parse(MANIFEST_SRC);
const DEFAULTS = MANIFEST.preferenceDefaults;
const GLOBAL_SRC = fs.readFileSync(path.join(ROOT, "global.js"), "utf8");
/* read-only: the sidebar's own proxy calls, to check the allowlist covers them */
const BROWSER_SRC = fs.readFileSync(path.join(ROOT, "ui/browser.js"), "utf8");
const micro = () => new Promise((r) => setImmediate(r));
/* the startup ladder's numbers, read from main.js so a change there fails here */
const WINDOW_FALLBACK_MS = Number((/^var WINDOW_FALLBACK_MS = (\d+);/m.exec(MAIN) || [])[1]);
const WEBVIEW_RETRY_MS = ((/^var WEBVIEW_RETRY_MS = \[([^\]]*)\];/m.exec(MAIN) || [])[1] || "")
  .split(",").map((n) => Number(n.trim())).filter((n) => !isNaN(n));
const AUTO_OPEN_SETTLE_MS = Number((/^var AUTO_OPEN_SETTLE_MS = (\d+);/m.exec(MAIN) || [])[1]);
const autoOpenRequests = (app) => app.calls.global.filter((m) => m.name === "twt:auto-open-browser");
/* lets a deferred (setTimeout 0) menu rebuild run; setImmediate can win the race */
const flush = () => new Promise((r) => setTimeout(r, 20));
const RAW_LINE = "@badges=subscriber/3;color=#FF0000;display-name=PomsClih;id=aaa-111;tmi-sent-ts=1792328984433;user-id=1 :pomsclih!pomsclih@pomsclih.tmi.twitch.tv PRIVMSG #chan :Kappa hello";

function boot(options) {
  const opts = options || {};
  const calls = { sidebar: [], overlay: [], log: [], warn: [], http: [], require: [], clickable: [], forceUpdate: 0, opened: [], global: [], osd: [], loadFile: [], show: [], hide: [], prefSet: [], topMenu: [], mpvCommands: [] };
  const handlers = { sidebar: {}, overlay: {}, event: {} };
  const menuItems = [];
  const prefs = Object.assign({}, DEFAULTS, opts.prefs || {});
  const files = opts.files || {};
  let loading = true;
  const requireStub = (spec) => {
    calls.require.push({ spec, runtime: !loading });
    if (!loading) throw new Error("require() must not be called at runtime: " + spec);
    return LIB_BY_SPEC[spec] || IRC_JS;
  };
  /* IINA's JavascriptAPISidebarView/Overlay .loadFile() throw exactly this until
   * the player window exists (seen in the launch logs). */
  let windowReady = opts.windowReady !== false;
  const wv = (owner) => ({
    loadFile() {
      if (!windowReady) {
        throw new Error(owner + ".loadFile called when window is not available. Please call it after receiving the \"iina.window-loaded\" event.");
      }
      calls.loadFile.push(owner);
    },
    show() { calls.show.push(owner); },
    hide() { calls.hide.push(owner); },
    setClickable(v) { calls.clickable.push(!!v); },
    postMessage(name, data) { calls[owner].push({ name, data }); },
    onMessage(name, cb) { handlers[owner][name] = cb; }
  });
  const iina = {
    console: { log: (m) => calls.log.push(String(m)), warn: (m) => calls.warn.push(String(m)), error: (m) => calls.warn.push(String(m)) },
    core: {
      osd: (m) => calls.osd.push(String(m)),
      open(url) { calls.opened.push(url); },
      status: {
        url: opts.url || "",
        title: opts.title || "",
        position: typeof opts.position === "number" ? opts.position : null,
        duration: typeof opts.duration === "number" ? opts.duration : null,
        idle: opts.idle === true
      }
    },
    mpv: {
      getString: (name) => (opts.mpv && opts.mpv[name]) || "",
      command(name, args) { calls.mpvCommands.push({ name, args }); }
    },
    playlist: { list: () => [] },
    event: { on(n, cb) { handlers.event[n] = cb; return n; }, off() {} },
    menu: { item(t, a, o) { const it = { title: t, action: a, options: o, sub: [], addSubMenuItem(s) { this.sub.push(s); return this; } }; menuItems.push(it); return it; }, addItem(item) { calls.topMenu.push(item); },
 separator: () => ({}), items: () => menuItems, removeAllItems() { menuItems.length = 0; }, forceUpdate() { calls.forceUpdate++; } },
    sidebar: wv("sidebar"),
    overlay: wv("overlay"),
    /* the global entry's API as the main entry sees it: postMessage to the
     * global instance; createPlayerInstance itself lives in the global entry */
    global: { postMessage(name, data) { calls.global.push({ name, data }); }, onMessage() {} },
    preferences: {
      get: (k) => (Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : undefined),
      set(k, v) { calls.prefSet.push(k); prefs[k] = v; },
      sync() {}
    },
    file: {
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      read: (p) => files[p],
      write() {}, list: () => []
    },
    utils: {
      resolvePath: (p) => p,
      exec: () => Promise.resolve({ status: 0, stdout: "HOME=/Users/stub\n", stderr: "" }),
      prompt: () => "", ask: () => true,
      keyChainRead: () => "tok123", keyChainWrite: () => true, open: () => true
    }
  };
  if (opts.http || opts.post) {
    iina.http = {
      get: function (url, o) {
        calls.http.push({ method: "GET", url, options: o });
        return opts.http ? opts.http(url, o) : Promise.reject(new Error("no GET fixture"));
      },
      post: function (url, o) {
        calls.http.push({ method: "POST", url, options: o });
        return opts.post ? opts.post(url, o) : Promise.reject(new Error("no POST fixture"));
      }
    };
  }
  /* unref'ed timers: the plugin's poll/watchdog intervals must not keep the test
   * process alive after a test finishes (each test also calls the teardown).
   * The wrapper also counts the plugin's live timers, which is how the tests
   * prove that a window teardown cancels everything the plugin started (a late
   * timer would touch a dead plugin instance). */
  const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  const live = new Map();
  let timerSeq = 0;
  const dropTimer = (id) => {
    const entry = live.get(id);
    if (!entry) return;
    live.delete(id);
    if (entry.interval) clearInterval(entry.handle);
    else clearTimeout(entry.handle);
  };
  const timer = {
    setTimeout: (fn, ms) => {
      const id = ++timerSeq;
      live.set(id, { handle: unref(setTimeout(() => { live.delete(id); fn(); }, ms)), interval: false, ms, fn, stack: new Error().stack });
      return id;
    },
    clearTimeout: (id) => dropTimer(id),
    setInterval: (fn, ms) => {
      const id = ++timerSeq;
      live.set(id, { handle: unref(setInterval(fn, ms)), interval: true, ms, fn, stack: new Error().stack });
      return id;
    },
    clearInterval: (id) => dropTimer(id)
  };
  const factory = new Function("iina", "require", "module", "exports", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    MAIN + "\n//# sourceURL=main.js");
  factory(iina, requireStub, { exports: {} }, {}, timer.setTimeout, timer.clearTimeout, timer.setInterval, timer.clearInterval);
  loading = false;
  return {
    calls, handlers, prefs, menuItems, iina,
    /* the window appearing after the plugin booted (the slow-launch case) */
    setWindowReady(v) { windowReady = !!v; },
    timers: {
      pending: () => live.size,
      describe: () => Array.from(live.values()).map((e) => String(e.stack).split("\n").slice(1, 4).join(" | ")).join("\n---\n"),
      /* Fire the pending timeouts armed for `ms` (the startup ladder), the way a
       * slow launch behaves: the timer runs while no player window exists. */
      fire(ms) {
        let fired = 0;
        for (const [id, entry] of Array.from(live)) {
          if (entry.interval || entry.ms !== ms) continue;
          live.delete(id);
          if (entry.handle) clearTimeout(entry.handle);
          entry.fn();
          fired++;
        }
        return fired;
      }
    }
  };
}

function teardown(app) {
  app.handlers.event["iina.window-will-close"]();
}

async function ready(app) {
  await micro();
  app.handlers.event["iina.window-loaded"]();
  app.handlers.sidebar["twt:ready"]({ href: "file:///repo/ui/sidebar.html" });
}

/* Binds chat the way the product does: the channel comes from the playing
 * media, never from a preference or a sidebar message. Setting the media URL
 * and re-firing the sidebar's ready message runs the same startup decision
 * synchronously (no 800 ms file-decision ladder). It only binds while nothing
 * is bound yet; a real switch goes through iina.file-loaded - see
 * switchChannel(). */
function mediaUrl(channel) {
  return "https://www.twitch.tv/" + channel;
}

function bindChannel(app, channel) {
  app.iina.core.status.url = mediaUrl(channel);
  app.handlers.sidebar["twt:ready"]({ href: "file:///repo/ui/sidebar.html" });
}

/* A channel switch is an iina.file-loaded event plus the file-decision ladder,
 * so the first rung (800 ms) has to be waited out. */
async function switchChannel(app, channel) {
  app.iina.core.status.url = mediaUrl(channel);
  app.handlers.event["iina.file-loaded"](mediaUrl(channel));
  await new Promise((resolve) => setTimeout(resolve, 850));
}

const historyResults = (app) => app.calls.sidebar.filter((c) => c.name === "twt:history-result").map((c) => c.data);

test("the libs are required exactly once, at module load (no runtime require)", async () => {
  const app = boot({ http: () => Promise.resolve({ statusCode: 200, text: JSON.stringify({ messages: [RAW_LINE] }) }), prefs: { history_remote: true } });
  await ready(app);
  bindChannel(app, "chan");
  app.handlers.sidebar["twt:history-request"]({ id: "r1", channel: "chan", roomId: "1", count: 50 });
  await micro();
  assert.deepStrictEqual(app.calls.require.map((r) => r.spec).sort(),
    ["./lib/config.js", "./lib/helix.js", "./lib/hostenv.js", "./lib/irc.js", "./lib/migrate.js", "./lib/webview.js"]);
  assert.equal(app.calls.require.filter((r) => r.runtime).length, 0, "require() was called at runtime, which traps in IINA");
  teardown(app);
});

test("a fresh remote request returns mapped messages and caches them", async () => {
  const app = boot({ http: () => Promise.resolve({ statusCode: 200, text: JSON.stringify({ messages: [RAW_LINE, RAW_LINE] }) }), prefs: { history_remote: true } });
  await ready(app);
  bindChannel(app, "chan");
  app.handlers.sidebar["twt:history-request"]({ id: "r2", channel: "chan", roomId: "1", count: 50 });
  await micro();
  const result = historyResults(app).pop();
  assert.equal(result.id, "r2");
  assert.equal(result.ok, true);
  assert.equal(result.source, "remote");
  assert.equal(result.messages.length, 1, "duplicates are removed");
  assert.equal(result.messages[0].id, "aaa-111");
  assert.equal(result.messages[0].displayName, "PomsClih");
  assert.equal(result.messages[0].text, "Kappa hello");
  assert.equal(result.messages[0].emotes.length, 0);
  assert.equal(result.messages[0].badges[0].name, "subscriber");
  /* the result is cached: a second request answers from the cache without HTTP */
  const httpBefore = app.calls.http.length;
  app.handlers.sidebar["twt:history-request"]({ id: "r3", channel: "chan", roomId: "1", count: 50 });
  await micro();
  assert.equal(app.calls.http.length, httpBefore);
  assert.equal(historyResults(app).pop().source, "cache");
  teardown(app);
});

test("a result arriving after the channel changed is dropped silently", async () => {
  let resolveHttp;
  const betaLine = "@badges=;color=#00FF00;display-name=Beta;id=bbb-222;tmi-sent-ts=1792328990340;user-id=2 :beta!beta@beta.tmi.twitch.tv PRIVMSG #beta :second";
  const app = boot({
    prefs: { history_remote: true },
    http: () => new Promise((resolve) => { resolveHttp = resolve; })
  });
  await ready(app);
  bindChannel(app, "alpha");
  app.handlers.sidebar["twt:history-request"]({ id: "stale", channel: "alpha", roomId: "1", count: 50 });
  await micro();
  assert.equal(historyResults(app).length, 0, "nothing has answered yet");

  await switchChannel(app, "beta");  /* bumps the generation */
  resolveHttp({ statusCode: 200, text: JSON.stringify({ messages: [RAW_LINE] }) });
  await micro(); await micro();
  assert.equal(historyResults(app).filter((r) => r.id === "stale").length, 0, "a stale result must not be answered");

  /* a fresh request for the new channel still works and only sees its own data */
  app.handlers.sidebar["twt:history-request"]({ id: "beta-req", channel: "beta", roomId: "2", count: 50 });
  await micro();
  resolveHttp({ statusCode: 200, text: JSON.stringify({ messages: [betaLine] }) });
  await micro(); await micro();
  const beta = historyResults(app).pop();
  assert.equal(beta.id, "beta-req");
  assert.equal(beta.ok, true);
  assert.equal(beta.source, "remote");
  assert.equal(beta.messages.length, 1);
  assert.equal(beta.messages[0].id, "bbb-222", "alpha's stale payload must not leak into beta");
  teardown(app);
});

test("a result arriving after the window closed does nothing and does not throw", async () => {
  let resolveHttp;
  const app = boot({
    prefs: { history_remote: true },
    http: () => new Promise((resolve) => { resolveHttp = resolve; })
  });
  await ready(app);
  bindChannel(app, "alpha");
  app.handlers.sidebar["twt:history-request"]({ id: "late", channel: "alpha", roomId: "1", count: 50 });
  await micro();
  app.handlers.event["iina.window-will-close"]();
  const logCount = app.calls.log.length;
  resolveHttp({ statusCode: 200, text: JSON.stringify({ messages: [RAW_LINE] }) });
  await micro(); await micro();
  assert.equal(historyResults(app).filter((r) => r.id === "late").length, 0);
  assert.equal(app.calls.log.length, logCount, "nothing may be logged through IINA after teardown");
});

test("an oversized response is rejected instead of parsed", async () => {
  const huge = "x".repeat(2 * 1024 * 1024);
  const app = boot({ http: () => Promise.resolve({ statusCode: 200, text: huge }), prefs: { history_remote: true } });
  await ready(app);
  bindChannel(app, "chan");
  app.handlers.sidebar["twt:history-request"]({ id: "big", channel: "chan", roomId: "1", count: 50 });
  await micro();
  const result = historyResults(app).pop();
  assert.equal(result.ok, false);
  assert.equal(result.error, "response too large");
  teardown(app);
});

test("history_remote off never touches the network", async () => {
  const app = boot({ http: () => Promise.resolve({ statusCode: 200, text: "{}" }) });
  await ready(app);
  bindChannel(app, "chan");
  app.handlers.sidebar["twt:history-request"]({ id: "off", channel: "chan", roomId: "1", count: 50 });
  await micro();
  assert.equal(app.calls.http.length, 0);
  assert.equal(historyResults(app).pop().error, "no cached history");
  teardown(app);
});

/* ---------------------------------------- favourite channels (applyOverrides)
 *
 * The `favorite_channels_csv` preference is gone (the sidebar browser has no
 * favourite-channel switcher any more): settings.chat.favoriteChannels is the
 * config's [frontend] favorite_channels list, untouched.
 */
const lastSettings = (app) => app.calls.sidebar.filter((c) => c.name === "twt:settings").pop().data;

test("the config favourite-channel list feeds the settings unchanged", async () => {
  const app = boot({
    files: {
      "/Users/stub/.config/twt/config.toml":
        '[frontend]\nfavorite_channels = ["Twitch", "Gaules", "twitch"]\n'
    }
  });
  await ready(app);
  assert.deepStrictEqual(lastSettings(app).settings.chat.favoriteChannels, ["Twitch", "Gaules", "twitch"]);
  teardown(app);
});

/* ------------------------------------------------------------ overlay layout
 *
 * One layout is {anchor, dx, dy, w, h}: `anchor` is the panel corner tied to
 * the same viewport corner ("tl"/"tr"/"bl"/"br") and dx/dy are the integer
 * distances (CSS px) from the anchored viewport edges to the panel's anchored
 * edges. The overlay reports continuously while a drag/resize is in flight
 * (<=1 per 100 ms) plus a final report; the plugin clamps, keys the layout by
 * channel (or "default") in `overlay_layouts`, restores it on overlay ready and
 * on channel change, and never echoes it back.
 */
const overlayPosts = (app, name) => app.calls.overlay.filter((c) => c.name === name).map((c) => c.data);
const lastLayout = (app) => overlayPosts(app, "twt:overlay-layout").pop();
const menuAction = (app, title) => app.menuItems.find((m) => m.title === title).action;
const storedLayouts = (app) => JSON.parse(app.prefs.overlay_layouts).channels;
const layoutWrites = (app) => app.calls.prefSet.filter((k) => k === "overlay_layouts").length;

async function overlayReady(app) {
  await ready(app);
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
}

test("the overlay is interactive while visible and click-through when hidden", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await ready(app);
  app.calls.clickable.length = 0;
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
  assert.deepStrictEqual(app.calls.clickable, [true], "a visible overlay lets the page decide per element");

  app.calls.clickable.length = 0;
  app.calls.show.length = 0;
  menuAction(app, "Toggle Twitch Overlay")();
  assert.deepStrictEqual(app.calls.clickable, [false], "hiding it is hard click-through");
  assert.deepStrictEqual(app.calls.hide, ["overlay"]);

  app.calls.clickable.length = 0;
  menuAction(app, "Toggle Twitch Overlay")();
  assert.deepStrictEqual(app.calls.clickable, [true], "showing it becomes interactive again");
  assert.deepStrictEqual(app.calls.show, ["overlay"]);

  /* teardown also ends with click-through */
  app.calls.clickable.length = 0;
  teardown(app);
  assert.deepStrictEqual(app.calls.clickable, [false]);
});

test("the overlay never appears on a non-Twitch video and returns with a Twitch one", async () => {
  const NON_TWITCH = "https://www.youtube.com/watch?v=abc";
  const app = boot({ url: NON_TWITCH, prefs: { overlay_visible: true } });
  await ready(app);
  assert.equal(lastSettings(app).channel, null, "a YouTube video binds nothing");
  assert.deepStrictEqual(app.calls.show, [], "nothing Twitch plays: the panel stays hidden");
  assert.deepStrictEqual(app.calls.loadFile, ["sidebar", "overlay"],
    "the wanted view is loaded warm but never shown");
  assert.equal(app.prefs.overlay_visible, true, "the user's wish is remembered, not overwritten");

  /* toggling on a non-Twitch video changes the wish but never shows the panel */
  const osdBefore = app.calls.osd.length;
  menuAction(app, "Toggle Twitch Overlay")();
  menuAction(app, "Toggle Twitch Overlay")();
  assert.deepStrictEqual(app.calls.show, [], "the toggle cannot force it onto a non-Twitch video");
  assert.equal(app.prefs.overlay_visible, true);
  assert.deepStrictEqual(app.calls.osd.slice(osdBefore),
    ["Twitch: Twitch Chat is only available on Twitch videos"],
    "the inert toggle explains itself");

  /* a Twitch stream arrives: the remembered wish puts the panel back */
  await switchChannel(app, "chan");
  assert.equal(lastSettings(app).channel, "chan");
  assert.deepStrictEqual([...new Set(app.calls.show)], ["overlay"],
    "the overlay is shown with a bound Twitch channel");

  /* and the next non-Twitch video hides it again */
  app.calls.hide.length = 0;
  app.iina.core.status.url = NON_TWITCH;
  app.handlers.event["iina.file-loaded"](NON_TWITCH);
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(lastSettings(app).channel, null, "the channel is released");
  assert.deepStrictEqual(app.calls.hide, ["overlay"], "the panel is hidden as soon as the channel is gone");
  assert.equal(app.prefs.overlay_visible, true, "hiding for the media does not clear the preference");
  teardown(app);
});

test("the layout payload is only {channel, layout} and there is no lock message", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);

  const posted = lastLayout(app);
  assert.deepStrictEqual(Object.keys(posted).sort(), ["channel", "layout"], "no locked/editable anymore");
  assert.equal(posted.channel, "chan");
  assert.equal(posted.layout, null, "nothing is stored yet");
  assert.deepStrictEqual(Object.keys(app.prefs).filter((k) => /locked/.test(k)), [], "no lock preference is declared");

  /* the retired messages are not handled at all */
  assert.equal(app.handlers.overlay["twt:overlay-lock"], undefined);
  assert.equal(app.handlers.overlay["twt:overlay-edit"], undefined);

  app.calls.overlay.length = 0;
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "br", dx: 7, dy: 9, w: 300, h: 200 });
  assert.deepStrictEqual(overlayPosts(app, "twt:overlay-layout"), [], "a report is never echoed back");
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
  assert.deepStrictEqual(lastLayout(app).layout, { anchor: "br", dx: 7, dy: 9, w: 300, h: 200 },
    "a stored layout travels in the payload");
  assert.deepStrictEqual(Object.keys(lastLayout(app)).sort(), ["channel", "layout"]);
  teardown(app);
});

test("continuous drag reports are stored at once and written once per gesture", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  app.calls.prefSet.length = 0;
  app.calls.overlay.length = 0;

  /* three reports inside the debounce window: the last one wins, nothing is echoed */
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tl", dx: 10, dy: 20, w: 300, h: 200 });
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tl", dx: 30, dy: 40, w: 320, h: 210 });
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "br", dx: 5, dy: 6, w: 340, h: 220 });

  assert.equal(layoutWrites(app), 0, "nothing is written before the 250 ms debounce");
  assert.deepStrictEqual(overlayPosts(app, "twt:overlay-layout"), [], "the layout is never echoed back");

  /* the newest report is already the stored one (a fresh ready re-pushes it) */
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
  assert.deepStrictEqual(lastLayout(app).layout, { anchor: "br", dx: 5, dy: 6, w: 340, h: 220 });

  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(layoutWrites(app), 1, "the whole gesture costs one write");
  assert.deepStrictEqual(storedLayouts(app).chan, { anchor: "br", dx: 5, dy: 6, w: 340, h: 220 });

  /* a report that flags the gesture's end writes right away, without waiting
   * for the debounce (the overlay's release/Escape report carries done:true) */
  app.calls.prefSet.length = 0;
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "bl", dx: 1, dy: 2, w: 300, h: 200, done: true });
  assert.equal(layoutWrites(app), 1, "the final report flushes the debounce");
  assert.deepStrictEqual(storedLayouts(app).chan, { anchor: "bl", dx: 1, dy: 2, w: 300, h: 200 },
    "the flushed write holds the final geometry itself");

  /* `final` is accepted as the same flag */
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "bl", dx: 3, dy: 4, w: 300, h: 200, final: true });
  assert.equal(layoutWrites(app), 2, "final:true flushes too");
  assert.deepStrictEqual(storedLayouts(app).chan, { anchor: "bl", dx: 3, dy: 4, w: 300, h: 200 });
  teardown(app);
});

test("the plugin menu is exactly the four first-level items", async () => {
  const app = boot({});
  await ready(app);
  assert.deepStrictEqual(app.calls.topMenu.map((m) => m.title),
    ["Connect / Disconnect", "Toggle Twitch Overlay", "Show Twitch Sidebar", "Config"]);
  assert.equal(app.calls.topMenu.find((m) => m.title === "Toggle Twitch Overlay").options.keyBinding, "Meta+Shift+t");
  assert.equal(app.calls.topMenu.find((m) => m.title === "Show Twitch Sidebar").options.keyBinding, "Meta+Shift+b");

  const config = app.calls.topMenu.find((m) => m.title === "Config");
  assert.deepStrictEqual(config.sub.map((m) => m.title),
    ["Reload Config", "Open Config Folder", "Open Help / README"]);

  /* the removed items have no item and no handler left */
  for (const title of ["Chat", "Detect Channel from Video", "Clear Chat", "Edit Overlay Layout", "Join / Leave Channel\u2026"]) {
    assert.equal(app.menuItems.some((m) => m.title === title), false, title + " is still in the menu");
  }
  assert.equal(MAIN.indexOf("onDetectChannel"), -1);
  assert.equal(MAIN.indexOf("onClearChat"), -1);
  teardown(app);
});

test("a slow launch loads the web views once, after the window exists", async () => {
  /* The launch fallback used to mark state.webviewsLoaded before its
   * sidebar.loadFile() threw, so the real iina.window-loaded returned early and
   * nothing was ever loaded: a window-less attempt must re-arm instead, and the
   * real event must still do the load. */
  const app = boot({ windowReady: false, prefs: { overlay_visible: true } });
  await micro();
  assert.equal(WINDOW_FALLBACK_MS, 3000, "the launch fallback delay is the one the tests fire");
  assert.deepStrictEqual(app.calls.loadFile, [], "boot loads nothing while no window exists");

  assert.equal(app.timers.fire(WINDOW_FALLBACK_MS), 1, "the launch fallback was armed");
  assert.deepStrictEqual(app.calls.loadFile, [], "a window-less attempt loads nothing");
  assert.equal(app.calls.warn.filter((m) => /no player window yet for the web views/.test(m)).length, 1,
    "the failed attempt says why instead of claiming the views are loaded");

  /* the failed attempt armed the retry ladder, which also finds no window */
  assert.equal(app.timers.fire(WEBVIEW_RETRY_MS[0]), 1, "a retry is armed for the failed attempt");
  assert.deepStrictEqual(app.calls.loadFile, [], "the retry does not load the views either");

  /* the window appears and the real event finally arrives */
  app.setWindowReady(true);
  app.handlers.event["iina.window-loaded"]();
  assert.deepStrictEqual(app.calls.loadFile, ["sidebar", "overlay"],
    "the real event loads the sidebar and the (visible) overlay exactly once");

  /* the retry still pending from the ladder must not load them again */
  app.timers.fire(WEBVIEW_RETRY_MS[1]);
  assert.deepStrictEqual(app.calls.loadFile, ["sidebar", "overlay"], "no second load from a stale retry");

  /* and the readiness delivery of both views still works */
  app.handlers.sidebar["twt:ready"]({ href: "file:///repo/ui/sidebar.html" });
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
  assert.equal(app.calls.sidebar.some((c) => c.name === "twt:settings"), true, "the sidebar gets its settings");
  assert.equal(app.calls.overlay.some((c) => c.name === "twt:state"), true, "the overlay gets its state");
  teardown(app);
});

test("a fallback load happens once, and a late window-loaded does not load again", async () => {
  /* The window exists but iina.window-loaded never arrives: the fallback loads
   * the views, and the event turning up later must not load them a second time. */
  const app = boot({});
  await micro();
  assert.equal(app.timers.fire(WINDOW_FALLBACK_MS), 1);
  assert.deepStrictEqual(app.calls.loadFile, ["sidebar"], "the fallback loads the views");

  app.handlers.event["iina.window-loaded"]();
  assert.deepStrictEqual(app.calls.loadFile, ["sidebar"], "the late event does not load them again");
  app.handlers.event["iina.window-loaded"]();
  assert.deepStrictEqual(app.calls.loadFile, ["sidebar"], "nor does a reused window");
  teardown(app);
});

test("auto_open_browser is off by default and never asks the global entry", async () => {
  const app = boot({ idle: true });
  await micro();
  assert.equal(app.timers.fire(AUTO_OPEN_SETTLE_MS), 0, "an unset preference arms no timer");
  assert.deepStrictEqual(autoOpenRequests(app), []);
  teardown(app);
});

test("auto_open_browser asks for the browser window after the settle window", async () => {
  const app = boot({ idle: true, prefs: { auto_open_browser: true } });
  await micro();
  assert.equal(AUTO_OPEN_SETTLE_MS, 2500, "the settle delay the tests fire is the one main.js arms");
  assert.deepStrictEqual(autoOpenRequests(app), [], "nothing happens during the settle window");
  assert.equal(app.timers.fire(AUTO_OPEN_SETTLE_MS), 1, "the settle timer is armed once");
  assert.deepStrictEqual(autoOpenRequests(app), [{ name: "twt:auto-open-browser", data: {} }],
    "the request goes to the global entry, which owns once-per-launch and isOpen()");
  assert.equal(app.timers.fire(AUTO_OPEN_SETTLE_MS), 0, "the request is made once, not on a repeat");
  teardown(app);
});

test("auto_open_browser stands down when media is already playing", async () => {
  const app = boot({ idle: false, prefs: { auto_open_browser: true } });
  await micro();
  assert.equal(app.timers.fire(AUTO_OPEN_SETTLE_MS), 0, "no settle window is armed with media present");
  assert.deepStrictEqual(autoOpenRequests(app), []);
  teardown(app);
});

test("auto_open_browser stands down when media arrives inside the settle window", async () => {
  const app = boot({ idle: true, prefs: { auto_open_browser: true } });
  await micro();
  app.handlers.event["iina.file-loaded"]("https://www.twitch.tv/someone");
  assert.equal(app.timers.fire(AUTO_OPEN_SETTLE_MS), 0, "the settle window was cancelled by the file load");
  assert.deepStrictEqual(autoOpenRequests(app), []);
  teardown(app);
});

test("the menu is published only after the window exists, never from boot", async () => {
  const app = boot({});
  await micro();
  /* IINA builds the Plugin menu from PlayerCore.active.plugins, which does not
   * contain this instance until JavascriptPluginInstance.init returns
   * (PlayerCore.loadPlugins assigns `plugins` after constructing the
   * instances). A forceUpdate() from boot would therefore rebuild the menu
   * without these items - dropping every plugin key equivalent until the Plugin
   * menu is opened - instead of publishing them. */
  assert.equal(app.calls.forceUpdate, 0, "no refresh while the instance is still being constructed");
  app.handlers.event["iina.window-loaded"]();
  assert.equal(app.calls.forceUpdate, 1, "the window loading publishes the items, now that the instance is registered");
  /* IINA re-emits window-loaded when it reuses a cached player window, and the
   * rebuild is the only repair for a menu that still holds another window's
   * items - so every window load refreshes, even when the web views are up. */
  app.handlers.event["iina.window-loaded"]();
  assert.equal(app.calls.forceUpdate, 2, "a reused window refreshes the menu again");
  assert.deepStrictEqual(app.calls.topMenu.map((m) => m.title),
    ["Connect / Disconnect", "Toggle Twitch Overlay", "Show Twitch Sidebar", "Config"],
    "the items are registered before the refresh");
  teardown(app);
});

test("a completed drag is stored per channel and a second channel keeps its own", async () => {
  const app = boot({ url: mediaUrl("alpha"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  app.handlers.overlay["twt:overlay-moved"]({ channel: "alpha", anchor: "tl", dx: 30, dy: 40, w: 320, h: 200 });
  app.handlers.overlay["twt:overlay-moved"]({ channel: "beta", anchor: "br", dx: 10, dy: 20, w: 260, h: 140 });
  teardown(app);
  const channels = storedLayouts(app);
  assert.deepStrictEqual(channels.alpha, { anchor: "tl", dx: 30, dy: 40, w: 320, h: 200 });
  assert.deepStrictEqual(channels.beta, { anchor: "br", dx: 10, dy: 20, w: 260, h: 140 });
});

test("the stored layout is restored on overlay ready and on channel change", async () => {
  const app = boot({
    url: mediaUrl("alpha"),
    prefs: {
      overlay_visible: true,
      overlay_layouts: JSON.stringify({
        version: 1,
        channels: {
          alpha: { anchor: "br", dx: 5, dy: 6, w: 300, h: 180 },
          beta: { anchor: "tl", dx: 1, dy: 2, w: 240, h: 130 }
        }
      })
    }
  });
  await ready(app);
  app.calls.overlay.length = 0;
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
  let pushed = lastLayout(app);
  assert.equal(pushed.channel, "alpha");
  assert.deepStrictEqual(pushed.layout, { anchor: "br", dx: 5, dy: 6, w: 300, h: 180 });

  app.calls.overlay.length = 0;
  await switchChannel(app, "beta");
  pushed = lastLayout(app);
  assert.equal(pushed.channel, "beta");
  assert.deepStrictEqual(pushed.layout, { anchor: "tl", dx: 1, dy: 2, w: 240, h: 130 });
  teardown(app);
});

test("a reported layout is clamped to the floors and never stores a negative gap", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);

  /* sub-minimum size and a negative gap: clamped to the floors, anchored edges kept */
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tr", dx: -12, dy: -3.6, w: 100, h: 40 });
  teardown(app);
  assert.deepStrictEqual(storedLayouts(app).chan, { anchor: "tr", dx: 0, dy: 0, w: 220, h: 120 });
});

test("a legacy {x,y,w,h} layout is accepted as anchor tl and rewritten canonically", async () => {
  const app = boot({
    url: mediaUrl("chan"),
    prefs: {
      overlay_visible: true,
      overlay_layouts: JSON.stringify({ version: 1, channels: { chan: { x: 12, y: 34, w: 300, h: 180 } } })
    }
  });
  await overlayReady(app);
  assert.deepStrictEqual(lastLayout(app).layout, { anchor: "tl", dx: 12, dy: 34, w: 300, h: 180 },
    "the old absolute form is the top-left anchored form");

  /* and it is written back in the anchored shape */
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tl", dx: 12, dy: 34, w: 300, h: 180, done: true });
  await flush();
  assert.deepStrictEqual(storedLayouts(app).chan, { anchor: "tl", dx: 12, dy: 34, w: 300, h: 180 });
  teardown(app);
});

test("a layout that is not finite numbers is ignored", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tl", dx: "nope", dy: 0, w: 300, h: 200 });
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tl", dx: 0, dy: 0, w: NaN, h: 200 });
  app.handlers.overlay["twt:overlay-moved"]({ channel: "chan", anchor: "tl" });
  app.handlers.overlay["twt:overlay-moved"](null);
  await flush();
  assert.deepStrictEqual(app.calls.prefSet.filter((k) => k === "overlay_layouts"), [], "nothing was written");
  assert.equal(app.prefs.overlay_layouts, "", "the preference is untouched");
  assert.equal(lastLayout(app).layout, null);
  teardown(app);
});

test("a corrupt overlay_layouts preference is ignored without throwing", async () => {
  for (const raw of ["{not json", '"a string"', '{"version":1}']) {
    const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true, overlay_layouts: raw } });
    await overlayReady(app);
    assert.equal(lastLayout(app).layout, null, "no layout is restored from " + raw);
    teardown(app);
  }
});

test("more than 50 stored channels prunes the least recently used layout", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  for (let i = 0; i < 55; i++) {
    app.handlers.overlay["twt:overlay-moved"]({ channel: "c" + i, x: 1, y: 2, w: 300, h: 200 });
  }
  teardown(app);
  const channels = storedLayouts(app);
  assert.equal(Object.keys(channels).length, 50);
  assert.equal(channels.c0, undefined, "the oldest layout is pruned");
  assert.equal(channels.c4, undefined);
  assert.ok(channels.c5, "the 50 newest survive");
  assert.ok(channels.c54, "the newest layout survives");
});

/* ------------------------------------------------ chat binding (video only)
 *
 * Chat lives only in the video overlay and is always bound to the playing
 * stream. The config channel, the `channel`/`last_channel` preferences and any
 * manual switching are gone, and sidebar-originated twt:join/twt:part/twt:say
 * are ignored.
 */
const joinsTo = (app, target) => app.calls[target].filter((c) => c.name === "twt:join").map((c) => c.data.channel);

test("chat binds from the playing video and the old config/manual paths are gone", async () => {
  const app = boot({
    prefs: { channel: "cfgchan", last_channel: "remembered", overlay_visible: true },
    files: { "/Users/stub/.config/twt/config.toml": '[twitch]\nchannel = "cfgchan"\n' }
  });
  await overlayReady(app);
  /* nothing Twitch is playing: no channel and no join, despite the config */
  assert.equal(lastSettings(app).channel, null);
  assert.equal(lastSettings(app).channelSource, "none");
  assert.deepStrictEqual(joinsTo(app, "sidebar"), []);

  bindChannel(app, "detected");
  assert.deepStrictEqual(joinsTo(app, "sidebar"), ["detected"]);
  assert.deepStrictEqual(joinsTo(app, "overlay"), ["detected"]);
  assert.equal(lastSettings(app).channel, "detected");
  assert.equal(lastSettings(app).channelSource, "video");

  /* a fake sidebar join/part/say has no handler at all and cannot bind */
  assert.equal(typeof app.handlers.sidebar["twt:join"], "undefined");
  assert.equal(typeof app.handlers.sidebar["twt:part"], "undefined");
  assert.equal(typeof app.handlers.sidebar["twt:say"], "undefined");
  assert.deepStrictEqual(joinsTo(app, "sidebar"), ["detected"], "no extra join from the sidebar");

  /* leaving the video releases the channel */
  app.iina.core.status.url = "https://www.youtube.com/watch?v=abc";
  app.handlers.event["iina.file-loaded"]("https://www.youtube.com/watch?v=abc");
  await new Promise((resolve) => setTimeout(resolve, 850));
  const part = app.calls.sidebar.filter((c) => c.name === "twt:part").pop();
  assert.deepStrictEqual(part.data, { channel: "detected" });
  assert.equal(lastSettings(app).channel, null);
  assert.equal(lastSettings(app).channelSource, "none");
  teardown(app);
});

test("the removed channel preferences and helpers are gone from the plugin", async () => {
  for (const key of ["channel", "favorite_channels_csv", "last_channel"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS, key), false, "Info.json still declares " + key);
  }
  for (const symbol of ["preferredChannel", "onJoinLeaveChannel", "promptChannel", "declinedChannel", "rememberChannel", "autoChannel"]) {
    assert.equal(MAIN.indexOf(symbol), -1, "main.js still contains " + symbol);
  }
  /* the Join / Leave menu item is gone too */
  const app = boot({});
  await ready(app);
  assert.equal(app.menuItems.some((m) => /Join \/ Leave/.test(m.title)), false);
  teardown(app);
});

test("auto_join=false never binds, and turning it on binds the detected channel", async () => {
  const app = boot({
    url: mediaUrl("chan"),
    prefs: { auto_join: false, overlay_visible: true }
  });
  await overlayReady(app);
  assert.equal(lastSettings(app).channel, null, "nothing binds while auto_join is off");
  assert.deepStrictEqual(joinsTo(app, "sidebar"), []);
  assert.equal(lastSettings(app).channelSource, "none");

  /* the settings page flips auto_join on: the 700 ms preference poll picks it
   * up and re-evaluates the binding */
  app.prefs.auto_join = true;
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepStrictEqual(joinsTo(app, "sidebar"), ["chan"]);
  assert.equal(lastSettings(app).channel, "chan");
  assert.equal(lastSettings(app).channelSource, "video");
  teardown(app);
});

/* ------------------------------------------------------ Twitch API proxy */
const twitchResults = (app) => app.calls.sidebar.filter((c) => c.name === "twt:twitch-result").map((c) => c.data);
/* The proxy's allowlist, parsed out of the shared lib so the tests pin the
 * exact set (main.js delegates to lib/helix.js since the extraction). */
const HELIX_SRC = fs.readFileSync(path.join(ROOT, "lib", "helix.js"), "utf8");
const ALLOWED_PATHS = (function () {
  const match = /var ALLOWED_PATHS = \[([\s\S]*?)\n  \];/.exec(HELIX_SRC);
  return match ? match[1].split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => JSON.parse(entry)) : [];
})();
/* One request per allow-listed path (bar /identity, which is answered from the
 * validation), used by the coverage test below. */
const ALLOWLIST_FIXTURES = [
  "/helix/users?login=a",
  "/helix/streams?user_login=a",
  "/helix/videos?user_id=42&type=archive&after=eyJjdXJzb3IiOjF9&first=20",
  "/helix/games/top?first=10",
  "/helix/channels/followed?first=20",
  "/helix/search/channels?query=foo&first=5",
  "/helix/search/categories?query=foo&first=20"
];
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const identityBody = () => JSON.stringify({ client_id: "cid", login: "me", user_id: "42", scopes: ["chat:read"] });

test("twt:twitch-get validates once then calls the allowed Helix path with both headers", async () => {
  const app = boot({
    http: (url) => Promise.resolve({
      statusCode: 200,
      text: url === VALIDATE_URL ? identityBody() : JSON.stringify({ data: [{ id: "s1", user_login: "foo" }] })
    })
  });
  await ready(app);
  assert.equal(typeof app.handlers.sidebar["twt:twitch-get"], "function");

  app.handlers.sidebar["twt:twitch-get"]({ id: "g1", path: "/helix/streams?user_login=foo" });
  await micro(); await micro(); await micro();

  assert.equal(app.calls.http.length, 2, "one validate then one Helix request");
  assert.equal(app.calls.http[0].url, VALIDATE_URL);
  assert.deepStrictEqual(app.calls.http[0].options.headers, { Authorization: "OAuth tok123" });
  assert.equal(app.calls.http[1].url, "https://api.twitch.tv/helix/streams?user_login=foo");
  assert.deepStrictEqual(app.calls.http[1].options.headers, { "Client-Id": "cid", Authorization: "Bearer tok123" });

  const result = twitchResults(app).pop();
  assert.equal(result.id, "g1");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.error, null);
  assert.deepStrictEqual(result.data, { data: [{ id: "s1", user_login: "foo" }] });
  teardown(app);
});

test("the identity is cached and user_id is injected for the followed channels", async () => {
  const app = boot({
    http: (url) => Promise.resolve({
      statusCode: 200,
      text: url === VALIDATE_URL ? identityBody() : JSON.stringify({ data: [] })
    })
  });
  await ready(app);

  app.handlers.sidebar["twt:twitch-get"]({ id: "i1", path: "/identity" });
  await micro();
  const identity = twitchResults(app).pop();
  assert.equal(identity.ok, true);
  assert.equal(identity.status, 200);
  assert.deepStrictEqual(identity.data, { userId: "42", login: "me", clientId: "cid", scopes: ["chat:read"] });
  assert.equal(app.calls.http.length, 1, "/identity is answered without a Helix call");

  app.handlers.sidebar["twt:twitch-get"]({ id: "f1", path: "/helix/channels/followed?first=20" });
  await micro();
  assert.equal(app.calls.http.length, 2, "the cached identity avoids a second validate");
  assert.equal(app.calls.http[1].url, "https://api.twitch.tv/helix/channels/followed?first=20&user_id=42");

  /* an explicit user_id is left alone */
  app.handlers.sidebar["twt:twitch-get"]({ id: "f2", path: "/helix/channels/followed?user_id=99" });
  await micro();
  assert.equal(app.calls.http[2].url, "https://api.twitch.tv/helix/channels/followed?user_id=99");

  /* the deprecated endpoint is not in the allowlist any more: blocked, no HTTP */
  const before = app.calls.http.length;
  app.handlers.sidebar["twt:twitch-get"]({ id: "f3", path: "/helix/users/follows?first=20" });
  await micro();
  assert.equal(app.calls.http.length, before, "a removed path never reaches the network");
  assert.equal(twitchResults(app).pop().error, "blocked");
  teardown(app);
});

test("twt:twitch-get blocks unknown paths, absolute URLs and other hosts without HTTP", async () => {
  const app = boot({ http: () => { throw new Error("the proxy must not call the network here"); } });
  await ready(app);
  const paths = [
    "/helix/chat/messages",
    "/helix/users/../streams",
    "/identity/extra",
    "https://evil.com/helix/users",
    "//evil.com/helix/users",
    ""
  ];
  for (const path of paths) {
    app.handlers.sidebar["twt:twitch-get"]({ id: "b", path });
    await micro();
  }
  assert.equal(app.calls.http.length, 0);
  const results = twitchResults(app);
  assert.equal(results.length, paths.length);
  for (const result of results) {
    assert.equal(result.ok, false, "blocked path must fail");
    assert.equal(result.error, "blocked");
    assert.equal(result.data, null);
  }
  teardown(app);
});

test("a 401 from validate answers token invalid", async () => {
  /* IINA rejects non-2xx responses with the same dict, so a real 401 arrives
   * through the rejection branch */
  const app = boot({
    http: (url) => url === VALIDATE_URL
      ? Promise.reject({ statusCode: 401, reason: "Unauthorized", text: "{}" })
      : Promise.reject(new Error("the Helix call must not happen"))
  });
  await ready(app);
  app.handlers.sidebar["twt:twitch-get"]({ id: "e1", path: "/helix/users" });
  await micro(); await micro();
  const result = twitchResults(app).pop();
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "token invalid");
  assert.equal(app.calls.http.length, 1, "the Helix call is skipped");
  teardown(app);
});

test("the proxy never logs the token or the Authorization header", async () => {
  const app = boot({
    http: (url) => Promise.resolve({
      statusCode: url === VALIDATE_URL ? 200 : 500,
      text: url === VALIDATE_URL ? identityBody() : "{}"
    })
  });
  await ready(app);
  app.handlers.sidebar["twt:twitch-get"]({ id: "l1", path: "/helix/users" });
  await micro(); await micro();
  app.handlers.sidebar["twt:twitch-get"]({ id: "l2", path: "/helix/channels/followed" });
  await micro(); await micro();
  const logged = app.calls.log.concat(app.calls.warn).join("\n");
  assert.equal(/tok123|Authorization|Bearer|OAuth/.test(logged), false, "the token/header must never be logged:\n" + logged);
  teardown(app);
});

/* ---------------------------------------------------------------- twt:open */
test("twt:open loads through mpv in the current window and a new window goes through the global API", async () => {
  const app = boot({});
  await ready(app);
  assert.equal(typeof app.handlers.sidebar["twt:open"], "function");

  /* current: mpv's own loadfile, so IINA never opens its loading window */
  app.handlers.sidebar["twt:open"]({ url: "https://www.twitch.tv/someone", target: "current" });
  assert.deepStrictEqual(app.calls.mpvCommands, [{ name: "loadfile", args: ["https://www.twitch.tv/someone", "replace", "-1", "vid=auto,aid=auto"] }]);
  assert.deepStrictEqual(app.calls.opened, [], "core.open is not used for the current window any more");

  /* new: the global entry creates a player instance */
  app.handlers.sidebar["twt:open"]({ url: "https://twitch.tv/videos/123", target: "new" });
  assert.equal(app.calls.mpvCommands.length, 1, "the new-window target does not touch mpv");
  assert.deepStrictEqual(app.calls.global, [{ name: "twt:open-new-player", data: { url: "https://twitch.tv/videos/123" } }]);

  /* validation precedes the load */
  const urls = [
    "https://evil.com/someone",
    "http://www.twitch.tv/someone",
    "https://www.twitch.tv.evil.com/someone",
    "https://www.twitch.tv:8443/someone",
    "javascript:alert(1)"
  ];
  for (const url of urls) app.handlers.sidebar["twt:open"]({ url, target: "current" });
  assert.equal(app.calls.mpvCommands.length, 1, "a rejected URL never reaches mpv");
  assert.equal(app.calls.opened.length, 0);
  assert.equal(app.calls.global.length, 1);
  teardown(app);
});

test("a failed mpv load warns once and unbinds the channel", async () => {
  const app = boot({
    url: mediaUrl("previous"),
    prefs: { overlay_visible: true }
  });
  await overlayReady(app);
  assert.equal(lastSettings(app).channel, "previous", "a channel is bound first");

  app.handlers.sidebar["twt:open"]({ url: mediaUrl("broken"), target: "current" });
  assert.deepStrictEqual(app.calls.mpvCommands.pop().args, [mediaUrl("broken"), "replace", "-1", "vid=auto,aid=auto"]);
  const osdBefore = app.calls.osd.length;
  const warnsBefore = app.calls.warn.length;

  /* mpv reports the end of the old file and nothing new ever starts */
  app.iina.core.status.url = "";
  app.iina.core.status.idle = true;
  app.handlers.event["mpv.end-file"]();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(app.calls.osd.length, osdBefore + 1, "exactly one OSD");
  assert.ok(/could not be opened/.test(app.calls.osd[app.calls.osd.length - 1]), "the OSD says the URL failed");
  assert.equal(app.calls.warn.length, warnsBefore + 1, "exactly one warning");
  const part = app.calls.sidebar.filter((c) => c.name === "twt:part").pop();
  assert.deepStrictEqual(part.data, { channel: "previous" }, "chat was unbound");
  assert.equal(lastSettings(app).channel, null, "no channel stays bound to a stream that did not load");

  /* a second end-file must not repeat any of it */
  const osdAfter = app.calls.osd.length;
  app.handlers.event["mpv.end-file"]();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(app.calls.osd.length, osdAfter, "the failure is reported once");
  teardown(app);
});

test("a successful mpv load settles the pending load, so a later stop is not a failure", async () => {
  const app = boot({
    url: mediaUrl("previous"),
    prefs: { overlay_visible: true }
  });
  await overlayReady(app);

  app.handlers.sidebar["twt:open"]({ url: mediaUrl("nextchannel"), target: "current" });
  /* a replace makes mpv end the old file while the new one loads */
  app.handlers.event["mpv.end-file"]();
  app.iina.core.status.url = mediaUrl("nextchannel");
  app.iina.core.status.idle = false;
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(app.calls.osd.some((m) => /could not be opened/.test(m)), false,
    "a load that works is never reported as failed");
  assert.equal(app.calls.osd.filter((m) => /^Twitch: opening /.test(m)).length, 1, "the opening OSD");
  assert.equal(app.calls.sidebar.some((c) => c.name === "twt:part"), false, "nothing was unbound");
  assert.equal(lastSettings(app).channel, "nextchannel", "the ladder bound the new channel");
  assert.deepStrictEqual(app.calls.sidebar.filter((c) => c.name === "twt:join").map((c) => c.data.channel),
    ["previous", "nextchannel"], "the switch bound the new channel");

  /* the media is stopped later: the pending load was already settled by the
   * successful switch, so this end-file must not be read as a load failure */
  const osdBefore = app.calls.osd.length;
  app.iina.core.status.url = "";
  app.iina.core.status.idle = true;
  app.handlers.event["mpv.end-file"]();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(app.calls.osd.length, osdBefore, "no failure OSD for the later stop");

  /* the ladder's empty-token rung is what releases the channel then */
  app.handlers.event["mpv.path.changed"]();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(lastSettings(app).channel, null, "a stop releases the channel");
  teardown(app);
});

test("two quick switches leave the second stream loading and bound", async () => {
  const app = boot({ url: mediaUrl("first"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  app.handlers.sidebar["twt:open"]({ url: mediaUrl("second"), target: "current" });
  app.handlers.sidebar["twt:open"]({ url: mediaUrl("third"), target: "current" });
  assert.deepStrictEqual(app.calls.mpvCommands.map((c) => c.args[0]),
    [mediaUrl("second"), mediaUrl("third")], "the second loadfile is the one in flight");

  /* the first load's end-file arrives late: it must not fail the second load
   * (the ladder's own "joined …" OSD may appear meanwhile - only a failure OSD
   * would be wrong here) */
  app.iina.core.status.url = mediaUrl("third");
  app.iina.core.status.idle = false;
  app.handlers.event["mpv.end-file"]();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(app.calls.osd.filter((m) => /could not be opened/.test(m)).length, 0,
    "no failure is reported for the superseded load");
  assert.equal(app.calls.sidebar.some((c) => c.name === "twt:part"), false);

  app.handlers.event["mpv.path.changed"]();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(lastSettings(app).channel, "third", "the second switch wins");
  teardown(app);
});

test("a failed load with nothing bound before warns but parts nothing", async () => {
  const app = boot({});
  await ready(app);
  assert.equal(app.calls.sidebar.filter((c) => c.name === "twt:join").length, 0);
  app.handlers.sidebar["twt:open"]({ url: mediaUrl("nobody"), target: "current" });
  app.iina.core.status.url = "";
  app.iina.core.status.idle = true;
  const osdBefore = app.calls.osd.length;
  app.handlers.event["mpv.end-file"]();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(app.calls.osd.length, osdBefore + 1, "the failure is still reported");
  assert.equal(app.calls.sidebar.some((c) => c.name === "twt:part"), false, "nothing to unbind");
  assert.equal(lastSettings(app).channel, null);
  teardown(app);
});

test("a decision ladder with no media releases the channel", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  assert.equal(lastSettings(app).channel, "chan");

  /* the player stops: mpv.path.changed fires with no media and iina.file-loaded
   * never arrives for the next one */
  app.iina.core.status.url = "";
  app.iina.mpvCommand = null;
  app.handlers.event["mpv.path.changed"]();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepStrictEqual(app.calls.sidebar.filter((c) => c.name === "twt:part").map((c) => c.data.channel), ["chan"]);
  assert.equal(lastSettings(app).channel, null, "nothing may stay bound when nothing plays");
  teardown(app);
});

/* --------------------------------------------------- IINA's web-view bridge
 *
 * IINA's JavascriptMessageHub.postMessage builds
 *   window.iina._emit(`<name>`, String.raw`<json>`)
 * and evaluates it; the bridge's _emit JSON.parses the string it gets and hands
 * the value to the registered listener. `call.data` below is what main.js
 * passed to postMessage(), i.e. already encodeForWebview()'d. This helper is a
 * faithful replay of that step, so a payload that would break the template
 * literal (backtick) or be interpolated ("${") fails the test loudly.
 */
function throughBridge(call) {
  const json = JSON.stringify(call.data);
  const script = "window.iina._emit(`" + call.name + "`, String.raw`" + json + "`)";
  const seen = [];
  const fakeWindow = {
    iina: {
      _emit: function (name, dataString) { seen.push({ name: name, data: JSON.parse(dataString) }); }
    }
  };
  new Function("window", script)(fakeWindow);
  return seen[0];
}

/* ui/protocol.js decodes the {__b64} markers in the web view; the tests need
 * that same view-side step to see what a listener would actually receive. */
function decodeForView(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return value;
  if (Object.prototype.toString.call(value) === "[object Array]") return value.map(decodeForView);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "__b64") {
    return Buffer.from(String(value.__b64), "base64").toString("utf8");
  }
  const out = {};
  for (const key of keys) out[key] = decodeForView(value[key]);
  return out;
}

/* ------------------------------------------------------- VOD chat replay
 *
 * Twitch has no official VOD-chat API, so the plugin uses the undocumented GQL
 * operation the web player calls. These tests pin the frozen body, the paging
 * and the emission rules with a stubbed iina.http.post.
 */
const VOD_URL = "https://www.twitch.tv/videos/1234567890";
const VOD_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";
const vodCalls = (app) => app.calls.http.filter((c) => c.method === "POST");
const vodBodies = (app) => vodCalls(app).map((c) => c.options.data);
const overlayEvents = (app) => app.calls.overlay.filter((c) => c.name === "twt:event").map((c) => c.data.event);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1150));
const settle = () => new Promise((resolve) => setTimeout(resolve, 350));
/* the replay always reaches the network through a 0 ms plugin timer, which only
 * runs on a real timer turn, so a microtask flush is not enough */
const soon = () => new Promise((resolve) => setTimeout(resolve, 40));
const ok200 = (body) => ({ statusCode: 200, text: JSON.stringify(body) });

function vodEdge(id, offset, options) {
  const o = options || {};
  const fragments = [{ text: o.text === undefined ? "hi" : o.text }];
  if (o.emote) fragments.push({ text: "Kappa", emote: { emoteID: o.emote } });
  return {
    node: {
      id: id,
      contentOffsetSeconds: offset,
      commenter: { id: "uid-" + id, login: "login-" + id, displayName: "Name " + id },
      message: {
        fragments: fragments,
        userColor: o.color === undefined ? "#00FF00" : o.color,
        /* the probe: badges live on the message, never on the fragments */
        userBadges: o.badges
      }
    }
  };
}

function vodPage(edges, hasNext) {
  return { data: { video: { comments: { edges: edges, pageInfo: { hasNextPage: hasNext } } } } };
}

/* the offset of every request the plugin made (offset stepping, no cursors) */
const vodOffsets = (app) => vodBodies(app).map((b) => b.variables.contentOffsetSeconds);

test("VOD replay emits a page's comments on the tick, in order and never early", async () => {
  const app = boot({
    url: VOD_URL,
    title: "ohnePixel \u2014 VITY vs LOUD",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([
      vodEdge("a", 5),
      vodEdge("b", 10),
      vodEdge("c", 15),
      vodEdge("d", 20, { text: "hello ", emote: "25", badges: [{ setID: "moderator", version: "1" }] })
    ], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();

  assert.equal(lastSettings(app).vodReplay, true, "the mode travels in twt:settings");
  assert.equal(lastSettings(app).channelNote, "VOD chat replay");
  assert.equal(lastSettings(app).channel, "ohnepixel", "the channel still comes from the normal detection");
  assert.deepStrictEqual(vodBodies(app), [{
    operationName: "VideoCommentsByOffsetOrCursor",
    variables: { videoID: "1234567890", contentOffsetSeconds: 0 },
    extensions: { persistedQuery: { version: 1, sha256Hash: VOD_HASH } }
  }]);
  assert.deepStrictEqual(overlayEvents(app), [], "nothing is emitted before the playhead arrives");

  app.iina.core.status.position = 12;
  await tick();
  assert.deepStrictEqual(overlayEvents(app).map((e) => e.offsetSeconds), [5, 10], "due comments in order, never early");
  const first = overlayEvents(app)[0];
  assert.equal(first.kind, "message");
  assert.equal(first.replay, true);
  assert.equal(first.id, "a");
  assert.equal(first.login, "login-a");
  assert.equal(first.displayName, "Name a");
  assert.equal(first.userId, "uid-a");
  assert.equal(first.color, "#00FF00");
  assert.equal(first.text, "hi");
  assert.equal(first.emotes.length, 0);
  assert.equal(first.badges.length, 0);
  assert.equal(first.channel, "ohnepixel");
  assert.equal(typeof first.timestamp, "number");
  assert.equal(vodCalls(app).length, 1, "the last page is reached, so nothing more is fetched");
  assert.equal(lastSettings(app).vodError, null);
  assert.deepStrictEqual(lastSettings(app).vodStats, { pages: 1, comments: 4, offset: 0 });

  app.iina.core.status.position = 25;
  await tick();
  const rest = overlayEvents(app).slice(2);
  assert.deepStrictEqual(rest.map((e) => e.offsetSeconds), [15, 20]);
  assert.deepStrictEqual(rest[1].emotes, [{ id: "25", ranges: [[6, 10]] }]);
  assert.deepStrictEqual(rest[1].badges, [{ name: "moderator", version: "1" }], "badges come from message.userBadges");
  assert.equal(rest[1].text, "hello Kappa");
  teardown(app);
});

test("an empty emote index clears the overlay instead of being dropped", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await ready(app);
  app.handlers.overlay["twt:ready"]({ href: "file:///repo/ui/overlay.html" });
  app.calls.overlay.length = 0;

  app.handlers.sidebar["twt:emotes"]({ index: { o7: "https://cdn.7tv.app/emote/o7/2x.webp" } });
  assert.deepEqual(overlayPosts(app, "twt:emotes").pop().index,
    { o7: "https://cdn.7tv.app/emote/o7/2x.webp" });

  app.calls.overlay.length = 0;
  app.handlers.sidebar["twt:emotes"]({ index: {} });
  assert.deepEqual(overlayPosts(app, "twt:emotes").pop().index, {},
    "an explicit empty index is a clear, not a malformed payload");
  teardown(app);
});

test("a VOD with no channel in the title publishes its creator id and joins nothing", async () => {
  let pages = 0;
  const page = (edges, hasNext) => ({
    data: {
      video: {
        creator: { id: "93869876" },
        comments: { edges: edges, pageInfo: { hasNextPage: hasNext } }
      }
    }
  });
  const app = boot({
    url: VOD_URL,
    title: "Busted ?",
    position: 20,
    duration: 60,
    prefs: { overlay_visible: true },
    post: () => {
      pages++;
      if (pages === 1) {
        return Promise.resolve(ok200(page([
          vodEdge("o7-1", 5, { text: "o7" }),
          vodEdge("ta-1", 6, { text: "ta" })
        ], true)));
      }
      return Promise.resolve(ok200(page([vodEdge("more-1", 7, { text: "o7 ta" })], false)));
    }
  });
  await overlayReady(app);
  await settle();
  await micro();

  const settings = lastSettings(app);
  assert.equal(settings.channel, null, "the title names no channel");
  assert.equal(settings.vodOwnerId, "93869876", "the creator id travels to the sidebar");
  assert.equal(settings.vodReplay, true);
  assert.deepStrictEqual(joinsTo(app, "sidebar"), [], "nothing joins the video id as a channel");
  const ownerBroadcasts = app.calls.sidebar
    .filter((c) => c.name === "twt:settings" && c.data.vodOwnerId === "93869876");
  assert.equal(ownerBroadcasts.length, 2,
    "the owner change is broadcast once, and vodEnd once - never once per page");

  const replayed = overlayEvents(app);
  assert.deepStrictEqual(replayed.map((e) => e.text), ["o7", "ta", "o7 ta"]);
  assert.equal(replayed[0].channel, "", "a replay row without a channel stays empty");
  teardown(app);
});

test("VOD replay steps the offset and pages only while it has to", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    post: (url, o) => o.data.variables.contentOffsetSeconds === 0
      ? Promise.resolve(ok200(vodPage([vodEdge("x", 5), vodEdge("y", 10)], true)))
      : Promise.resolve(ok200(vodPage([vodEdge("z", 30)], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  assert.equal(vodCalls(app).length, 1);

  await settle();
  await micro(); await micro();
  assert.equal(vodCalls(app).length, 2, "the playhead is within 20 s of the buffered end, so the next page is fetched");
  assert.deepStrictEqual(vodBodies(app)[1].variables, { videoID: "1234567890", contentOffsetSeconds: 11 },
    "the next offset is the newest comment of the last page + 1 (no cursor)");
  assert.deepStrictEqual(vodBodies(app).map((b) => Object.keys(b.variables).sort()), [["contentOffsetSeconds", "videoID"], ["contentOffsetSeconds", "videoID"]],
    "no request ever carries a cursor");

  await settle();
  assert.equal(vodCalls(app).length, 2, "hasNextPage=false ends the paging");
  assert.deepStrictEqual(lastSettings(app).vodStats, { pages: 2, comments: 3, offset: 11 });
  teardown(app);
});

test("an overlapping page is deduped by id and a page of only duplicates ends the replay", async () => {
  /* Every page starts a few seconds before the requested offset (the probe
   * measured 6-21 s), so page 2 repeats ids page 1 already had: they must be
   * dropped, and a page of NOTHING but repeats ends the replay. */
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    post: (url, o) => {
      const offset = o.data.variables.contentOffsetSeconds;
      if (offset === 0) {
        return Promise.resolve(ok200(vodPage([vodEdge("c0", 0), vodEdge("c1", 1)], true)));
      }
      if (offset === 2) {
        return Promise.resolve(ok200(vodPage([vodEdge("c0", 0), vodEdge("c1", 1), vodEdge("c2", 2)], true)));
      }
      /* only ids we already have: stop here */
      return Promise.resolve(ok200(vodPage([vodEdge("c1", 1), vodEdge("c2", 2)], true)));
    }
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  await settle();
  await micro(); await micro();
  await settle();
  await micro(); await micro();
  app.iina.core.status.position = 2;
  await tick();

  const ids = overlayEvents(app).map((e) => e.id);
  assert.deepStrictEqual(ids, ["c0", "c1", "c2"], "each id once, in offset order");
  assert.equal(new Set(ids).size, ids.length, "no id is emitted twice");
  assert.deepStrictEqual(vodOffsets(app), [0, 2, 3], "the offset steps past the newest comment each time");
  assert.equal(vodCalls(app).length, 3, "the duplicate-only page ends the replay after it");
  assert.equal(lastSettings(app).vodError, null, "running out of new comments is not a failure");
  assert.deepStrictEqual(lastSettings(app).vodStats, { pages: 3, comments: 3, offset: 3 });
  teardown(app);
});

test("a service error past the end of the comments is a normal end, not a failure", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    duration: 32082,
    prefs: { overlay_visible: true },
    post: (url, o) => o.data.variables.contentOffsetSeconds === 0
      ? Promise.resolve(ok200(vodPage([vodEdge("a", 5), vodEdge("b", 10)], true)))
      : Promise.resolve(ok200({ errors: [{ message: "service error" }], data: { video: { comments: null } } }))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  await settle();
  await micro(); await micro();
  assert.equal(vodCalls(app).length, 2, "the past-the-end answer stops the paging");
  assert.equal(lastSettings(app).vodError, null, "no error is surfaced for a normal end");
  assert.equal(app.calls.osd.some((m) => /VOD chat replay unavailable/.test(m)), false);
  assert.equal(app.calls.warn.some((m) => /vod chat replay unavailable/.test(m)), false);
  teardown(app);
});

test("the replay stops once the offset passes the media duration", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    duration: 25,
    prefs: { overlay_visible: true },
    post: (url, o) => o.data.variables.contentOffsetSeconds === 0
      ? Promise.resolve(ok200(vodPage([vodEdge("a", 5), vodEdge("b", 10)], true)))
      : Promise.resolve(ok200(vodPage([vodEdge("c", 25)], true)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  await settle();
  await micro(); await micro();
  assert.deepStrictEqual(vodOffsets(app), [0, 11], "the page at 11 pushed the next offset past the 25 s duration");
  assert.equal(vodCalls(app).length, 2);
  teardown(app);
});

test("a seek resets the buffer, refetches by offset and drops the stale page", async () => {
  let releasePage2;
  const app = boot({
    url: VOD_URL,
    position: 40,
    prefs: { overlay_visible: true },
    post: (url, o) => {
      const offset = o.data.variables.contentOffsetSeconds;
      if (offset === 43) {
        return new Promise((resolve) => {
          releasePage2 = () => resolve(ok200(vodPage([vodEdge("s1", 43), vodEdge("s2", 44)], true)));
        });
      }
      if (offset === 40) {
        return Promise.resolve(ok200(vodPage([vodEdge("a", 41), vodEdge("b", 42)], true)));
      }
      return Promise.resolve(ok200(vodPage([vodEdge("n1", 4), vodEdge("n2", 5)], false)));
    }
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  assert.deepStrictEqual(vodBodies(app)[0].variables, { videoID: "1234567890", contentOffsetSeconds: 40 }, "paging starts at the playhead");

  await settle();
  await micro(); await micro();
  assert.deepStrictEqual(vodBodies(app)[1].variables, { videoID: "1234567890", contentOffsetSeconds: 43 }, "the offset drives the next page");

  /* seek back: the next tick resets the buffer and page 2 becomes stale */
  app.iina.core.status.position = 5;
  await tick();
  releasePage2();
  await soon();
  await micro(); await micro();
  assert.deepStrictEqual(vodOffsets(app), [40, 43, 5], "the seek reset refetches from the new playhead");
  assert.deepStrictEqual(overlayEvents(app).map((e) => e.offsetSeconds), [4, 5], "the stale page never reaches the overlay");
  teardown(app);
});

test("duplicate comment ids are emitted once", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    post: (url, o) => o.data.variables.contentOffsetSeconds === 0
      ? Promise.resolve(ok200(vodPage([vodEdge("dup", 5), vodEdge("dup", 6)], true)))
      : Promise.resolve(ok200(vodPage([vodEdge("dup", 7), vodEdge("new", 8)], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  await settle();
  await micro(); await micro();
  app.iina.core.status.position = 10;
  await tick();
  assert.deepStrictEqual(overlayEvents(app).map((e) => e.id), ["dup", "new"]);
  teardown(app);
});

test("live chat is suppressed while replaying, and resumes afterwards", async () => {
  const app = boot({
    url: VOD_URL,
    title: "ohnePixel \u2014 VITY vs LOUD",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([vodEdge("a", 5, "c1")], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();

  /* a live backlog is refused for the replayed channel, and its room id is kept */
  app.handlers.sidebar["twt:history-request"]({ id: "h1", channel: "ohnepixel", roomId: "77", count: 50 });
  await micro();
  const refused = app.calls.sidebar.filter((c) => c.name === "twt:history-result").pop().data;
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "vod chat replay active");

  app.handlers.sidebar["twt:event"]({ event: { kind: "message", channel: "ohnepixel", text: "live" } });
  assert.deepStrictEqual(overlayEvents(app), [], "no live message reaches the overlay while replaying");

  app.iina.core.status.position = 6;
  await tick();
  const replayed = overlayEvents(app);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].replay, true);
  assert.equal(replayed[0].text, "hi");
  assert.equal(replayed[0].roomId, "77");

  /* the media becomes a live stream: VOD mode ends and live chat resumes */
  app.iina.core.status.url = "https://www.twitch.tv/ohnepixel";
  app.handlers.event["iina.file-loaded"]("https://www.twitch.tv/ohnepixel");
  assert.equal(lastSettings(app).vodReplay, false);
  assert.equal(lastSettings(app).channelNote !== "VOD chat replay", true);
  app.handlers.sidebar["twt:event"]({ event: { kind: "message", channel: "ohnepixel", text: "live again" } });
  assert.deepStrictEqual(overlayEvents(app).map((e) => e.text), ["hi", "live again"]);
  teardown(app);
});

test("switching from a live stream to another channel's VOD labels the VOD's channel", async () => {
  /* Reported: watching #agurin (live), then a VOD of thebausffs starts. The
   * replay is the VOD's, but the header kept "#agurin (VOD chat replay)".
   * IINA reports core.status.url for the new media before it parses the title,
   * and a VOD URL carries no channel name, so the first decision ran with the
   * previous stream's title and kept #agurin bound. The title then settled to
   * the VOD's channel, but the decision ladder had already stopped (only the
   * file token changes it), so nothing re-evaluated the channel. */
  const app = boot({
    url: mediaUrl("agurin"),
    title: "agurin \u2014 live",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([], false)))
  });
  await overlayReady(app);
  assert.equal(lastSettings(app).channel, "agurin", "the live stream is bound");

  /* the VOD loads: the URL switches first, the title still belongs to agurin */
  app.iina.core.status.url = VOD_URL;
  app.handlers.event["iina.file-loaded"](VOD_URL);
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(lastSettings(app).vodReplay, true, "the replay started from the VOD URL");
  assert.equal(lastSettings(app).channelNote, "VOD chat replay");

  /* the VOD title arrives and carries its channel; the ladder must re-decide */
  app.iina.core.status.title = "thebausffs \u2014 ranked grind";
  await new Promise((resolve) => setTimeout(resolve, 2600));

  const settings = lastSettings(app);
  assert.equal(settings.channel, "thebausffs", "the header names the VOD's channel, not the live one");
  assert.equal(settings.vodReplay, true);
  assert.equal(settings.channelNote, "VOD chat replay");
  assert.equal("#" + settings.channel + " (" + settings.channelNote + ")",
    "#thebausffs (VOD chat replay)", "the exact rendered header");
  const overlaySettings = app.calls.overlay.filter((c) => c.name === "twt:settings").pop().data;
  assert.equal(overlaySettings.channel, "thebausffs", "the overlay payload carries it too");

  /* VOD B -> VOD C: the new VOD's title settles after the URL, as above */
  const vodC = "https://www.twitch.tv/videos/987654321";
  app.iina.core.status.url = vodC;
  app.handlers.event["iina.file-loaded"](vodC);
  await new Promise((resolve) => setTimeout(resolve, 850));
  app.iina.core.status.title = "caedrel \u2014 solo queue";
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(lastSettings(app).channel, "caedrel", "the second VOD's channel replaces the first");
  assert.equal(lastSettings(app).vodReplay, true);

  /* replay disabled while the VOD plays: VOD mode ends, the media's channel stays */
  app.prefs.vod_chat_replay = false;
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(lastSettings(app).vodReplay, false, "switching the preference off ends the replay");
  assert.equal(lastSettings(app).channel, "caedrel", "the playing video's channel is still bound");

  /* back to a live stream: the replay ends and the live channel is restored */
  app.iina.core.status.url = mediaUrl("agurin");
  app.iina.core.status.title = "agurin \u2014 live";
  app.handlers.event["iina.file-loaded"](mediaUrl("agurin"));
  assert.equal(lastSettings(app).vodReplay, false, "a live file leaves VOD mode at once");
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(lastSettings(app).channel, "agurin");
  assert.equal(lastSettings(app).channelNote, "");
  teardown(app);
});

test("a replayed comment survives the bridge with backticks, ${ and emoji intact", async () => {
  /* Chat text is attacker controlled and a VOD replay pushes thousands of rows
   * through IINA's String.raw template: a backtick used to end the literal and
   * "${" is still an interpolation, which either mangles the JSON or throws
   * ("Request to run JavaScript failed" in WebKit's log) and drops the row. */
  /* deliberately NO backtick here: the backtick guard would mask the
   * interpolation hole, and an interpolation of an unknown name makes the
   * whole evaluation throw ("Request to run JavaScript failed") */
  const hostile = "price ${nope} and ${1+1} and \\ backslash and \u{1F600}";
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([vodEdge("a", 5, { text: hostile })], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  app.iina.core.status.position = 5;
  await tick();

  const call = app.calls.overlay.filter((c) => c.name === "twt:event").pop();
  assert.ok(call, "the row was posted");
  const bridged = throughBridge(call);
  assert.equal(bridged.name, "twt:event");
  const received = decodeForView(bridged.data);
  assert.deepStrictEqual(received, decodeForView(JSON.parse(JSON.stringify(call.data))),
    "the view receives exactly what main.js sent");
  assert.equal(received.event.text, hostile, "the chat text arrives verbatim");
  assert.equal(received.event.replay, true);
  teardown(app);
});

test("the bridge also carries hostile strings in the settings payload", async () => {
  /* the settings page and the twt config are the other text sources the plugin
   * forwards into the views; each hostile shape is tested on its own so no
   * guard can mask the other */
  const cases = ["theme-${oops}", "theme-`backtick`", "theme-${1+1}-`b`", "theme-plain"];
  for (const hostile of cases) {
    const app = boot({ prefs: { ui_overrides: JSON.stringify({ theme: hostile }) } });
    await ready(app);
    const call = app.calls.sidebar.filter((c) => c.name === "twt:settings").pop();
    const bridged = throughBridge(call);
    const received = decodeForView(bridged.data);
    assert.equal(received.overrides.theme, hostile, "settings value survives: " + hostile);
    assert.deepStrictEqual(received, decodeForView(JSON.parse(JSON.stringify(call.data))),
      "the view receives exactly what main.js sent for " + hostile);
    teardown(app);
  }
});

test("a replayed comment carries only its own channel's room id", async () => {
  /* The VOD is #ohnepixel (title heuristic) while the sidebar is joined to a
   * different channel. Both the live ROOMSTATE and a refused live history
   * request teach the plugin a room id - for OTHER channels. A room id
   * identifies a chat room, so none of them may be stamped onto a replayed
   * comment from this VOD (the row keeps "" when its own room is unknown). */
  const app = boot({
    url: VOD_URL,
    title: "ohnePixel \u2014 VITY vs LOUD",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([vodEdge("a", 5), vodEdge("b", 10)], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  assert.equal(lastSettings(app).channel, "ohnepixel", "the VOD's channel comes from detection");

  app.handlers.sidebar["twt:event"]({ event: { kind: "roomstate", channel: "someother", roomId: "777" } });
  app.handlers.sidebar["twt:event"]({ event: { kind: "message", channel: "someother", text: "live" } });
  app.handlers.sidebar["twt:history-request"]({ id: "h1", channel: "someother", roomId: "999", count: 50 });
  await micro();
  const answer = app.calls.sidebar.filter((c) => c.name === "twt:history-result").pop().data;
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "no cached history",
    "only the replayed channel's backlog is refused; another channel's request is answered normally");

  app.iina.core.status.position = 10;
  await tick();
  const replayed = overlayEvents(app);
  assert.deepStrictEqual(replayed.map((e) => e.id), ["a", "b"], "both comments are emitted");
  assert.deepStrictEqual(replayed.map((e) => e.roomId), ["", ""],
    "no room id of another channel leaks into a replayed comment");
  teardown(app);
});

test("a replayed comment keeps its own channel's room id when that is known", async () => {
  /* Same-shaped VOD, but the room id of the VOD's own channel arrives before
   * the comments are emitted: then it is stamped, so a consumer can rely on it. */
  const app = boot({
    url: VOD_URL,
    title: "ohnePixel \u2014 VITY vs LOUD",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([vodEdge("a", 5)], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  app.handlers.sidebar["twt:history-request"]({ id: "h1", channel: "ohnepixel", roomId: "42", count: 50 });
  await micro();
  app.iina.core.status.position = 5;
  await tick();
  assert.deepStrictEqual(overlayEvents(app).map((e) => [e.id, e.roomId]), [["a", "42"]]);
  teardown(app);
});

test("a rejected persisted query logs once, OSDs and shows no chat", async () => {
  const app = boot({
    url: VOD_URL,
    title: "ohnePixel \u2014 VITY vs LOUD",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200({ errors: [{ message: "PersistedQueryNotFound" }] }))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  app.iina.core.status.position = 10;
  await tick();

  assert.deepStrictEqual(overlayEvents(app), [], "no chat at all on failure");
  assert.equal(vodCalls(app).length, 1, "a persisted-query rejection is not retried");
  const warnings = app.calls.warn.filter((m) => /vod chat replay unavailable/.test(m));
  assert.equal(warnings.length, 1);
  assert.equal(/VideoCommentsByOffsetOrCursor/.test(warnings[0]), true, "the operation name is logged");
  assert.equal(/PersistedQueryNotFound/.test(app.calls.log.concat(app.calls.warn).join("\n")), false,
    "the GQL error body is never logged");
  assert.equal(app.calls.osd.filter((m) => /VOD chat replay unavailable/.test(m)).length, 1);
  /* the failure is visible without the log: the payload carries the code */
  assert.equal(lastSettings(app).vodError, "VOD chat replay unavailable (integrity)");
  assert.equal(lastSettings(app).vodReplay, true, "still in VOD mode, so live chat cannot leak in");
  assert.deepStrictEqual(lastSettings(app).vodStats, { pages: 0, comments: 0, offset: 0 },
    "nothing was paged, and the counters say so");

  /* the live chat must not leak in as a substitute */
  app.handlers.sidebar["twt:event"]({ event: { kind: "message", channel: "ohnepixel", text: "live" } });
  assert.deepStrictEqual(overlayEvents(app), []);
  teardown(app);
});

test("HTTP 429 backs off 2/4/8 s, retries three times, then gives up with the code surfaced", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    /* every request is rate limited */
    post: () => Promise.resolve({ statusCode: 429, text: "{\"message\":\"rate limited\"}" })
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  assert.equal(vodCalls(app).length, 1, "the first attempt");

  /* 2 s, 4 s, 8 s: the backoff delays are real, so this test spends ~14 s here */
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(vodCalls(app).length, 2, "retry 1 after 2 s");
  await new Promise((resolve) => setTimeout(resolve, 4300));
  assert.equal(vodCalls(app).length, 3, "retry 2 after 4 s");
  await new Promise((resolve) => setTimeout(resolve, 8300));
  assert.equal(vodCalls(app).length, 4, "retry 3 after 8 s");

  /* the fourth 429 is the end of the replay */
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(vodCalls(app).length, 4, "no fifth attempt");
  assert.equal(lastSettings(app).vodError, "VOD chat replay unavailable (http-429)");
  const warnings = app.calls.warn.filter((m) => /vod chat replay unavailable \(http-429\)/.test(m));
  assert.equal(warnings.length, 1, "one warning for the whole page");
  assert.equal(app.calls.osd.filter((m) => /VOD chat replay unavailable/.test(m)).length, 1);
  assert.equal(app.calls.log.filter((m) => /rate limited, retrying in 2000ms/.test(m)).length, 1);
  assert.equal(app.calls.log.filter((m) => /rate limited, retrying in 4000ms/.test(m)).length, 1);
  assert.equal(app.calls.log.filter((m) => /rate limited, retrying in 8000ms/.test(m)).length, 1);
  assert.deepStrictEqual(overlayEvents(app), [], "no chat");
  teardown(app);
});

test("the VOD failure codes cover the transport failures too", async () => {
  const cases = [
    ["network", () => Promise.reject(new Error("offline"))],
    ["invalid-json", () => Promise.resolve({ statusCode: 200, text: "<html>not json</html>" })],
    ["http-500", () => Promise.resolve({ statusCode: 500, text: "{}" })]
  ];
  for (const entry of cases) {
    const code = entry[0];
    const app = boot({ url: VOD_URL, position: 0, prefs: { overlay_visible: true }, post: entry[1] });
    await overlayReady(app);
    await soon();
    await micro(); await micro();
    assert.equal(lastSettings(app).vodError, "VOD chat replay unavailable (" + code + ")", code + " is surfaced");
    assert.equal(vodCalls(app).length, 1, code + " is not retried");
    assert.deepStrictEqual(overlayEvents(app), [], code + " shows no chat");
    assert.equal(app.calls.osd.filter((m) => /VOD chat replay unavailable/.test(m)).length, 1, code + " OSDs once");
    teardown(app);
  }
});

test("vod_chat_replay=false never touches the GQL endpoint", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true, vod_chat_replay: false },
    post: () => { throw new Error("the GQL endpoint must not be called"); }
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  assert.equal(app.calls.http.length, 0);
  assert.equal(lastSettings(app).vodReplay, false);
  app.iina.core.status.position = 30;
  await tick();
  assert.deepStrictEqual(overlayEvents(app), []);
  teardown(app);
});

test("the replay sends no Authorization header and never logs the token", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([vodEdge("a", 1, "c1")], false)))
  });
  await overlayReady(app);
  await soon();
  await micro(); await micro();
  assert.equal(lastSettings(app).channel, null, "the VOD URL carries no channel name");
  assert.equal(lastSettings(app).vodReplay, true);
  assert.ok(app.calls.show.includes("overlay"), "a VOD replay is a connected chat: the overlay stays on screen");
  const posts = vodCalls(app);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://gql.twitch.tv/gql");
  assert.deepStrictEqual(posts[0].options.headers, {
    "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
    "Content-Type": "application/json"
  });
  assert.equal(app.calls.http.some((c) => c.options && c.options.headers &&
    (c.options.headers.Authorization || c.options.headers.authorization)), false);
  const logged = app.calls.log.concat(app.calls.warn).join("\n");
  assert.equal(/tok123|Authorization|Bearer|OAuth/.test(logged), false, "the token must never be logged:\n" + logged);
  teardown(app);
});

test("a non-Twitch media that merely looks like a VOD is not replayed", async () => {
  const app = boot({
    url: "file:///Users/stub/videos/123.mp4",
    position: 0,
    prefs: { overlay_visible: true },
    post: () => { throw new Error("the GQL endpoint must not be called"); }
  });
  await overlayReady(app);
  await soon();
  assert.equal(app.calls.http.length, 0);
  assert.equal(lastSettings(app).vodReplay, false);
  /* live chat is not suppressed either */
  app.handlers.sidebar["twt:event"]({ event: { kind: "message", channel: "chan", text: "live" } });
  assert.deepStrictEqual(overlayEvents(app).map((e) => e.text), ["live"]);
  teardown(app);
});

test("turning vod_chat_replay off mid-playback releases the replay", async () => {
  const app = boot({
    url: VOD_URL,
    position: 0,
    prefs: { overlay_visible: true },
    post: () => Promise.resolve(ok200(vodPage([vodEdge("a", 5, "c1")], false)))
  });
  await overlayReady(app);
  await soon();
  await micro();
  assert.equal(lastSettings(app).vodReplay, true);

  app.prefs.vod_chat_replay = false;
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(lastSettings(app).vodReplay, false, "the poll stops the replay");
  app.handlers.sidebar["twt:event"]({ event: { kind: "message", channel: "chan", text: "live" } });
  assert.deepStrictEqual(overlayEvents(app).map((e) => e.text), ["live"], "live chat resumes");
  teardown(app);
});

/* ------------------------------------------------ teardown hardening (crash)
 *
 * IINA's JavascriptMessageHub.callListener(forEvent:withDataString:) reads
 * `callback.value.context` from a JSManagedValue with no nil check, so a
 * sidebar message that arrives after the plugin instance's JS context is gone
 * traps the app (SIGTRAP, report IINA-2026-10-18-200511). The plugin's part of
 * that contract: never re-register a listener or reload a web view after
 * iina.window-will-close, keep a strong JS reference to every callback it
 * registers, and leave no timer running that could do either.
 */
test("the message callbacks are kept in a plugin-side table and reused", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  const warnsBefore = app.calls.warn.length;
  await overlayReady(app);
  const first = app.handlers.overlay["twt:ready"];
  assert.equal(typeof first, "function");

  /* every ladder rung re-registers after overlay.loadFile() cleared IINA's
   * listeners; the same function object must come back, so no JSManagedValue
   * can be collected between registrations and no second handler appears */
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(app.handlers.overlay["twt:ready"], first, "the callback object is reused, not recreated");
  assert.equal(app.calls.warn.filter((m) => /two different handlers registered/.test(m)).length, 0,
    "re-registering is not reported as a duplicate handler");

  /* the sidebar's readiness retry re-registers too (6 s after the window loads) */
  app.handlers.sidebar["twt:ready"]({ href: "file:///repo/ui/sidebar.html" });
  const sidebarFirst = app.handlers.sidebar["twt:ready"];
  await new Promise((resolve) => setTimeout(resolve, 6500));
  assert.equal(app.handlers.sidebar["twt:ready"], sidebarFirst, "the sidebar callbacks are stable too");
  assert.equal(app.calls.warn.filter((m) => /two different handlers registered/.test(m)).length, 0);
  assert.ok(app.calls.warn.length >= warnsBefore, "warnings are still recorded");
  teardown(app);
});

test("a window teardown cancels every plugin timer and blocks late handler work", async () => {
  const app = boot({ url: mediaUrl("chan"), prefs: { overlay_visible: true } });
  await overlayReady(app);
  assert.ok(app.timers.pending() > 0, "the handshake, ladder and poll timers are running");
  const reloads = app.calls.loadFile.length;
  const toggleOverlay = app.menuItems.find((m) => m.title === "Toggle Twitch Overlay");
  const shows = app.calls.show.length;

  teardown(app);
  assert.equal(app.timers.pending(), 0, "the teardown cancelled every timer the plugin created:\n" + app.timers.describe());

  /* a late menu action and a late registration reach nothing any more */
  toggleOverlay.action();
  assert.equal(app.calls.show.length, shows, "a post-teardown menu action does not touch the overlay");
  assert.equal(app.calls.loadFile.length, reloads, "no web view is reloaded after the teardown");

  /* and the readiness retry (6 s) cannot fire: wait past it and check again */
  await new Promise((resolve) => setTimeout(resolve, 6500));
  assert.equal(app.calls.loadFile.length, reloads, "the sidebar readiness retry was cancelled");
  assert.equal(app.timers.pending(), 0);
});

test("every allowed path is served with its query intact, and the dead follows path is not", async () => {
  const app = boot({
    http: (url) => Promise.resolve({ statusCode: 200, text: url === VALIDATE_URL ? identityBody() : "{}" })
  });
  await ready(app);
  for (const path of ALLOWLIST_FIXTURES) app.handlers.sidebar["twt:twitch-get"]({ id: path, path });
  await micro(); await micro(); await micro();

  assert.deepStrictEqual(
    app.calls.http.filter((c) => c.url.indexOf("https://api.twitch.tv") === 0).map((c) => c.url),
    [
      "https://api.twitch.tv/helix/users?login=a",
      "https://api.twitch.tv/helix/streams?user_login=a",
      "https://api.twitch.tv/helix/videos?user_id=42&type=archive&after=eyJjdXJzb3IiOjF9&first=20",
      "https://api.twitch.tv/helix/games/top?first=10",
      "https://api.twitch.tv/helix/channels/followed?first=20&user_id=42",
      "https://api.twitch.tv/helix/search/channels?query=foo&first=5",
      "https://api.twitch.tv/helix/search/categories?query=foo&first=20"
    ],
    "type=/after= cursors and search queries pass through untouched"
  );
  assert.equal(app.calls.http.filter((c) => c.url === VALIDATE_URL).length, 1, "the identity is validated once");

  const before = app.calls.http.length;
  app.handlers.sidebar["twt:twitch-get"]({ id: "gone", path: "/helix/users/follows?first=20" });
  await micro();
  assert.equal(app.calls.http.length, before, "the deprecated endpoint never reaches the network");
  assert.equal(twitchResults(app).pop().error, "blocked");
  teardown(app);
});

/* ------------------------------------------------------------ product naming
 *
 * The plugin is called "Twitch": the chat is what it shows, not what it is -
 * so no user-visible string carries the old "Chat" suffix any more. The bundle
 * identifier follows the repository rename; the 1.5.0 identifier survives only
 * in lib/migrate.js, which ports the preferences and history it keyed.
 */
test("the manifest and the sidebar tab are named Twitch, with no stale product name left", () => {
  assert.equal(MANIFEST.name, "Twitch");
  assert.equal(MANIFEST.sidebarTab.name, "Twitch");
  assert.equal(MANIFEST.identifier, "com.kdressler.twitch-iina", "the identifier follows the plugin name");
  assert.equal(/Twitch Chat/.test(MANIFEST.description), false);

  /* The one deliberate exception: the OSD sentence shown when the overlay is
   * toggled on non-Twitch media. It talks about the chat feature, not the
   * plugin's name, so it is removed before the stale-name scan. */
  const OSD_NOTICE = "Twitch Chat is only available on Twitch videos";
  for (const entry of [["main.js", MAIN], ["global.js", GLOBAL_SRC], ["Info.json", MANIFEST_SRC]]) {
    assert.equal(/Twitch Chat|Chat Sidebar|chat sidebar/.test(entry[1].split(OSD_NOTICE).join("")), false,
      entry[0] + " still names the plugin \"Twitch Chat\"");
  }
  assert.ok(MAIN.indexOf(OSD_NOTICE) !== -1, "the non-Twitch notice keeps its requested wording");
  assert.ok(MAIN.indexOf('menuItem("Toggle Twitch Overlay"') !== -1, "the overlay item is renamed");
  assert.ok(MAIN.indexOf('menuItem("Show Twitch Sidebar"') !== -1, "the sidebar item is renamed");
  assert.equal(/log\("Twitch Chat v"/.test(MAIN), false, "the boot line is renamed");
});

test("the 1.5.0 identifier survives only in the migration module", () => {
  /* The identifier keys `.preferences/<identifier>.plist` and `.data/<identifier>`;
   * the rename would silently start from empty, so lib/migrate.js copies the old
   * state once. Nothing else may reference the old identifier: a stale copy in an
   * entry script would mean a half-rename. */
  const LEGACY = "com.kdressler.iina-twitch-chat";
  const MIGRATE_SRC = fs.readFileSync(path.join(ROOT, "lib", "migrate.js"), "utf8");
  for (const entry of [["main.js", MAIN], ["global.js", GLOBAL_SRC], ["Info.json", MANIFEST_SRC]]) {
    assert.equal(entry[1].includes(LEGACY), false, entry[0] + " still carries the old identifier");
  }
  assert.equal(MIGRATE_JS.LEGACY_IDENTIFIER, LEGACY);
  assert.ok(MIGRATE_SRC.includes(`"${LEGACY}"`), "lib/migrate.js names the identifier it migrates from");
  assert.equal(/LEGACY_IDENTIFIER = "[^"]+"/.test(MIGRATE_SRC), true);
  /* A bare "@data" throws in parsePath() and would make the migration a silent
   * no-op, so the entries must ask for "@data/". */
  for (const entry of [["main.js", MAIN], ["global.js", GLOBAL_SRC]]) {
    assert.ok(/resolvePath\("@data\/"\)/.test(entry[1]), entry[0] + " resolves the @data/ prefix");
  }
});

test("the script's version string and the manifest version cannot drift apart", () => {
  /* IINA shows Info.json's version in its plugin list and main.js prints its own
   * in the boot log and in every state payload; a mismatch makes "did the new
   * one load?" unanswerable. There is no API to read the manifest from the
   * script, so the two are kept in step by this test. */
  const match = /var VERSION = "([^"]+)"/.exec(MAIN);
  assert.ok(match, "main.js declares VERSION");
  assert.equal(match[1], MANIFEST.version);
  assert.equal(/^\d+\.\d+\.\d+$/.test(match[1]), true, "a semver-looking version");
});

test("the allowlist is exactly the paths the sidebar calls, and every one has a fixture", () => {
  assert.deepStrictEqual(ALLOWED_PATHS, [
    "/identity",
    "/helix/users",
    "/helix/streams",
    "/helix/videos",
    "/helix/games/top",
    "/helix/channels/followed",
    "/helix/search/channels",
    "/helix/search/categories"
  ], "a new path needs this list, a request fixture and the sidebar's own call");

  /* every path literal ui/browser.js asks the proxy for must be allow-listed:
   * this is the check that would have caught /helix/search/categories */
  const used = {};
  const literal = /"(\/(?:identity|helix\/[a-z_/]+))/g;
  let match;
  while ((match = literal.exec(BROWSER_SRC)) !== null) used[match[1]] = true;
  const usedPaths = Object.keys(used).sort();
  assert.ok(usedPaths.length >= 7, "the browser-side scan found " + usedPaths.join(", "));
  assert.ok(used["/helix/search/categories"], "the Categories search calls /helix/search/categories");
  for (const path of usedPaths) {
    assert.ok(ALLOWED_PATHS.indexOf(path) !== -1, path + " is called by ui/browser.js but not allow-listed");
  }

  /* and every allow-listed Helix path is actually requested in the coverage test */
  for (const path of ALLOWED_PATHS) {
    if (path === "/identity") continue;
    assert.ok(ALLOWLIST_FIXTURES.some((fixture) => fixture.split("?")[0] === path),
      path + " is allow-listed but has no request fixture");
  }
});
