/*
 * ui/chat-view.js - renders the chat stream.
 *
 * Shared by ui/sidebar.html (which owns the IRC connection) and
 * ui/overlay.html (which mirrors the sidebar stream). All chat text, display
 * names, badge names and channel names are attacker controlled, so every node
 * is built with createElement/textContent - never innerHTML.
 */

(function (global) {
  "use strict";

  var libs = global.TwitchPlugin || {};
  var emotesLib = libs.emotes || {};
  var strftimeLib = libs.strftime || {};
  var configLib = libs.config || {};

  var JUMP_THRESHOLD = 24;
  var BADGE_SCALE = 1;
  var EMOTE_SCALE = 2;
  var EMOTE_ERROR_LOG_LIMIT = 5;

  /* One-shot diagnostics, forwarded through the same "twt:log" channel
   * transport.js uses, so an emote that silently stays text is observable in
   * IINA's log (the overlay has no debugger attached). */
  var diag = {
    emote: false,
    emoteTagMessage: false,
    indexSize: -1,
    reRenders: 0,
    imageErrors: {},
    imageErrorsLogged: 0,
    limitLogged: false
  };

  function logDiag(message) {
    var protocol = global.TwitchProtocol;
    if (!protocol || typeof protocol.postMessage !== "function") return;
    try {
      protocol.postMessage("twt:log", { message: "chat-view: " + message });
    } catch (e) { /* diagnostics must never break rendering */ }
  }

  function onEmoteImageError(event) {
    var target = (event && (event.target || event.currentTarget)) || null;
    var src = (target && target.src) || "unknown";
    if (diag.imageErrors[src]) return;
    diag.imageErrors[src] = true;
    if (diag.imageErrorsLogged >= EMOTE_ERROR_LOG_LIMIT) return;
    diag.imageErrorsLogged++;
    logDiag("emote image failed to load: " + src);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== "") node.textContent = String(text);
    return node;
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* VOD replay positions are seconds into the video: "5:07", "1:02:09". */
  function twoDigits(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function formatOffset(value) {
    var total = Math.floor(Number(value));
    if (!isFinite(total) || total < 0) return "";
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    return (hours ? hours + ":" + twoDigits(minutes) : String(minutes)) + ":" + twoDigits(seconds);
  }

  function rowFrom(node) {
    if (!node) return null;
    if (node.className && String(node.className).indexOf("twt-msg") !== -1) return node;
    return null;
  }

  function create(options) {
    var list = options.list;
    var jumpButton = options.jump || null;
    var emptyHint = options.empty || null;
    var view = {
      settings: options.settings || { chat: {} },
      filters: options.filters || null,
      emoteIndex: options.emoteIndex || null,
      emoteIndexSize: options.emoteIndex ? Object.keys(options.emoteIndex).length : 0,
      selfLogin: "",
      channel: null,
      channelId: null,
      onChannelId: options.onChannelId || null,
      /* Explicit stick-to-bottom state: only a real user scroll changes it.
       * `programmatic` remembers the scrollTop a programmatic write left
       * behind, so its own scroll event is not mistaken for a user scroll. */
      stick: true,
      programmatic: null,
      unread: 0
    };

    /* ------------------------------------------------------------ helpers */

    function chatSettings() {
      return (view.settings && view.settings.chat) ? view.settings.chat : {};
    }

    function applyAppearance() {
      var chat = chatSettings();
      var body = document.body;
      /* "system" (a plugin-only override) follows the macOS appearance via
       * prefers-color-scheme; twt's own values are dark|light. */
      if (chat.theme && chat.theme !== "system") body.setAttribute("data-theme", chat.theme);
      else body.removeAttribute("data-theme");
      if (chat.palette) body.setAttribute("data-palette", chat.palette);
      else body.removeAttribute("data-palette");
    }

    function formatTime(timestamp) {
      var format = chatSettings().datetimeFormat || "%H:%M:%S";
      try {
        return strftimeLib.formatTimestamp(timestamp, format);
      } catch (e) {
        return "";
      }
    }

    function distanceFromBottom() {
      return Math.max(list.scrollHeight - (list.scrollTop + list.clientHeight), 0);
    }

    function isAtBottom() {
      return distanceFromBottom() <= JUMP_THRESHOLD;
    }

    /* The chip exists only while the reader is away from the bottom; clicking
     * it re-sticks and hides it. */
    function updateJumpButton() {
      if (!jumpButton) return;
      if (view.stick) {
        jumpButton.textContent = "";
        jumpButton.hidden = true;
        return;
      }
      jumpButton.textContent = view.unread > 0
        ? view.unread + " new message" + (view.unread === 1 ? "" : "s")
        : "Jump to latest";
      jumpButton.hidden = false;
    }

    /* Programmatic writes fire a scroll event in a real web view. Remember the
     * scrollTop actually left behind (the browser may clamp it) so the scroll
     * listener can recognise that event as its own and leave `stick` alone. */
    function setScrollTop(value) {
      list.scrollTop = value;
      view.programmatic = list.scrollTop;
    }

    function scrollToBottom() {
      view.stick = true;
      view.unread = 0;
      setScrollTop(list.scrollHeight);
      updateJumpButton();
    }

    /* IINA routes a wheel event to the overlay only when the point is over an
     * element carrying data-clickable (PluginOverlayView.hitTest), so the panel
     * and the list own the gesture. preventDefault keeps the browser (and the
     * video underneath) from acting on it, and the list is scrolled by hand so
     * it works without a click or keyboard focus. deltaMode is normalised: 1
     * line ~= 16 px, 2 pages ~= one viewport. */
    function wheelDelta(event) {
      var delta = Number(event && event.deltaY);
      if (!isFinite(delta)) return 0;
      var mode = event && event.deltaMode;
      if (mode === 1) return delta * 16;
      if (mode === 2) return delta * Math.max(list.clientHeight, 1);
      return delta;
    }

    function onWheel(event) {
      var delta = wheelDelta(event);
      if (!delta) return;
      if (event.preventDefault) event.preventDefault();
      list.scrollTop += delta;
      /* a wheel is user intent, exactly like dragging the scrollbar */
      view.programmatic = null;
      view.stick = isAtBottom();
      if (view.stick) view.unread = 0;
      updateJumpButton();
      /* deliberately no stopPropagation(): the page keeps the event */
    }

    function rowCount() {
      var count = 0;
      var nodes = list.children;
      for (var i = 0; i < nodes.length; i++) {
        if (rowFrom(nodes[i])) count++;
      }
      return count;
    }

    function applyLimit() {
      var max = chatSettings().maxMessages;
      if (typeof max !== "number" || !isFinite(max) || max <= 0) return;
      while (rowCount() > max && list.firstChild) {
        list.removeChild(list.firstChild);
      }
    }

    function updateEmptyHint() {
      if (!emptyHint) return;
      emptyHint.hidden = list.childElementCount > 0;
    }

    function removeByLogin(login) {
      if (!login) return;
      var nodes = list.querySelectorAll('[data-login="' + String(login).replace(/["\\]/g, "\\$&") + '"]');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].parentNode === list) list.removeChild(nodes[i]);
      }
      updateEmptyHint();
    }

    function removeById(id) {
      if (!id) return;
      var nodes = list.querySelectorAll('[data-msg-id="' + String(id).replace(/["\\]/g, "\\$&") + '"]');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].parentNode === list) list.removeChild(nodes[i]);
      }
      updateEmptyHint();
    }

    function clearRows() {
      while (list.firstChild) list.removeChild(list.firstChild);
      view.unread = 0;
      view.stick = true;
      view.programmatic = null;
      updateJumpButton();
      updateEmptyHint();
    }

    /* --------------------------------------------------------- rendering */

    function mention(text) {
      var chat = chatSettings();
      if (!chat.usernameHighlight || !view.selfLogin) return false;
      var pattern = new RegExp("(^|[^\\w@])@?" + escapeRegExp(view.selfLogin) + "\\b", "i");
      return pattern.test(String(text || ""));
    }

    function appendSegments(container, event) {
      var chat = chatSettings();
      var parts;
      try {
        parts = emotesLib.segment(event.text || "", {
          emotes: chat.twitchEmotes ? (isArray(event.emotes) ? event.emotes : null) : null,
          emoteIndex: view.emoteIndex
        });
      } catch (e) {
        parts = null;
      }
      if (!isArray(parts)) {
        container.appendChild(document.createTextNode(event.text || ""));
        return;
      }
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (!part) continue;
        if (part.type === "emote") {
          if (!diag.emote) {
            diag.emote = true;
            logDiag("first emote rendered: " + (part.name || "?") + " -> " + part.url +
              " (index has " + view.emoteIndexSize + " name(s))");
          }
          var img = document.createElement("img");
          img.className = "twt-emote";
          img.src = part.url;
          img.alt = part.name || "";
          img.title = part.name || "";
          img.loading = "lazy";
          img.addEventListener("error", onEmoteImageError);
          container.appendChild(img);
        } else {
          container.appendChild(document.createTextNode(part.text === undefined ? "" : String(part.text)));
        }
      }
      if (!diag.emoteTagMessage && isArray(event.emotes) && event.emotes.length) {
        diag.emoteTagMessage = true;
        var rangeCount = 0;
        for (i = 0; i < event.emotes.length; i++) {
          if (isArray(event.emotes[i].ranges)) rangeCount += event.emotes[i].ranges.length;
        }
        logDiag("first message with a Twitch emotes tag: " + event.emotes.length + " emote(s), " +
          rangeCount + " range(s), index has " + view.emoteIndexSize + " name(s)");
      }
    }

    function appendBadges(row, event) {
      var chat = chatSettings();
      if (!chat.badges || !isArray(event.badges)) return;
      for (var i = 0; i < event.badges.length; i++) {
        var badge = event.badges[i];
        if (!badge || !badge.name) continue;
        var img = document.createElement("img");
        img.className = "twt-badge";
        img.alt = badge.name;
        img.title = badge.version ? badge.name + "/" + badge.version : badge.name;
        img.loading = "lazy";
        img.src = emotesLib.badgeURL(badge.name, badge.version || "1", BADGE_SCALE);
        row.appendChild(img);
      }
    }

    function buildMessage(event) {
      var chat = chatSettings();
      var row = el("div", "twt-msg");
      if (event.isAction) row.classList.add("twt-action");
      if (mention(event.text)) row.classList.add("twt-mention");

      /* A replayed VOD comment is a normal message; the offset into the video
       * and a quiet VOD chip are the only differences from a live row. */
      if (event.replay) {
        row.classList.add("twt-replay");
        row.setAttribute("data-replay", "true");
        var offset = formatOffset(event.offsetSeconds);
        if (offset) {
          var offsetEl = el("span", "twt-vod-offset", offset);
          offsetEl.setAttribute("data-role", "vod-offset");
          row.appendChild(offsetEl);
        }
        var chip = el("span", "twt-chip twt-vod-chip", "VOD");
        chip.title = "Replayed VOD chat";
        chip.setAttribute("data-role", "vod-chip");
        row.appendChild(chip);
      }

      /* A replayed row's `timestamp` is the moment the replay ran (main.js
       * stamps Date.now()), not when the comment was written, so the row must
       * not print it as a wall clock: the original position is the VOD offset
       * above, and one time per row is the point. */
      if (chat.showDatetimes && !event.replay) {
        var time = formatTime(event.timestamp);
        if (time) row.appendChild(el("span", "twt-time", time));
      }
      appendBadges(row, event);

      var name = event.displayName || event.login || "";
      if (chat.usernameShown && name) {
        var nameEl = el("span", "twt-name", name);
        try {
          nameEl.style.color = emotesLib.userColor(event.login || name, event.color, chat.palette);
        } catch (e) { /* keep the default colour */ }
        row.appendChild(nameEl);
        row.appendChild(el("span", "twt-sep", ":"));
      }
      if (event.isWhisper) row.appendChild(el("span", "twt-chip", "whisper"));
      if (event.bits) row.appendChild(el("span", "twt-chip", event.bits + " bits"));

      var textEl = el("span", "twt-text");
      if (event.isAction) textEl.appendChild(el("span", null, "* "));
      appendSegments(textEl, event);
      row.appendChild(textEl);

      if (event.id) row.dataset.msgId = event.id;
      if (event.login) row.dataset.login = event.login;
      /* Kept so an emote index that arrives after this row can re-render it:
       * third-party emotes are only known once transport.js has fetched the
       * provider lists (transport.js -> plugin -> this view). */
      row.twtEvent = event;
      row.twtIndexSize = view.emoteIndexSize;
      return row;
    }

    /* Messages rendered while the emote index was still empty (or smaller)
     * show BTTV/7TV/FFZ names as plain text. When a bigger index lands, rebuild
     * those rows - otherwise an emote that was already on screen stays text
     * forever. Each row is rebuilt at most once per index change, and only
     * rows that were rendered under an older index are touched. */
    function rerenderStaleRows() {
      var nodes = list.children;
      var stale = [];
      for (var i = 0; i < nodes.length; i++) {
        var row = nodes[i];
        if (row && row.twtEvent && (row.twtIndexSize || 0) < view.emoteIndexSize) stale.push(row);
      }
      if (!stale.length) return;
      var wasPinned = view.stick;
      for (var j = 0; j < stale.length; j++) {
        var fresh = buildMessage(stale[j].twtEvent);
        if (stale[j].parentNode === list) list.replaceChild(fresh, stale[j]);
      }
      if (wasPinned) scrollToBottom();
      diag.reRenders++;
      logDiag("re-rendered " + stale.length + " message(s) after the emote index grew to " +
        view.emoteIndexSize + " name(s)");
    }

    function describeMsgId(msgId) {
      if (!msgId) return "";
      return String(msgId).replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    }

    /* Frozen shape of a history message (web view <-> plugin):
     * {id, login, displayName, userId, color, text, emotes, badges, timestamp,
     *  isAction, bits} - the same field names as a live kind:"message" event,
     * so it renders through buildMessage()/segment() unchanged. */
    function historyEvent(message, channel) {
      if (!message || typeof message !== "object" || typeof message.text !== "string") return null;
      return {
        kind: "message",
        history: true,
        channel: message.channel || channel || view.channel,
        id: message.id || "",
        login: message.login || "",
        displayName: message.displayName || message.login || "",
        userId: message.userId || "",
        color: message.color || null,
        text: message.text,
        emotes: isArray(message.emotes) ? message.emotes : [],
        badges: isArray(message.badges) ? message.badges : [],
        timestamp: message.timestamp,
        isAction: !!message.isAction,
        bits: message.bits || 0,
        isWhisper: false,
        roomId: message.roomId || view.channelId
      };
    }

    /* Channel history is requested after the join; the answer is prepended
     * above the live rows, oldest first, with a "previous messages" divider
     * before the first live row. A history message whose id is already on
     * screen (it arrived live while the request was in flight) is skipped, so
     * nothing is rendered twice, and a reader who is not at the bottom keeps
     * their scroll position. Returns the number of rows added. */
    function prependHistory(messages, channel) {
      if (!isArray(messages) || !messages.length) return 0;
      var known = {};
      var nodes = list.children;
      for (var i = 0; i < nodes.length; i++) {
        var id = nodes[i].dataset && nodes[i].dataset.msgId;
        if (id) known[id] = true;
      }
      var ordered = messages.slice().sort(function (a, b) {
        return (Number(a && a.timestamp) || 0) - (Number(b && b.timestamp) || 0);
      });
      var fragment = document.createDocumentFragment();
      var added = 0;
      for (var j = 0; j < ordered.length; j++) {
        var event = historyEvent(ordered[j], channel);
        if (!event) continue;
        if (event.id && known[event.id]) continue;
        if (event.id) known[event.id] = true;
        if (!passesFilters(event)) continue;
        fragment.appendChild(buildMessage(event));
        added++;
      }
      if (!added) return 0;
      var firstLive = list.firstChild;
      if (firstLive) fragment.appendChild(el("div", "twt-history-divider", "previous messages"));
      var wasPinned = view.stick;
      var previousScrollTop = list.scrollTop;
      var previousScrollHeight = list.scrollHeight;
      list.insertBefore(fragment, firstLive);
      applyLimit();
      updateEmptyHint();
      if (wasPinned) scrollToBottom();
      else setScrollTop(previousScrollTop + (list.scrollHeight - previousScrollHeight));
      return added;
    }

    function buildNodes(event) {
      var nodes = [];
      var kind = event && event.kind;
      if (!kind) return nodes;
      switch (kind) {
      case "message":
        if (!passesFilters(event)) return nodes;
        nodes.push(buildMessage(event));
        break;
      case "usernotice":
        if (!passesFilters(event)) return nodes;
        if (event.isRaid) {
          nodes.push(el("div", "twt-system", "Incoming raid: " + (event.raidCount || 0) + " viewers"));
        } else {
          var notice = event.systemMessage || event.text || describeMsgId(event.msgId);
          if (notice) nodes.push(el("div", "twt-system", notice));
          if (event.text && event.systemMessage) nodes.push(buildMessage(event));
        }
        break;
      case "notice":
        nodes.push(el("div", "twt-system", event.text || describeMsgId(event.msgId)));
        break;
      case "clearchat":
        if (event.bannedUser) {
          removeByLogin(event.bannedUser);
          nodes.push(el("div", "twt-system", event.bannedUser +
            (event.isTimeout ? " was timed out for " + (event.duration || 0) + "s" : " was banned")));
        } else {
          clearRows();
          nodes.push(el("div", "twt-system", "chat was cleared"));
        }
        break;
      case "clearmsg":
        removeById(event.id);
        break;
      case "reconnect":
        nodes.push(el("div", "twt-system", "Twitch asked the client to reconnect"));
        break;
      case "roomstate":
      case "userstate":
        onStateEvent(event);
        break;
      default:
        break;
      }
      return nodes;
    }

    function onStateEvent(event) {
      if (event.channel) view.channel = event.channel;
      var roomId = event.roomId || null;
      if (roomId && roomId !== view.channelId) {
        view.channelId = roomId;
        if (typeof view.onChannelId === "function") {
          try {
            view.onChannelId(roomId, event.channel || view.channel);
          } catch (e) { /* third-party emotes are optional */ }
        }
      }
    }

    function passesFilters(event) {
      if (!view.filters || typeof configLib.matchesFilters !== "function") return true;
      if (!configLib.matchesFilters(event.text || "", view.filters.message)) return false;
      if (!configLib.matchesFilters(event.login || "", view.filters.username)) return false;
      return true;
    }

    /* ------------------------------------------------------------- events */

    /* Every event lands in the DOM in the same task: no queue, no timer, no
     * coalescing. The stick-to-bottom rule then runs once for the batch. */
    function appendEvents(events) {
      if (!events.length) return;
      var wasPinned = view.stick;
      var fragment = document.createDocumentFragment();
      var added = 0;
      for (var i = 0; i < events.length; i++) {
        var nodes = buildNodes(events[i]);
        for (var j = 0; j < nodes.length; j++) {
          fragment.appendChild(nodes[j]);
          added++;
        }
      }
      if (added) list.appendChild(fragment);
      applyLimit();
      updateEmptyHint();
      if (wasPinned) {
        scrollToBottom();
      } else if (added) {
        view.unread += added;
        updateJumpButton();
      }
    }

    /* The list handles its own wheel input; mark it so the panel's delegated
     * handler does not scroll twice once the event bubbles up. */
    list.addEventListener("wheel", function (event) {
      if (event) event.__twtWheelHandled = true;
      onWheel(event);
    }, { passive: false });

    list.addEventListener("scroll", function () {
      if (view.programmatic !== null && list.scrollTop === view.programmatic) {
        /* the echo of our own write, not a user scroll */
        view.programmatic = null;
        return;
      }
      view.programmatic = null;
      view.stick = isAtBottom();
      if (view.stick) view.unread = 0;
      updateJumpButton();
    });

    if (jumpButton) {
      jumpButton.addEventListener("click", function () {
        scrollToBottom();
      });
    }

    applyAppearance();
    updateJumpButton();

    return {
      setSettings: function (settings, filters) {
        var previousMax = chatSettings().maxMessages;
        if (settings) view.settings = settings;
        if (filters !== undefined && filters !== null) view.filters = filters;
        applyAppearance();
        var max = chatSettings().maxMessages;
        if (max !== previousMax) applyLimit();
      },
      setFilters: function (filters) {
        view.filters = filters || null;
      },
      /* Status/empty-state text owned by the page; visibility stays with
       * updateEmptyHint() so a hint never covers a non-empty list. */
      setHint: function (text) {
        if (emptyHint) emptyHint.textContent = text === undefined || text === null ? "" : String(text);
      },
      setEmoteIndex: function (index) {
        var previousSize = view.emoteIndexSize;
        view.emoteIndex = index || null;
        view.emoteIndexSize = index ? Object.keys(index).length : 0;
        if (view.emoteIndexSize !== previousSize) {
          logDiag("emote index: " + view.emoteIndexSize + " name(s)");
        }
        if (view.emoteIndexSize > previousSize) rerenderStaleRows();
      },
      setSelf: function (login) {
        view.selfLogin = login || "";
      },
      setChannel: function (channel) {
        view.channel = channel || null;
        view.channelId = null;
      },
      getChannelId: function () {
        return view.channelId;
      },
      addEvent: function (event) {
        if (!event || !event.kind) return;
        /* state events are applied immediately; chat lines render immediately
         * too, so the overlay feels live like twitch.tv */
        if (event.kind === "roomstate" || event.kind === "userstate") {
          buildNodes(event);
          return;
        }
        appendEvents([event]);
      },
      clear: clearRows,
      prependHistory: prependHistory,
      scrollToBottom: scrollToBottom,
      isAtBottom: isAtBottom,
      /* the overlay's panel delegates its wheel events to the list */
      wheelScroll: onWheel
    };
  }

  global.TwitchChat = { create: create };
})(typeof window !== "undefined" ? window : this);
