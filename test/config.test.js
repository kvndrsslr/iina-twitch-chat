"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../lib/config.js");

const FIXTURES = path.join(__dirname, "fixtures");

function reader(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    return null;
  }
}

/* -------------------------------------------------------------- TOML */

test("parseTOML parses the fixture with nested tables and multi-line arrays", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "config.toml"), "utf8");
  const toml = config.parseTOML(text);
  assert.equal(toml.twitch.username, "testbot");
  assert.equal(toml.twitch.channel, "dallas");
  assert.equal(toml.twitch.server, "wss://irc-ws.chat.twitch.tv:443");
  assert.equal(toml.terminal.delay, 45);
  assert.equal(toml.terminal.maximum_messages, 300);
  assert.equal(toml.storage.channels, true);
  assert.equal(toml.filters.enabled, true);
  assert.equal(toml.frontend.palette, "vibrant");
  assert.equal(toml.frontend.theme, "light");
  assert.equal(toml.frontend.badges, true);
  assert.equal(toml.frontend.twitch_emotes, true);
  assert.deepEqual(toml.frontend.favorite_channels, ["placeholder_channel", "another_channel"]);
});

test("parseTOML dotted keys, quoted keys, literals, escapes, numbers", () => {
  const text = [
    "a.b.c = 3",
    '"my key".sub = "hello"',
    "lit = 'literal \\\\ not escaped'",
    "esc = \"line1\\nline2\\t\\u0041\\\"\"",
    "underscore = 1_000_000",
    "neg = -42",
    "float = 3.14",
    "exp = 1e6",
    "flag = true",
    "date = 1979-05-27T07:32:00Z",
    "time = 07:32:00",
  ].join("\n");
  const toml = config.parseTOML(text);
  assert.equal(toml.a.b.c, 3);
  assert.equal(toml["my key"].sub, "hello");
  assert.equal(toml.lit, "literal \\\\ not escaped");
  assert.equal(toml.esc, 'line1\nline2\tA"');
  assert.equal(toml.underscore, 1000000);
  assert.equal(toml.neg, -42);
  assert.equal(toml.float, 3.14);
  assert.equal(toml.exp, 1000000);
  assert.equal(toml.flag, true);
  assert.equal(toml.date, "1979-05-27T07:32:00Z");
  assert.equal(toml.time, "07:32:00");
});

test("parseTOML handles CRLF, comments inside and outside arrays, trailing comma", () => {
  const text = [
    "x = 1\r",
    "[arr]\r",
    "v = [",
    "  1, # inline comment",
    "  2,",
    "  3 # last without comma",
    "]\r",
  ].join("\r\n");
  const toml = config.parseTOML(text);
  assert.equal(toml.x, 1);
  assert.deepEqual(toml.arr.v, [1, 2, 3]);
});

test("parseTOML later duplicate key wins", () => {
  const toml = config.parseTOML("a = 1\n[a]\nb = 2\n[a]\nb = 3");
  assert.equal(toml.a.b, 3);
});

test("parseTOML throws with line number on invalid syntax", () => {
  assert.throws(() => config.parseTOML("a = 1\nx =\n"), /line 2/);
  assert.throws(() => config.parseTOML("[table\n"), /line 1/);
  assert.throws(() => config.parseTOML("a = \"unterminated\n"), /line 1/);
  assert.throws(() => config.parseTOML("a = [1, 2\n"), /line 1/);
  assert.throws(() => config.parseTOML("a = 3.\n"), /line 1/);
});

/* ------------------------------------------------------------- paths */

test("resolveConfigPaths expands ~ and honours TWT_CONFIG and explicit path", () => {
  const base = config.resolveConfigPaths({ home: "/Users/x", env: {} });
  assert.equal(base.configFile, "/Users/x/.config/twt/config.toml");
  assert.equal(base.filtersFile, "/Users/x/.config/twt/filters.txt");

  const env = config.resolveConfigPaths({ home: "/Users/x", env: { TWT_CONFIG: "/custom/config.toml" } });
  assert.equal(env.configFile, "/custom/config.toml");
  assert.equal(env.filtersFile, "/custom/filters.txt");

  const explicit = config.resolveConfigPaths({ home: "/Users/x", env: { TWT_CONFIG: "/env.toml" }, configFile: "~/mine.toml" });
  assert.equal(explicit.configFile, "/Users/x/mine.toml");
});

/* -------------------------------------------------------- loadConfig */

test("loadConfig returns defaults when config is missing", () => {
  const result = config.loadConfig({
    readFile: () => null,
    home: "/tmp/nohome",
    env: {},
  });
  assert.equal(result.source.configFileFound, false);
  assert.equal(result.settings.twitch.server, "wss://irc-ws.chat.twitch.tv:443");
  assert.equal(result.settings.chat.maxMessages, 500);
  assert.equal(result.settings.chat.delay, 30);
  assert.equal(result.settings.chat.palette, "pastel");
  assert.equal(result.settings.chat.theme, "dark");
  assert.equal(result.settings.chat.datetimeFormat, "%a %b %e %T %Y");
  assert.ok(result.warnings.some((w) => /not found/.test(w)));
});

test("loadConfig normalises the fixture config and filters", () => {
  const result = config.loadConfig({
    readFile: reader,
    home: "/tmp/h",
    env: {},
    configFile: path.join(FIXTURES, "config.toml"),
  });
  const s = result.settings;
  assert.equal(result.source.configFileFound, true);
  assert.equal(s.twitch.username, "testbot");
  assert.equal(s.twitch.channel, "dallas");
  assert.equal(s.twitch.token, null);
  assert.equal(s.twitch.server, "wss://irc-ws.chat.twitch.tv:443");
  assert.equal(s.twitch.keepaliveTimeoutSeconds, 30);
  assert.equal(s.chat.maxMessages, 300);
  assert.equal(s.chat.delay, 45);
  assert.equal(s.chat.palette, "vibrant");
  assert.equal(s.chat.theme, "light");
  assert.equal(s.chat.badges, true);
  assert.equal(s.chat.usernameHighlight, false);
  assert.equal(s.chat.twitchEmotes, true);
  assert.deepEqual(s.chat.favoriteChannels, ["placeholder_channel", "another_channel"]);
  assert.equal(s.chat.datetimeFormat, "%a %b %e %T %Y");
  // Flat [filters] + filters.txt
  assert.equal(s.filters.message.enabled, true);
  assert.equal(s.filters.message.reversed, false);
  assert.deepEqual(s.filters.message.patterns, ["^bad", "Kappa", "[Vv]ip", "naughty_("]);
  assert.equal(s.filters.username.enabled, true);
  assert.ok(result.source.filtersFound);
});

test("loadConfig with EventSub default server falls back to IRC with a warning", () => {
  const text = '[twitch]\nserver = "wss://eventsub.wss.twitch.tv/ws"\nusername = "u"\nchannel = "c"\ntoken = "x"\n';
  const result = config.loadConfig({
    readFile: (p) => (p === "/tmp/e/config.toml" ? text : null),
    home: "/tmp/e",
    env: {},
    configFile: "/tmp/e/config.toml",
  });
  assert.equal(result.settings.twitch.server, "wss://irc-ws.chat.twitch.tv:443");
  assert.ok(result.warnings.some((w) => w.includes("wss://eventsub.wss.twitch.tv/ws")));
});

test("loadConfig honours an irc-ws server verbatim (no warning)", () => {
  const text = '[twitch]\nserver = "wss://irc-ws.chat.twitch.tv:443"\n';
  const result = config.loadConfig({
    readFile: (p) => (p === "/tmp/f/config.toml" ? text : null),
    home: "/tmp/f",
    env: {},
    configFile: "/tmp/f/config.toml",
  });
  assert.equal(result.settings.twitch.server, "wss://irc-ws.chat.twitch.tv:443");
  assert.ok(!result.warnings.some((w) => w.includes("not an irc-ws endpoint")));
});

test("loadConfig supports the nested filters form with path and inline arrays", () => {
  const result = config.loadConfig({
    readFile: reader,
    home: "/tmp/h",
    env: {},
    configFile: path.join(FIXTURES, "config-nested.toml"),
  });
  const f = result.settings.filters;
  assert.equal(f.message.enabled, true);
  assert.equal(f.message.reversed, true);
  assert.deepEqual(f.message.patterns, ["^spam", "naughty"]);
  assert.equal(f.username.enabled, false);
  assert.equal(f.username.reversed, false);
  assert.deepEqual(f.username.patterns, ["not-good", "^bot"]);
});

/* ---------------------------------------------------------- normalize */

test("normalize falls back to defaults and warns on invalid enums", () => {
  const toml = { frontend: { palette: "neon", theme: "sepia", show_datetimes: false }, terminal: { delay: 7 } };
  const warnings = [];
  const s = config.normalize(toml, { warnings });
  assert.equal(s.chat.palette, "pastel");
  assert.equal(s.chat.theme, "dark");
  assert.equal(s.chat.delay, 7);
  assert.equal(s.chat.showDatetimes, false);
  assert.ok(warnings.some((w) => w.includes("neon")));
  assert.ok(warnings.some((w) => w.includes("sepia")));
  assert.deepEqual(s.raw, toml);
});

test("normalize accepts the flat DEFAULT_SETTINGS shape", () => {
  const warnings = [];
  const s = config.normalize(config.DEFAULT_SETTINGS, { warnings });
  assert.equal(s.chat.palette, "pastel");
  assert.equal(s.chat.theme, "dark");
  assert.equal(s.chat.maxMessages, 500);
  assert.equal(s.chat.delay, 30);
  assert.equal(s.twitch.keepaliveTimeoutSeconds, 30);
  assert.ok(warnings.some((w) => /eventsub/i.test(w)));
});

test("normalize keeps unknown keys in raw without crashing", () => {
  const toml = { frontend: { palette: "cool", totally_unknown: { a: 1 } }, new_section: [1, 2] };
  const s = config.normalize(toml, {});
  assert.equal(s.chat.palette, "cool");
  assert.deepEqual(s.raw.new_section, [1, 2]);
});

/* ---------------------------------------------------------- matchesFilters */

test("matchesFilters: disabled filter always passes", () => {
  assert.equal(config.matchesFilters("anything", { enabled: false, patterns: ["x"] }), true);
});

test("matchesFilters: regex match and invalid-regex substring fallback", () => {
  const cfg = { enabled: true, reversed: false, patterns: ["^bad", "naughty_("] };
  assert.equal(config.matchesFilters("bad word", cfg), true);
  assert.equal(config.matchesFilters("very naughty_(stuff)", cfg), true);
  assert.equal(config.matchesFilters("fine message", cfg), false);
});

test("matchesFilters: invalid regex falls back to case-insensitive substring", () => {
  const cfg = { enabled: true, reversed: false, patterns: ["KAPPA["] }; // "[" makes this an invalid regex
  assert.equal(config.matchesFilters("hey KAPPA[ here", cfg), true);
  assert.equal(config.matchesFilters("just kappa", cfg), false);
});

test("matchesFilters: reversed inverts the whole result", () => {
  const cfg = { enabled: true, reversed: true, patterns: ["^bad"] };
  assert.equal(config.matchesFilters("bad thing", cfg), false);
  assert.equal(config.matchesFilters("good thing", cfg), true);
});

test("parseFiltersFile skips comments and blanks", () => {
  assert.deepEqual(config.parseFiltersFile("# comment\n\n^bad\nKappa\n"), ["^bad", "Kappa"]);
});

/* ---------------------------------------------- path probing (injected) */

const HOME = "/Users/probe";
const HOME_CONFIG = HOME + "/.config/twt/config.toml";
const HOME_FILTERS = HOME + "/.config/twt/filters.txt";
const MACOS_SUPPORT_CONFIG = HOME + "/Library/Application Support/com.twitch-tui.twt/config.toml";
const MACOS_SUPPORT_FILTERS = HOME + "/Library/Application Support/com.twitch-tui.twt/filters.txt";
const MACOS_PREFS_CONFIG = HOME + "/Library/Preferences/com.twitch-tui.twt/config.toml";

function fakeReader(files, requested) {
  return function readFile(p) {
    requested.push(p);
    return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
  };
}

test("resolveConfigPaths returns ordered, de-duplicated candidates", () => {
  const envPath = "/env/twt.toml";
  const resolved = config.resolveConfigPaths({
    home: HOME,
    env: { TWT_CONFIG: envPath },
    configFile: "~/explicit.toml",
    candidates: ["/extra/one.toml", "", "~/explicit.toml", "/extra/two.toml"],
  });
  assert.deepEqual(resolved.candidates, [
    HOME + "/explicit.toml",
    envPath,
    HOME_CONFIG,
    MACOS_SUPPORT_CONFIG,
    MACOS_PREFS_CONFIG,
    "/extra/one.toml",
    "/extra/two.toml",
  ]);
  assert.equal(resolved.configFile, HOME + "/explicit.toml");
  assert.equal(resolved.filtersFile, HOME + "/filters.txt");
});

test("loadConfig prefers TWT_CONFIG over the home candidates", () => {
  const envPath = "/custom/config.toml";
  const requested = [];
  const result = config.loadConfig({
    home: HOME,
    env: { TWT_CONFIG: envPath },
    readFile: fakeReader(
      {
        [envPath]: '[twitch]\nusername = "env"\ntoken = "oauth:abc"\n',
        [HOME_CONFIG]: '[twitch]\nusername = "home"\n',
      },
      requested
    ),
  });
  assert.equal(result.source.configFile, envPath);
  assert.equal(result.source.configFileFound, true);
  assert.deepEqual(requested.slice(0, 1), [envPath]);
  assert.equal(result.settings.twitch.username, "env");
  assert.deepEqual(result.source.tokenPresent, { available: true, empty: false });
});

test("loadConfig uses ~/.config/twt/config.toml when it is the only existing file", () => {
  const requested = [];
  const result = config.loadConfig({
    home: HOME,
    env: {},
    readFile: fakeReader(
      { [HOME_CONFIG]: '[twitch]\nusername = "dotconfig"\n' },
      requested
    ),
  });
  assert.equal(result.source.configFile, HOME_CONFIG);
  assert.equal(result.settings.twitch.username, "dotconfig");
  assert.deepEqual(requested.slice(0, 1), [HOME_CONFIG]);
});

test("loadConfig probes the macOS ProjectDirs candidate", () => {
  const requested = [];
  const result = config.loadConfig({
    home: HOME,
    env: {},
    readFile: fakeReader(
      { [MACOS_SUPPORT_CONFIG]: '[twitch]\nusername = "macos"\n' },
      requested
    ),
  });
  assert.equal(result.source.configFile, MACOS_SUPPORT_CONFIG);
  assert.equal(result.settings.twitch.username, "macos");
  assert.deepEqual(requested.slice(0, 2), [HOME_CONFIG, MACOS_SUPPORT_CONFIG]);
});

test("loadConfig reports every tried path when nothing exists", () => {
  const requested = [];
  const result = config.loadConfig({
    home: HOME,
    env: {},
    readFile: fakeReader({}, requested),
  });
  const expected = [HOME_CONFIG, MACOS_SUPPORT_CONFIG, MACOS_PREFS_CONFIG];
  assert.deepEqual(requested, expected);
  assert.deepEqual(result.source.tried.map((entry) => entry.path), expected);
  assert.ok(result.source.tried.every((entry) => entry.found === false));
  assert.equal(result.source.configFile, HOME_CONFIG);
  assert.equal(result.source.configFileFound, false);
  assert.equal(result.settings.chat.maxMessages, 500);
  assert.ok(
    result.warnings.some((w) => /not found/i.test(w) && w.includes(HOME_CONFIG))
  );
});

test("loadConfig warns about a malformed first file and falls back to the next candidate", () => {
  const explicit = "/tmp/broken/config.toml";
  const requested = [];
  const result = config.loadConfig({
    home: HOME,
    env: {},
    configFile: explicit,
    readFile: fakeReader(
      {
        [explicit]: "[terminal]\ndelay =\n",
        [HOME_CONFIG]: "[terminal]\ndelay = 12\n",
      },
      requested
    ),
  });
  assert.equal(result.source.configFile, HOME_CONFIG);
  assert.equal(result.settings.chat.delay, 12);
  assert.deepEqual(requested.slice(0, 2), [explicit, HOME_CONFIG]);
  assert.deepEqual(result.source.tried.map((entry) => entry.path), [explicit, HOME_CONFIG]);
  assert.equal(result.source.tried[0].found, true);
  assert.ok(result.source.tried[0].error);
  assert.ok(
    result.warnings.some((w) => /could not parse/i.test(w) && w.includes(explicit))
  );
});

test("loadConfig derives source.tokenPresent without exposing the token", () => {
  function load(text) {
    const file = "/tmp/token/config.toml";
    return config.loadConfig({
      home: "/tmp/token-home",
      env: {},
      configFile: file,
      readFile: (p) => (p === file ? text : null),
    });
  }

  assert.deepEqual(load('[twitch]\ntoken = "oauth:secret"\n').source.tokenPresent, {
    available: true,
    empty: false,
  });
  assert.deepEqual(load('[twitch]\ntoken = ""\n').source.tokenPresent, {
    available: true,
    empty: true,
  });
  assert.deepEqual(load('[twitch]\nusername = "u"\n').source.tokenPresent, {
    available: false,
    empty: false,
  });

  const secret = "oauth:supersecret-token-value";
  const result = load(`[twitch]\ntoken = "${secret}"\nserver = "wss://irc-ws.chat.twitch.tv:443"\n`);
  const haystack = JSON.stringify(result.source) + "\n" + result.warnings.join("\n");
  assert.equal(haystack.includes("supersecret"), false);
  assert.equal(haystack.includes(secret), false);
});

test("loadConfig resolves filters.txt next to whichever config won", () => {
  const requested = [];
  const result = config.loadConfig({
    home: HOME,
    env: {},
    readFile: fakeReader(
      {
        [MACOS_SUPPORT_CONFIG]: "[filters]\nenabled = true\n",
        [MACOS_SUPPORT_FILTERS]: "^spam\nKappa\n",
        [HOME_FILTERS]: "^wrong-place\n",
      },
      requested
    ),
  });
  assert.equal(result.source.configFile, MACOS_SUPPORT_CONFIG);
  assert.equal(result.source.filtersFile, MACOS_SUPPORT_FILTERS);
  assert.equal(result.source.filtersFound, true);
  assert.deepEqual(result.settings.filters.message.patterns, ["^spam", "Kappa"]);
  assert.ok(requested.includes(MACOS_SUPPORT_FILTERS));
  assert.ok(!requested.includes(HOME_FILTERS));
});
