/*
 * lib/helix.js - the Twitch Helix proxy shared by both plugin entries.
 *
 * The sidebar web view (main entry) and the standalone Twitch browser window
 * (global entry) both need Twitch API data, and neither may hold the OAuth
 * token itself: a file:// page cannot be trusted with it and its cross-origin
 * fetches are blocked. So a host injects its HTTP implementation and a token
 * provider, and this module owns the parts that must not diverge between hosts:
 *
 *   - the path allowlist (the only place a path is accepted),
 *   - the absolute-URL check for hosts that hand over `url` instead of `path`,
 *   - the token plumbing: /identity (validate) once per token, cached; 401 drops
 *     the cache; the user id from it is injected for /helix/channels/followed,
 *   - the transport discipline: 10 s timeout, 4 MiB body cap, an IINA-style
 *     "resolve 2xx / reject otherwise with the same dict" response shape,
 *   - the frozen error strings: "no token", "token invalid", "blocked",
 *     "timeout", "network", "http <status>", "invalid json".
 *
 * Nothing here is player-specific: it runs unchanged in IINA's JavaScriptCore
 * (both entries), Node and a WKWebView.
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.helix = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var IDENTITY_PATH = "/identity";
  var VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
  var API_ORIGIN = "https://api.twitch.tv";
  var API_HOST = "api.twitch.tv";
  /* The one allowlist: a path the browser may ask the host for. Results are
   * query-stringed (`?first=20&after=…`); the base path must match exactly. */
  var ALLOWED_PATHS = [
    "/identity",
    "/helix/users",
    "/helix/streams",
    "/helix/videos",
    "/helix/games/top",
    "/helix/channels/followed",
    "/helix/search/channels",
    "/helix/search/categories"
  ];
  var DEFAULT_TIMEOUT_MS = 10000;
  var DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
  /* The only hosts a view may ask us to *open* (any path): a stream or VOD page
   * has to be resolved by IINA/yt-dlp/streamlink. */
  var MEDIA_HOSTS = { "twitch.tv": 1, "www.twitch.tv": 1 };

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function allowedPath(path) {
    return ALLOWED_PATHS.indexOf(path) !== -1;
  }

  /* -> {path, query} when `raw` is an allowed path (query string allowed), else
   * null. A protocol-relative "//host/..." is rejected, as is anything that is
   * not a plain path. */
  function pathSpec(raw) {
    if (typeof raw !== "string" || raw.charAt(0) !== "/" || raw.slice(0, 2) === "//") return null;
    var q = raw.indexOf("?");
    var path = q === -1 ? raw : raw.slice(0, q);
    if (!allowedPath(path)) return null;
    return { path: path, query: q === -1 ? "" : raw.slice(q + 1) };
  }

  /* -> {path, query} for an absolute URL, or null. Only the two origins this
   * proxy ever talks to are accepted, and the path still has to be on the
   * allowlist, so handing over `url` is exactly as safe as handing over `path`.
   * (The identity probe's absolute form is the token-validate endpoint, which is
   * not an api.twitch.tv path - it maps onto IDENTITY_PATH.) */
  function urlSpec(raw) {
    if (typeof raw !== "string") return null;
    var match = /^https:\/\/([^\/?#]+)(\/[^?#]*)?(?:\?([^#]*))?/.exec(raw);
    if (!match) return null;
    var authority = match[1].toLowerCase();
    if (authority.indexOf("@") !== -1) return null;
    var port = /:(\d+)$/.exec(authority);
    if (port && port[1] !== "443") return null;
    var host = authority.replace(/:\d+$/, "");
    var path = match[2] || "/";
    var query = match[3] === undefined ? "" : match[3];
    if (host === API_HOST) {
      if (!allowedPath(path)) return null;
      return { path: path, query: query };
    }
    if (host === "id.twitch.tv" && path === "/oauth2/validate") {
      return { path: IDENTITY_PATH, query: query };
    }
    return null;
  }

  /* One request spec out of a view's request: `path` wins (the single
   * enforcement point), `url` is accepted as an alternative and validated
   * against the same allowlist. */
  function requestSpec(request) {
    if (!request || typeof request !== "object") return null;
    if (typeof request.path === "string") return pathSpec(request.path);
    if (typeof request.url === "string") return urlSpec(request.url);
    return null;
  }

  /* "oauth:xyz" / stray whitespace -> "xyz"; anything else is left alone. */
  function cleanToken(raw) {
    if (typeof raw !== "string") return "";
    var token = raw.replace(/\s+/g, "");
    if (/^oauth:/i.test(token)) token = token.slice(6);
    return token;
  }

  /* -> the URL when it is an https twitch.tv URL (any path), else null. Both
   * entries validate a twt:open request with this before loading anything. */
  function twitchMediaUrl(raw) {
    if (typeof raw !== "string") return null;
    var match = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(raw);
    if (!match) return null;
    var authority = match[1].toLowerCase();
    if (authority.indexOf("@") !== -1) return null;
    var port = /:(\d+)$/.exec(authority);
    if (port && port[1] !== "443") return null;
    if (!MEDIA_HOSTS[authority.replace(/:\d+$/, "")]) return null;
    return raw;
  }

  /* The IRC path's rule: the config's [twitch] token, else the Keychain. */
  function pickToken(configToken, keychainToken) {
    var fromConfig = cleanToken(configToken);
    if (fromConfig) return { value: fromConfig, source: "config" };
    var fromKeychain = cleanToken(keychainToken);
    if (fromKeychain) return { value: fromKeychain, source: "keychain" };
    return { value: null, source: "none" };
  }

  /* The token and the Authorization header are never logged: log lines only
   * name the host plus path and the status, and the query string is stripped. */
  function logUrl(url) {
    var match = /^https:\/\/([^\/?#]+)([^?#]*)/i.exec(String(url || ""));
    return match ? match[1] + match[2] : "?";
  }

  /* options: { http, token(), log(), warn(), timeoutMs, maxBytes, setTimeout, clearTimeout }
   * `http.get(url, {headers}) -> Promise<response>` where a 2xx resolves and
   * anything else rejects with the same {statusCode, text} dict (IINA's
   * JavascriptAPIHttp.request). */
  function create(options) {
    var opts = options || {};
    var http = opts.http;
    var tokenProvider = opts.token || function () { return null; };
    var log = opts.log || function () {};
    var warn = opts.warn || function () {};
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_MAX_BYTES;
    var defer = opts.setTimeout || (typeof setTimeout === "function" ? setTimeout : null);
    var cancel = opts.clearTimeout || (typeof clearTimeout === "function" ? clearTimeout : null);

    var identity = null;        /* {token, clientId, userId, login, scopes} */
    var validation = null;      /* in-flight validate shared by a burst */

    function fetchJson(url, headers, callback) {
      var request = http && typeof http.get === "function"
        ? http.get(url, { headers: headers || {} })
        : null;
      if (!request || typeof request.then !== "function") { callback("network", null, null); return; }
      var settled = false;
      var timer = defer ? defer(function () {
        if (settled) return;
        settled = true;
        callback("timeout", null, null);
      }, timeoutMs) : null;
      function finish(error, status, data) {
        if (settled) return;
        settled = true;
        if (timer !== null && cancel) cancel(timer);
        callback(error, status, data);
      }
      /* IINA resolves 2xx and rejects every other status with the same dict, so
       * both branches are read as a response. A rejection without a statusCode
       * (a transport failure) becomes "network". */
      function handleResponse(response) {
        if (settled) return;
        var status = response && typeof response.statusCode === "number" ? response.statusCode : null;
        var text = response && typeof response.text === "string" ? response.text : null;
        if (status === null || text === null) { finish("network", status, null); return; }
        log("twitch api: " + logUrl(url) + " -> " + status);
        if (status < 200 || status >= 300) { finish("http " + status, status, null); return; }
        if (text.length > maxBytes) { finish("invalid json", status, null); return; }
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        if (parsed === null || typeof parsed !== "object") { finish("invalid json", status, null); return; }
        finish(null, status, parsed);
      }
      request.then(handleResponse, handleResponse);
    }

    /* Validates the current token once and caches the identity per token. A
     * burst (a browser page load asks for several endpoints at once) shares one
     * /oauth2/validate call: the in-flight validation queues the callbacks. */
    function withIdentity(callback) {
      var token = tokenProvider();
      if (!token) { callback("no token", null, null); return; }
      if (identity && identity.token === token) { callback(null, identity, 200); return; }
      if (validation && validation.token === token) { validation.callbacks.push(callback); return; }
      var current = { token: token, callbacks: [callback] };
      validation = current;
      function settle(error, value, status) {
        if (validation === current) validation = null;
        var callbacks = current.callbacks;
        current.callbacks = [];
        for (var i = 0; i < callbacks.length; i++) callbacks[i](error, value, status);
      }
      fetchJson(VALIDATE_URL, { "Authorization": "OAuth " + token }, function (error, status, json) {
        if (error === "http 401") {
          identity = null;
          settle("token invalid", null, 401);
          return;
        }
        if (error) { settle(error, null, status); return; }
        var clientId = json && typeof json.client_id === "string" ? json.client_id : "";
        if (!clientId) {
          identity = null;
          settle("token invalid", null, status);
          return;
        }
        identity = {
          token: token,
          clientId: clientId,
          userId: json && typeof json.user_id === "string" ? json.user_id : "",
          login: json && typeof json.login === "string" ? json.login : "",
          scopes: json && isArray(json.scopes) ? json.scopes : []
        };
        settle(null, identity, status);
      });
    }

    /* Serves one allowed request. callback(error, status, data) - `data` is the
     * parsed JSON body; /identity is answered from the validate call alone. */
    function request(spec, callback) {
      withIdentity(function (error, value, status) {
        if (error) { callback(error, status === undefined ? null : status, null); return; }
        if (spec.path === IDENTITY_PATH) {
          callback(null, 200, {
            userId: value.userId,
            login: value.login,
            clientId: value.clientId,
            scopes: value.scopes
          });
          return;
        }
        var query = spec.query;
        /* /helix/channels/followed defaults user_id to the validated user (the
         * old /helix/users/follows endpoint is gone: Twitch answers 410 there) */
        if (spec.path === "/helix/channels/followed" && !/(^|&)user_id=/.test(query)) {
          query = (query ? query + "&" : "") + "user_id=" + encodeURIComponent(value.userId);
        }
        var url = API_ORIGIN + spec.path + (query ? "?" + query : "");
        fetchJson(url, {
          "Client-Id": value.clientId,
          "Authorization": "Bearer " + value.token
        }, function (err, resStatus, json) {
          if (err) { callback(err, resStatus === undefined ? null : resStatus, null); return; }
          callback(null, resStatus, json);
        });
      });
    }

    return {
      request: request,
      identity: withIdentity,          /* exposed for tests and for hosts that want it directly */
      cachedIdentity: function () { return identity; },
      dropIdentity: function () { identity = null; }
    };
  }

  return {
    ALLOWED_PATHS: ALLOWED_PATHS,
    IDENTITY_PATH: IDENTITY_PATH,
    API_ORIGIN: API_ORIGIN,
    VALIDATE_URL: VALIDATE_URL,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
    MEDIA_HOSTS: MEDIA_HOSTS,
    allowedPath: allowedPath,
    pathSpec: pathSpec,
    urlSpec: urlSpec,
    requestSpec: requestSpec,
    cleanToken: cleanToken,
    pickToken: pickToken,
    twitchMediaUrl: twitchMediaUrl,
    logUrl: logUrl,
    create: create
  };
});
