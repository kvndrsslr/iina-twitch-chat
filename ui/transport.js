/*
 * ui/transport.js - sidebar web view: the plugin's IRC transport host.
 *
 * The sidebar owns the only WebSocket in the plugin (IINA's plugin script has
 * none), so it owns the IRC client and is the single source of truth for the
 * chat stream. It forwards every state change and chat event to the plugin
 * script, which relays them to the video overlay, which is the only view that
 * renders chat. The sidebar itself is a Twitch browser (ui/browser.js) and a
 * preferences view; it shows no chat text, no composer and no channel switcher.
 */

(function (global) {
  "use strict";

  var proto = global.TwitchProtocol;
  var libs = global.TwitchPlugin || {};
  var irc = libs.irc;
  var emotes = libs.emotes;

  var PALETTES = ["pastel", "vibrant", "warm", "cool"];
  /* Only ping Twitch when the connection has really been idle (a poke is sent
   * more often than the keepalive interval while an overlay is on screen). */
  var KEEPALIVE_IDLE_MS = 25000;
  var CONNECTED_STATES = { connecting: 1, connected: 1, reconnecting: 1 };

  function $(id) {
    return document.getElementById(id);
  }

  function logLine(message) {
    proto.postMessage("twt:log", { message: String(message).slice(0, 300) });
  }

  function normalizeChannel(raw) {
    if (typeof raw !== "string") return "";
    var value = raw.trim();
    if (!value) return "";
    var url = /twitch\.tv\/([a-z0-9_]{1,25})/i.exec(value);
    if (url) value = url[1];
    if (value.charAt(0) === "#") value = value.slice(1);
    value = value.toLowerCase();
    return /^[a-z0-9_]{1,25}$/.test(value) ? value : "";
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  var state = {
    settings: null,
    filters: null,
    overrides: {},
    token: { available: false, source: "none", value: null },
    channel: null,
    channelId: null,
    client: null,
    keepaliveMs: 0,
    connState: "idle",
    connInfo: {},
    autoConnectDone: false,
    localSeq: 0,
    emoteIndex: {},
    /* The global sets and the channel's own sets are kept apart: a channel
     * change must drop only the channel names, while BTTV/7TV/FFZ globals stay
     * for the session (their URLs are never cleared from emoteFetches). */
    emoteGlobalIndex: {},
    emoteChannelIndex: {},
    emoteChannel: "",
    emoteChannelGeneration: 0,
    emoteFetchSeq: 0,
    emoteFetches: {},
    emoteEndpointLog: "",
    historyRoomId: null,
    historyRequestId: null,
    historySeq: 0,
    firstMessageSeen: false,
    lastIrcActivity: 0,
    /* the plugin reports a VOD replay in its settings payload; while it is
     * active the plugin refuses live history (it is the wrong conversation), so
     * the sidebar must not treat "asked once" as done for that room */
    vodReplay: false,
    /* broadcaster id from the replay's GQL page; lets the sidebar fetch the
     * channel emote sets even when no login/ROOMSTATE exists */
    vodOwnerId: null,
    configSource: null,
    configTried: [],
    statusText: "",
    tokenStatusText: "",
    detection: null,
    warnings: []
  };

  function chat() {
    return (state.settings && state.settings.chat) ? state.settings.chat : {};
  }

  function isLive() {
    return state.connState === "connected";
  }

  /* -------------------------------------------------------------- appearance
   *
   * The config (or an override) pins the appearance of the sidebar: the palette
   * drives the accent colour of the browser chrome, and the theme pins light /
   * dark on top of prefers-color-scheme. The overlay applies the same values to
   * its own document through ui/chat-view.js.
   */
  function applyAppearance() {
    var chatSettings = chat();
    var overrides = state.overrides || {};
    var theme = overrides.theme !== undefined && overrides.theme !== null ? overrides.theme : chatSettings.theme;
    var palette = overrides.palette !== undefined && overrides.palette !== null ? overrides.palette : chatSettings.palette;
    var body = document.body;
    if (theme && theme !== "system") body.setAttribute("data-theme", theme);
    else body.removeAttribute("data-theme");
    if (palette && PALETTES.indexOf(palette) !== -1) body.setAttribute("data-palette", palette);
    else body.removeAttribute("data-palette");
  }

  /* -------------------------------------------------------------- rendering */

  function describeState() {
    switch (state.connState) {
    case "connected":
      return state.token.available && state.settings && state.settings.twitch.username
        ? "connected as " + state.settings.twitch.username
        : "connected (read-only)";
    case "connecting":
      return "connecting\u2026";
    case "reconnecting":
      return "reconnecting (attempt " + ((state.connInfo && state.connInfo.attempt) || 1) + ")\u2026";
    case "closed":
      return "disconnected";
    default:
      return "not connected";
    }
  }

  function renderStatus() {
    var dot = $("status-dot");
    var text = $("status-text");
    if (dot) dot.setAttribute("data-state", state.connState);
    if (text) text.textContent = state.channel ? describeState() + " \u00b7 #" + state.channel : describeState();
  }

  function renderConfigSummary() {
    var summary = $("config-summary");
    if (summary) {
      var source = state.configSource || {};
      var parts = [];
      parts.push(state.statusText || (source.configFileFound ? "Config: " + source.configFile : "No config file found"));
      parts.push(state.tokenStatusText || (state.token.available ? "OAuth token: available" : "OAuth token: none"));
      if (source.filtersFound) parts.push("filters.txt loaded");
      if (state.warnings.length) parts.push(state.warnings.length + " config warning(s)");
      summary.textContent = parts.join(" \u00b7 ");
    }
    var filterSummary = $("filter-summary");
    if (filterSummary) {
      var messageFilter = state.filters ? state.filters.message : null;
      var usernameFilter = state.filters ? state.filters.username : null;
      filterSummary.textContent = "Message: " + describeFilter(messageFilter) +
        " \u00b7 Username: " + describeFilter(usernameFilter);
    }
  }

  function describeFilter(filter) {
    if (!filter) return "not configured";
    var count = (filter.patterns || []).length;
    return count + " pattern(s), " + (filter.enabled ? "on" : "off");
  }

  /* ------------------------------------------------------------ the settings
   *
   * The controls carry data-override / data-filter attributes; one generic
   * change handler collects every set value and posts it as the plugin's
   * overrides. Everything defaults to "Use config" (an empty value).
   */

  function overrideControls() {
    return document.querySelectorAll("[data-override]");
  }

  function filterControls() {
    return document.querySelectorAll("[data-filter]");
  }

  function fillSelect(select, values, labels) {
    while (select.firstChild) select.removeChild(select.firstChild);
    for (var i = 0; i < values.length; i++) {
      var option = document.createElement("option");
      option.value = values[i];
      option.textContent = labels ? labels[values[i]] : (values[i] || "Use config");
      select.appendChild(option);
    }
  }

  function initSettings() {
    var boolOptions = ["", "true", "false"];
    var boolLabels = { "": "Use config", "true": "On", "false": "Off" };
    var paletteOptions = [""].concat(PALETTES);
    var themeOptions = ["", "dark", "light", "system"];
    var themeLabels = { "": "Use config", dark: "Dark", light: "Light", system: "System (follow macOS)" };
    var messageControls = overrideControls();
    for (var i = 0; i < messageControls.length; i++) {
      var control = messageControls[i];
      var kind = control.dataset.kind;
      if (kind === "bool") {
        fillSelect(control, boolOptions, boolLabels);
      } else if (control.dataset.override === "palette") {
        fillSelect(control, paletteOptions, null);
      } else if (control.dataset.override === "theme") {
        fillSelect(control, themeOptions, themeLabels);
      }
    }
    var filters = filterControls();
    for (i = 0; i < filters.length; i++) {
      fillSelect(filters[i], boolOptions, boolLabels);
    }
    for (i = 0; i < messageControls.length; i++) {
      messageControls[i].addEventListener("change", onOverrideChanged);
    }
    for (i = 0; i < filters.length; i++) {
      filters[i].addEventListener("change", onOverrideChanged);
    }
  }

  function syncSettings() {
    var overrides = state.overrides || {};
    var controls = overrideControls();
    for (var i = 0; i < controls.length; i++) {
      var key = controls[i].dataset.override;
      var value = overrides[key];
      if (value === undefined || value === null) {
        controls[i].value = "";
      } else if (typeof value === "boolean") {
        controls[i].value = value ? "true" : "false";
      } else {
        controls[i].value = String(value);
      }
    }
    var filters = filterControls();
    var enabled = overrides.filtersEnabled || {};
    for (i = 0; i < filters.length; i++) {
      var filterValue = enabled[filters[i].dataset.filter];
      filters[i].value = typeof filterValue === "boolean" ? (filterValue ? "true" : "false") : "";
    }
  }

  function collectOverrides() {
    var overrides = {};
    var controls = overrideControls();
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      var key = control.dataset.override;
      var raw = control.value;
      if (raw === "") continue;
      if (control.dataset.kind === "bool") {
        overrides[key] = raw === "true";
      } else if (key === "maxMessages" || key === "delay") {
        var number = parseFloat(raw);
        if (isFinite(number) && number >= 0) overrides[key] = number;
      } else {
        overrides[key] = raw;
      }
    }
    var filters = {};
    var hasFilters = false;
    var filterControlsList = filterControls();
    for (i = 0; i < filterControlsList.length; i++) {
      var filterRaw = filterControlsList[i].value;
      if (filterRaw === "") continue;
      filters[filterControlsList[i].dataset.filter] = filterRaw === "true";
      hasFilters = true;
    }
    if (hasFilters) overrides.filtersEnabled = filters;
    return overrides;
  }

  function onOverrideChanged() {
    state.overrides = collectOverrides();
    applyAppearance();
    proto.postMessage("twt:overrides", { overrides: state.overrides });
  }

  /* ------------------------------------------------------------ HTTP GET
   *
   * The sidebar is a file:// web view, so a cross-origin fetch() is at the
   * mercy of CORS: the emote providers do not answer a null origin. The plugin
   * script can do HTTP itself (iina.http, gated by Info.json allowedDomains),
   * so provider payloads are requested through it:
   *   web view -> plugin : "twt:http-get"    {id, url}
   *   plugin -> web view : "twt:http-result" {id, ok, status, text, error}
   * fetch() stays as the fallback (harnesses and plugin builds without the
   * bridge), and the bridge is dropped for the session once it says it cannot
   * serve a URL, so a broken bridge costs one request, not one per provider.
   */
  var HTTP_BRIDGE_TIMEOUT_MS = 8000;
  var httpSeq = 0;
  var httpPending = {};
  var bridgeDisabled = false;

  function bridgeGet(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = "emotes-" + (++httpSeq) + "-" + Date.now();
      var timer = setTimeout(function () {
        delete httpPending[id];
        reject(new Error("no reply within " + timeoutMs + "ms"));
      }, timeoutMs);
      httpPending[id] = function (result) {
        clearTimeout(timer);
        delete httpPending[id];
        if (result && result.ok && typeof result.text === "string") resolve(result);
        else reject(new Error(String((result && (result.error || "HTTP " + result.status)) || "no payload")));
      };
      try {
        proto.postMessage("twt:http-get", { id: id, url: url });
      } catch (error) {
        clearTimeout(timer);
        delete httpPending[id];
        reject(error);
      }
    });
  }

  proto.onMessage("twt:http-result", function (data) {
    if (!data || typeof data.id !== "string") return;
    var settle = httpPending[data.id];
    if (settle) settle(data);
  });

  function fetchDirect(url) {
    return global.fetch(url, { credentials: "omit" }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    });
  }

  /* Payload text for `url`, logging once which path served it. */
  function httpGetText(url, label) {
    var started = Date.now();
    var viaFetch = function (note) {
      return fetchDirect(url).then(function (text) {
        logLine(label + ": fetch() served the payload in " + (Date.now() - started) + "ms" + (note || ""));
        return text;
      });
    };
    if (bridgeDisabled) return viaFetch();
    return bridgeGet(url, HTTP_BRIDGE_TIMEOUT_MS).then(function (result) {
      logLine(label + ": plugin bridge served the payload (HTTP " + result.status + ", " + (Date.now() - started) + "ms)");
      return result.text;
    }).catch(function (bridgeError) {
      /* An answer that says "cannot serve this" disables the bridge; a slow
       * answer (timeout) does not, it only falls back for this URL. */
      var refused = String(bridgeError).indexOf("no reply within") === -1;
      if (refused) bridgeDisabled = true;
      logLine(label + ": plugin bridge failed (" + bridgeError + "), using fetch()");
      return viaFetch(refused ? "; plugin bridge disabled for this session" : "");
    });
  }

  /* ------------------------------------------------------- third party emotes */

  /* The id whose channel emote sets apply. While a VOD replays, the broadcast
   * owner from its GQL page wins (the title may name no channel or the wrong
   * one); otherwise the joined room's id is the authority. */
  function effectiveEmoteChannelId() {
    if (state.vodReplay && state.vodOwnerId) return state.vodOwnerId;
    return state.channelId || state.vodOwnerId || "";
  }

  function thirdPartyURLs() {
    var out = [];
    var channelId = effectiveEmoteChannelId();
    if (!channelId) return out;
    if (chat().betterttvEmotes) out.push({ kind: "bttv", url: emotes.THIRD_PARTY.bttv.global }, { kind: "bttv", url: emotes.THIRD_PARTY.bttv.channel(channelId) });
    if (chat().seventvEmotes) out.push({ kind: "seventv", url: emotes.THIRD_PARTY.seventv.global }, { kind: "seventv", url: emotes.THIRD_PARTY.seventv.channel(channelId) });
    if (chat().frankerfacezEmotes) out.push({ kind: "ffz", url: emotes.THIRD_PARTY.ffz.global }, { kind: "ffz", url: emotes.THIRD_PARTY.ffz.channel(channelId) });
    return out;
  }

  function isGlobalEmoteURL(url) {
    for (var kind in emotes.THIRD_PARTY) {
      if (Object.prototype.hasOwnProperty.call(emotes.THIRD_PARTY, kind) &&
          emotes.THIRD_PARTY[kind].global === url) return true;
    }
    return false;
  }

  /* Forget the one-shot fetch flags for channel URLs only; global URLs and
   * their flags are what keep BTTV/7TV/FFZ globals alive across a switch. */
  function clearChannelEmoteFetches() {
    for (var url in state.emoteFetches) {
      if (!Object.prototype.hasOwnProperty.call(state.emoteFetches, url)) continue;
      if (!isGlobalEmoteURL(url)) delete state.emoteFetches[url];
    }
  }

  function mergedEmoteIndex() {
    var merged = {};
    var key;
    for (key in state.emoteGlobalIndex) {
      if (Object.prototype.hasOwnProperty.call(state.emoteGlobalIndex, key)) merged[key] = state.emoteGlobalIndex[key];
    }
    for (key in state.emoteChannelIndex) {
      if (Object.prototype.hasOwnProperty.call(state.emoteChannelIndex, key)) merged[key] = state.emoteChannelIndex[key];
    }
    return merged;
  }

  function publishEmoteIndex(force) {
    var merged = mergedEmoteIndex();
    var changed = !!force || Object.keys(merged).length !== Object.keys(state.emoteIndex).length;
    if (!changed) {
      for (var name in merged) {
        if (Object.prototype.hasOwnProperty.call(merged, name) && state.emoteIndex[name] !== merged[name]) {
          changed = true;
          break;
        }
      }
    }
    state.emoteIndex = merged;
    if (!changed) return;
    logLine("emote index: " + Object.keys(merged).length + " name(s), " +
      JSON.stringify(merged).length + " bytes; publishing to the plugin and the overlay");
    proto.postMessage("twt:emotes", { index: merged, channelId: state.emoteChannel });
  }

  function refreshThirdPartyEmotes() {
    var channelId = effectiveEmoteChannelId();
    if (channelId !== state.emoteChannel) {
      /* Drop only the previous channel's names and their fetch flags; the
       * globals (and their flags) are never touched, so they survive. */
      state.emoteChannel = channelId;
      state.emoteChannelGeneration++;
      state.emoteChannelIndex = {};
      clearChannelEmoteFetches();
      publishEmoteIndex(true);
    }
    var urls = thirdPartyURLs();
    var signature = (channelId || "?") + " " + urls.map(function (item) { return item.url; }).join(" ");
    if (signature !== state.emoteEndpointLog) {
      state.emoteEndpointLog = signature;
      logLine("third-party emotes: " + urls.length + " endpoint(s) for room " + (channelId || "unknown"));
    }
    for (var i = 0; i < urls.length; i++) {
      fetchEmoteSet(urls[i].kind, urls[i].url);
    }
  }

  function fetchEmoteSet(kind, url) {
    if (state.emoteFetches[url]) return;
    var token = ++state.emoteFetchSeq;
    state.emoteFetches[url] = token;
    var globalSet = isGlobalEmoteURL(url);
    var generation = state.emoteChannelGeneration;
    httpGetText(url, kind + " emotes").then(function (text) {
      try {
        return JSON.parse(text);
      } catch (parseError) {
        /* The plugin bridge caps a body at main.js HTTP_MAX_BYTES (8 MiB), and
         * a body above that is truncated and fails to parse. fetch() is not
         * subject to the cap, so retry there before giving up; the log says
         * which path worked. */
        if (String(parseError).indexOf("Unterminated") === -1) throw parseError;
        logLine(kind + " emotes: bridged payload is truncated (" + text.length + " char(s), " + parseError + "); retrying with fetch()");
        return fetchDirect(url).then(function (direct) {
          logLine(kind + " emotes: fetch() served " + direct.length + " char(s)");
          return JSON.parse(direct);
        });
      }
    }).then(function (json) {
      /* A channel set that landed after the effective id changed belongs to the
       * previous channel: drop it rather than leak its names into this one. */
      if (!globalSet && generation !== state.emoteChannelGeneration) {
        if (state.emoteFetches[url] === token) state.emoteFetches[url] = false;
        return;
      }
      var list = emotes.parseThirdParty(kind, json, state.emoteChannel);
      logLine(kind + " emotes: " + list.length + " entr" + (list.length === 1 ? "y" : "ies") + " from " + url);
      mergeEmotes(list, globalSet ? "global" : "channel");
      if (state.emoteFetches[url] === token) state.emoteFetches[url] = true;
    }).catch(function (error) {
      if (state.emoteFetches[url] === token) state.emoteFetches[url] = false;
      logLine(kind + " emotes unavailable (" + url + "): " + error);
    });
  }

  function mergeEmotes(list, scope) {
    if (!list || !list.length) return;
    var target = scope === "global" ? state.emoteGlobalIndex : state.emoteChannelIndex;
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var emote = list[i];
      if (!emote || !emote.name || !emote.url) continue;
      if (target[emote.name] !== emote.url) {
        target[emote.name] = emote.url;
        changed = true;
      }
    }
    if (changed) publishEmoteIndex(true);
  }

  /* ------------------------------------------------------------- history
   *
   * The last messages of the channel the client just joined are requested from
   * the plugin (it has the API credentials and the cache), one request per room
   * id. The plugin renders them in the overlay; the sidebar only forwards the
   * room id it learns from ROOMSTATE, which the overlay never sees.
   *   web view -> plugin : "twt:history-request" {id, channel, roomId, count}
   */
  var HISTORY_COUNT = 50;

  function requestHistory(roomId, channel) {
    var name = normalizeChannel(channel || state.channel);
    if (!roomId || !name) return;
    if (state.historyRoomId === roomId) return;
    /* While a VOD replay is active the plugin may refuse this request (the live
     * backlog is the wrong conversation for the replay), so a request made now
     * is never remembered as "asked for this room": when the replay ends the
     * sidebar asks again and the overlay - which the plugin cleared - gets its
     * backlog back. */
    if (!state.vodReplay) state.historyRoomId = roomId;
    var id = "history-" + (++state.historySeq) + "-" + Date.now();
    state.historyRequestId = id;
    logLine("history: requesting the last " + HISTORY_COUNT + " message(s) of #" + name + " (room " + roomId + ")");
    proto.postMessage("twt:history-request", {
      id: id,
      channel: name,
      roomId: String(roomId),
      count: HISTORY_COUNT
    });
  }

  /* ------------------------------------------------------------ the client */

  function teardownClient() {
    if (!state.client) return;
    try {
      state.client.disconnect();
    } catch (e) { /* already gone */ }
    state.client = null;
  }

  function ensureClient() {
    var keepalive = (state.settings.twitch.keepaliveTimeoutSeconds || 30) * 1000;
    if (state.client && keepalive === state.keepaliveMs) return state.client;
    teardownClient();
    state.keepaliveMs = keepalive;
    state.client = irc.createClient({
      url: state.settings.twitch.server || irc.CHAT_URL,
      socketFactory: function (url) { return new WebSocket(url); },
      keepaliveMs: keepalive,
      log: function (message) {
        /* the IRC client logs outbound lines, including PASS: redact the token */
        logLine("irc: " + String(message).replace(/PASS\s+oauth:\S+/gi, "PASS oauth:<redacted>"));
      }
    });
    state.client.on("state", onClientState);
    state.client.on("event", onChatEvent);
    state.client.on("notice", onChatEvent);
    state.client.on("error", function (error) {
      logLine("irc error: " + error);
    });
    return state.client;
  }

  function credentialsFor() {
    var username = state.settings ? state.settings.twitch.username : "";
    if (state.token.available && state.token.value && username) {
      return { token: state.token.value, login: username };
    }
    return { token: null, login: null };
  }

  function connect() {
    if (!state.settings) return;
    var client = ensureClient();
    /* lib/irc.js generates its own justinfanNNNNN nick for anonymous
     * connections; credentials are only passed when both parts exist. */
    var credentials = credentialsFor();
    var payload = {};
    if (credentials.token) {
      payload.token = credentials.token;
      payload.login = credentials.login;
    }
    state.credentials = credentials;
    try {
      var result = client.connect(payload);
      if (result && typeof result.catch === "function") {
        result.catch(function (error) {
          logLine("connect failed: " + error);
        });
      }
    } catch (error) {
      logLine("connect failed: " + error);
    }
  }

  /* A token or username arriving (or going away) while a connection exists
   * only takes effect after re-authenticating. */
  function reconnectForCredentials(previous) {
    var credentials = credentialsFor();
    if (credentials.token === previous.token && credentials.login === previous.login) return;
    state.credentials = credentials;
    if (state.connState === "idle" && !state.client) return;
    logLine("credentials changed, reconnecting");
    connect();
  }

  /* The plugin decides which channel the playing stream binds to and tells the
   * sidebar through "twt:join" / "twt:command"; the sidebar never switches
   * channels on its own. Binding never posts back to the plugin. */
  function bindChannel(rawChannel) {
    var channel = normalizeChannel(rawChannel);
    if (!channel) return null;
    var previous = state.channel;
    if (previous && previous !== channel && isLive()) {
      try { state.client.part(previous); } catch (e) { /* ignore */ }
    }
    state.channel = channel;
    state.channelId = null;
    state.historyRoomId = null;
    state.historyRequestId = null;
    state.firstMessageSeen = false;
    if (isLive()) {
      try { state.client.join(channel); } catch (e) { logLine("join failed: " + e); }
    }
    refreshThirdPartyEmotes();
    renderStatus();
    return channel;
  }

  function partChannel(rawChannel) {
    var channel = normalizeChannel(rawChannel) || state.channel;
    if (!channel) return;
    if (isLive()) {
      try { state.client.part(channel); } catch (e) { /* ignore */ }
    }
    if (state.channel === channel) {
      state.channel = null;
      state.channelId = null;
      state.historyRoomId = null;
      state.historyRequestId = null;
    }
    renderStatus();
  }

  /* --------------------------------------------------------------- events */

  function onClientState(next, info) {
    state.connState = next || "idle";
    state.connInfo = info || {};
    if (isLive() && state.channel) {
      try { state.client.join(state.channel); } catch (e) { logLine("join failed: " + e); }
    }
    renderStatus();
    proto.postMessage("twt:state", { state: state.connState, info: state.connInfo, channel: state.channel });
  }

  function onChatEvent(event) {
    if (!event || !event.kind) return;
    state.lastIrcActivity = Date.now();
    var roomId = event.roomId || event.channelId || "";
    if (event.kind === "roomstate" || event.kind === "userstate") {
      if (event.roomId) roomId = event.roomId;
    }
    if (roomId && String(roomId) !== String(state.channelId || "")) {
      state.channelId = String(roomId);
      refreshThirdPartyEmotes();
      requestHistory(state.channelId, event.channel || state.channel);
    }
    if (!state.firstMessageSeen && (event.kind === "message" || event.kind === "usernotice")) {
      state.firstMessageSeen = true;
      logLine("chat is flowing: forwarded the first " + event.kind + " in #" + (event.channel || state.channel || "?"));
    }
    proto.postMessage("twt:event", { event: event });
  }

  /* ------------------------------------------------------------ UI wiring */

  /* The tab strip (and every tab's stack, data and scroll position) is owned
   * by ui/browser.js; the transport only drives the IRC connection and the
   * settings controls. Escape is handled here because it must also work while
   * the Settings tab is active. */

  function wireUI() {
    var reset = $("p-reset");
    if (reset) {
      reset.addEventListener("click", function () {
        state.overrides = {};
        syncSettings();
        applyAppearance();
        proto.postMessage("twt:overrides", { overrides: {} });
      });
    }
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (global.TwitchBrowser && global.TwitchBrowser.onEscape && global.TwitchBrowser.onEscape()) return;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      }
    });
  }

  /* ------------------------------------------------------- plugin messages */

  function onSettings(payload) {
    if (!payload || !payload.settings) return;
    var first = !state.settings;
    var wasReplaying = state.vodReplay;
    var previousCredentials = state.credentials || { token: null, login: null };
    state.settings = payload.settings;
    state.filters = payload.filters || null;
    state.overrides = payload.overrides || {};
    state.token = payload.token || { available: false, source: "none", value: null };
    state.configSource = payload.configSource || null;
    state.configTried = payload.configTried || [];
    state.statusText = payload.statusText || "";
    state.tokenStatusText = payload.tokenStatusText || "";
    state.detection = payload.detection || null;
    state.warnings = payload.warnings || [];
    state.vodReplay = payload.vodReplay === true;
    state.vodOwnerId = typeof payload.vodOwnerId === "string" && payload.vodOwnerId
      ? payload.vodOwnerId : null;

    applyAppearance();
    syncSettings();
    renderConfigSummary();
    renderStatus();
    refreshThirdPartyEmotes();
    if (!first) reconnectForCredentials(previousCredentials);

    var wanted = normalizeChannel(payload.channel || payload.currentChannel || "");
    if (wanted && wanted !== state.channel) {
      bindChannel(wanted);
      if (first && !state.autoConnectDone) {
        state.autoConnectDone = true;
        connect();
      }
    } else if (first && !state.autoConnectDone && state.channel) {
      state.autoConnectDone = true;
      connect();
    }

    /* Replay just ended for a channel that never parted (a VOD of the channel
     * being watched): the live backlog was refused while it replayed, so the
     * "asked once per room" rule would otherwise suppress it forever. */
    if (wasReplaying && !state.vodReplay) {
      state.historyRoomId = null;
      if (state.channelId) requestHistory(state.channelId, state.channel);
    }
  }

  proto.onMessage("twt:settings", onSettings);

  proto.onMessage("twt:join", function (data) {
    if (data && data.channel) bindChannel(data.channel);
  });

  proto.onMessage("twt:part", function (data) {
    partChannel(data && data.channel);
  });

  proto.onMessage("twt:command", function (data) {
    if (!data || typeof data.command !== "string") return;
    switch (data.command) {
    case "connect":
      if (data.channel) bindChannel(data.channel);
      if (!CONNECTED_STATES[state.connState]) connect();
      break;
    case "disconnect":
      if (state.client) {
        try { state.client.disconnect(); } catch (e) { /* ignore */ }
      }
      break;
    case "poke":
      /* The plugin pokes us when the hidden web view looks throttled (WebKit
       * suspends it and withholds socket callbacks): report the state and, only
       * when the connection has been idle, push an IRC keepalive. */
      if (state.client && isLive() && Date.now() - (state.lastIrcActivity || 0) > KEEPALIVE_IDLE_MS) {
        try { state.client.ping(); } catch (e) { /* ignore */ }
      }
      proto.postMessage("twt:state", { state: state.connState, info: state.connInfo, channel: state.channel });
      break;
    default:
      break;
    }
  });

  proto.onMessage("twt:state", function (payload) {
    if (!payload) return;
    state.connState = payload.state || state.connState;
    state.connInfo = payload.info || {};
    renderStatus();
  });

  proto.onMessage("twt:emotes", function (data) {
    if (data && data.index) state.emoteIndex = data.index;
  });

  initSettings();
  wireUI();
  applyAppearance();
  renderStatus();
  proto.postMessage("twt:ready", { href: global.location.href });
})(typeof window !== "undefined" ? window : this);
