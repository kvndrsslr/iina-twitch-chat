"use strict";

/*
 * Regression tests for the UMD wrappers.
 *
 * IINA 1.5.0 (JavascriptPluginInstance.swift, evaluateFile(_:asModule:))
 * evaluates a require()d module as:
 *   (function () { const module = {}; <file contents> return module.exports; })()
 * The shim's `module` has no `exports` property, so the wrapper must decide on
 * `module` truthiness (not `module.exports`) or require() yields undefined.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const LIBS = {
  "irc.js": {
    name: "irc",
    keys: ["parseTags", "escapeTagValue", "parseMessage", "splitLines", "toChatEvent", "formatMessage", "createClient", "CHAT_URL"],
  },
  "config.js": {
    name: "config",
    keys: ["parseTOML", "DEFAULT_SETTINGS", "resolveConfigPaths", "loadConfig", "normalize", "matchesFilters", "parseFiltersFile"],
  },
  "emotes.js": {
    name: "emotes",
    keys: ["twitchEmoteURL", "badgeURL", "bttvEmoteURL", "seventvEmoteURL", "ffzEmoteURL", "THIRD_PARTY", "parseThirdParty", "segment", "PALETTES", "userColor"],
  },
  "strftime.js": {
    name: "strftime",
    keys: ["strftime", "formatTimestamp"],
  },
  "webview.js": {
    name: "webview",
    keys: ["base64Encode", "encodeForWebview"],
  },
  "helix.js": {
    name: "helix",
    keys: ["ALLOWED_PATHS", "IDENTITY_PATH", "API_ORIGIN", "VALIDATE_URL", "DEFAULT_TIMEOUT_MS", "DEFAULT_MAX_BYTES", "MEDIA_HOSTS", "allowedPath", "pathSpec", "urlSpec", "requestSpec", "cleanToken", "pickToken", "twitchMediaUrl", "logUrl", "create"],
  },
  "hostenv.js": {
    name: "hostenv",
    keys: ["DEFAULT_TIMEOUT_MS", "create"],
  },
  "migrate.js": {
    name: "migrate",
    keys: ["LEGACY_IDENTIFIER", "MARKER_KEY", "DATA_FILES", "parsePlist", "pluginsDirFromDataPath", "identifierFromDataPath", "run"],
  },
};

function sourceFor(file) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8");
}

test("IINA require() shim: module = {} yields real module.exports", () => {
  for (const [file, spec] of Object.entries(LIBS)) {
    // Exactly IINA's shim: a plain object named `module`, no `self` global.
    const sandbox = { module: {} };
    vm.runInNewContext(sourceFor(file), sandbox, { filename: "lib/" + file });

    const exports = sandbox.module.exports;
    assert.ok(exports && typeof exports === "object", file + ": module.exports must be an object, got " + typeof exports);
    assert.ok(Object.keys(exports).length > 0, file + ": module.exports must not be empty");
    for (const key of spec.keys) {
      assert.ok(key in exports, file + ": module.exports is missing '" + key + "'");
    }
    // The module branch must not leak into the global TwitchPlugin namespace.
    assert.equal(sandbox.TwitchPlugin, undefined, file + ": global namespace must stay untouched when module exists");
  }
});

test("browser path: no module yields TwitchPlugin.<name>", () => {
  for (const [file, spec] of Object.entries(LIBS)) {
    const sandbox = {};
    vm.runInNewContext(sourceFor(file), sandbox, { filename: "lib/" + file });

    assert.equal(typeof sandbox.module, "undefined", file + ": browser path must not create module");
    assert.ok(sandbox.TwitchPlugin && typeof sandbox.TwitchPlugin === "object", file + ": TwitchPlugin missing");
    const exports = sandbox.TwitchPlugin[spec.name];
    assert.ok(exports && typeof exports === "object", file + ": TwitchPlugin." + spec.name + " missing");
    for (const key of spec.keys) {
      assert.ok(key in exports, file + ": TwitchPlugin." + spec.name + " is missing '" + key + "'");
    }
  }
});

test("shared namespace: browser loads accumulate on one TwitchPlugin object", () => {
  const sandbox = {};
  for (const file of Object.keys(LIBS)) {
    vm.runInNewContext(sourceFor(file), sandbox, { filename: "lib/" + file });
  }
  assert.deepEqual(
    Object.keys(sandbox.TwitchPlugin).sort(),
    ["config", "emotes", "helix", "hostenv", "irc", "migrate", "strftime", "webview"]
  );
  assert.equal(sandbox.TwitchPlugin.irc.CHAT_URL, "wss://irc-ws.chat.twitch.tv:443");
});
