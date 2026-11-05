/*
 * lib/config.js - twitch-tui configuration loading and normalisation.
 *
 * Runs unchanged in IINA's JavaScriptCore, Node and a WKWebView. File access
 * and environment are injected; this file never touches fs, path or the OS env.
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.config = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // twitch-tui defaults, verified from
  // https://raw.githubusercontent.com/xithrius/twitch-tui/main/default-config.toml
  // and https://raw.githubusercontent.com/xithrius/twitch-tui/main/src/config/frontend.rs
  // (plus src/config/terminal.rs and src/config/twitch.rs).
  var DEFAULT_SETTINGS = {
    show_datetimes: true,
    datetime_format: "%a %b %e %T %Y",
    username_shown: true,
    palette: "pastel",
    title_shown: true,
    badges: false,
    theme: "dark",
    username_highlight: true,
    twitch_emotes: false,
    betterttv_emotes: false,
    seventv_emotes: false,
    frankerfacez_emotes: false,
    maximum_messages: 500,
    delay: 30,
    server: "wss://eventsub.wss.twitch.tv/ws",
    keepalive_timeout_seconds: 30,
    favorite_channels: []
  };

  // The plugin is a TUI-style companion, so it follows twitch-tui's config
  // layout. CONFIG_DIR is the location this project documents; the real
  // twitch-tui uses `directories::ProjectDirs`, see src/config/persistence.rs.
  var CONFIG_DIR = "~/.config/twt";

  // twitch-tui builds `ProjectDirs::from("com", "twitch-tui", "twt")` (both
  // names lowercased from CARGO_PKG_NAME / CARGO_BIN_NAME) and reads
  // `config_local_dir()`. The `directories` crate documents that on macOS
  // `config_local_dir()` is `$HOME/Library/Application Support/<project_path>`
  // and that `project_path` is `qualifier.organization.application` with
  // spaces replaced by hyphens:
  // https://docs.rs/directories/6.0.0/directories/struct.ProjectDirs.html
  //   ProjectDirs::from("com", "Foo Corp", "Bar App") =>
  //   /Users/Alice/Library/Application Support/com.Foo-Corp.Bar-App
  // Older `directories` releases (2.x) used `$HOME/Library/Preferences/` for
  // `config_dir()`, so that location is probed as a legacy fallback:
  // https://docs.rs/directories/2.0.2/directories/struct.ProjectDirs.html
  // The exact directory name has changed between crate versions, so callers
  // probe every variant instead of guessing one.
  var MACOS_PROJECT_CONFIGS = [
    "~/Library/Application Support/com.twitch-tui.twt/config.toml",
    "~/Library/Preferences/com.twitch-tui.twt/config.toml"
  ];
  var IRC_DEFAULT_SERVER = "wss://irc-ws.chat.twitch.tv:443";
  var PALETTES = ["pastel", "vibrant", "warm", "cool"];
  var THEMES = ["dark", "light"];

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function syntaxError(lineNo, message) {
    return new Error("TOML parse error at line " + lineNo + ": " + message);
  }

  /* -------------------------------------------------------- TOML parsing */

  function stripComment(line) {
    var inBasic = false;
    var inLiteral = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inBasic) {
        if (ch === "\\") i++;
        else if (ch === "\"") inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else if (ch === "\"") {
        inBasic = true;
      } else if (ch === "'") {
        inLiteral = true;
      } else if (ch === "#") {
        return line.slice(0, i);
      }
    }
    return line;
  }

  function findEquals(line, lineNo) {
    var inBasic = false;
    var inLiteral = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inBasic) {
        if (ch === "\\") i++;
        else if (ch === "\"") inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else if (ch === "\"") {
        inBasic = true;
      } else if (ch === "'") {
        inLiteral = true;
      } else if (ch === "=") {
        return i;
      }
    }
    throw syntaxError(lineNo, "expected '='");
  }

  function splitKeyPath(text, lineNo) {
    var parts = [];
    var start = 0;
    var inBasic = false;
    var inLiteral = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inBasic) {
        if (ch === "\\") i++;
        else if (ch === "\"") inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else if (ch === "\"") {
        inBasic = true;
      } else if (ch === "'") {
        inLiteral = true;
      } else if (ch === ".") {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(text.slice(start).trim());
    for (var j = 0; j < parts.length; j++) {
      if (!parts[j]) throw syntaxError(lineNo, "empty key segment");
    }
    return parts;
  }

  function parseBasicString(text, state, lineNo) {
    var out = "";
    var i = state.i + 1;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch === "\"") {
        state.i = i + 1;
        return out;
      }
      if (ch === "\\") {
        var esc = text.charAt(i + 1);
        var simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\" };
        if (hasOwn(simple, esc)) {
          out += simple[esc];
          i += 2;
        } else if (esc === "u") {
          var hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw syntaxError(lineNo, "invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (esc === "U") {
          var hex8 = text.slice(i + 2, i + 10);
          if (!/^[0-9a-fA-F]{8}$/.test(hex8)) throw syntaxError(lineNo, "invalid \\U escape");
          out += String.fromCodePoint(parseInt(hex8, 16));
          i += 10;
        } else {
          throw syntaxError(lineNo, "invalid escape \\" + esc);
        }
      } else {
        out += ch;
        i++;
      }
    }
    throw syntaxError(lineNo, "unterminated string");
  }

  function parseLiteralString(text, state, lineNo) {
    var i = state.i + 1;
    var start = i;
    while (i < text.length) {
      if (text.charAt(i) === "'") {
        state.i = i + 1;
        return text.slice(start, i);
      }
      i++;
    }
    throw syntaxError(lineNo, "unterminated literal string");
  }

  function isDateTimeToken(token) {
    return /^\d{4}-\d{2}-\d{2}/.test(token) || /^\d{2}:\d{2}:\d{2}/.test(token);
  }

  function parseNumberToken(token) {
    var clean = token.replace(/_/g, "");
    if (/^[+-]?0x[0-9a-fA-F]+$/.test(clean)) return parseInt(clean, 16);
    var sign = clean.charAt(0) === "-" ? -1 : 1;
    var unsigned = clean.charAt(0) === "-" || clean.charAt(0) === "+" ? clean.slice(1) : clean;
    if (/^0o[0-7]+$/.test(unsigned)) return sign * parseInt(unsigned.slice(2), 8);
    if (/^0b[01]+$/.test(unsigned)) return sign * parseInt(unsigned.slice(2), 2);
    if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(clean)) return parseInt(clean, 10);
    if (/^[+-]?[0-9]+\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(clean)) return parseFloat(clean);
    if (/^[+-]?[0-9]+[eE][+-]?[0-9]+$/.test(clean)) return parseFloat(clean);
    return undefined;
  }

  function parseValue(text, lineNo) {
    var state = { i: 0 };
    var len = text.length;

    function skipWs() {
      while (state.i < len && /\s/.test(text.charAt(state.i))) state.i++;
    }

    function parseArray() {
      state.i++; // [
      var arr = [];
      skipWs();
      if (text.charAt(state.i) === "]") {
        state.i++;
        return arr;
      }
      while (true) {
        skipWs();
        if (state.i >= len) throw syntaxError(lineNo, "unterminated array");
        arr.push(parseAny());
        skipWs();
        var ch = text.charAt(state.i);
        if (ch === ",") {
          state.i++;
          skipWs();
          if (text.charAt(state.i) === "]") {
            state.i++;
            break;
          }
          continue;
        }
        if (ch === "]") {
          state.i++;
          break;
        }
        throw syntaxError(lineNo, "expected ',' or ']' in array");
      }
      return arr;
    }

    function parseAny() {
      skipWs();
      var ch = text.charAt(state.i);
      if (ch === "\"") return parseBasicString(text, state, lineNo);
      if (ch === "'") return parseLiteralString(text, state, lineNo);
      if (ch === "[") return parseArray();

      var start = state.i;
      while (state.i < len && !/[\s,\]]/.test(text.charAt(state.i))) state.i++;
      var token = text.slice(start, state.i);
      if (!token) throw syntaxError(lineNo, "missing value");
      if (token === "true") return true;
      if (token === "false") return false;
      if (isDateTimeToken(token)) return token; // dates/times stay raw strings
      var num = parseNumberToken(token);
      if (num !== undefined) return num;
      throw syntaxError(lineNo, "invalid value '" + token + "'");
    }

    skipWs();
    if (state.i >= len) throw syntaxError(lineNo, "missing value");
    var value = parseAny();
    skipWs();
    if (state.i < len) throw syntaxError(lineNo, "unexpected trailing characters");
    return value;
  }

  // True when `text` starts an array whose brackets are still open.
  function arrayNeedsMore(text) {
    var i = 0;
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    if (text.charAt(i) !== "[") return false;
    var depth = 0;
    var inBasic = false;
    var inLiteral = false;
    for (; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inBasic) {
        if (ch === "\\") i++;
        else if (ch === "\"") inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else if (ch === "\"") {
        inBasic = true;
      } else if (ch === "'") {
        inLiteral = true;
      } else if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
      }
    }
    return inBasic || inLiteral || depth > 0;
  }

  function unquoteKey(segment, lineNo) {
    if (segment.charAt(0) === "\"" && segment.charAt(segment.length - 1) === "\"") {
      var state = { i: 0 };
      var value = parseBasicString(segment, state, lineNo);
      if (state.i !== segment.length) throw syntaxError(lineNo, "invalid quoted key");
      return value;
    }
    if (segment.charAt(0) === "'" && segment.charAt(segment.length - 1) === "'") {
      return segment.slice(1, -1);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
      throw syntaxError(lineNo, "invalid bare key '" + segment + "'");
    }
    return segment;
  }

  function keyPathFrom(text, lineNo) {
    var rawParts = splitKeyPath(text, lineNo);
    var path = [];
    for (var i = 0; i < rawParts.length; i++) path.push(unquoteKey(rawParts[i], lineNo));
    return path;
  }

  function ensureTable(root, path, lineNo) {
    var node = root;
    for (var i = 0; i < path.length; i++) {
      var key = path[i];
      if (!hasOwn(node, key)) {
        node[key] = {};
      } else if (!isObject(node[key])) {
        if (Array.isArray(node[key])) throw syntaxError(lineNo, "key '" + key + "' is already a value");
        node[key] = {};
      }
      node = node[key];
    }
    return node;
  }

  function assignKey(current, path, value) {
    var node = current;
    for (var i = 0; i < path.length - 1; i++) {
      var key = path[i];
      if (!isObject(node[key])) node[key] = {};
      node = node[key];
    }
    node[path[path.length - 1]] = value;
  }

  /**
   * Parse the TOML subset used by twitch-tui's default config: tables,
   * dotted/quoted keys, basic and literal strings, integers/floats/booleans,
   * multi-line arrays, comments and CRLF. Date/time literals are kept as
   * raw strings. Later duplicate keys win.
   */
  function parseTOML(text) {
    if (typeof text !== "string") throw syntaxError(1, "expected a string");
    var source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var lines = source.split("\n");
    var root = {};
    var current = root;

    for (var n = 0; n < lines.length; n++) {
      var lineNo = n + 1;
      var line = stripComment(lines[n]).trim();
      if (!line) continue;

      if (line.charAt(0) === "[") {
        if (line.charAt(1) === "[") throw syntaxError(lineNo, "array-of-tables is not supported");
        var close = line.lastIndexOf("]");
        if (close === -1 || line.slice(close + 1).trim() !== "") {
          throw syntaxError(lineNo, "invalid table header");
        }
        current = ensureTable(root, keyPathFrom(line.slice(1, close).trim(), lineNo), lineNo);
        continue;
      }

      var eq = findEquals(line, lineNo);
      var keyText = line.slice(0, eq).trim();
      var valueText = line.slice(eq + 1).trim();
      if (!keyText) throw syntaxError(lineNo, "missing key");
      if (!valueText) throw syntaxError(lineNo, "missing value");

      while (arrayNeedsMore(valueText)) {
        n++;
        if (n >= lines.length) throw syntaxError(lineNo, "unterminated array");
        valueText += "\n" + stripComment(lines[n]);
      }

      assignKey(current, keyPathFrom(keyText, lineNo), parseValue(valueText, lineNo));
    }

    return root;
  }

  /* ------------------------------------------------------------ paths */

  function expandTilde(path, home) {
    if (path === "~") return home;
    if (path.indexOf("~/") === 0) return home + path.slice(1);
    return path;
  }

  function dirname(path) {
    var idx = path.lastIndexOf("/");
    if (idx === -1) return ".";
    if (idx === 0) return "/";
    return path.slice(0, idx);
  }

  function addCandidate(list, seen, value, home) {
    if (typeof value !== "string") return;
    var trimmed = value.trim();
    if (!trimmed) return;
    var expanded = expandTilde(trimmed, home);
    if (seen[expanded]) return;
    seen[expanded] = true;
    list.push(expanded);
  }

  /**
   * Ordered candidate list for twitch-tui's config.toml:
   *   1. an explicit config path (the plugin's `--config`-style option)
   *   2. `TWT_CONFIG` (twitch-tui builds it as `<BINARY_NAME>_CONFIG`)
   *   3. `~/.config/twt/config.toml` (this project's documented location)
   *   4. macOS `ProjectDirs` variants for twitch-tui/twt
   *   5. extra paths supplied through the `candidates` option
   *
   * `~` is expanded, empty entries are ignored and duplicates are removed
   * while order is preserved. `configFile` is the first candidate (the
   * fallback path when no file exists), `filtersFile` sits next to it.
   */
  function resolveConfigPaths(opts) {
    opts = opts || {};
    var env = opts.env || {};
    var home = opts.home || env.HOME || "~";
    var seen = Object.create(null);
    var candidates = [];

    addCandidate(candidates, seen, opts.configFile, home);
    addCandidate(candidates, seen, env.TWT_CONFIG, home);
    addCandidate(candidates, seen, CONFIG_DIR + "/config.toml", home);
    for (var i = 0; i < MACOS_PROJECT_CONFIGS.length; i++) {
      addCandidate(candidates, seen, MACOS_PROJECT_CONFIGS[i], home);
    }
    var extra = Array.isArray(opts.candidates) ? opts.candidates : [];
    for (var j = 0; j < extra.length; j++) {
      addCandidate(candidates, seen, extra[j], home);
    }
    if (!candidates.length) {
      addCandidate(candidates, seen, CONFIG_DIR + "/config.toml", home);
    }

    var configFile = candidates[0];
    return {
      configFile: configFile,
      filtersFile: dirname(configFile) + "/filters.txt",
      candidates: candidates
    };
  }

  /**
   * filters.txt semantics: one entry per line, '#' starts a comment line,
   * blank lines are ignored.
   */
  function parseFiltersFile(text) {
    if (typeof text !== "string") return [];
    var lines = text.split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      out.push(line);
    }
    return out;
  }

  /* -------------------------------------------------------- normalise */

  function stringOr(value, fallback) {
    return typeof value === "string" ? value : fallback;
  }

  function boolOr(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function numberOr(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  function stringArray(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (typeof value[i] === "string") out.push(value[i]);
    }
    return out;
  }

  function emptyFilter() {
    return { enabled: false, reversed: false, patterns: [] };
  }

  function normalizeFilters(raw) {
    var fallback = { message: emptyFilter(), username: emptyFilter() };
    if (!isObject(raw)) return fallback;
    var nested = isObject(raw.message) || isObject(raw.username);
    if (!nested) {
      var flat = {
        enabled: raw.enabled === true,
        reversed: raw.reversed === true,
        patterns: []
      };
      return { message: flat, username: { enabled: flat.enabled, reversed: flat.reversed, patterns: [] } };
    }
    function one(cfg) {
      if (!isObject(cfg)) return emptyFilter();
      return {
        enabled: cfg.enabled === true,
        reversed: cfg.reversed === true,
        patterns: Array.isArray(cfg.filters) ? cfg.filters.map(String) : []
      };
    }
    return { message: one(raw.message), username: one(raw.username) };
  }

  /**
   * normalize(toml, {filters?, warnings?}) -> settings consumed by the UI.
   *
   * Accepts both the twitch-tui TOML shape ([twitch]/[terminal]/[frontend])
   * and the flat DEFAULT_SETTINGS shape. Bad enum values fall back to the
   * default and push a warning into opts.warnings when provided.
   */
  function normalize(toml, opts) {
    opts = opts || {};
    var warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
    var raw = isObject(toml) ? toml : {};

    function section(name) {
      return isObject(raw[name]) ? raw[name] : {};
    }
    var twitch = section("twitch");
    var terminal = section("terminal");
    var frontend = section("frontend");

    function pick(obj, key, fallback) {
      if (hasOwn(obj, key)) return obj[key];
      if (hasOwn(raw, key)) return raw[key];
      return fallback;
    }

    function enumOr(value, allowed, key, fallback) {
      if (typeof value === "string" && allowed.indexOf(value.toLowerCase()) !== -1) {
        return value.toLowerCase();
      }
      if (value !== undefined) {
        warnings.push("Invalid " + key + " value '" + String(value) + "', using '" + fallback + "'");
      }
      return fallback;
    }

    var palette = enumOr(pick(frontend, "palette", DEFAULT_SETTINGS.palette), PALETTES, "palette", DEFAULT_SETTINGS.palette);
    var theme = enumOr(pick(frontend, "theme", DEFAULT_SETTINGS.theme), THEMES, "theme", DEFAULT_SETTINGS.theme);

    var configuredServer = pick(twitch, "server", DEFAULT_SETTINGS.server);
    configuredServer = stringOr(configuredServer, DEFAULT_SETTINGS.server);
    var server = IRC_DEFAULT_SERVER;
    if (/^wss?:\/\/irc-ws[\w.-]*/i.test(configuredServer)) {
      server = configuredServer;
    } else {
      warnings.push(
        "Configured server '" + configuredServer + "' is not an irc-ws endpoint; " +
        "using '" + IRC_DEFAULT_SERVER + "' (EventSub uses a different protocol)"
      );
    }

    var tokenValue = pick(twitch, "token", null);
    var token = typeof tokenValue === "string" && tokenValue !== "" ? tokenValue : null;

    var configuredChannel = stringOr(pick(twitch, "channel", ""), "");
    if (configuredChannel.charAt(0) === "#") configuredChannel = configuredChannel.slice(1);

    var keepalive = numberOr(pick(twitch, "keepalive_timeout_seconds", DEFAULT_SETTINGS.keepalive_timeout_seconds), DEFAULT_SETTINGS.keepalive_timeout_seconds);
    if (keepalive <= 0) keepalive = DEFAULT_SETTINGS.keepalive_timeout_seconds;

    var maxMessages = numberOr(pick(terminal, "maximum_messages", DEFAULT_SETTINGS.maximum_messages), DEFAULT_SETTINGS.maximum_messages);
    if (maxMessages <= 0) maxMessages = DEFAULT_SETTINGS.maximum_messages;

    var filters = opts.filters ? opts.filters : normalizeFilters(raw.filters);

    return {
      twitch: {
        username: stringOr(pick(twitch, "username", ""), ""),
        channel: configuredChannel.toLowerCase(),
        server: server,
        token: token,
        keepaliveTimeoutSeconds: keepalive
      },
      chat: {
        maxMessages: maxMessages,
        delay: numberOr(pick(terminal, "delay", DEFAULT_SETTINGS.delay), DEFAULT_SETTINGS.delay),
        showDatetimes: boolOr(pick(frontend, "show_datetimes", DEFAULT_SETTINGS.show_datetimes), DEFAULT_SETTINGS.show_datetimes),
        datetimeFormat: stringOr(pick(frontend, "datetime_format", DEFAULT_SETTINGS.datetime_format), DEFAULT_SETTINGS.datetime_format),
        usernameShown: boolOr(pick(frontend, "username_shown", DEFAULT_SETTINGS.username_shown), DEFAULT_SETTINGS.username_shown),
        palette: palette,
        titleShown: boolOr(pick(frontend, "title_shown", DEFAULT_SETTINGS.title_shown), DEFAULT_SETTINGS.title_shown),
        badges: boolOr(pick(frontend, "badges", DEFAULT_SETTINGS.badges), DEFAULT_SETTINGS.badges),
        theme: theme,
        usernameHighlight: boolOr(pick(frontend, "username_highlight", DEFAULT_SETTINGS.username_highlight), DEFAULT_SETTINGS.username_highlight),
        twitchEmotes: boolOr(pick(frontend, "twitch_emotes", DEFAULT_SETTINGS.twitch_emotes), DEFAULT_SETTINGS.twitch_emotes),
        betterttvEmotes: boolOr(pick(frontend, "betterttv_emotes", DEFAULT_SETTINGS.betterttv_emotes), DEFAULT_SETTINGS.betterttv_emotes),
        seventvEmotes: boolOr(pick(frontend, "seventv_emotes", DEFAULT_SETTINGS.seventv_emotes), DEFAULT_SETTINGS.seventv_emotes),
        frankerfacezEmotes: boolOr(pick(frontend, "frankerfacez_emotes", DEFAULT_SETTINGS.frankerfacez_emotes), DEFAULT_SETTINGS.frankerfacez_emotes),
        favoriteChannels: stringArray(pick(frontend, "favorite_channels", DEFAULT_SETTINGS.favorite_channels))
      },
      filters: {
        message: {
          enabled: filters.message.enabled === true,
          reversed: filters.message.reversed === true,
          patterns: Array.isArray(filters.message.patterns) ? filters.message.patterns.map(String) : []
        },
        username: {
          enabled: filters.username.enabled === true,
          reversed: filters.username.reversed === true,
          patterns: Array.isArray(filters.username.patterns) ? filters.username.patterns.map(String) : []
        }
      },
      raw: raw
    };
  }

  /* ----------------------------------------------------------- filters */

  function resolveFilters(raw, paths, readFile, source, warnings) {
    var config = isObject(raw.filters) ? raw.filters : {};
    var nested = isObject(config.message) || isObject(config.username);

    function readPatterns(explicitPath, kind) {
      var path = explicitPath || paths.filtersFile;
      var text = null;
      try {
        text = readFile(path);
      } catch (err) {
        if (explicitPath) warnings.push("Could not read " + kind + " filters file '" + path + "': " + err.message);
        return [];
      }
      if (typeof text !== "string") {
        if (explicitPath) warnings.push("Could not read " + kind + " filters file '" + path + "'");
        return [];
      }
      source.filtersFound = true;
      return parseFiltersFile(text);
    }

    function nestedOne(kind) {
      var cfg = isObject(config[kind]) ? config[kind] : {};
      var patterns;
      if (Array.isArray(cfg.filters)) {
        patterns = cfg.filters.map(String);
      } else {
        patterns = readPatterns(typeof cfg.path === "string" && cfg.path !== "" ? String(cfg.path) : null, kind);
      }
      return {
        enabled: cfg.enabled === true,
        reversed: cfg.reversed === true,
        patterns: patterns
      };
    }

    if (nested) {
      return { message: nestedOne("message"), username: nestedOne("username") };
    }

    var patterns = readPatterns(null, "message");
    var enabled = config.enabled === true;
    var reversed = config.reversed === true;
    return {
      message: { enabled: enabled, reversed: reversed, patterns: patterns },
      username: { enabled: enabled, reversed: reversed, patterns: patterns.slice() }
    };
  }

  /**
   * Only the presence/emptiness of the token is exposed outside this module;
   * the value itself stays in `settings.twitch.token`.
   */
  function tokenState(raw) {
    var twitch = isObject(raw.twitch) ? raw.twitch : {};
    if (!hasOwn(twitch, "token")) return { available: false, empty: false };
    if (typeof twitch.token !== "string") return { available: false, empty: false };
    return { available: true, empty: twitch.token === "" };
  }

  /**
   * loadConfig({readFile, home, env, configFile?, candidates?})
   *
   * Probes the ordered candidates from resolveConfigPaths through readFile
   * (returns a string, or null/throws for a missing file) and uses the first
   * file that exists and parses. A malformed file is reported with its path
   * and probing continues. When no file exists, defaults and a warning that
   * lists every attempted path are returned. Filters come from filters.txt
   * next to the winning config file unless the config points elsewhere.
   */
  function loadConfig(opts) {
    opts = opts || {};
    var readFile = opts.readFile;
    if (typeof readFile !== "function") {
      throw new TypeError("loadConfig requires a readFile(path) function");
    }

    var paths = resolveConfigPaths(opts);
    var candidates = paths.candidates;
    var warnings = [];
    var tried = [];
    var raw = null;
    var configFileFound = false;
    var winner = null;
    var firstExisting = null;

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var text = null;
      try {
        text = readFile(candidate);
      } catch (err) {
        tried.push({
          path: candidate,
          found: false,
          error: err && err.message ? String(err.message) : String(err)
        });
        continue;
      }
      if (typeof text !== "string") {
        tried.push({ path: candidate, found: false });
        continue;
      }

      configFileFound = true;
      if (!firstExisting) firstExisting = candidate;
      try {
        raw = parseTOML(text);
      } catch (err) {
        var parseMessage = err && err.message ? String(err.message) : String(err);
        tried.push({ path: candidate, found: true, error: parseMessage });
        warnings.push(
          "Could not parse config file '" + candidate + "': " +
          parseMessage + " (trying the next candidate)"
        );
        continue;
      }
      tried.push({ path: candidate, found: true });
      winner = candidate;
      break;
    }

    var primary = winner || firstExisting || candidates[0];
    var filtersFile = dirname(primary) + "/filters.txt";
    var source = {
      configFile: primary,
      filtersFile: filtersFile,
      configFileFound: configFileFound,
      filtersFound: false,
      tried: tried,
      tokenPresent: { available: false, empty: false }
    };

    if (!raw) {
      if (!configFileFound) {
        warnings.push("No twt config found: config file not found; tried: " + candidates.join(", "));
      } else {
        warnings.push("No usable twt config found; tried: " + candidates.join(", "));
      }
      var defaults = normalize(DEFAULT_SETTINGS, { warnings: warnings });
      return { settings: defaults, filters: defaults.filters, source: source, warnings: warnings };
    }

    source.tokenPresent = tokenState(raw);
    var filters = resolveFilters(
      raw,
      { configFile: primary, filtersFile: filtersFile },
      readFile,
      source,
      warnings
    );
    var settings = normalize(raw, { filters: filters, warnings: warnings });
    return { settings: settings, filters: settings.filters, source: source, warnings: warnings };
  }

  /**
   * matchesFilters(text, {enabled, reversed, patterns}) -> boolean
   *
   * Each line is tried as a regex; an invalid regex falls back to a
   * case-insensitive substring match. ANY pattern matching counts as a
   * match; `reversed` inverts the result; a disabled filter returns true.
   * Note: JS regex syntax differs slightly from Rust's `regex` crate (the
   * reference implementation), so some Rust-only patterns fall back to
   * substring matching here.
   */
  function matchesFilters(text, opts) {
    opts = opts || {};
    if (opts.enabled === false) return true;
    var patterns = Array.isArray(opts.patterns) ? opts.patterns : [];
    var subject = text === null || text === undefined ? "" : String(text);
    var matched = false;
    for (var i = 0; i < patterns.length; i++) {
      var pattern = String(patterns[i]);
      if (!pattern) continue;
      var re = null;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        re = null;
      }
      if (re) {
        if (re.test(subject)) {
          matched = true;
          break;
        }
      } else if (subject.toLowerCase().indexOf(pattern.toLowerCase()) !== -1) {
        matched = true;
        break;
      }
    }
    return matched !== (opts.reversed === true);
  }

  return {
    parseTOML: parseTOML,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    CONFIG_DIR: CONFIG_DIR,
    resolveConfigPaths: resolveConfigPaths,
    loadConfig: loadConfig,
    normalize: normalize,
    matchesFilters: matchesFilters,
    parseFiltersFile: parseFiltersFile
  };
});
