/*
 * lib/hostenv.js - the config/HOME plumbing both plugin entries need.
 *
 * Both entries read the twitch-tui configuration (main entry: the player window;
 * global entry: the standalone Twitch browser window) and both need the same
 * careful behaviour around IINA's APIs:
 *   - iina.file.read is declared `read(_ path: String, _ options: [String: Any])`
 *     (iina/JavascriptAPIFile.swift), so a build that bridges it differently is
 *     tried with and without the options argument, and a read that fails records
 *     *why* instead of looking like "no config file";
 *   - iina.utils.resolvePath only expands a leading "~/" (a bare "~" throws
 *     "The path should be an absolute path: ~"), so HOME comes from /usr/bin/env
 *     and is derived from a known "~/" probe otherwise.
 *
 * Everything is injected (file, utils, log, warn, the env accessor and a "is the
 * window gone" predicate), so this runs unchanged in IINA's JavaScriptCore and
 * in Node tests.
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.hostenv = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 1500;

  function create(options) {
    var opts = options || {};
    var file = opts.file;
    var utils = opts.utils;
    var log = opts.log || function () {};
    var warn = opts.warn || function () {};
    var envOf = opts.env || function () { return {}; };
    var isGone = opts.isGone || function () { return false; };
    var fallbackDir = opts.fallbackDir || "~/.config/twt";
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var defer = opts.setTimeout || (typeof setTimeout === "function" ? setTimeout : null);
    var cancel = opts.clearTimeout || (typeof clearTimeout === "function" ? clearTimeout : null);

    var readArityLogged = false;
    var readErrors = {};

    function recordReadError(path, message) {
      readErrors[path] = String(message);
      warn("iina.file.read(" + path + ") failed: " + message);
    }

    /* undefined => the call itself threw (recorded once both shapes failed) */
    function readFileAttempt(path, withOptions) {
      try {
        var value = withOptions ? file.read(path, {}) : file.read(path);
        if (typeof value === "string") {
          delete readErrors[path];
          return value;
        }
        return null;
      } catch (err) {
        if (withOptions) return undefined;           /* let the 1-argument form try */
        recordReadError(path, err);
        return undefined;
      }
    }

    function readTextFile(path) {
      var exists = false;
      try {
        exists = file.exists(path);
      } catch (err) {
        recordReadError(path, "file.exists: " + err);
        return null;
      }
      if (!exists) {
        delete readErrors[path];
        return null;   /* genuinely absent: not an error */
      }
      if (!readArityLogged) {
        readArityLogged = true;
        var arity = "unknown";
        try { arity = file.read.length; } catch (err) { arity = "unknown"; }
        log("iina.file.read arity: " + arity);
      }
      var value = readFileAttempt(path, true);
      if (value === undefined) value = readFileAttempt(path, false);
      if (value === undefined) return null;         /* both shapes threw; recorded */
      if (typeof value === "string") {
        delete readErrors[path];
        return value;
      }
      recordReadError(path, "read() returned " + String(value) + " instead of a string");
      return null;
    }

    function readErrorsText() {
      var paths = Object.keys(readErrors);
      if (!paths.length) return "";
      var parts = [];
      for (var i = 0; i < paths.length; i++) parts.push(paths[i] + ": " + readErrors[paths[i]]);
      return parts.join("; ");
    }

    function resolvePath(path) {
      try { return utils.resolvePath(path); } catch (err) { return path; }
    }

    /* Prefer HOME from /usr/bin/env and derive it from a known "~/" path otherwise. */
    function homePath() {
      var env = envOf();
      if (env && typeof env.HOME === "string" && env.HOME) return env.HOME;
      var probe = resolvePath(fallbackDir);
      if (typeof probe === "string" && probe.length > fallbackDir.length && probe.slice(-fallbackDir.length) === fallbackDir) {
        return probe.slice(0, -fallbackDir.length);
      }
      return "~";
    }

    function readEnvironment(done) {
      var finished = false;
      var timer = null;
      function finish(env) {
        if (finished || isGone()) return;
        finished = true;
        if (timer !== null && cancel) cancel(timer);
        done(env);
      }
      if (defer) {
        timer = defer(function () { finish({}); }, timeoutMs);
      }
      try {
        utils.exec("/usr/bin/env", []).then(function (result) {
          var env = {};
          var lines = String(result && result.stdout ? result.stdout : "").split("\n");
          for (var i = 0; i < lines.length; i++) {
            var idx = lines[i].indexOf("=");
            if (idx > 0) env[lines[i].slice(0, idx)] = lines[i].slice(idx + 1);
          }
          finish(env);
        }).catch(function (err) {
          warn("could not read the environment: " + err);
          finish({});
        });
      } catch (e) {
        warn("could not read the environment: " + e);
        finish({});
      }
    }

    function expandHome(path, home) {
      if (typeof path === "string" && path.indexOf("~/") === 0 && home && home !== "~") return home + path.slice(1);
      return path;
    }

    /* The *Config file* preference, resolved and expanded, or null. */
    function configFileOption(prefFile, home) {
      if (typeof prefFile !== "string" || !prefFile) return null;
      var resolved = resolvePath(prefFile);
      return expandHome(resolved || prefFile, home);
    }

    return {
      readErrors: readErrors,
      readTextFile: readTextFile,
      readErrorsText: readErrorsText,
      resolvePath: resolvePath,
      homePath: homePath,
      readEnvironment: readEnvironment,
      expandHome: expandHome,
      configFileOption: configFileOption
    };
  }

  return {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    create: create
  };
});
