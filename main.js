/*
 * Twitch for IINA - plugin entry script.
 *
 * One instance per player window. Responsibilities:
 *   - load the twitch-tui configuration (~/.config/twt/config.toml + filters.txt)
 *     and merge the plugin's own preferences on top of it,
 *   - own IINA state: menus, keyboard shortcuts, OSD, preferences, and the relay
 *     between the sidebar (Twitch browser + settings) and the overlay web views,
 *   - bind chat to the channel of the playing media (never to a configured or
 *     remembered channel), and proxy Twitch API calls for the sidebar browser,
 *   - replay a VOD's chat from the undocumented Twitch GQL endpoint while a VOD
 *     plays (the live chat is suppressed then),
 *   - the IRC client itself lives in the sidebar web view (the only context with
 *     a WebSocket implementation); this plugin only tells it which channel to
 *     join.
 *
 * Runs in JavaScriptCore: no window/fetch/localStorage, ES2017 syntax only.
 */

"use strict";

var configLib = loadLib("config", "config");
var ircLib = loadLib("irc", "irc");
var helixLib = loadLib("helix", "helix");
var webviewLib = loadLib("webview", "webview");
var hostenvLib = loadLib("hostenv", "hostenv");
var migrateLib = loadLib("migrate", "migrate");

var VERSION = "1.5.0";

var SIDEBAR_FILE = "ui/sidebar.html";
var OVERLAY_FILE = "ui/overlay.html";
var HELP_FILE = "ui/help.html";

var KEYCHAIN_SERVICE = "twitch-chat";
var KEYCHAIN_ACCOUNT = "oauth-token";
var FALLBACK_CONFIG_DIR = "~/.config/twt";

var RECENT_EVENT_LIMIT = 60;
var PREF_POLL_MS = 700;
var ENV_TIMEOUT_MS = 1500;
var WINDOW_FALLBACK_MS = 3000;
/* A launch where the player window does not exist yet: sidebar.loadFile() and
 * overlay.loadFile() both throw "called when window is not available" until
 * IINA has a window for the instance. The ladder below retries the load on
 * these delays instead of treating the failed attempt as a loaded view. */
var WEBVIEW_RETRY_MS = [1000, 2000, 4000, 8000];
/* auto_open_browser: open the browser window on startup, but only while nothing
 * is playing. This is the settle window: media arriving inside it (IINA
 * restoring its last stream, the user opening a file) cancels the action. */
var AUTO_OPEN_SETTLE_MS = 2500;
var AUTO_OPEN_BROWSER_MESSAGE = "twt:auto-open-browser";
var SIDEBAR_READY_TIMEOUT_MS = 6000;
/* The sidebar web view is not attached to the window until its tab is opened,
 * and WebKit throttles/suspends timers of such a view: measured on IINA 1.5.0,
 * the page runs (it connects and joins) but its 30 s IRC keepalive never fires.
 * A postMessage makes WebKit run script in it again, so the plugin pokes a
 * silent view; the view answers with a state report and an IRC keepalive. */
/* IINA flips overlayViewLoaded inside DispatchQueue.main.async *after*
 * overlay.loadFile (iina/JavascriptAPIOverlay.swift) and both postMessage() and
 * show() are no-ops until it is true, so nothing may be delivered in the tick
 * that loads the overlay. A bounded retry ladder re-registers the handlers and
 * re-posts the state until the view reports back. */
/* Per-channel history: a local ring buffer that is persisted in the plugin's
 * data directory, plus optional remote pre-fill. Twitch has no official
 * chat-history API, so the cache is the default source (see README). */
var HISTORY_MAX_PER_CHANNEL = 50;
var HISTORY_MAX_CHANNELS = 20;
var HISTORY_MAX_BYTES = 512 * 1024;
var HISTORY_REMOTE_URL = "https://recent-messages.robotty.de/api/v2/recent-messages/";
var HISTORY_SAVE_DEBOUNCE_MS = 2000;
var HTTP_JSON_MAX_BYTES = 1024 * 1024;   /* the remote history body */
var REMOTE_MAX_LINES = 200;              /* lines we are willing to parse */
var REMOTE_MAX_TEXT = 2000;              /* characters kept per message */
var OVERLAY_RETRY_MS = [0, 250, 1000, 2500];
/* Overlay layout: the overlay reports completed drags/resizes, the plugin owns
 * the bounds and the persistence. The overlay applies the viewport part of the
 * clamp itself (the plugin never sees the video size). */
var OVERLAY_LAYOUT_MIN_W = 220;
var OVERLAY_LAYOUT_MIN_H = 120;
var OVERLAY_LAYOUT_MAX_CHANNELS = 50;
/* a drag reports every <=100 ms, so the preference is written once the gesture
 * pauses rather than once per report */
var OVERLAY_LAYOUT_SAVE_DEBOUNCE_MS = 250;
var OVERLAY_LAYOUT_ANCHORS = { tl: 1, tr: 1, bl: 1, br: 1 };
var SIDEBAR_POKE_CHECK_MS = 3000;
/* Measured: while the hidden web view is suspended, WebKit holds back *inbound*
 * socket data too - a busy channel delivered nothing for 59 s until a poke. With
 * the overlay on screen a short threshold therefore matters; when no chat view is
 * visible the poke only has to keep the connection alive. */
var SIDEBAR_SILENCE_MS = 45000;
var SIDEBAR_SILENCE_OVERLAY_MS = 3000;

/* VOD chat replay. Twitch has no official API for a finished VOD's chat, so
 * this uses the undocumented GraphQL operation the web player itself calls
 * (POST https://gql.twitch.tv/gql, operation VideoCommentsByOffsetOrCursor with
 * a persisted-query hash and the public web client id). It can break without
 * notice: any error therefore ends the replay instead of falling back to the
 * live chat, which would show the wrong conversation. */
var VOD_GQL_URL = "https://gql.twitch.tv/gql";
var VOD_GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
var VOD_GQL_OPERATION = "VideoCommentsByOffsetOrCursor";
var VOD_GQL_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";
var VOD_PATH_RE = /(?:^|\/)videos\/(\d{3,})/;
var VOD_PLAYER_RE = /[?&]video=v(\d+)/;
var VOD_TICK_MS = 1000;                  /* position poll + emission cadence */
var VOD_MIN_GAP_MS = 250;                /* at most one request per 250 ms */
var VOD_FETCH_AHEAD_SEC = 20;            /* fetch the next page this close to the end */
var VOD_PREFETCH_MAX_COMMENTS = 180;     /* ~3 pages (59 edges each) buffered ahead */
var VOD_SEEK_FORWARD_SEC = 15;           /* a bigger forward jump resets the buffer */
var VOD_SEEK_BACK_TOLERANCE_SEC = 0.5;
var VOD_BACKOFF_MS = [2000, 4000, 8000]; /* HTTP 429: 2/4/8 s, 3 retries per page */
var VOD_MAX_ATTEMPTS = 3;
var VOD_SEEN_MAX = 2000;                 /* dedupe ids kept per buffered window */
var VOD_TIMEOUT_MS = 10000;
var VOD_MAX_BYTES = 4 * 1024 * 1024;
/* Fast switch: a twt:open for the current window loads through mpv so IINA's
 * own "Loading media" window (PlayerCore.openMainWindow) is never entered.
 * mpv.end-file carries no reason through IINA's plugin API (MPVController
 * .swift emits "mpv.end-file" with no data), so a failed load is decided from
 * what the player shows shortly after: nothing playing at all. */
var LOAD_FAILURE_GRACE_MS = 1200;
/* Shown as channelNote while a VOD is replaying (the overlay labels the mode). */
var VOD_NOTE = "VOD chat replay";

var MSG = {
  /* plugin -> web views */
  SETTINGS: "twt:settings",
  STATE: "twt:state",
  EVENT: "twt:event",
  COMMAND: "twt:command",
  JOIN: "twt:join",
  PART: "twt:part",
  EMOTES: "twt:emotes",
  CLEAR: "twt:clear",
  HISTORY_RESULT: "twt:history-result",
  HTTP_RESULT: "twt:http-result",
  OVERLAY_LAYOUT: "twt:overlay-layout",
  /* web views -> plugin */
  READY: "twt:ready",
  OVERRIDES: "twt:overrides",
  HTTP_GET: "twt:http-get",
  TWITCH_GET: "twt:twitch-get",
  TWITCH_RESULT: "twt:twitch-result",
  OPEN: "twt:open",
  HISTORY_REQUEST: "twt:history-request",
  OVERLAY_MOVED: "twt:overlay-moved",
  LOG: "twt:log"
};

/* Preference keys that hold the user's overrides on top of the twt config. */
var OVERRIDE_BOOL_KEYS = [
  "showDatetimes",
  "usernameShown",
  "titleShown",
  "badges",
  "usernameHighlight",
  "twitchEmotes",
  "betterttvEmotes",
  "seventvEmotes",
  "frankerfacezEmotes"
];
var OVERRIDE_STRING_KEYS = ["palette", "theme", "datetimeFormat"];
var OVERRIDE_NUMBER_KEYS = ["maxMessages", "delay"];

/* Paths on twitch.tv that are not channel names. */
var RESERVED_TWITCH_PATHS = {
  about: 1, activate: 1, api: 1, blog: 1, charity: 1, clip: 1, clips: 1,
  collection: 1, collections: 1, creatorcamp: 1, directory: 1, downloads: 1,
  drops: 1, feed: 1, following: 1, friends: 1, games: 1, inventory: 1, jobs: 1,
  legal: 1, login: 1, messages: 1, mobile: 1, oauth2: 1, p: 1, player: 1,
  prime: 1, products: 1, search: 1, security: 1, settings: 1, signup: 1,
  squads: 1, store: 1, subscriptions: 1, team: 1, turbo: 1, video: 1,
  videos: 1, wallet: 1
};

/* ------------------------------------------------------------------- libs */

/* Compatibility net for the lib modules.
 *
 * The normal path is require("./lib/<name>.js"): IINA evaluates a required module as
 *   (function () { const module = {}; <file> return module.exports; })()
 * (iina/JavascriptPluginInstance.swift, evaluateFile(_:asModule:)), and the lib files
 * detect that shim (their UMD test is `typeof module === "object" && module`).
 *
 * If a lib file ever ships a UMD whose test this shim defeats, require() comes back
 * without exports while the same file has still filled in its TwitchPlugin.* global,
 * so read that instead of failing. Logged only when the fallback is actually used (or
 * when both paths fail), so a healthy load stays silent. */
function loadLib(name, globalName) {
  var mod = attempt(function () { return require("./lib/" + name + ".js"); }, null);
  if (mod && typeof mod === "object" && Object.keys(mod).length > 0) return mod;
  var fromGlobal = (typeof TwitchPlugin !== "undefined" && TwitchPlugin) ? TwitchPlugin[globalName] : null;
  if (fromGlobal && typeof fromGlobal === "object" && Object.keys(fromGlobal).length > 0) {
    log("lib/" + name + ".js: require() returned no exports, using the TwitchPlugin." + globalName + " global (compatibility)");
    return fromGlobal;
  }
  logWarn("cannot load lib/" + name + ".js: require() gave " + describeValue(mod) +
          " and TwitchPlugin." + globalName + " is " + describeValue(fromGlobal));
  return mod || {};
}

function describeValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") return "an object with " + Object.keys(value).length + " key(s)";
  return typeof value;
}

/* ----------------------------------------------------------------- logging */

function log(message) {
  if (state.windowGone) return;
  try {
    iina.console.log("[twitch-chat] " + message);
  } catch (e) { /* logging must never break the plugin */ }
}

function logWarn(message) {
  if (state.windowGone) return;
  try {
    iina.console.warn("[twitch-chat] " + message);
  } catch (e) {
    log("WARN " + message);
  }
}

/* Calls fn, returns fallback on any error (IINA throws JS exceptions for
 * illegal API usage, e.g. loading a web view before the window is ready). */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    logWarn("call failed: " + e);
    return fallback;
  }
}

/* ------------------------------------------------------------------- state */

var state = {
  env: {},
  settings: null,        /* effective (config + preferences) settings */
  filters: null,         /* effective filters */
  configSource: null,    /* {configFile, filtersFile, configFileFound, filtersFound} */
  warnings: [],
  channel: null,         /* channel the plugin wants to be joined (lowercase) */
  connState: "idle",
  token: { available: false, source: "none", value: null },
  sidebarReady: false,
  overlayLoaded: false,  /* overlay.loadFile() has been called */
  overlayReady: false,   /* the overlay web view reported twt:ready */
  overlayRetryTimer: null,
  overlayVisible: false,
  overlayLayouts: {},        /* channel (or "default") -> {x, y, w, h} */
  overlayLayoutOrder: [],    /* channel usage order, oldest first (LRU pruning) */
  overlayLayoutTimer: null,
  overlayLayoutDirty: false,
  overlayLayoutCorruptLogged: false,
  recent: [],
  detection: null,       /* {channel, reason, source} for the playing video */
  configTried: [],
  clearedChannel: null,      /* the channel the views' message lists belong to */
  history: {},               /* channel -> [normalised message] */
  historyOrder: [],          /* channel usage order, oldest first (LRU pruning) */
  historyTimer: null,
  historyLoaded: false,
  historyGeneration: 0,     /* bumped on every channel switch and on teardown */
  historyCorruptLogged: false,
  roomIds: {},             /* channel -> room id last seen from ROOMSTATE/history */
  pendingOpen: null,       /* {url, at} of the mpv loadfile we are waiting on */
  videoRepair: "",         /* url whose disabled video track was already repaired */
  loadCheckTimer: null,
  /* VOD chat replay. `active` means a VOD is playing with replay enabled: the
   * live chat is suppressed while it is true, whatever the other fields say. */
  vod: {
    active: false,
    videoId: "",
    channel: null,        /* channel the replay belongs to (live history is refused for it) */
    ownerId: "",          /* broadcaster id from video.creator, for the emote index */
    generation: 0,        /* bumped on every reset/stop so stale responses are dropped */
    pending: [],          /* mapped messages not emitted yet, ascending by offsetSeconds */
    seen: {},             /* comment id -> true, bounded by seenOrder */
    seenOrder: [],
    nextOffset: 0,        /* contentOffsetSeconds of the next request (offset stepping) */
    startOffset: 0,       /* offset the current replay window started at */
    error: "",            /* short failure code surfaced as vodError ("integrity", ...) */
    stats: { pages: 0, comments: 0, offset: 0 },
    bufferedEnd: 0,       /* offset (s) of the newest buffered comment */
    lastPosition: null,
    fetching: false,      /* one request in flight at a time */
    lastRequestAt: 0,     /* wall clock of the last request (VOD_MIN_GAP_MS) */
    attempts: 0,          /* 429 retries spent on the current page */
    requestTimer: null,
    tickTimer: null,
    done: false,          /* the last page was reached */
    failed: false,        /* gave up: show no chat at all */
    failureLogged: false
  },
  windowGone: false,       /* the player window is closing: no IINA API calls any more */
  channelSource: "none", /* which rule picked the current channel */
  channelNote: "",       /* why detection produced no channel, for the status line */
  fileToken: "",
  detectionSignature: "", /* what channel detection saw (URL + title + ...) when it last decided */
  lastSidebarMessage: 0,
  pokesSent: 0,
  pokesWithoutReply: 0,
  emoteIndex: null,
  pluginRoot: null,
  webviewsLoaded: false,   /* a loadFile() call actually succeeded - never set by a failed attempt */
  autoOpenBrowser: false,  /* auto_open_browser, read once at boot (startup only) */
  autoOpenTimer: null,     /* the settle window, null once it fired or was cancelled */
  webviewAttempts: 0,      /* failed load attempts on the retry ladder (logging + bound only) */
  prefWrites: {},
  poll: { seq: 0, watched: null, timer: null }
};

var menus = {};

/* Timeouts that belong to the startup handshake (window-loaded fallback, the
 * sidebar-readiness retry). A late one would reload a web view and re-register
 * plugin listeners on an instance whose JS context is gone - which is how
 * JavascriptMessageHub's unchecked `callback.value` traps the app - so they are
 * tracked here and cancelled by the window teardown. */
var handshakeTimers = [];

function handshakeTimeout(fn, ms) {
  var timer = setTimeout(function () {
    var index = handshakeTimers.indexOf(timer);
    if (index !== -1) handshakeTimers.splice(index, 1);
    if (state.windowGone) return;
    fn();
  }, ms);
  handshakeTimers.push(timer);
  return timer;
}

function clearHandshakeTimers() {
  for (var i = 0; i < handshakeTimers.length; i++) clearTimeout(handshakeTimers[i]);
  handshakeTimers.length = 0;
}

/* -------------------------------------------------------------- preferences */

function readPref(key, fallback) {
  var value = null;
  try {
    value = iina.preferences.get(key);
  } catch (e) {
    value = null;
  }
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number" && isNaN(value)) return fallback;
  return value;
}

function prefBool(key, fallback) {
  var value = readPref(key, fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1" || value === "yes";
  return !!fallback;
}

function readPrefString(key, fallback) {
  var value = readPref(key, fallback);
  return typeof value === "string" ? value : (typeof value === "number" ? String(value) : fallback);
}

/* Writes only when the value actually changed (preferences.sync() hits disk). */
function writePref(key, value) {
  if (state.prefWrites[key] === value) return;
  if (attempt(function () { iina.preferences.set(key, value); iina.preferences.sync(); return true; }, false)) {
    state.prefWrites[key] = value;
  }
}

function readOverrides() {
  var raw = readPrefString("ui_overrides", "");
  if (!raw) return {};
  var parsed = attempt(function () { return JSON.parse(raw); }, null);
  return (parsed && typeof parsed === "object" && !isArray(parsed)) ? parsed : {};
}

function writeOverrides(overrides) {
  writePref("ui_overrides", JSON.stringify(overrides));
}

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

/* ---------------------------------------------------- web view text codec
 *
 * The codec that keeps a payload safe inside IINA's
 * `window.iina._emit(\`name\`, String.raw\`<json>\`)` bridge (backticks and "${"
 * both break the template literal) lives in lib/webview.js so the standalone
 * host in global.js encodes exactly the same way. */

/* ------------------------------------------------------------- config load */

/* The config-file and environment plumbing (the iina.file.read arity dance, HOME from
 * /usr/bin/env, "~/" expansion, the *Config file* preference) lives in
 * lib/hostenv.js so the standalone host in global.js reads the same config the
 * same way. This entry only supplies its own state and logging. */
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

function readTextFile(path) {
  return hostenv.readTextFile(path);
}

function readErrorsText() {
  return hostenv.readErrorsText();
}

function resolvePath(path) {
  return hostenv.resolvePath(path);
}

/* utils.resolvePath() only expands a leading "~/"; a bare "~" throws
 * "The path should be an absolute path: ~" (iina/JavascriptAPI.swift, parsePath).
 * Prefer HOME from /usr/bin/env and derive it from a known "~/" path otherwise. */
function homePath() {
  return hostenv.homePath();
}

function readEnvironment(done) {
  hostenv.readEnvironment(function (env) {
    state.env = env;
    done();
  });
}

function expandHome(path, home) {
  return hostenv.expandHome(path, home);
}

/* Where the config file lives is lib/config.js's job: it probes the candidates
 * twitch-tui uses (config_file preference, TWT_CONFIG, ~/.config/twt,
 * ~/Library/Application Support/com.twitch-tui.twt from
 * ProjectDirs::from("com", "twitch-tui", "twt") and
 * ~/Library/Preferences/com.twitch-tui.twt) and reports every candidate it
 * tried through source.tried = [{path, found, error?}]. The only decision left
 * here is the *Config file* preference, which is passed through explicitly. */
function configFileOption(home) {
  return hostenv.configFileOption(readPrefString("config_file", ""), home);
}

function configDir() {
  var source = state.configSource;
  if (source && typeof source.configFile === "string" && source.configFile) {
    return dirname(source.configFile);
  }
  return resolvePath(FALLBACK_CONFIG_DIR);
}

function dirname(path) {
  var idx = String(path).lastIndexOf("/");
  if (idx <= 0) return String(path);
  return String(path).slice(0, idx);
}

function applyOverrides(settings, overrides) {
  var chat = settings.chat;
  var i, key, value;
  for (i = 0; i < OVERRIDE_BOOL_KEYS.length; i++) {
    key = OVERRIDE_BOOL_KEYS[i];
    value = overrides[key];
    if (typeof value === "boolean") chat[key] = value;
  }
  for (i = 0; i < OVERRIDE_STRING_KEYS.length; i++) {
    key = OVERRIDE_STRING_KEYS[i];
    value = overrides[key];
    if (typeof value === "string" && value) chat[key] = value;
  }
  for (i = 0; i < OVERRIDE_NUMBER_KEYS.length; i++) {
    key = OVERRIDE_NUMBER_KEYS[i];
    value = overrides[key];
    if (typeof value === "number" && isFinite(value) && value >= 0) {
      chat[key] = key === "maxMessages" ? Math.max(1, Math.floor(value)) : value;
    }
  }
  var filterToggles = overrides.filtersEnabled;
  if (filterToggles && typeof filterToggles === "object") {
    if (typeof filterToggles.message === "boolean") settings.filters.message.enabled = filterToggles.message;
    if (typeof filterToggles.username === "boolean") settings.filters.username.enabled = filterToggles.username;
  }
  return settings;
}

function reloadConfig(announce) {
  var home = homePath();
  var env = {};
  var keys = Object.keys(state.env);
  for (var i = 0; i < keys.length; i++) env[keys[i]] = state.env[keys[i]];
  if (home) env.HOME = home;

  var options = { readFile: readTextFile, home: home, env: env };
  var configFile = configFileOption(home);
  if (configFile) {
    options.configFile = configFile;
    state.configTried = [configFile];
  }

  var result = attempt(function () { return configLib.loadConfig(options); }, null);
  if (!result) {
    logWarn("config loading failed; keeping the previous settings");
    return;
  }
  state.configSource = result.source;
  state.configTried = sourcePaths(result.source) || state.configTried;
  state.warnings = isArray(result.warnings) ? result.warnings : [];
  var effective = applyOverrides(result.settings, readOverrides());
  /* token: the twt config file wins, the Keychain is the fallback */
  var token = cleanToken(effective.twitch.token);
  var tokenSource = token ? "config" : "none";
  if (!token) {
    var stored = readKeychainToken();
    if (stored) {
      token = stored;
      tokenSource = "keychain";
    }
  }
  effective.twitch.token = token || null;
  state.token = { available: !!token, source: tokenSource, value: token || null };
  state.settings = effective;
  state.filters = effective.filters;

  for (i = 0; i < state.warnings.length; i++) logWarn("config: " + state.warnings[i]);
  log("config " + describeConfig());
  publishPreferencesPageStatus();
  if (announce) broadcastSettings();
}

function describeConfig() {
  var source = state.configSource;
  if (!source) return "unavailable";
  return (source.configFileFound ? "loaded " : "missing ") + source.configFile +
    (source.filtersFound ? " (+filters.txt)" : "");
}

/* ------------------------------------------------------------------- token */

function cleanToken(raw) {
  if (typeof raw !== "string") return "";
  var token = raw.replace(/\s+/g, "");
  if (/^oauth:/i.test(token)) token = token.slice(6);
  return token;
}

function readKeychainToken() {
  var stored = attempt(function () { return iina.utils.keyChainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT); }, false);
  if (typeof stored !== "string") return "";
  return cleanToken(stored);
}

function saveTokenToKeychain(raw) {
  var token = cleanToken(raw);
  if (!token) return false;
  var ok = attempt(function () { return iina.utils.keyChainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token); }, false);
  if (!ok) {
    logWarn("could not write the token to the Keychain");
    return false;
  }
  log("OAuth token stored in the Keychain");
  return true;
}

function forgetToken() {
  attempt(function () { return iina.utils.keyChainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, ""); }, false);
  log("OAuth token removed from the Keychain");
}

/* ------------------------------------------------------------------ channel */

function normalizeChannel(raw) {
  if (typeof raw !== "string") return "";
  var value = raw.trim();
  if (!value) return "";
  var fromUrl = channelFromText(value);
  if (fromUrl) return fromUrl;
  if (value.charAt(0) === "#") value = value.slice(1);
  value = value.toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(value)) return "";
  if (RESERVED_TWITCH_PATHS[value]) return "";
  return value;
}

function channelFromText(text) {
  if (typeof text !== "string" || !text) return null;
  var lower = text.toLowerCase();
  var i;
  if (lower.indexOf("twitch.tv") !== -1) {
    var query = /[?&]channel=([a-z0-9_]{1,25})/i.exec(text);
    if (query) {
      var fromQuery = query[1].toLowerCase();
      if (!RESERVED_TWITCH_PATHS[fromQuery]) return fromQuery;
    }
    var path = /twitch\.tv\/([a-z0-9_]{1,25})(?:[/?#]|$)/i.exec(text);
    if (path) {
      var fromPath = path[1].toLowerCase();
      if (!RESERVED_TWITCH_PATHS[fromPath]) return fromPath;
    }
  }
  return null;
}

/* ------------------------------------------------------- channel detection
 *
 * Plugin feature (not a twitch-tui field): guess the channel from the video
 * that is playing. An explicit twitch.tv URL anywhere in the media is trusted;
 * a bare title is only trusted when the same media is demonstrably
 * Twitch-sourced, so a YouTube video called "Bob - highlights" never joins
 * #bob. VOD URLs (twitch.tv/videos/<id>) carry no channel name, so there the
 * title heuristic is the only signal. */

var LOGIN_RE = /^[a-zA-Z0-9_]{2,25}$/;

/* Words that are never a channel name, so a VOD/stream title like "VoD" or
 * "Live" cannot produce a bogus join. */
var TITLE_STOPWORDS = {
  archive: 1, clip: 1, clips: 1, final: 1, grand: 1, highlight: 1, highlights: 1,
  live: 1, match: 1, part: 1, play: 1, recording: 1, replay: 1, stream: 1,
  streamed: 1, twitch: 1, video: 1, videos: 1, vod: 1, vods: 1, watch: 1
};
var TITLE_SEPARATOR_RE = /\s+[\u2014\u2013|\u00b7:]\s+|\s+-\s+/;
var DETECT_LABEL = {
  url: "video URL",
  path: "media path",
  filename: "file name",
  mediaTitle: "media title",
  playlist: "playlist entry",
  title: "video title"
};

function mpvString(name) {
  var value = attempt(function () { return iina.mpv.getString(name); }, "");
  return typeof value === "string" ? value : "";
}

/* Every place the channel name could hide, in the order we trust it. */
function candidateSources() {
  var sources = [];
  function push(label, value) {
    if (typeof value === "string" && value.trim()) sources.push({ label: label, value: value.trim() });
  }
  push("url", attempt(function () { return iina.core.status.url; }, ""));
  push("title", attempt(function () { return iina.core.status.title; }, ""));
  push("path", mpvString("path"));
  push("filename", mpvString("filename"));
  push("mediaTitle", mpvString("media-title"));
  var items = attempt(function () { return iina.playlist.list(); }, null);
  if (isArray(items)) {
    for (var i = 0; i < items.length && i < 10; i++) {
      if (!items[i]) continue;
      push("playlist", items[i].filename);
      if (items[i].isPlaying && typeof items[i].title === "string") push("mediaTitle", items[i].title);
    }
  }
  return sources;
}

/* Everything channel detection can read, as one comparable value. The media
 * switch is not over when the file token settles: iina.file-loaded fires before
 * core.status.url changes, and the title of a VOD - which carries the only
 * channel name it has - is parsed later still. The decision ladder compares
 * this signature so a decision taken from the previous media's title is revisited. */
function detectionSignature() {
  var sources = candidateSources();
  var parts = [];
  for (var i = 0; i < sources.length; i++) parts.push(sources[i].label + "=" + sources[i].value);
  return parts.join("\n");
}

/* Evidence that the media really comes from Twitch (the title alone is not). */
function twitchMarkerLabel(sources) {
  for (var i = 0; i < sources.length; i++) {
    if (sources[i].label === "title") continue;
    if (/twitch\.tv|ttvnw\.net|twitch\.com/i.test(sources[i].value)) return sources[i].label;
  }
  return null;
}

/* "ohnePixel — VITY vs LOUD [GRAND FINAL]" -> "ohnepixel" */
function channelFromTitle(title) {
  if (typeof title !== "string") return "";
  var head = title.split(TITLE_SEPARATOR_RE)[0];
  if (!head) return "";
  head = head.trim().replace(/^#/, "");
  if (!LOGIN_RE.test(head)) return "";
  var login = head.toLowerCase();
  if (RESERVED_TWITCH_PATHS[login] || TITLE_STOPWORDS[login]) return "";
  return login;
}

/* -> {channel, reason, source}; channel is null when nothing was found. */
function detectChannel(urlOverride) {
  var sources = candidateSources();
  /* iina.file-loaded fires before core.status.url / mpv `path` switch to the new
   * file, so the event's own URL is the authoritative candidate (otherwise the
   * decision lags one file behind). */
  if (typeof urlOverride === "string" && urlOverride) sources.unshift({ label: "url", value: urlOverride });
  var i, channel;
  for (i = 0; i < sources.length; i++) {
    channel = channelFromText(sources[i].value);
    if (channel) {
      return { channel: channel, reason: "found in the " + DETECT_LABEL[sources[i].label], source: sources[i].label };
    }
  }
  var marker = twitchMarkerLabel(sources);
  if (!marker) {
    return { channel: null, reason: sources.length ? "no Twitch video detected" : "nothing is playing", source: null };
  }
  for (i = 0; i < sources.length; i++) {
    if (sources[i].label !== "title" && sources[i].label !== "mediaTitle") continue;
    channel = channelFromTitle(sources[i].value);
    if (channel) {
      return {
        channel: channel,
        reason: "guessed from the " + DETECT_LABEL[sources[i].label] + " (" + DETECT_LABEL[marker] + " is Twitch)",
        source: sources[i].label
      };
    }
  }
  return {
    channel: null,
    reason: "Twitch video detected (" + DETECT_LABEL[marker] + ") but its title carries no channel name",
    source: null
  };
}

function setDetection(detection) {
  var before = JSON.stringify(state.detection);
  state.detection = detection || null;
  if (before !== JSON.stringify(state.detection)) {
    broadcastSettings();
  }
}

/* Auto-join policy: an explicit channel (config or the channel preference) and
 * any manual join win; a channel the user left on purpose is not re-joined
 * until another file is loaded; at most one automatic join per loaded file. */
function currentFileToken() {
  var url = attempt(function () { return iina.core.status.url; }, "");
  if (typeof url === "string" && url) return url;
  return mpvString("path");
}

/* Human wording for why detection produced nothing, used in the status line. */
function humanDetectionReason(detection) {
  if (!detection || !detection.reason) return "";
  if (detection.reason === "nothing is playing") return "nothing is playing";
  if (detection.reason === "no Twitch video detected") return "no Twitch channel detected in this video";
  if (detection.reason === "automatic joining is switched off in the plugin settings") return "video detection is switched off";
  if (/title carries no channel name/.test(detection.reason)) return "no channel name in this Twitch video's title";
  return detection.reason;
}

/* Chat is bound to the playing media and to nothing else. The rule is:
 * bind only to a channel detected in the playing video, gated by auto_join
 * (false = never bind automatically), and never to config or manual input -
 * there is no config channel, no remembered channel and no manual join. */
function chooseChannel(urlOverride) {
  var detection = detectChannel(urlOverride);
  if (!prefBool("auto_join", true)) {
    return {
      channel: null,
      source: "none",
      note: "automatic joining is switched off in the plugin settings",
      detection: detection
    };
  }
  if (detection.channel) {
    return { channel: detection.channel, source: "video", note: detection.reason, detection: detection };
  }
  return { channel: null, source: "none", note: humanDetectionReason(detection), detection: detection };
}

/* Entry point: pick the channel for the playing media, then the playback mode
 * (live chat vs VOD chat replay) for that same media. */
function maybeAutoJoin(trigger, urlOverride) {
  if (!state.settings) return;
  applyChannelDecision(trigger, urlOverride);
  updateVodReplay(urlOverride);
  /* A pending mpv load is settled as soon as the player reports media other
   * than the one we were on when the loadfile was issued: anything later (the
   * natural end of that stream, a stop) must not be read as this load failing. */
  var pending = state.pendingOpen;
  if (pending && state.fileToken && state.fileToken !== pending.prevToken) {
    state.pendingOpen = null;
    if (state.loadCheckTimer) { clearTimeout(state.loadCheckTimer); state.loadCheckTimer = null; }
  }
}

/* Applies the automatic choice. Chat follows the video: a file without a Twitch
 * channel releases the previous one, and a channel detected in a new file
 * replaces what an earlier file bound. */
function applyChannelDecision(trigger, urlOverride) {
  /* remember which media this decision belongs to, so a later event for the
   * same file does not re-bind over and over */
  state.fileToken = currentFileToken() || state.fileToken;
  state.detectionSignature = detectionSignature();

  var decision = chooseChannel(urlOverride);
  state.channelSource = decision.source;
  state.channelNote = decision.note || "";
  if (decision.detection) setDetection(decision.detection);

  if (!decision.channel) {
    log("channel decision: no channel (" + (decision.note || "nothing detected") + ")");
    if (state.channel) {
      requestLeave("the playing video has no Twitch channel");
    } else {
      broadcastSettings();
    }
    return;
  }
  if (decision.channel === state.channel) {
    log("channel decision: staying in #" + decision.channel + " (from the playing video)");
    broadcastSettings();
    return;
  }
  var previous = state.channel;
  requestJoin(decision.channel, trigger);
  log("channel decision: detected #" + decision.channel + " from " +
      (decision.detection && decision.detection.source ? decision.detection.source : "the video") +
      (previous ? ", leaving #" + previous : ""));
  osd("joined #" + decision.channel + " (from the playing video)");
  broadcastSettings();
}

/* Switching channel must clear what the views show and the plugin's replay
 * backlog. Done explicitly, before anything about the new channel is posted,
 * so neither view has to infer it from a settings change. */
function announceChannelChange(channel) {
  if (!channel || channel === state.clearedChannel) return;
  state.clearedChannel = channel;
  state.recent.length = 0;
  state.historyGeneration++;
  saveHistoryNow();        /* keep what we already have for the channel we leave */
  /* the channel we are leaving may have a debounced layout write pending */
  saveOverlayLayoutsNow();
  log("channel switch: clearing the message lists and the backlog for #" + channel);
  postToSidebar(MSG.CLEAR, { channel: channel });
  postToOverlay(MSG.CLEAR, { channel: channel });
  /* after the clear: the overlay shows the layout remembered for the new
   * channel (or the CSS default when there is none) */
  postOverlayLayout(channel);
}

/* Binds chat to `rawChannel`. Chat is always bound automatically (the channel
 * comes from the video), so there is no manual flag any more. */
function requestJoin(rawChannel, reason) {
  var channel = normalizeChannel(rawChannel);
  if (!channel) {
    logWarn("ignoring invalid channel '" + rawChannel + "'");
    return false;
  }
  var changed = channel !== state.channel;
  if (changed) announceChannelChange(channel);
  state.channel = channel;
  state.channelSource = "video";
  state.channelNote = "";
  if (reason) log("joining #" + channel + " (" + reason + ")");
  postToSidebar(MSG.JOIN, { channel: channel });
  postToOverlay(MSG.JOIN, { channel: channel });
  /* a Twitch video may now be playing: the overlay comes back if it was left
   * visible */
  syncOverlayVisibility();
  return changed;
}

/* Releases the channel: nothing Twitch is playing any more, so chat goes idle.
 * Mirrors announceChannelChange (clear the message lists + the replay backlog)
 * but posts a part instead of a join. */
function requestLeave(reason) {
  var channel = state.channel;
  if (!channel) return;
  state.channel = null;
  state.clearedChannel = null;
  state.channelSource = "none";
  state.recent.length = 0;
  state.historyGeneration++;
  saveHistoryNow();
  if (reason) log("leaving #" + channel + " (" + reason + ")");
  postToSidebar(MSG.PART, { channel: channel });
  postToOverlay(MSG.PART, { channel: channel });
  postOverlayLayout(null);
  /* no channel means non-Twitch (or idle) media: the overlay never stays on
   * screen there */
  syncOverlayVisibility();
  broadcastSettings();
}

/* -------------------------------------------------------------------- OSD */

function osd(message) {
  if (state.windowGone || !message) return;
  attempt(function () { iina.core.osd("Twitch: " + message); });
}

/* ------------------------------------------------------------------ menus */

/* IINA exports MenuItem.addSubMenuItem (JavascriptPluginMenuItem.swift:19 and
 * the plugin type definitions); the example in IINA's own API docs spells it
 * "addSubmenuItem", so accept either. Anything that cannot be nested is added
 * at the top level instead, because IINA counts first-level items and silently
 * drops everything past the fifth. */
function addSubmenu(parent, item) {
  if (typeof parent.addSubMenuItem === "function") {
    parent.addSubMenuItem(item);
    return true;
  }
  if (typeof parent.addSubmenuItem === "function") {
    parent.addSubmenuItem(item);
    return true;
  }
  logWarn("this IINA build exposes no submenu API; '" + item.title + "' is added at the top level");
  attempt(function () { iina.menu.addItem(item); });
  return false;
}

/* menu.item(_ title: String, _ action: JSValue, _ options: JSValue) - the options
 * object is always passed explicitly (IINA reads it with getKeyedValue()). */
function menuItem(title, action, options) {
  return attempt(function () {
    return iina.menu.item(title, action, options || {});
  }, null);
}

/* Builds the plugin menu from scratch. JavascriptPluginMenuItem keeps its
 * NSMenuItem `unowned`, so writing .title/.selected/.enabled on a live item
 * traps in Swift (observed SIGABRT); the menu is built once and never mutated
 * in place (menu.removeAllItems() is part of IINA's API). */
function buildMenus() {
  menus.connection = menuItem("Connect / Disconnect", onToggleConnection);
  attempt(function () { iina.menu.addItem(menus.connection); });

  menus.overlay = menuItem("Toggle Twitch Overlay", onToggleOverlay, {
    keyBinding: "Meta+Shift+t"
  });
  attempt(function () { iina.menu.addItem(menus.overlay); });

  menus.sidebar = menuItem("Show Twitch Sidebar", onShowSidebar, {
    keyBinding: "Meta+Shift+b"
  });
  attempt(function () { iina.menu.addItem(menus.sidebar); });

  /* IINA only shows the first five first-level items of a plugin menu
   * ("Please avoid adding too much first-level menu items"), so the Config
   * entries live in one submenu. */
  menus.configMenu = menuItem("Config");
  menus.reload = menuItem("Reload Config", onReloadConfig);
  addSubmenu(menus.configMenu, menus.reload);
  menus.configFolder = menuItem("Open Config Folder", onOpenConfigFolder);
  addSubmenu(menus.configMenu, menus.configFolder);
  menus.help = menuItem("Open Help / README", onOpenHelp);
  addSubmenu(menus.configMenu, menus.help);
  attempt(function () { iina.menu.addItem(menus.configMenu); });
}

function setupMenus() {
  attempt(function () {
    if (typeof iina.menu.removeAllItems === "function") iina.menu.removeAllItems();
    buildMenus();
  });
}

/* Publishes the items built by setupMenus() into the app menu.
 *
 * IINA populates the Plugin menu from PlayerCore.active.plugins only when the
 * menu opens (MenuController.menuWillOpen, MenuController.swift:846-848) or
 * when a plugin calls JavascriptAPIMenu.forceUpdate() (JavascriptAPIMenu.swift:
 * 73-77). A plugin's top-level code runs inside JavascriptPluginInstance.init
 * (JavascriptPluginInstance.swift:57-68), i.e. while PlayerCore.plugins still
 * holds the *previous* instances (PlayerCore.loadPlugins, PlayerCore.swift:
 * 367-375, and reloadPlugin, :377-395, assign it after the init returns). A
 * forceUpdate() from boot therefore cannot publish these items - and if the
 * active core has no plugins yet it makes updatePluginMenu() run
 * pluginMenu.removeAllItems() (MenuController.swift:634) and rebuild the menu
 * without them, which drops every plugin key equivalent (ours and other
 * plugins') until the Plugin menu is opened again. The first event after the
 * instance is registered is the window loading, so refresh here. */
function refreshMenus() {
  attempt(function () {
    if (typeof iina.menu.forceUpdate === "function") iina.menu.forceUpdate();
  });
}


function onToggleConnection() {
  if (state.windowGone) return;
  var busy = state.connState === "connecting" || state.connState === "connected" || state.connState === "reconnecting";
  if (busy) {
    postToSidebar(MSG.COMMAND, { command: "disconnect" });
    return;
  }
  /* the channel always comes from the playing video: there is no prompt */
  if (state.channel) {
    postToSidebar(MSG.COMMAND, { command: "connect", channel: state.channel });
    return;
  }
  postToSidebar(MSG.COMMAND, { command: "connect" });
  osd("no Twitch channel detected in the playing video");
}

function onToggleOverlay() {
  if (state.windowGone) return;
  var visible = !state.overlayVisible;
  setOverlayVisible(visible);
  /* the preference is remembered, but the panel itself never appears without a
   * bound chat: say why the toggle looks inert */
  if (visible && !state.channel) osd("Twitch Chat is only available on Twitch videos");
}

function onShowSidebar() {
  if (state.windowGone) return;
  attempt(function () { iina.sidebar.show(); });
}

function onReloadConfig() {
  if (state.windowGone) return;
  reloadConfig(true);
  osd(state.configSource && state.configSource.configFileFound ? "configuration reloaded" : "no config file found, using defaults");
}

function onOpenConfigFolder() {
  if (state.windowGone) return;
  var dir = configDir();
  var opened = attempt(function () { return iina.utils.open(dir); }, false);
  if (!opened) logWarn("could not open " + dir);
}

function onOpenHelp() {
  if (state.windowGone) return;
  var path = state.pluginRoot ? state.pluginRoot + "/" + HELP_FILE : HELP_FILE;
  var opened = attempt(function () { return iina.utils.open(path); }, false);
  if (!opened) {
    attempt(function () { return iina.utils.open("https://docs.iina.io/pages/webviews.html"); }, false);
  }
}

/* -------------------------------------------------------------- messaging */

function postToWebview(target, name, payload) {
  if (state.windowGone || !target) return;
  attempt(function () { target.postMessage(name, webviewLib.encodeForWebview(payload)); });
}

/* The channel source travels with every state message, so a view can label the
 * header without waiting for the next settings broadcast. The note names the
 * playback mode while a VOD is replaying; the channel-decision note is kept. */
function withChannelSource(payload) {
  var out = {};
  var keys = Object.keys(payload || {});
  for (var i = 0; i < keys.length; i++) out[keys[i]] = payload[keys[i]];
  out.channelSource = state.channelSource;
  out.channelNote = state.vod.active ? VOD_NOTE : state.channelNote;
  out.vodReplay = !!state.vod.active;
  out.vodError = vodErrorPayload();
  out.vodStats = vodStatsPayload();
  return out;
}

function postToSidebar(name, payload) {
  if (!state.sidebarReady) return;
  postToWebview(iina.sidebar, name, payload);
}

function postToOverlay(name, payload) {
  if (!state.overlayLoaded) return;
  postToWebview(iina.overlay, name, payload);
}

/* The short failure code and the paging counters travel in the state payloads:
 * a live run can then be verified from the overlay even when IINA's log is
 * off. vodError is null unless the replay gave up. */
function vodErrorPayload() {
  return state.vod.active && state.vod.error ? "VOD chat replay unavailable (" + state.vod.error + ")" : null;
}

function vodStatsPayload() {
  var vod = state.vod;
  if (!vod.active) return null;
  return { pages: vod.stats.pages, comments: vod.stats.comments, offset: vod.stats.offset };
}

function sidebarSettingsPayload() {
  return {
    settings: state.settings,
    filters: state.filters,
    overrides: readOverrides(),
    /* the channel the plugin decided on (the decision, not just the config), so
     * the sidebar's first connect already opens the right one */
    channel: state.channel,
    currentChannel: state.channel,
    token: { available: state.token.available, source: state.token.source, value: state.token.value },
    configSource: state.configSource,
    configTried: sourcePaths(state.configSource) || state.configTried,
    tokenPresent: (state.configSource && state.configSource.tokenPresent) || null,
    readErrors: triedReadErrors(state.configSource),
    configDir: configDir(),
    statusText: configStatusText(),
    tokenStatusText: tokenStatusText(),
    detection: state.detection,
    channelSource: state.channelSource,
    channelNote: state.vod.active ? VOD_NOTE : state.channelNote,
    vodReplay: !!state.vod.active,
    vodOwnerId: state.vod.active && state.vod.ownerId ? state.vod.ownerId : null,
    vodError: vodErrorPayload(),
    vodStats: vodStatsPayload(),
    autoJoin: prefBool("auto_join", true),
    warnings: state.warnings,
    overlayVisible: state.overlayVisible,
    version: VERSION
  };
}

function overlaySettingsPayload() {
  return {
    settings: stripToken(state.settings),
    filters: state.filters,
    channel: state.channel,
    currentChannel: state.channel,
    token: { available: state.token.available, source: state.token.source },
    detection: state.detection,
    channelSource: state.channelSource,
    channelNote: state.vod.active ? VOD_NOTE : state.channelNote,
    vodReplay: !!state.vod.active,
    vodOwnerId: state.vod.active && state.vod.ownerId ? state.vod.ownerId : null,
    vodError: vodErrorPayload(),
    vodStats: vodStatsPayload(),
    version: VERSION
  };
}

function stripToken(settings) {
  /* JSON clone keeps the payload plain and keeps the token out of the overlay. */
  var clone = attempt(function () { return JSON.parse(JSON.stringify(settings)); }, null);
  if (!clone) return settings;
  if (clone.twitch) delete clone.twitch.token;
  return clone;
}

function broadcastSettings() {
  if (state.sidebarReady) postToSidebar(MSG.SETTINGS, sidebarSettingsPayload());
  if (state.overlayLoaded) {
    postToOverlay(MSG.SETTINGS, overlaySettingsPayload());
    /* the overlay rebuilds its renderer on settings changes */
    postEmoteIndexToOverlay();
  }
}

/* lib/config.js may report the whole search: source.tried = [{path, found}] and
 * source.tokenPresent = {available, empty}. Every field is optional - the plugin
 * falls back to its own probe and to the [twitch] token it actually has. */
function sourcePaths(source) {
  if (!source || !isArray(source.tried)) return null;
  var paths = [];
  for (var i = 0; i < source.tried.length; i++) {
    var entry = source.tried[i];
    if (!entry) continue;
    if (typeof entry === "string") paths.push(entry);
    else if (typeof entry.path === "string" && entry.path) paths.push(entry.path);
  }
  return paths.length ? paths : null;
}

function configStatusText() {
  var source = state.configSource || {};
  var tried = sourcePaths(source) || (state.configTried.length ? state.configTried : [FALLBACK_CONFIG_DIR]);
  var readError = triedReadErrors(source);
  var status;
  if (source.configFileFound) {
    status = "Config: " + (source.configFile || tried[0]);
  } else if (tried.length > 1) {
    status = (readError ? "No config file could be read" : "No config file found") + " (tried: " + tried.join(", ") + ")";
  } else {
    status = (readError ? "Config could not be read at " : "Config not found at ") + (source.configFile || tried[0]);
  }
  if (source.filtersFound) status += " (filters.txt loaded)";
  if (readError) status += " - read error: " + readError;
  if (state.warnings.length) status += " - " + state.warnings.length + " warning(s), see Window > Log Viewer";
  return status;
}

/* Problems lib/config.js saw while probing, plus anything this plugin's
 * iina.file.read calls reported, so a broken API shape cannot masquerade as
 * "file not found". */
function triedReadErrors(source) {
  var parts = [];
  if (source && isArray(source.tried)) {
    for (var i = 0; i < source.tried.length; i++) {
      var entry = source.tried[i];
      if (entry && entry.error) parts.push((entry.path || "?") + ": " + entry.error);
    }
  }
  var own = readErrorsText();
  if (own) parts.push(own);
  return parts.join("; ");
}

function tokenPresenceText(source) {
  var present = source && source.tokenPresent;
  if (!present || typeof present.available !== "boolean") return null;
  if (!present.available) return "no [twitch] token";
  if (present.empty) return "[twitch] token is present but empty";
  return "[twitch] token present";
}

function tokenStatusText() {
  var source = state.configSource || {};
  var tried = sourcePaths(source) || (state.configTried.length ? state.configTried : [FALLBACK_CONFIG_DIR]);
  var file = source.configFile || tried[0];
  var presence = tokenPresenceText(source);
  var username = state.settings ? state.settings.twitch.username : "";

  if (state.token.available) {
    var where = state.token.source === "keychain" ? "read from the Keychain" : "read from [twitch] token in " + file;
    return "OAuth token: " + where + (username ? "" : "; no [twitch] username, so chat stays read-only");
  }
  var detail;
  if (!source.configFileFound) {
    /* nothing was readable: the list of candidates is the useful information */
    detail = "no config file was readable; tried " + tried.join(", ");
  } else {
    detail = (presence || "[twitch] token is missing or empty") + " in " + file;
  }
  var readError = triedReadErrors(source);
  if (readError && !source.configFileFound) detail += " - read error: " + readError;
  return "OAuth token: none - chat is read-only (" + detail + ")";
}

function publishPreferencesPageStatus() {
  writePref("status_line", configStatusText());
  writePref("token_status", tokenStatusText());

  var messageFilters = state.filters ? state.filters.message : null;
  var usernameFilters = state.filters ? state.filters.username : null;
  writePref("filters_status",
    "Message filter: " + describeFilter(messageFilters) + " / Username filter: " + describeFilter(usernameFilters));
}

function describeFilter(filter) {
  if (!filter) return "not configured";
  var count = isArray(filter.patterns) ? filter.patterns.length : 0;
  return count + " pattern(s), " + (filter.enabled ? "applied" : "off") + (filter.reversed ? ", reversed" : "");
}

/* -------------------------------------------------------------- HTTP bridge
 *
 * Third-party emote lists are fetched from inside a file:// web view, where a
 * cross-origin fetch is frequently blocked. The plugin script can do HTTP
 * (iina.http + the "network-request" permission), so a web view may ask it to
 * fetch instead:
 *   web view -> plugin : "twt:http-get"    { id, url }
 *   plugin -> web view : "twt:http-result" { id, ok, status, text, error }
 * Only HTTPS URLs whose host is declared in this plugin's allowedDomains are
 * served - it is a bridge for those lists, not an open proxy - and a body is
 * never logged, only its size.
 */
var ALLOWED_HOSTS = [
  /* must mirror "allowedDomains" in Info.json (the plugin cannot read it) */
  /* *.twitch.tv covers api.twitch.tv (Helix) and id.twitch.tv (token validate) */
  "irc-ws.chat.twitch.tv", "*.twitch.tv", "*.jtvnw.net",
  "api.betterttv.net", "cdn.betterttv.net",
  "7tv.io", "api.7tv.app", "cdn.7tv.app",
  "api.frankerfacez.com", "cdn.frankerfacez.com",
  /* opt-in remote history pre-fill (history_remote) */
  "recent-messages.robotty.de"
];
var HTTP_TIMEOUT_MS = 10000;
/* 7TV's per-channel emote set alone can exceed 2 MiB (measured: 2,321,907 B, and
 * truncating it makes the JSON unparseable), so the ceiling is generous. */
var HTTP_MAX_BYTES = 8 * 1024 * 1024;

/* -> the matched host, or null when the URL is not allowed. Wildcards are
 * "<anything>.<suffix>" (so "*.twitch.tv" covers "www.twitch.tv", not
 * "twitch.tv"), mirroring the intent of IINA's allowedDomains. */
function hostAllowed(url) {
  var match = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(String(url || ""));
  if (!match) return null;
  var authority = match[1];
  if (authority.indexOf("@") !== -1) return null;
  var port = /:(\d+)$/.exec(authority);
  if (port && port[1] !== "443") return null;
  var host = authority.replace(/:\d+$/, "").toLowerCase();
  for (var i = 0; i < ALLOWED_HOSTS.length; i++) {
    var pattern = ALLOWED_HOSTS[i].toLowerCase();
    if (pattern.charAt(0) === "*") {
      var suffix = pattern.slice(1);
      if (host.length > suffix.length && host.slice(-suffix.length) === suffix) return host;
    } else if (host === pattern) {
      return host;
    }
  }
  return null;
}

/* ------------------------------------------------------------- twitch api
 *
 * Frozen protocol for the Twitch browsers (the sidebar in this entry, the
 * standalone window in the global entry). The view cannot call the Twitch API
 * itself: the token must not travel into the file:// page, and cross-origin
 * fetches from it are blocked. So the view asks, the plugin calls:
 *   view -> plugin : "twt:twitch-get"    {id, path}      (path, or an absolute url)
 *   plugin -> view : "twt:twitch-result" {id, ok, status, data, error}
 * A path that is not on the allowlist - or an absolute URL that is not this
 * API - is answered with error "blocked" and no request is made. Errors are
 * "no token", "token invalid", "blocked", "timeout", "network",
 * "http <status>" and "invalid json"; `data` is the parsed JSON body.
 *
 * The allowlist, the /oauth2/validate identity cache and the transport
 * discipline live in lib/helix.js, shared with the standalone host; this entry
 * only supplies the HTTP implementation, the resolved token and the view reply.
 */
var helix = helixLib.create({
  http: iina.http,
  token: function () { return state.token && state.token.value; },
  log: log,
  warn: logWarn
});

function twitchGetForWebview(target, request) {
  var id = request && typeof request.id === "string" ? request.id : "";
  if (!id) return;
  function reply(ok, status, data, error) {
    postToWebview(target, MSG.TWITCH_RESULT, {
      id: id,
      ok: !!ok,
      status: status === undefined ? null : status,
      data: data === undefined ? null : data,
      error: error === undefined || error === null ? null : String(error)
    });
  }
  var spec = helixLib.requestSpec(request);
  if (!spec) {
    var raw = request && typeof request.path === "string"
      ? request.path.slice(0, 100)
      : (request && typeof request.url === "string" ? request.url.slice(0, 100) : "");
    logWarn("twitch api: blocked " + (raw || "(no request)"));
    reply(false, null, null, "blocked");
    return;
  }
  helix.request(spec, function (error, status, json) {
    if (error) { reply(false, status === undefined ? null : status, null, error); return; }
    reply(true, status, json, null);
  });
}

/* ------------------------------------------------------------- open a stream
 *
 * Frozen protocol: view -> plugin "twt:open" {url, target}. Only
 * https://twitch.tv (or www.twitch.tv) URLs are accepted. "current" opens the
 * URL in this player window; "new" creates a player window, which only IINA's
 * global entry can do (createPlayerInstance), so the request is forwarded to
 * global.js over the global message hub. Stream resolution is not this plugin's
 * job: yt-dlp/streamlink do it, and a refusal is reported on the OSD.
 */
var OPEN_NEW_PLAYER_MESSAGE = "twt:open-new-player";

/* Per-file mpv options for every load this plugin issues.
 *
 * `vid` is a global mpv option, and IINA saves it (with `aid`) into the URL's
 * watch-later file and applies it again before a file starts. A stream opened
 * while video is off - a stale entry from an earlier session, or IINA's music
 * mode - is then resolved by IINA's yt-dlp plugin as "bestaudio/best" (it reads
 * options/vid), which leaves a black window playing audio. mpv applies these
 * loadfile options after the watch-later file (loadfile.c: mp_load_playback_resume
 * before load_per_file_options), so a stream always starts with its tracks on.
 * `mute` and `volume` stay untouched: those are the user's. */
var STREAM_LOAD_OPTIONS = "vid=auto,aid=auto";

/* The twitch.tv URL rule lives in lib/helix.js so the standalone host validates
 * a twt:open request exactly the same way. */
function twitchOpenUrl(raw) {
  return helixLib.twitchMediaUrl(raw);
}

function openTwitchForWebview(request) {
  var url = twitchOpenUrl(request && request.url);
  if (!url) {
    var raw = request && typeof request.url === "string" ? request.url.slice(0, 100) : "";
    logWarn("open: rejected " + (raw || "(no url)"));
    osd("only https://twitch.tv links can be opened");
    return;
  }
  /* A new window has to go through the global entry (createPlayerInstance) and
   * therefore keeps IINA's own load path - only the current-window target can
   * skip it. */
  if (request && request.target === "new") { openInNewPlayer(url); return; }
  /* mpv's own loadfile replaces the playlist entry directly, so IINA never
   * opens its "Loading media" window (PlayerCore.openMainWindow) and does not
   * touch its title, history or "now playing" bookkeeping for this load. */
  if (attempt(function () { iina.mpv.command("loadfile", [url, "replace", "-1", STREAM_LOAD_OPTIONS]); return true; }, false)) {
    /* No URL hint for the ladder: IINA is not the one loading here, so the
     * requested URL is not evidence that media started - the ladder must wait
     * for what the player actually reports (mpv.path.changed). */
    state.pendingOpen = { url: url, prevToken: currentFileToken(), at: Date.now() };
    osd("opening " + url.replace(/^https:\/\//, ""));
    scheduleFileDecision("twitch-open", null);
    return;
  }
  logWarn("open: mpv refused the loadfile for " + url);
  osd("the URL could not be opened (yt-dlp/streamlink may be needed)");
}

/* The same repair for a load this plugin did not issue: a new player window
 * (createPlayerInstance takes no mpv options) or IINA's own Open URL. One
 * attempt per URL - if the reload does not turn the video on, the ladder must
 * not reload again; the next URL gets its own attempt. */
function repairDisabledVideo(url) {
  if (!url || state.videoRepair === url) return false;
  if (!helixLib.twitchMediaUrl(url)) return false;
  var vid = attempt(function () { return iina.mpv.getString("options/vid"); }, "");
  if (vid !== "no") return false;
  state.videoRepair = url;
  logWarn("video track is disabled for " + url + " (stale watch-later state); reloading with video enabled");
  return attempt(function () {
    iina.mpv.command("loadfile", [url, "replace", "-1", STREAM_LOAD_OPTIONS]);
    return true;
  }, false);
}

/* mpv ended a file. mpv.end-file reaches the plugin without a reason (IINA
 * emits the bare event name), so the outcome is decided a moment later: if the
 * window we asked for is still the pending one and nothing is playing, that
 * load failed. A natural end of playback keeps the media loaded (not idle) and
 * is left alone. */
function onMpvEndFile() {
  if (state.windowGone || !state.pendingOpen) return;
  var pending = state.pendingOpen;
  if (state.loadCheckTimer) clearTimeout(state.loadCheckTimer);
  state.loadCheckTimer = setTimeout(function () {
    state.loadCheckTimer = null;
    checkPendingOpen(pending);
  }, LOAD_FAILURE_GRACE_MS);
}

function checkPendingOpen(pending) {
  if (state.windowGone || state.pendingOpen !== pending) return;   /* superseded */
  state.pendingOpen = null;
  if (!playerIdle()) return;      /* the new media started: the ladder binds it */
  logWarn("open: " + pending.url + " did not load (mpv ended the file and nothing is playing)");
  osd("the URL could not be opened");
  /* never leave the previous stream's chat bound to a stream that did not load */
  if (state.channel) {
    requestLeave("the stream could not be opened");
  } else {
    broadcastSettings();
  }
}

/* IINA's StatusAPI idle flag, with the media token as a fallback. */
function playerIdle() {
  var idle = attempt(function () { return iina.core.status.idle; }, null);
  if (idle === true) return true;
  if (idle === false) return false;
  return !currentFileToken();
}

/* Only the global entry may create a player (JavascriptAPIGlobal
 * .createPlayerInstance); the main entry reaches it through the global message
 * hub. See global.js. */
function openInNewPlayer(url) {
  var api = attempt(function () { return iina.global; }, null);
  if (!api || typeof api.postMessage !== "function") {
    logWarn("open: no global entry in this build; cannot create a player window");
    osd("could not open a new player window");
    return;
  }
  if (!attempt(function () { api.postMessage(OPEN_NEW_PLAYER_MESSAGE, { url: url }); return true; }, false)) {
    logWarn("open: could not ask the global entry for a new player");
    osd("could not open a new player window");
  }
}

/* --------------------------------------------------------- VOD chat replay
 *
 * A finished VOD carries its chat as comments keyed by their offset in the
 * video. Twitch has no official endpoint for that (Helix has none, EventSub and
 * IRC are live only), so this is the undocumented GraphQL call the web player
 * itself makes: POST https://gql.twitch.tv/gql with the public web client id,
 * NO Authorization header, operation VideoCommentsByOffsetOrCursor and a
 * persisted-query sha256 hash. A rejected persisted query is reported by
 * operation name and the replay gives up - it never falls back to sending an
 * arbitrary query text, and never to the live chat, which would show a different
 * conversation.
 *
 * Body (frozen):
 *   {operationName:"VideoCommentsByOffsetOrCursor",
 *    variables:{videoID, contentOffsetSeconds: floor(position)}   // first page
 *    variables:{videoID, cursor:<last edge cursor>}               // later pages
 *    extensions:{persistedQuery:{version:1, sha256Hash}}}
 * Request body option: iina.http.post(url, {headers, data}) - `data` is a plain
 * object because IINA casts it with `as? [String: Any]` (JavascriptAPIHttp
 * .swift); with Content-Type: application/json Just serialises it as the JSON
 * body. A JSON.stringify()ed string would be dropped and send an empty body.
 */

/* -> {videoId, source}; videoId is "" when the media is not a Twitch VOD.
 * A local path or a title that merely contains "videos/<number>" (a YouTube
 * download in ~/videos/123.mp4, say) is not a Twitch VOD, so the match must be
 * Twitch-sourced: the matched value itself, or - for a bare title - a Twitch
 * marker elsewhere in the same media (the same rule detectChannel() uses). */
function detectVodId(urlOverride) {
  var sources = candidateSources();
  if (typeof urlOverride === "string" && urlOverride) sources.unshift({ label: "url", value: urlOverride });
  for (var i = 0; i < sources.length; i++) {
    var match = VOD_PATH_RE.exec(sources[i].value) || VOD_PLAYER_RE.exec(sources[i].value);
    if (!match) continue;
    if (/twitch|ttvnw/i.test(sources[i].value)) return { videoId: match[1], source: sources[i].label };
    if (sources[i].label === "title" || sources[i].label === "mediaTitle") {
      if (twitchMarkerLabel(sources)) return { videoId: match[1], source: sources[i].label };
    }
  }
  return { videoId: "", source: null };
}

/* Playhead in seconds, or null when nothing is playing. */
function vodPosition() {
  var value = attempt(function () { return iina.core.status.position; }, null);
  if (typeof value === "number" && isFinite(value)) return value;
  var raw = attempt(function () { return iina.mpv.getString("time-pos"); }, "");
  if (typeof raw !== "string" || !raw) return null;
  var parsed = Number(raw);
  return isFinite(parsed) ? parsed : null;
}

/* Code point length: Twitch emote indices are code point offsets (see
 * lib/irc.js), and JavaScript strings index UTF-16 code units. */
function vodCodePointLength(str) {
  var count = 0;
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      var next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

function vodAddEmoteRange(emotes, id, start, end) {
  for (var i = 0; i < emotes.length; i++) {
    if (emotes[i].id === id) {
      emotes[i].ranges.push([start, end]);
      return;
    }
  }
  emotes.push({ id: id, ranges: [[start, end]] });
}

function vodAddBadge(badges, name, version) {
  for (var i = 0; i < badges.length; i++) {
    if (badges[i].name === name && badges[i].version === version) return;
  }
  badges.push({ name: name, version: version });
}

/* Decides between live chat and VOD chat replay for the playing media. Called
 * after the channel decision, so `state.channel` is already up to date. */
function updateVodReplay(urlOverride) {
  var found = prefBool("vod_chat_replay", true) ? detectVodId(urlOverride) : { videoId: "" };
  var vod = state.vod;
  if (!found.videoId) {
    if (vod.active) vodStop("the playing media is not a Twitch VOD");
    return;
  }
  if (vod.active && vod.videoId === found.videoId) {
    vod.channel = state.channel || vod.channel;
    return;
  }
  vodStart(found.videoId);
}

/* Stops every timer and invalidates in-flight responses. Deliberately does not
 * touch the overlay or the payloads; vodStop() does that. */
function vodTeardown() {
  var vod = state.vod;
  vod.generation++;
  vod.ownerId = "";
  vod.active = false;
  vod.fetching = false;
  vod.attempts = 0;
  vod.done = false;
  vod.failed = false;
  vod.failureLogged = false;
  vod.lastRequestAt = 0;
  vod.pending.length = 0;
  vod.seen = {};
  vod.seenOrder.length = 0;
  vod.nextOffset = 0;
  vod.error = "";
  vod.stats.pages = 0;
  vod.stats.comments = 0;
  vod.stats.offset = 0;
  vod.bufferedEnd = 0;
  vod.startOffset = 0;
  vod.lastPosition = null;
  clearTimeout(vod.requestTimer);
  vod.requestTimer = null;
  clearInterval(vod.tickTimer);
  vod.tickTimer = null;
}

/* Enters VOD mode: the live chat is suppressed from here on, the overlay is
 * cleared once and the tick starts. Paging starts at the current position. */
function vodStart(videoId) {
  var vod = state.vod;
  vodTeardown();
  vod.videoId = videoId;
  vod.active = true;
  vod.channel = state.channel || null;
  var position = vodPosition();
  vod.startOffset = position === null ? 0 : Math.max(0, Math.floor(position));
  vod.nextOffset = vod.startOffset;
  vod.stats.offset = vod.nextOffset;
  vod.lastPosition = position;
  state.recent.length = 0;
  log("vod replay: watching video " + videoId + " from " + vod.startOffset + "s (undocumented Twitch GQL endpoint)");
  postToOverlay(MSG.CLEAR, { channel: state.channel });
  vod.tickTimer = setInterval(vodPass, VOD_TICK_MS);
  vodScheduleFetch(0);
  /* a VOD replay is a connected chat even when the title named no channel */
  syncOverlayVisibility();
  broadcastSettings();
}

/* Leaves VOD mode: the overlay is cleared once and the live chat may resume. */
function vodStop(reason) {
  var vod = state.vod;
  if (!vod.active) return;
  var videoId = vod.videoId;
  vodTeardown();
  vod.videoId = "";
  vod.channel = null;
  state.recent.length = 0;
  log("vod replay: stopped (" + reason + ")" + (videoId ? " - video " + videoId : ""));
  postToOverlay(MSG.CLEAR, { channel: state.channel });
  /* without a bound channel the replay was the chat: the panel may have to go */
  syncOverlayVisibility();
  broadcastSettings();
}

/* A seek (backwards, or more than VOD_SEEK_FORWARD_SEC forwards) discards the
 * buffer and refetches from the new position; the generation bump drops every
 * response that is still in flight. */
function vodResetTo(position, reason) {
  var vod = state.vod;
  vod.generation++;
  vod.pending.length = 0;
  vod.seen = {};
  vod.seenOrder.length = 0;
  vod.nextOffset = Math.max(0, Math.floor(position));
  vod.stats.offset = vod.nextOffset;
  vod.bufferedEnd = 0;
  vod.startOffset = Math.max(0, Math.floor(position));
  vod.done = false;
  vod.failed = false;
  vod.error = "";
  vod.attempts = 0;
  vod.lastPosition = position;
  clearTimeout(vod.requestTimer);
  vod.requestTimer = null;
  log("vod replay: " + reason + " to " + vod.startOffset + "s, refetching");
  vodScheduleFetch(0);
}

/* One pass: detect a seek, emit what is due and top the buffer up. The 1 s
 * interval calls this, and so does a page the moment it lands, so a fresh page
 * shows without waiting out the tick. */
function vodPass() {
  var vod = state.vod;
  if (!vod.active || !vod.videoId) return;
  vod.channel = state.channel || vod.channel;
  var position = vodPosition();
  if (position === null) return;
  var previous = vod.lastPosition;
  vod.lastPosition = position;
  if (previous !== null &&
      (position < previous - VOD_SEEK_BACK_TOLERANCE_SEC || position > previous + VOD_SEEK_FORWARD_SEC)) {
    vodResetTo(position, "seek");
  }
  vodEmitDue(position);
  vodMaybePrefetch(position);
}

/* Sends every buffered comment whose offset the playhead has reached, in order,
 * through the normal event relay. Emitted comments leave the buffer. */
function vodEmitDue(position) {
  var vod = state.vod;
  var due = 0;
  while (due < vod.pending.length && vod.pending[due].offsetSeconds <= position) due++;
  if (!due) return;
  var batch = vod.pending.splice(0, due);
  /* A replayed comment belongs to the room of the VOD's channel, never to the
   * channel the sidebar happens to be joined to: a room id identifies a chat
   * room, so borrowing the live one would be wrong whenever the VOD is from a
   * different channel. Unknown stays empty. */
  var vodRoomId = state.roomIds[normalizeChannel(state.vod.channel || state.channel || "")] || "";
  for (var i = 0; i < batch.length; i++) {
    batch[i].roomId = vodRoomId;
    state.recent.push(batch[i]);
    while (state.recent.length > RECENT_EVENT_LIMIT) state.recent.shift();
    postToOverlay(MSG.EVENT, { event: batch[i] });
  }
}

/* One request in flight, at most one page buffered more than ~3 pages ahead and
 * only once the playhead is within VOD_FETCH_AHEAD_SEC of the buffered end. */
function vodMaybePrefetch(position) {
  var vod = state.vod;
  if (vod.done || vod.failed || vod.fetching || vod.requestTimer) return;
  if (vod.pending.length >= VOD_PREFETCH_MAX_COMMENTS) return;
  if (vod.bufferedEnd - position >= VOD_FETCH_AHEAD_SEC) return;
  vodScheduleFetch(0);
}

function vodScheduleFetch(delayMs) {
  var vod = state.vod;
  if (!vod.active) return;
  clearTimeout(vod.requestTimer);
  vod.requestTimer = setTimeout(function () {
    vod.requestTimer = null;
    vodSendFetch();
  }, Math.max(0, delayMs || 0));
}

function vodSendFetch() {
  var vod = state.vod;
  if (!vod.active || vod.failed || vod.done || vod.fetching) return;
  var now = Date.now();
  if (vod.lastRequestAt && now - vod.lastRequestAt < VOD_MIN_GAP_MS) {
    vodScheduleFetch(VOD_MIN_GAP_MS - (now - vod.lastRequestAt));
    return;
  }
  var generation = vod.generation;
  vod.fetching = true;
  vod.lastRequestAt = now;
  vodRequest(function (error, status, json) {
    vod.fetching = false;
    /* stale: the window closed, the media changed or a seek reset the replay */
    if (state.vod !== vod || !vod.active || vod.generation !== generation) {
      /* a seek may have reset the replay while this page was in flight: the
       * reset could not start its own request, so re-run the pass for it */
      if (state.vod === vod && vod.active) vodPass();
      return;
    }
    if (error) { vodHandleError(vod, error, status); return; }
    vodAcceptPage(vod, json);
  });
}

/* Offset stepping only: the persisted query's cursor form (and `after`) is
 * rejected with IntegrityCheckFailed even with a client-integrity token, while
 * the offset form works anonymously. Each page starts a few seconds before the
 * requested offset, hence the overlap and the id dedupe. */
function vodRequest(callback) {
  var vod = state.vod;
  vod.stats.offset = vod.nextOffset;
  vodPost({
    operationName: VOD_GQL_OPERATION,
    variables: {
      videoID: vod.videoId,
      contentOffsetSeconds: Math.max(0, Math.floor(vod.nextOffset || 0))
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: VOD_GQL_HASH } }
  }, callback);
}

/* POST JSON to the GQL endpoint. No Authorization header, ever; only the host
 * and the status are logged, never the body or a header. */
function vodPost(body, callback) {
  if (state.windowGone) { callback("network", null, null); return; }
  var http = attempt(function () { return iina.http; }, null);
  var promise = http && typeof http.post === "function"
    ? attempt(function () {
        return http.post(VOD_GQL_URL, {
          headers: { "Client-Id": VOD_GQL_CLIENT_ID, "Content-Type": "application/json" },
          data: body
        });
      }, null)
    : null;
  if (!promise || typeof promise.then !== "function") { callback("network", null, null); return; }
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    callback("timeout", null, null);
  }, VOD_TIMEOUT_MS);
  function finish(error, status, data) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, status, data);
  }
  /* IINA resolves 2xx and rejects every other status with the same dict. */
  function handleResponse(response) {
    if (settled || state.windowGone) return;
    var status = response && typeof response.statusCode === "number" ? response.statusCode : null;
    var text = response && typeof response.text === "string" ? response.text : null;
    if (status === null || text === null) { finish("network", status, null); return; }
    log("vod replay: gql -> " + status);
    if (status < 200 || status >= 300) { finish("http " + status, status, null); return; }
    if (text.length > VOD_MAX_BYTES) { finish("invalid json", status, null); return; }
    var parsed = attempt(function () { return JSON.parse(text); }, null);
    if (parsed === null || typeof parsed !== "object") { finish("invalid json", status, null); return; }
    finish(null, status, parsed);
  }
  promise.then(handleResponse, handleResponse);
}

function vodErrorCode(error) {
  if (error === "timeout") return "timeout";
  if (error === "network") return "network";
  if (error === "invalid json") return "invalid-json";
  var status = /^http (\d+)$/.exec(String(error || ""));
  if (status) return "http-" + status[1];
  return "error";
}

function vodHandleError(vod, error, status) {
  if (error === "http 429") {
    if (vod.attempts < VOD_MAX_ATTEMPTS) {
      var delay = VOD_BACKOFF_MS[Math.min(vod.attempts, VOD_BACKOFF_MS.length - 1)];
      vod.attempts++;
      log("vod replay: rate limited, retrying in " + delay + "ms (retry " + vod.attempts + " of " + VOD_MAX_ATTEMPTS + ")");
      vodScheduleFetch(delay);
      return;
    }
    vodFail(vod, "http-429");
    return;
  }
  vodFail(vod, vodErrorCode(error));
}

/* Give up on this replay: log once, tell the user, show no chat at all. The
 * replay stays in VOD mode so the live chat cannot leak in; a seek retries.
 * `code` is the short reason surfaced in the payload (vodError) so a failure
 * is visible without IINA's log. */
function vodFail(vod, code, detail) {
  if (vod !== state.vod) return;
  vod.failed = true;
  vod.done = true;
  vod.error = code;
  vod.pending.length = 0;
  clearTimeout(vod.requestTimer);
  vod.requestTimer = null;
  if (!vod.failureLogged) {
    vod.failureLogged = true;
    logWarn("vod chat replay unavailable (" + code + (detail ? ": " + detail : "") + ") - no chat is shown for this VOD");
    osd("VOD chat replay unavailable");
    postToOverlay(MSG.CLEAR, { channel: state.channel });
  }
  broadcastSettings();
}

/* The replay reached the end of the VOD's comments (nothing more to page).
 * Buffered comments still get emitted; this is not an error. */
function vodEnd(vod) {
  vod.done = true;
  vod.error = "";
  /* what this last page brought still has to reach the overlay now, not on the
   * next tick */
  vodPass();
  broadcastSettings();
}

function vodDuration() {
  var value = attempt(function () { return iina.core.status.duration; }, null);
  return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
}

function vodRemember(vod, id) {
  if (!id) return;
  vod.seen[id] = true;
  vod.seenOrder.push(id);
  while (vod.seenOrder.length > VOD_SEEN_MAX) {
    var oldest = vod.seenOrder.shift();
    if (oldest !== undefined) delete vod.seen[oldest];
  }
}

function vodAcceptPage(vod, json) {
  if (vod !== state.vod || !vod.active) return;
  vod.attempts = 0;
  var video = json.data ? json.data.video : null;
  var comments = video ? video.comments : null;
  /* The replay's broadcaster id comes from the page itself. It is what the
   * sidebar needs to fetch the channel emote sets when no channel could be
   * detected from the VOD's title (the usual case: a VOD URL carries no login).
   * Set before vodPass() below, so the first emitted row can resolve. */
  if (video && video.creator && typeof video.creator.id === "string" && video.creator.id &&
      vod.ownerId !== video.creator.id) {
    vod.ownerId = video.creator.id;
    log("vod replay: owner " + vod.ownerId);
    broadcastSettings();
  }
  if (json.errors) {
    /* The past-the-end answer is HTTP 200 with errors[].message "service
     * error" and video.comments === null: a normal end of the replay, not a
     * failure. Anything else is the persisted query being rejected. */
    if (!comments && vodIsServiceError(json.errors)) { vodEnd(vod); return; }
    /* Never log the body (it can echo request headers); the operation name is
     * what identifies a rotated persisted query. */
    vodFail(vod, "integrity", "Twitch rejected the " + VOD_GQL_OPERATION + " persisted query");
    return;
  }
  var edges = comments && isArray(comments.edges) ? comments.edges : null;
  if (!edges) {
    vodFail(vod, "no-comments");
    return;
  }
  var requested = vod.nextOffset;
  var lastOffset = vod.bufferedEnd;
  var fresh = 0;
  for (var i = 0; i < edges.length; i++) {
    var edge = edges[i];
    if (!edge) continue;
    var node = edge.node;
    var offset = node && typeof node.contentOffsetSeconds === "number" && isFinite(node.contentOffsetSeconds)
      ? node.contentOffsetSeconds
      : lastOffset;
    if (offset > lastOffset) lastOffset = offset;
    var message = vodMapEdge(vod, node, offset);
    if (!message) continue;
    vod.pending.push(message);
    vodRemember(vod, message.id);
    fresh++;
  }
  vod.stats.pages++;
  vod.stats.comments += fresh;
  vod.bufferedEnd = lastOffset;
  /* emission scans the buffer from the front, so keep it strictly ordered by
   * offset (pages arrive chronologically; this only guards against a surprise) */
  vod.pending.sort(function (a, b) { return a.offsetSeconds - b.offsetSeconds; });

  if (!edges.length || !fresh) {
    /* nothing new: paging further from here would only loop over the overlap */
    vodEnd(vod);
    return;
  }
  var hasNext = !!(comments.pageInfo && comments.pageInfo.hasNextPage);
  if (!hasNext) {
    vodEnd(vod);
    return;
  }
  /* Offset stepping: the next window starts just past the newest comment this
   * page held. Pages begin a few seconds before the requested offset, so the
   * new request overlaps what we already have - the id dedupe absorbs it. */
  var next = Math.max(lastOffset + 1, requested + 1);
  var duration = vodDuration();
  if (duration !== null && next > duration) {
    vodEnd(vod);
    return;
  }
  vod.nextOffset = next;
  /* show what this page brought right away, then keep the buffer topped up */
  vodPass();
}

/* errors[].message === "service error" is Twitch's answer past the last comment. */
function vodIsServiceError(errors) {
  if (!isArray(errors)) return false;
  for (var i = 0; i < errors.length; i++) {
    var error = errors[i];
    if (error && typeof error.message === "string" && /service error/i.test(error.message)) return true;
  }
  return false;
}

/* One GQL edge -> the same shape lib/irc.js emits for a chat message, so the
 * overlay renders a replayed comment like a live one. */
function vodMapEdge(vod, node, offset) {
  if (!node) return null;
  var id = typeof node.id === "string" ? node.id : "";
  if (id && vod.seen[id]) return null;
  var commenter = node.commenter || {};
  var message = node.message || {};
  var fragments = isArray(message.fragments) ? message.fragments : [];
  var text = "";
  var emotes = [];
  for (var i = 0; i < fragments.length; i++) {
    var fragment = fragments[i] || {};
    var piece = typeof fragment.text === "string" ? fragment.text : "";
    var emoteId = fragment.emote && typeof fragment.emote.emoteID === "string" ? fragment.emote.emoteID : "";
    if (emoteId && piece) {
      var start = vodCodePointLength(text);
      text += piece;
      vodAddEmoteRange(emotes, emoteId, start, start + vodCodePointLength(piece) - 1);
    } else {
      text += piece;
    }
  }
  /* The badges live on message.userBadges, not on the fragments (the GQL
   * fragments carry no userBadges at all). */
  var badges = [];
  var sourceBadges = isArray(message.userBadges) ? message.userBadges : [];
  for (var b = 0; b < sourceBadges.length; b++) {
    var badge = sourceBadges[b];
    if (badge && typeof badge.setID === "string") {
      vodAddBadge(badges, badge.setID, typeof badge.version === "string" ? badge.version : "");
    }
  }
  var login = typeof commenter.login === "string" ? commenter.login : "";
  return {
    kind: "message",
    replay: true,
    offsetSeconds: offset,
    id: id,
    userId: typeof commenter.id === "string" ? commenter.id : "",
    login: login,
    displayName: typeof commenter.displayName === "string" && commenter.displayName ? commenter.displayName : login,
    color: typeof message.userColor === "string" && /^#[0-9a-fA-F]{6}$/.test(message.userColor) ? message.userColor : null,
    badges: badges,
    text: text,
    emotes: emotes,
    isAction: false,
    bits: 0,
    channel: state.channel || vod.channel || "",
    roomId: "",
    timestamp: Date.now()
  };
}

/* ------------------------------------------------------------------ history
 *
 * Twitch exposes no official endpoint for recent chat messages (the API
 * reference has only POST /helix/chat/messages for sending, and reading is
 * EventSub/IRC), so the plugin keeps its own per-channel ring buffer and can
 * optionally ask a community service to pre-fill it.
 *
 * Frozen protocol: web view -> plugin `twt:history-request {id, channel, roomId,
 * count}`, plugin -> that view `twt:history-result {id, channel, ok, source,
 * messages, error}`. Messages use the same field names as lib/irc.js
 * `toChatEvent` produces for kind:"message", so the renderer can treat them as
 * ordinary messages. `source` is "cache" or "remote".
 */
/* IINA's require() force-unwraps `pluginInstance.currentFile` (JavascriptPolyfill
 * closure #5), which is nil whenever we are not inside evaluateFile - i.e. in any
 * timer or promise callback. Requiring there traps (SIGTRAP, observed with the
 * remote history path), so the libs are required once at module load and only
 * this already-loaded object is used from callbacks. */
function historyIrc() {
  return ircLib;
}

function normalizeHistoryMessage(event) {
  if (!event) return null;
  return {
    id: typeof event.id === "string" ? event.id : "",
    login: typeof event.login === "string" ? event.login : "",
    displayName: typeof event.displayName === "string" ? event.displayName : "",
    userId: typeof event.userId === "string" ? event.userId : "",
    color: typeof event.color === "string" && event.color ? event.color : null,
    text: typeof event.text === "string" ? event.text : "",
    emotes: isArray(event.emotes) ? event.emotes : [],
    badges: isArray(event.badges) ? event.badges : [],
    timestamp: typeof event.timestamp === "number" && isFinite(event.timestamp) ? event.timestamp : Date.now(),
    isAction: !!event.isAction,
    bits: typeof event.bits === "number" ? event.bits : 0
  };
}

function touchHistoryChannel(channel) {
  var index = state.historyOrder.indexOf(channel);
  if (index !== -1) state.historyOrder.splice(index, 1);
  state.historyOrder.push(channel);
  while (state.historyOrder.length > HISTORY_MAX_CHANNELS) {
    var oldest = state.historyOrder.shift();
    if (oldest !== undefined) delete state.history[oldest];
  }
}

function recordHistoryMessage(event) {
  if (!event || event.kind !== "message" || !event.channel) return;
  var channel = normalizeChannel(event.channel);
  if (!channel) return;
  var message = normalizeHistoryMessage(event);
  if (!message) return;
  var list = state.history[channel] || (state.history[channel] = []);
  list.push(message);
  if (list.length > HISTORY_MAX_PER_CHANNEL) list.splice(0, list.length - HISTORY_MAX_PER_CHANNEL);
  touchHistoryChannel(channel);
  scheduleHistorySave();
}

function historyPayload() {
  /* newest-used channel last; `historyOrder` already is that order */
  var out = { version: 1, channels: {} };
  for (var i = 0; i < state.historyOrder.length; i++) {
    var channel = state.historyOrder[i];
    var list = state.history[channel];
    if (!list || !list.length) continue;
    out.channels[channel] = list;
  }
  return out;
}

function saveHistoryNow() {
  if (state.windowGone) return;
  if (state.historyTimer) { clearTimeout(state.historyTimer); state.historyTimer = null; }
  if (fileDecisionTimer) { clearTimeout(fileDecisionTimer); fileDecisionTimer = null; }
  if (!state.historyLoaded) return;      /* never overwrite what we could not read */
  var json = attempt(function () { return JSON.stringify(historyPayload()); }, null);
  if (!json) return;
  while (json.length > HISTORY_MAX_BYTES && state.historyOrder.length > 1) {
    var oldest = state.historyOrder.shift();
    delete state.history[oldest];
    json = attempt(function () { return JSON.stringify(historyPayload()); }, "");
  }
  var ok = attempt(function () { iina.file.write("@data/history.json", json); return true; }, false);
  if (!ok) logWarn("history cache: could not write @data/history.json");
}

function scheduleHistorySave() {
  if (state.historyTimer) clearTimeout(state.historyTimer);
  state.historyTimer = setTimeout(function () {
    state.historyTimer = null;
    saveHistoryNow();
  }, HISTORY_SAVE_DEBOUNCE_MS);
}

function loadHistory() {
  state.historyLoaded = true;    /* even on failure: writes start from empty */
  var text = readTextFile("@data/history.json");
  if (text === null) return;
  var parsed = attempt(function () { return JSON.parse(text); }, null);
  var channels = parsed && parsed.channels && typeof parsed.channels === "object" ? parsed.channels : null;
  if (!channels) {
    if (!state.historyCorruptLogged) {
      state.historyCorruptLogged = true;
      logWarn("history cache: @data/history.json is unreadable, starting empty");
    }
    return;
  }
  var keys = Object.keys(channels);
  for (var i = 0; i < keys.length; i++) {
    var channel = normalizeChannel(keys[i]);
    var list = channels[keys[i]];
    if (!channel || !isArray(list)) continue;
    var messages = [];
    for (var j = 0; j < list.length && messages.length < HISTORY_MAX_PER_CHANNEL; j++) {
      var message = normalizeHistoryMessage(list[j]);
      if (message) messages.push(message);
    }
    if (!messages.length) continue;
    state.history[channel] = messages;
    state.historyOrder.push(channel);
  }
  while (state.historyOrder.length > HISTORY_MAX_CHANNELS) {
    var dropped = state.historyOrder.shift();
    delete state.history[dropped];
  }
  log("history cache: restored " + state.historyOrder.length + " channel(s) from @data/history.json");
}

function dedupeHistory(messages) {
  var seen = {};
  var out = [];
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    if (!message) continue;
    var key = message.id || (message.login + "|" + message.timestamp + "|" + message.text);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(message);
  }
  return out;
}

/* GET a JSON document with the bridge's discipline: allow-listed host, 10 s
 * timeout, and only the host/status is logged (never a body or a header). */
function httpGetJson(url, headers, callback) {
  if (state.windowGone) { callback("window closed"); return; }
  var host = hostAllowed(url);
  if (!host) { callback("blocked"); return; }
  var http = attempt(function () { return iina.http; }, null);
  var promise = http && typeof http.get === "function"
    ? attempt(function () { return http.get(url, { headers: headers || {} }); }, null)
    : null;
  if (!promise || typeof promise.then !== "function") { callback("http api unavailable"); return; }
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    callback("timeout");
  }, HTTP_TIMEOUT_MS);
  function finish(error, data) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, data);
  }
  promise.then(function (response) {
    if (settled || state.windowGone) return;
    var status = response && typeof response.statusCode === "number" ? response.statusCode : null;
    var text = response && typeof response.text === "string" ? response.text : null;
    if (text !== null && text.length > HTTP_JSON_MAX_BYTES) { finish("response too large"); return; }
    log("twitch api: " + host + " -> " + (status === null ? "?" : status));
    if (status === null || status < 200 || status >= 300 || text === null) { finish("HTTP " + status); return; }
    var parsed = attempt(function () { return JSON.parse(text); }, null);
    if (!parsed) { finish("invalid JSON"); return; }
    finish(null, parsed);
  }, function (error) {
    finish("request failed: " + error);
  });
}

/* Optional, opt-in remote pre-fill. The OAuth token is never sent: the request
 * carries only the public channel login. */
function fetchRemoteHistory(channel, count, callback) {
  var generation = state.historyGeneration;
  var limit = Math.max(1, Math.min(HISTORY_MAX_PER_CHANNEL, count || HISTORY_MAX_PER_CHANNEL));
  var url = HISTORY_REMOTE_URL + encodeURIComponent(channel) +
    "?limit=" + Math.max(1, Math.min(100, limit)) +
    "&hide_moderation_messages=true";
  httpGetJson(url, {}, function (error, json) {
    /* stale (channel switched) or gone: drop the result without touching IINA */
    if (state.windowGone || generation !== state.historyGeneration) return;
    if (error) { callback(error, null); return; }
    if (json && json.error) { callback("service error: " + json.error, null); return; }
    var lines = json && isArray(json.messages) ? json.messages.slice(0, REMOTE_MAX_LINES) : [];
    var lib = historyIrc();
    var messages = [];
    for (var i = 0; i < lines.length; i++) {
      if (typeof lines[i] !== "string" || lines[i].length > 4096) continue;
      var parsed = attempt(function () { return lib.parseMessage(lines[i]); }, null);
      if (!parsed) continue;
      var event = attempt(function () { return lib.toChatEvent(parsed); }, null);
      if (!event || event.kind !== "message") continue;
      event.channel = channel;
      var normalized = normalizeHistoryMessage(event);
      if (normalized && normalized.text.length > REMOTE_MAX_TEXT) normalized.text = normalized.text.slice(0, REMOTE_MAX_TEXT);
      messages.push(normalized);
    }
    messages.sort(function (a, b) { return a.timestamp - b.timestamp; });
    messages = dedupeHistory(messages).slice(-limit);
    if (messages.length > HISTORY_MAX_PER_CHANNEL) messages = messages.slice(-HISTORY_MAX_PER_CHANNEL);
    if (!messages.length) { callback("service returned no messages", null); return; }
    callback(null, messages);
  });
}

function handleHistoryRequest(target, request) {
  var id = request && typeof request.id === "string" ? request.id : "";
  if (!id) return;
  var channel = normalizeChannel(request && request.channel) || state.channel || "";
  /* Recorded before the replay refusal below: a refused live request is still
   * how the plugin learns that channel's room id, which live chat needs after
   * the replay ends. Keyed by channel so it can never leak into a VOD row. */
  if (request && request.roomId && channel) state.roomIds[channel] = String(request.roomId);
  var count = typeof request.count === "number" && isFinite(request.count) ? Math.floor(request.count) : HISTORY_MAX_PER_CHANNEL;
  function reply(ok, source, messages, error) {
    if (state.windowGone) return;
    var payload = {
      id: id,
      channel: channel,
      ok: !!ok,
      source: source || null,
      messages: isArray(messages) ? messages : [],
      error: error === undefined || error === null ? null : String(error)
    };
    postToWebview(target, MSG.HISTORY_RESULT, payload);
    /* the overlay is not allowed to request history (it never sees ROOMSTATE),
     * but it needs the same answer to pre-fill its own list; it dedupes by id */
    if (target !== iina.overlay) postToOverlay(MSG.HISTORY_RESULT, payload);
    log("history: #" + (channel || "?") + " -> " + (ok ? messages.length + " message(s) from " + source : error));
  }
  /* A live backlog is the wrong conversation for a VOD, so it is refused while
   * replay is active for this channel (the overlay shows the replayed chat). */
  if (state.vod.active && (!channel || channel === (state.vod.channel || state.channel))) {
    reply(false, null, [], "vod chat replay active");
    return;
  }
  var cached = channel ? (state.history[channel] || []) : [];
  if (cached.length) {
    touchHistoryChannel(channel);
    reply(true, "cache", dedupeHistory(cached.slice(-HISTORY_MAX_PER_CHANNEL)));
    return;
  }
  if (!prefBool("history_remote", false)) {
    reply(false, null, [], "no cached history");
    return;
  }
  var generation = state.historyGeneration;
  fetchRemoteHistory(channel, count, function (error, messages) {
    if (state.windowGone || generation !== state.historyGeneration) return;
    if (error) { reply(false, null, [], error); return; }
    state.history[channel] = messages.slice(-HISTORY_MAX_PER_CHANNEL);
    touchHistoryChannel(channel);
    scheduleHistorySave();
    reply(true, "remote", messages);
  });
}

function httpGetForWebview(target, request) {
  var id = request && typeof request.id === "string" ? request.id : "";
  if (!id) return;
  function reply(ok, status, text, error) {
    postToWebview(target, MSG.HTTP_RESULT, {
      id: id,
      ok: !!ok,
      status: status === undefined ? null : status,
      text: text === undefined ? null : text,
      error: error === undefined ? null : error
    });
  }
  var url = request && typeof request.url === "string" ? request.url : "";
  var host = hostAllowed(url);
  if (!host) {
    logWarn("http bridge: blocked " + (url ? url.slice(0, 100) : "(no url)"));
    reply(false, null, null, "blocked");
    return;
  }
  var http = attempt(function () { return iina.http; }, null);
  var promise = http && typeof http.get === "function"
    ? attempt(function () { return http.get(url, {}); }, null)
    : null;
  if (!promise || typeof promise.then !== "function") {
    logWarn("http bridge: iina.http is unavailable");
    reply(false, null, null, "http api unavailable");
    return;
  }
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    logWarn("http bridge: timed out after " + HTTP_TIMEOUT_MS + "ms for " + host);
    reply(false, null, null, "timeout");
  }, HTTP_TIMEOUT_MS);
  promise.then(function (response) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    var status = response && typeof response.statusCode === "number" ? response.statusCode : null;
    var body = response && typeof response.text === "string" ? response.text : null;
    if (body !== null && body.length > HTTP_MAX_BYTES) {
      logWarn("http bridge: " + host + " answered " + body.length + " bytes; truncating");
      body = body.slice(0, HTTP_MAX_BYTES);
    }
    var ok = status !== null && status >= 200 && status < 300 && body !== null;
    log("http bridge: " + host + " -> " + (status === null ? "?" : status) +
        (body === null ? "" : " (" + body.length + " bytes)"));
    reply(ok, status, body, ok ? null : (status === null ? "no status" : "HTTP " + status));
  }, function (error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    logWarn("http bridge: " + host + " failed: " + error);
    reply(false, null, null, "request failed");
  });
}

/* ------------------------------------------------------------ sidebar wiring */

/* IINA stores the callbacks registered through onMessage() only as
 * JSManagedValues inside a JavascriptMessageHub, and its
 * callListener(forEvent:withDataString:) dereferences `callback.value.context`
 * with no nil check (JavascriptMessageHub.swift). A managed value whose JS
 * object JavaScriptCore has collected therefore traps the whole app (SIGTRAP,
 * IINA-2026-10-18-200511). The plugin keeps its own strong reference to every
 * callback here - reachable from the module scope, the functions can never be
 * collected while the JS context lives - and re-registering after a loadFile()
 * (which clears IINA's listeners) reuses the same function object instead of
 * creating a new managed value each time. */
var viewHandlers = { sidebar: {}, overlay: {} };

function onViewMessage(owner, name, callback) {
  if (state.windowGone) return;
  var handlers = viewHandlers[owner];
  if (handlers[name] && handlers[name] !== callback) {
    /* a second, different callback for one message would silently never run
     * (IINA replaces the listener, this table keeps the first one): plugin bug */
    logWarn("two different handlers registered for " + name + "; the first one is kept");
  }
  if (!handlers[name]) handlers[name] = callback;
  var view = owner === "overlay" ? iina.overlay : iina.sidebar;
  view.onMessage(name, handlers[name]);
}

function touchSidebar() {
  state.lastSidebarMessage = Date.now();
  /* any message from the view (including the reply to a poke) proves it runs */
  state.pokesWithoutReply = 0;
}

/* The view callbacks are created once per entry and reused by every later
 * registration. IINA clears its listeners on loadFile(), so the plugin
 * re-registers after each load; handing back the same function object keeps the
 * strong JS reference (see onViewMessage) and IINA's managed value stable, and
 * it is what makes a second call to this function a no-op for the views. */
var sidebarHandlerSet = null;

function sidebarHandlers() {
  if (sidebarHandlerSet) return sidebarHandlerSet;
  sidebarHandlerSet = {
    ready: function (data) {
      touchSidebar();
      state.sidebarReady = true;
      rememberPluginRoot(data && data.href);
      log("sidebar ready");
      broadcastSettings();
      replayRecent();
      if (!state.channel) maybeAutoJoin("startup");
    },
    state: function (data) {
      touchSidebar();
      onConnectionState(data);
      postToOverlay(MSG.STATE, withChannelSource(data));
    },
    event: function (data) {
      touchSidebar();
      onSidebarEvent(data);
    },
    /* The sidebar no longer owns the channel: chat is bound to the playing video
     * only, so twt:join/twt:part/twt:say from a view are deliberately ignored
     * (sending has no UI any more). */
    overrides: function (data) {
      touchSidebar();
      if (!data || !data.overrides || typeof data.overrides !== "object") return;
      writeOverrides(data.overrides);
      state.poll.watched = watchedSnapshot();
      reloadConfig(true);
    },
    httpGet: function (data) {
      touchSidebar();
      httpGetForWebview(iina.sidebar, data);
    },
    twitchGet: function (data) {
      touchSidebar();
      twitchGetForWebview(iina.sidebar, data);
    },
    open: function (data) {
      touchSidebar();
      openTwitchForWebview(data);
    },
    historyRequest: function (data) {
      touchSidebar();
      handleHistoryRequest(iina.sidebar, data);
    },
    emotes: function (data) {
      touchSidebar();
      var index = emoteIndexFrom(data);
      if (!index) return;
      state.emoteIndex = index;
      postToOverlay(MSG.EMOTES, { index: index });
    },
    log: function (data) {
      touchSidebar();
      if (data && data.message) log("sidebar: " + data.message);
    }
  };
  return sidebarHandlerSet;
}

function registerSidebarHandlers() {
  if (state.windowGone) return;
  var handlers = sidebarHandlers();
  onViewMessage("sidebar", MSG.READY, handlers.ready);
  onViewMessage("sidebar", MSG.STATE, handlers.state);
  onViewMessage("sidebar", MSG.EVENT, handlers.event);
  onViewMessage("sidebar", MSG.OVERRIDES, handlers.overrides);
  onViewMessage("sidebar", MSG.HTTP_GET, handlers.httpGet);
  onViewMessage("sidebar", MSG.TWITCH_GET, handlers.twitchGet);
  onViewMessage("sidebar", MSG.OPEN, handlers.open);
  onViewMessage("sidebar", MSG.HISTORY_REQUEST, handlers.historyRequest);
  onViewMessage("sidebar", MSG.EMOTES, handlers.emotes);
  onViewMessage("sidebar", MSG.LOG, handlers.log);
}

var overlayHandlerSet = null;

function overlayHandlers() {
  if (overlayHandlerSet) return overlayHandlerSet;
  overlayHandlerSet = {
    ready: function (data) {
      var first = !state.overlayReady;
      state.overlayReady = true;
      clearTimeout(state.overlayRetryTimer);
      state.overlayRetryTimer = null;
      rememberPluginRoot(data && data.href);
      /* Clickable means "let the page decide per element": IINA's overlay
       * hitTest asks window.iina._hitTest only when isClickable is on, and that
       * consults data-clickable. Hidden stays hard click-through. */
      attempt(function () { iina.overlay.setClickable(overlayOnScreen()); });
      deliverOverlayState();
      if (first) log("overlay ready: settings + emotes delivered");
    },
    /* continuous while a drag/resize is in flight (<=1 per 100 ms) plus a final
     * one; the overlay already applied the geometry, so it is stored, never
     * echoed back */
    overlayMoved: function (data) {
      if (!data) return;
      storeOverlayLayout(data.channel || state.channel, data, data.done === true || data.final === true);
    },
    httpGet: function (data) {
      httpGetForWebview(iina.overlay, data);
    },
    historyRequest: function (data) {
      handleHistoryRequest(iina.overlay, data);
    },
    log: function (data) {
      if (data && data.message) log("overlay: " + data.message);
    }
  };
  return overlayHandlerSet;
}

function registerOverlayHandlers() {
  if (state.windowGone) return;
  var handlers = overlayHandlers();
  onViewMessage("overlay", MSG.READY, handlers.ready);
  onViewMessage("overlay", MSG.OVERLAY_MOVED, handlers.overlayMoved);
  onViewMessage("overlay", MSG.HTTP_GET, handlers.httpGet);
  onViewMessage("overlay", MSG.HISTORY_REQUEST, handlers.historyRequest);
  onViewMessage("overlay", MSG.LOG, handlers.log);
}

function rememberPluginRoot(href) {
  if (!href || typeof href !== "string") return;
  var path = attempt(function () { return decodeURIComponent(href.replace(/^file:\/\//, "")); }, null);
  if (!path) return;
  /* .../<plugin>/ui/page.html -> .../<plugin> */
  state.pluginRoot = dirname(dirname(path));
}

function onSidebarEvent(data) {
  var event = data && data.event;
  if (!event) return;
  var eventChannel = normalizeChannel(event.channel);
  /* The ROOMSTATE bookkeeping runs first on purpose: the room id is per
   * channel (state.roomIds) and live chat needs it once the replay ends, while
   * the guard below only stops the live *chat* from reaching the overlay. */
  if (event.roomId && eventChannel) state.roomIds[eventChannel] = String(event.roomId);
  /* A VOD is replaying: its live chat is a different conversation. The socket
   * stays connected (ROOMSTATE/room-id and the emote sets still arrive via
   * twt:state / twt:emotes), but no live message reaches the overlay. */
  if (state.vod.active) return;
  recordHistoryMessage(event);
  state.recent.push(event);
  while (state.recent.length > RECENT_EVENT_LIMIT) state.recent.shift();
  postToOverlay(MSG.EVENT, { event: event });
}

/* The overlay re-renders messages it receives from the backlog, so it needs the
 * emote index as well - cached here and re-posted whenever the overlay (re)builds
 * its renderer. */
function emoteIndexFrom(data) {
  if (!data || typeof data !== "object") return null;
  var index = data.index && typeof data.index === "object" ? data.index : data;
  if (!index || typeof index !== "object") return null;
  /* An empty object is a deliberate clear (the channel changed); null still
   * means "this message carried no index at all". */
  return index;
}

function postEmoteIndexToOverlay() {
  if (!state.emoteIndex) return;
  postToOverlay(MSG.EMOTES, { index: state.emoteIndex });
}

function replayRecent() {
  if (!state.recent.length) return;
  for (var i = 0; i < state.recent.length; i++) {
    /* only the overlay needs the backlog: the sidebar owns the stream */
    postToOverlay(MSG.EVENT, { event: state.recent[i] });
  }
}

function onConnectionState(data) {
  var next = data && typeof data.state === "string" ? data.state : state.connState;
  var info = (data && data.info) || {};
  var previous = state.connState;
  state.connState = next;
  if (next !== previous) {
    if (next === "connected") {
      osd(state.channel ? "connected to #" + state.channel : "connected (no channel joined)");
      if (!state.token.available) osd("read-only mode: no OAuth token configured");
    } else if (next === "reconnecting") {
      osd("connection lost, reconnecting\u2026");
    } else if (next === "closed" || next === "idle") {
      if (previous !== "idle") osd("disconnected");
    }
  }
  if (info.error) {
    osd("error: " + String(info.error).slice(0, 120));
    logWarn("connection error: " + info.error);
  }
}

/* ------------------------------------------------------- overlay layout
 *
 * A layout is anchored and remembered per channel: the preference
 * `overlay_layouts` holds
 * {"version":1,"channels":{"<channel>":{anchor,dx,dy,w,h}, …}} keyed by the
 * joined channel, with "default" for the no-channel case, so "per stream" means
 * per channel. `anchor` is the panel corner tied to the same viewport corner
 * ("tl"/"tr"/"bl"/"br") and dx/dy are the pixel gaps to the anchored viewport
 * edges, so a resized video window keeps the gap; the older {x,y,w,h} form is
 * read as anchor "tl". The overlay reports twt:overlay-moved CONTINUOUSLY while
 * a drag or resize is in flight (at most one report per 100 ms) plus a final
 * one: the plugin clamps every report (w >= 220, h >= 120, dx/dy >= 0 - the
 * overlay clamps inside the video area itself, so a negative or undersized
 * value is a bad payload and never a position to rescue), stores it at once and
 * debounces the preference write by 250 ms, writing immediately for a report
 * that flags the gesture's end. A layout is never echoed back to the overlay.
 * Writes are capped at 50 entries, least-recently-used first out. */

function layoutKeyFor(channel) {
  return normalizeChannel(channel || "") || "default";
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

/* Bounds are the plugin's authority: w >= 220, h >= 120, never a negative
 * coordinate. Anything that is not four finite numbers is not a layout. */
function clampOverlayLayout(layout) {
  if (!layout || typeof layout !== "object") return null;
  var anchor = typeof layout.anchor === "string" && OVERLAY_LAYOUT_ANCHORS[layout.anchor] ? layout.anchor : "tl";
  var dx = isFiniteNumber(layout.dx) ? layout.dx : (isFiniteNumber(layout.x) ? layout.x : null);
  var dy = isFiniteNumber(layout.dy) ? layout.dy : (isFiniteNumber(layout.y) ? layout.y : null);
  if (dx === null || dy === null || !isFiniteNumber(layout.w) || !isFiniteNumber(layout.h)) return null;
  var w = Math.round(layout.w);
  var h = Math.round(layout.h);
  if (w < OVERLAY_LAYOUT_MIN_W) w = OVERLAY_LAYOUT_MIN_W;
  if (h < OVERLAY_LAYOUT_MIN_H) h = OVERLAY_LAYOUT_MIN_H;
  /* the overlay reports geometry that is already inside the video area, so a
   * negative gap or an undersized panel is a bad payload, not a position to
   * rescue: it is clamped to the floor rather than kept "mostly on screen" */
  return { anchor: anchor, dx: Math.max(0, Math.round(dx)), dy: Math.max(0, Math.round(dy)), w: w, h: h };
}

function overlayLayoutFor(channel) {
  return state.overlayLayouts[layoutKeyFor(channel)] || null;
}

function touchOverlayLayout(key) {
  var index = state.overlayLayoutOrder.indexOf(key);
  if (index !== -1) state.overlayLayoutOrder.splice(index, 1);
  state.overlayLayoutOrder.push(key);
}

function pruneOverlayLayouts() {
  while (state.overlayLayoutOrder.length > OVERLAY_LAYOUT_MAX_CHANNELS) {
    var oldest = state.overlayLayoutOrder.shift();
    if (oldest !== undefined) delete state.overlayLayouts[oldest];
  }
}

function overlayLayoutsPayload() {
  /* oldest first, newest used last: the order the LRU prunes from */
  var out = { version: 1, channels: {} };
  for (var i = 0; i < state.overlayLayoutOrder.length; i++) {
    var key = state.overlayLayoutOrder[i];
    if (state.overlayLayouts[key]) out.channels[key] = state.overlayLayouts[key];
  }
  return out;
}

function saveOverlayLayoutsNow() {
  if (state.windowGone) return;
  if (state.overlayLayoutTimer) { clearTimeout(state.overlayLayoutTimer); state.overlayLayoutTimer = null; }
  if (!state.overlayLayoutDirty) return;
  pruneOverlayLayouts();
  var json = attempt(function () { return JSON.stringify(overlayLayoutsPayload()); }, null);
  if (!json) return;
  writePref("overlay_layouts", json);
  state.overlayLayoutDirty = false;
}

function scheduleOverlayLayoutSave() {
  state.overlayLayoutDirty = true;
  if (state.overlayLayoutTimer) clearTimeout(state.overlayLayoutTimer);
  state.overlayLayoutTimer = setTimeout(function () {
    state.overlayLayoutTimer = null;
    saveOverlayLayoutsNow();
  }, OVERLAY_LAYOUT_SAVE_DEBOUNCE_MS);
}

/* Stores a completed drag/resize for `channel` (the overlay's own channel wins,
 * so a late report for the previous channel is not filed under the new one). */
function storeOverlayLayout(channel, layout, finalize) {
  var clamped = clampOverlayLayout(layout);
  if (!clamped) return null;
  var key = layoutKeyFor(channel);
  state.overlayLayouts[key] = clamped;
  touchOverlayLayout(key);
  pruneOverlayLayouts();
  /* the overlay reports continuously while a drag is in flight, so the write is
   * debounced; a report that flags the gesture's end writes right away */
  state.overlayLayoutDirty = true;
  if (finalize) saveOverlayLayoutsNow();
  else scheduleOverlayLayoutSave();
  return clamped;
}

/* A corrupt or absent preference is not an error: log once and start empty. */
function loadOverlayLayouts() {
  var raw = readPrefString("overlay_layouts", "");
  if (!raw) return;
  var parsed = attempt(function () { return JSON.parse(raw); }, null);
  var channels = parsed && parsed.channels && typeof parsed.channels === "object" && !isArray(parsed.channels) ? parsed.channels : null;
  if (!channels) {
    if (!state.overlayLayoutCorruptLogged) {
      state.overlayLayoutCorruptLogged = true;
      logWarn("overlay layout: the overlay_layouts preference is unreadable, starting empty");
    }
    return;
  }
  var keys = Object.keys(channels);
  var restored = 0;
  for (var i = 0; i < keys.length; i++) {
    var clamped = clampOverlayLayout(channels[keys[i]]);
    if (!clamped) continue;
    state.overlayLayouts[keys[i]] = clamped;
    touchOverlayLayout(keys[i]);
    restored++;
  }
  pruneOverlayLayouts();
  if (restored) log("overlay layout: restored " + restored + " channel layout(s)");
}

function overlayLayoutPayload(channel) {
  var forChannel = channel === undefined ? state.channel : channel;
  return {
    channel: forChannel || null,
    layout: overlayLayoutFor(forChannel)
  };
}

function postOverlayLayout(channel) {
  if (!state.overlayLoaded) return;
  postToOverlay(MSG.OVERLAY_LAYOUT, overlayLayoutPayload(channel));
}


/* --------------------------------------------------------------- overlay */

/* A connected chat is the only reason for the overlay to exist: a channel
 * bound to the playing video, or a VOD replay (a VOD URL names only the video,
 * so its channel may be unknown while its replayed chat is real). */
function chatConnected() {
  return !!state.channel || !!state.vod.active;
}

/* `overlay_visible` is the user's wish; show()/hide() follow wish AND chat,
 * which keeps the panel off a non-Twitch video (and off an idle player)
 * without touching the preference: switching back to a Twitch stream brings it
 * back. The view may still be loaded while hidden, so the next stream has it
 * warm. */
function overlayOnScreen() {
  return !state.windowGone && state.overlayVisible && chatConnected();
}

function syncOverlayVisibility() {
  if (state.windowGone) return;
  /* the preference owns the load; the chat owns the display */
  if (state.overlayVisible) ensureOverlayLoaded();
  if (!overlayOnScreen()) {
    attempt(function () { iina.overlay.setClickable(false); });
    attempt(function () { iina.overlay.hide(); });
    return;
  }
  /* show() is a no-op until IINA has the view loaded; the ladder retries */
  attempt(function () { iina.overlay.show(); });
  /* The overlay is interactive while it is visible; the page decides per
   * element through data-clickable, everything else stays click-through. */
  attempt(function () { iina.overlay.setClickable(true); });
  if (state.overlayReady) {
    deliverOverlayState();
  } else {
    scheduleOverlayDelivery(0);
  }
}

function setOverlayVisible(visible) {
  if (state.windowGone) return;
  state.overlayVisible = !!visible;
  writePref("overlay_visible", state.overlayVisible);
  syncOverlayVisibility();
}

function ensureOverlayLoaded() {
  if (state.overlayLoaded || state.windowGone) return;
  if (!state.webviewsLoaded) return;
  /* Same rule as the sidebar: only a loadFile() that returned marks the view as
   * loaded, so a window-less attempt is retried by the next window-loaded (or
   * the next setOverlayVisible) instead of leaving the overlay unloaded. */
  var loaded = attempt(function () {
    iina.overlay.loadFile(OVERLAY_FILE);
    return true;
  }, false);
  if (!loaded) {
    logWarn("no player window yet for the overlay; it loads on the next window-loaded");
    return;
  }
  state.overlayLoaded = true;
  state.overlayReady = false;
  /* overlay.loadFile() clears the plugin side listeners: re-register, but do
   * not post anything yet - see OVERLAY_RETRY_MS. */
  registerOverlayHandlers();
  scheduleOverlayDelivery(0);
}

/* Re-registers the handlers (addListener replaces, so this cannot duplicate a
 * callback) and re-posts what the overlay needs, until it reports ready. */
function scheduleOverlayDelivery(index) {
  if (state.overlayReady || state.windowGone) return;
  if (index >= OVERLAY_RETRY_MS.length) {   /* four rungs, then give up */
    logWarn("the overlay web view never reported ready; its settings and emotes may be missing (toggle the overlay or open the Twitch tab)");
    return;
  }
  var delay = OVERLAY_RETRY_MS[Math.min(index, OVERLAY_RETRY_MS.length - 1)];
  clearTimeout(state.overlayRetryTimer);
  state.overlayRetryTimer = setTimeout(function () {
    state.overlayRetryTimer = null;
    if (state.overlayReady || state.windowGone) return;
    registerOverlayHandlers();
    if (overlayOnScreen()) attempt(function () { iina.overlay.show(); });
    postToOverlay(MSG.SETTINGS, overlaySettingsPayload());
    postEmoteIndexToOverlay();
    postOverlayLayout();
    scheduleOverlayDelivery(index + 1);
  }, delay);
}

/* The overlay is live: hand it the full state, once per ready. */
function deliverOverlayState() {
  postToOverlay(MSG.SETTINGS, overlaySettingsPayload());
  postEmoteIndexToOverlay();
  postToOverlay(MSG.STATE, withChannelSource({ state: state.connState, channel: state.channel, info: {} }));
  replayRecent();
  /* last, so it never races the settings the overlay needs to render first */
  postOverlayLayout();
}

/* ---------------------------------------------------------------- events */

function setupEvents() {
  attempt(function () {
    iina.event.on("iina.window-loaded", onWindowLoaded);
  });
  handshakeTimeout(function () {
    if (state.webviewsLoaded) return;
    logWarn("iina.window-loaded has not arrived yet, loading the web views now");
    loadWebviews();
  }, WINDOW_FALLBACK_MS);

  attempt(function () {
    iina.event.on("iina.file-loaded", function (url) {
      onFileLoaded(url);
    });
  });
  /* mpv.path.changed is the primary rung for a media switch: it fires for any
   * load, including the loadfile path where iina.file-loaded never arrives. */
  attempt(function () {
    iina.event.on("mpv.path.changed", function () {
      cancelAutoOpenBrowser();
      scheduleFileDecision("path-changed", null);
    });
  });
  attempt(function () {
    iina.event.on("mpv.end-file", function () {
      onMpvEndFile();
    });
  });
  attempt(function () {
    iina.event.on("iina.window-will-close", function () {
      onWindowTeardown();
    });
  });
  attempt(function () {
    iina.event.on("iina.window-did-close", function () {
      onWindowTeardown();
    });
  });
}

/* The window is going away: stop everything that could still reach IINA's
 * objects (menus, the sidebar/overlay web views) and persist the history. */
function onWindowTeardown() {
  if (state.windowGone) return;
  saveHistoryNow();
  saveOverlayLayoutsNow();
  log("window closed: timers stopped, history saved");
  state.windowGone = true;
  state.historyGeneration++;
  /* invalidate in-flight GQL responses and stop the replay timers */
  vodTeardown();
  state.vod.videoId = "";
  state.vod.channel = null;
  if (state.poll.timer) { clearInterval(state.poll.timer); state.poll.timer = null; }
  if (state.watchdogTimer) { clearInterval(state.watchdogTimer); state.watchdogTimer = null; }
  if (state.overlayRetryTimer) { clearTimeout(state.overlayRetryTimer); state.overlayRetryTimer = null; }
  if (state.overlayLayoutTimer) { clearTimeout(state.overlayLayoutTimer); state.overlayLayoutTimer = null; }
  /* the overlay never stays clickable after the window is gone */
  attempt(function () { iina.overlay.setClickable(false); });
  if (state.historyTimer) { clearTimeout(state.historyTimer); state.historyTimer = null; }
  if (fileDecisionTimer) { clearTimeout(fileDecisionTimer); fileDecisionTimer = null; }
  if (state.loadCheckTimer) { clearTimeout(state.loadCheckTimer); state.loadCheckTimer = null; }
  state.pendingOpen = null;
  clearHandshakeTimers();
}

/* ------------------------------------------------------- auto_open_browser
 *
 * The preference says "open the standalone browser on IINA startup (if no media
 * is being played)". Startup only: the timer is armed once, from boot, and the
 * request is re-checked when it fires - media that arrived in the meantime wins.
 * The global entry owns the "once per launch" rule and the isOpen() check,
 * because only it survives across player windows (see global.js). */
function armAutoOpenBrowser() {
  if (!state.autoOpenBrowser || state.windowGone) return;
  if (mediaPresent()) {
    log("auto_open_browser: not arming, media is already present");
    return;
  }
  state.autoOpenTimer = handshakeTimeout(fireAutoOpenBrowser, AUTO_OPEN_SETTLE_MS);
}

function cancelAutoOpenBrowser() {
  if (state.autoOpenTimer === null) return;
  clearTimeout(state.autoOpenTimer);
  state.autoOpenTimer = null;
}

function fireAutoOpenBrowser() {
  state.autoOpenTimer = null;
  if (state.windowGone || !state.autoOpenBrowser) return;
  if (mediaPresent()) {
    log("auto_open_browser: media arrived inside the settle window, not opening");
    return;
  }
  if (!attempt(function () {
    iina.global.postMessage(AUTO_OPEN_BROWSER_MESSAGE, {});
    return true;
  }, false)) {
    logWarn("auto_open_browser: no global entry to open the browser window");
    return;
  }
  log("auto_open_browser: asked the global entry for the browser window");
}

/* "no media is being played": the same signals the detection ladder trusts, plus
 * a native open that has been requested but not yet reported. playerIdle() falls
 * back to IINA's status.idle with the media token. */
function mediaPresent() {
  if (state.pendingOpen || state.channel) return true;
  return !playerIdle();
}

function onWindowLoaded() {
  /* Before the web-view guard: IINA re-emits window-loaded when it reuses a
   * cached player window (and our own fallback timer calls this directly), and
   * the refresh is the only repair for a menu that was last built for another
   * window or instance. */
  refreshMenus();
  if (state.windowGone) return;
  loadWebviews();
}

/* Loads the plugin's two web views, exactly once per window.
 *
 * Two states, deliberately kept apart: "the load was attempted" (the retry
 * ladder below, only ever a timer) and "the views are loaded"
 * (state.webviewsLoaded, set only after a loadFile() call returned). The old
 * code folded them together - the launch fallback set webviewsLoaded before its
 * loadFile() threw, so the real iina.window-loaded saw the flag and returned
 * early and the sidebar/overlay were never loaded on a slow launch (16 + 8
 * "called when window is not available" failures in one day of logs).
 *
 * A failed attempt therefore re-arms instead of claiming success, and the real
 * event always performs the load; whichever path loads first wins, because a
 * pending retry finds state.webviewsLoaded true and stops. */
function loadWebviews() {
  if (state.windowGone || state.webviewsLoaded) return false;
  var loaded = attempt(function () {
    iina.sidebar.loadFile(SIDEBAR_FILE);
    return true;
  }, false);
  if (!loaded) {
    state.webviewAttempts++;
    if (state.webviewAttempts <= WEBVIEW_RETRY_MS.length) {
      var delay = WEBVIEW_RETRY_MS[state.webviewAttempts - 1];
      logWarn("no player window yet for the web views (attempt " + state.webviewAttempts + "), retrying in " + delay + "ms");
      handshakeTimeout(loadWebviews, delay);
    } else {
      logWarn("no player window for the web views after " + state.webviewAttempts + " attempts; they load when one appears");
    }
    return false;
  }
  state.webviewsLoaded = true;
  /* sidebar.loadFile() clears the plugin side listeners: register after. */
  registerSidebarHandlers();
  if (state.overlayVisible) ensureOverlayLoaded();
  watchSidebarReadiness();
  startSidebarWatchdog();
  return true;
}

/* Keeps the hidden sidebar web view (and with it the IRC connection) alive. */
function startSidebarWatchdog() {
  state.watchdogTimer = setInterval(function () {
    if (!state.sidebarReady) return;
    if (state.connState !== "connected" && state.connState !== "connecting") return;
    var silent = Date.now() - (state.lastSidebarMessage || 0);
    var limit = overlayOnScreen() ? SIDEBAR_SILENCE_OVERLAY_MS : SIDEBAR_SILENCE_MS;
    if (silent < limit) return;
    state.pokesSent++;
    state.pokesWithoutReply++;
    log("sidebar quiet for " + Math.round(silent / 1000) + "s; poking it (#" + state.pokesSent + ")");
    postToSidebar(MSG.COMMAND, { command: "poke" });
    /* A view that answers each poke is healthy even though it keeps going quiet
     * between pokes (that is WebKit throttling, not a failure), so only count
     * pokes that stay unanswered. */
    if (state.pokesWithoutReply === 3) {
      logWarn("the sidebar web view is not answering pokes - chat may have stopped updating; opening the Twitch tab wakes it");
    }
  }, SIDEBAR_POKE_CHECK_MS);
}

/* The sidebar web view is the only place with a WebSocket, so the whole chat
 * feature depends on its JavaScript context. IINA creates it lazily
 * (JavascriptPluginInstance.sidebarTabView) and only attaches it to the window
 * when the tab is selected (PluginViewController.installView), but
 * sidebar.loadFile() instantiates it and starts the navigation right away, so
 * the transport runs without the tab ever being opened. If the view never
 * reports ready we reload it once and leave a clear message in the log. */
function watchSidebarReadiness() {
  handshakeTimeout(function () {
    if (state.sidebarReady) return;
    logWarn("the sidebar web view has not reported ready - reloading it once (the IRC transport lives there)");
    attempt(function () { iina.sidebar.loadFile(SIDEBAR_FILE); });
    registerSidebarHandlers();
    handshakeTimeout(function () {
      if (!state.sidebarReady) {
        logWarn("the sidebar web view is still not ready: chat cannot connect until the Twitch tab is opened");
      }
    }, SIDEBAR_READY_TIMEOUT_MS);
  }, SIDEBAR_READY_TIMEOUT_MS);
}

/* IINA reports `iina.file-loaded` (and even the URL it carries) before
 * core.status.url and the mpv `path` switch to the new file, so the channel is
 * re-evaluated on a short bounded ladder until the observed media changes. The
 * first join of a session is decided at startup and is not affected. */
var FILE_DECISION_DELAYS = [800, 2500, 5000, 8000];
var fileDecisionTimer = null;
var fileDecisionIndex = 0;
var fileDecisionUrl = "";
var fileDecisionReason = "";

function scheduleFileDecision(reason, url) {
  if (state.windowGone) return;
  if (typeof url === "string" && url) fileDecisionUrl = url;
  fileDecisionReason = reason;
  fileDecisionIndex = 0;
  runFileDecision();
}

function runFileDecision() {
  if (state.windowGone) return;
  if (fileDecisionTimer) clearTimeout(fileDecisionTimer);
  var delay = FILE_DECISION_DELAYS[Math.min(fileDecisionIndex, FILE_DECISION_DELAYS.length - 1)];
  fileDecisionTimer = setTimeout(function () {
    fileDecisionTimer = null;
    if (!state.settings || state.windowGone) return;
    var token = currentFileToken() || fileDecisionUrl;
    if (!token) {
      /* Nothing is playing (a failed load, a stop): no channel may stay bound. */
      if (state.channel) requestLeave("nothing is playing");
      return;
    }
    if (state.videoRepair && state.videoRepair !== token) state.videoRepair = "";
    if (repairDisabledVideo(token)) return;   /* the reload re-arms the ladder */
    var signature = detectionSignature();
    if (token !== state.fileToken || signature !== state.detectionSignature) {
      state.fileToken = token;
      state.detectionSignature = signature;
      maybeAutoJoin(fileDecisionReason, token);
      /* A VOD URL names only the video; its channel comes from the title, which
       * IINA may parse after the URL. While a replay is running, keep the
       * bounded ladder armed so a title that settles later re-runs the decision
       * instead of leaving the previous live channel on the header. */
      if (!state.vod.active) return;
    }
    fileDecisionIndex++;
    if (fileDecisionIndex < FILE_DECISION_DELAYS.length) runFileDecision();
  }, delay);
}

function onFileLoaded(url) {
  cancelAutoOpenBrowser();
  if (!state.settings) return;
  var token = typeof url === "string" ? url : "";
  /* a different file: leave VOD mode at once (the decision below restarts the
   * replay if the new media is a VOD again), then decide once the player settles */
  if (token && token !== state.fileToken) vodStop("the file changed");
  scheduleFileDecision("file-loaded", token);
}

/* ------------------------------------------------------ preference watching
 *
 * The IINA preferences page (ui/preferences.html) can only read and write
 * preferences - it has no postMessage bridge - and preferences are persisted
 * when that page closes. The plugin therefore polls the few keys the page
 * owns and reacts to changes. */

function watchedSnapshot() {
  return {
    configFile: readPrefString("config_file", ""),
    overrides: readPrefString("ui_overrides", ""),
    autoJoin: prefBool("auto_join", true),
    vodChatReplay: prefBool("vod_chat_replay", true)
  };
}

function sameSnapshot(a, b) {
  return a.configFile === b.configFile && a.overrides === b.overrides &&
    a.autoJoin === b.autoJoin && a.vodChatReplay === b.vodChatReplay;
}

function startPreferenceWatch() {
  state.poll.seq = Number(readPref("command_seq", 0)) || 0;
  state.poll.watched = watchedSnapshot();
  state.poll.timer = setInterval(onPreferencePoll, PREF_POLL_MS);
}

function onPreferencePoll() {
  var snapshot = watchedSnapshot();
  var previous = state.poll.watched;
  var seq = Number(readPref("command_seq", 0)) || 0;

  if (!sameSnapshot(snapshot, previous)) {
    state.poll.watched = snapshot;
    onPreferenceChange({
      configFile: snapshot.configFile !== previous.configFile,
      overrides: snapshot.overrides !== previous.overrides,
      autoJoin: snapshot.autoJoin !== previous.autoJoin,
      vodChatReplay: snapshot.vodChatReplay !== previous.vodChatReplay
    });
  }
  if (seq !== state.poll.seq) {
    state.poll.seq = seq;
    handleRequest(readPrefString("command_request", ""));
  }

  var pendingToken = readPrefString("token_input", "");
  if (pendingToken) {
    writePref("token_input", "");
    if (saveTokenToKeychain(pendingToken)) {
      reloadConfig(true);
      osd("OAuth token saved");
    } else {
      osd("could not save the OAuth token");
    }
  }
}

/* A change in the settings page. The channel is decided by the playing video
 * alone, so a config or appearance change never switches it: only toggling
 * auto_join (binds when on, releases when off) re-evaluates the binding, and
 * only vod_chat_replay starts/stops the replay of the playing VOD. */
function onPreferenceChange(changed) {
  reloadConfig(false);
  broadcastSettings();
  if (changed.autoJoin) maybeAutoJoin("preferences");
  if (changed.vodChatReplay) updateVodReplay();
}

function handleRequest(request) {
  switch (request) {
  case "reload-config":
    reloadConfig(true);
    osd(state.configSource && state.configSource.configFileFound ? "configuration reloaded" : "no config file found, using defaults");
    break;
  case "forget-token":
    forgetToken();
    reloadConfig(true);
    osd("OAuth token forgotten");
    break;
  case "open-config-folder":
    onOpenConfigFolder();
    break;
  case "":
    break;
  default:
    logWarn("unknown preference request '" + request + "'");
    break;
  }
}

/* ----------------------------------------------------------------- palette */

/* IINA keys preferences (`.preferences/<identifier>.plist`) and @data by the
 * manifest identifier, so a rename starts this build empty. lib/migrate.js
 * copies the 1.5.0 state once; the identifier and the plugins directory are
 * read back from @data instead of hard-coded. */
function migrateLegacyState() {
  if (!migrateLib || typeof migrateLib.run !== "function") return;
  /* parsePath() only recognises the "@data/" prefix, not a bare "@data"
   * (iina/JavascriptAPI.swift); the trailing slash makes it expand. */
  var data = resolvePath("@data/");
  var pluginsDir = migrateLib.pluginsDirFromDataPath(data);
  var identifier = migrateLib.identifierFromDataPath(data);
  if (!pluginsDir || !identifier) return;
  try {
    var result = migrateLib.run({
      identifier: identifier,
      pluginsDir: pluginsDir,
      preferences: iina.preferences,
      file: iina.file,
      readText: readTextFile
    });
    if (result.status === "migrated") {
      log("migrated " + result.keys + " preference(s) and " + result.files + " data file(s) from " + migrateLib.LEGACY_IDENTIFIER);
    }
  } catch (e) {
    logWarn("preference migration failed: " + e);
  }
}

function boot() {
  log("Twitch v" + VERSION + " loading");
  migrateLegacyState();
  state.overlayVisible = readPref("overlay_visible", false) === true;
  readEnvironment(function () {
    if (state.windowGone) return;
    reloadConfig(false);
    loadHistory();
    loadOverlayLayouts();
    setupMenus();
    setupEvents();
    state.autoOpenBrowser = prefBool("auto_open_browser", false);
    armAutoOpenBrowser();
    startPreferenceWatch();
    log("ready - " + describeConfig());
  });
}

boot();
