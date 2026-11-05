/* Tests for lib/migrate.js: the one-time copy of a 1.5.0 install's preferences
 * and cached history onto the renamed identifier's storage.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const MIGRATE = require("../lib/migrate.js");

const PLUGINS = "/Users/test/Library/Application Support/com.colliderli.iina/plugins";
const LEGACY = MIGRATE.LEGACY_IDENTIFIER;
const CURRENT = "com.kdressler.twitch-iina";

function plist(entries) {
  const body = Object.keys(entries).map((key) => {
    const value = entries[key];
    if (value === true) return `<key>${key}</key><true/>`;
    if (value === false) return `<key>${key}</key><false/>`;
    if (typeof value === "number" && Number.isInteger(value)) return `<key>${key}</key><integer>${value}</integer>`;
    return `<key>${key}</key><string>${value}</string>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

function harness(options) {
  const opts = options || {};
  const files = Object.assign({}, opts.files);
  const sets = [];
  const written = [];
  const synced = [];
  const prefs = {};
  const deps = {
    identifier: opts.identifier || CURRENT,
    pluginsDir: "pluginsDir" in opts ? opts.pluginsDir : PLUGINS,
    preferences: {
      set(key, value) { sets.push([key, value]); prefs[key] = value; },
      sync() { synced.push(true); }
    },
    file: {
      exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
      write: (path, content) => { written.push([path, content]); files[path] = content; }
    },
    readText: (path) => (Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null)
  };
  return { deps, files, sets, written, synced, prefs };
}

test("preferences absent from the new file are copied, existing ones win, and a marker is written", () => {
  const files = {
    [`${PLUGINS}/.preferences/${CURRENT}.plist`]: plist({ status_line: "fresh" }),
    [`${PLUGINS}/.preferences/${LEGACY}.plist`]: plist({
      status_line: "stale",
      last_channel: "caedrel",
      auto_open_browser: true,
      command_seq: 4,
      ui_overrides: "{}"
    })
  };
  const h = harness({ files });
  const result = MIGRATE.run(h.deps);
  assert.deepStrictEqual(result, { status: "migrated", keys: 4, files: 0 });
  assert.deepStrictEqual(h.sets.map((entry) => entry[0]).sort(),
    ["auto_open_browser", "command_seq", "last_channel", MIGRATE.MARKER_KEY, "ui_overrides"]);
  assert.equal(h.prefs.status_line, undefined, "an existing key is never overwritten");
  assert.equal(h.prefs.last_channel, "caedrel");
  assert.equal(h.prefs.auto_open_browser, true);
  assert.equal(h.prefs.command_seq, 4);
  assert.equal(h.prefs[MIGRATE.MARKER_KEY], LEGACY);
  assert.equal(h.synced.length, 1, "one sync persists the copies and the marker");
});

test("a second run does nothing once the marker is present", () => {
  const files = {
    [`${PLUGINS}/.preferences/${CURRENT}.plist`]: plist({ [MIGRATE.MARKER_KEY]: LEGACY }),
    [`${PLUGINS}/.preferences/${LEGACY}.plist`]: plist({ last_channel: "caedrel" })
  };
  const h = harness({ files });
  assert.deepStrictEqual(MIGRATE.run(h.deps), { status: "current" });
  assert.deepStrictEqual(h.sets, []);
  assert.deepStrictEqual(h.synced, []);
});

test("the cached history is copied once and never overwrites this install's file", () => {
  const history = JSON.stringify({ version: 1, channels: { caedrel: [] } });
  const files = {
    [`${PLUGINS}/.preferences/${LEGACY}.plist`]: plist({ last_channel: "caedrel" }),
    [`${PLUGINS}/.data/${LEGACY}/history.json`]: history
  };
  const h = harness({ files });
  const result = MIGRATE.run(h.deps);
  assert.deepStrictEqual(result, { status: "migrated", keys: 1, files: 1 });
  assert.deepStrictEqual(h.written, [["@data/history.json", history]]);
  assert.equal(h.files["@data/history.json"], history);

  const again = harness({ files: Object.assign({}, files, { "@data/history.json": history }) });
  again.deps.identifier = "another.install";
  const second = MIGRATE.run(again.deps);
  assert.deepStrictEqual(second, { status: "migrated", keys: 1, files: 0 },
    "an existing @data file is kept");
});

test("an unreadable legacy plist leaves no marker, so the next launch retries", () => {
  const files = {
    [`${PLUGINS}/.preferences/${LEGACY}.plist`]: "bplist00\u0001\u0002 not an XML plist"
  };
  const h = harness({ files });
  assert.deepStrictEqual(MIGRATE.run(h.deps), { status: "error", reason: "unreadable legacy preferences" });
  assert.deepStrictEqual(h.sets, []);
  assert.deepStrictEqual(h.synced, []);
});

test("a fresh install with no legacy state writes nothing", () => {
  const h = harness({ files: {} });
  assert.deepStrictEqual(MIGRATE.run(h.deps), { status: "empty" });
  assert.deepStrictEqual(h.sets, []);
});

test("nothing happens when the manifest still carries the legacy identifier", () => {
  const h = harness({ files: { [`${PLUGINS}/.preferences/${LEGACY}.plist`]: plist({ a: "b" }) }, identifier: LEGACY });
  assert.deepStrictEqual(MIGRATE.run(h.deps), { status: "noop" });
});

test("the plist reader returns the scalar types IINA stores and decodes entities", () => {
  const text = plist({
    plain: "value",
    escaped: "a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;",
    on: true,
    off: false,
    count: -3,
    config: "line1\nline2"
  });
  assert.deepStrictEqual(MIGRATE.parsePlist(text), {
    plain: "value",
    escaped: "a & b <c> \"d\" 'e' A",
    on: true,
    off: false,
    count: -3,
    config: "line1\nline2"
  });
  assert.equal(MIGRATE.parsePlist("bplist00"), null);
  assert.equal(MIGRATE.parsePlist(""), null);
});

test("@data paths yield the plugins directory and the identifier IINA keyed", () => {
  const data = `${PLUGINS}/.data/${CURRENT}`;
  assert.equal(MIGRATE.pluginsDirFromDataPath(data), PLUGINS);
  assert.equal(MIGRATE.identifierFromDataPath(data), CURRENT);
  assert.equal(MIGRATE.pluginsDirFromDataPath(data + "/"), PLUGINS, "expandPath() may keep a trailing slash");
  assert.equal(MIGRATE.identifierFromDataPath(data + "/"), CURRENT);
  assert.equal(MIGRATE.pluginsDirFromDataPath("@data"), null);
  assert.equal(MIGRATE.identifierFromDataPath("@data"), null);
  assert.equal(MIGRATE.identifierFromDataPath(`${PLUGINS}/.data/a/b`), null);
});
