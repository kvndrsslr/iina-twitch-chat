/*
 * Twitch for IINA - global entry script.
 *
 * IINA evaluates this once per app launch (player == nil), not per player
 * window, and only this context exposes JavascriptAPIGlobal.createPlayerInstance
 * (iina/JavascriptAPIGlobal.swift). It has two jobs:
 *
 *   1. open a stream/VOD in a *new* player window for the player entries
 *      (frozen protocol: main entry -> here "twt:open-new-player" {url}), and
 *      honour the auto_open_browser preference the same way (main entry ->
 *      here "twt:auto-open-browser" {} once, after its settle window, and only
 *      while nothing is playing);
 *   2. host the standalone Twitch browser window (ui/standalone.html) - the
 *      Twitch browser that works with no player window open at all.
 *
 * What this entry can use, verified in JavascriptPluginInstance.createJSContext
 * (IINA 1.5.0): menu, standaloneWindow, utils, file, preferences, console, http
 * and global are registered for the global instance; core, mpv, event, overlay,
 * sidebar, playlist, subtitle and input are only registered for player
 * instances. So nothing here may touch a player API - there is no player.
 *
 * Frozen view protocol (same names as the sidebar's proxy):
 *   view -> host : "twt:twitch-get"  {id, path}  (or {id, url}; `path` is the
 *                                                single allowlist entry point)
 *   host -> view : "twt:twitch-result" {id, ok, status, data, error}
 *   view -> host : "twt:settings" is never *posted* by the view; the host sends
 *                  it on "twt:ready" with channel: null (there is no playing
 *                  media here)
 *   view -> host : "twt:open" {url, target} - with no player to switch, both
 *                  targets create a new player instance
 */

"use strict";

var OPEN_NEW_PLAYER_MESSAGE = "twt:open-new-player";
/* main entry -> here: the user asked for "open the browser on startup" and the
 * settle window passed with nothing playing. Opened at most once per launch. */
var AUTO_OPEN_BROWSER_MESSAGE = "twt:auto-open-browser";
var STANDALONE_MESSAGE = "twt:standalone";
/* ⌘⇧W: unused in IINA 1.5.0's menus (Base.lproj/MainMenu.xib keyEquivalents:
 * ⌘⇧F/G/H/O/S/Z) and in all four shipped key-binding files (iina-default, vlc,
 * movist, movist-v2: Shift+Meta+{a,c,m,p,r,s,t,v,L,R}); ⌘⇧T and ⌘⇧B belong to
 * the per-player items. */
var STANDALONE_KEY = "Meta+Shift+W";
var STANDALONE_PAGE = "ui/standalone.html";
var STANDALONE_WIDTH = 980;
var STANDALONE_HEIGHT = 760;
var KEYCHAIN_SERVICE = "twitch-chat";
var KEYCHAIN_ACCOUNT = "oauth-token";
var FALLBACK_CONFIG_DIR = "~/.config/twt";
var ENV_TIMEOUT_MS = 1500;
/* ui/standalone.html posts no "twt:ready" (it is a browser page, not a chat
 * view), and postMessage() is a no-op until its document exists, so the settings
 * are pushed on a short bounded ladder instead - the same shape the overlay uses
 * for IINA's not-loaded-yet window. */
var STANDALONE_SETTINGS_RETRY_MS = [0, 250, 1000, 2500];

function loadLib(name, globalName) {
  var mod = null;
  try { mod = require("./lib/" + name + ".js"); } catch (e) { mod = null; }
  if (mod && typeof mod === "object" && Object.keys(mod).length > 0) return mod;
  var fromGlobal = (typeof TwitchPlugin !== "undefined" && TwitchPlugin) ? TwitchPlugin[globalName] : null;
  if (fromGlobal && typeof fromGlobal === "object" && Object.keys(fromGlobal).length > 0) return fromGlobal;
  return mod || {};
}

var configLib = loadLib("config", "config");
var helixLib = loadLib("helix", "helix");
var webviewLib = loadLib("webview", "webview");
var hostenvLib = loadLib("hostenv", "hostenv");
var migrateLib = loadLib("migrate", "migrate");

var state = {
  windowGone: false,
  env: {},
  token: { value: null, source: "none" },
  settingsTimers: [],
  autoOpened: false      /* auto_open_browser is a startup action: once per launch */
};

function log(message) {
  try { iina.console.log("[twitch-chat/global] " + message); } catch (e) { /* never break the plugin */ }
}

function logWarn(message) {
  try { iina.console.warn("[twitch-chat/global] " + message); } catch (e) { log("WARN " + message); }
}

function postToStandalone(name, payload) {
  try { iina.standaloneWindow.postMessage(name, webviewLib.encodeForWebview(payload)); } catch (e) { logWarn("standalone post failed: " + e); }
}

/* ------------------------------------------------------ token and config */

var hostenv = hostenvLib.create({
  file: iina.file,
  utils: iina.utils,
  log: log,
  warn: logWarn,
  env: function () { return state.env; },
  isGone: function () { return state.windowGone; },
  fallbackDir: FALLBACK_CONFIG_DIR,
  timeoutMs: ENV_TIMEOUT_MS
});

function readPrefString(key, fallback) {
  var value = null;
  try { value = iina.preferences.get(key); } catch (e) { value = null; }
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? value : (typeof value === "number" ? String(value) : fallback);
}

function keychainToken() {
  try {
    var stored = iina.utils.keyChainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return typeof stored === "string" ? stored : "";
  } catch (e) {
    return "";
  }
}

/* The same rule as the player entry: the config's [twitch] token, else the
 * Keychain. lib/helix.js owns the choice so both hosts agree. */
function loadToken() {
  var home = hostenv.homePath();
  var env = {};
  var keys = Object.keys(state.env);
  for (var i = 0; i < keys.length; i++) env[keys[i]] = state.env[keys[i]];
  if (home) env.HOME = home;
  var options = { readFile: hostenv.readTextFile, home: home, env: env };
  var configFile = hostenv.configFileOption(readPrefString("config_file", ""), home);
  if (configFile) options.configFile = configFile;
  var result = null;
  try { result = configLib.loadConfig(options); } catch (e) { result = null; }
  var configToken = result && result.settings && result.settings.twitch ? result.settings.twitch.token : "";
  state.token = helixLib.pickToken(configToken, keychainToken());
}

/* ----------------------------------------------------------- the proxy */

var helix = helixLib.create({
  http: iina.http,
  token: function () { return state.token.value; },
  log: log,
  warn: logWarn
});

function onTwitchGet(request) {
  var id = request && typeof request.id === "string" ? request.id : "";
  if (!id) return;
  function reply(ok, status, data, error) {
    postToStandalone("twt:twitch-result", {
      id: id,
      ok: !!ok,
      status: status === undefined ? null : status,
      data: data === undefined ? null : data,
      error: error === undefined || error === null ? null : String(error)
    });
  }
  var spec = helixLib.requestSpec(request);
  if (!spec) {
    var raw = typeof request.path === "string" ? request.path.slice(0, 100)
      : (typeof request.url === "string" ? request.url.slice(0, 100) : "");
    logWarn("twitch api: blocked " + (raw || "(no request)"));
    reply(false, null, null, "blocked");
    return;
  }
  helix.request(spec, function (error, status, json) {
    if (error) { reply(false, status === undefined ? null : status, null, error); return; }
    reply(true, status, json, null);
  });
}

/* --------------------------------------------------- open a Twitch page */

/* With no player window to take over, both targets create a player instance -
 * createPlayerInstance is the only route, and only the global entry has it.
 *
 * `enablePlugins: true` is not optional: with the default (false)
 * createPlayerInstance loads *this* plugin only (JavascriptAPIGlobal.swift:
 * `pc.reloadPlugin(pluginInstance.plugin)`), so IINA's Online Media/yt-dlp
 * plugin never installs its mpv load hook in the new window. mpv then gets the
 * raw https://www.twitch.tv/<channel> page URL with `ytdl=no` and answers
 * "error: Failed to recognize file format." - the user's "IINA cannot open file
 * or stream" on the first Watch/⌘-click, while a retry from IINA's own Open URL
 * window works because those windows load every plugin
 * (PlayerCore.createPlayerCore -> startMPV() -> loadPlugins()). */
function createPlayerForUrl(url) {
  return iina.global.createPlayerInstance({ url: url, enablePlugins: true });
}

function openTwitchPage(request) {
  var url = helixLib.twitchMediaUrl(request && request.url);
  if (!url) {
    logWarn("open: rejected " + (request && typeof request.url === "string" ? request.url.slice(0, 100) : "(no url)"));
    return;
  }
  var target = request && request.target === "current" ? "current" : "new";
  var id = null;
  try {
    id = createPlayerForUrl(url);
  } catch (e) {
    logWarn("open: could not create a player window: " + e);
    return;
  }
  log("opened a player window for " + url + " (id " + id + ", requested as \"" + target + "\")");
}

/* ------------------------------------------------------- the standalone */

function standaloneSettings() {
  return {
    /* no playing media here - the contract with the page */
    channel: null,
    currentChannel: null,
    channelSource: "none",
    channelNote: "",
    token: { available: !!state.token.value, source: state.token.source },
    settings: null,          /* there is no player config to send */
    filters: null
  };
}

/* The page has no readiness handshake, so this is the delivery ladder: four
 * attempts over ~4 s, then the footer keeps its neutral text (the page's own
 * content comes from its twt:twitch-get requests, which pull, not push). */
function scheduleStandaloneSettings(index) {
  if (state.windowGone) return;
  if (index >= STANDALONE_SETTINGS_RETRY_MS.length) return;
  var timer = setTimeout(function () {
    if (state.windowGone) return;
    postToStandalone("twt:settings", standaloneSettings());
    scheduleStandaloneSettings(index + 1);
  }, STANDALONE_SETTINGS_RETRY_MS[index]);
  state.settingsTimers.push(timer);
}

function openStandalone() {
  if (state.windowGone) return;
  try {
    iina.standaloneWindow.loadFile(STANDALONE_PAGE);
    /* loadFile() clears the plugin-side listeners
     * (JavascriptAPIStandaloneWindow.swift: `messageHub.clearListeners()`), and
     * every open - including a re-open of an existing window - loads the page
     * again, so the handlers are registered here, after the load, every time.
     * Registering them once at boot is what made page -> host dead before
     * 1.4.0. */
    registerStandaloneHandlers();
    iina.standaloneWindow.setProperty({ title: "Twitch", resizable: true });
    iina.standaloneWindow.setFrame(STANDALONE_WIDTH, STANDALONE_HEIGHT, null, null);
    iina.standaloneWindow.open();
    log("standalone browser window opened");
    scheduleStandaloneSettings(0);
  } catch (e) {
    logWarn("could not open the standalone window: " + e);
  }
}

/* The page handlers. Created once (stable function objects) and registered
 * after every loadFile, so a re-open cannot pile up managed values or trip a
 * duplicate-handler warning. */
var standaloneHandlerSet = null;

function standaloneHandlers() {
  if (standaloneHandlerSet) return standaloneHandlerSet;
  standaloneHandlerSet = {
    /* The page does not handshake at boot; this stays for a page that does. */
    ready: function (data) {
      loadToken();                 /* a token saved since launch must be picked up */
      log("standalone ready");
      postToStandalone("twt:settings", standaloneSettings());
    },
    twitchGet: function (data) {
      onTwitchGet(data);
    },
    open: function (data) {
      openTwitchPage(data);
    },
    log: function (data) {
      if (data && data.message) log("standalone: " + data.message);
    }
  };
  return standaloneHandlerSet;
}

function registerStandaloneHandlers() {
  if (state.windowGone) return;
  var handlers = standaloneHandlers();
  iina.standaloneWindow.onMessage("twt:ready", handlers.ready);
  iina.standaloneWindow.onMessage("twt:twitch-get", handlers.twitchGet);
  iina.standaloneWindow.onMessage("twt:open", handlers.open);
  iina.standaloneWindow.onMessage("twt:log", handlers.log);
}

/* Named and module-level on purpose: IINA keeps a menu item's action only as a
 * JSValue, and a JS closure that nothing in the JS heap references can be
 * collected - the item then stays in the menu but clicking it does nothing (the
 * same class as the JSManagedValue trap in JavascriptMessageHub). main.js's
 * items use named functions for the same reason. */
function onOpenStandaloneMenu() {
  openStandalone();
}

/* auto_open_browser: startup only. "Once per launch" lives here because this
 * entry is the only per-launch context (player entries come and go with their
 * windows); a window that is already open is left alone, and a repeated request
 * - a second player window booting, or the same one retrying - does nothing. */
function autoOpenBrowserOnce() {
  if (state.autoOpened) return;
  state.autoOpened = true;
  if (state.windowGone) return;
  /* isOpen() is the API's own answer (JavascriptAPIStandaloneWindow.isOpen);
   * a build without it simply opens. */
  var isOpen = false;
  try { isOpen = !!iina.standaloneWindow.isOpen(); } catch (e) { isOpen = false; }
  if (isOpen) {
    log("auto_open_browser: the browser window is already open");
    return;
  }
  log("auto_open_browser: opening the browser window");
  openStandalone();
}

function setupMenu() {
  try {
    var item = iina.menu.item("Open Twitch Window", onOpenStandaloneMenu, {
      keyBinding: STANDALONE_KEY
    });
    iina.menu.addItem(item);
  } catch (e) {
    logWarn("could not add the standalone menu item: " + e);
  }
}

/* main entry -> here: the browser should open itself on this launch */
iina.global.onMessage(AUTO_OPEN_BROWSER_MESSAGE, function () {
  autoOpenBrowserOnce();
});

/* main entry -> here: open a stream/VOD in a new player window */
iina.global.onMessage(OPEN_NEW_PLAYER_MESSAGE, function (data) {
  var url = data && typeof data.url === "string" ? data.url : "";
  if (!url) return;
  try {
    var id = createPlayerForUrl(url);
    log("opened a player window for " + url + " (id " + id + ")");
  } catch (e) {
    logWarn("could not open a player window: " + e);
  }
});

/* IINA keys preferences (`.preferences/<identifier>.plist`) and @data by the
 * manifest identifier, so a rename starts this build empty. lib/migrate.js
 * copies the 1.5.0 state once; the identifier and the plugins directory are
 * read back from @data instead of hard-coded. */
function migrateLegacyState() {
  if (!migrateLib || typeof migrateLib.run !== "function") return;
  /* parsePath() only recognises the "@data/" prefix, not a bare "@data"
   * (iina/JavascriptAPI.swift); the trailing slash makes it expand. */
  var data = hostenv.resolvePath("@data/");
  var pluginsDir = migrateLib.pluginsDirFromDataPath(data);
  var identifier = migrateLib.identifierFromDataPath(data);
  if (!pluginsDir || !identifier) return;
  try {
    var result = migrateLib.run({
      identifier: identifier,
      pluginsDir: pluginsDir,
      preferences: iina.preferences,
      file: iina.file,
      readText: hostenv.readTextFile
    });
    if (result.status === "migrated") {
      log("migrated " + result.keys + " preference(s) and " + result.files + " data file(s) from " + migrateLib.LEGACY_IDENTIFIER);
    }
  } catch (e) {
    logWarn("preference migration failed: " + e);
  }
}

/* The menu and the view listeners do not depend on the environment, so they are
 * registered at once; the /usr/bin/env probe only refines HOME and re-reads the
 * token (a token saved since launch is picked up on the view's ready message). */
migrateLegacyState();
loadToken();
setupMenu();
hostenv.readEnvironment(function (env) {
  state.env = env;
  loadToken();
  log("global entry ready (token source: " + state.token.source + ")");
});
