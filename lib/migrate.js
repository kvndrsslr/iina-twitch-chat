/*
 * lib/migrate.js - carry a install's state across the identifier rename.
 *
 * IINA keys plugin state by the manifest identifier: preferences live in
 * `<plugins>/.preferences/<identifier>.plist` and data in `<plugins>/.data/<identifier>/`
 * (iina/JavascriptPlugin.swift, `preferencesFileURL` and `dataURL`). Changing the
 * identifier therefore starts the plugin empty. This module copies the previous
 * identifier's preferences (only keys the new file does not already have) and the
 * cached history file once, then writes a `migrated_from` marker into the new
 * preferences so later launches do no work.
 *
 * The plists are read as text and parsed for the scalar types IINA stores:
 * string, integer, real, boolean, date and data. That covers every preference
 * this plugin writes; a value of any other type is skipped rather than guessed.
 * `iina.preferences.set` remains the only writer, so IINA owns the file format.
 *
 * Everything is injected (file, preferences, readText, identifiers, plugin dir),
 * so this runs unchanged in IINA's JavaScriptCore and in Node tests.
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.migrate = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* The identifier every 1.5.0 install was stored under. */
  var LEGACY_IDENTIFIER = "com.kdressler.iina-twitch-chat";
  /* Presence of this key in the *new* preferences file means the copy already ran. */
  var MARKER_KEY = "migrated_from";
  var DATA_FILES = ["history.json"];

  var TOKEN = /<key>([\s\S]*?)<\/key>|<string>([\s\S]*?)<\/string>|<integer>([\s\S]*?)<\/integer>|<real>([\s\S]*?)<\/real>|<date>([\s\S]*?)<\/date>|<data>([\s\S]*?)<\/data>|<true\s*\/>|<false\s*\/>/g;

  function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, function (all, entity) {
      if (entity === "lt") return "<";
      if (entity === "gt") return ">";
      if (entity === "amp") return "&";
      if (entity === "quot") return "\"";
      if (entity === "apos") return "'";
      if (entity.charAt(1) === "x") return String.fromCodePoint(parseInt(entity.slice(2), 16));
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    });
  }

  /* Scalar plist -> object, or null when the text is not an XML plist. */
  function parsePlist(text) {
    if (typeof text !== "string" || text.indexOf("<plist") === -1) return null;
    var out = {};
    var key = null;
    var match;
    TOKEN.lastIndex = 0;
    while ((match = TOKEN.exec(text)) !== null) {
      if (match[1] !== undefined) {
        key = decodeEntities(match[1]);
        continue;
      }
      if (key === null) continue;                 /* value outside a <key>: not our shape */
      if (match[2] !== undefined) out[key] = decodeEntities(match[2]);
      else if (match[3] !== undefined) out[key] = parseInt(match[3], 10);
      else if (match[4] !== undefined) out[key] = parseFloat(match[4]);
      else if (match[5] !== undefined) out[key] = decodeEntities(match[5]);
      else if (match[6] !== undefined) out[key] = match[6].replace(/\s+/g, "");
      else out[key] = match[0].indexOf("<true") === 0;
      key = null;
    }
    return out;
  }

  /* `<plugins>/.data/<identifier>` -> `<plugins>`, without guessing HOME.
   * IINA's expandPath() may or may not keep a trailing slash. */
  function pluginsDirFromDataPath(dataPath) {
    if (typeof dataPath !== "string") return null;
    var index = dataPath.replace(/\/+$/, "").lastIndexOf("/.data/");
    return index > 0 ? dataPath.slice(0, index) : null;
  }

  /* `<plugins>/.data/<identifier>` -> `<identifier>`: the name IINA keys this
   * install's preferences and data by, read back instead of hard-coded. */
  function identifierFromDataPath(dataPath) {
    if (typeof dataPath !== "string") return null;
    var trimmed = dataPath.replace(/\/+$/, "");
    var index = trimmed.lastIndexOf("/.data/");
    if (index <= 0) return null;
    var identifier = trimmed.slice(index + "/.data/".length);
    return identifier && identifier.indexOf("/") === -1 ? identifier : null;
  }

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function run(deps) {
    var identifier = deps.identifier;
    var legacy = deps.legacyIdentifier || LEGACY_IDENTIFIER;
    if (!identifier || identifier === legacy) return { status: "noop" };
    var pluginsDir = deps.pluginsDir;
    if (!pluginsDir) return { status: "error", reason: "plugins directory unknown" };

    var prefsDir = pluginsDir + "/.preferences/";
    var destText = deps.readText(prefsDir + identifier + ".plist");
    var dest = destText ? parsePlist(destText) : null;
    if (dest && has(dest, MARKER_KEY)) return { status: "current" };

    var legacyText = deps.readText(prefsDir + legacy + ".plist");
    var legacyPrefs = null;
    if (legacyText) {
      legacyPrefs = parsePlist(legacyText);
      /* An unreadable legacy file is not "nothing to copy": leave no marker and retry. */
      if (!legacyPrefs) return { status: "error", reason: "unreadable legacy preferences" };
    }

    var keys = 0;
    if (legacyPrefs) {
      Object.keys(legacyPrefs).forEach(function (name) {
        if (name === MARKER_KEY) return;
        if (dest && has(dest, name)) return;      /* never overwrite what this install already wrote */
        deps.preferences.set(name, legacyPrefs[name]);
        keys += 1;
      });
    }

    var files = 0;
    var legacyDataDir = pluginsDir + "/.data/" + legacy;
    for (var i = 0; i < DATA_FILES.length; i++) {
      var name = DATA_FILES[i];
      var target = "@data/" + name;
      if (deps.file.exists(target)) continue;
      var source = legacyDataDir + "/" + name;
      if (!deps.file.exists(source)) continue;
      var content = deps.readText(source);
      if (typeof content !== "string") continue;
      deps.file.write(target, content);
      files += 1;
    }

    if (keys || files) {
      deps.preferences.set(MARKER_KEY, legacy);
      deps.preferences.sync();
      return { status: "migrated", keys: keys, files: files };
    }
    return { status: "empty" };
  }

  return {
    LEGACY_IDENTIFIER: LEGACY_IDENTIFIER,
    MARKER_KEY: MARKER_KEY,
    DATA_FILES: DATA_FILES,
    parsePlist: parsePlist,
    pluginsDirFromDataPath: pluginsDirFromDataPath,
    identifierFromDataPath: identifierFromDataPath,
    run: run
  };
});
