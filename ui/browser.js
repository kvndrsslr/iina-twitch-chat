/*
 * ui/browser.js - the sidebar's Twitch browser.
 *
 * All data comes from the plugin proxy, never straight from Twitch:
 *   view -> plugin : "twt:twitch-get"    {id, path}
 *   plugin -> view : "twt:twitch-result" {id, ok, status, data, error}
 * `path` is one of the whitelisted Helix paths (see main.js). The navigation
 * model is a split: a channel row (avatar + name) opens the channel's overview
 * inside the sidebar, and the live item's own affordance (thumbnail + "Watch")
 * opens the stream. VOD rows open https://www.twitch.tv/videos/<id>. The view
 * renders everything with createElement/textContent, because every title,
 * description and display name is attacker-controlled data.
 */

(function (global) {
  "use strict";

  var proto = global.TwitchProtocol;
  var CDN = "https://static-cdn.jtvnw.net";
  var REQUEST_TIMEOUT_MS = 12000;
  var FOLLOW_LIMIT = 100;
  var TOP_LIMIT = 30;
  var VOD_LIMIT = 20;
  var SEARCH_LIMIT = 20;
  /* The standalone video view fans out over the followed channels. Bounded on
   * every axis: at most this many channels are asked, at most this many HTTP
   * requests are in flight, one page per channel, and the merged list is
   * capped. */
  var VOD_FANOUT_CHANNELS = 12;
  var VOD_FANOUT_CONCURRENCY = 4;
  var VOD_FANOUT_PER_CHANNEL = 10;
  var VOD_FANOUT_MAX = 60;

  function $(id) {
    return document.getElementById(id);
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function str(value) {
    return typeof value === "string" ? value : "";
  }

  function obj(value) {
    return value && typeof value === "object" ? value : {};
  }

  function dataList(result) {
    var payload = result && result.data;
    var list = payload && payload.data;
    return isArray(list) ? list : [];
  }

  /* --------------------------------------------------------------- requests */

  var API_ORIGIN = "https://api.twitch.tv";
  var TOKEN_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
  var seq = 0;
  var pending = {};

  /* The same request in the two shapes the two hosts take: the sidebar's Helix
   * proxy reads the allowlisted `path`, the standalone host reads the absolute
   * `url`. One browser.js therefore serves both pages. `/identity` is the
   * plugin's own probe, whose absolute form is the token-validate endpoint. */
  function twitchRequestURL(path) {
    if (path === "/identity") return TOKEN_VALIDATE_URL;
    return API_ORIGIN + path;
  }

  function request(path) {
    return new Promise(function (resolve) {
      var id = "twitch-" + (++seq) + "-" + Date.now();
      var timer = setTimeout(function () {
        delete pending[id];
        resolve({ path: path, ok: false, status: 0, data: null, error: "no reply from the plugin within " + REQUEST_TIMEOUT_MS + "ms" });
      }, REQUEST_TIMEOUT_MS);
      pending[id] = function (result) {
        clearTimeout(timer);
        delete pending[id];
        var payload = result.data;
        if (typeof payload === "string" && payload) {
          try { payload = JSON.parse(payload); } catch (parseError) { /* keep the string */ }
        }
        resolve({
          path: path,
          ok: !!result.ok,
          status: typeof result.status === "number" ? result.status : 0,
          data: payload === undefined ? null : payload,
          error: result.error === undefined ? null : result.error
        });
      };
      try {
        proto.postMessage("twt:twitch-get", { id: id, path: path, url: twitchRequestURL(path) });
      } catch (error) {
        clearTimeout(timer);
        delete pending[id];
        resolve({ path: path, ok: false, status: 0, data: null, error: String(error) });
      }
    });
  }

  proto.onMessage("twt:twitch-result", function (data) {
    if (!data || typeof data.id !== "string") return;
    var settle = pending[data.id];
    if (settle) settle(data);
  });

  /* Responses are cached by full path (every page has its own path) inside the
   * tab the request belongs to, so a view is instant when it is revisited and a
   * refresh of one tab never touches another tab's data. Every loader is handed
   * its tab explicitly, so a reply that arrives after a tab switch still lands
   * in the right cache. The promise itself is stored while the request is in
   * flight, so two callers asking for the same path share one twt:twitch-get;
   * a failed request is dropped so a Retry really retries. */
  function cached(path, tab) {
    var store = tab.cache;
    if (Object.prototype.hasOwnProperty.call(store, path)) {
      return Promise.resolve(store[path]);
    }
    var inFlight = request(path).then(function (result) {
      if (!result.ok) delete store[path];
      return result;
    });
    store[path] = inFlight;
    return inFlight;
  }

  /* ----------------------------------------------------------- identities */

  var identityPromise = null;

  function extractScopes(data) {
    var d = obj(data);
    if (isArray(d.scopes)) {
      return d.scopes.map(function (scope) { return String(scope); });
    }
    return [];
  }

  function ensureIdentity(force) {
    if (identityPromise && !force) return identityPromise;
    identityPromise = request("/identity").then(function (result) {
      if (!result.ok) return { ok: false, error: describeError(result) };
      var d = obj(result.data);
      return {
        ok: true,
        login: str(d.login),
        userId: str(d.user_id || d.userId),
        scopes: extractScopes(d)
      };
    });
    return identityPromise;
  }

  function resetIdentity() {
    identityPromise = null;
  }

  function errorText(result) {
    var data = obj(result && result.data);
    if (typeof data.message === "string" && data.message) return data.message;
    return str(result && result.error);
  }

  function describeError(result) {
    var status = (result && result.status) || 0;
    var raw = str(result && result.error);
    var message = errorText(result);
    var combined = raw + " " + message;
    if (status === 401 || /invalid access token|invalid token|token invalid|unauthorized/i.test(combined)) {
      return {
        kind: "token-invalid",
        title: "Token invalid",
        text: "Twitch rejected the saved token. Add a new one in IINA \u2192 Settings \u2192 Twitch, then Retry."
      };
    }
    if (status === 410) {
      return {
        kind: "endpoint-gone",
        title: "Endpoint removed",
        text: "Twitch removed the API this view used (HTTP 410 Gone). Following now uses /helix/channels/followed \u2014 Retry, and update the plugin if this keeps happening."
      };
    }
    if (/no token|missing token|not (set|configured)|unauthorised|unauthorized/i.test(combined)) {
      return {
        kind: "no-token",
        title: "No token",
        text: "No OAuth token is available. Add one in IINA \u2192 Settings \u2192 Twitch, then Retry."
      };
    }
    if (/scope/i.test(combined)) {
      return {
        kind: "scope",
        title: "Missing permission",
        text: "The token does not grant the permission this view needs. Re-authorise it, then Retry."
      };
    }
    return {
      kind: "network",
      title: "Could not load",
      text: (raw || message || ("HTTP " + status)) + " \u2014 check the connection, then Retry."
    };
  }

  /* ------------------------------------------------------------- DOM helpers */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function attach(parent, child) {
    parent.appendChild(child);
    return child;
  }

  /* Twitch image hosts. A just-processing VOD's thumbnail is served from
   * vod-secure.twitch.tv (measured), and every Twitch image CDN lives under
   * *.jtvnw.net, so those two plus the static host are accepted; everything
   * else - other hosts, plain http, protocol-relative URLs - is rejected and
   * rendered as a placeholder. Both hosts are already permitted at the IINA
   * layer: static-cdn.jtvnw.net and *.jtvnw.net match Info.json's
   * allowedDomains, and *.twitch.tv covers vod-secure.twitch.tv. */
  var IMAGE_HOSTS = {
    "static-cdn.jtvnw.net": 1,
    "vod-secure.twitch.tv": 1
  };

  function twitchImageURL(url) {
    if (typeof url !== "string" || url.indexOf("https://") !== 0) return "";
    var rest = url.slice("https://".length);
    var slash = rest.indexOf("/");
    if (slash === -1) return "";
    var host = rest.slice(0, slash).toLowerCase();
    if (!host) return "";
    if (IMAGE_HOSTS[host]) return url;
    if (/\.jtvnw\.net$/.test(host)) return url;
    return "";
  }

  /* An image in a fixed-size box: the box reserves the slot (so a late or
   * failed image never shifts the row) and a missing / non-Twitch / errored
   * image leaves the box's neutral background instead of a broken icon. When a
   * `fallback` is given (the live preview for a VOD row) the first error swaps
   * to it once; if that also fails the box goes back to the placeholder. */
  function imageBox(url, imgClass, alt, boxClass, fallback) {
    var wrap = el("span", "twt-image-box " + (boxClass || ""));
    var primary = twitchImageURL(url);
    var spare = twitchImageURL(fallback);
    if (!primary && !spare) {
      wrap.classList.add("twt-art-placeholder");
      return wrap;
    }
    var img = document.createElement("img");
    img.className = imgClass;
    img.src = primary || spare;
    img.alt = alt || "";
    img.loading = "lazy";
    /* the spare is only held when it is not already the primary source */
    var attempt = primary && spare ? spare : "";
    img.addEventListener("error", function () {
      if (attempt) {
        img.src = attempt;
        attempt = "";
        return;
      }
      img.hidden = true;
      wrap.classList.add("twt-art-placeholder");
    });
    attach(wrap, img);
    return wrap;
  }

  /* Helix templates come in two flavours: VOD thumbnails use "%{width}", game
   * box art uses "{width}". The percent form must be replaced first, otherwise
   * its "{width}" suffix would be left behind as "%285". */
  function templateURL(url, width, height) {
    if (typeof url !== "string" || !url) return "";
    return url
      .split("%{width}").join(String(width))
      .split("%{height}").join(String(height))
      .split("{width}").join(String(width))
      .split("{height}").join(String(height));
  }

  function previewURL(login) {
    var clean = String(login || "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(clean)) return "";
    return CDN + "/previews-ttv/live_user_" + clean + "-640x360.jpg";
  }

  /* Twitch serves this marker (observed as
   * https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png)
   * for a broadcast whose VOD is still being generated: a real URL on a
   * whitelisted host that is not real art. It counts as "no thumbnail", so it
   * is never requested and the live preview is used instead. */
  function processingThumbnail(url) {
    return /_404\/404_processing_/i.test(str(url));
  }

  /* A VOD's own art, or - when it has none yet (empty or the processing
   * marker) - the live stream's thumbnail while the channel is broadcasting. */
  function vodThumbnail(video, live) {
    var url = str(video && video.thumbnail_url);
    if (url && !processingThumbnail(url)) return templateURL(url, 160, 90);
    return live ? templateURL(str(live.thumbnail_url), 160, 90) : "";
  }

  function formatCount(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return "";
    if (number >= 1000000) return (number / 1000000).toFixed(number >= 10000000 ? 0 : 1) + "M";
    if (number >= 1000) return (number / 1000).toFixed(number >= 10000 ? 0 : 1) + "K";
    return String(Math.round(number));
  }

  function formatUptime(startedAt) {
    var started = Date.parse(startedAt);
    if (!isFinite(started)) return "";
    var seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    if (days) return days + "d " + hours + "h";
    if (hours) return hours + "h " + minutes + "m";
    if (minutes) return minutes + "m";
    return seconds + "s";
  }

  function formatDuration(value) {
    var match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(str(value));
    if (!match) return str(value);
    var hours = match[1] ? parseInt(match[1], 10) : 0;
    var minutes = match[2] ? parseInt(match[2], 10) : 0;
    var seconds = match[3] ? parseInt(match[3], 10) : 0;
    function pad(number) { return number < 10 ? "0" + number : String(number); }
    if (hours) return hours + ":" + pad(minutes) + ":" + pad(seconds);
    return minutes + ":" + pad(seconds);
  }

  function formatDate(value) {
    var time = Date.parse(value);
    if (!isFinite(time)) return "";
    var date = new Date(time);
    var month = date.getMonth() + 1;
    var day = date.getDate();
    return date.getFullYear() + "-" + (month < 10 ? "0" + month : month) + "-" + (day < 10 ? "0" + day : day);
  }

  function vodTime(video) {
    var time = Date.parse(str(video && (video.published_at || video.created_at)));
    return isFinite(time) ? time : 0;
  }

  /* Appends `videos` to `target`, dropping ids already present (the fan-out
   * over followed channels overlaps whenever a channel is followed twice or a
   * video shows up in two pages). */
  function mergeVods(target, videos) {
    var seen = {};
    var i;
    for (i = 0; i < target.length; i++) seen[str(target[i].id)] = true;
    for (i = 0; i < videos.length; i++) {
      var video = videos[i];
      var id = str(video && video.id);
      if (!id || seen[id]) continue;
      seen[id] = true;
      target.push(video);
    }
  }

  function sortVods(list) {
    list.sort(function (a, b) { return vodTime(b) - vodTime(a); });
  }

  /* --------------------------------------------------------------- elements */

  var titleEl = $("browser-title");
  var backEl = $("browser-back");
  var refreshEl = $("browser-refresh");

  /* ------------------------------------------------------------------ tabs
   *
   * Six tabs; the five browse tabs each own their own view stack, their own
   * rendered DOM and their own response cache, so switching away and back
   * never refetches and never loses a stack. Only the refresh button drops the
   * active tab's cache and refetches that tab.
   */

  var TABS = [
    { id: "following", label: "Following", title: "Following" },
    { id: "top", label: "Top", title: "Top streams" },
    { id: "categories", label: "Categories", title: "Categories" },
    { id: "search", label: "Search", title: "Search channels" },
    { id: "videos", label: "Videos", title: "Videos" },
    { id: "settings", label: "Settings", title: "Settings" }
  ];
  var tabs = {};
  var activeId = "following";

  function activeTab() {
    return tabs[activeId];
  }

  function isSettingsTab(tab) {
    return tab.id === "settings";
  }

  function initTabs() {
    for (var i = 0; i < TABS.length; i++) {
      var spec = TABS[i];
      /* One script, two pages: a tab whose pane is not in this document (the
       * standalone window has no Settings pane) is skipped entirely, so it
       * never becomes a dead button or an empty view. */
      var pane = $("pane-" + spec.id);
      if (!pane) continue;
      var tab = {
        id: spec.id,
        label: spec.label,
        title: spec.title,
        button: $("tab-" + spec.id),
        pane: pane,
        stack: [],
        current: null,
        cache: {},
        rendered: false,
        /* bumped by render(): every reply of an older generation is dropped */
        generation: 0,
        /* per-tab query state: the field keeps its value when the tab is left
         * and re-entered, and a refresh re-runs the query */
        query: "",
        queryTimer: null,
        videos: []
      };
      tabs[spec.id] = tab;
      if (tab.button) {
        tab.button.addEventListener("click", (function (chosen) {
          return function () { selectTab(chosen.id); };
        })(tab));
      }
    }
  }

  /* The nav title and the back button reflect the active tab's top of stack. */
  function navTitle(tab) {
    var descriptor = tab.current;
    if (!descriptor) return tab.title;
    if (descriptor.type === "channel") return descriptor.login ? "#" + descriptor.login : "Channel";
    if (descriptor.type === "category") return descriptor.name || "Category";
    return tab.title;
  }

  function updateNav() {
    var tab = activeTab();
    if (!tab) return;
    if (titleEl) titleEl.textContent = navTitle(tab);
    if (backEl) backEl.hidden = isSettingsTab(tab) || !tab.stack.length;
    if (refreshEl) refreshEl.hidden = isSettingsTab(tab);
  }

  function selectTab(id) {
    if (!tabs[id]) return;
    activeId = id;
    for (var key in tabs) {
      var tab = tabs[key];
      if (tab.pane) tab.pane.hidden = key !== id;
      if (tab.button) {
        if (key === id) tab.button.classList.add("twt-tab-active");
        else tab.button.classList.remove("twt-tab-active");
        tab.button.setAttribute("aria-selected", key === id ? "true" : "false");
      }
    }
    updateNav();
    var active = tabs[id];
    if (!isSettingsTab(active) && !active.rendered) {
      active.rendered = true;
      show(active, active.current);
    }
  }

  function noteNode(text) {
    return el("div", "twt-browser-note", text);
  }

  /* An error card from a described error object (title + text). */
  function errorCard(error, retry) {
    var box = el("div", "twt-browser-error");
    attach(box, el("div", "twt-browser-error-title", error.title || "Could not load"));
    attach(box, el("div", "twt-browser-error-text", error.text || ""));
    var button = el("button", "twt-btn", "Retry");
    button.type = "button";
    button.setAttribute("data-action", "retry");
    button.addEventListener("click", function () { retry(); });
    attach(box, button);
    return box;
  }

  function errorNode(result, retry) {
    return errorCard(describeError(result), retry);
  }

  function loadMoreButton(label, onClick) {
    var button = el("button", "twt-btn twt-load-more", label || "Load more");
    button.type = "button";
    button.setAttribute("data-action", "load-more");
    button.addEventListener("click", function () {
      button.disabled = true;
      onClick();
    });
    return button;
  }

  function row(kind, className) {
    var node = el("div", "twt-browser-row " + (className || ""));
    node.setAttribute("data-kind", kind);
    return node;
  }

  function bindNavigate(node, action) {
    node.addEventListener("click", function (event) {
      if (event && event.preventDefault) event.preventDefault();
      action();
    });
  }

  /* Opens a stream or a VOD. `isolate` stops the click from also reaching a
   * navigating row the affordance sits inside. */
  function bindOpen(node, kind, value, isolate) {
    function open(target) {
      var url = kind === "vod"
        ? "https://www.twitch.tv/videos/" + encodeURIComponent(String(value))
        : "https://www.twitch.tv/" + encodeURIComponent(String(value));
      proto.postMessage("twt:open", { url: url, target: target });
    }
    node.addEventListener("click", function (event) {
      if (event && event.preventDefault) event.preventDefault();
      if (isolate && event && event.stopPropagation) event.stopPropagation();
      open(event && event.metaKey ? "new" : "current");
    });
    node.addEventListener("auxclick", function (event) {
      if (event && event.button === 1) {
        if (event.preventDefault) event.preventDefault();
        if (isolate && event.stopPropagation) event.stopPropagation();
        open("new");
      }
    });
  }

  /* The live item's own affordance: a thumbnail and a Watch button. It opens
   * the stream (physical click = active window, meta/middle = new window) and
   * never navigates. */
  function watchAffordance(login) {
    var box = el("span", "twt-live-affordance");
    box.setAttribute("data-action", "watch");
    attach(box, imageBox(previewURL(login), "twt-stream-thumb", "", "twt-stream-box"));
    var button = el("button", "twt-btn twt-watch", "Watch");
    button.type = "button";
    attach(box, button);
    bindOpen(box, "stream", login, true);
    return box;
  }

  /* ------------------------------------------------------------ row builders */

  function normalizeFollow(entry) {
    var follow = obj(entry);
    var login = str(follow.broadcaster_login || follow.to_login || follow.login).toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return null;
    return {
      login: login,
      name: str(follow.broadcaster_name || follow.to_name || follow.name) || login,
      id: str(follow.broadcaster_id || follow.to_id || follow.user_id)
    };
  }

  /* Case-insensitive comparison of the display name (login as the tie-break),
   * done on lower-cased code points so the order is identical in the harness
   * and in the web view - localeCompare() would depend on the environment. */
  function compareFollowNames(a, b) {
    var nameA = str(a.name || a.login).toLowerCase();
    var nameB = str(b.name || b.login).toLowerCase();
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    var loginA = str(a.login);
    var loginB = str(b.login);
    if (loginA < loginB) return -1;
    if (loginA > loginB) return 1;
    return 0;
  }

  function viewerCount(live) {
    var count = Number(live && live.viewer_count);
    return isFinite(count) ? count : -1;
  }

  /* The accumulated list is sorted as a whole on every render (never per page):
   * live channels first by viewer count descending, then everything offline by
   * name ascending. A channel that flips live/offline therefore lands in the
   * right group instead of where it was first appended. */
  function sortFollows(list, live) {
    list.sort(function (a, b) {
      var liveA = live[a.login] ? 1 : 0;
      var liveB = live[b.login] ? 1 : 0;
      if (liveA !== liveB) return liveB - liveA;
      if (liveA) {
        var countA = viewerCount(live[a.login]);
        var countB = viewerCount(live[b.login]);
        if (countA !== countB) return countB - countA;
      }
      return compareFollowNames(a, b);
    });
  }

  function followRow(tab, follow, live, avatar) {
    var node = row("follow", "twt-follow");
    node.setAttribute("data-login", follow.login);
    if (live) node.setAttribute("data-live", "true");
    attach(node, imageBox(avatar, "twt-follow-avatar", follow.name, "twt-avatar-box"));
    var main = attach(node, el("div", "twt-browser-row-main"));
    attach(main, el("span", "twt-browser-name", follow.name));
    if (live) {
      var meta = attach(main, el("span", "twt-browser-meta"));
      var parts = [];
      if (live.game_name) parts.push(str(live.game_name));
      if (live.viewer_count !== undefined) parts.push(formatCount(live.viewer_count) + " viewers");
      meta.textContent = parts.join(" \u00b7 ");
      if (live.title) attach(main, el("span", "twt-browser-title", str(live.title)));
      attach(node, watchAffordance(follow.login));
    } else {
      attach(main, el("span", "twt-browser-meta", "offline"));
    }
    bindNavigate(node, function () {
      pushAndShow(tab, { type: "channel", login: follow.login });
    });
    return node;
  }

  /* A live stream row: the channel part navigates to the overview, the Watch
   * affordance opens the stream. */
  function streamRow(tab, stream) {
    var node = row("stream", "twt-stream");
    var login = str(stream.user_login).toLowerCase();
    node.setAttribute("data-login", login);
    node.setAttribute("data-id", str(stream.id));
    var main = attach(node, el("div", "twt-browser-row-main"));
    attach(main, el("span", "twt-browser-name", str(stream.user_name) || login));
    if (stream.title) attach(main, el("span", "twt-browser-title", str(stream.title)));
    var meta = attach(main, el("span", "twt-browser-meta"));
    var parts = [];
    if (stream.game_name) parts.push(str(stream.game_name));
    if (stream.viewer_count !== undefined) parts.push(formatCount(stream.viewer_count) + " viewers");
    var uptime = formatUptime(stream.started_at);
    if (uptime) parts.push("live " + uptime);
    meta.textContent = parts.join(" \u00b7 ");
    attach(node, watchAffordance(login));
    bindNavigate(node, function () {
      pushAndShow(tab, { type: "channel", login: login });
    });
    return node;
  }

  /* A VOD row. A broadcast that is still running has no VOD thumbnail of its
   * own: Helix either omits it or answers with Twitch's processing marker, so
   * both cases fall back to the live stream's thumbnail for that channel (only
   * when the channel is actually live). Whatever it ends up with still goes
   * through the image host guard, and if the image itself fails the box swaps
   * once to the live preview before giving up. */
  function vodRow(video, live) {
    var node = row("vod", "twt-vod");
    var videoId = str(video.id);
    node.setAttribute("data-id", videoId);
    var liveThumb = live ? templateURL(str(live.thumbnail_url), 160, 90) : "";
    attach(node, imageBox(vodThumbnail(video, live), "twt-vod-thumb", "", "twt-vod-box", liveThumb));
    var main = attach(node, el("div", "twt-browser-row-main"));
    if (video.title) attach(main, el("span", "twt-browser-title", str(video.title)));
    var meta = attach(main, el("span", "twt-browser-meta"));
    var parts = [];
    var duration = formatDuration(video.duration);
    if (duration) parts.push(duration);
    var date = formatDate(video.published_at || video.created_at);
    if (date) parts.push(date);
    if (video.view_count !== undefined) parts.push(formatCount(video.view_count) + " views");
    meta.textContent = parts.join(" \u00b7 ");
    bindOpen(node, "vod", videoId, false);
    return node;
  }

  function categoryRow(tab, game) {
    var node = row("category", "twt-category");
    var gameId = str(game.id);
    node.setAttribute("data-id", gameId);
    attach(node, imageBox(templateURL(str(game.box_art_url), 285, 380), "twt-game-art", str(game.name), "twt-art-box"));
    var main = attach(node, el("div", "twt-browser-row-main"));
    attach(main, el("span", "twt-browser-name", str(game.name)));
    bindNavigate(node, function () {
      pushAndShow(tab, { type: "category", id: gameId, name: str(game.name) });
    });
    return node;
  }

  /* A /helix/search/channels entry: it is a channel, so it opens the overview
   * (whose Videos section is where its VODs live). */
  function searchChannelRow(tab, entry) {
    var login = str(entry.broadcaster_login).toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return null;
    var name = str(entry.display_name) || login;
    var node = row("search-channel", "twt-search-channel");
    node.setAttribute("data-login", login);
    attach(node, imageBox(str(entry.thumbnail_url), "twt-follow-avatar", name, "twt-avatar-box"));
    var main = attach(node, el("div", "twt-browser-row-main"));
    attach(main, el("span", "twt-browser-name", name));
    var metaParts = [];
    if (entry.is_live) metaParts.push("live now");
    if (entry.game_name) metaParts.push(str(entry.game_name));
    if (entry.title) metaParts.push(str(entry.title));
    attach(main, el("span", "twt-browser-meta", metaParts.join(" \u00b7 ") || "offline"));
    if (entry.is_live) attach(node, watchAffordance(login));
    bindNavigate(node, function () {
      pushAndShow(tab, { type: "channel", login: login });
    });
    return node;
  }

  /* ------------------------------------------------------------ view plumbing */

  function listBody(target, nodes) {
    clear(target);
    for (var i = 0; i < nodes.length; i++) attach(target, nodes[i]);
  }

  function loading(target) {
    listBody(target, [noteNode("Loading\u2026")]);
  }

  function render(descriptor, tab) {
    /* A re-render (navigation, refresh, retry) supersedes every reply of the
     * previous one: loaders capture tab.generation and drop stale writes. The
     * pending query debounce belongs to the field this render replaces. */
    tab.generation++;
    if (tab.queryTimer) {
      clearTimeout(tab.queryTimer);
      tab.queryTimer = null;
    }
    if (!descriptor) renderRoot(tab);
    else if (descriptor.type === "category") renderCategory(descriptor, tab);
    else if (descriptor.type === "channel") renderChannel(descriptor, tab);
  }

  function renderRoot(tab) {
    if (tab.id === "following") renderFollowing(tab);
    else if (tab.id === "top") renderTop(tab);
    else if (tab.id === "categories") renderCategories(tab);
    else if (tab.id === "search") renderSearch(tab);
    else if (tab.id === "videos") renderVideos(tab);
  }

  function show(tab, descriptor) {
    tab.current = descriptor;
    render(descriptor, tab);
    if (tab === activeTab()) updateNav();
  }

  function pushAndShow(tab, descriptor) {
    tab.stack.push(tab.current);
    show(tab, descriptor);
  }

  function goBack(tab) {
    if (!tab.stack.length) return;
    show(tab, tab.stack.pop());
  }

  /* Refresh refetches only the active tab: drop its cache and re-render its
   * current view. The other tabs keep their DOM and issue no request. */
  function refresh() {
    var tab = activeTab();
    if (!tab || isSettingsTab(tab)) return;
    tab.cache = {};
    render(tab.current, tab);
  }

  function showError(target, error, retry) {
    if (!target) return;
    clear(target);
    attach(target, errorCard(error, retry));
  }

  function makeSection(title) {
    var section = el("section", "twt-browser-section");
    attach(section, el("h2", "twt-browser-heading", title));
    return { root: section, list: attach(section, el("div", "twt-browser-list")) };
  }

  /* ------------------------------------------------------------------ tabs */

  function renderFollowing(tab) {
    var target = tab.pane;
    if (!target) return;
    var generation = tab.generation;
    clear(target);
    loading(target);
    ensureIdentity().then(function (identity) {
      if (tab.generation !== generation) return;
      if (!identity.ok) {
        showError(target, identity.error, function () {
          resetIdentity();
          render(tab.current, tab);
        });
        return;
      }
      if (identity.scopes.length && identity.scopes.indexOf("user:read:follows") === -1) {
        listBody(target, [noteNode("Following needs the user:read:follows permission. Re-authorise the token to see the channels you follow.")]);
        return;
      }
      if (!identity.userId) {
        listBody(target, [errorCard({ title: "No user id", text: "The token did not reveal a user id, so followed channels cannot be listed." }, function () {
          resetIdentity();
          render(tab.current, tab);
        })]);
        return;
      }
      loadFollowing(target, identity.userId, tab);
    });
  }

  function renderTop(tab) {
    var target = tab.pane;
    if (!target) return;
    clear(target);
    loading(target);
    loadTopStreams(target, tab, tab.generation);
  }

  /* The Categories tab: a search field over /helix/search/categories, and
   * Twitch's own top-games list when the field is empty.
   *
   * /helix/games/top returns only id/name/box_art_url/igdb_id - there is no
   * viewer count in the payload (measured), and one /helix/streams call per row
   * would be N requests for a number that is still only a page-capped sample.
   * The rows therefore carry no count. The top-list order is Twitch's own
   * popularity order (its cursor encodes the sort token); it is not sorted
   * here. */
  function renderCategories(tab) {
    var target = tab.pane;
    if (!target) return;
    clear(target);
    attach(target, searchField(tab, "Search categories", "category-search", function (query) {
      tab.query = query;
      renderCategoryResults(tab);
    }));
    tab.listEl = attach(target, el("div", "twt-browser-list twt-category-results"));
    renderCategoryResults(tab);
  }

  function renderCategoryResults(tab) {
    var target = tab.listEl;
    if (!target) return;
    if (!tab.query) {
      loading(target);
      loadCategories(target, tab);
      return;
    }
    searchCategories(tab.query, target, tab);
  }

  function searchCategories(query, target, tab) {
    var generation = tab.generation;
    loading(target);
    var path = "/helix/search/categories?query=" + encodeURIComponent(query) + "&first=" + SEARCH_LIMIT;
    cached(path, tab).then(function (result) {
      /* a newer query (or a re-render) owns the list now */
      if (tab.generation !== generation || tab.query !== query) return;
      if (!result.ok) {
        listBody(target, [errorNode(result, function () { searchCategories(query, target, tab); })]);
        return;
      }
      var rows = dataList(result);
      var nodes = [];
      for (var i = 0; i < rows.length; i++) nodes.push(categoryRow(tab, rows[i]));
      if (!nodes.length) {
        listBody(target, [noteNode("No categories match \u201c" + query + "\u201d.")]);
        return;
      }
      listBody(target, nodes);
    });
  }

  /* Twitch retired GET /helix/users/follows (HTTP 410 Gone); the supported
   * call is GET /helix/channels/followed?user_id=<viewer>&first=100, which
   * needs the user:read:follows scope and returns broadcaster identity plus a
   * pagination cursor. Pages render on demand: the first page immediately and
   * a "Load more" button for the next 100. */
  function followedPath(userId, cursor) {
    var path = "/helix/channels/followed?user_id=" + encodeURIComponent(userId) +
      "&first=" + FOLLOW_LIMIT;
    if (cursor) path += "&after=" + encodeURIComponent(cursor);
    return path;
  }

  function usersPath(logins) {
    var query = "";
    for (var i = 0; i < logins.length && i < FOLLOW_LIMIT; i++) {
      if (query) query += "&";
      query += "login=" + encodeURIComponent(logins[i]);
    }
    return "/helix/users" + (query ? "?" + query : "");
  }

  /* A followed page is appended once per login: cursor pages overlap when the
   * user follows/unfollows mid-page, and a repeated entry must not render a
   * second row for the same channel. */
  function mergeFollows(target, page) {
    var seen = {};
    var i;
    for (i = 0; i < target.length; i++) seen[target[i].login] = true;
    for (i = 0; i < page.length; i++) {
      var follow = page[i];
      if (!follow || seen[follow.login]) continue;
      seen[follow.login] = true;
      target.push(follow);
    }
  }

  /* One batched /helix/streams?user_login=a&user_login=b... call per follow
   * page (Helix accepts up to 100 user_login filters, and a page is 100
   * entries): the cheapest correct way to learn which follows are live. One
   * batched /helix/users?login=a&login=b call brings the avatars for the same
   * page. The page renders as soon as it arrives, so the list, its cursor and
   * its rows are usable while the live/avatar replies are still out. */
  function loadFollowing(target, userId, tab) {
    var generation = tab.generation;
    var state = {
      follows: [],
      live: {},
      avatars: {},
      cursor: "",
      loading: false,
      error: null
    };

    function renderList() {
      sortFollows(state.follows, state.live);
      var nodes = [];
      for (var i = 0; i < state.follows.length; i++) {
        var follow = state.follows[i];
        nodes.push(followRow(tab, follow, state.live[follow.login], state.avatars[follow.login]));
      }
      if (state.error) {
        /* keep the rows already rendered; Retry re-fetches the same page */
        nodes.push(errorNode(state.error, function () {
          state.error = null;
          fetchPage();
        }));
      } else if (state.loading) {
        nodes.push(noteNode("Loading\u2026"));
      } else if (!state.follows.length) {
        nodes.push(noteNode("You do not follow any channels yet."));
      } else if (state.cursor) {
        nodes.push(loadMoreButton("Load more", fetchPage));
      }
      listBody(target, nodes);
    }

    function loadAvatars(page) {
      var logins = [];
      for (var i = 0; i < page.length; i++) logins.push(page[i].login);
      if (!logins.length) return;
      cached(usersPath(logins), tab).then(function (result) {
        if (tab.generation !== generation) return;
        if (!result.ok) return;
        var users = dataList(result);
        var changed = false;
        for (var j = 0; j < users.length; j++) {
          var login = str(users[j].login).toLowerCase();
          var url = str(users[j].profile_image_url);
          if (login && url && state.avatars[login] !== url) {
            state.avatars[login] = url;
            changed = true;
          }
        }
        if (changed) renderList();
      });
    }

    function fetchPage() {
      if (state.loading) return;
      state.loading = true;
      renderList();
      cached(followedPath(userId, state.cursor), tab).then(function (result) {
        if (tab.generation !== generation) return;
        state.loading = false;
        if (!result.ok) {
          if (isScopeError(result)) {
            listBody(target, [noteNode("Following needs the user:read:follows permission.")]);
            return;
          }
          state.error = result;
          renderList();
          return;
        }
        var rows = dataList(result);
        var page = [];
        for (var i = 0; i < rows.length; i++) {
          var follow = normalizeFollow(rows[i]);
          if (follow) page.push(follow);
        }
        state.error = null;
        state.cursor = str(obj(obj(result.data).pagination).cursor);
        if (!page.length) {
          state.cursor = "";
          renderList();
          return;
        }
        /* the rows (and the next cursor) exist before the live batch lands */
        mergeFollows(state.follows, page);
        renderList();
        loadAvatars(page);
        var query = "";
        for (i = 0; i < page.length; i++) query += "&user_login=" + encodeURIComponent(page[i].login);
        var path = "/helix/streams?first=" + Math.max(page.length, 1) + query;
        cached(path, tab).then(function (liveResult) {
          if (tab.generation !== generation) return;
          /* this page's logins are re-evaluated from scratch: a channel the
           * previous page reported live is offline when this page's batch does
           * not return it, and it keeps no stale viewer count */
          var asked = {};
          for (var k = 0; k < page.length; k++) asked[page[k].login] = true;
          for (var askedLogin in asked) {
            if (Object.prototype.hasOwnProperty.call(asked, askedLogin)) delete state.live[askedLogin];
          }
          if (liveResult && liveResult.ok) {
            var streams = dataList(liveResult);
            for (var j = 0; j < streams.length; j++) {
              state.live[str(streams[j].user_login).toLowerCase()] = streams[j];
            }
          }
          renderList();
        });
      });
    }

    fetchPage();
  }

  function isScopeError(result) {
    return /scope/i.test(str(result && result.error) + " " + errorText(result));
  }

  function loadTopStreams(target, tab, generation) {
    var expected = generation === undefined ? tab.generation : generation;
    cached("/helix/streams?first=" + TOP_LIMIT, tab).then(function (result) {
      if (tab.generation !== expected) return;
      if (!result.ok) {
        listBody(target, [errorNode(result, function () { loadTopStreams(target, tab); })]);
        return;
      }
      var rows = dataList(result);
      if (!rows.length) {
        listBody(target, [noteNode("No live streams right now.")]);
        return;
      }
      var nodes = [];
      for (var i = 0; i < rows.length; i++) nodes.push(streamRow(tab, rows[i]));
      listBody(target, nodes);
    });
  }

  function loadCategories(target, tab) {
    var generation = tab.generation;
    cached("/helix/games/top?first=" + TOP_LIMIT, tab).then(function (result) {
      if (tab.generation !== generation) return;
      if (!result.ok) {
        listBody(target, [errorNode(result, function () { loadCategories(target, tab); })]);
        return;
      }
      var rows = dataList(result);
      if (!rows.length) {
        listBody(target, [noteNode("No categories available.")]);
        return;
      }
      var nodes = [];
      for (var i = 0; i < rows.length; i++) nodes.push(categoryRow(tab, rows[i]));
      listBody(target, nodes);
    });
  }

  /* --------------------------------------------------------------- category */

  function renderCategory(descriptor, tab) {
    var target = tab.pane;
    if (!target) return;
    clear(target);
    var list = attach(target, el("div", "twt-browser-list twt-browser-list-grid"));
    loading(list);
    var path = "/helix/streams?first=" + TOP_LIMIT + "&game_id=" + encodeURIComponent(str(descriptor.id));
    var generation = tab.generation;
    cached(path, tab).then(function (result) {
      if (tab.generation !== generation) return;
      if (!result.ok) {
        listBody(list, [errorNode(result, function () { renderCategory(descriptor, tab); })]);
        return;
      }
      var rows = dataList(result);
      if (!rows.length) {
        listBody(list, [noteNode("No live streams in this category right now.")]);
        return;
      }
      var nodes = [];
      for (var i = 0; i < rows.length; i++) nodes.push(streamRow(tab, rows[i]));
      listBody(list, nodes);
    });
  }

  /* ---------------------------------------------------------------- channel */

  var VOD_TYPES = [
    { value: "archive", label: "Archive" },
    { value: "highlight", label: "Highlights" },
    { value: "upload", label: "Uploads" }
  ];

  function vodTemplatesKey(type) {
    for (var i = 0; i < VOD_TYPES.length; i++) {
      if (VOD_TYPES[i].value === type) return VOD_TYPES[i].label;
    }
    return type;
  }

  function vodPath(userId, type, cursor) {
    var path = "/helix/videos?user_id=" + encodeURIComponent(userId) +
      "&type=" + encodeURIComponent(type) +
      "&first=" + VOD_LIMIT;
    if (cursor) path += "&after=" + encodeURIComponent(cursor);
    return path;
  }

  /* A paged, filtered VOD list for one channel. `state` is per channel view, so
   * switching the filter starts a fresh list and Load more appends the next
   * cursor page; both sort newest first and dedupe by id. */
  function loadVods(state, target, tab) {
    if (state.loading || !state.userId) return;
    var generation = tab.generation;
    state.loading = true;
    renderVodList(state, target, tab);
    cached(vodPath(state.userId, state.type, state.cursor), tab).then(function (result) {
      if (tab.generation !== generation) return;
      state.loading = false;
      if (!result.ok) {
        /* keep the rows already rendered; Retry re-fetches this same page */
        state.error = result;
        renderVodList(state, target, tab);
        return;
      }
      state.error = null;
      state.cursor = str(obj(obj(result.data).pagination).cursor);
      var page = dataList(result);
      if (!page.length) state.cursor = "";
      mergeVods(state.items, page);
      sortVods(state.items);
      renderVodList(state, target, tab);
    });
  }

  function renderVodList(state, target, tab) {
    var nodes = [];
    for (var i = 0; i < state.items.length; i++) {
      var item = state.items[i];
      nodes.push(vodRow(item, state.live[str(item.user_login).toLowerCase()]));
    }
    if (state.error) {
      nodes.push(errorNode(state.error, function () {
        state.error = null;
        loadVods(state, target, tab);
      }));
    } else if (state.loading) {
      nodes.push(noteNode("Loading\u2026"));
    } else if (!state.items.length) {
      nodes.push(noteNode("No " + vodTemplatesKey(state.type).toLowerCase() + " videos."));
    } else if (state.cursor) {
      nodes.push(loadMoreButton("Load more", function () { loadVods(state, target, tab); }));
    }
    listBody(target, nodes);
  }

  function vodTypeSelect(state, target, tab) {
    var select = el("select", "twt-select twt-vod-type");
    select.setAttribute("data-action", "vod-type");
    for (var i = 0; i < VOD_TYPES.length; i++) {
      var option = document.createElement("option");
      option.value = VOD_TYPES[i].value;
      option.textContent = VOD_TYPES[i].label;
      select.appendChild(option);
    }
    select.value = state.type;
    select.addEventListener("change", function () {
      state.type = select.value;
      state.items = [];
      state.cursor = "";
      state.error = null;
      loadVods(state, target, tab);
    });
    return select;
  }

  function renderChannel(descriptor, tab) {
    var login = str(descriptor.login).toLowerCase();
    var target = tab.pane;
    if (!target) return;
    var generation = tab.generation;
    clear(target);
    var headerBox = attach(target, el("div", "twt-channel-header"));
    var liveBox = attach(target, el("div", "twt-channel-live"));
    var vodSection = makeSection("Videos");
    attach(target, vodSection.root);
    var state = { userId: "", type: "archive", items: [], cursor: "", loading: false, error: null, live: {} };
    var controls = el("div", "twt-vod-controls");
    attach(controls, el("label", "twt-vod-label", "Type"));
    attach(controls, vodTypeSelect(state, vodSection.list, tab));
    vodSection.root.insertBefore(controls, vodSection.list);
    loading(headerBox);
    loading(vodSection.list);

    cached("/helix/users?login=" + encodeURIComponent(login), tab).then(function (result) {
      if (tab.generation !== generation) return;
      if (!result.ok) {
        showError(target, describeError(result), function () {
          render(tab.current || { type: "channel", login: login }, tab);
        });
        return;
      }
      var user = normalizeUser(dataList(result)[0]);
      if (!user) {
        showError(target, { title: "Channel not found", text: "No channel named " + login + "." }, function () { goBack(tab); });
        return;
      }
      renderChannelHeader(headerBox, user);

      cached("/helix/streams?user_login=" + encodeURIComponent(login), tab).then(function (liveResult) {
        if (tab.generation !== generation) return;
        var live = liveResult.ok ? dataList(liveResult)[0] : null;
        clear(liveBox);
        if (live) {
          attach(liveBox, liveBlock(live));
          /* the in-flight broadcast's VOD has no thumbnail of its own; keep the
           * live stream so the VOD list can fall back to its thumbnail. The box
           * sizes are fixed, so re-rendering never reorders or jumps the list. */
          state.live[login] = live;
          renderVodList(state, vodSection.list, tab);
        } else {
          attach(liveBox, noteNode("Offline right now \u2014 the channel's videos are below."));
        }
      });

      if (!user.id) {
        listBody(vodSection.list, [noteNode("No videos available.")]);
        return;
      }
      state.userId = user.id;
      loadVods(state, vodSection.list, tab);
    });
  }

  function normalizeUser(entry) {
    var user = obj(entry);
    var login = str(user.login || user.display_name).toLowerCase();
    if (!login) return null;
    return {
      id: str(user.id),
      login: login,
      displayName: str(user.display_name) || login,
      description: str(user.description),
      avatar: str(user.profile_image_url)
    };
  }

  function renderChannelHeader(target, user) {
    clear(target);
    target.setAttribute("data-role", "channel-header");
    var box = imageBox(user.avatar, "twt-channel-avatar", user.displayName, "twt-channel-avatar-box");
    var avatar = box.children && box.children[0] ? box.children[0] : null;
    if (avatar && avatar.tagName === "IMG") avatar.setAttribute("data-role", "avatar");
    attach(target, box);
    var main = attach(target, el("div", "twt-channel-main"));
    attach(main, el("h1", "twt-channel-name", user.displayName));
    attach(main, el("div", "twt-channel-login", "#" + user.login));
    if (user.description) attach(main, el("p", "twt-channel-description", user.description));
  }

  function liveBlock(stream) {
    var node = row("stream", "twt-live-block");
    var login = str(stream.user_login).toLowerCase();
    node.setAttribute("data-login", login);
    attach(node, imageBox(previewURL(login), "twt-live-thumb", "", "twt-live-thumb-box"));
    var main = attach(node, el("div", "twt-browser-row-main"));
    attach(main, el("span", "twt-live-label", "LIVE"));
    if (stream.title) attach(main, el("span", "twt-browser-title", str(stream.title)));
    var meta = attach(main, el("span", "twt-browser-meta"));
    var parts = [];
    if (stream.game_name) parts.push(str(stream.game_name));
    if (stream.viewer_count !== undefined) parts.push(formatCount(stream.viewer_count) + " viewers");
    var uptime = formatUptime(stream.started_at);
    if (uptime) parts.push("live " + uptime);
    meta.textContent = parts.join(" \u00b7 ");
    var button = el("button", "twt-btn twt-watch", "Watch");
    button.type = "button";
    button.setAttribute("data-action", "watch");
    attach(main, button);
    bindOpen(button, "stream", login, true);
    bindOpen(node, "stream", login, false);
    return node;
  }

  /* ----------------------------------------------------- search and videos */

  var QUERY_DEBOUNCE_MS = 300;

  function debounceQuery(tab, run) {
    clearTimeout(tab.queryTimer);
    tab.queryTimer = setTimeout(function () {
      tab.queryTimer = null;
      run();
    }, QUERY_DEBOUNCE_MS);
  }

  /* A search/filter field. The tab owns the query, so leaving and re-entering
   * the tab keeps it (the pane DOM persists) and a re-render (refresh) starts
   * from the same value. Typing is debounced; Enter and the button run now. */
  function searchField(tab, placeholder, action, run) {
    var row = el("div", "twt-search");
    var input = document.createElement("input");
    input.className = "twt-input";
    input.type = "text";
    input.placeholder = placeholder;
    input.setAttribute("data-action", action + "-input");
    input.spellcheck = false;
    input.value = tab.query || "";
    var button = el("button", "twt-btn twt-search-btn", "Search");
    button.type = "button";
    button.setAttribute("data-action", action);
    function runNow() {
      if (tab.queryTimer) {
        clearTimeout(tab.queryTimer);
        tab.queryTimer = null;
      }
      run(str(input.value).trim());
    }
    input.addEventListener("input", function () {
      tab.query = str(input.value);
      debounceQuery(tab, function () { run(str(input.value).trim()); });
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runNow();
      }
    });
    button.addEventListener("click", runNow);
    attach(row, input);
    attach(row, button);
    return row;
  }

  /* ------------------------------------------------------ the Search tab */

  function renderSearch(tab) {
    var target = tab.pane;
    if (!target) return;
    clear(target);
    attach(target, searchField(tab, "Search channels", "channel-search", function (query) {
      tab.query = query;
      renderChannelResults(tab);
    }));
    tab.listEl = attach(target, el("div", "twt-browser-list twt-search-results"));
    renderChannelResults(tab);
  }

  function renderChannelResults(tab) {
    var target = tab.listEl;
    if (!target) return;
    if (!tab.query) {
      listBody(target, [noteNode("Search Twitch for channels by name. Open a result to see the channel's page and its videos.")]);
      return;
    }
    searchChannels(tab.query, target, tab);
  }

  /* /helix/search/channels returns channels; a row opens the in-sidebar
   * overview, whose Videos section is the full VOD list. */
  function searchChannels(query, target, tab) {
    var generation = tab.generation;
    loading(target);
    var path = "/helix/search/channels?query=" + encodeURIComponent(query) + "&first=" + SEARCH_LIMIT;
    cached(path, tab).then(function (result) {
      /* a newer query (or a re-render) owns the list now */
      if (tab.generation !== generation || tab.query !== query) return;
      if (!result.ok) {
        listBody(target, [errorNode(result, function () { searchChannels(query, target, tab); })]);
        return;
      }
      var rows = dataList(result);
      var nodes = [];
      for (var i = 0; i < rows.length; i++) {
        var rowNode = searchChannelRow(tab, rows[i]);
        if (rowNode) nodes.push(rowNode);
      }
      if (!nodes.length) {
        listBody(target, [noteNode("No channels match \u201c" + query + "\u201d.")]);
        return;
      }
      listBody(target, nodes);
    });
  }

  /* ------------------------------------------------------ the Videos tab */

  /* The Videos tab filters the recent videos of the channels you follow. Helix
   * has no video text-search endpoint, so this is deliberately not a global
   * search: the filter only ever considers the videos the fan-out already
   * loaded, matching by title, channel name or login. */
  function renderVideos(tab) {
    var target = tab.pane;
    if (!target) return;
    clear(target);
    attach(target, searchField(tab, "Filter videos", "video-search", function (query) {
      tab.query = query;
      renderVideoList(tab);
    }));
    attach(target, el("div", "twt-browser-note twt-video-hint",
      "Filters the videos of the channels you follow (title, channel name or login)."));
    var section = makeSection("Recent videos from followed channels");
    attach(target, section.root);
    tab.listEl = section.list;
    tab.videos = [];
    tab.liveThumbs = {};
    tab.liveThumbsAsked = {};
    tab.videosLoading = true;
    tab.failures = 0;
    loading(tab.listEl);
    loadRecentVods(tab);
  }

  function videoMatches(video, query) {
    return str(video.title).toLowerCase().indexOf(query) !== -1 ||
      str(video.user_name).toLowerCase().indexOf(query) !== -1 ||
      str(video.user_login).toLowerCase().indexOf(query) !== -1;
  }

  function renderVideoList(tab) {
    var target = tab.listEl;
    if (!target) return;
    var query = str(tab.query).toLowerCase();
    var merged = [];
    for (var i = 0; i < (tab.videos || []).length; i++) {
      if (!query || videoMatches(tab.videos[i], query)) mergeVods(merged, [tab.videos[i]]);
    }
    sortVods(merged);
    var nodes = [];
    var limit = Math.min(merged.length, VOD_FANOUT_MAX);
    for (var j = 0; j < limit; j++) {
      var video = merged[j];
      nodes.push(vodRow(video, (tab.liveThumbs || {})[str(video.user_login).toLowerCase()]));
    }
    if (!nodes.length) {
      if (tab.videosLoading) nodes.push(noteNode("Loading\u2026"));
      else if (query) nodes.push(noteNode("No videos match \u201c" + tab.query + "\u201d in the channels you follow."));
      else nodes.push(noteNode("No recent videos from the channels you follow."));
    }
    if (tab.failures) nodes.push(noteNode(tab.failures + " channel(s) could not be loaded."));
    listBody(target, nodes);
  }

  /* One batched live lookup for the VOD rows that have no thumbnail of their
   * own (empty or Twitch's processing marker); logins already asked about in
   * this render are not requested again, even when the answer was "offline". */
  function ensureLiveThumbs(tab, videos, callback) {
    tab.liveThumbs = tab.liveThumbs || {};
    tab.liveThumbsAsked = tab.liveThumbsAsked || {};
    var generation = tab.generation;
    var seen = {};
    var missing = [];
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var login = str(video.user_login).toLowerCase();
      var url = str(video.thumbnail_url);
      if (url && !processingThumbnail(url)) continue;
      if (Object.prototype.hasOwnProperty.call(tab.liveThumbsAsked, login) || seen[login]) continue;
      seen[login] = true;
      tab.liveThumbsAsked[login] = true;
      missing.push(video);
    }
    if (!missing.length) { callback(); return; }
    loadLiveThumbnails(missing, tab, function (map) {
      if (tab.generation !== generation) return;
      for (var key in map) {
        if (Object.prototype.hasOwnProperty.call(map, key)) tab.liveThumbs[key] = map[key];
      }
      callback();
    });
  }

  /* The Videos tab loads the recent videos of the followed channels into the
   * tab's own list; the filter above it is local and never re-requests. */
  function loadRecentVods(tab) {
    var target = tab.listEl;
    var generation = tab.generation;
    ensureIdentity().then(function (identity) {
      if (tab.generation !== generation) return;
      if (!identity.ok) {
        tab.videosLoading = false;
        listBody(target, [errorCard(identity.error, function () { resetIdentity(); loadRecentVods(tab); })]);
        return;
      }
      if (!identity.userId) {
        tab.videosLoading = false;
        listBody(target, [errorCard({ title: "No user id", text: "The token did not reveal a user id, so followed channels cannot be listed." }, function () { resetIdentity(); loadRecentVods(tab); })]);
        return;
      }
      cached(followedPath(identity.userId, ""), tab).then(function (result) {
        if (tab.generation !== generation) return;
        if (!result.ok) {
          tab.videosLoading = false;
          if (isScopeError(result)) {
            listBody(target, [noteNode("Recent videos need the user:read:follows permission.")]);
            return;
          }
          listBody(target, [errorNode(result, function () { loadRecentVods(tab); })]);
          return;
        }
        var rows = dataList(result);
        var channels = [];
        var seen = {};
        for (var i = 0; i < rows.length && channels.length < VOD_FANOUT_CHANNELS; i++) {
          var follow = normalizeFollow(rows[i]);
          if (!follow || !follow.id || seen[follow.id]) continue;
          seen[follow.id] = true;
          channels.push(follow);
        }
        if (!channels.length) {
          tab.videosLoading = false;
          listBody(target, [noteNode("Follow some channels to see their recent videos.")]);
          return;
        }
        fanOutVideos(channels, tab, function (videos, failures) {
          tab.videos = videos;
          tab.failures = failures || 0;
          tab.videosLoading = false;
          ensureLiveThumbs(tab, videos, function () { renderVideoList(tab); });
        });
      });
    });
  }

  /* Bounded fan-out over channels: VOD_FANOUT_CHANNELS channels, at most
   * VOD_FANOUT_CONCURRENCY requests in flight, one archive page per channel,
   * merged and deduped by id. */
  function fanOutVideos(channels, tab, done) {
    var generation = tab.generation;
    var videos = [];
    var failures = 0;
    var remaining = channels.slice(0, VOD_FANOUT_CHANNELS);
    var active = 0;
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      if (tab.generation !== generation) return;
      sortVods(videos);
      done(videos, failures);
    }

    function pump() {
      while (active < VOD_FANOUT_CONCURRENCY && remaining.length) start(remaining.shift());
      if (active === 0 && !remaining.length) finish();
    }

    function start(channel) {
      active++;
      var path = "/helix/videos?user_id=" + encodeURIComponent(channel.id) +
        "&type=archive&first=" + VOD_FANOUT_PER_CHANNEL;
      cached(path, tab).then(function (result) {
        active--;
        if (result.ok) mergeVods(videos, dataList(result));
        else failures++;
        pump();
      });
    }

    pump();
  }

  function liveLoginsFor(videos) {
    var seen = {};
    var logins = [];
    for (var i = 0; i < videos.length && logins.length < FOLLOW_LIMIT; i++) {
      var login = str(videos[i].user_login).toLowerCase();
      if (!/^[a-z0-9_]{1,25}$/.test(login) || seen[login]) continue;
      seen[login] = true;
      logins.push(login);
    }
    return logins;
  }

  /* One batched /helix/streams?user_login=... call for the logins on a page of
   * VOD rows that have no thumbnail of their own; the response feeds the
   * live-thumbnail fallback. Cached by path like every other request. */
  function loadLiveThumbnails(videos, tab, callback) {
    var logins = liveLoginsFor(videos);
    if (!logins.length) { callback({}); return; }
    var query = "";
    for (var i = 0; i < logins.length; i++) query += "&user_login=" + encodeURIComponent(logins[i]);
    var path = "/helix/streams?first=" + Math.max(logins.length, 1) + query;
    cached(path, tab).then(function (result) {
      var map = {};
      if (result.ok) {
        var rows = dataList(result);
        for (var j = 0; j < rows.length; j++) {
          map[str(rows[j].user_login).toLowerCase()] = rows[j];
        }
      }
      callback(map);
    });
  }

  /* ------------------------------------------------------------------ wiring */

  function wire() {
    if (backEl) backEl.addEventListener("click", function () { goBack(activeTab()); });
    if (refreshEl) refreshEl.addEventListener("click", refresh);
  }

  /* -------------------------------------------------------- the page footer
   *
   * The sidebar's footer belongs to ui/transport.js: it reports the live IRC
   * connection. The standalone window has no transport and no Settings pane, so
   * when this document has no Settings pane the browse page keeps a neutral
   * footer instead: "browsing" plus the host's token status from twt:settings,
   * never a channel and never a connection claim. */
  function setupFooter() {
    if ($("pane-settings")) return;      /* the sidebar owns its own footer */
    var text = $("status-text");
    if (!text) return;
    text.textContent = "browsing";
    proto.onMessage("twt:settings", function (payload) {
      var token = (payload && payload.token) || {};
      text.textContent = "browsing \u00b7 " + (token.available ? "token available" : "no token");
    });
  }

  initTabs();
  selectTab(activeId);
  setupFooter();
  wire();

  global.TwitchBrowser = {
    onEscape: function () {
      var tab = activeTab();
      if (!tab || isSettingsTab(tab) || !tab.stack.length) return false;
      goBack(tab);
      return true;
    },
    refresh: refresh,
    selectTab: selectTab
  };
})(typeof window !== "undefined" ? window : this);
