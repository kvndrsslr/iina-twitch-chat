/*
 * ui/overlay-view.js - the video overlay.
 *
 * A passive mirror of the chat that ui/transport.js receives in the sidebar:
 * chat events, state and the emote index are forwarded by main.js. It has no
 * IRC client of its own and no chat controls: the panel's header and its eight
 * resize zones plus the message list are the hit-testable region (scrollable
 * chat, always-available layout affordances), and everything decorative stays
 * click-through so the video underneath keeps those mouse events. The only
 * page-owned text is the one-line channel/connection status built in
 * renderHeader().
 *
 * There is no hover mode and nothing appears or disappears: the header is the
 * move area (cursor: grab) and four edge bands plus four corner squares are the
 * resize affordances (each with its directional cursor; the zones themselves
 * are invisible, so the cursor is the only affordance). The overlay owns no
 * persistence - it applies the anchored geometry main.js sends, clamps it
 * strictly into the video area, and reports geometry while a gesture runs
 * (throttled) plus once more when it ends:
 *
 *   main.js -> overlay  "twt:overlay-layout" {channel,
 *                         layout: {anchor, dx, dy, w, h}|null}
 *                       (sent on ready, channel change and any restore;
 *                        layout: null means "use the CSS default")
 *   overlay -> main.js  "twt:overlay-moved"  {channel, anchor, dx, dy, w, h}
 *                       (during a drag/resize, at most one per 100 ms, plus
 *                        one final message when the gesture ends or Escape
 *                        finalises it) — the final message carries done: true
 *                       so main.js writes the layout immediately instead of
 *                       waiting for its save debounce
 *
 * `anchor` is the panel corner tied to the viewport corner: "tl", "tr", "bl" or
 * "br". dx/dy are the integer distances in CSS px from the anchored viewport
 * edges to the panel's anchored edges, so rendering is
 *
 *   x = anchor is left  ? dx : viewportW - dx - w
 *   y = anchor is top   ? dy : viewportH - dy - h
 *
 * A resize moves only the dragged edge(s); the opposite edge(s) stay fixed and
 * the gesture keeps the anchor it started with, so its dx/dy stay constant.
 * The minimum size (220x120) and the strict inside-the-video clamp hold, and
 * the reported geometry always carries the anchored form so a later window
 * resize keeps the panel's gap.
 *
 * A move derives the anchor from the panel's centre against the viewport
 * centre, one axis at a time, with hysteresis: the previous anchor is kept
 * until the centre passes the centre line by 10% of the viewport on that axis,
 * so a small drag near the boundary cannot flip the anchor back and forth.
 *
 * Gestures are plain mouse events (mousedown on the header or a zone,
 * mousemove/mouseup on window) - not CSS resize, and not pointer events, whose
 * capture semantics WKWebView does not need here. Because IINA only hit tests
 * elements that carry data-clickable, a gesture arms a full-viewport catcher
 * for its duration so the web view keeps receiving the moves once the pointer
 * has left the affordance; it is disarmed the moment the gesture ends.
 */

(function (global) {
  "use strict";

  var proto = global.TwitchProtocol;

  /* Clamping: main.js is the persistence authority and clamps too, but a stale
   * viewport or a corrupt pref must not be able to hide the panel off screen. */
  var MIN_W = 220;   /* smallest usable width, same floor as main.js */
  var MIN_H = 120;

  /* A finished drag/resize reports at most once per this many ms while the
   * pointer is still down, so main.js can save continuously without a message
   * storm; the release always sends one final report. */
  var REPORT_MS = 100;

  function $(id) {
    return document.getElementById(id);
  }

  var state = {
    settings: null,
    filters: null,
    token: { available: false, source: "none" },
    channel: null,
    connState: "idle",
    /* VOD chat replay: main.js sets vodReplay while a VOD is playing and
     * channelNote to "VOD chat replay" (the same field it uses for the sidebar
     * source line). The overlay labels that mode but stays passive. */
    vodReplay: false,
    channelNote: ""
  };

  var ANCHORS = ["tl", "tr", "bl", "br"];
  /* A move only flips the anchor once the panel's centre passes the viewport
   * centre by this fraction of the viewport on that axis. */
  var HYSTERESIS = 0.1;

  /* Resize affordances: four edge bands and four corner squares, all always
   * active. `dir` is the set of dragged edges (the opposite edges stay fixed). */
  var ZONES = [
    { id: "overlay-edge-top", dir: "top" },
    { id: "overlay-edge-right", dir: "right" },
    { id: "overlay-edge-bottom", dir: "bottom" },
    { id: "overlay-edge-left", dir: "left" },
    { id: "overlay-corner-tl", dir: "tl" },
    { id: "overlay-corner-tr", dir: "tr" },
    { id: "overlay-corner-bl", dir: "bl" },
    { id: "overlay-corner-br", dir: "br" }
  ];

  /* Layout state. `geo` is the anchored geometry currently applied to
   * #overlay-root, or null while the CSS default (right-anchored, 340px wide)
   * is in charge. `drag` is
   * {mode, dir, start:{x,y,w,h}, geo:{anchor,dx,dy,w,h}, px, py} while a
   * gesture runs. */
  var layout = {
    geo: null,
    channel: null,
    drag: null
  };

  /* Throttle state for the continuous reports of a running gesture. */
  var reportTimer = null;
  var reportQueued = null;

  var view = global.TwitchChat.create({
    list: $("messages"),
    jump: $("jump-bottom"),
    settings: { chat: {} }
  });

  function chat() {
    return (state.settings && state.settings.chat) ? state.settings.chat : {};
  }

  function describeState() {
    switch (state.connState) {
    case "connected":
      return state.token.available && state.settings && state.settings.twitch.username ? "" : "read-only";
    case "connecting":
      return "connecting\u2026";
    case "reconnecting":
      return "reconnecting\u2026";
    case "closed":
      return "disconnected";
    default:
      return "";
    }
  }

  /* The single non-interactive text line: channel label + connection state.
   * While a VOD replays, channelNote ("VOD chat replay") rides on the channel
   * label so the source line says which conversation is on screen; the live
   * connection state stays in its own span. */
  function renderHeader() {
    /* [frontend] title_shown: hide the channel label in the header */
    var showChannel = chat().titleShown !== false;
    $("header-channel").hidden = !showChannel;
    var label = state.channel ? "#" + state.channel : "Twitch";
    if (state.vodReplay && state.channelNote) label += " (" + state.channelNote + ")";
    $("header-channel").textContent = label;
    $("status-dot").setAttribute("data-state", state.connState);
    /* hiding the channel label must not hide the replay label, so the note
     * moves to the status span in that one case */
    $("status-text").textContent = (!showChannel && state.vodReplay && state.channelNote)
      ? state.channelNote
      : describeState();
  }

  /* ------------------------------------------------------------- layout */

  function isNum(value) {
    return typeof value === "number" && isFinite(value);
  }

  /* innerWidth/innerHeight are the overlay viewport; 0 means "unknown" (the
   * test DOM has no layout engine), in which case only the floors apply. */
  function viewport() {
    return {
      w: isNum(global.innerWidth) && global.innerWidth > 0 ? global.innerWidth : 0,
      h: isNum(global.innerHeight) && global.innerHeight > 0 ? global.innerHeight : 0
    };
  }

  /* w in [220, viewport], h in [120, viewport]; the viewport bounds are applied
   * when rendering only and are never written back to the stored geometry. */
  function clampDim(value, min, vpSize) {
    var size = Math.max(Math.round(value), min);
    return vpSize > 0 ? Math.min(size, vpSize) : size;
  }

  /* The panel lives strictly inside the video area: a gap/coordinate is
   * clamped to [0, viewport - size] for both anchors (a positive gap pulls the
   * panel inside; nothing may overhang any edge). */
  function clampSpan(value, size, vpSize) {
    var span = Math.max(Math.round(value), 0);
    if (!(vpSize > 0)) return span;
    return Math.min(span, Math.max(vpSize - size, 0));
  }

  function isAnchor(value) {
    return ANCHORS.indexOf(value) !== -1;
  }

  function anchorParts(anchor) {
    return {
      left: anchor === "tl" || anchor === "bl",
      top: anchor === "tl" || anchor === "tr"
    };
  }

  /* Incoming layout, v2 {anchor,dx,dy,w,h} or the older plugin's {x,y,w,h}
   * (anchor "tl"). Anything that is not four finite numbers is not a layout and
   * leaves the stylesheet default in charge. */
  function normalizeLayout(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (!isNum(raw.w) || !isNum(raw.h)) return null;
    var anchor = isAnchor(raw.anchor) ? raw.anchor : null;
    var dx = isNum(raw.dx) ? raw.dx : (isNum(raw.x) ? raw.x : null);
    var dy = isNum(raw.dy) ? raw.dy : (isNum(raw.y) ? raw.y : null);
    if (dx === null || dy === null) return null;
    return {
      anchor: anchor || "tl",
      dx: Math.round(dx),
      dy: Math.round(dy),
      w: Math.round(raw.w),
      h: Math.round(raw.h)
    };
  }

  /* x/y are derived from the anchor on every render: this is what keeps a
   * right/bottom gap fixed while the viewport (video window) changes size. */
  function rectFromGeo(geo) {
    var vp = viewport();
    var w = clampDim(geo.w, MIN_W, vp.w);
    var h = clampDim(geo.h, MIN_H, vp.h);
    var dx = clampSpan(geo.dx, w, vp.w);
    var dy = clampSpan(geo.dy, h, vp.h);
    var parts = anchorParts(geo.anchor);
    return {
      x: parts.left || !(vp.w > 0) ? dx : vp.w - dx - w,
      y: parts.top || !(vp.h > 0) ? dy : vp.h - dy - h,
      w: w,
      h: h
    };
  }

  function geoFromRect(rect, anchor) {
    var vp = viewport();
    var parts = anchorParts(anchor);
    var x = Math.round(rect.x);
    var y = Math.round(rect.y);
    var w = Math.round(rect.w);
    var h = Math.round(rect.h);
    return {
      anchor: anchor,
      dx: Math.round(parts.left || !(vp.w > 0) ? x : vp.w - x - w),
      dy: Math.round(parts.top || !(vp.h > 0) ? y : vp.h - y - h),
      w: w,
      h: h
    };
  }

  function clampRect(rect) {
    var vp = viewport();
    var w = clampDim(rect.w, MIN_W, vp.w);
    var h = clampDim(rect.h, MIN_H, vp.h);
    return {
      x: clampSpan(rect.x, w, vp.w),
      y: clampSpan(rect.y, h, vp.h),
      w: w,
      h: h
    };
  }

  /* Applying geometry pins the panel to explicit edges: the CSS default anchors
   * it to the right, so leaving right/bottom/max-width in place would fight the
   * computed box. Clearing the inline styles restores that default, which is
   * what layout: null means. */
  function renderGeo(geo) {
    var root = $("overlay-root");
    if (!root) return null;
    if (!geo) {
      root.style.left = "";
      root.style.top = "";
      root.style.width = "";
      root.style.height = "";
      root.style.right = "";
      root.style.bottom = "";
      root.style.maxWidth = "";
      return null;
    }
    var rect = rectFromGeo(geo);
    root.style.left = rect.x + "px";
    root.style.top = rect.y + "px";
    root.style.width = rect.w + "px";
    root.style.height = rect.h + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.style.maxWidth = "none";
    return rect;
  }

  function applyGeo(geo) {
    layout.geo = geo;
    return renderGeo(geo);
  }

  /* The box a gesture starts from: the applied anchored geometry rendered
   * against the current viewport, or - when the CSS default is in charge - the
   * panel as the browser actually laid it out. */
  function currentRect() {
    if (layout.geo) return rectFromGeo(layout.geo);
    var root = $("overlay-root");
    if (!root || typeof root.getBoundingClientRect !== "function") return null;
    var rect = root.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    var measuredRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    var measured = geoFromRect(measuredRect, deriveAnchor(measuredRect, null));
    return rectFromGeo(measured);
  }

  function markClickable(element, on) {
    if (!element) return;
    if (on) element.setAttribute("data-clickable", "");
    else element.removeAttribute("data-clickable");
  }

  /* IINA hit tests one element at a time. The header (move), the eight resize
   * zones, the message list (wheel/scroll) and the jump chip are marked for as
   * long as the overlay is shown; the panel itself and everything decorative
   * stay transparent (chat.css), so clicks on the gutters reach the video. */
  function syncClickability() {
    markClickable($("overlay-header"), true);
    markClickable($("messages"), true);
    markClickable($("jump-bottom"), true);
    for (var i = 0; i < ZONES.length; i++) markClickable($(ZONES[i].id), true);
  }

  /* While a gesture runs, a full-viewport catcher keeps IINA hit testing (and
   * therefore the mouse events) inside this web view wherever the pointer is. */
  function armCatcher(on) {
    var catcher = $("overlay-catcher");
    if (!catcher) return;
    markClickable(catcher, on);
    catcher.style.display = on ? "block" : "none";
  }

  function consume(event) {
    if (!event) return;
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
  }

  /* `done` marks the report that ends a gesture: main.js persists immediately
   * on it (it also accepts `final`), instead of waiting for the save debounce.
   * The continuous reports during the gesture leave it off. */
  function movedPayload(geo, done) {
    var payload = {
      channel: layout.channel,
      anchor: geo.anchor,
      dx: Math.round(geo.dx),
      dy: Math.round(geo.dy),
      w: Math.round(geo.w),
      h: Math.round(geo.h)
    };
    if (done) payload.done = true;
    return payload;
  }

  function postMoved(geo, done) {
    proto.postMessage("twt:overlay-moved", movedPayload(geo, done));
  }

  /* While the pointer is down, geometry is reported continuously but at most
   * once per REPORT_MS: the first update of a window goes out at once, later
   * ones are coalesced into the newest geometry and sent when the window ends.
   * The final report on release bypasses the throttle. */
  function clearReportTimer() {
    if (reportTimer) {
      global.clearTimeout(reportTimer);
      reportTimer = null;
    }
    reportQueued = null;
  }

  function reportDuring(geo) {
    if (reportTimer) {
      reportQueued = geo;
      return;
    }
    postMoved(geo);
    reportTimer = setTimeout(function () {
      reportTimer = null;
      if (reportQueued) {
        var queued = reportQueued;
        reportQueued = null;
        reportDuring(queued);
      }
    }, REPORT_MS);
  }

  /* The active resize zone keeps the twt-overlay-zone-active class for the
   * whole gesture (used as gesture bookkeeping; the zones paint nothing); the
   * body class turns the cursor into grabbing while a move runs. */
  function markActiveZone(dir) {
    for (var i = 0; i < ZONES.length; i++) {
      var zone = $(ZONES[i].id);
      if (!zone || !zone.classList) continue;
      if (ZONES[i].dir === dir) zone.classList.add("twt-overlay-zone-active");
      else zone.classList.remove("twt-overlay-zone-active");
    }
    if (global.document && document.body && document.body.classList) {
      if (dir === null) document.body.classList.add("twt-overlay-moving");
      else document.body.classList.remove("twt-overlay-moving");
    }
  }

  function cancelDrag() {
    layout.drag = null;
    clearReportTimer();
    markActiveZone("");
    armCatcher(false);
  }

  function beginDrag(mode, event, dir) {
    var ev = event || {};
    if (layout.drag) return;
    /* left button only: a right click is not a gesture start */
    if (ev.button !== undefined && ev.button !== 0) return;
    var rect = currentRect();
    if (!rect) return;
    var geo = geoFromRect(rect, deriveAnchor(rect, layout.geo ? layout.geo.anchor : null));
    layout.drag = {
      mode: mode,
      dir: dir || null,
      start: rect,
      geo: geo,
      px: isNum(ev.clientX) ? ev.clientX : 0,
      py: isNum(ev.clientY) ? ev.clientY : 0
    };
    clearReportTimer();
    markActiveZone(layout.drag.dir);
    /* a gesture works on numbers, so it also pins down the CSS default */
    applyGeo(geo);
    armCatcher(true);
    consume(event);
  }

  /* A resize moves only the dragged edge(s), keeping the opposite edge(s)
   * fixed, then clamps to the minimum size and strictly inside the viewport. */
  function resizeRect(start, dir, deltaX, deltaY) {
    var vp = viewport();
    var minW = Math.min(MIN_W, vp.w > 0 ? vp.w : MIN_W);
    var minH = Math.min(MIN_H, vp.h > 0 ? vp.h : MIN_H);
    var left = dir === "left" || dir === "tl" || dir === "bl";
    var right = dir === "right" || dir === "tr" || dir === "br";
    var top = dir === "top" || dir === "tl" || dir === "tr";
    var bottom = dir === "bottom" || dir === "bl" || dir === "br";
    var rect = { x: start.x, y: start.y, w: start.w, h: start.h };
    if (left) {
      /* the right edge stays where it is */
      var fixedRight = start.x + start.w;
      rect.w = Math.min(Math.max(start.w - deltaX, minW), fixedRight);
      rect.x = fixedRight - rect.w;
    } else if (right) {
      var maxRight = vp.w > 0 ? vp.w - start.x : Infinity;
      rect.w = Math.min(Math.max(start.w + deltaX, minW), maxRight);
    }
    if (top) {
      /* the bottom edge stays where it is */
      var fixedBottom = start.y + start.h;
      rect.h = Math.min(Math.max(start.h - deltaY, minH), fixedBottom);
      rect.y = fixedBottom - rect.h;
    } else if (bottom) {
      var maxBottom = vp.h > 0 ? vp.h - start.y : Infinity;
      rect.h = Math.min(Math.max(start.h + deltaY, minH), maxBottom);
    }
    return rect;
  }

  function onDragMove(event) {
    var ev = event || {};
    var drag = layout.drag;
    if (!drag) return false;
    var deltaX = (isNum(ev.clientX) ? ev.clientX : drag.px) - drag.px;
    var deltaY = (isNum(ev.clientY) ? ev.clientY : drag.py) - drag.py;
    var rect;
    if (drag.mode === "resize") {
      rect = resizeRect(drag.start, drag.dir, deltaX, deltaY);
    } else {
      /* a move changes the free edges only: w/h stay exactly as they were */
      rect = clampRect({
        x: drag.start.x + deltaX,
        y: drag.start.y + deltaY,
        w: drag.start.w,
        h: drag.start.h
      });
    }
    /* a resize keeps the anchor it started with (its dx/dy stay constant); a
     * move derives it from the final rect with hysteresis, so the stored
     * layout always carries the anchored form */
    var anchor = drag.mode === "resize" ? drag.geo.anchor : deriveAnchor(rect, drag.geo.anchor);
    var next = geoFromRect(rect, anchor);
    drag.geo = next;
    applyGeo(next);
    reportDuring(next);
    consume(event);
    return true;
  }

  /* The panel's anchor: the viewport centre splits each axis (left/right,
   * top/bottom) at the panel centre. With a previous anchor the flip only
   * happens once the centre has passed the centre line by HYSTERESIS of the
   * viewport on that axis, so a panel that sits near the boundary cannot flip
   * back and forth on a small drag. Without one (the CSS default is in charge)
   * the centre alone decides and ties stay on tl/bl. */
  function deriveAnchor(rect, previous) {
    var vp = viewport();
    var cx = rect.x + rect.w / 2;
    var cy = rect.y + rect.h / 2;
    var mx = vp.w * HYSTERESIS;
    var my = vp.h * HYSTERESIS;
    var prev = isAnchor(previous) ? previous : null;
    var left;
    var top;
    if (prev) {
      left = prev === "tl" || prev === "bl";
      top = prev === "tl" || prev === "tr";
      if (left && cx > vp.w / 2 + mx) left = false;
      else if (!left && cx < vp.w / 2 - mx) left = true;
      if (top && cy > vp.h / 2 + my) top = false;
      else if (!top && cy < vp.h / 2 - my) top = true;
    } else {
      left = !(vp.w > 0) || cx <= vp.w / 2;
      top = !(vp.h > 0) || cy <= vp.h / 2;
    }
    return (top ? "t" : "b") + (left ? "l" : "r");
  }

  /* The gesture is over: the final rect decides the anchor (a move re-derives
   * it with hysteresis, a resize keeps its own), then main.js persists the
   * anchored geometry with one final report. */
  function finishDrag() {
    var drag = layout.drag;
    if (!drag) return null;
    layout.drag = null;
    clearReportTimer();
    markActiveZone("");
    var geo = drag.geo;
    if (geo) {
      var rect = rectFromGeo(geo);
      var anchor = drag.mode === "resize" ? geo.anchor : deriveAnchor(rect, geo.anchor);
      geo = geoFromRect(rect, anchor);
      applyGeo(geo);
    }
    return geo;
  }

  function endDrag(event) {
    var wasDragging = !!layout.drag;
    var geo = finishDrag();
    if (!wasDragging) return;
    consume(event);
    armCatcher(false);
    if (geo) postMoved(geo, true);
  }

  /* Re-render against the new viewport: the anchored edges keep their gap and
   * the panel is re-clamped strictly inside. This is not a gesture, so nothing
   * is reported and the stored geometry is not rewritten. */
  function onViewportResize() {
    if (layout.drag || !layout.geo) return;
    renderGeo(layout.geo);
  }

  /* Escape finalises a running gesture: the final report goes out and the
   * catcher is released. Nothing is hidden or shown - the affordances are
   * always there. */
  function onKeyDown(event) {
    if (!event || event.key !== "Escape") return;
    var wasDragging = !!layout.drag;
    var geo = finishDrag();          /* null when nothing was running */
    armCatcher(false);
    if (!wasDragging) return;
    consume(event);
    if (geo) postMoved(geo, true);
  }

  function onBlur() {
    cancelDrag();
  }

  /* The header starts a move; each zone starts a resize in its own direction.
   * Every move/release is watched on window, which is what lets a gesture
   * continue over the video once the catcher is armed. */
  function bindLayout() {
    if ($("overlay-header")) {
      $("overlay-header").addEventListener("mousedown", function (event) {
        beginDrag("move", event, null);
      });
    }
    for (var i = 0; i < ZONES.length; i++) {
      var zone = $(ZONES[i].id);
      if (!zone) continue;
      zone.addEventListener("mousedown", (function (dir) {
        return function (event) { beginDrag("resize", event, dir); };
      })(ZONES[i].dir));
    }
    /* The list handles its own wheel events; the panel's listener covers the
     * header and gutters too. */
    if ($("overlay-panel")) {
      $("overlay-panel").addEventListener("wheel", function (event) {
        if (event && event.__twtWheelHandled) return;
        view.wheelScroll(event);
      }, { passive: false });
    }
    if (!global.addEventListener) return;
    global.addEventListener("mousemove", onDragMove, false);
    global.addEventListener("mouseup", endDrag, false);
    global.addEventListener("resize", onViewportResize, false);
    global.addEventListener("keydown", onKeyDown, false);
    global.addEventListener("blur", onBlur, false);
  }

  proto.onMessage("twt:overlay-layout", function (payload) {
    var p = payload || {};
    layout.channel = p.channel === undefined ? state.channel : (p.channel || null);
    applyGeo(normalizeLayout(p.layout));
  });

  proto.onMessage("twt:settings", function (payload) {
    if (!payload || !payload.settings) return;
    state.settings = payload.settings;
    state.filters = payload.filters || null;
    state.token = payload.token || { available: false, source: "none" };
    state.vodReplay = !!payload.vodReplay;
    state.channelNote = payload.channelNote || "";
    if (payload.currentChannel) state.channel = payload.currentChannel;
    view.setSettings(state.settings, state.filters);
    renderHeader();
  });

  proto.onMessage("twt:state", function (payload) {
    if (!payload) return;
    state.connState = payload.state || state.connState;
    if (payload.channel) state.channel = payload.channel;
    state.vodReplay = !!payload.vodReplay;
    state.channelNote = payload.channelNote || "";
    renderHeader();
  });

  proto.onMessage("twt:event", function (payload) {
    if (payload && payload.event) view.addEvent(payload.event);
  });

  /* The plugin announces every channel change with twt:clear (which carries
   * the new channel) before it joins, so the header follows that message. */
  proto.onMessage("twt:part", function () {
    state.channel = null;
    view.setChannel(null);
    renderHeader();
  });

  proto.onMessage("twt:emotes", function (payload) {
    if (payload && payload.index) view.setEmoteIndex(payload.index);
  });

  proto.onMessage("twt:clear", function (payload) {
    /* the plugin posts this to both views whenever the channel decision
     * changes: no row of the previous channel may survive it */
    state.channel = (payload && payload.channel) || null;
    view.clear();
    view.setChannel(state.channel);
    renderHeader();
  });

  /* history is fetched by the sidebar (only it sees the room id) and relayed;
   * messages carry the same fields as live ones, so they prepend unchanged */
  proto.onMessage("twt:history-result", function (payload) {
    if (!payload || !payload.ok || !payload.messages) return;
    if (payload.channel && state.channel && payload.channel !== state.channel) return;
    view.prependHistory(payload.messages, payload.channel);
  });

  proto.onMessage("twt:command", function (payload) {
    if (payload && payload.command === "clear") view.clear();
  });

  syncClickability();
  applyGeo(null);
  armCatcher(false);   /* the stylesheet keeps it display:none until a gesture */
  bindLayout();
  renderHeader();
  proto.postMessage("twt:ready", { href: global.location.href });
})(typeof window !== "undefined" ? window : this);
