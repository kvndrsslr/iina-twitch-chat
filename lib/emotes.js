/*
 * lib/emotes.js - emote/badge URLs, third-party emote parsing, message
 * segmentation and username colours.
 *
 * Runs unchanged in IINA's JavaScriptCore, Node and a WKWebView.
 *
 * Third-party endpoint shapes follow twitch-tui's downloader:
 * https://github.com/xithrius/twitch-tui/blob/main/src/emotes/downloader.rs
 * (BTTV: api.betterttv.net/3/cached/...; 7TV: 7tv.io/v3/...;
 *  FFZ: api.frankerfacez.com/v1/set/global and /v1/room/id/<id> - the
 *  "_set"/"_room" variants only list set ids / the room, never emoticons).
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.emotes = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toHexByte(n) {
    var clamped = Math.max(0, Math.min(255, Math.trunc(n)));
    return pad2(clamped.toString(16));
  }

  function rgbToHex(rgb) {
    return "#" + toHexByte(rgb[0]) + toHexByte(rgb[1]) + toHexByte(rgb[2]);
  }

  /* --------------------------------------------------------------- URLs */

  function twitchScale(scale) {
    if (scale === 1 || scale === 2 || scale === 3) return scale + ".0";
    var s = String(scale === null || scale === undefined ? "" : scale);
    return s === "1.0" || s === "2.0" || s === "3.0" ? s : "2.0";
  }

  /**
   * https://static-cdn.jtvnw.net/emoticons/v2/<id>/default/<dark|light>/<1.0|2.0|3.0>
   */
  function twitchEmoteURL(id, options) {
    options = options || {};
    var theme = options.theme === "light" ? "light" : "dark";
    var scale = twitchScale(options.scale === undefined ? "2.0" : options.scale);
    return "https://static-cdn.jtvnw.net/emoticons/v2/" + String(id) + "/default/" + theme + "/" + scale;
  }

  function badgeScale(scale) {
    var n = typeof scale === "number" ? scale : parseInt(String(scale === null || scale === undefined ? "" : scale), 10);
    return n === 1 || n === 3 ? String(n) : "2";
  }

  /**
   * https://static-cdn.jtvnw.net/badges/v1/<set>/<version>/<1|2|3>
   */
  function badgeURL(set, version, scale) {
    return "https://static-cdn.jtvnw.net/badges/v1/" + String(set) + "/" + String(version) + "/" + badgeScale(scale);
  }

  function providerScale(scale, max) {
    var n = typeof scale === "number" ? scale : parseInt(String(scale === null || scale === undefined ? "" : scale).replace(/x$/i, ""), 10);
    if (!isFinite(n) || n < 1) n = 2;
    if (n > max) n = max;
    return String(n);
  }

  // https://cdn.betterttv.net/emote/<id>/<1x|2x|3x>
  function bttvEmoteURL(id, scale) {
    return "https://cdn.betterttv.net/emote/" + String(id) + "/" + providerScale(scale, 3) + "x";
  }

  // https://cdn.7tv.app/emote/<id>/<1x..4x>.webp (twitch-tui uses 1x.webp)
  function seventvEmoteURL(id, scale) {
    return "https://cdn.7tv.app/emote/" + String(id) + "/" + providerScale(scale, 4) + "x.webp";
  }

  // https://cdn.frankerfacez.com/emoticon/<id>/<1..4>
  function ffzEmoteURL(id, scale) {
    return "https://cdn.frankerfacez.com/emoticon/" + String(id) + "/" + providerScale(scale, 4);
  }

  var THIRD_PARTY = {
    bttv: {
      global: "https://api.betterttv.net/3/cached/emotes/global",
      channel: function (channelId) {
        return "https://api.betterttv.net/3/cached/users/twitch/" + String(channelId);
      }
    },
    seventv: {
      global: "https://7tv.io/v3/emote-sets/global",
      channel: function (channelId) {
        return "https://7tv.io/v3/users/twitch/" + String(channelId);
      }
    },
    ffz: {
      /* /v1/_set/global only lists set ids ("default_sets"); /v1/set/global
       * carries the sets themselves, so it is the one the parser can eat.
       * The per-room endpoint is /v1/room/id/<id> ("_room/id/<id>" answers
       * with the room only, no sets). */
      global: "https://api.frankerfacez.com/v1/set/global",
      channel: function (channelId) {
        return "https://api.frankerfacez.com/v1/room/id/" + String(channelId);
      }
    }
  };

  /* ----------------------------------------------------- third-party */

  function normalizeKind(kind) {
    var k = String(kind === null || kind === undefined ? "" : kind).toLowerCase();
    if (k === "7tv" || k === "seventv") return "seventv";
    if (k === "bttv" || k === "betterttv") return "bttv";
    if (k === "ffz" || k === "frankerfacez") return "ffz";
    return "";
  }

  /**
   * Normalise a provider payload into [{id, name, url}].
   * - bttv: [{id, code}] or {channelEmotes, sharedEmotes}
   * - 7tv:  {emotes:[{id,name}]} or {emote_set:{emotes:[...]}}
   * - ffz:  {sets:{<id>:{emoticons:[{id,name}]}}} / {set:{emoticons}} /
   *         {emoticons:[...]}
   */
  function parseThirdParty(kind, json, channelId) {
    var provider = normalizeKind(kind);
    var out = [];
    if (!json || typeof json !== "object") return out;

    function add(id, name, makeURL) {
      if (id === null || id === undefined || id === "") return;
      if (typeof name !== "string" || name === "") return;
      var entry = { id: String(id), name: name, url: makeURL(id) };
      for (var i = 0; i < out.length; i++) {
        if (out[i].id === entry.id && out[i].name === entry.name) return;
      }
      out.push(entry);
    }

    if (provider === "bttv") {
      var list = [];
      if (Array.isArray(json)) {
        list = json;
      } else {
        if (Array.isArray(json.channelEmotes)) list = list.concat(json.channelEmotes);
        if (Array.isArray(json.sharedEmotes)) list = list.concat(json.sharedEmotes);
        if (Array.isArray(json.emotes)) list = list.concat(json.emotes);
      }
      for (var i = 0; i < list.length; i++) {
        if (!list[i] || typeof list[i] !== "object") continue;
        add(list[i].id, typeof list[i].code === "string" ? list[i].code : list[i].name, bttvEmoteURL);
      }
    } else if (provider === "seventv") {
      var emotes = Array.isArray(json.emotes) ? json.emotes :
        (json.emote_set && Array.isArray(json.emote_set.emotes) ? json.emote_set.emotes : []);
      for (var j = 0; j < emotes.length; j++) {
        if (!emotes[j] || typeof emotes[j] !== "object") continue;
        add(emotes[j].id, emotes[j].name, seventvEmoteURL);
      }
    } else if (provider === "ffz") {
      var sets = [];
      if (json.sets && typeof json.sets === "object") {
        for (var key in json.sets) {
          if (!hasOwn(json.sets, key)) continue;
          var set = json.sets[key];
          if (set && Array.isArray(set.emoticons)) sets = sets.concat(set.emoticons);
        }
      }
      if (json.set && Array.isArray(json.set.emoticons)) sets = sets.concat(json.set.emoticons);
      if (Array.isArray(json.emoticons)) sets = sets.concat(json.emoticons);
      for (var k = 0; k < sets.length; k++) {
        if (!sets[k] || typeof sets[k] !== "object") continue;
        add(sets[k].id, sets[k].name, ffzEmoteURL);
      }
    }

    // channelId is accepted for parity with the provider APIs; the payload
    // already contains everything parsed here.
    return out;
  }

  /* --------------------------------------------------------------- HSL */

  // Verbatim port of twitch-tui's username colour algorithm:
  // src/handlers/data.rs `hash_username` (Palette -> HSL bands) and
  // src/utils/colors.rs `hsl_to_rgb`. twitch-tui's `Palette` enum is NOT
  // inert: it selects the saturation/lightness band and the hue range.
  var PALETTE_BANDS = {
    pastel: { hue: function (hash) { return hash % 360 + 1; }, saturation: 0.5, lightness: 0.75 },
    vibrant: { hue: function (hash) { return hash % 360 + 1; }, saturation: 1, lightness: 0.6 },
    warm: { hue: function (hash) { return (hash % 100 + 1) * 1.2; }, saturation: 0.8, lightness: 0.7 },
    cool: { hue: function (hash) { return (hash % 100 + 1) * 1.2 + 180; }, saturation: 0.6, lightness: 0.7 }
  };

  function hslToRgb(hue, saturation, lightness) {
    var chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    var x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    var m = lightness - chroma / 2;
    var h = Math.round(hue);
    var rgb;
    if (h <= 60) rgb = [chroma, x, 0];
    else if (h <= 120) rgb = [x, chroma, 0];
    else if (h <= 180) rgb = [0, chroma, x];
    else if (h <= 240) rgb = [0, x, chroma];
    else if (h <= 300) rgb = [x, 0, chroma];
    else rgb = [chroma, 0, x];
    return [
      Math.trunc((rgb[0] + m) * 255),
      Math.trunc((rgb[1] + m) * 255),
      Math.trunc((rgb[2] + m) * 255)
    ];
  }

  // UTF-8 bytes, matching Rust's str::as_bytes() used by twitch-tui.
  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var low = str.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  /**
   * PALETTES maps each twitch-tui palette name to representative hex swatches
   * sampled from the same HSL bands used by userColor. twitch-tui itself has
   * no fixed hex table (see PALETTE_BANDS), so these swatches exist for UI
   * previews; userColor consumes PALETTES for palette selection/validation
   * and computes the exact continuous colour from the matching band.
   */
  var PALETTES = {};
  (function buildPalettes() {
    var names = ["pastel", "vibrant", "warm", "cool"];
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      var band = PALETTE_BANDS[name];
      var step = name === "pastel" || name === "vibrant" ? 30 : 8;
      var swatches = [];
      for (var i = 0; i < 12; i++) {
        swatches.push(rgbToHex(hslToRgb(band.hue(i * step), band.saturation, band.lightness)));
      }
      PALETTES[name] = swatches;
    }
  })();

  function normalizePalette(palette) {
    var p = String(palette === null || palette === undefined ? "" : palette).toLowerCase();
    return hasOwn(PALETTES, p) ? p : "pastel";
  }

  /**
   * userColor(login, twitchColor, palette) -> "#rrggbb"
   * The Twitch-supplied colour wins; otherwise the selected palette's HSL
   * band (PALETTES registry + twitch-tui band values) picks a stable colour
   * from the byte-sum hash of the login. Never throws.
   */
  function userColor(login, twitchColor, palette) {
    if (typeof twitchColor === "string") {
      if (/^#[0-9a-fA-F]{6}$/.test(twitchColor)) return twitchColor.toLowerCase();
      if (/^#[0-9a-fA-F]{3}$/.test(twitchColor)) {
        return ("#" + twitchColor.charAt(1) + twitchColor.charAt(1) +
          twitchColor.charAt(2) + twitchColor.charAt(2) +
          twitchColor.charAt(3) + twitchColor.charAt(3)).toLowerCase();
      }
    }
    var name = typeof login === "string" ? login : login === null || login === undefined ? "" : String(login);
    var bytes = utf8Bytes(name);
    var hash = 0;
    for (var i = 0; i < bytes.length; i++) hash = (hash + bytes[i]) >>> 0;
    var paletteName = normalizePalette(palette);
    var swatches = PALETTES[paletteName];
    var band = PALETTE_BANDS[paletteName];
    // The swatch list is the palette registry; the exact colour below uses
    // the same HSL parameters the swatches were generated from.
    if (!swatches || !band) return "#ffffff";
    return rgbToHex(hslToRgb(band.hue(hash), band.saturation, band.lightness));
  }

  /* ----------------------------------------------------------- segment */

  // Map code point index -> UTF-16 index (Twitch emote ranges are code point
  // based, see the comment in lib/irc.js).
  function codePointBoundaries(text) {
    var map = [];
    var i = 0;
    var cp = 0;
    while (i < text.length) {
      map[cp] = i;
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        i += low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
      } else {
        i += 1;
      }
      cp++;
    }
    map[cp] = text.length;
    return map;
  }

  function twitchURLFor(id) {
    return twitchEmoteURL(id, {});
  }

  /**
   * segment(text, {emotes?, emoteIndex?}) ->
   *   [{type:"text", text} | {type:"emote", name, url}]
   *
   * `emotes` is the parsed tag ([{id, ranges:[[start,end],...]}]); ranges are
   * code point offsets. Remaining text is tokenised on whitespace and looked
   * up in `emoteIndex` (name -> URL) for BTTV/7TV/FFZ emotes. Every character
   * of the input appears exactly once in the output.
   */
  function segment(text, options) {
    options = options || {};
    var body = text === null || text === undefined ? "" : String(text);
    var emotes = Array.isArray(options.emotes) ? options.emotes : [];
    var emoteIndex = options.emoteIndex && typeof options.emoteIndex === "object" ? options.emoteIndex : null;
    var out = [];

    function pushItem(item) {
      if (item.type === "text" && item.text === "") return;
      var last = out[out.length - 1];
      if (item.type === "text" && last && last.type === "text") {
        last.text += item.text;
      } else {
        out.push(item);
      }
    }

    function pushText(chunk) {
      if (!chunk) return;
      if (!emoteIndex) {
        pushItem({ type: "text", text: chunk });
        return;
      }
      var pieces = chunk.split(/(\s+)/);
      for (var i = 0; i < pieces.length; i++) {
        var piece = pieces[i];
        if (!piece) continue;
        if (/^\s+$/.test(piece)) {
          pushItem({ type: "text", text: piece });
        } else if (hasOwn(emoteIndex, piece)) {
          pushItem({ type: "emote", name: piece, url: String(emoteIndex[piece]) });
        } else {
          pushItem({ type: "text", text: piece });
        }
      }
    }

    if (!emotes.length) {
      pushText(body);
      return out;
    }

    var boundaries = codePointBoundaries(body);
    var maxCp = boundaries.length - 1;

    var ranges = [];
    for (var i = 0; i < emotes.length; i++) {
      var emote = emotes[i];
      if (!emote || !Array.isArray(emote.ranges)) continue;
      for (var j = 0; j < emote.ranges.length; j++) {
        var range = emote.ranges[j];
        var start = range[0];
        var end = range[1];
        if (typeof start !== "number" || typeof end !== "number") continue;
        if (start < 0 || end < start || start >= maxCp) continue;
        if (end >= maxCp) end = maxCp - 1;
        ranges.push({ start: start, end: end, id: emote.id });
      }
    }
    ranges.sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });

    var cursorCp = 0;
    for (var r = 0; r < ranges.length; r++) {
      var item = ranges[r];
      if (item.start < cursorCp) continue; // overlapping range: skip
      if (item.start > cursorCp) {
        pushText(body.slice(boundaries[cursorCp], boundaries[item.start]));
      }
      var name = body.slice(boundaries[item.start], boundaries[item.end + 1]);
      var url = emoteIndex && hasOwn(emoteIndex, name) ? String(emoteIndex[name]) : twitchURLFor(item.id);
      pushItem({ type: "emote", name: name, url: url });
      cursorCp = item.end + 1;
    }
    if (cursorCp < maxCp) pushText(body.slice(boundaries[cursorCp]));

    return out;
  }

  return {
    twitchEmoteURL: twitchEmoteURL,
    badgeURL: badgeURL,
    bttvEmoteURL: bttvEmoteURL,
    seventvEmoteURL: seventvEmoteURL,
    ffzEmoteURL: ffzEmoteURL,
    THIRD_PARTY: THIRD_PARTY,
    parseThirdParty: parseThirdParty,
    segment: segment,
    PALETTES: PALETTES,
    userColor: userColor
  };
});
