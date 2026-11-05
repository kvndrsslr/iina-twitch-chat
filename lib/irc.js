/*
 * lib/irc.js - Twitch IRC wire protocol, message parsing and a small client.
 *
 * Environment: this file must run unchanged in IINA's JavaScriptCore, in
 * Node (CommonJS) and in a WKWebView (plain <script>). It therefore never
 * touches host globals: sockets and timers are injected by the caller.
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.irc = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CHAT_URL = "wss://irc-ws.chat.twitch.tv:443";
  var DEFAULT_URL = CHAT_URL;
  var MAX_PRIVMSG = 500;

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* ---------------------------------------------------------------- tags */

  var TAG_UNESCAPE = {
    "s": " ",
    ":": ";",
    "\\": "\\",
    "\"": "\"",
    "r": "\r",
    "n": "\n"
  };

  function unescapeTagValue(value) {
    return String(value).replace(/\\(.)/g, function (match, ch) {
      return hasOwn(TAG_UNESCAPE, ch) ? TAG_UNESCAPE[ch] : ch;
    });
  }

  var TAG_ESCAPE = {
    "\\": "\\\\",
    ";": "\\:",
    " ": "\\s",
    "\r": "\\r",
    "\n": "\\n",
    "\"": "\\\""
  };

  function escapeTagValue(value) {
    var s = value === null || value === undefined ? "" : String(value);
    return s.replace(/[\\; \r\n"]/g, function (ch) {
      return TAG_ESCAPE[ch];
    });
  }

  /**
   * Parse an IRCv3 tag string. Accepts both "@a=b;c" and "a=b;c".
   * A tag without "=" (or with an empty value) maps to "".
   */
  function parseTags(str) {
    var out = {};
    if (typeof str !== "string" || str === "") return out;
    var s = str.charAt(0) === "@" ? str.slice(1) : str;
    // Tolerate a trailing space left over from splitting the prefix off.
    if (s.charAt(s.length - 1) === " ") s = s.slice(0, -1);
    var parts = s.split(";");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      var eq = part.indexOf("=");
      if (eq === -1) {
        out[part] = "";
      } else {
        out[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- message */

  function parsePrefix(text) {
    var nick = text;
    var user = "";
    var host = "";
    var bang = text.indexOf("!");
    var at;
    if (bang !== -1) {
      nick = text.slice(0, bang);
      var rest = text.slice(bang + 1);
      at = rest.indexOf("@");
      if (at === -1) {
        user = rest;
      } else {
        user = rest.slice(0, at);
        host = rest.slice(at + 1);
      }
    }
    return { nick: nick, user: user, host: host };
  }

  /**
   * Parse one IRC line into {raw, tags, prefix, command, params}.
   * Returns null for empty / whitespace-only input.
   */
  function parseMessage(line) {
    if (typeof line !== "string") return null;
    var rest = line.replace(/[\r\n]+$/, "").replace(/^\s+/, "");
    if (!rest) return null;

    var tags = {};
    var prefix = null;
    var command = "";
    var params = [];

    if (rest.charAt(0) === "@") {
      var sp = rest.indexOf(" ");
      if (sp === -1) {
        tags = parseTags(rest);
        rest = "";
      } else {
        tags = parseTags(rest.slice(0, sp));
        rest = rest.slice(sp + 1).replace(/^\s+/, "");
      }
    }

    if (rest.charAt(0) === ":") {
      var psp = rest.indexOf(" ");
      if (psp === -1) {
        prefix = parsePrefix(rest.slice(1));
        rest = "";
      } else {
        prefix = parsePrefix(rest.slice(1, psp));
        rest = rest.slice(psp + 1).replace(/^\s+/, "");
      }
    }

    if (rest) {
      var csp = rest.indexOf(" ");
      if (csp === -1) {
        command = rest;
        rest = "";
      } else {
        command = rest.slice(0, csp);
        rest = rest.slice(csp + 1).replace(/^\s+/, "");
      }
      if (/^\d+$/.test(command)) {
        // Numerics stay as-is ("001").
      } else {
        command = command.toUpperCase();
      }
    }

    while (rest) {
      if (rest.charAt(0) === ":") {
        params.push(rest.slice(1));
        break;
      }
      var next = rest.indexOf(" ");
      if (next === -1) {
        params.push(rest);
        break;
      }
      params.push(rest.slice(0, next));
      rest = rest.slice(next + 1).replace(/^\s+/, "");
    }

    return { raw: line, tags: tags, prefix: prefix, command: command, params: params };
  }

  /**
   * Split a raw socket chunk into complete IRC lines.
   * Lines end in \r\n or a bare \n; an incomplete trailing line is returned
   * in `rest` so the caller can prepend it to the next chunk.
   */
  function splitLines(chunk) {
    var text = chunk === null || chunk === undefined ? "" : String(chunk);
    var parts = text.split("\n");
    var rest = parts.pop();
    var lines = [];
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i];
      if (line.charAt(line.length - 1) === "\r") line = line.slice(0, -1);
      if (line !== "") lines.push(line);
    }
    return { lines: lines, rest: rest };
  }

  /* ------------------------------------------------------------ events */

  function channelName(value) {
    var s = value === null || value === undefined ? "" : String(value);
    if (s.charAt(0) === "#") s = s.slice(1);
    return s.toLowerCase();
  }

  function parseTimestamp(tags, fallback) {
    var raw = tags["tmi-sent-ts"];
    if (raw === undefined || raw === "") return fallback;
    var n = Number(raw);
    return isFinite(n) ? n : fallback;
  }

  function normalizeColor(raw) {
    if (typeof raw !== "string" || raw === "") return null;
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null;
  }

  function parseBadges(raw) {
    var out = [];
    if (typeof raw !== "string" || raw === "") return out;
    var parts = raw.split(",");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      var slash = part.indexOf("/");
      if (slash === -1) continue;
      out.push({ name: part.slice(0, slash), version: part.slice(slash + 1) });
    }
    return out;
  }

  function hasBadge(badges, name, version) {
    for (var i = 0; i < badges.length; i++) {
      if (badges[i].name === name && badges[i].version === version) return true;
    }
    return false;
  }

  function parseEmotes(raw) {
    var out = [];
    if (typeof raw !== "string" || raw === "") return out;
    var entries = raw.split("/");
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry) continue;
      var colon = entry.indexOf(":");
      if (colon === -1) continue;
      var id = entry.slice(0, colon);
      if (!id) continue;
      var ranges = [];
      var bits = entry.slice(colon + 1).split(",");
      for (var j = 0; j < bits.length; j++) {
        var m = /^(\d+)-(\d+)$/.exec(bits[j]);
        if (m) ranges.push([Number(m[1]), Number(m[2])]);
      }
      out.push({ id: id, ranges: ranges });
    }
    return out;
  }

  // CTCP ACTION wrapper: "\u0001ACTION " (8 code units).
  var ACTION_PREFIX = "\u0001ACTION ";

  function shiftEmotes(emotes, delta) {
    var out = [];
    for (var i = 0; i < emotes.length; i++) {
      var ranges = [];
      for (var j = 0; j < emotes[i].ranges.length; j++) {
        var r = emotes[i].ranges[j];
        var start = r[0] + delta;
        var end = r[1] + delta;
        if (start >= 0) ranges.push([start, end]);
      }
      if (ranges.length) out.push({ id: emotes[i].id, ranges: ranges });
    }
    return out;
  }

  function messageFields(tags, parsed, now) {
    var badges = parseBadges(tags.badges);
    var login = (parsed.prefix && parsed.prefix.nick) || tags.login || "";
    var text = parsed.params.length > 1 ? String(parsed.params[1]) : "";
    var isAction = text.indexOf(ACTION_PREFIX) === 0;
    if (isAction) {
      text = text.slice(ACTION_PREFIX.length);
      if (text.charAt(text.length - 1) === "\u0001") text = text.slice(0, -1);
    }
    var emotes = parseEmotes(tags.emotes);
    if (isAction) emotes = shiftEmotes(emotes, -ACTION_PREFIX.length);
    var bits = Number(tags.bits);
    return {
      id: tags.id || "",
      userId: tags["user-id"] || "",
      login: login,
      displayName: tags["display-name"] || login,
      color: normalizeColor(tags.color),
      badges: badges,
      isMod: tags.mod === "1",
      isSubscriber: tags.subscriber === "1",
      isBroadcaster: hasBadge(badges, "broadcaster", "1"),
      isTurbo: tags.turbo === "1",
      isFirstMessage: tags["first-msg"] === "1",
      text: text,
      // Twitch emote indices are Unicode code point offsets (see Twitch
      // developer forum: https://discuss.dev.twitch.com/t/cant-calculate-offset-from-the-emotes-tag-if-the-message-contains-emojis/28414).
      emotes: emotes,
      bits: isFinite(bits) ? bits : 0,
      isAction: isAction,
      isWhisper: parsed.command === "WHISPER" || tags.whisper === "1" || parsed.params[0] === "*",
      roomId: tags["room-id"] || ""
    };
  }

  /**
   * Convert a parsed IRC message into the plugin's ChatEvent shape.
   * Never throws; unrecognised or malformed commands become kind "other".
   */
  function toChatEvent(parsed, nowMs) {
    if (!parsed || typeof parsed !== "object") return null;
    var now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
    var tags = parsed.tags || {};
    var params = parsed.params || [];
    var command = parsed.command || "";
    var timestamp = parseTimestamp(tags, now);
    var event = {
      kind: "other",
      command: command,
      channel: channelName(params[0]),
      timestamp: timestamp
    };

    try {
      switch (command) {
      case "PRIVMSG":
      case "WHISPER": {
        var msg = messageFields(tags, parsed, now);
        event = {
          kind: "message",
          channel: channelName(params[0]),
          timestamp: timestamp,
          id: msg.id,
          userId: msg.userId,
          login: msg.login,
          displayName: msg.displayName,
          color: msg.color,
          badges: msg.badges,
          isMod: msg.isMod,
          isSubscriber: msg.isSubscriber,
          isBroadcaster: msg.isBroadcaster,
          isTurbo: msg.isTurbo,
          isFirstMessage: msg.isFirstMessage,
          text: msg.text,
          emotes: msg.emotes,
          bits: msg.bits,
          isAction: msg.isAction,
          isWhisper: msg.isWhisper,
          roomId: msg.roomId
        };
        break;
      }
      case "USERNOTICE": {
        var notice = messageFields(tags, parsed, now);
        var raidCount = Number(tags["msg-param-viewerCount"]);
        event = {
          kind: "usernotice",
          channel: channelName(params[0]),
          timestamp: timestamp,
          id: notice.id,
          userId: notice.userId,
          login: tags.login || notice.login,
          displayName: tags["display-name"] || notice.displayName,
          color: notice.color,
          badges: notice.badges,
          isMod: notice.isMod,
          isSubscriber: notice.isSubscriber,
          isBroadcaster: notice.isBroadcaster,
          isTurbo: notice.isTurbo,
          isFirstMessage: notice.isFirstMessage,
          text: notice.text,
          emotes: notice.emotes,
          bits: notice.bits,
          isAction: notice.isAction,
          isWhisper: notice.isWhisper,
          roomId: notice.roomId,
          systemMessage: tags["system-msg"] || "",
          msgId: tags["msg-id"] || "",
          isRaid: tags["msg-id"] === "raid",
          raidCount: isFinite(raidCount) ? raidCount : null
        };
        break;
      }
      case "NOTICE":
        event = {
          kind: "notice",
          channel: channelName(params[0]),
          timestamp: timestamp,
          msgId: tags["msg-id"] || "",
          text: params.length > 1 ? String(params[1]) : ""
        };
        break;
      case "CLEARCHAT": {
        var duration;
        if (tags["ban-duration"] !== undefined && tags["ban-duration"] !== "") {
          var d = Number(tags["ban-duration"]);
          if (isFinite(d)) duration = d;
        }
        event = {
          kind: "clearchat",
          channel: channelName(params[0]),
          timestamp: timestamp,
          bannedUser: params.length > 1 ? String(params[1]) : undefined,
          duration: duration,
          isTimeout: duration !== undefined,
          isPermanent: duration === undefined
        };
        break;
      }
      case "CLEARMSG":
        event = {
          kind: "clearmsg",
          channel: channelName(params[0]),
          timestamp: timestamp,
          id: tags["target-msg-id"] || "",
          login: tags.login || (parsed.prefix && parsed.prefix.nick) || "",
          text: params.length > 1 ? String(params[1]) : ""
        };
        break;
      case "ROOMSTATE":
        event = {
          kind: "roomstate",
          channel: channelName(params[0]),
          timestamp: timestamp,
          roomId: tags["room-id"] || "",
          emoteOnly: tags["emote-only"] === "1",
          // Tag semantics: minutes a user must have followed, -1 when off.
          followersOnly: isFinite(Number(tags["followers-only"])) ? Number(tags["followers-only"]) : -1,
          r9k: tags.r9k === "1",
          slow: isFinite(Number(tags.slow)) ? Number(tags.slow) : 0,
          subsOnly: tags["subs-only"] === "1"
        };
        break;
      case "USERSTATE":
        event = {
          kind: "userstate",
          channel: channelName(params[0]),
          timestamp: timestamp,
          badges: parseBadges(tags.badges),
          color: normalizeColor(tags.color),
          displayName: tags["display-name"] || "",
          login: tags.login || "",
          isMod: tags.mod === "1",
          isSubscriber: tags.subscriber === "1",
          roomId: tags["room-id"] || ""
        };
        break;
      case "RECONNECT":
        event = { kind: "reconnect", channel: "", timestamp: timestamp };
        break;
      case "PING":
      case "PONG":
        event = {
          kind: command === "PING" ? "ping" : "pong",
          channel: "",
          timestamp: timestamp,
          payload: params.length ? String(params[params.length - 1]) : ""
        };
        break;
      case "JOIN":
      case "PART":
        event = {
          kind: command === "JOIN" ? "join" : "part",
          channel: channelName(params[0]),
          timestamp: timestamp,
          login: (parsed.prefix && parsed.prefix.nick) || "",
          reason: command === "PART" && params.length > 1 ? String(params[1]) : ""
        };
        break;
      default:
        event = {
          kind: "other",
          command: command,
          channel: channelName(params[0]),
          timestamp: timestamp
        };
      }
    } catch (err) {
      return { kind: "other", command: command, channel: channelName(params[0]), timestamp: timestamp };
    }

    return event;
  }

  /* ---------------------------------------------------------- formatting */

  var FREE_TEXT_COMMANDS = { PRIVMSG: true, NOTICE: true, WHISPER: true, USERNOTICE: true, QUIT: true, TOPIC: true };

  /**
   * Build an IRC line without CRLF. Tag values are escaped. A ':' is added to
   * a parameter containing a space; the last parameter is also trailing
   * (':' prefixed) when empty, already ':'-prefixed, when the command carries
   * free text (PRIVMSG/NOTICE/WHISPER/USERNOTICE/QUIT/TOPIC), or — for PART —
   * when an explicit reason parameter is present.
   */
  function formatMessage(command, params, tags) {
    var out = "";
    if (tags && typeof tags === "object") {
      var pairs = [];
      for (var key in tags) {
        if (!hasOwn(tags, key)) continue;
        var v = tags[key];
        pairs.push(key + "=" + escapeTagValue(v === null || v === undefined ? "" : v));
      }
      if (pairs.length) out += "@" + pairs.join(";") + " ";
    }
    out += command === null || command === undefined ? "" : String(command);
    var list = params || [];
    var cmd = String(command || "").toUpperCase();
    for (var i = 0; i < list.length; i++) {
      var p = list[i] === null || list[i] === undefined ? "" : String(list[i]);
      var last = i === list.length - 1;
      var freeText = FREE_TEXT_COMMANDS[cmd] === true;
      var partReason = cmd === "PART" && list.length > 1;
      var needsColon = p.indexOf(" ") !== -1 ||
        (last && (p === "" || p.charAt(0) === ":" || freeText || partReason));
      if (needsColon && p.charAt(0) !== ":") p = ":" + p;
      out += " " + p;
    }
    return out;
  }

  /* -------------------------------------------------------------- client */

  function normalizeChannel(channel) {
    var s = channel === null || channel === undefined ? "" : String(channel);
    if (s.charAt(0) === "#") s = s.slice(1);
    return s;
  }

  /**
   * createClient({ url?, socketFactory, now?, setTimer?, clearTimer?, random?,
   *                log?, keepaliveMs? })
   *
   * socketFactory(url) must return a W3C-WebSocket-like object with send,
   * close, readyState and assignable onopen/onmessage/onerror/onclose.
   */
  function createClient(options) {
    options = options || {};
    var socketFactory = options.socketFactory;
    if (typeof socketFactory !== "function") {
      throw new TypeError("createClient requires a socketFactory function");
    }

    var url = options.url || DEFAULT_URL;
    var now = typeof options.now === "function" ? options.now : function () { return Date.now(); };
    var setTimer = typeof options.setTimer === "function" ? options.setTimer : null;
    var clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : null;
    var random = typeof options.random === "function" ? options.random : Math.random;
    var log = typeof options.log === "function" ? options.log : function () {};
    var keepaliveMs = typeof options.keepaliveMs === "number" && options.keepaliveMs > 0 ? options.keepaliveMs : 30000;

    var listeners = {};
    var state = "idle";
    var socket = null;
    var partial = "";
    var queue = [];
    var credentials = { token: null, login: null };
    var currentChannel = "";
    var intentionalClose = false;
    var got001 = false;
    var attempt = 0;
    var reconnectTimer = null;
    var keepaliveTimer = null;
    var pending = null;

    function emit(name) {
      var args = Array.prototype.slice.call(arguments, 1);
      var list = listeners[name];
      if (!list || !list.length) return;
      list = list.slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].apply(null, args);
        } catch (err) {
          log("listener for " + name + " threw: " + err);
        }
      }
    }

    function on(name, fn) {
      if (typeof fn !== "function") return;
      if (!listeners[name]) listeners[name] = [];
      listeners[name].push(fn);
    }

    function off(name, fn) {
      var list = listeners[name];
      if (!list) return;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] === fn) list.splice(i, 1);
      }
    }

    function setState(next, info) {
      state = next;
      emit("state", next, info || {});
    }

    function sendNow(line) {
      if (!socket) return false;
      var rs = socket.readyState;
      if (rs !== undefined && rs !== null && rs !== 1) return false;
      try {
        socket.send(line + "\r\n");
        log(">> " + line);
        return true;
      } catch (err) {
        emit("error", err);
        return false;
      }
    }

    function sendOrQueue(line) {
      if (state === "connected" && socket) return sendNow(line);
      queue.push(line);
      return true;
    }

    function flushQueue() {
      while (queue.length) sendNow(queue.shift());
    }

    function clearTimerHandle(handle) {
      if (handle !== null && handle !== undefined && clearTimer) clearTimer(handle);
      return null;
    }

    function stopKeepalive() {
      keepaliveTimer = clearTimerHandle(keepaliveTimer);
    }

    function stopReconnect() {
      reconnectTimer = clearTimerHandle(reconnectTimer);
    }

    function startKeepalive() {
      stopKeepalive();
      if (!setTimer) return;
      function tick() {
        keepaliveTimer = null;
        if (state !== "connected" || !socket) return;
        sendNow("PING :tmi.twitch.tv");
        keepaliveTimer = setTimer(tick, keepaliveMs);
      }
      keepaliveTimer = setTimer(tick, keepaliveMs);
    }

    function settleConnect(err) {
      if (!pending) return;
      var p = pending;
      pending = null;
      if (err) p.reject(err);
      else p.resolve();
    }

    function handleLine(line) {
      emit("raw", line);
      var parsed = parseMessage(line);
      if (!parsed) return;
      var command = parsed.command;

      if (command === "PING") {
        var payload = parsed.params.length ? parsed.params[parsed.params.length - 1] : "";
        sendNow(payload ? "PONG :" + payload : "PONG");
      }

      if (command === "001") {
        got001 = true;
        attempt = 0;
        setState("connected", {});
        flushQueue();
        startKeepalive();
        settleConnect(null);
      }

      if (command === "RECONNECT") {
        reconnectNow();
        return;
      }

      var event = toChatEvent(parsed, now());
      if (event) {
        emit("event", event);
        if (event.kind === "notice") emit("notice", event);
      }
    }

    function handleClose(sock, info) {
      if (socket !== sock) return;
      socket = null;
      partial = "";
      stopKeepalive();

      if (intentionalClose || state === "closed") {
        setState("closed", { reason: "disconnect" });
        return;
      }

      if (!got001) {
        settleConnect(new Error("Socket closed before IRC welcome (001)"));
        setState("closed", { reason: "closed" });
        return;
      }

      scheduleReconnect(info);
    }

    function onOpen(sock) {
      if (socket !== sock) return;
      sendNow("CAP REQ :twitch.tv/tags twitch.tv/commands");
      if (credentials.token && credentials.login) {
        var token = String(credentials.token);
        if (token.slice(0, 6).toLowerCase() !== "oauth:") token = "oauth:" + token;
        sendNow(formatMessage("PASS", [token]));
        sendNow(formatMessage("NICK", [credentials.login]));
      } else {
        var nick = "justinfan";
        for (var i = 0; i < 5; i++) nick += String(Math.floor(random() * 10));
        sendNow(formatMessage("NICK", [nick]));
      }
      if (currentChannel) sendNow(formatMessage("JOIN", ["#" + currentChannel]));
    }

    function onData(sock, data) {
      if (socket !== sock) return;
      if (data === null || data === undefined) return;
      var chunk = partial + String(data);
      var split = splitLines(chunk);
      partial = split.rest;
      for (var i = 0; i < split.lines.length; i++) handleLine(split.lines[i]);
    }

    function openSocket(reconnecting) {
      var sock;
      try {
        sock = socketFactory(url);
      } catch (err) {
        setState("closed", { error: err, reason: "socket" });
        emit("error", err);
        settleConnect(err);
        return;
      }
      socket = sock;
      sock.onopen = function () { onOpen(sock); };
      sock.onmessage = function (evt) {
        var data = evt && typeof evt === "object" && "data" in evt ? evt.data : evt;
        onData(sock, data);
      };
      sock.onerror = function (err) {
        if (socket !== sock) return;
        var error = err instanceof Error ? err : new Error("WebSocket error");
        emit("error", error);
        if (pending) settleConnect(error);
      };
      sock.onclose = function (info) { handleClose(sock, info || {}); };
      if (reconnecting) setState("reconnecting", { attempt: attempt });
    }

    function scheduleReconnect(info) {
      attempt += 1;
      var delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
      setState("reconnecting", { attempt: attempt, reason: info && info.reason });
      if (!setTimer) return;
      reconnectTimer = setTimer(function () {
        reconnectTimer = null;
        if (state === "closed" || intentionalClose) return;
        openSocket(true);
      }, delay);
    }

    function reconnectNow() {
      stopKeepalive();
      stopReconnect();
      var old = socket;
      socket = null;
      if (old) {
        try {
          old.close();
        } catch (err) {
          log("close during reconnect failed: " + err);
        }
      }
      got001 = false;
      attempt = 0;
      setState("reconnecting", { attempt: 0, reason: "reconnect" });
      openSocket(true);
    }

    function connect(opts) {
      opts = opts || {};
      if (pending) settleConnect(new Error("Superseded by a new connect()"));
      if (socket) {
        var old = socket;
        socket = null;
        try {
          old.close();
        } catch (err) {
          log("close during connect failed: " + err);
        }
      }
      stopKeepalive();
      stopReconnect();
      intentionalClose = false;
      got001 = false;
      attempt = 0;
      partial = "";
      queue = [];
      credentials = {
        token: typeof opts.token === "string" && opts.token ? opts.token : null,
        login: typeof opts.login === "string" && opts.login ? opts.login : null
      };
      if (opts.channel !== undefined && opts.channel !== null) {
        currentChannel = normalizeChannel(opts.channel);
      }
      setState("connecting", {});
      var connectPromise = new Promise(function (resolve, reject) {
        pending = { resolve: resolve, reject: reject };
      });
      openSocket(false);
      return connectPromise;
    }

    function join(channel) {
      var ch = normalizeChannel(channel);
      if (!ch) return false;
      currentChannel = ch;
      return sendOrQueue(formatMessage("JOIN", ["#" + ch]));
    }

    function part(channel, reason) {
      var ch = normalizeChannel(channel) || currentChannel;
      if (!ch) return false;
      var params = ["#" + ch];
      if (reason !== undefined && reason !== null && reason !== "") params.push(String(reason));
      return sendOrQueue(formatMessage("PART", params));
    }

    function say(text) {
      if (!credentials.token || !socket || !currentChannel) return false;
      var body = text === null || text === undefined ? "" : String(text);
      if (!body) return false;
      var action = body.indexOf("/me ") === 0;
      if (action) body = body.slice(4);
      if (!body) return false;

      var chunks = [];
      for (var i = 0; i < body.length; i += MAX_PRIVMSG) {
        chunks.push(body.slice(i, i + MAX_PRIVMSG));
      }
      for (var j = 0; j < chunks.length; j++) {
        var chunk = chunks[j];
        if (action) chunk = "\u0001ACTION " + chunk + "\u0001";
        sendOrQueue(formatMessage("PRIVMSG", ["#" + currentChannel, chunk]));
      }
      return true;
    }

    function ping() {
      if (!socket) return false;
      return sendNow("PING :tmi.twitch.tv");
    }

    function disconnect() {
      intentionalClose = true;
      stopKeepalive();
      stopReconnect();
      queue = [];
      partial = "";
      got001 = false;
      var old = socket;
      socket = null;
      if (old) {
        try {
          old.close();
        } catch (err) {
          log("disconnect close failed: " + err);
        }
      }
      settleConnect(new Error("Disconnected"));
      setState("closed", { reason: "disconnect" });
    }

    return {
      connect: connect,
      join: join,
      part: part,
      say: say,
      ping: ping,
      disconnect: disconnect,
      on: on,
      off: off,
      get state() { return state; }
    };
  }

  return {
    parseTags: parseTags,
    escapeTagValue: escapeTagValue,
    parseMessage: parseMessage,
    splitLines: splitLines,
    toChatEvent: toChatEvent,
    formatMessage: formatMessage,
    createClient: createClient,
    CHAT_URL: CHAT_URL,
    DEFAULT_URL: DEFAULT_URL
  };
});
