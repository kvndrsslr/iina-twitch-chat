"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const em = require("../lib/emotes.js");

const ROOT = path.join(__dirname, "..");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

/* ---------------------------------------------------------------- URLs */

test("twitchEmoteURL builds CDN URLs with theme and scale", () => {
  assert.equal(
    em.twitchEmoteURL("62835"),
    "https://static-cdn.jtvnw.net/emoticons/v2/62835/default/dark/2.0"
  );
  assert.equal(
    em.twitchEmoteURL("62835", { theme: "light", scale: "3.0" }),
    "https://static-cdn.jtvnw.net/emoticons/v2/62835/default/light/3.0"
  );
  assert.equal(
    em.twitchEmoteURL("62835", { theme: "light", scale: 1 }),
    "https://static-cdn.jtvnw.net/emoticons/v2/62835/default/light/1.0"
  );
});

test("badgeURL builds the badge CDN URL", () => {
  assert.equal(em.badgeURL("subscriber", "6", 2), "https://static-cdn.jtvnw.net/badges/v1/subscriber/6/2");
  assert.equal(em.badgeURL("moderator", "1", 1), "https://static-cdn.jtvnw.net/badges/v1/moderator/1/1");
});

test("third-party emote URL builders", () => {
  assert.equal(em.bttvEmoteURL("5e9c76ffb0c2ae7ab5d5f7e0", 1), "https://cdn.betterttv.net/emote/5e9c76ffb0c2ae7ab5d5f7e0/1x");
  assert.equal(em.seventvEmoteURL("62cdb2a6e7b0e627fc103a0c", 2), "https://cdn.7tv.app/emote/62cdb2a6e7b0e627fc103a0c/2x.webp");
  assert.equal(em.ffzEmoteURL("305954319", 3), "https://cdn.frankerfacez.com/emoticon/305954319/3");
});

test("THIRD_PARTY exposes global and per-channel endpoints", () => {
  assert.equal(em.THIRD_PARTY.bttv.global, "https://api.betterttv.net/3/cached/emotes/global");
  assert.equal(em.THIRD_PARTY.bttv.channel("123"), "https://api.betterttv.net/3/cached/users/twitch/123");
  assert.equal(em.THIRD_PARTY.seventv.global, "https://7tv.io/v3/emote-sets/global");
  assert.equal(em.THIRD_PARTY.seventv.channel("123"), "https://7tv.io/v3/users/twitch/123");
  /* Measured against the live API: /v1/_set/global answers {"default_sets":[..]}
   * (set ids only) and /v1/_room/id/<id> answers {"room":{..}} (no sets), so
   * neither can feed parseThirdParty - /v1/set/global carries "sets" with
   * "emoticons" and /v1/room/id/<id> carries the room's "sets". */
  assert.equal(em.THIRD_PARTY.ffz.global, "https://api.frankerfacez.com/v1/set/global");
  assert.equal(em.THIRD_PARTY.ffz.channel("123"), "https://api.frankerfacez.com/v1/room/id/123");
});

/* ------------------------------------------------------ third-party */

test("parseThirdParty bttv global array and channel object", () => {
  const global = [
    { id: "5e9c76ffb0c2ae7ab5d5f7e0", code: "KEKW", imageType: "png", animated: true, modifier: false },
    { id: "60ae3a9cdfc9c4a2e5b0f1e0", code: "OMEGALUL", imageType: "png", animated: false, modifier: false },
  ];
  const parsed = em.parseThirdParty("bttv", global, "123");
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    id: "5e9c76ffb0c2ae7ab5d5f7e0",
    name: "KEKW",
    url: "https://cdn.betterttv.net/emote/5e9c76ffb0c2ae7ab5d5f7e0/2x",
  });

  const channel = {
    id: "123",
    channelEmotes: [{ id: "aa", code: "catJAM", imageType: "gif" }],
    sharedEmotes: [{ id: "bb", code: "PogU", imageType: "png" }],
  };
  const parsedChannel = em.parseThirdParty("bttv", channel, "123");
  assert.deepEqual(parsedChannel.map((e) => e.name), ["catJAM", "PogU"]);
});

test("parseThirdParty seventv emote_set payload", () => {
  const payload = {
    emote_set: {
      emotes: [
        { id: "62cdb2a6e7b0e627fc103a0c", name: "Pog", flags: 0, tags: [], lifecycle: 2 },
        { id: "62cdb2a7e7b0e627fc103a0d", name: "EZ", flags: 1 },
      ],
    },
  };
  const parsed = em.parseThirdParty("7tv", payload, "123");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Pog");
  assert.equal(parsed[0].url, "https://cdn.7tv.app/emote/62cdb2a6e7b0e627fc103a0c/2x.webp");
});

test("parseThirdParty ffz sets payload", () => {
  const payload = {
    sets: {
      123456: {
        id: 123456,
        emoticons: [
          { id: 305954319, name: "Pog", height: 28, width: 28 },
          { id: 305954320, name: "Pepega", height: 28, width: 28 },
        ],
      },
    },
  };
  const parsed = em.parseThirdParty("ffz", payload, "123");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].name, "Pepega");
  assert.equal(parsed[1].url, "https://cdn.frankerfacez.com/emoticon/305954320/2");
});

test("parseThirdParty tolerates unknown kinds and null payloads", () => {
  assert.deepEqual(em.parseThirdParty("nope", {}, "1"), []);
  assert.deepEqual(em.parseThirdParty("bttv", null, "1"), []);
});

/* The fixtures below are trimmed copies of the live responses (channel
 * 92038375 = caedrel), so a provider that changes its payload shape breaks a
 * test instead of silently contributing zero emotes. */

test("parseThirdParty reads the live BTTV global and channel payloads", () => {
  const global = em.parseThirdParty("bttv", fixture("emotes-bttv-global.json"), "92038375");
  assert.deepEqual(global.map((e) => e.name), [":tf:", "CiGrip"]);
  assert.equal(global[0].url, "https://cdn.betterttv.net/emote/54fa8f1401e468494b85b537/2x");

  /* channelEmotes + sharedEmotes, the shape /3/cached/users/twitch/<id> uses */
  const channel = em.parseThirdParty("bttv", fixture("emotes-bttv-channel.json"), "92038375");
  assert.deepEqual(channel.map((e) => e.name), ["caedJAMMER", "caedJAM", "PepePls"]);
});

test("parseThirdParty reads the live 7TV global payload and the channel emote set", () => {
  const global = em.parseThirdParty("seventv", fixture("emotes-7tv-global.json"), "92038375");
  assert.deepEqual(global.map((e) => e.name), ["reckH", "PETPET"]);

  const channel = em.parseThirdParty("7tv", fixture("emotes-7tv-channel.json"), "92038375");
  assert.deepEqual(channel.map((e) => e.name), ["o7", "xdd"]);
  assert.equal(channel[0].url, "https://cdn.7tv.app/emote/01FS5ZCFG0000500DPPCXJWCP8/2x.webp");
  assert.equal(channel[1].url, "https://cdn.7tv.app/emote/01FF3R5C30000FF5VVCKV49G6J/2x.webp");
});

test("parseThirdParty reads the live FFZ set/global and room payloads", () => {
  const global = em.parseThirdParty("ffz", fixture("emotes-ffz-global.json"), "92038375");
  assert.deepEqual(global.map((e) => e.name), ["ZrehplaR", "YooHoo"]);

  const room = em.parseThirdParty("ffz", fixture("emotes-ffz-room.json"), "92038375");
  assert.deepEqual(room.map((e) => e.name), ["Pog", "MEGALUL"]);
  assert.equal(room[0].url, "https://cdn.frankerfacez.com/emoticon/210748/2");
});

test("every fixture URL host is reachable through the plugin's allowedDomains", () => {
  const allowed = ["irc-ws.chat.twitch.tv", "*.twitch.tv", "*.jtvnw.net", "api.betterttv.net",
    "cdn.betterttv.net", "7tv.io", "api.7tv.app", "cdn.7tv.app",
    "api.frankerfacez.com", "cdn.frankerfacez.com"];
  const hosts = [];
  for (const [kind, file] of [["bttv", "emotes-bttv-global.json"], ["bttv", "emotes-bttv-channel.json"],
    ["seventv", "emotes-7tv-global.json"], ["7tv", "emotes-7tv-channel.json"],
    ["ffz", "emotes-ffz-global.json"], ["ffz", "emotes-ffz-room.json"]]) {
    for (const emote of em.parseThirdParty(kind, fixture(file), "92038375")) {
      hosts.push(new URL(emote.url).hostname);
    }
  }
  for (const [kindKey, urls] of [["bttv", [em.THIRD_PARTY.bttv.global, em.THIRD_PARTY.bttv.channel("92038375")]],
    ["seventv", [em.THIRD_PARTY.seventv.global, em.THIRD_PARTY.seventv.channel("92038375")]],
    ["ffz", [em.THIRD_PARTY.ffz.global, em.THIRD_PARTY.ffz.channel("92038375")]]]) {
    for (const url of urls) {
      const host = new URL(url).hostname;
      assert.ok(allowed.some((pattern) => (pattern.startsWith("*")
        ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
        : host === pattern)), kindKey + " endpoint host " + host + " is not in allowedDomains");
    }
  }
  for (const host of hosts) {
    assert.ok(allowed.some((pattern) => (pattern.startsWith("*")
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern)), "image host " + host + " is not in allowedDomains");
  }
});

test("segment matches third-party names as whole, case-sensitive tokens", () => {
  const index = {};
  for (const emote of em.parseThirdParty("7tv", fixture("emotes-7tv-channel.json"), "92038375")) {
    index[emote.name] = emote.url;
  }
  const o7 = "https://cdn.7tv.app/emote/01FS5ZCFG0000500DPPCXJWCP8/2x.webp";
  const xdd = "https://cdn.7tv.app/emote/01FF3R5C30000FF5VVCKV49G6J/2x.webp";

  assert.deepEqual(em.segment("o7 xdd", { emoteIndex: index }), [
    { type: "emote", name: "o7", url: o7 },
    { type: "text", text: " " },
    { type: "emote", name: "xdd", url: xdd },
  ]);
  /* case matters ("07" and "xDD" are not emotes), and a token with attached
   * punctuation is left alone rather than mangled into a false positive */
  const parts = em.segment("07 xDD xdd, o7", { emoteIndex: index });
  assert.deepEqual(parts, [
    { type: "text", text: "07 xDD xdd, " },
    { type: "emote", name: "o7", url: o7 },
  ]);
  assert.equal(parts.map((p) => (p.type === "emote" ? p.name : p.text)).join(""), "07 xDD xdd, o7");
});

/* ----------------------------------------------------------- segment */

test("segment uses code point indices (emoji before emote)", () => {
  // "😀 Kappa": 😀 is code point 0, space 1, "Kappa" code points 2-6.
  const parts = em.segment("😀 Kappa", { emotes: [{ id: "25", ranges: [[2, 6]] }] });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: "text", text: "😀 " });
  assert.deepEqual(parts[1], {
    type: "emote",
    name: "Kappa",
    url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
  });
});

test("segment handles multi-range emotes and adjacent emotes without loss", () => {
  const parts = em.segment("Kappa Keepo Kappa", {
    emotes: [
      { id: "25", ranges: [[0, 4], [12, 16]] },
      { id: "1902", ranges: [[6, 10]] },
    ],
  });
  assert.deepEqual(parts, [
    { type: "emote", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0" },
    { type: "text", text: " " },
    { type: "emote", name: "Keepo", url: "https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/2.0" },
    { type: "text", text: " " },
    { type: "emote", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0" },
  ]);

  // Adjacent emotes with no gap.
  const adjacent = em.segment("KappaKappa", { emotes: [{ id: "25", ranges: [[0, 4], [5, 9]] }] });
  assert.equal(adjacent.length, 2);
  assert.equal(adjacent[0].type, "emote");
  assert.equal(adjacent[1].type, "emote");
});

test("segment reconstructs the original text exactly", () => {
  const text = "😀 Kappa Keepo Kappa 🎉 done";
  const parts = em.segment(text, {
    emotes: [
      { id: "25", ranges: [[2, 6]] },
      { id: "1902", ranges: [[8, 12]] },
    ],
  });
  const rebuilt = parts.map((p) => (p.type === "emote" ? p.name : p.text)).join("");
  assert.equal(rebuilt, text);
});

test("segment falls back to emoteIndex for whitespace-delimited tokens", () => {
  const index = { KEKW: "https://cdn.betterttv.net/emote/abc/2x", catJAM: "https://cdn.betterttv.net/emote/def/2x" };
  const parts = em.segment("hello  KEKW  catJAM bye", { emotes: [], emoteIndex: index });
  assert.deepEqual(parts, [
    { type: "text", text: "hello  " },
    { type: "emote", name: "KEKW", url: "https://cdn.betterttv.net/emote/abc/2x" },
    { type: "text", text: "  " },
    { type: "emote", name: "catJAM", url: "https://cdn.betterttv.net/emote/def/2x" },
    { type: "text", text: " bye" },
  ]);
});

test("segment merges adjacent text nodes and never drops characters", () => {
  const parts = em.segment("plain message with emotes", { emotes: [], emoteIndex: null });
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { type: "text", text: "plain message with emotes" });
});

/* ---------------------------------------------------------- userColor */

test("userColor prefers the Twitch-supplied colour", () => {
  assert.equal(em.userColor("x", "#0D4200", "pastel"), "#0d4200");
  assert.equal(em.userColor("x", "#ABC", "vibrant"), "#aabbcc");
  assert.equal(em.userColor("x", "not-a-colour", "pastel"), em.userColor("x", null, "pastel"));
});

test("userColor is stable per login and palette-aware", () => {
  const a1 = em.userColor("forstycup", null, "pastel");
  const a2 = em.userColor("forstycup", null, "pastel");
  const a3 = em.userColor("forstycup", null, "PASTEL"); // case-insensitive
  assert.equal(a1, a2);
  assert.equal(a1, a3);
  assert.match(a1, /^#[0-9a-f]{6}$/);
  const b = em.userColor("another_login", null, "vibrant");
  assert.match(b, /^#[0-9a-f]{6}$/);
});

test("userColor never throws on whitespace or missing input", () => {
  assert.match(em.userColor("", null, "pastel"), /^#[0-9a-f]{6}$/);
  assert.match(em.userColor("   ", null, "warm"), /^#[0-9a-f]{6}$/);
  assert.match(em.userColor(null, null, "cool"), /^#[0-9a-f]{6}$/);
  assert.match(em.userColor(undefined, undefined, undefined), /^#[0-9a-f]{6}$/);
});

test("userColor palette setting produces distinct, stable colours", () => {
  const login = "forstycup";
  const names = ["pastel", "vibrant", "warm", "cool"];
  const colors = names.map((name) => em.userColor(login, null, name));
  assert.equal(new Set(colors).size, 4, "each palette yields a different colour: " + colors.join(","));
  for (const name of names) {
    assert.equal(em.userColor(login, null, name), em.userColor(login, null, name));
    assert.match(em.userColor(login, null, name), /^#[0-9a-f]{6}$/);
  }
});

test("PALETTES swatches are generated per palette and differ", () => {
  assert.deepEqual(Object.keys(em.PALETTES).sort(), ["cool", "pastel", "vibrant", "warm"]);
  for (const name of ["pastel", "vibrant", "warm", "cool"]) {
    assert.equal(em.PALETTES[name].length, 12);
  }
  assert.notDeepEqual(em.PALETTES.pastel, em.PALETTES.vibrant);
  assert.notDeepEqual(em.PALETTES.warm, em.PALETTES.cool);
});

test("PALETTES exposes four palettes of hex colours", () => {
  for (const name of ["pastel", "vibrant", "warm", "cool"]) {
    assert.ok(Array.isArray(em.PALETTES[name]));
    assert.ok(em.PALETTES[name].length > 0);
    for (const c of em.PALETTES[name]) assert.match(c, /^#[0-9a-f]{6}$/);
  }
});

/* ------------------------------------------------- overlay render harness
 *
 * The overlay reaches an emote through plugin -> ui/overlay-view.js ->
 * chat-view.js, and it is the only consumer of the index that arrives over the
 * plugin relay (the sidebar also hands its index to chat-view directly). This
 * harness runs the real page scripts of ui/overlay.html inside a minimal DOM
 * and drives the plugin side of the "twt:*" protocol, exactly like main.js
 * does: twt:settings, then twt:emotes, then twt:event.
 */

function makeTextNode(data) {
  return {
    nodeType: 3,
    data: String(data),
    parentNode: null,
    get textContent() {
      return this.data;
    },
  };
}

/* A DOM event the fake DOM can hand to a listener: real events carry
 * coordinates and a preventDefault()/stopPropagation(), and the page code uses
 * both. */
function domEvent(type, props) {
  return Object.assign({
    type,
    bubbles: true,
    button: 0,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  }, props || {});
}

/* data-clickable -> clickable, the way dataset mirrors data-* attributes */
function dataKey(name) {
  return name.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase());
}

/* window and document need the same addEventListener contract as an element */
function addEventTarget(target) {
  const listeners = {};
  target.addEventListener = (type, listener) => {
    (listeners[type] = listeners[type] || []).push(listener);
  };
  target.removeEventListener = (type, listener) => {
    const list = listeners[type];
    if (!list) return;
    const at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
  };
  target.dispatchEvent = (event) => {
    for (const listener of (listeners[event.type] || []).slice()) listener(event);
    return true;
  };
  return target;
}

function makeElement(tag) {
  const classes = new Set();
  const listeners = {};
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attrs: {},
    dataset: {},
    style: {},
    hidden: false,
    loading: "",
    alt: "",
    title: "",
    src: "",
    value: "",
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    /* optional test-only box for elementFromPoint()/hit-test modelling */
    rect: null,
    z: 0,
    /* test-only mirror of `pointer-events: none` (decorative panel content) */
    pointerEvents: "",
    classList: {
      add() {
        for (const name of arguments) classes.add(name);
      },
      remove() {
        for (const name of arguments) classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      if (child.nodeType === 11) {
        for (const inner of child.childNodes.slice()) node.appendChild(inner);
        child.childNodes.length = 0;
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child, reference) {
      if (child.nodeType === 11) {
        for (const inner of child.childNodes.slice()) node.insertBefore(inner, reference);
        child.childNodes.length = 0;
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      const at = reference ? node.childNodes.indexOf(reference) : -1;
      if (at === -1) node.childNodes.push(child);
      else node.childNodes.splice(at, 0, child);
      return child;
    },
    replaceChild(fresh, old) {
      const at = node.childNodes.indexOf(old);
      if (at === -1) throw new Error("replaceChild: node is not a child of this element");
      fresh.parentNode = node;
      old.parentNode = null;
      node.childNodes[at] = fresh;
      return old;
    },
    removeChild(child) {
      const at = node.childNodes.indexOf(child);
      if (at !== -1) {
        node.childNodes.splice(at, 1);
        child.parentNode = null;
      }
      return child;
    },
    setAttribute(name, value) {
      node.attrs[name] = String(value);
      /* the real DOM mirrors data-* attributes into dataset; querySelectorAll()
       * below reads dataset, so [data-clickable] finds what setAttribute set */
      if (/^data-/.test(name)) node.dataset[dataKey(name)] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
    },
    removeAttribute(name) {
      delete node.attrs[name];
      if (/^data-/.test(name)) delete node.dataset[dataKey(name)];
    },
    addEventListener(type, listener) {
      (listeners[type] = listeners[type] || []).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners[type];
      if (!list) return;
      const at = list.indexOf(listener);
      if (at !== -1) list.splice(at, 1);
    },
    dispatchEvent(event) {
      const payload = event || {};
      if (!payload.type) throw new Error("dispatchEvent: event has no type");
      if (!payload.target) payload.target = node;
      for (const listener of (listeners[payload.type] || []).slice()) listener(payload);
      return true;
    },
    dispatch(type, props) {
      return node.dispatchEvent(domEvent(type, props));
    },
    querySelectorAll(selector) {
      const found = [];
      const pattern = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      const walk = (current) => {
        for (const child of current.childNodes) {
          if (child.nodeType !== 1) continue;
          if (pattern) {
            const key = pattern[1].replace(/^data-/, "").replace(/-(\w)/g, (m, c) => c.toUpperCase());
            const value = child.dataset[key];
            if (value !== undefined && (pattern[2] === undefined || String(value) === pattern[2])) found.push(child);
          }
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    get firstChild() {
      return node.childNodes[0] || null;
    },
    get children() {
      return node.childNodes.filter((child) => child.nodeType === 1);
    },
    get childElementCount() {
      return node.children.length;
    },
    getBoundingClientRect() {
      const rect = node.rect;
      return rect
        ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h,
            right: rect.x + rect.w, bottom: rect.y + rect.h }
        : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    },
  };
  Object.defineProperty(node, "className", {
    get: () => Array.from(classes).join(" "),
    set(value) {
      classes.clear();
      String(value || "").split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
  });
  Object.defineProperty(node, "textContent", {
    get: () => node.childNodes.map((child) => (child.nodeType === 3 ? child.data : child.textContent)).join(""),
    set(value) {
      node.childNodes.length = 0;
      if (value !== undefined && value !== null && value !== "") node.appendChild(makeTextNode(value));
    },
  });
  return node;
}

/* Loads the real scripts of a page (in the order its <script> tags use) with a
 * stub `iina` that records what the web view posts. `options.width/height` are
 * the web view viewport a layout test measures against. */
function openPage(htmlFile, scripts, options) {
  const opts = options || {};
  const html = fs.readFileSync(path.join(ROOT, htmlFile), "utf8");
  const body = makeElement("body");
  const byId = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const element = makeElement("div");
    byId.set(match[1], element);
    body.appendChild(element);
  }
  const document = {
    body,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => makeTextNode(text),
    createDocumentFragment: () => {
      const fragment = makeElement("#fragment");
      fragment.nodeType = 11;
      return fragment;
    },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    elementFromPoint: (x, y) => topElementAt(Number(x), Number(y)),
  };
  addEventTarget(document);
  const messages = {};
  const sent = [];
  const sockets = [];
  const timers = [];
  const sandbox = {
    document,
    location: { href: "file://" + path.join(ROOT, htmlFile) },
    iina: {
      postMessage: (name, data) => sent.push({ name, data }),
      onMessage: (name, callback) => {
        (messages[name] = messages[name] || []).push(callback);
      },
    },
    setTimeout: (fn, ms) => {
      const entry = { fn, at: Number(ms) || 0, fired: false };
      entry.real = setTimeout(() => {
        if (entry.fired) return;
        entry.fired = true;
        fn();
      }, entry.at);
      timers.push(entry);
      return entry.real;
    },
    clearTimeout: (id) => {
      for (const entry of timers) {
        if (entry.real === id && !entry.fired) entry.fired = true;
      }
      clearTimeout(id);
    },
    setInterval: () => 0,
    clearInterval() {},
    /* lib/irc.js assigns onopen/onmessage/onclose on whatever the factory
     * returns, so a plain object is a complete fake server socket. */
    WebSocket: function (url) {
      const socket = {
        url,
        readyState: 1,
        sent: [],
        send(line) {
          socket.sent.push(String(line));
        },
        close() {
          socket.readyState = 3;
        },
      };
      sockets.push(socket);
      return socket;
    },
    /* tests never reach the network: provider fetches stay pending */
    fetch: () => new Promise(() => {}),
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  /* the overlay lays itself out against the web view viewport */
  sandbox.innerWidth = opts.width === undefined ? 1280 : opts.width;
  sandbox.innerHeight = opts.height === undefined ? 720 : opts.height;
  addEventTarget(sandbox);
  const context = vm.createContext(sandbox);
  for (const file of scripts) {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), "utf8"), { filename: file }).runInContext(context);
  }
  const messagesElement = byId.get("messages");
  /* Minimal elementFromPoint: the topmost element whose test-only rect
   * contains the point. Later DOM order paints on top, an explicit z-index
   * wins over document order, and display:none/hidden elements are skipped,
   * like a real DOM. */
  const topElementAt = (x, y) => {
    const order = new Map();
    let index = 0;
    const number = (node) => {
      order.set(node, index++);
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        number(child);
      }
    };
    number(body);
    let best = null;
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        walk(child);
        const rect = child.rect;
        if (!rect || child.style.display === "none" || child.hidden) continue;
        if (child.pointerEvents === "none") continue;
        if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) continue;
        if (!best || (child.z || 0) > (best.z || 0) ||
          ((child.z || 0) === (best.z || 0) && order.get(child) > order.get(best))) {
          best = child;
        }
      }
    };
    walk(body);
    return best;
  };
  const walk = (current, visit) => {
    for (const child of current.childNodes) {
      if (child.nodeType !== 1) continue;
      visit(child);
      walk(child, visit);
    }
  };
  return {
    sent,
    /* how many setTimeout() calls the page made (the render path must be
     * timer-free; transport.js still schedules its own) */
    timerCount() {
      return timers.length;
    },
    /* how many recorded timers have not fired yet */
    pendingTimers() {
      return timers.filter((entry) => !entry.fired).length;
    },
    /* fire every recorded timer scheduled within `ms` (in insertion order) and
     * return the number still pending; real timers keep working, this only
     * pulls the ones a synchronous test could not wait for */
    advanceTimers(ms) {
      const due = timers.filter((entry) => !entry.fired && entry.at <= ms);
      for (const entry of due) {
        entry.fired = true;
        clearTimeout(entry.real);
        entry.fn();
      }
      return this.pendingTimers();
    },
    /* plugin -> web view */
    fromPlugin(name, payload) {
      for (const handler of (messages[name] || []).slice()) handler(payload);
    },
    /* web view -> plugin, filtered by message name (JSON-normalised: the
     * payloads are built inside the vm realm) */
    posted(name) {
      return sent.filter((entry) => entry.name === name)
        .map((entry) => JSON.parse(JSON.stringify(entry.data === undefined ? null : entry.data)));
    },
    byId(id) {
      return byId.get(id);
    },
    /* elements by the same selector subset querySelectorAll() supports:
     * [attr] / [attr="value"], searching the whole document */
    find(selector) {
      return body.querySelectorAll(selector);
    },
    /* the topmost element at a point - what a real document.elementFromPoint
     * returns (no data-clickable filtering) */
    elementAt(x, y) {
      return document.elementFromPoint(x, y);
    },
    /* IINA 1.5.0 PluginOverlayView._hitTest, verbatim: only the topmost
     * element under the pointer counts and it must carry data-clickable */
    iinaHit(x, y) {
      const top = document.elementFromPoint(x, y);
      return top && top.dataset.clickable !== undefined ? top : null;
    },
    /* the harness hit test: walk up from the topmost element to the first
     * data-clickable ancestor (more permissive than IINA's own check) */
    hitTest(x, y) {
      let node = document.elementFromPoint(x, y);
      while (node) {
        if (node.dataset.clickable !== undefined) return node;
        node = node.parentNode;
      }
      return null;
    },
    /* a real DOM event on an element, the way the page would receive one */
    fire(target, type, props) {
      const payload = domEvent(type, props);
      target.dispatchEvent(payload);
      return payload;
    },
    /* window-level listeners: mousemove/mouseup/keydown/resize */
    fireWindow(type, props) {
      const payload = domEvent(type, props);
      sandbox.dispatchEvent(payload);
      return payload;
    },
    key(key, props) {
      return this.fireWindow("keydown", Object.assign({ key }, props || {}));
    },
    /* the transport listens for Escape on document, not window */
    documentKey(key, props) {
      const payload = domEvent("keydown", Object.assign({ key }, props || {}));
      document.dispatchEvent(payload);
      return payload;
    },
    resize(width, height) {
      sandbox.innerWidth = width;
      sandbox.innerHeight = height;
      return this.fireWindow("resize", {});
    },
    /* one line of raw IRC from the fake server */
    line(raw) {
      const socket = sockets[sockets.length - 1];
      if (!socket || !socket.onmessage) throw new Error("no IRC socket has been opened yet");
      socket.onmessage({ data: raw + "\r\n" });
    },
    rows() {
      return messagesElement.children.filter((node) => /(^|\s)twt-msg(\s|$)/.test(node.className));
    },
    /* the message list in document order: history rows, divider, live rows */
    entries() {
      return messagesElement.children.map((node) => ({
        id: node.dataset.msgId || "",
        className: node.className,
        text: node.textContent,
      }));
    },
    images() {
      const found = [];
      walk(messagesElement, (node) => {
        if (node.tagName === "IMG") found.push(node);
      });
      return found;
    },
    /* document order, emote images as their alt text: the original message */
    rendered() {
      const out = [];
      const collect = (current) => {
        for (const child of current.childNodes) {
          if (child.nodeType === 3) out.push(child.data);
          else if (child.tagName === "IMG") out.push(child.alt);
          else collect(child);
        }
      };
      collect(messagesElement);
      return out.join("");
    },
    text() {
      return messagesElement.textContent;
    },
  };
}

function openOverlay(options) {
  return openPage("ui/overlay.html", [
    "lib/emotes.js", "lib/strftime.js", "ui/protocol.js", "ui/chat-view.js", "ui/overlay-view.js",
  ], options);
}

/* The index transport.js builds: every provider payload, merged by name. */
function providerIndex() {
  const index = {};
  for (const [kind, file] of [["bttv", "emotes-bttv-global.json"], ["bttv", "emotes-bttv-channel.json"],
    ["seventv", "emotes-7tv-global.json"], ["7tv", "emotes-7tv-channel.json"],
    ["ffz", "emotes-ffz-global.json"], ["ffz", "emotes-ffz-room.json"]]) {
    for (const emote of em.parseThirdParty(kind, fixture(file), "92038375")) index[emote.name] = emote.url;
  }
  return index;
}

const OVERLAY_SETTINGS = { settings: { chat: { twitchEmotes: true, usernameShown: false, badges: false } }, currentChannel: "caedrel" };
const O7_URL = "https://cdn.7tv.app/emote/01FS5ZCFG0000500DPPCXJWCP8/2x.webp";
const XDD_URL = "https://cdn.7tv.app/emote/01FF3R5C30000FF5VVCKV49G6J/2x.webp";

function chatEvent(text, emotes) {
  return {
    kind: "message",
    channel: "caedrel",
    timestamp: Date.now(),
    id: "m1",
    login: "someone",
    displayName: "Someone",
    text: text,
    emotes: emotes || [],
    bits: 0,
  };
}

/* main.js emits replayed VOD comments on the same channel, with the offset
 * into the video and replay: true on top of the live-message fields. */
function replayEvent(text, emotes, offsetSeconds) {
  return Object.assign(chatEvent(text, emotes), {
    replay: true,
    offsetSeconds: offsetSeconds === undefined ? 83 : offsetSeconds,
  });
}

test("the overlay renders Twitch-tag and third-party emotes as images", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page.fromPlugin("twt:emotes", { index: providerIndex() });
  /* "hi o7 xdd Kappa": Kappa is code points 10-14 */
  page.fromPlugin("twt:event", { event: chatEvent("hi o7 xdd Kappa", [{ id: "25", ranges: [[10, 14]] }]) });

  const images = page.images();
  assert.deepEqual(images.map((img) => img.src), [
    O7_URL,
    XDD_URL,
    "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
  ]);
  assert.deepEqual(images.map((img) => img.alt), ["o7", "xdd", "Kappa"]);
  assert.deepEqual(images.map((img) => img.title), ["o7", "xdd", "Kappa"]);
  for (const img of images) assert.equal(img.className, "twt-emote");
  /* every character of the message survives the render */
  assert.equal(page.rendered(), "hi o7 xdd Kappa");
});

test("the overlay re-renders messages that arrived before the emote index", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page.fromPlugin("twt:event", { event: chatEvent("o7 and xdd") });
  /* the index lives in the sidebar, so the overlay sees chat first */
  assert.equal(page.images().length, 0);
  assert.equal(page.rendered(), "o7 and xdd");
  assert.equal(page.text(), "o7 and xdd");

  page.fromPlugin("twt:emotes", { index: providerIndex() });
  const images = page.images();
  assert.deepEqual(images.map((img) => img.src), [O7_URL, XDD_URL]);
  assert.equal(page.rendered(), "o7 and xdd");

  /* a later, larger index re-renders again (the sidebar publishes per provider) */
  page.fromPlugin("twt:emotes", { index: Object.assign(providerIndex(), { KEKW: "https://cdn.betterttv.net/emote/5e9c76ffb0c2ae7ab5d5f7e0/2x" }) });
  page.fromPlugin("twt:event", { event: chatEvent("KEKW o7", []) });
  assert.deepEqual(page.images().map((img) => img.src).slice(2), [
    "https://cdn.betterttv.net/emote/5e9c76ffb0c2ae7ab5d5f7e0/2x",
    O7_URL,
  ]);
  assert.equal(page.rendered(), "o7 and xddKEKW o7");
});

test("the overlay never renders one image per range and never drops text", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  /* one emote id used twice, plus a second emote id */
  page.fromPlugin("twt:event", {
    event: chatEvent("Kappa Keepo Kappa", [
      { id: "25", ranges: [[0, 4], [12, 16]] },
      { id: "1902", ranges: [[6, 10]] },
    ]),
  });
  const images = page.images();
  assert.equal(images.length, 3);
  assert.deepEqual(images.map((img) => img.alt), ["Kappa", "Keepo", "Kappa"]);
  assert.equal(images[0].src, images[2].src);
  assert.equal(page.rendered(), "Kappa Keepo Kappa");

  /* third-party names are matched exactly and case-sensitively */
  const page2 = openOverlay();
  page2.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page2.fromPlugin("twt:emotes", { index: providerIndex() });
  page2.fromPlugin("twt:event", { event: chatEvent("07 xDD xdd, o7") });
  assert.deepEqual(page2.images().map((img) => img.alt), ["o7"]);
  assert.equal(page2.rendered(), "07 xDD xdd, o7");
});

/* ------------------------------------- sidebar (browser + transport) harness
 *
 * The sidebar is a Twitch browser plus a settings view; it renders no chat.
 * These tests drive the real page scripts (ui/browser.js and ui/transport.js)
 * inside the same minimal DOM, mock the plugin side of the frozen
 * "twt:twitch-get" protocol, and feed the transport raw IRC lines through the
 * fake socket.
 */

function openSidebar() {
  return openPage("ui/sidebar.html", [
    "lib/irc.js", "lib/config.js", "lib/emotes.js", "lib/strftime.js",
    "ui/protocol.js", "ui/browser.js", "ui/transport.js",
  ]);
}

/* The standalone browser window: the same ui/browser.js without ui/transport.js
 * (no IRC client, so it can never bind a channel). browser.js reads only
 * TwitchProtocol, so the page loads protocol.js + browser.js and none of lib/. */
function openStandalone() {
  return openPage("ui/standalone.html", [
    "ui/protocol.js", "ui/browser.js",
  ]);
}

function sidebarSettings(chat, twitch) {
  return {
    twitch: Object.assign({ server: "wss://irc-ws.chat.twitch.tv:443", username: "" }, twitch || {}),
    chat: Object.assign({
      twitchEmotes: true,
      betterttvEmotes: false,
      seventvEmotes: false,
      frankerfacezEmotes: false,
      usernameShown: false,
      badges: false,
      showDatetimes: false,
      maxMessages: 200,
      delay: 0,
    }, chat || {}),
  };
}

function startSidebar(channel) {
  const page = openSidebar();
  /* the plugin's settings payload carries the channel decision (main.js does
   * the same), and the transport connects on the first one */
  page.fromPlugin("twt:settings", {
    settings: sidebarSettings(),
    token: { available: false },
    channel: channel || "",
  });
  return page;
}

function roomState(channel, roomId) {
  /* Twitch puts the room id in the IRCv3 tags of ROOMSTATE, not the body */
  return "@room-id=" + roomId + " :tmi.twitch.tv ROOMSTATE #" + channel;
}

function privmsg(channel, id, login, text, tags) {
  const extra = tags ? tags + ";" : "";
  return "@" + extra + "id=" + id + ";display-name=" + login + " :" + login + "!" + login +
    "@" + login + ".tmi.twitch.tv PRIVMSG #" + channel + " :" + text;
}

/* the frozen history message shape (all fields of a live message event) */
function historyMessage(id, text, timestamp, extra) {
  return Object.assign({
    id,
    login: "hist",
    displayName: "Hist",
    userId: "42",
    color: null,
    text,
    emotes: [],
    badges: [],
    timestamp,
    isAction: false,
    bits: 0,
  }, extra || {});
}

/* The fake plugin side of "twt:twitch-get": every request is answered once,
 * matched by path, exactly like the proxy in main.js answers the web view. */
function tick() {
  let promise = Promise.resolve();
  for (let i = 0; i < 8; i++) promise = promise.then(() => {});
  return promise;
}

function browserHarness(opener) {
  const page = (opener || openSidebar)();
  const served = new Set();
  function pending(match) {
    return page.posted("twt:twitch-get")
      .filter((entry) => match(entry.path) && !served.has(entry.id))[0];
  }
  const harness = {
    page,
    requests() {
      return page.posted("twt:twitch-get");
    },
    answer(match, payload) {
      const request = pending(match);
      assert.ok(request, "expected an unanswered twt:twitch-get");
      served.add(request.id);
      page.fromPlugin("twt:twitch-result",
        Object.assign({ id: request.id, ok: true, status: 200, data: null, error: null }, payload || {}));
      return request;
    },
    answerPath(path, payload) {
      return harness.answer((candidate) => candidate === path, payload);
    },
    /* answers the nth *unanswered* request matching `match` (0-based), so a
     * test can settle replies out of order */
    answerAt(match, index, payload) {
      const list = page.posted("twt:twitch-get")
        .filter((entry) => match(entry.path) && !served.has(entry.id));
      const request = list[index || 0];
      assert.ok(request, "expected an unanswered twt:twitch-get at index " + (index || 0));
      served.add(request.id);
      page.fromPlugin("twt:twitch-result",
        Object.assign({ id: request.id, ok: true, status: 200, data: null, error: null }, payload || {}));
      return request;
    },
  };
  return harness;
}

test("the sidebar is a tabbed browser plus settings and renders no chat", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/sidebar.html"), "utf8");
  for (const marker of ["twt-messages", "composer-input", "send-btn", "channel-select",
    "join-btn", "jump-bottom", "empty-hint", "header-channel"]) {
    assert.equal(html.indexOf(marker), -1, "sidebar.html must not contain " + marker);
  }
  /* the single Browse tab is gone: the strip is the six sections */
  assert.equal(html.indexOf("Browse"), -1, "sidebar.html has no Browse tab");
  for (const id of ["tab-following", "tab-top", "tab-categories", "tab-search", "tab-videos", "tab-settings",
    "pane-following", "pane-top", "pane-categories", "pane-search", "pane-videos", "pane-settings"]) {
    assert.notEqual(html.indexOf('id="' + id + '"'), -1, "sidebar.html has " + id);
  }
  assert.notEqual(html.indexOf('src="browser.js"'), -1, "the browser script is loaded");

  /* the product is Twitch, not "Twitch Chat" */
  for (const file of ["ui/sidebar.html", "ui/browser.js", "ui/browser.css"]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.equal(text.indexOf("Twitch Chat"), -1, file + " must not say Twitch Chat");
  }

  /* no web view -> plugin chat posts survive in transport.js */
  const source = fs.readFileSync(path.join(ROOT, "ui/transport.js"), "utf8");
  for (const name of ["twt:say", "twt:join", "twt:part"]) {
    assert.equal(source.indexOf('postMessage("' + name + '"'), -1,
      "transport.js must not post " + name);
  }

  const page = openSidebar();
  assert.equal(page.byId("messages"), undefined, "no message list element exists");
});

test("the transport still binds the stream and forwards IRC events and history", () => {
  const page = startSidebar("caedrel");
  page.line(roomState("caedrel", "92038375"));

  const requests = page.posted("twt:history-request");
  assert.equal(requests.length, 1, "asked once, after the room id is known");
  assert.deepEqual(requests[0], {
    id: requests[0].id,
    channel: "caedrel",
    roomId: "92038375",
    count: 50,
  });
  /* a second ROOMSTATE for the same room does not ask again */
  page.line(roomState("caedrel", "92038375"));
  assert.equal(page.posted("twt:history-request").length, 1);

  page.line(privmsg("caedrel", "m1", "alice", "hello overlay"));
  const events = page.posted("twt:event");
  assert.ok(events.some((entry) => entry.event && entry.event.text === "hello overlay"),
    "the chat event is forwarded to the plugin");
  assert.ok(page.posted("twt:state").length >= 1, "connection state is forwarded");
  assert.equal(page.byId("messages"), undefined, "chat is never rendered in the sidebar");

  /* chat input / channel switching never come from the sidebar */
  assert.deepEqual(page.posted("twt:say"), []);
  assert.deepEqual(page.posted("twt:join"), []);
  assert.deepEqual(page.posted("twt:part"), []);
  assert.equal(page.posted("twt:ready").length, 1, "the transport host announces itself");
});

/* Opens the sidebar's default tab (Following) and answers its requests. */
async function followingTab(options) {
  const opts = options || {};
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: opts.follows || [
      { broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" },
      { broadcaster_id: "8", broadcaster_login: "thebausffs", broadcaster_name: "Thebausffs" },
    ], pagination: {} },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, {
    data: { data: opts.live === undefined ? [{
      user_login: "caedrel", user_name: "Caedrel", title: "ranked grind",
      game_name: "League of Legends", viewer_count: 8000,
      started_at: new Date(Date.now() - 7200e3).toISOString(),
    }] : opts.live },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, {
    data: { data: opts.users === undefined ? [
      { id: "9", login: "caedrel", display_name: "Caedrel", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png" },
      { id: "8", login: "thebausffs", display_name: "Thebausffs", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/thebausffs-profile_image-bb1-300x300.png" },
    ] : opts.users },
  });
  await tick();
  return h;
}

function clickTab(h, id) {
  h.page.fire(h.page.byId("tab-" + id), "click", {});
}

test("each tab shows only its own section", async () => {
  const h = await followingTab();
  assert.equal(h.page.byId("pane-following").hidden, false, "Following is the default tab");
  for (const id of ["top", "categories", "search", "videos", "settings"]) {
    assert.equal(h.page.byId("pane-" + id).hidden, true, id + " starts hidden");
  }
  assert.equal(h.page.byId("browser-title").textContent, "Following");
  assert.equal(h.page.byId("browser-back").hidden, true, "a tab root has no back");
  assert.equal(h.page.byId("browser-refresh").hidden, false);

  const followsCount = () => h.requests().filter((entry) => entry.path.indexOf("/helix/channels/followed") === 0).length;
  const before = followsCount();
  clickTab(h, "top");
  await tick();
  assert.equal(h.page.byId("pane-following").hidden, true);
  assert.equal(h.page.byId("pane-top").hidden, false);
  assert.equal(h.page.byId("browser-title").textContent, "Top streams");
  assert.ok(h.requests().some((entry) => entry.path === "/helix/streams?first=30"), "Top fetches its own list");
  assert.equal(followsCount(), before, "switching tabs does not refetch the other tab");
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();

  clickTab(h, "categories");
  await tick();
  assert.equal(h.page.byId("pane-top").hidden, true);
  assert.equal(h.page.byId("browser-title").textContent, "Categories");
  assert.equal(h.page.find('[data-action="category-search-input"]').length, 1, "Categories has its own search field");
  h.answerPath("/helix/games/top?first=30", {
    data: { data: [{ id: "509658", name: "Just Chatting", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/509658-{width}x{height}.jpg" }] },
  });
  await tick();
  assert.equal(h.page.find('[data-kind="category"]').length, 1);

  clickTab(h, "search");
  await tick();
  assert.equal(h.page.byId("pane-categories").hidden, true);
  assert.equal(h.page.byId("browser-title").textContent, "Search channels");
  assert.equal(h.page.find('[data-action="channel-search-input"]').length, 1, "Search has the channel field");

  clickTab(h, "videos");
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "Videos");
  assert.equal(h.page.find('[data-action="video-search-input"]').length, 1, "the Videos tab has its video filter");
  assert.equal(h.page.byId("pane-videos").querySelectorAll('[data-action="channel-search-input"]').length, 0,
    "the channel search moved out of the Videos tab");
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();
  assert.notEqual(h.page.byId("pane-videos").textContent.indexOf("Recent videos"), -1,
    "the Videos tab keeps the recent-videos list");
  assert.notEqual(h.page.byId("pane-videos").textContent.indexOf("Filters the videos"), -1,
    "the filter is described honestly");

  clickTab(h, "settings");
  await tick();
  assert.equal(h.page.byId("pane-settings").hidden, false);
  assert.equal(h.page.byId("pane-videos").hidden, true);
  assert.equal(h.page.byId("browser-title").textContent, "Settings");
  assert.equal(h.page.byId("browser-back").hidden, true);
  assert.equal(h.page.byId("browser-refresh").hidden, true, "Settings has nothing to refresh");
});

test("switching tabs keeps each tab's stack, DOM and data", async () => {
  const h = await followingTab();
  h.page.fire(h.page.find('[data-kind="follow"]')[0], "click", {});
  await tick();
  h.answerPath("/helix/users?login=caedrel", { data: { data: [{ id: "9", login: "caedrel", display_name: "Caedrel" }] } });
  await tick();
  h.answerPath("/helix/streams?user_login=caedrel", { data: { data: [] } });
  h.answerPath("/helix/videos?user_id=9&type=archive&first=20", {
    data: { data: [{ id: "v1", title: "VOD one", duration: "1m", published_at: "2024-01-01T00:00:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/v1-%{width}x%{height}.jpg" }], pagination: {} },
  });
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel");
  assert.equal(h.page.byId("browser-back").hidden, false, "the overview is on the Following stack");
  const vod = h.page.find('[data-kind="vod"]')[0];

  clickTab(h, "top");
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "Top streams");
  assert.equal(h.page.byId("browser-back").hidden, true, "Top has its own empty stack");
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();

  const count = (prefix) => h.requests().filter((entry) => entry.path.indexOf(prefix) === 0).length;
  const followsBefore = count("/helix/channels/followed");
  const usersBefore = count("/helix/users?login=caedrel");
  clickTab(h, "following");
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel", "the Following stack is restored");
  assert.equal(h.page.byId("browser-back").hidden, false);
  assert.equal(h.page.find('[data-kind="vod"]')[0], vod, "the same DOM node is still rendered");
  assert.equal(count("/helix/channels/followed"), followsBefore, "returning to Following refetches nothing");
  assert.equal(count("/helix/users?login=caedrel"), usersBefore, "returning to Following refetches nothing");
});

test("the refresh button refetches only the active tab", async () => {
  const h = await followingTab();
  clickTab(h, "top");
  await tick();
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();

  const topCount = () => h.requests().filter((entry) => entry.path === "/helix/streams?first=30").length;
  const followsCount = () => h.requests().filter((entry) => entry.path.indexOf("/helix/channels/followed") === 0).length;
  const topBefore = topCount();
  const followsBefore = followsCount();
  h.page.fire(h.page.byId("browser-refresh"), "click", {});
  await tick();
  assert.equal(topCount(), topBefore + 1, "the active tab refetches");
  assert.equal(followsCount(), followsBefore, "the other tab is untouched");
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();

  clickTab(h, "following");
  await tick();
  assert.equal(followsCount(), followsBefore, "returning after a Top refresh does not refetch Following");
});

test("the avatar is the channel's profile image on live and offline follow rows", async () => {
  const h = await followingTab();
  const live = h.page.find('[data-kind="follow"]').filter((row) => row.dataset.login === "caedrel")[0];
  const offline = h.page.find('[data-kind="follow"]').filter((row) => row.dataset.login === "thebausffs")[0];
  assert.equal(live.dataset.live, "true");
  assert.equal(offline.dataset.live, undefined);

  const cases = [
    [live, "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png"],
    [offline, "https://static-cdn.jtvnw.net/jtv_user_pictures/thebausffs-profile_image-bb1-300x300.png"],
  ];
  for (const [row, url] of cases) {
    const box = row.children[0];
    const img = box.children[0];
    assert.notEqual(box.className.indexOf("twt-avatar-box"), -1, "the avatar box is present");
    assert.equal(box.classList.contains("twt-art-placeholder"), false, "the avatar is not a placeholder");
    assert.equal(img.tagName, "IMG");
    assert.equal(img.className, "twt-follow-avatar");
    assert.equal(img.loading, "lazy");
    assert.equal(img.src, url);
    assert.equal(img.src.indexOf("previews-ttv"), -1, "the avatar box never uses a preview URL");
  }

  /* the preview URL belongs to the watch affordance only */
  const watch = live.querySelectorAll('[data-action="watch"]')[0];
  assert.equal(watch.children[0].children[0].src,
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_caedrel-640x360.jpg");
});

test("the avatar lookup is one well-formed login query", async () => {
  const h = await followingTab();
  const users = h.requests().filter((entry) => entry.path.indexOf("/helix/users?") === 0);
  assert.deepEqual(users.map((entry) => entry.path), ["/helix/users?login=caedrel&login=thebausffs"],
    "the first login is not mangled into login=login=...");
});

test("a missing profile image leaves the placeholder box", async () => {
  const h = await followingTab({ users: [
    { id: "9", login: "caedrel", display_name: "Caedrel", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png" },
  ] });
  const offline = h.page.find('[data-kind="follow"]').filter((row) => row.dataset.login === "thebausffs")[0];
  const box = offline.children[0];
  assert.ok(box.classList.contains("twt-art-placeholder"), "no profile_image_url is a placeholder");
  assert.equal(box.children.length, 0, "a placeholder has no broken <img>");
});

test("the Following list sorts live by viewers first, then offline by name", async () => {
  const started = new Date(Date.now() - 3600e3).toISOString();
  const h = await followingTab({
    follows: [
      { broadcaster_id: "1", broadcaster_login: "zedlive", broadcaster_name: "ZedLive" },
      { broadcaster_id: "2", broadcaster_login: "mid", broadcaster_name: "Mid" },
      { broadcaster_id: "3", broadcaster_login: "alpha", broadcaster_name: "Alpha" },
      { broadcaster_id: "4", broadcaster_login: "low", broadcaster_name: "Low" },
      { broadcaster_id: "5", broadcaster_login: "zed", broadcaster_name: "Zed" },
      { broadcaster_id: "6", broadcaster_login: "anna", broadcaster_name: "anna" },
    ],
    live: [
      { user_login: "mid", user_name: "Mid", viewer_count: 300, started_at: started },
      { user_login: "low", user_name: "Low", viewer_count: 5, started_at: started },
      { user_login: "zedlive", user_name: "ZedLive", viewer_count: 1200, started_at: started },
      { user_login: "alpha", user_name: "Alpha", viewer_count: 300, started_at: started },
    ],
  });
  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login),
    ["zedlive", "alpha", "mid", "low", "anna", "zed"],
    "1200 viewers, then the 300-viewer tie by name, then 5, then offline anna < Zed");
});

test("a channel that goes live on a later page slots into the live group", async () => {
  const started = new Date(Date.now() - 3600e3).toISOString();
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [
      { broadcaster_id: "1", broadcaster_login: "zed", broadcaster_name: "Zed" },
      { broadcaster_id: "2", broadcaster_login: "mid", broadcaster_name: "Mid" },
    ], pagination: { cursor: "page-two" } },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, {
    data: { data: [{ user_login: "mid", user_name: "Mid", viewer_count: 300, started_at: started }] },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, { data: { data: [] } });
  await tick();
  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), ["mid", "zed"]);

  h.page.fire(h.page.find('[data-action="load-more"]')[0], "click", {});
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100&after=page-two", {
    data: { data: [
      { broadcaster_id: "3", broadcaster_login: "anna", broadcaster_name: "anna" },
      { broadcaster_id: "4", broadcaster_login: "high", broadcaster_name: "High" },
    ], pagination: {} },
  });
  await tick();
  h.answerPath("/helix/streams?first=2&user_login=anna&user_login=high", {
    data: { data: [{ user_login: "high", user_name: "High", viewer_count: 900, started_at: started }] },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, { data: { data: [] } });
  await tick();

  const rows = h.page.find('[data-kind="follow"]');
  assert.deepEqual(rows.map((row) => row.dataset.login), ["high", "mid", "anna", "zed"],
    "the second page's live channel slots above the offline ones; no unsorted tail");
  assert.equal(h.page.find('[data-action="load-more"]').length, 0, "the list ends without a pump");
});

test("the sorted order survives a refresh", async () => {
  const started = new Date(Date.now() - 3600e3).toISOString();
  const follows = [
    { broadcaster_id: "1", broadcaster_login: "zed", broadcaster_name: "Zed" },
    { broadcaster_id: "2", broadcaster_login: "mid", broadcaster_name: "Mid" },
    { broadcaster_id: "3", broadcaster_login: "anna", broadcaster_name: "anna" },
  ];
  const live = [{ user_login: "mid", user_name: "Mid", viewer_count: 300, started_at: started }];
  const h = await followingTab({ follows, live });
  const order = () => h.page.find('[data-kind="follow"]').map((row) => row.dataset.login);
  assert.deepEqual(order(), ["mid", "anna", "zed"]);

  h.page.fire(h.page.byId("browser-refresh"), "click", {});
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: live } });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, { data: { data: [] } });
  await tick();
  assert.deepEqual(order(), ["mid", "anna", "zed"], "the refresh keeps the same sorted order");
});

test("a 410 from the follows API shows the removed-endpoint error and Retry asks again", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "42", scopes: ["user:read:follows"] } });
  await tick();

  h.answerPath("/helix/channels/followed?user_id=42&first=100", { ok: false, status: 410, error: "http 410" });
  await tick();

  const body = h.page.byId("pane-following");
  assert.match(body.textContent, /HTTP 410 Gone/, "the error names the HTTP status");
  assert.match(body.textContent, /removed/i, "the error says Twitch removed the endpoint");
  assert.doesNotMatch(body.textContent, /You do not follow any channels yet/,
    "a failure is never rendered as an empty following list");
  const retry = h.page.find('[data-action="retry"]');
  assert.equal(retry.length, 1, "the section offers a Retry");

  const path = "/helix/channels/followed?user_id=42&first=100";
  const before = h.requests().filter((entry) => entry.path === path).length;
  h.page.fire(retry[0], "click", {});
  await tick();
  assert.equal(h.requests().filter((entry) => entry.path === path).length, before + 1,
    "Retry re-requests the failed page");
});

test("Following paginates by cursor and batches live state for each page", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "42", scopes: ["user:read:follows"] } });
  await tick();

  h.answerPath("/helix/channels/followed?user_id=42&first=100", {
    data: { data: [
      { broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" },
      { broadcaster_id: "8", broadcaster_login: "thebausffs", broadcaster_name: "Thebausffs" },
    ], pagination: { cursor: "page-two" } },
  });
  await tick();
  h.answer((path) => path === "/helix/streams?first=2&user_login=caedrel&user_login=thebausffs", {
    data: { data: [{ user_login: "caedrel", user_name: "Caedrel", viewer_count: 5 }] },
  });
  await tick();

  assert.equal(h.page.find('[data-kind="follow"]').length, 2);
  const more = h.page.find('[data-action="load-more"]');
  assert.equal(more.length, 1, "a cursor renders a Load more control");

  h.page.fire(more[0], "click", {});
  await tick();
  const nextPath = "/helix/channels/followed?user_id=42&first=100&after=page-two";
  assert.ok(h.requests().some((entry) => entry.path === nextPath), "the cursor is sent as ?after=");
  h.answerPath(nextPath, {
    data: { data: [{ broadcaster_id: "7", broadcaster_login: "xqc", broadcaster_name: "xQc" }], pagination: {} },
  });
  await tick();
  h.answerPath("/helix/streams?first=1&user_login=xqc", { data: { data: [] } });
  await tick();

  const follows = h.page.find('[data-kind="follow"]');
  assert.deepEqual(follows.map((row) => row.dataset.login), ["caedrel", "thebausffs", "xqc"],
    "the next page is appended and keeps the first page");
  assert.equal(h.page.find('[data-live="true"]').length, 1, "the second page's live state is merged in");
  assert.equal(h.page.find('[data-action="load-more"]').length, 0, "a missing cursor ends pagination");
});

test("category cover art substitutes the single-brace template and reserves a placeholder", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "42", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=42&first=100", { data: { data: [], pagination: {} } });
  await tick();
  clickTab(h, "categories");
  await tick();
  h.answerPath("/helix/games/top?first=30", {
    data: { data: [
      { id: "21779", name: "League of Legends", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/21779-{width}x{height}.jpg" },
      { id: "1", name: "No Art" },
    ] },
  });
  await tick();

  const rows = h.page.find('[data-kind="category"]');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.dataset.id), ["21779", "1"],
    "the top list keeps Twitch's own popularity order (it is not re-sorted here)");
  const art = rows[0].children[0].children[0];
  assert.equal(art.tagName, "IMG");
  assert.equal(art.className, "twt-game-art");
  assert.equal(art.alt, "League of Legends");
  assert.equal(art.loading, "lazy");
  assert.equal(art.src, "https://static-cdn.jtvnw.net/ttv-boxart/21779-285x380.jpg");
  assert.ok(art.src.endsWith("-285x380.jpg"), "the {width}x{height} template is substituted");

  const placeholder = rows[1].children[0];
  assert.ok(placeholder.classList.contains("twt-art-placeholder"), "missing box art is a placeholder");
  assert.equal(placeholder.children.length, 0, "a placeholder has no broken <img>");

  h.page.fire(art, "error", {});
  assert.equal(art.hidden, true, "a failed image is hidden");
  assert.ok(rows[0].children[0].classList.contains("twt-art-placeholder"),
    "the wrapper keeps the neutral placeholder after an error");
});

test("only Twitch image hosts render: vod-secure and *.jtvnw.net yes, everything else no", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [{ broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" }], pagination: {} },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();
  /* the Following tab's avatar batch uses the same path as the overview's
   * /helix/users?login= request, so answer it first */
  h.answerPath("/helix/users?login=caedrel", { data: { data: [{ id: "9", login: "caedrel", display_name: "Caedrel" }] } });
  await tick();

  h.page.fire(h.page.find('[data-kind="follow"]')[0], "click", {});
  await tick();
  /* the overview's /helix/users?login=caedrel is already cached from the avatar
   * batch (same path), so only the live and video requests go out */
  h.answerPath("/helix/streams?user_login=caedrel", { data: { data: [] } });
  h.answerPath("/helix/videos?user_id=9&type=archive&first=20", {
    data: { data: [
      { id: "s1", title: "processing", duration: "1m", published_at: "2024-01-01T00:00:00Z", thumbnail_url: "https://vod-secure.twitch.tv/x-%{width}x%{height}.jpg" },
      { id: "s2", title: "cdn", duration: "1m", published_at: "2024-01-02T00:00:00Z", thumbnail_url: "https://foo.jtvnw.net/thumb/x-%{width}x%{height}.jpg" },
      { id: "s3", title: "evil", duration: "1m", published_at: "2024-01-03T00:00:00Z", thumbnail_url: "https://evil.example.com/x-%{width}x%{height}.jpg" },
      { id: "s4", title: "insecure", duration: "1m", published_at: "2024-01-04T00:00:00Z", thumbnail_url: "http://static-cdn.jtvnw.net/x-%{width}x%{height}.jpg" },
      { id: "s5", title: "relative", duration: "1m", published_at: "2024-01-05T00:00:00Z", thumbnail_url: "//static-cdn.jtvnw.net/x-%{width}x%{height}.jpg" },
    ], pagination: {} },
  });
  await tick();

  const rows = h.page.find('[data-kind="vod"]');
  assert.equal(rows.length, 5, "every VOD renders a row (nothing is dropped)");
  const boxAt = (row) => row.children[0];
  const imgAt = (row) => boxAt(row).children[0];
  const placeholderAt = (row) => boxAt(row).classList.contains("twt-art-placeholder");

  /* sorted newest first: s5, s4, s3, s2, s1 */
  assert.equal(imgAt(rows[0]), undefined, "a protocol-relative URL is rejected");
  assert.equal(imgAt(rows[1]), undefined, "plain http is rejected");
  assert.equal(imgAt(rows[2]), undefined, "another host is rejected");
  assert.ok(placeholderAt(rows[0]) && placeholderAt(rows[1]) && placeholderAt(rows[2]),
    "rejected URLs leave the placeholder box");

  assert.equal(imgAt(rows[3]).tagName, "IMG", "a *.jtvnw.net host is accepted");
  assert.equal(imgAt(rows[3]).src, "https://foo.jtvnw.net/thumb/x-160x90.jpg");
  assert.equal(placeholderAt(rows[3]), false);
  assert.equal(imgAt(rows[4]).tagName, "IMG", "vod-secure.twitch.tv is accepted");
  assert.equal(imgAt(rows[4]).src, "https://vod-secure.twitch.tv/x-160x90.jpg");
  assert.equal(imgAt(rows[4]).loading, "lazy");
  assert.equal(placeholderAt(rows[4]), false);
});

test("the overlay drops its rows on a switch and does not resurrect them", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page.fromPlugin("twt:emotes", { index: providerIndex() });
  page.fromPlugin("twt:event", { event: chatEvent("o7 xdd", []) });
  assert.equal(page.rows().length, 1);
  assert.equal(page.images().length, 2);

  page.fromPlugin("twt:clear", { channel: "thebausffs" });
  assert.equal(page.rows().length, 0);
  assert.equal(page.images().length, 0);
  assert.equal(page.byId("header-channel").textContent, "#thebausffs");

  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  assert.equal(page.rows().length, 0);
  assert.equal(page.images().length, 0);
});

/* Navigates the Following tab into a channel overview and answers its requests,
 * so the navigation/click tests share the setup. `caedrel` is live (so its row
 * carries a Watch affordance) and `thebausffs` is offline. */
async function openOverview(options) {
  const opts = options || {};
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [
      { broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" },
      { broadcaster_id: "8", broadcaster_login: "thebausffs", broadcaster_name: "Thebausffs" },
    ], pagination: {} },
  });
  await tick();
  /* one batched live-state call for the follow page */
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, {
    data: { data: [{
      user_login: "caedrel", user_name: "Caedrel", title: "ranked grind",
      game_name: "League of Legends", viewer_count: 8000,
      started_at: new Date(Date.now() - 7200e3).toISOString(),
    }] },
  });
  await tick();
  /* one batched avatar call for the same page (thebausffs has none) */
  h.answer((path) => path.indexOf("/helix/users?login=") === 0 && path.indexOf("&login=") !== -1, {
    data: { data: [{
      id: "9", login: "caedrel", display_name: "Caedrel",
      profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png",
    }] },
  });
  await tick();

  const login = opts.offline ? "thebausffs" : "caedrel";
  const id = opts.offline ? "8" : "9";
  if (opts.beforeNavigate) opts.beforeNavigate(h);
  const follow = h.page.find('[data-kind="follow"]').filter((row) => row.dataset.login === login)[0];
  h.page.fire(follow, "click", {});
  await tick();

  h.answerPath("/helix/users?login=" + login, {
    data: { data: [{
      id: id, login: login, display_name: opts.offline ? "Thebausffs" : "Caedrel", description: "pro player",
      profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png",
    }] },
  });
  await tick();
  h.answerPath("/helix/streams?user_login=" + login, {
    data: { data: opts.offline ? [] : [opts.liveStream || {
      user_login: login, user_name: "Caedrel", title: "ranked grind",
      game_name: "League of Legends", viewer_count: 8000,
      started_at: new Date(Date.now() - 7200e3).toISOString(),
      thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_caedrel-%{width}x%{height}.jpg",
    }] },
  });
  h.answer((path) => path === "/helix/videos?user_id=" + id + "&type=archive&first=20", {
    data: { data: opts.vods || [{
      id: "v1", title: "VOD one", duration: "1h2m3s",
      published_at: "2024-01-02T03:04:05Z", view_count: 123,
      thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/v1-%{width}x%{height}.jpg",
    }], pagination: opts.pagination || { cursor: "vod-2" } },
  });
  await tick();
  return h;
}

test("clicking a channel row opens the overview inside the sidebar, not the stream", async () => {
  const h = await openOverview();
  assert.deepEqual(h.page.posted("twt:open"), [], "opening a channel never opens a stream");
  const body = h.page.byId("pane-following").textContent;
  for (const label of ["Caedrel", "pro player", "ranked grind", "VOD one"]) {
    assert.notEqual(body.indexOf(label), -1, "the overview shows " + label);
  }

  const avatar = h.page.find('[data-role="avatar"]');
  assert.equal(avatar.length, 1);
  assert.equal(avatar[0].src,
    "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png");
  const live = h.page.find('[data-kind="stream"]');
  assert.equal(live.length, 1);
  assert.match(live[0].className, /twt-live-block/);
  const vod = h.page.find('[data-kind="vod"]');
  assert.equal(vod.length, 1);
  assert.equal(vod[0].children[0].children[0].src,
    "https://static-cdn.jtvnw.net/cf_vods/v1-160x90.jpg",
    "VOD %{width} templates still substitute");
});

test("the Watch affordance opens the stream, and VOD rows open the video", async () => {
  const h = await openOverview();
  const watch = h.page.find('[data-action="watch"]');
  assert.equal(watch.length, 1, "the live block has one Watch affordance");
  h.page.fire(watch[0], "click", {});
  h.page.fire(watch[0], "click", { metaKey: true });
  h.page.fire(watch[0], "auxclick", { button: 1 });
  assert.deepEqual(h.page.posted("twt:open"), [
    { url: "https://www.twitch.tv/caedrel", target: "current" },
    { url: "https://www.twitch.tv/caedrel", target: "new" },
    { url: "https://www.twitch.tv/caedrel", target: "new" },
  ]);

  const vod = h.page.find('[data-kind="vod"]')[0];
  h.page.fire(vod, "click", {});
  h.page.fire(vod, "auxclick", { button: 1 });
  assert.deepEqual(h.page.posted("twt:open").slice(-2), [
    { url: "https://www.twitch.tv/videos/v1", target: "current" },
    { url: "https://www.twitch.tv/videos/v1", target: "new" },
  ]);
});

test("an offline followed channel renders a row and opens an overview with its videos", async () => {
  let checked = false;
  const h = await openOverview({ offline: true, beforeNavigate(home) {
    const row = home.page.find('[data-kind="follow"]').filter((r) => r.dataset.login === "thebausffs")[0];
    assert.ok(row, "the offline follow still renders a row");
    assert.equal(row.dataset.live, undefined, "it is not marked live");
    assert.equal(row.querySelectorAll('[data-action="watch"]').length, 0, "no dead Watch affordance");
    assert.notEqual(row.textContent.indexOf("offline"), -1, "the row says offline");
    assert.deepEqual(home.page.posted("twt:open"), []);
    checked = true;
  } });
  assert.ok(checked, "the offline row was inspected before navigating");

  const body = h.page.byId("pane-following").textContent;
  for (const label of ["Thebausffs", "VOD one"]) {
    assert.notEqual(body.indexOf(label), -1, "the offline overview shows " + label);
  }
  assert.equal(h.page.find('[data-kind="vod"]').length, 1);
});

test("category stream rows split: the row navigates, Watch opens the stream", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();

  clickTab(h, "categories");
  await tick();
  h.answerPath("/helix/games/top?first=30", {
    data: { data: [{ id: "509658", name: "Just Chatting", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/509658-{width}x{height}.jpg" }] },
  });
  await tick();

  h.page.fire(h.page.find('[data-kind="category"]')[0], "click", {});
  await tick();
  h.answerPath("/helix/streams?first=30&game_id=509658", {
    data: { data: [{ id: "s1", user_login: "xqc", user_name: "xQc", title: "top", game_name: "Just Chatting", viewer_count: 10, started_at: new Date().toISOString() }] },
  });
  await tick();

  const row = h.page.find('[data-kind="stream"]')[0];
  const watch = row.querySelectorAll('[data-action="watch"]');
  assert.equal(watch.length, 1, "the category stream row has a Watch affordance");
  h.page.fire(watch[0], "click", {});
  assert.deepEqual(h.page.posted("twt:open"), [{ url: "https://www.twitch.tv/xqc", target: "current" }]);

  h.page.fire(row, "click", {});
  await tick();
  assert.equal(h.page.posted("twt:open").length, 1, "the row itself navigates instead of opening a stream");
  assert.ok(h.requests().some((entry) => entry.path === "/helix/users?login=xqc"),
    "the row opened the channel overview instead");
});

test("the channel VOD list paginates by cursor and the filter changes the type", async () => {
  const h = await openOverview();
  assert.equal(h.page.find('[data-kind="vod"]').length, 1);
  const more = h.page.find('[data-action="load-more"]');
  assert.equal(more.length, 1, "a cursor renders Load more");

  h.page.fire(more[0], "click", {});
  await tick();
  const page2 = "/helix/videos?user_id=9&type=archive&first=20&after=vod-2";
  assert.ok(h.requests().some((entry) => entry.path === page2), "the cursor is sent as ?after=");
  h.answerPath(page2, { data: { data: [{
    id: "v2", title: "VOD two", duration: "2h1m", published_at: "2024-03-04T00:00:00Z",
    thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/v2-%{width}x%{height}.jpg",
  }], pagination: {} } });
  await tick();

  const titles = h.page.find('[data-kind="vod"]').map((entry) => entry.textContent);
  assert.equal(titles.length, 2, "the next page is appended");
  assert.notEqual(titles[0].indexOf("VOD two"), -1, "the merged list is newest first");
  assert.equal(h.page.find('[data-action="load-more"]').length, 0, "a missing cursor ends pagination");

  const select = h.page.find('[data-action="vod-type"]')[0];
  select.value = "highlight";
  h.page.fire(select, "change", {});
  await tick();
  const highlightPath = "/helix/videos?user_id=9&type=highlight&first=20";
  assert.ok(h.requests().some((entry) => entry.path === highlightPath), "the filter switches type=");
  h.answerPath(highlightPath, { data: { data: [{
    id: "h1", title: "Highlight one", duration: "3m", published_at: "2024-05-06T00:00:00Z",
    thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/h1-%{width}x%{height}.jpg",
  }], pagination: {} } });
  await tick();

  const afterFilter = h.page.find('[data-kind="vod"]');
  assert.equal(afterFilter.length, 1, "the filter starts a fresh list");
  assert.notEqual(afterFilter[0].textContent.indexOf("Highlight one"), -1);
});

test("the Videos tab fans out over followed channels, bounded, merged and newest first", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [];
  for (let i = 1; i <= 15; i++) {
    follows.push({ broadcaster_id: "id" + i, broadcaster_login: "chan" + i, broadcaster_name: "Chan " + i });
  }
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  /* each tab has its own cache, so the Videos tab asks for the follows itself */
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();

  const videoRequests = () => h.requests().filter((entry) => entry.path.indexOf("/helix/videos?user_id=id") === 0);
  assert.equal(videoRequests().length, 4, "at most 4 VOD requests are in flight");

  const served = new Set();
  let guard = 0;
  while (guard++ < 50) {
    const pending = videoRequests().filter((entry) => !served.has(entry.id));
    if (!pending.length) break;
    for (const request of pending) {
      served.add(request.id);
      const index = Number(/user_id=id(\d+)/.exec(request.path)[1]);
      const videoId = index === 2 ? "v1" : "v" + index; /* chan2 repeats chan1's video */
      h.answerPath(request.path, { data: { data: [{
        id: videoId, title: "Video " + index, duration: "1m2s",
        published_at: new Date(Date.UTC(2024, 0, index)).toISOString(),
        thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/x-%{width}x%{height}.jpg",
      }], pagination: {} } });
    }
    await tick();
  }

  const paths = videoRequests().map((entry) => entry.path);
  const ids = [...new Set(paths.map((path) => Number(/user_id=id(\d+)/.exec(path)[1])))].sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "only the first 12 followed channels are asked");
  assert.ok(paths.every((path) => path.indexOf("&type=archive&first=10") !== -1), "one archive page per channel");
  assert.ok(paths.every((path) => path.indexOf("after=") === -1), "no channel is paged twice");

  const rows = h.page.find('[data-kind="vod"]');
  assert.equal(rows.length, 11, "chan2's duplicate of chan1's video is deduped");
  assert.notEqual(rows[0].textContent.indexOf("Video 12"), -1, "merged newest first");
  assert.equal(h.page.find('[data-action="load-more"]').length, 0, "the Videos tab loads one page per channel");

  h.page.fire(rows[0], "click", {});
  assert.deepEqual(h.page.posted("twt:open").slice(-1), [
    { url: "https://www.twitch.tv/videos/v12", target: "current" },
  ]);
});

test("the Search tab searches channels, debounces input and keeps its query per tab", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();

  clickTab(h, "search");
  await tick();
  assert.match(h.page.byId("pane-search").textContent, /Search Twitch for channels/,
    "the empty state explains what the tab searches");

  const searchCount = () => h.requests().filter((entry) => entry.path.indexOf("/helix/search/channels") === 0).length;
  const input = h.page.find('[data-action="channel-search-input"]')[0];
  input.value = "caedrel";
  h.page.fire(input, "input", {});
  assert.equal(searchCount(), 0, "typing alone does not fire the request");
  h.page.advanceTimers(300);
  assert.equal(searchCount(), 1, "the debounce fires one request");

  h.answerPath("/helix/search/channels?query=caedrel&first=20", { data: { data: [{
    id: "9", broadcaster_login: "caedrel", display_name: "Caedrel", is_live: true,
    game_name: "League of Legends", title: "ranked",
    thumbnail_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png",
  }], pagination: {} } });
  await tick();

  const results = h.page.find('[data-kind="search-channel"]');
  assert.equal(results.length, 1, "the search renders a channel row");
  assert.equal(results[0].querySelectorAll('[data-action="watch"]').length, 1, "a live result keeps its Watch affordance");

  /* leaving and coming back keeps the query and does not refetch */
  const before = searchCount();
  clickTab(h, "top");
  await tick();
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();
  clickTab(h, "search");
  await tick();
  assert.equal(h.page.find('[data-action="channel-search-input"]')[0].value, "caedrel", "the query is preserved");
  assert.equal(searchCount(), before, "returning does not refetch");
  assert.equal(h.page.find('[data-kind="search-channel"]').length, 1, "the results are preserved");

  h.page.fire(results[0], "click", {});
  await tick();
  assert.ok(h.requests().some((entry) => entry.path === "/helix/users?login=caedrel"),
    "the search result opens the channel overview inside the sidebar");
});

test("a failed channel search shows the error card with Retry", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();
  clickTab(h, "search");
  await tick();

  const input = h.page.find('[data-action="channel-search-input"]')[0];
  input.value = "caedrel";
  h.page.fire(input, "input", {});
  h.page.advanceTimers(300);
  const path = "/helix/search/channels?query=caedrel&first=20";
  h.answerPath(path, { ok: false, status: 0, error: "blocked" });
  await tick();
  assert.match(h.page.byId("pane-search").textContent, /blocked/);
  const retry = h.page.find('[data-action="retry"]');
  assert.equal(retry.length, 1, "the error card offers Retry");
  const before = h.requests().filter((entry) => entry.path === path).length;
  h.page.fire(retry[0], "click", {});
  await tick();
  assert.equal(h.requests().filter((entry) => entry.path === path).length, before + 1,
    "Retry re-requests the search");
});

test("back and Escape pop the active tab's stack only", async () => {
  const h = await openOverview();
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel");
  assert.equal(h.page.byId("browser-back").hidden, false);

  /* Top has its own empty stack */
  clickTab(h, "top");
  await tick();
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();
  assert.equal(h.page.byId("browser-back").hidden, true, "Top has no back entry");
  assert.equal(h.page.byId("browser-title").textContent, "Top streams");

  clickTab(h, "following");
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel", "the Following stack is restored");
  h.page.fire(h.page.byId("browser-back"), "click", {});
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "Following", "Back returns to the Following root");
  assert.equal(h.page.byId("browser-back").hidden, true);

  h.page.fire(h.page.find('[data-kind="follow"]')[0], "click", {});
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel");
  h.page.documentKey("Escape");
  await tick();
  assert.equal(h.page.byId("browser-title").textContent, "Following", "Escape pops the active tab");
  h.page.documentKey("Escape");
  assert.equal(h.page.byId("browser-title").textContent, "Following", "Escape on a tab root is inert");
});

test("a VOD replay never suppresses the live backlog after replay ends", () => {
  const page = startSidebar("caedrel");
  page.line(roomState("caedrel", "92038375"));
  assert.equal(page.posted("twt:history-request").length, 1, "the live backlog is requested once for the room");

  /* the same channel keeps playing, but now as a VOD replay (no part/join) */
  page.fromPlugin("twt:settings", {
    settings: sidebarSettings(), token: { available: false }, channel: "caedrel",
    vodReplay: true, vodError: null, vodStats: { pages: 1, comments: 3, offset: 0 },
  });
  /* a ROOMSTATE for the same room is still deduped while replaying */
  page.line(roomState("caedrel", "92038375"));
  assert.equal(page.posted("twt:history-request").length, 1,
    "the room is asked for once, not once per ROOMSTATE");

  /* replay ends: the plugin cleared the overlay, so the backlog is re-requested
   * even though the channel never changed */
  page.fromPlugin("twt:settings", {
    settings: sidebarSettings(), token: { available: false }, channel: "caedrel",
    vodReplay: false, vodError: null, vodStats: null,
  });
  const requests = page.posted("twt:history-request");
  assert.equal(requests.length, 2, "replay end re-requests the backlog for the same room");
  assert.equal(requests[1].channel, "caedrel");
  assert.equal(requests[1].roomId, "92038375");

  /* and the room is remembered again, so a later ROOMSTATE is deduped */
  page.line(roomState("caedrel", "92038375"));
  assert.equal(page.posted("twt:history-request").length, 2);
});

test("VOD-shaped plugin payloads never throw and keep the sidebar usable", () => {
  const page = openSidebar();
  const settings = sidebarSettings();
  page.fromPlugin("twt:settings", { settings, token: { available: false }, channel: "caedrel" });
  assert.notEqual(page.byId("status-text").textContent.indexOf("#caedrel"), -1);

  /* a VOD starts: the plugin parts the live channel, then broadcasts settings
   * whose channel is gone and that carry the replay fields */
  page.fromPlugin("twt:part", { channel: "caedrel" });
  page.fromPlugin("twt:settings", {
    settings,
    token: { available: false },
    channel: null,
    currentChannel: null,
    channelSource: "none",
    channelNote: "VOD chat replay",
    vodReplay: true,
    vodError: "VOD chat replay unavailable (integrity)",
    vodStats: { pages: 2, comments: 118, offset: 40 },
  });
  assert.equal(page.byId("status-text").textContent.indexOf("#caedrel"), -1, "the stale channel is gone");
  page.fromPlugin("twt:state", { state: "idle", channel: null, vodReplay: true });
  page.fromPlugin("twt:command", { command: "poke" });
  page.fromPlugin("twt:clear", { channel: "caedrel" });

  /* the panes are still rendered and the tabs still switch */
  assert.equal(page.byId("pane-following").hidden, false);
  assert.notEqual(page.byId("pane-following").textContent.length, 0, "the active pane still has content");
  page.fire(page.byId("tab-settings"), "click", {});
  assert.equal(page.byId("pane-settings").hidden, false);
  page.fire(page.byId("tab-following"), "click", {});
  assert.equal(page.byId("pane-following").hidden, false);

  /* a later live join recovers the status line */
  page.fromPlugin("twt:join", { channel: "thebausffs" });
  assert.notEqual(page.byId("status-text").textContent.indexOf("#thebausffs"), -1);
});

test("a VOD settings payload with no channel opens no IRC socket", () => {
  const page = openSidebar();
  page.fromPlugin("twt:settings", {
    settings: sidebarSettings(),
    token: { available: false },
    channel: null,
    currentChannel: null,
    channelSource: "none",
    channelNote: "VOD chat replay",
    vodReplay: true,
    vodError: null,
    vodStats: null,
  });
  assert.equal(page.byId("status-text").textContent, "not connected",
    "a VOD with no channel stays idle");
  assert.throws(() => page.line(":tmi.twitch.tv 001 justinfan1234 :Welcome"),
    /no IRC socket/, "nothing connected the sidebar to IRC");
});

test("thin or hostile payloads are guarded before property access", () => {
  const page = openSidebar();
  const settings = sidebarSettings();
  page.fromPlugin("twt:settings", { settings, token: { available: false }, channel: "caedrel" });

  const payloads = [
    ["twt:settings", { settings, token: { available: false }, channel: null, overrides: null, filters: null, warnings: null, configTried: null, configSource: null }],
    ["twt:settings", { settings, token: { available: true, value: "x" }, channel: "" }],
    ["twt:state", { state: "idle" }],
    ["twt:state", null],
    ["twt:join", {}],
    ["twt:join", null],
    ["twt:part", {}],
    ["twt:part", null],
    ["twt:command", null],
    ["twt:command", {}],
    ["twt:command", { command: "poke" }],
    ["twt:command", { command: "disconnect" }],
    ["twt:emotes", null],
    ["twt:clear", null],
    ["twt:http-result", {}],
    ["twt:twitch-result", {}],
    /* the plugin refuses live history while a VOD is replaying */
    ["twt:history-result", { id: "h1", channel: "caedrel", ok: false, error: "vod chat replay active", messages: [] }],
  ];
  for (const [name, payload] of payloads) {
    assert.doesNotThrow(() => page.fromPlugin(name, payload), name + " must not throw");
  }
  assert.notEqual(page.byId("status-text").textContent.length, 0, "the status line still renders");
});

test("a burst of live events does not break the sidebar", () => {
  const page = startSidebar("caedrel");
  page.line(roomState("caedrel", "92038375"));
  for (let i = 0; i < 200; i++) {
    page.line(privmsg("caedrel", "burst-" + i, "viewer" + i, "message " + i));
  }
  assert.equal(page.posted("twt:event").length, 201, "every event is forwarded (roomstate + 200 messages)");
  assert.notEqual(page.byId("status-text").textContent.indexOf("#caedrel"), -1);
  assert.equal(page.posted("twt:history-request").length, 1, "one history request for the room, not one per event");
  /* the tab shell is still alive */
  page.fire(page.byId("tab-top"), "click", {});
  assert.equal(page.byId("pane-top").hidden, false);
});

test("the standalone page loads the browse scripts, never the transport", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/standalone.html"), "utf8");
  assert.notEqual(html.indexOf('src="protocol.js"'), -1, "it loads the protocol shim");
  assert.notEqual(html.indexOf('src="browser.js"'), -1, "it loads the browse page script");
  /* browser.js reads no TwitchPlugin global, so nothing from lib/ belongs here,
   * and the transport would own a WebSocket this window cannot use */
  for (const dropped of ["transport.js", "../lib/irc.js", "../lib/config.js", "../lib/emotes.js", "../lib/strftime.js"]) {
    assert.equal(html.indexOf('src="' + dropped + '"'), -1, "it must not load " + dropped);
  }
  assert.equal(html.indexOf('id="pane-settings"'), -1, "no settings pane");
  assert.equal(html.indexOf('id="tab-settings"'), -1, "no settings button");
  for (const id of ["pane-following", "pane-top", "pane-categories", "pane-search", "pane-videos"]) {
    assert.notEqual(html.indexOf('id="' + id + '"'), -1, "it has " + id);
  }

  /* behaviour: the missing Settings tab is skipped, the browse tabs still work */
  const page = openStandalone();
  assert.equal(page.byId("pane-settings"), undefined);
  assert.equal(page.byId("tab-settings"), undefined);
  assert.equal(page.byId("pane-following").hidden, false, "Following is the first existing tab");
  page.fire(page.byId("tab-top"), "click", {});
  assert.equal(page.byId("pane-top").hidden, false);
  assert.equal(page.byId("pane-following").hidden, true);
  page.fire(page.byId("tab-videos"), "click", {});
  assert.equal(page.byId("pane-videos").hidden, false);

  /* the same guard leaves the sidebar's Settings tab alone */
  const sidebar = openSidebar();
  assert.notEqual(sidebar.byId("pane-settings"), undefined);
  assert.notEqual(sidebar.byId("tab-settings"), undefined);
});

test("the standalone page talks the host contract: path + absolute url in, rows and twt:open out", async () => {
  const h = browserHarness(openStandalone);
  const identity = h.requests()[0];
  assert.equal(identity.path, "/identity");
  assert.equal(identity.url, "https://id.twitch.tv/oauth2/validate",
    "the identity probe is the token-validate endpoint in absolute form");
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();

  clickTab(h, "top");
  await tick();
  const top = h.requests().filter((entry) => entry.path === "/helix/streams?first=30")[0];
  assert.ok(top, "the host is asked for the top streams");
  assert.equal(top.url, "https://api.twitch.tv/helix/streams?first=30",
    "every request also carries the absolute url");
  h.answerPath("/helix/streams?first=30", { data: { data: [{
    id: "s1", user_login: "xqc", user_name: "xQc", title: "top", game_name: "Just Chatting",
    viewer_count: 10, started_at: new Date().toISOString(),
  }] } });
  await tick();

  const row = h.page.find('[data-kind="stream"]')[0];
  const watch = row.querySelectorAll('[data-action="watch"]')[0];
  h.page.fire(watch, "click", {});
  h.page.fire(watch, "click", { metaKey: true });
  assert.deepEqual(h.page.posted("twt:open"), [
    { url: "https://www.twitch.tv/xqc", target: "current" },
    { url: "https://www.twitch.tv/xqc", target: "new" },
  ]);
});

test("the standalone footer is neutral and never claims a channel or a connection", () => {
  const h = browserHarness(openStandalone);
  assert.equal(h.page.byId("status-text").textContent, "browsing");
  h.page.fromPlugin("twt:settings", {
    settings: { twitch: { username: "viewer" }, chat: {} },
    token: { available: true }, channel: null,
  });
  assert.equal(h.page.byId("status-text").textContent, "browsing \u00b7 token available");
  h.page.fromPlugin("twt:settings", { settings: { twitch: {}, chat: {} }, token: { available: false }, channel: null });
  assert.equal(h.page.byId("status-text").textContent, "browsing \u00b7 no token");
  const text = h.page.byId("status-text").textContent;
  assert.equal(text.indexOf("#"), -1, "no channel is rendered");
  assert.equal(/connect/i.test(text), false, "never a connection claim");

  /* browser.js's neutral hook is inert where the Settings pane exists: the
     sidebar footer stays the transport's */
  const sidebar = openSidebar();
  sidebar.fromPlugin("twt:settings", {
    settings: sidebarSettings(), token: { available: true }, channel: null,
  });
  assert.equal(sidebar.byId("status-text").textContent, "not connected",
    "the transport owns the sidebar footer");
});

test("the connection indicator lives in a pinned footer, not the header", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/sidebar.html"), "utf8");
  const headerStart = html.indexOf("<header");
  const headerEnd = html.indexOf("</header>");
  assert.ok(headerStart !== -1 && headerEnd > headerStart, "the header exists");
  const header = html.slice(headerStart, headerEnd);
  assert.equal(header.indexOf("status-dot"), -1, "the header no longer holds the dot");
  assert.equal(header.indexOf("status-text"), -1, "the header no longer holds the text");

  const footerStart = html.indexOf('<footer id="status-bar"');
  const footerEnd = html.indexOf("</footer>", footerStart);
  assert.ok(footerStart !== -1 && footerEnd > footerStart, "the footer exists");
  const footer = html.slice(footerStart, footerEnd);
  assert.notEqual(footer.indexOf('id="status-dot"'), -1, "the footer holds the dot");
  assert.notEqual(footer.indexOf('id="status-text"'), -1, "the footer holds the text");
  assert.notEqual(footer.indexOf('data-state="idle"'), -1, "the dot keeps its state attribute");

  /* the shell is header -> panes -> footer, and the pane is the scroll region */
  assert.ok(headerEnd < html.indexOf('id="pane-following"'), "the panes follow the header");
  assert.ok(html.indexOf('id="pane-settings"') < footerStart, "the footer follows every pane");
  assert.ok(footerStart < html.lastIndexOf("</div>"), "the footer is inside the shell");

  const css = fs.readFileSync(path.join(ROOT, "ui/browser.css"), "utf8");
  assert.match(css, /\.twt-root \.twt-header\s*\{[^}]*border-bottom:\s*0/, "the header border is folded into the nav");
  assert.match(css, /\.twt-pane\s*\{[^}]*overflow-y:\s*auto/, "the pane is the scroll container");
  assert.match(css, /\.twt-status-bar\s*\{[^}]*flex:\s*0 0 auto/, "the footer neither grows nor shrinks");
  assert.match(css, /\.twt-status-bar\s*\{[^}]*border-top:/, "the footer is separated by a subtle border");
  /* a narrow sidebar: the strip scrolls sideways instead of wrapping */
  assert.match(css, /\.twt-tabs\s*\{[^}]*flex-wrap:\s*nowrap/, "the tab strip never wraps");
  assert.match(css, /\.twt-tabs\s*\{[^}]*overflow-x:\s*auto/, "the tab strip scrolls horizontally");
});

test("status updates still land on the same ids after the move", () => {
  const page = startSidebar("caedrel");
  assert.notEqual(page.byId("status-text").textContent.indexOf("#caedrel"), -1,
    "the transport writes the channel into #status-text");
  const state = page.byId("status-dot").getAttribute("data-state");
  assert.ok(["idle", "connecting", "connected", "reconnecting", "closed"].indexOf(state) !== -1,
    "the dot keeps a known data-state for the CSS colours");
});

test("the Videos tab filters the loaded videos by title, channel name and login", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [
    { broadcaster_id: "id1", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" },
    { broadcaster_id: "id2", broadcaster_login: "thebausffs", broadcaster_name: "Thebausffs" },
  ];
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answerPath("/helix/videos?user_id=id1&type=archive&first=10", { data: { data: [
    { id: "v1", user_login: "caedrel", user_name: "Caedrel", title: "Worlds Finals", duration: "1h", published_at: "2024-01-02T00:00:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/a-%{width}x%{height}.jpg" },
  ], pagination: {} } });
  h.answerPath("/helix/videos?user_id=id2&type=archive&first=10", { data: { data: [
    { id: "v2", user_login: "thebausffs", user_name: "Thebausffs", title: "Ranked Grind", duration: "2h", published_at: "2024-01-03T00:00:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/b-%{width}x%{height}.jpg" },
  ], pagination: {} } });
  await tick();

  const ids = () => h.page.find('[data-kind="vod"]').map((row) => row.dataset.id);
  assert.deepEqual(ids(), ["v2", "v1"], "both videos render, newest first");

  const input = h.page.find('[data-action="video-search-input"]')[0];
  const queryVideos = (value) => {
    input.value = value;
    h.page.fire(input, "input", {});
    h.page.advanceTimers(300);
  };

  queryVideos("worlds");
  assert.deepEqual(ids(), ["v1"], "title match is case-insensitive");
  queryVideos("GRIND");
  assert.deepEqual(ids(), ["v2"], "title match ignores case");
  queryVideos("THEBAUSFFS");
  assert.deepEqual(ids(), ["v2"], "channel name/login match ignores case");
  queryVideos("caedrel");
  assert.deepEqual(ids(), ["v1"], "channel login matches");
  queryVideos("nothing-matches");
  assert.deepEqual(ids(), [], "no rows when nothing matches");
  assert.match(h.page.byId("pane-videos").textContent, /No videos match/);

  queryVideos("");
  assert.deepEqual(ids(), ["v2", "v1"], "clearing the query restores the full list");
  assert.match(h.page.byId("pane-videos").textContent, /Filters the videos of the channels you follow/,
    "the hint states the coverage, not a global search");
});

test("the Videos tab filter never searches beyond the followed channels", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [{ broadcaster_id: "id1", broadcaster_login: "chan1", broadcaster_name: "Chan 1" }];
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answerPath("/helix/videos?user_id=id1&type=archive&first=10", { data: { data: [{
    id: "a1", user_login: "chan1", user_name: "Chan 1", title: "one", duration: "1m",
    published_at: "2024-01-02T00:00:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/a-%{width}x%{height}.jpg",
  }], pagination: {} } });
  await tick();
  assert.equal(h.page.find('[data-kind="vod"]').length, 1, "the followed channel's video renders");

  /* typing a non-followed channel name into the filter must not trigger a
   * channel search: the filter only ever considers the loaded videos */
  const input = h.page.find('[data-action="video-search-input"]')[0];
  input.value = "someoneelse";
  h.page.fire(input, "input", {});
  h.page.advanceTimers(300);
  await tick();

  const searchRequests = h.requests().filter((entry) => entry.path.indexOf("/helix/search/channels") === 0);
  assert.equal(searchRequests.length, 0, "the Videos tab never issues a channel search");
  assert.equal(h.page.find('[data-kind="vod"]').length, 0, "a non-followed channel's videos never appear");
  assert.match(h.page.byId("pane-videos").textContent,
    /No videos match \u201csomeoneelse\u201d in the channels you follow/,
    "the filter reports the miss within the followed channels");
});

test("the Categories tab searches /helix/search/categories and keeps its query", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();
  clickTab(h, "categories");
  await tick();
  h.answerPath("/helix/games/top?first=30", {
    data: { data: [{ id: "21779", name: "League of Legends", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/21779-{width}x{height}.jpg" }] },
  });
  await tick();
  assert.deepEqual(h.page.find('[data-kind="category"]').map((row) => row.dataset.id), ["21779"],
    "the empty query shows Twitch's top list");

  const input = h.page.find('[data-action="category-search-input"]')[0];
  input.value = "league";
  h.page.fire(input, "input", {});
  assert.equal(h.requests().filter((entry) => entry.path.indexOf("/helix/search/categories") === 0).length, 0,
    "typing is debounced");
  h.page.advanceTimers(300);
  const path = "/helix/search/categories?query=league&first=20";
  assert.ok(h.requests().some((entry) => entry.path === path), "the category search endpoint is used");
  h.answerPath(path, { data: { data: [{ id: "9446", name: "League Challenge", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/9446-{width}x{height}.jpg" }] } });
  await tick();
  assert.deepEqual(h.page.find('[data-kind="category"]').map((row) => row.dataset.id), ["9446"]);

  /* per-tab query survives a trip away and back */
  clickTab(h, "top");
  await tick();
  h.answerPath("/helix/streams?first=30", { data: { data: [] } });
  await tick();
  clickTab(h, "categories");
  await tick();
  assert.equal(h.page.find('[data-action="category-search-input"]')[0].value, "league", "the query is preserved");
  assert.deepEqual(h.page.find('[data-kind="category"]').map((row) => row.dataset.id), ["9446"],
    "the results are preserved without a refetch");

  /* a failed search shows the normal error card with Retry */
  input.value = "fail";
  h.page.fire(input, "input", {});
  h.page.advanceTimers(300);
  const failPath = "/helix/search/categories?query=fail&first=20";
  h.answerPath(failPath, { ok: false, status: 0, error: "blocked" });
  await tick();
  assert.match(h.page.byId("pane-categories").textContent, /blocked/);
  assert.equal(h.page.find('[data-action="retry"]').length, 1, "the error card offers Retry");
});

test("a VOD with no thumbnail uses the live stream thumbnail while the channel is live", async () => {
  const h = await openOverview({ vods: [
    { id: "live-vod", user_login: "caedrel", user_name: "Caedrel", title: "Today's stream", duration: "2h", published_at: "2024-06-01T00:00:00Z", thumbnail_url: "" },
  ], pagination: {} });
  const row = h.page.find('[data-kind="vod"]')[0];
  const img = row.children[0].children[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.src, "https://static-cdn.jtvnw.net/previews-ttv/live_user_caedrel-160x90.jpg",
    "the live template is resolved to 160x90");
});

test("an offline channel with no VOD thumbnail keeps the placeholder", async () => {
  const h = await openOverview({ offline: true, vods: [
    { id: "v", user_login: "thebausffs", title: "old stream", duration: "1h", published_at: "2024-01-01T00:00:00Z", thumbnail_url: "" },
  ], pagination: {} });
  const box = h.page.find('[data-kind="vod"]')[0].children[0];
  assert.ok(box.classList.contains("twt-art-placeholder"), "no invented image");
  assert.equal(box.children.length, 0, "no broken <img>");
});

test("a VOD with its own thumbnail keeps it", async () => {
  const h = await openOverview();
  const box = h.page.find('[data-kind="vod"]')[0].children[0];
  assert.equal(box.children[0].src, "https://static-cdn.jtvnw.net/cf_vods/v1-160x90.jpg");
});

test("a non-Twitch live thumbnail is rejected by the host guard", async () => {
  const h = await openOverview({
    liveStream: {
      user_login: "caedrel", user_name: "Caedrel", viewer_count: 1,
      started_at: new Date().toISOString(),
      thumbnail_url: "https://evil.example.com/live-%{width}x%{height}.jpg",
    },
    vods: [{ id: "v", user_login: "caedrel", title: "t", duration: "1m", published_at: "2024-01-01T00:00:00Z", thumbnail_url: "" }],
    pagination: {},
  });
  const box = h.page.find('[data-kind="vod"]')[0].children[0];
  assert.ok(box.classList.contains("twt-art-placeholder"), "the fallback goes through the host guard");
  assert.equal(box.children.length, 0);
});

test("the Videos tab resolves missing VOD thumbnails with one batched live call", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [
    { broadcaster_id: "id1", broadcaster_login: "chan1", broadcaster_name: "Chan 1" },
    { broadcaster_id: "id2", broadcaster_login: "chan2", broadcaster_name: "Chan 2" },
  ];
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  /* answer the Following tab's own live batch so it cannot be mistaken for the
   * Videos tab's later one */
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answerPath("/helix/videos?user_id=id1&type=archive&first=10", { data: { data: [
    { id: "a1", user_login: "chan1", user_name: "Chan 1", title: "live one", duration: "1m", published_at: "2024-01-02T00:00:00Z", thumbnail_url: "" },
  ], pagination: {} } });
  h.answerPath("/helix/videos?user_id=id2&type=archive&first=10", { data: { data: [
    { id: "b1", user_login: "chan2", user_name: "Chan 2", title: "live two", duration: "1m", published_at: "2024-01-01T00:00:00Z", thumbnail_url: "" },
  ], pagination: {} } });
  await tick();

  const batch = "/helix/streams?first=2&user_login=chan1&user_login=chan2";
  assert.equal(h.requests().filter((entry) => entry.path === batch).length, 2,
    "one batch for the Following tab, one for the Videos page (not one per row)");
  h.answerPath(batch, { data: { data: [
    { user_login: "chan1", thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_chan1-%{width}x%{height}.jpg" },
  ] } });
  await tick();

  const rows = h.page.find('[data-kind="vod"]');
  const byId = (id) => rows.filter((row) => row.dataset.id === id)[0];
  assert.equal(byId("a1").children[0].children[0].src,
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_chan1-160x90.jpg");
  assert.ok(byId("b1").children[0].classList.contains("twt-art-placeholder"),
    "a channel that is not live keeps the placeholder");
});

test("the Videos tab issues no live call when every VOD already has a thumbnail", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [
    { broadcaster_id: "id1", broadcaster_login: "chan1", broadcaster_name: "Chan 1" },
    { broadcaster_id: "id2", broadcaster_login: "chan2", broadcaster_name: "Chan 2" },
  ];
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answerPath("/helix/videos?user_id=id1&type=archive&first=10", { data: { data: [
    { id: "a1", user_login: "chan1", user_name: "Chan 1", title: "one", duration: "1m", published_at: "2024-01-02T00:00:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/a-%{width}x%{height}.jpg" },
  ], pagination: {} } });
  h.answerPath("/helix/videos?user_id=id2&type=archive&first=10", { data: { data: [
    { id: "b1", user_login: "chan2", user_name: "Chan 2", title: "two", duration: "1m", published_at: "2024-01-01T00:00:00Z", thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/b-%{width}x%{height}.jpg" },
  ], pagination: {} } });
  await tick();

  const batch = "/helix/streams?first=2&user_login=chan1&user_login=chan2";
  assert.equal(h.requests().filter((entry) => entry.path === batch).length, 1,
    "only the Following tab's batch; the VOD rows already had art");
  assert.equal(h.page.find('[data-kind="vod"]').length, 2);
});

test("a token invalid reply renders the error state and Retry re-requests", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { ok: false, status: 401, error: "token invalid" });
  await tick();
  const body = h.page.byId("pane-following");
  assert.match(body.textContent, /token invalid/i);

  const retry = h.page.find('[data-action="retry"]');
  assert.equal(retry.length, 1, "the error state offers a Retry");
  const before = h.requests().filter((entry) => entry.path === "/identity").length;
  h.page.fire(retry[0], "click", {});
  const after = h.requests().filter((entry) => entry.path === "/identity").length;
  assert.equal(after, before + 1, "Retry asks the plugin again");
});

test("the overlay renders history emotes whichever order the index arrives in", () => {
  /* index first */
  const early = openOverlay();
  early.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  early.fromPlugin("twt:emotes", { index: providerIndex() });
  early.fromPlugin("twt:history-result", {
    id: "h1",
    channel: "caedrel",
    ok: true,
    messages: [historyMessage("h-1", "o7 xdd", 1000)],
  });
  assert.deepEqual(early.images().map((img) => img.src), [O7_URL, XDD_URL]);
  assert.equal(early.rendered(), "o7 xdd");

  /* index after the history: the late-index re-render must cover history rows */
  const late = openOverlay();
  late.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  late.fromPlugin("twt:history-result", {
    id: "h1",
    channel: "caedrel",
    ok: true,
    messages: [historyMessage("h-1", "o7 xdd", 1000)],
  });
  assert.equal(late.images().length, 0);
  assert.equal(late.rendered(), "o7 xdd");
  late.fromPlugin("twt:emotes", { index: providerIndex() });
  assert.deepEqual(late.images().map((img) => img.src), [O7_URL, XDD_URL]);
  assert.equal(late.rendered(), "o7 xdd");
});

test("the overlay ignores history for another channel and dedupes what it already shows", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  /* live message with id m1 is already on screen */
  page.fromPlugin("twt:event", { event: chatEvent("live one", []) });
  page.fromPlugin("twt:history-result", {
    id: "h1",
    channel: "thebausffs",
    ok: true,
    messages: [historyMessage("h-9", "wrong channel", 100)],
  });
  assert.equal(page.rows().length, 1, "another channel's history is ignored");

  page.fromPlugin("twt:history-result", {
    id: "h2",
    channel: "caedrel",
    ok: true,
    messages: [historyMessage("m1", "live one", 500), historyMessage("h-9", "older", 100)],
  });
  assert.deepEqual(page.entries().map((entry) => entry.id || entry.className), [
    "h-9", "twt-history-divider", "m1",
  ]);
  /* the live message itself is rendered once, below the divider */
  const rows = page.rows();
  assert.deepEqual(rows.map((row) => row.dataset.msgId), ["h-9", "m1"]);
  assert.deepEqual(rows.map((row) => row.textContent), ["older", "live one"]);
});

/* -------------------------------------------- overlay layout edit mode
 *
 * The plugin owns persistence: it pushes "twt:overlay-layout" {channel, layout}
 * and the overlay applies the anchored geometry, arms its always-on move/resize
 * affordances, and reports geometry continuously while a gesture runs (at most
 * one twt:overlay-moved per 100 ms) plus a final one on release. Every test
 * below drives real DOM events through the harness - mouseenter on the panel,
 * mousedown on a marker, mousemove/mouseup/keydown on window, wheel/scroll on
 * the list - so the maths under test is the maths the web view runs.
 */

function layoutMessage(layout, channel) {
  return {
    channel: channel === undefined ? "caedrel" : channel,
    layout: layout,
  };
}

function anchored(anchor, dx, dy, w, h) {
  return { anchor, dx, dy, w, h };
}

function laidOutOverlay(layout, options) {
  const page = openOverlay(options);
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page.fromPlugin("twt:overlay-layout", layoutMessage(layout));
  return page;
}

/* The nine always-on affordances: the header (move) and the eight resize zones. */
const AFFORDANCES = [
  "overlay-header",
  "overlay-edge-top", "overlay-edge-right", "overlay-edge-bottom", "overlay-edge-left",
  "overlay-corner-tl", "overlay-corner-tr", "overlay-corner-bl", "overlay-corner-br",
];

function zoneCentre(page, id) {
  const rect = page.byId(id).rect;
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
}

/* A point inside the header but clear of the top edge band and the corners. */
function headerPoint(page) {
  const rect = page.byId("overlay-panel").rect;
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + 18) };
}

/* Read rule bodies from chat.css by one of their selectors, so the test model is
 * derived from the stylesheet instead of duplicating it. Blocks are parsed by
 * brace depth (rules inside @media are flattened in, instead of swallowing the
 * body the way a flat regex does), comments are stripped, and the selector must
 * be a whole item of the rule's selector list. */
function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf("{", i);
    if (open === -1) break;
    const selector = clean.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") depth--;
      j++;
    }
    const body = clean.slice(open + 1, j - 1);
    if (selector.charAt(0) === "@") Array.prototype.push.apply(rules, parseRules(body));
    else rules.push({ selector: selector, body: body });
    i = j;
  }
  return rules;
}

function cssRuleBodies(css, selector) {
  return parseRules(css)
    .filter((rule) => rule.selector.split(",").map((item) => item.trim()).indexOf(selector) !== -1)
    .map((rule) => rule.body);
}

function cssRuleBody(css, selector) {
  const found = cssRuleBodies(css, selector);
  return found.length ? found[0] : null;
}

function cssZFor(css, selector) {
  for (const body of cssRuleBodies(css, selector)) {
    const z = cssZ(body);
    if (z !== undefined) return z;
  }
  return undefined;
}

/* px values by exact property name, with the `inset` shorthand expanded. */
function cssPx(body, property) {
  if (!body) return undefined;
  if (property !== "inset") {
    const direct = new RegExp("(?:^|[;\\s])" + property + "\\s*:\\s*(-?[0-9.]+)px").exec(body);
    if (direct) return parseFloat(direct[1]);
  }
  const inset = /(?:^|[;\s])inset\s*:\s*([^;]+)/.exec(body);
  if (!inset) return undefined;
  const parts = inset[1].trim().split(/\s+/).map((value) => parseFloat(value));
  if (!parts.length || parts.some((value) => !isFinite(value))) return undefined;
  const values = {
    top: parts[0],
    right: parts[1] === undefined ? parts[0] : parts[1],
    bottom: parts[2] === undefined ? parts[0] : parts[2],
    left: parts[3] === undefined ? (parts[1] === undefined ? parts[0] : parts[1]) : parts[3],
  };
  return values[property];
}

function cssZ(body) {
  const match = body ? /(?:^|[;\s])z-index\s*:\s*(-?\d+)/.exec(body) : null;
  return match ? parseInt(match[1], 10) : undefined;
}

/* The fake DOM has no layout engine; model the boxes chat.css draws so
 * elementFromPoint()/IINA's hit test can be exercised. The panel covers its
 * applied geometry (or the stylesheet default); inside it, the header spans the
 * top and the eight zones are the four edge bands and four corner squares; the
 * catcher covers the viewport. Band thicknesses, corner size and z-order are
 * READ FROM chat.css (and asserted explicitly in the tests too), so a CSS
 * regression fails here instead of being mirrored by a hardcoded model. */
function applyLayoutRects(page, options) {
  const opts = options || {};
  const vw = opts.width === undefined ? 1280 : opts.width;
  const vh = opts.height === undefined ? 720 : opts.height;
  const root = page.byId("overlay-root");
  const num = (value) => parseFloat(value) || 0;
  const panel = root.style.width
    ? { x: num(root.style.left), y: num(root.style.top), w: num(root.style.width), h: num(root.style.height) }
    : { x: vw - 12 - 340, y: vh * 0.1, w: 340, h: vh * 0.8 };   /* the CSS default */

  const css = fs.readFileSync(path.join(ROOT, "ui/chat.css"), "utf8");
  const place = (id, rect, z, pointer) => {
    const element = page.byId(id);
    element.rect = rect;
    if (z !== undefined) element.z = z;
    if (pointer !== undefined) element.pointerEvents = pointer;
  };
  /* decorative panel content is transparent to hit testing (chat.css) */
  const blanket = cssRuleBody(css, ".twt-overlay-panel *");
  const decorativeOff = /pointer-events:\s*none/.test(blanket || "");
  const panelPointer = decorativeOff ? "none" : "";
  const bandY = cssPx(cssRuleBody(css, ".twt-overlay-edge-top"), "height") || 7;
  const bandX = cssPx(cssRuleBody(css, ".twt-overlay-edge-left"), "width") || 7;
  const corner = cssPx(cssRuleBody(css, ".twt-overlay-corner"), "width") || 16;
  const zoneZ = cssZ(cssRuleBody(css, ".twt-overlay-zone")) || 3;
  const cornerZ = cssZ(cssRuleBody(css, ".twt-overlay-corner")) || 4;
  const catcherZ = cssZFor(css, ".twt-overlay-catcher") || 30;
  const headerHeight = 22;

  place("overlay-root", panel);
  place("overlay-panel", panel, cssZFor(css, ".twt-overlay-panel"), panelPointer);
  place("overlay-header", { x: panel.x, y: panel.y, w: panel.w, h: headerHeight }, 0);
  place("overlay-edge-top", { x: panel.x, y: panel.y, w: panel.w, h: bandY }, zoneZ);
  place("overlay-edge-bottom", { x: panel.x, y: panel.y + panel.h - bandY, w: panel.w, h: bandY }, zoneZ);
  place("overlay-edge-left", { x: panel.x, y: panel.y, w: bandX, h: panel.h }, zoneZ);
  place("overlay-edge-right", { x: panel.x + panel.w - bandX, y: panel.y, w: bandX, h: panel.h }, zoneZ);
  place("overlay-corner-tl", { x: panel.x, y: panel.y, w: corner, h: corner }, cornerZ);
  place("overlay-corner-tr", { x: panel.x + panel.w - corner, y: panel.y, w: corner, h: corner }, cornerZ);
  place("overlay-corner-bl", { x: panel.x, y: panel.y + panel.h - corner, w: corner, h: corner }, cornerZ);
  place("overlay-corner-br", { x: panel.x + panel.w - corner, y: panel.y + panel.h - corner, w: corner, h: corner }, cornerZ);

  const messagesRect = { x: panel.x + 1, y: panel.y + headerHeight, w: panel.w - 2, h: panel.h - headerHeight - 22 };
  place("messages", messagesRect, undefined, "auto");
  place("jump-bottom", { x: panel.x + panel.w - 90, y: panel.y + panel.h - 30, w: 80, h: 22 },
    cssZ(cssRuleBody(css, ".twt-jump-bottom")) || 2, "auto");
  place("overlay-catcher", { x: 0, y: 0, w: vw, h: vh }, catcherZ);
  /* the real chat rows live inside #messages: decorative, so they are
   * transparent to hit testing exactly when the stylesheet says so */
  for (const rowElement of page.byId("messages").children) {
    rowElement.rect = messagesRect;
    rowElement.pointerEvents = decorativeOff ? "none" : "";
  }
  return page;
}

test("a top-right layout renders from the right edge and keeps the gap on resize", () => {
  const page = laidOutOverlay(anchored("tr", 100, 40, 360, 240), { width: 1280, height: 720 });
  const root = page.byId("overlay-root");

  assert.equal(root.style.left, "820px", "1280 - 100 - 360");
  assert.equal(root.style.top, "40px");
  assert.equal(root.style.width, "360px");
  assert.equal(root.style.height, "240px");

  /* a video-window resize must not change the right/top gaps */
  page.resize(900, 600);
  assert.equal(root.style.left, "440px", "900 - 100 - 360: the right gap is unchanged");
  assert.equal(root.style.top, "40px", "the top gap is unchanged");
  assert.equal(root.style.width, "360px");
  assert.equal(root.style.height, "240px");
  assert.equal(page.posted("twt:overlay-moved").length, 0, "a viewport resize is not a gesture");
});

test("bottom-left and bottom-right layouts mirror the bottom gap", () => {
  const bl = laidOutOverlay(anchored("bl", 50, 30, 400, 200));
  const blRoot = bl.byId("overlay-root");
  assert.equal(blRoot.style.left, "50px");
  assert.equal(blRoot.style.top, "490px", "720 - 30 - 200");

  bl.resize(800, 500);
  assert.equal(blRoot.style.top, "270px", "500 - 30 - 200: the bottom gap is unchanged");
  assert.equal(blRoot.style.left, "50px");

  const br = laidOutOverlay(anchored("br", 60, 20, 300, 180));
  const brRoot = br.byId("overlay-root");
  assert.equal(brRoot.style.left, "920px", "1280 - 60 - 300");
  assert.equal(brRoot.style.top, "520px", "720 - 20 - 180");

  br.resize(800, 500);
  assert.equal(brRoot.style.left, "440px", "800 - 60 - 300");
  assert.equal(brRoot.style.top, "300px", "500 - 20 - 180");
});

test("each edge resizes only its own edge, keeping the opposite edge fixed", () => {
  const cases = [
    { zone: "overlay-edge-top", move: [0, 40], x: 100, y: 120, w: 300, h: 160, dy: 120,
      fixed: "bottom", fixedAt: 280 },
    { zone: "overlay-edge-right", move: [40, 0], x: 100, y: 80, w: 340, h: 200,
      fixed: "left", fixedAt: 100 },
    { zone: "overlay-edge-bottom", move: [0, 40], x: 100, y: 80, w: 300, h: 240,
      fixed: "top", fixedAt: 80 },
    { zone: "overlay-edge-left", move: [40, 0], x: 140, y: 80, w: 260, h: 200,
      fixed: "right", fixedAt: 400 },
  ];

  for (const c of cases) {
    const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
    applyLayoutRects(page);
    const root = page.byId("overlay-root");
    const at = zoneCentre(page, c.zone);
    page.fire(page.byId(c.zone), "mousedown", { clientX: at.x, clientY: at.y });
    page.fireWindow("mousemove", { clientX: at.x + c.move[0], clientY: at.y + c.move[1] });
    page.fireWindow("mouseup", { clientX: at.x + c.move[0], clientY: at.y + c.move[1] });

    assert.equal(root.style.left, c.x + "px", c.zone + ": x");
    assert.equal(root.style.top, c.y + "px", c.zone + ": y");
    assert.equal(root.style.width, c.w + "px", c.zone + ": width");
    assert.equal(root.style.height, c.h + "px", c.zone + ": height");
    if (c.fixed === "left") assert.equal(c.x, c.fixedAt, c.zone + ": the left edge stays fixed");
    if (c.fixed === "right") assert.equal(c.x + c.w, c.fixedAt, c.zone + ": the right edge stays fixed");
    if (c.fixed === "top") assert.equal(c.y, c.fixedAt, c.zone + ": the top edge stays fixed");
    if (c.fixed === "bottom") assert.equal(c.y + c.h, c.fixedAt, c.zone + ": the bottom edge stays fixed");

    const payload = { channel: "caedrel", anchor: "tl", dx: c.x, dy: c.dy === undefined ? 80 : c.dy, w: c.w, h: c.h };
    assert.deepEqual(page.posted("twt:overlay-moved"), [
      payload,
      Object.assign({}, payload, { done: true }),
    ]);
  }
});

test("each corner resizes both of its edges", () => {
  const cases = [
    { zone: "overlay-corner-tl", move: [40, 40], x: 140, y: 120, w: 260, h: 160, dx: 140, dy: 120,
      fixed: "right+bottom", right: 400, bottom: 280 },
    { zone: "overlay-corner-tr", move: [-40, 40], x: 100, y: 120, w: 260, h: 160, dx: 100, dy: 120,
      fixed: "left+bottom", left: 100, bottom: 280 },
    { zone: "overlay-corner-bl", move: [40, -40], x: 140, y: 80, w: 260, h: 160, dx: 140, dy: 80,
      fixed: "right+top", right: 400, top: 80 },
    { zone: "overlay-corner-br", move: [-40, -40], x: 100, y: 80, w: 260, h: 160, dx: 100, dy: 80,
      fixed: "left+top", left: 100, top: 80 },
  ];

  for (const c of cases) {
    const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
    applyLayoutRects(page);
    const root = page.byId("overlay-root");
    const at = zoneCentre(page, c.zone);
    page.fire(page.byId(c.zone), "mousedown", { clientX: at.x, clientY: at.y });
    page.fireWindow("mousemove", { clientX: at.x + c.move[0], clientY: at.y + c.move[1] });
    page.fireWindow("mouseup", { clientX: at.x + c.move[0], clientY: at.y + c.move[1] });

    assert.equal(root.style.left, c.x + "px", c.zone + ": x");
    assert.equal(root.style.top, c.y + "px", c.zone + ": y");
    assert.equal(root.style.width, c.w + "px", c.zone + ": width");
    assert.equal(root.style.height, c.h + "px", c.zone + ": height");
    if (c.left !== undefined) assert.equal(c.x, c.left, c.zone + ": the left edge stays fixed");
    if (c.right !== undefined) assert.equal(c.x + c.w, c.right, c.zone + ": the right edge stays fixed");
    if (c.top !== undefined) assert.equal(c.y, c.top, c.zone + ": the top edge stays fixed");
    if (c.bottom !== undefined) assert.equal(c.y + c.h, c.bottom, c.zone + ": the bottom edge stays fixed");

    const payload = { channel: "caedrel", anchor: "tl", dx: c.dx, dy: c.dy, w: c.w, h: c.h };
    assert.deepEqual(page.posted("twt:overlay-moved"), [
      payload,
      Object.assign({}, payload, { done: true }),
    ]);
  }
});

test("the opposite-corner handle keeps each anchor's edge and dx/dy fixed", () => {
  /* viewport 1280x720, layout dx=100 dy=80 w=300 h=200 for every corner */
  const cases = [
    /* anchor, opposite-corner zone, drag delta, expected rect and geo */
    { anchor: "tl", zone: "overlay-corner-br", move: [40, 40], x: 100, y: 80, w: 340, h: 240,
      dx: 100, dy: 80 },
    { anchor: "tr", zone: "overlay-corner-bl", move: [-40, 40], x: 840, y: 80, w: 340, h: 240,
      dx: 100, dy: 80 },
    { anchor: "bl", zone: "overlay-corner-tr", move: [40, -40], x: 100, y: 400, w: 340, h: 240,
      dx: 100, dy: 80 },
    { anchor: "br", zone: "overlay-corner-tl", move: [-40, -40], x: 840, y: 400, w: 340, h: 240,
      dx: 100, dy: 80 },
  ];

  for (const c of cases) {
    const page = laidOutOverlay(anchored(c.anchor, 100, 80, 300, 200));
    applyLayoutRects(page);
    const root = page.byId("overlay-root");
    const at = zoneCentre(page, c.zone);
    page.fire(page.byId(c.zone), "mousedown", { clientX: at.x, clientY: at.y });
    page.fireWindow("mousemove", { clientX: at.x + c.move[0], clientY: at.y + c.move[1] });
    page.fireWindow("mouseup", { clientX: at.x + c.move[0], clientY: at.y + c.move[1] });

    assert.equal(root.style.left, c.x + "px", c.anchor + ": x");
    assert.equal(root.style.top, c.y + "px", c.anchor + ": y");
    assert.equal(root.style.width, c.w + "px", c.anchor + ": width");
    assert.equal(root.style.height, c.h + "px", c.anchor + ": height");
    const payload = { channel: "caedrel", anchor: c.anchor, dx: c.dx, dy: c.dy, w: c.w, h: c.h };
    assert.deepEqual(page.posted("twt:overlay-moved"), [
      payload,
      Object.assign({}, payload, { done: true }),
    ], c.anchor + ": dx/dy are unchanged by a resize from the opposite corner");
  }
});

test("resizing clamps to 220 x 120 and strictly inside the video area", () => {
  /* a corner dragged towards the fixed edges stops at the floor */
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const root = page.byId("overlay-root");
  const at = zoneCentre(page, "overlay-corner-br");
  page.fire(page.byId("overlay-corner-br"), "mousedown", { clientX: at.x, clientY: at.y });
  page.fireWindow("mousemove", { clientX: at.x - 5000, clientY: at.y - 5000 });
  page.fireWindow("mouseup", { clientX: at.x - 5000, clientY: at.y - 5000 });
  assert.equal(root.style.width, "220px");
  assert.equal(root.style.height, "120px");
  assert.equal(root.style.left, "100px", "the left edge stays fixed");
  assert.equal(root.style.top, "80px", "the top edge stays fixed");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 100, dy: 80, w: 220, h: 120, done: true },
  ]);

  /* growing stops at the viewport: the fixed left/top edges bound the size */
  const grown = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(grown);
  const gRoot = grown.byId("overlay-root");
  const gAt = zoneCentre(grown, "overlay-corner-br");
  grown.fire(grown.byId("overlay-corner-br"), "mousedown", { clientX: gAt.x, clientY: gAt.y });
  grown.fireWindow("mousemove", { clientX: gAt.x + 5000, clientY: gAt.y + 5000 });
  grown.fireWindow("mouseup", { clientX: gAt.x + 5000, clientY: gAt.y + 5000 });
  assert.equal(gRoot.style.width, "1180px", "1280 - 100");
  assert.equal(gRoot.style.height, "640px", "720 - 80");
  assert.equal(gRoot.style.left, "100px");
  assert.equal(gRoot.style.top, "80px");
  assert.deepEqual(grown.posted("twt:overlay-moved").slice(-1), [
    /* a resize keeps the anchor it started with, so the anchored edges (and
     * dx/dy) stay exactly where they were while w/h grow */
    { channel: "caedrel", anchor: "tl", dx: 100, dy: 80, w: 1180, h: 640, done: true },
  ]);

  /* a left-edge drag cannot cross the fixed right edge, so the panel never
   * leaves the video area on the left */
  const left = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(left);
  const lRoot = left.byId("overlay-root");
  const lAt = zoneCentre(left, "overlay-edge-left");
  left.fire(left.byId("overlay-edge-left"), "mousedown", { clientX: lAt.x, clientY: lAt.y });
  left.fireWindow("mousemove", { clientX: lAt.x - 5000, clientY: lAt.y });
  left.fireWindow("mouseup", { clientX: lAt.x - 5000, clientY: lAt.y });
  assert.equal(lRoot.style.left, "0px");
  assert.equal(lRoot.style.width, "400px", "the right edge stays fixed at 400");
  assert.equal(lRoot.style.height, "200px");
  assert.deepEqual(left.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 0, dy: 80, w: 400, h: 200, done: true },
  ]);
});

test("the header starts a move and keeps w/h", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const root = page.byId("overlay-root");
  const at = headerPoint(page);
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: at.x, clientY: at.y });
  page.fireWindow("mousemove", { clientX: at.x + 20, clientY: at.y + 20 });
  page.fireWindow("mouseup", { clientX: at.x + 20, clientY: at.y + 20 });

  assert.equal(root.style.left, "120px");
  assert.equal(root.style.top, "100px");
  assert.equal(root.style.width, "300px", "a move never resizes");
  assert.equal(root.style.height, "200px");
  assert.deepEqual(page.posted("twt:overlay-moved"), [
    { channel: "caedrel", anchor: "tl", dx: 120, dy: 100, w: 300, h: 200 },
    { channel: "caedrel", anchor: "tl", dx: 120, dy: 100, w: 300, h: 200, done: true },
  ]);
});

test("dragging reports continuously, at most once per 100 ms, plus a final one", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  const root = page.byId("overlay-root");
  const drag = page.byId("overlay-header");

  page.fire(drag, "mousedown", { clientX: 500, clientY: 400 });
  assert.equal(page.posted("twt:overlay-moved").length, 0, "nothing before the first move");

  /* the first update of a window goes out immediately */
  page.fireWindow("mousemove", { clientX: 510, clientY: 410 });
  assert.deepEqual(page.posted("twt:overlay-moved"), [
    { channel: "caedrel", anchor: "tl", dx: 110, dy: 90, w: 300, h: 200 },
  ]);
  assert.equal(root.style.left, "110px");

  /* moves inside the 100 ms window are coalesced into the newest geometry */
  page.fireWindow("mousemove", { clientX: 520, clientY: 420 });
  page.fireWindow("mousemove", { clientX: 530, clientY: 430 });
  assert.equal(page.posted("twt:overlay-moved").length, 1, "still inside the window");
  assert.equal(root.style.left, "130px", "but the panel follows every move");

  /* the window ends and sends the newest geometry once */
  page.advanceTimers(100);
  assert.equal(page.posted("twt:overlay-moved").length, 2);
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 130, dy: 110, w: 300, h: 200 },
  ]);

  /* a new window opens: the next move waits for it again */
  page.fireWindow("mousemove", { clientX: 540, clientY: 440 });
  assert.equal(page.posted("twt:overlay-moved").length, 2, "the throttle re-arms");

  page.advanceTimers(100);
  assert.equal(page.posted("twt:overlay-moved").length, 3);
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 140, dy: 120, w: 300, h: 200 },
  ]);

  /* release always sends one final report, and only that one carries done */
  page.fireWindow("mouseup", { clientX: 540, clientY: 440 });
  assert.equal(page.posted("twt:overlay-moved").length, 4, "the release reports finally");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 140, dy: 120, w: 300, h: 200, done: true },
  ]);
  for (const report of page.posted("twt:overlay-moved").slice(0, 3)) {
    assert.equal(report.done, undefined, "an in-gesture report has no done");
  }
  assert.equal(page.pendingTimers(), 0, "no report timer survives the release");
});

test("every move report derives the anchor from the panel's centre", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  const root = page.byId("overlay-root");
  const drag = page.byId("overlay-header");

  page.fire(drag, "mousedown", { clientX: 500, clientY: 400 });
  /* centre (260,190) is left of and above the viewport centre */
  page.fireWindow("mousemove", { clientX: 510, clientY: 410 });
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 110, dy: 90, w: 300, h: 200 },
  ]);

  /* drag to the top-right: the panel's TR corner lands 70 px from the
   * viewport's TR corner */
  page.fireWindow("mousemove", { clientX: 1310, clientY: 400 });
  page.advanceTimers(100);
  assert.equal(root.style.left, "910px");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tr", dx: 70, dy: 80, w: 300, h: 200 },
  ]);
  page.fireWindow("mouseup", { clientX: 1310, clientY: 400 });

  /* drag to the bottom-left */
  page.fire(drag, "mousedown", { clientX: 1000, clientY: 150 });
  page.fireWindow("mousemove", { clientX: -210, clientY: 550 });
  page.advanceTimers(100);
  assert.equal(root.style.left, "0px", "strictly inside the viewport");
  assert.equal(root.style.top, "480px");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "bl", dx: 0, dy: 40, w: 300, h: 200 },
  ]);
  page.fireWindow("mouseup", { clientX: -210, clientY: 550 });

  /* drag to the bottom-right */
  page.fire(drag, "mousedown", { clientX: 150, clientY: 550 });
  page.fireWindow("mousemove", { clientX: 950, clientY: 950 });
  page.advanceTimers(100);
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "br", dx: 180, dy: 0, w: 300, h: 200 },
  ]);
  page.fireWindow("mouseup", { clientX: 950, clientY: 950 });
});

test("a perfectly centred panel keeps its anchor (ties stay put)", () => {
  /* x = (1280 - 300) / 2, y = (720 - 200) / 2: the panel's centre sits exactly
   * on the viewport centre, which the centre line (and the hysteresis margin)
   * leaves on the previous anchor, "tl" */
  const page = laidOutOverlay(anchored("tl", 490, 260, 300, 200));
  const root = page.byId("overlay-root");
  const drag = page.byId("overlay-header");

  page.fire(drag, "mousedown", { clientX: 500, clientY: 400 });
  page.fireWindow("mousemove", { clientX: 500, clientY: 400 });
  page.fireWindow("mouseup", { clientX: 500, clientY: 400 });

  assert.deepEqual(page.posted("twt:overlay-moved"), [
    { channel: "caedrel", anchor: "tl", dx: 490, dy: 260, w: 300, h: 200 },
    { channel: "caedrel", anchor: "tl", dx: 490, dy: 260, w: 300, h: 200, done: true },
  ]);
});

test("a move flips the anchor past the centre + 10% margin, not before", () => {
  /* viewport 1280x720: the margin is 128 px horizontally and 72 px vertically,
   * so the horizontal flip happens at centre x > 768 and the vertical one at
   * centre y > 432 */
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  const root = page.byId("overlay-root");
  const drag = page.byId("overlay-header");

  /* centre x = 640 + 50 = 690: past the viewport centre but inside the
   * margin, so the panel keeps "tl" */
  page.fire(drag, "mousedown", { clientX: 500, clientY: 400 });
  page.fireWindow("mousemove", { clientX: 940, clientY: 400 });   /* x: 100 -> 540 */
  page.advanceTimers(100);
  assert.equal(root.style.left, "540px");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 540, dy: 80, w: 300, h: 200 },
  ], "a small drag past the centre line does not flip the anchor");

  /* the same gesture keeps going past the margin: centre x = 800 > 768 flips
   * the horizontal axis to the right, the vertical stays on top */
  page.fireWindow("mousemove", { clientX: 1050, clientY: 400 });  /* x: 100 -> 650 */
  page.advanceTimers(100);
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tr", dx: 330, dy: 80, w: 300, h: 200 },
  ], "past the margin the anchor flips");

  /* a small vertical overshoot past the centre row keeps "top": centre
   * y = 360 + 30 = 390 < 432 */
  page.fireWindow("mousemove", { clientX: 1050, clientY: 490 });  /* y: 80 -> 170 */
  page.advanceTimers(100);
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tr", dx: 330, dy: 170, w: 300, h: 200 },
  ], "the vertical axis has its own hysteresis");

  /* past the vertical margin (centre y = 470 > 432) it flips to the bottom */
  page.fireWindow("mousemove", { clientX: 1050, clientY: 690 });  /* y: 80 -> 370 */
  page.advanceTimers(100);
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "br", dx: 330, dy: 150, w: 300, h: 200 },
  ]);

  page.fireWindow("mouseup", { clientX: 1050, clientY: 690 });
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "br", dx: 330, dy: 150, w: 300, h: 200, done: true },
  ]);
});

test("the moved payload is anchored, rounded and keeps w/h", () => {
  const page = laidOutOverlay(anchored("tr", 100, 80, 300, 200));
  const root = page.byId("overlay-root");

  page.fire(page.byId("overlay-header"), "mousedown", { clientX: 500, clientY: 400 });
  page.fireWindow("mousemove", { clientX: 513.6, clientY: 417.4 });
  assert.equal(root.style.left, "894px", "880 + 13.6, rounded");
  assert.equal(root.style.top, "97px", "80 + 17.4, rounded");
  assert.equal(root.style.width, "300px", "a move must not resize");
  assert.equal(root.style.height, "200px");
  page.fireWindow("mouseup", { clientX: 513.6, clientY: 417.4 });

  const moved = page.posted("twt:overlay-moved");
  assert.deepEqual(moved, [
    { channel: "caedrel", anchor: "tr", dx: 86, dy: 97, w: 300, h: 200 },
    { channel: "caedrel", anchor: "tr", dx: 86, dy: 97, w: 300, h: 200, done: true },
  ]);
  for (const key of ["dx", "dy", "w", "h"]) {
    assert.equal(Number.isInteger(moved[0][key]), true, key + " is an integer");
  }
  assert.deepEqual(Object.keys(moved[0]).sort(), ["anchor", "channel", "dx", "dy", "h", "w"],
    "an in-gesture report keeps exactly the anchored fields");
  assert.deepEqual(Object.keys(moved[1]).sort(),
    ["anchor", "channel", "done", "dx", "dy", "h", "w"],
    "the final report adds done");
});

test("a legacy {x,y,w,h} layout renders as top-left", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const root = page.byId("overlay-root");

  page.fromPlugin("twt:overlay-layout", layoutMessage({ x: 40, y: 30, w: 360, h: 240 }));
  assert.equal(root.style.left, "40px");
  assert.equal(root.style.top, "30px");
  assert.equal(root.style.width, "360px");
  assert.equal(root.style.height, "240px");

  /* hostile legacy numbers are clamped strictly inside the video area: the
   * panel never leaves it, whatever came in */
  page.fromPlugin("twt:overlay-layout", layoutMessage({ x: -9999, y: -9999, w: 10, h: 10 }));
  assert.equal(root.style.width, "220px");
  assert.equal(root.style.height, "120px");
  assert.equal(root.style.left, "0px");
  assert.equal(root.style.top, "0px");
});

test("dragging is clamped strictly inside the video area", () => {
  const page = laidOutOverlay(anchored("tl", 300, 150, 400, 300));
  const root = page.byId("overlay-root");
  const drag = page.byId("overlay-header");

  page.fire(drag, "mousedown", { clientX: 500, clientY: 400 });
  page.fireWindow("mousemove", { clientX: -5000, clientY: -5000 });
  page.fireWindow("mouseup", { clientX: -5000, clientY: -5000 });
  assert.equal(root.style.left, "0px");
  assert.equal(root.style.top, "0px");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "tl", dx: 0, dy: 0, w: 400, h: 300, done: true },
  ]);

  /* the far corner: the panel parks flush against it and the centre rule
   * reports bottom-right */
  page.fromPlugin("twt:overlay-layout", layoutMessage(anchored("tl", 300, 150, 400, 300)));
  page.fire(drag, "mousedown", { clientX: 500, clientY: 400 });
  page.fireWindow("mousemove", { clientX: 50000, clientY: 50000 });
  page.fireWindow("mouseup", { clientX: 50000, clientY: 50000 });
  assert.equal(root.style.left, "880px", "1280 - 400");
  assert.equal(root.style.top, "420px", "720 - 300");
  assert.deepEqual(page.posted("twt:overlay-moved").slice(-1), [
    { channel: "caedrel", anchor: "br", dx: 0, dy: 0, w: 400, h: 300, done: true },
  ]);
});

test("a viewport resize re-renders without rewriting the stored layout", () => {
  const page = laidOutOverlay(anchored("tr", 10, 20, 400, 300), { width: 1280, height: 720 });
  const root = page.byId("overlay-root");
  assert.equal(root.style.left, "870px");

  page.resize(500, 400);
  assert.equal(root.style.width, "400px");
  assert.equal(root.style.height, "300px");
  assert.equal(root.style.left, "90px", "500 - 10 - 400: the right gap is unchanged");
  assert.equal(root.style.top, "20px", "the top gap is unchanged");

  /* a viewport smaller than the panel clamps every gap to 0 for display only */
  page.resize(300, 200);
  assert.equal(root.style.width, "300px");
  assert.equal(root.style.height, "200px");
  assert.equal(root.style.left, "0px");
  assert.equal(root.style.top, "0px");

  page.resize(1280, 720);
  assert.equal(root.style.width, "400px", "the stored w is restored, not rewritten");
  assert.equal(root.style.height, "300px");
  assert.equal(root.style.left, "870px");
  assert.equal(root.style.top, "20px");
  assert.equal(page.posted("twt:overlay-moved").length, 0, "resizing the viewport is not a gesture");
});

test("the header and the eight zones are hit-testable at rest", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const css = fs.readFileSync(path.join(ROOT, "ui/chat.css"), "utf8");

  /* everything decorative is transparent; only the reacting nodes are
   * interactive, and the panel itself is not (clicks on its gutters reach the
   * video) */
  assert.match(cssRuleBody(css, ".twt-overlay-panel *") || "", /pointer-events:\s*none/);
  for (const selector of [".twt-overlay-panel #overlay-header",
    ".twt-overlay-panel #messages", ".twt-overlay-panel #jump-bottom",
    ".twt-overlay-panel .twt-overlay-zone"]) {
    assert.match(cssRuleBody(css, selector) || "", /pointer-events:\s*auto/, selector);
  }
  for (const body of cssRuleBodies(css, ".twt-overlay-panel")) {
    assert.equal(/pointer-events:\s*auto/.test(body), false, "the panel itself stays transparent");
  }
  assert.equal(page.byId("overlay-panel").pointerEvents, "none", "modelled like the stylesheet");

  /* the nine affordances must be the topmost clickable element at their own
   * geometry, with the catcher disarmed at rest */
  assert.equal(page.byId("overlay-catcher").getAttribute("data-clickable"), null);
  for (const id of AFFORDANCES) {
    const at = id === "overlay-header" ? headerPoint(page) : zoneCentre(page, id);
    assert.equal(page.elementAt(at.x, at.y), page.byId(id), id + " is topmost at its centre");
    assert.equal(page.iinaHit(at.x, at.y), page.byId(id), id + " carries data-clickable");
    assert.equal(page.byId(id).getAttribute("data-clickable"), "");
  }

  /* the list and the chip stay reachable too; a chat row does not block them */
  page.fromPlugin("twt:event", { event: chatEvent("a chat message", []) });
  applyLayoutRects(page);
  const messages = page.byId("messages").rect;
  assert.equal(page.iinaHit(messages.x + 20, messages.y + 30), page.byId("messages"),
    "a point over a chat row resolves to the clickable list");
  /* the chip is conditional (hidden while the list is stuck at the bottom), so
   * its attribute is covered by the interactive-set test; here the list point
   * is what matters */
});

test("the catcher is armed only for the duration of a gesture", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const catcher = page.byId("overlay-catcher");

  assert.equal(catcher.getAttribute("data-clickable"), null, "disarmed at rest");
  assert.equal(catcher.style.display, "none");

  /* a move gesture arms exactly for its duration */
  const at = headerPoint(page);
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: at.x, clientY: at.y });
  assert.equal(catcher.getAttribute("data-clickable"), "", "armed by the gesture");
  assert.equal(catcher.style.display, "block");
  page.fireWindow("mousemove", { clientX: at.x + 10, clientY: at.y });
  assert.equal(catcher.getAttribute("data-clickable"), "", "still armed mid-gesture");
  page.fireWindow("mouseup", { clientX: at.x + 10, clientY: at.y });
  assert.equal(catcher.getAttribute("data-clickable"), null, "disarmed on release");
  assert.equal(catcher.style.display, "none");

  /* the same for a resize, and Escape/blur release it too */
  const zone = zoneCentre(page, "overlay-edge-right");
  page.fire(page.byId("overlay-edge-right"), "mousedown", { clientX: zone.x, clientY: zone.y });
  assert.equal(catcher.getAttribute("data-clickable"), "", "armed by the resize");
  page.key("Escape");
  assert.equal(catcher.getAttribute("data-clickable"), null, "Escape releases the catcher");

  page.fire(page.byId("overlay-edge-right"), "mousedown", { clientX: zone.x, clientY: zone.y });
  assert.equal(catcher.getAttribute("data-clickable"), "");
  page.fireWindow("blur", {});
  assert.equal(catcher.getAttribute("data-clickable"), null, "blur cancels and releases it");
  assert.equal(page.pendingTimers(), 0, "no timer lingers");
});

test("the affordances never change the panel's or the list's geometry", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const panel = page.byId("overlay-panel");
  const messages = page.byId("messages");
  let before = { panel: Object.assign({}, panel.rect), messages: Object.assign({}, messages.rect) };

  const assertUnchanged = (when) => {
    assert.deepEqual(panel.rect, before.panel, "the panel's rect is unchanged " + when);
    assert.deepEqual(messages.rect, before.messages, "the list's rect is unchanged " + when);
    assert.deepEqual(messages.style, {}, "the list carries no inline layout " + when);
  };
  assertUnchanged("at rest");

  /* hover-ish events must not move anything either (there is no hover state) */
  for (const id of AFFORDANCES) {
    page.fire(page.byId(id), "mouseenter", {});
    page.fire(page.byId(id), "mouseover", {});
    page.fire(page.byId(id), "mouseleave", {});
    assertUnchanged("while " + id + " is hovered");
  }

  /* a move: the root's box changes, the panel and list geometry does not */
  const at = headerPoint(page);
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: at.x, clientY: at.y });
  page.fireWindow("mousemove", { clientX: at.x + 30, clientY: at.y + 20 });
  assertUnchanged("during a move");
  page.fireWindow("mouseup", { clientX: at.x + 30, clientY: at.y + 20 });
  assertUnchanged("after a move");

  /* a resize: the same; the move changed the panel's box, so re-baseline */
  applyLayoutRects(page);
  before = { panel: Object.assign({}, panel.rect), messages: Object.assign({}, messages.rect) };
  const zone = zoneCentre(page, "overlay-corner-br");
  page.fire(page.byId("overlay-corner-br"), "mousedown", { clientX: zone.x, clientY: zone.y });
  page.fireWindow("mousemove", { clientX: zone.x - 30, clientY: zone.y - 20 });
  assertUnchanged("during a resize");
  page.fireWindow("mouseup", { clientX: zone.x - 30, clientY: zone.y - 20 });
  assertUnchanged("after a resize");

  /* the zones are absolute inside the panel, so they cannot affect layout */
  const css = fs.readFileSync(path.join(ROOT, "ui/chat.css"), "utf8");
  assert.match(cssRuleBody(css, ".twt-overlay-zone") || "", /position:\s*absolute/);
});

test("no hover or dwell machinery remains in the overlay sources", () => {
  const sources = ["ui/overlay-view.js", "ui/overlay.html", "ui/chat.css"]
    .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"));
  /* split so this test's own source never contains the needles it searches for */
  const needles = ["HOVER" + "_MS", "setHover", "twt-overlay" + "-hover", "hoverDwell" + "Timer",
    "hoverHide" + "Timer", "overlay" + "-drag", "overlay" + "-resize", "panel" + "Centre",
    "entered" + "Panel", "outside" + "Panel"];
  for (const source of sources) {
    for (const needle of needles) {
      assert.equal(source.indexOf(needle), -1, "no " + needle + " remains");
    }
  }
});

test("the resize indicator is CSS-only: zone cursors and corner-over-edge order", () => {
  const css = fs.readFileSync(path.join(ROOT, "ui/chat.css"), "utf8");
  const bandY = cssPx(cssRuleBody(css, ".twt-overlay-edge-top"), "height");
  const bandX = cssPx(cssRuleBody(css, ".twt-overlay-edge-left"), "width");
  const corner = cssPx(cssRuleBody(css, ".twt-overlay-corner"), "width");
  assert.ok(bandY >= 6 && bandY <= 8, "the top/bottom bands are 6-8 px");
  assert.ok(bandX >= 6 && bandX <= 8, "the left/right bands are 6-8 px");
  assert.ok(corner >= 14 && corner <= 16, "the corners are 14-16 px squares");

  const cursors = {
    ".twt-overlay-edge-top": "ns", ".twt-overlay-edge-bottom": "ns",
    ".twt-overlay-edge-left": "ew", ".twt-overlay-edge-right": "ew",
    ".twt-overlay-corner-tl": "nwse", ".twt-overlay-corner-br": "nwse",
    ".twt-overlay-corner-tr": "nesw", ".twt-overlay-corner-bl": "nesw",
  };
  for (const [selector, cursor] of Object.entries(cursors)) {
    assert.match(cssRuleBody(css, selector) || "",
      new RegExp("cursor:\\s*" + cursor + "-resize"), selector + " has its directional cursor");
  }
  assert.match(cssRuleBody(css, "#overlay-header") || "", /cursor:\s*grab/,
    "the header advertises the move cursor");
  assert.match(css, /body\.twt-overlay-moving[^{]*\{[^}]*cursor:\s*grabbing/,
    "and grabbing while the move runs");

  /* the zones are invisible hit areas: no background and no opacity wash in
   * any state - the affordance is the resize cursor only */
  assert.doesNotMatch(css, /\.twt-overlay-zone:hover,[^{]*\.twt-overlay-zone\.twt-overlay-zone-active\s*\{[^}]*opacity/,
    "there is no hovered/active wash to paint the zones");
  const zoneBody = cssRuleBody(css, ".twt-overlay-zone") || "";
  assert.doesNotMatch(zoneBody, /background|opacity/,
    "the zone itself paints nothing (no background, no opacity)");
  assert.match(zoneBody, /position:\s*absolute/);

  /* z-order: corners above edges, edges above the content, catcher above all
   * only while a gesture runs */
  const cornerZ = cssZ(cssRuleBody(css, ".twt-overlay-corner"));
  const zoneZ = cssZ(cssRuleBody(css, ".twt-overlay-zone"));
  assert.ok(cornerZ > zoneZ, "corners win where they overlap an edge");
  assert.equal(cssZFor(css, ".twt-overlay-catcher"), 30, "the catcher keeps z-index 30");
});

test("the header, the eight zones and the list are the interactive set", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page.fromPlugin("twt:overlay-layout", layoutMessage(anchored("tl", 40, 30, 360, 240)));

  const marked = page.find("[data-clickable]");
  const expected = ["overlay-header", "messages", "jump-bottom"].concat(
    AFFORDANCES.filter((id) => id !== "overlay-header"));
  for (const id of expected) {
    assert.equal(marked.includes(page.byId(id)), true, id + " is hit-testable at rest");
    assert.equal(page.byId(id).getAttribute("data-clickable"), "");
  }
  assert.equal(marked.length, expected.length, "only those nodes are marked");
  for (const element of [page.byId("overlay-root"), page.byId("overlay-panel"),
    page.byId("overlay-catcher"), page.byId("status-dot")]) {
    assert.equal(element.getAttribute("data-clickable"), null, "everything else stays click-through");
  }

  /* wheel/pointer events reach the list and the CSS keeps the scroll inside it */
  const css = fs.readFileSync(path.join(ROOT, "ui/chat.css"), "utf8");
  assert.match(css, /\.twt-messages\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.twt-overlay-panel \.twt-messages\s*\{[^}]*overscroll-behavior:\s*contain/s);
});

test("Escape finalises the gesture and releases the catcher", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const root = page.byId("overlay-root");

  const at = headerPoint(page);
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: at.x, clientY: at.y });
  page.fireWindow("mousemove", { clientX: at.x + 20, clientY: at.y + 20 });
  page.key("Escape");

  /* one in-gesture report, then the Escape-finalised report with done */
  assert.deepEqual(page.posted("twt:overlay-moved"), [
    { channel: "caedrel", anchor: "tl", dx: 120, dy: 100, w: 300, h: 200 },
    { channel: "caedrel", anchor: "tl", dx: 120, dy: 100, w: 300, h: 200, done: true },
  ]);
  assert.deepEqual(page.sent.map((entry) => entry.name).slice(-1),
    ["twt:overlay-moved"], "Escape posts nothing but the final report");
  assert.equal(page.byId("overlay-catcher").getAttribute("data-clickable"), null);
  assert.equal(page.byId("overlay-catcher").style.display, "none");
  assert.equal(page.pendingTimers(), 0, "no report timer survives Escape");

  /* a second Escape is inert, and the affordances stay put (nothing is hidden) */
  const afterEscape = page.posted("twt:overlay-moved").length;
  page.key("Escape");
  assert.equal(page.posted("twt:overlay-moved").length, afterEscape, "a second Escape is inert");
  for (const id of AFFORDANCES) {
    assert.equal(page.byId(id).getAttribute("data-clickable"), "", id + " stays available");
  }
  assert.equal(root.style.left, "120px", "and the layout is left alone");
});

test("a release outside the panel ends the gesture and the catcher never persists", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const root = page.byId("overlay-root");
  const catcher = page.byId("overlay-catcher");

  const at = headerPoint(page);
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: at.x, clientY: at.y });
  assert.equal(catcher.getAttribute("data-clickable"), "", "the catcher is armed");
  assert.equal(page.iinaHit(900, 500), catcher,
    "during the gesture the catcher is the topmost hit-testable element everywhere");
  page.fireWindow("mousemove", { clientX: at.x + 20, clientY: at.y + 20 });
  page.fireWindow("mouseup", { clientX: 1200, clientY: 700 });

  assert.equal(catcher.getAttribute("data-clickable"), null,
    "the catcher is disarmed immediately on release");
  assert.equal(catcher.style.display, "none");
  assert.equal(root.style.left, "120px", "the move the gesture reached is applied");
  assert.equal(page.pendingTimers(), 0, "no timer persists");
  assert.equal(page.iinaHit(900, 500), null, "nothing outside the panel is hit-testable at rest");
  assert.equal(page.iinaHit(200, 150), page.byId("messages"),
    "the list itself stays hit-testable for scrolling");
});

test("blur cancels a gesture and releases the catcher", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const root = page.byId("overlay-root");
  const catcher = page.byId("overlay-catcher");

  const at = headerPoint(page);
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: at.x, clientY: at.y });
  page.fireWindow("mousemove", { clientX: at.x + 30, clientY: at.y + 30 });
  page.fireWindow("blur", {});

  assert.equal(page.posted("twt:overlay-moved").length, 1, "the in-flight report stays");
  assert.equal(page.pendingTimers(), 0, "no timer is left behind");
  assert.equal(catcher.getAttribute("data-clickable"), null);
  assert.equal(catcher.style.display, "none");
  assert.equal(root.style.left, "130px", "the geometry the gesture reached stays applied");
});

test("a resize starts at the zone's real centre and changes only that edge", () => {
  const page = laidOutOverlay(anchored("tl", 100, 80, 300, 200));
  applyLayoutRects(page);
  const root = page.byId("overlay-root");
  const panel = page.byId("overlay-panel");
  const zone = page.byId("overlay-corner-br");

  /* the pointer starts where the zone actually is, not at a guessed point */
  const at = zoneCentre(page, "overlay-corner-br");
  assert.equal(page.elementAt(at.x, at.y), zone, "the topmost element there is the zone");
  page.fire(zone, "mousedown", { clientX: at.x, clientY: at.y });
  page.fireWindow("mousemove", { clientX: at.x + 40, clientY: at.y + 30 });
  page.fireWindow("mouseup", { clientX: at.x + 40, clientY: at.y + 30 });

  assert.equal(root.style.width, "340px");
  assert.equal(root.style.height, "230px");
  assert.equal(root.style.left, "100px", "the opposite edges stay put");
  assert.equal(root.style.top, "80px");
  assert.deepEqual(page.posted("twt:overlay-moved"), [
    { channel: "caedrel", anchor: "tl", dx: 100, dy: 80, w: 340, h: 230 },
    { channel: "caedrel", anchor: "tl", dx: 100, dy: 80, w: 340, h: 230, done: true },
  ]);

  /* every zone sits entirely inside the panel so it can never be clipped out
   * of the hit test; the br zone is flush with the panel's bottom-right */
  for (const id of AFFORDANCES) {
    const rect = page.byId(id).rect;
    assert.equal(rect.x >= panel.rect.x, true, id + " is inside the panel horizontally");
    assert.equal(rect.y >= panel.rect.y, true, id + " is inside the panel vertically");
    assert.equal(rect.x + rect.w <= panel.rect.x + panel.rect.w, true);
    assert.equal(rect.y + rect.h <= panel.rect.y + panel.rect.h, true);
  }
  assert.equal(zone.rect.x + zone.rect.w, panel.rect.x + panel.rect.w,
    "the br corner is flush with the panel's right edge");
  assert.equal(zone.rect.y + zone.rect.h, panel.rect.y + panel.rect.h,
    "and with its bottom edge");
});

test("a null layout restores the stylesheet default", () => {
  const page = laidOutOverlay(anchored("tl", 40, 30, 360, 240));
  const root = page.byId("overlay-root");
  assert.equal(root.style.left, "40px");

  page.fromPlugin("twt:overlay-layout", layoutMessage(null));
  assert.equal(root.style.left, "");
  assert.equal(root.style.top, "");
  assert.equal(root.style.width, "");
  assert.equal(root.style.height, "");
  assert.equal(root.style.right, "", "the right anchor of the stylesheet is back in charge");
  assert.equal(root.style.bottom, "");
  assert.equal(root.style.maxWidth, "");
  assert.equal(root.style.display, undefined, "no other inline style is left behind");

  /* with no layout to work from, and no layout engine in this DOM, a drag must
   * not invent one (the web view would measure the stylesheet box first) */
  page.fire(page.byId("overlay-header"), "mousedown", { clientX: 10, clientY: 10 });
  page.fireWindow("mousemove", { clientX: 300, clientY: 300 });
  page.fireWindow("mouseup", { clientX: 300, clientY: 300 });
  assert.deepEqual(page.posted("twt:overlay-moved"), []);
  assert.equal(root.style.left, "");
});

/* ------------------------------------------- overlay scrolling and autoscroll
 *
 * The overlay list is a real scroll container (`overflow-y: auto`, wheel events
 * reach it because it carries data-clickable). The view keeps an explicit
 * `stick` state: only a real user scroll updates it, appends follow it, and
 * history prepends preserve a reader who is away from the bottom. The fake DOM
 * has no layout engine, so these tests model scrollHeight from the child count
 * and drive wheel/scroll events the way the browser would.
 */

function scrollableList(page, options) {
  const opts = options || {};
  const list = page.byId("messages");
  const base = opts.base === undefined ? 100 : opts.base;
  const rowHeight = opts.rowHeight === undefined ? 30 : opts.rowHeight;
  list.clientHeight = opts.clientHeight === undefined ? 200 : opts.clientHeight;
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    get: () => base + list.children.length * rowHeight,
  });
  return list;
}

/* A real wheel/trackpad gesture: the page consumes the wheel, the browser
 * applies the resulting offset, then fires scroll. */
function userScroll(page, top) {
  const list = page.byId("messages");
  const wheel = page.fire(list, "wheel", { deltaY: top < list.scrollTop ? -120 : 120, deltaMode: 0 });
  assert.equal(wheel.defaultPrevented, true, "the page owns the wheel");
  list.scrollTop = top;
  page.fire(list, "scroll", {});
  return list;
}

function addOverlayEvents(page, count, makeEvent) {
  for (let i = 0; i < count; i++) {
    page.fromPlugin("twt:event", { event: makeEvent(i) });
  }
}

test("autoscroll sticks to the bottom until a real scroll leaves it", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page);
  const chip = page.byId("jump-bottom");

  addOverlayEvents(page, 10, (i) => chatEvent("row " + i, []));
  assert.equal(page.rows().length, 10);
  assert.equal(list.scrollTop, list.scrollHeight, "the default stick follows appended rows");
  assert.equal(chip.hidden, true, "the chip stays hidden while stuck");

  /* the echo of our own scroll write carries the value we just set, so the
   * scroll listener recognises it as programmatic and leaves stick alone */
  page.fire(list, "scroll", {});
  assert.equal(chip.hidden, true, "programmatic scroll echoes are ignored");

  userScroll(page, 0);
  assert.equal(chip.hidden, false, "leaving the bottom shows the chip");
  assert.equal(chip.textContent, "Jump to latest");

  const away = list.scrollTop;
  addOverlayEvents(page, 1, () => chatEvent("away", []));
  assert.equal(list.scrollTop, away, "a reader away from the bottom is not dragged down");
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, "1 new message");

  userScroll(page, list.scrollHeight - list.clientHeight);
  assert.equal(chip.hidden, true, "reaching the bottom re-sticks");
  addOverlayEvents(page, 1, () => chatEvent("back", []));
  assert.equal(list.scrollTop, list.scrollHeight);
});

test("the jump chip appears only away from the bottom and hides on click", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page);
  const chip = page.byId("jump-bottom");

  addOverlayEvents(page, 5, (i) => chatEvent("row " + i, []));
  assert.equal(chip.hidden, true);

  userScroll(page, list.scrollHeight - list.clientHeight - 24);
  assert.equal(chip.hidden, true, "24 px from the bottom still counts as stuck");

  userScroll(page, list.scrollHeight - list.clientHeight - 25);
  assert.equal(chip.hidden, false, "25 px away breaks stick");
  assert.equal(chip.textContent, "Jump to latest");

  page.fire(chip, "click", {});
  assert.equal(chip.hidden, true, "clicking the chip re-sticks");
  assert.equal(list.scrollTop, list.scrollHeight);

  assert.equal(chip.getAttribute("data-clickable"), "", "the chip itself is hit-testable");
});

test("history prepends preserve a reader's position and never flip stick", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page);
  const chip = page.byId("jump-bottom");

  addOverlayEvents(page, 9, (i) => chatEvent("live " + i, []));
  userScroll(page, 0);
  assert.equal(chip.hidden, false);

  const top = list.scrollTop;
  const beforeHeight = list.scrollHeight;
  page.fromPlugin("twt:history-result", {
    ok: true,
    channel: "caedrel",
    messages: [{
      id: "h1", login: "old", displayName: "Old", text: "older message",
      emotes: [], badges: [], timestamp: Date.now() - 60000,
    }],
  });

  assert.equal(list.scrollTop, top + (list.scrollHeight - beforeHeight),
    "the prepended rows are added above the reader, not under them");
  assert.equal(chip.hidden, false, "history prepends do not flip stick");
  page.fire(list, "scroll", {});
  assert.equal(chip.hidden, false, "the programmatic adjustment is not a user scroll");

  const parked = list.scrollTop;
  addOverlayEvents(page, 1, () => chatEvent("new live", []));
  assert.equal(list.scrollTop, parked, "live rows do not move a non-sticky reader");
  assert.equal(chip.textContent, "1 new message");

  /* a sticky reader stays pinned across the same prepend */
  userScroll(page, list.scrollHeight - list.clientHeight);
  assert.equal(chip.hidden, true);
  const bottom = list.scrollTop;
  page.fromPlugin("twt:history-result", {
    ok: true,
    channel: "caedrel",
    messages: [{
      id: "h2", login: "older", displayName: "Older", text: "even older",
      emotes: [], badges: [], timestamp: Date.now() - 120000,
    }],
  });
  assert.equal(list.scrollTop, list.scrollHeight, "a sticky reader stays at the bottom");
  assert.equal(bottom < list.scrollTop, true, "the list grew above the reader");
  assert.equal(chip.hidden, true);
});

test("a burst of events renders immediately, in order, without timers", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page, { rowHeight: 100 });
  const chip = page.byId("jump-bottom");
  const timers = page.timerCount();

  page.fromPlugin("twt:event", { event: chatEvent("one", []) });
  page.fromPlugin("twt:event", { event: chatEvent("two", []) });
  page.fromPlugin("twt:event", { event: chatEvent("three", []) });

  assert.equal(page.rows().length, 3, "a burst lands in the DOM in the same task");
  assert.deepEqual(page.rows().map((row) => row.textContent), ["one", "two", "three"]);
  assert.equal(page.timerCount(), timers, "addEvent schedules nothing");
  assert.equal(list.scrollTop, list.scrollHeight, "a sticky reader follows each append");
  assert.equal(chip.hidden, true);

  userScroll(page, 0);
  assert.equal(chip.hidden, false, "the reader scrolled away");

  page.fromPlugin("twt:event", { event: replayEvent("vod four", [], 40) });
  page.fromPlugin("twt:event", { event: replayEvent("vod five", [], 50) });
  assert.equal(page.rows().length, 5, "VOD replay renders immediately too");
  assert.equal(list.scrollTop, 0, "a non-sticky reader is not dragged by the burst");
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, "2 new messages");
  assert.equal(page.rows().slice(3).every((row) => row.className.includes("twt-replay")), true);
  assert.equal(page.timerCount(), timers, "the whole render path stays timer-free");
});

test("the wheel scrolls the chat list directly and drives stick", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page);
  const chip = page.byId("jump-bottom");

  addOverlayEvents(page, 10, (i) => chatEvent("row " + i, []));
  list.scrollTop = list.scrollHeight - list.clientHeight;
  page.fire(list, "scroll", {});
  assert.equal(chip.hidden, true, "start at the bottom, stuck");

  const up = page.fire(list, "wheel", { deltaY: -120, deltaMode: 0 });
  assert.equal(up.defaultPrevented, true, "the page owns the wheel so the video does not");
  assert.equal(list.scrollTop, list.scrollHeight - list.clientHeight - 120,
    "scrollTop moves by deltaY");
  assert.equal(chip.hidden, false, "wheel away from the bottom unsticks");
  assert.equal(chip.textContent, "Jump to latest");

  const down = page.fire(list, "wheel", { deltaY: 120, deltaMode: 0 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(list.scrollTop, list.scrollHeight - list.clientHeight);
  assert.equal(chip.hidden, true, "wheel back to the bottom re-sticks");
});

test("wheel deltaMode is normalised and the panel delegates to the list", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page, { rowHeight: 100 });
  const panel = page.byId("overlay-panel");

  addOverlayEvents(page, 5, (i) => chatEvent("row " + i, []));

  list.scrollTop = 0;
  const line = page.fire(list, "wheel", { deltaY: 3, deltaMode: 1 });
  assert.equal(line.defaultPrevented, true);
  assert.equal(list.scrollTop, 48, "3 lines x 16 px");

  list.scrollTop = 0;
  const pages = page.fire(list, "wheel", { deltaY: 1, deltaMode: 2 });
  assert.equal(pages.defaultPrevented, true);
  assert.equal(list.scrollTop, list.clientHeight, "one page = one viewport");

  list.scrollTop = 0;
  const delegated = page.fire(panel, "wheel", { deltaY: 50, deltaMode: 0 });
  assert.equal(delegated.defaultPrevented, true);
  assert.equal(list.scrollTop, 50, "the panel scrolls the list");

  /* once the list has handled a wheel, its bubble to the panel must not double
   * the scroll (the list marks the event) */
  const bubbled = domEvent("wheel", { deltaY: 70, deltaMode: 0 });
  bubbled.__twtWheelHandled = true;
  panel.dispatchEvent(bubbled);
  assert.equal(bubbled.defaultPrevented, false, "the panel leaves a handled event alone");
  assert.equal(list.scrollTop, 50);
});

test("the wheel over the panel is captured and nothing outside is", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  const list = scrollableList(page);

  addOverlayEvents(page, 3, (i) => chatEvent("row " + i, []));

  /* the active nodes carry data-clickable while visible; nothing else does,
   * so IINA's hit test never routes a wheel or click from the video to us */
  assert.equal(page.byId("overlay-header").getAttribute("data-clickable"), "");
  assert.equal(page.byId("messages").getAttribute("data-clickable"), "");
  assert.equal(page.byId("jump-bottom").getAttribute("data-clickable"), "");
  for (const id of AFFORDANCES) {
    assert.equal(page.byId(id).getAttribute("data-clickable"), "", id);
  }
  for (const element of [page.byId("overlay-root"), page.byId("overlay-panel"),
    page.byId("overlay-catcher"), page.byId("status-dot")]) {
    assert.equal(element.getAttribute("data-clickable"), null, "everything else is click-through");
  }

  const before = list.scrollTop;
  const outside = page.fire(page.byId("overlay-root"), "wheel", { deltaY: 120, deltaMode: 0 });
  assert.equal(outside.defaultPrevented, false, "the overlay does not consume a wheel outside the panel");
  assert.equal(list.scrollTop, before, "and the chat does not scroll");
});

/* --------------------------------------------- passive overlay regression
 *
 * The overlay is a passive chat display. The panel and its list are
 * hit-testable so wheel/pointer input reaches the chat (which means a click
 * inside the panel no longer reaches the video: the accepted trade-off for
 * scrollable chat), while nothing outside the panel is marked, so those clicks
 * still go to the video. The only control is the conditional jump chip; the
 * move/resize affordances are always in the overlay but stay invisible until
 * the panel is hovered (they are styled / armed at runtime). The sidebar
 * keeps its own controls; ui/transport.js and ui/sidebar.html are its concern.
 */

test("the overlay markup stays passive apart from the jump chip", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui/overlay.html"), "utf8");
  /* the comments explain the hit-test mechanism; the markup stays declarative */
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  const buttons = markup.match(/<button/g) || [];
  assert.equal(buttons.length, 1, "only the jump chip is a control");
  assert.equal(markup.indexOf("overlay-lock"), -1, "no lock element exists anywhere");
  assert.match(markup, /id="jump-bottom"/);
  for (const tag of ["<input", "<select", "<textarea"]) {
    assert.equal(markup.indexOf(tag), -1, "overlay.html must not contain " + tag);
  }
  assert.equal(markup.indexOf("data-clickable"), -1,
    "clickability is armed at runtime so IINA hit tests only overlay-owned nodes");
  assert.equal(markup.indexOf("contenteditable"), -1, "overlay.html must not be editable");

  /* the move and resize affordances are always in the markup; they carry no
   * tab index and no button semantics, so they stay invisible to a11y */
  assert.match(markup, /id="overlay-header" class="twt-header"/);
  assert.equal(markup.indexOf("overlay-drag"), -1, "the old drag bar is gone");
  assert.equal(markup.indexOf("overlay-resize"), -1, "the old resize handle is gone");
  for (const zone of ["top", "right", "bottom", "left", "tl", "tr", "bl", "br"]) {
    assert.match(markup, new RegExp('id="overlay-(?:edge|corner)-' + zone + '"'));
  }
  assert.equal((markup.match(/data-dir=/g) || []).length, 8,
    "four edges and four corners are resize zones");
});

test("the overlay view wires the layout gestures and no chat controls", () => {
  const source = fs.readFileSync(path.join(ROOT, "ui/overlay-view.js"), "utf8");
  for (const name of ["twt:say", "twt:join", "twt:input-focus"]) {
    assert.equal(source.indexOf(name), -1, "overlay-view.js must not touch " + name);
  }
  assert.equal(source.indexOf("contenteditable"), -1, "overlay-view.js must not make anything editable");
  /* mousedown starts a gesture, wheel scrolls the list; the rest is
   * window-level state */
  const listeners = new Set([...source.matchAll(/addEventListener\(\s*"([\w:-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...listeners].sort(),
    ["blur", "keydown", "mousedown",
      "mousemove", "mouseup", "resize", "wheel"]);
});

test("the passive overlay still renders events and clears them", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  page.fromPlugin("twt:event", { event: chatEvent("hello world", []) });
  assert.equal(page.rows().length, 1);
  assert.equal(page.text(), "hello world");
  page.fromPlugin("twt:clear", { channel: "thebausffs" });
  assert.equal(page.rows().length, 0);
  assert.equal(page.text(), "");
});

/* ------------------------------------------------ VOD chat replay in the UI
 *
 * main.js labels the mode with vodReplay + channelNote and stamps replayed
 * events with replay:true and offsetSeconds. The overlay stays passive: the
 * header says which conversation is on screen, and a replayed row carries a
 * muted offset and a VOD chip. Everything else renders exactly like live chat.
 */

test("the overlay labels VOD replay and marks replayed rows only", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", Object.assign({}, OVERLAY_SETTINGS, {
    vodReplay: true,
    channelNote: "VOD chat replay",
    channelSource: "video",
  }));
  assert.equal(page.byId("header-channel").textContent, "#caedrel (VOD chat replay)");
  assert.equal(page.byId("header-channel").hidden, false);

  page.fromPlugin("twt:event", { event: replayEvent("replayed hello", [], 83) });
  page.fromPlugin("twt:event", { event: chatEvent("live hello", []) });

  const rows = page.rows();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].classList.contains("twt-replay"));
  assert.equal(rows[0].getAttribute("data-replay"), "true");
  assert.equal(rows[0].className.includes("twt-mention"), false);

  const chips = page.find('[data-role="vod-chip"]');
  assert.equal(chips.length, 1, "only the replayed row gets the chip");
  assert.equal(chips[0].textContent, "VOD");
  const offsets = page.find('[data-role="vod-offset"]');
  assert.equal(offsets.length, 1, "only the replayed row gets the offset");
  assert.equal(offsets[0].textContent, "1:23");
  assert.equal(rows[0].textContent, "1:23VODreplayed hello");

  /* the live row keeps today's rendering: no replay class, chip or offset */
  assert.equal(rows[1].classList.contains("twt-replay"), false);
  assert.equal(rows[1].getAttribute("data-replay"), null);
  assert.equal(rows[1].textContent, "live hello");
  assert.equal(page.find('[data-role="vod-offset"]').length, 1);
});

test("twt:state carries the replay label and switching it off restores the plain line", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", OVERLAY_SETTINGS);
  assert.equal(page.byId("header-channel").textContent, "#caedrel");

  page.fromPlugin("twt:state", {
    state: "connected",
    channel: "caedrel",
    vodReplay: true,
    channelNote: "VOD chat replay",
  });
  assert.equal(page.byId("header-channel").textContent, "#caedrel (VOD chat replay)");

  /* leaving VOD mode (main.js broadcasts vodReplay:false) returns the line */
  page.fromPlugin("twt:state", {
    state: "connected",
    channel: "caedrel",
    vodReplay: false,
    channelNote: "",
  });
  assert.equal(page.byId("header-channel").textContent, "#caedrel");
  assert.equal(page.byId("status-text").textContent, "read-only");
});

test("replayed messages still render emotes, badges and the VOD offset", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", {
    settings: { chat: {
      twitchEmotes: true, usernameShown: true, badges: true,
      showDatetimes: true, datetimeFormat: "%H:%M:%S",
    } },
    currentChannel: "caedrel",
    vodReplay: true,
    channelNote: "VOD chat replay",
  });
  page.fromPlugin("twt:emotes", { index: providerIndex() });

  const event = replayEvent("hi o7 xdd Kappa", [{ id: "25", ranges: [[10, 14]] }], 3725);
  event.badges = [{ name: "subscriber", version: "6" }];
  event.timestamp = Date.UTC(2024, 0, 2, 3, 4, 5);
  page.fromPlugin("twt:event", { event });

  const row = page.rows()[0];
  assert.ok(row.classList.contains("twt-replay"));
  assert.equal(page.find('[data-role="vod-offset"]')[0].textContent, "1:02:05");

  const images = page.images();
  assert.deepEqual(images.map((img) => img.alt), ["subscriber", "o7", "xdd", "Kappa"]);
  assert.equal(images[0].className, "twt-badge");
  assert.deepEqual(images.slice(1).map((img) => img.src), [
    O7_URL,
    XDD_URL,
    "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
  ]);
  assert.ok(page.rendered().endsWith("Someone:hi o7 xdd Kappa"), "text, name and emote alts survive");

  /* one time per row, and it is the VOD offset: the timestamp main.js stamps
   * on a replayed event is the replay moment, not the comment's */
  assert.equal(row.children.some((node) => node.className === "twt-time"), false,
    "a replayed row prints no wall clock");
  assert.equal(row.children.filter((node) => /twt-vod-offset/.test(node.className)).length, 1);
  assert.equal(row.children.some((node) => node.className === "twt-name" && node.textContent === "Someone"), true);
});

test("a replayed row shows exactly one time: the original VOD offset", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", {
    settings: { chat: { twtEmotes: true, usernameShown: true, badges: false,
      showDatetimes: true, datetimeFormat: "%H:%M:%S" } },
    currentChannel: "caedrel",
    vodReplay: true,
    channelNote: "VOD chat replay",
  });

  /* what main.js emits for a replayed comment: offsetSeconds is where the
   * comment sat in the VOD, timestamp is the moment the replay ran (Date.now
   * in main.js) - the value the user saw printed on every row */
  const event = replayEvent("hello from the past", [], 618);
  event.timestamp = Date.UTC(2024, 0, 2, 22, 43, 55);
  page.fromPlugin("twt:event", { event });

  const row = page.rows()[0];
  const times = row.children.filter((node) => /(^|\s)(twt-time|twt-vod-offset)(\s|$)/.test(node.className));
  assert.equal(times.length, 1, "a replayed row must carry exactly one time");
  assert.equal(times[0].className, "twt-vod-offset");
  assert.equal(times[0].textContent, "10:18", "the surviving time is the VOD offset");
  assert.equal(row.children.some((node) => node.className === "twt-time"), false,
    "the replay-moment wall clock must not be rendered");
  assert.equal(row.children.some((node) => node.className.includes("twt-vod-chip")), true,
    "the VOD badge still marks the row");
});

test("a live row keeps exactly one time: its own", () => {
  const page = openOverlay();
  page.fromPlugin("twt:settings", {
    settings: { chat: { twtEmotes: true, usernameShown: true, badges: false,
      showDatetimes: true, datetimeFormat: "%H:%M:%S" } },
    currentChannel: "caedrel",
  });

  const event = chatEvent("live message", []);
  event.timestamp = Date.UTC(2024, 0, 2, 22, 43, 55);
  page.fromPlugin("twt:event", { event });

  const row = page.rows()[0];
  const times = row.children.filter((node) => /(^|\s)(twt-time|twt-vod-offset)(\s|$)/.test(node.className));
  assert.equal(times.length, 1, "a live row carries exactly one time");
  assert.equal(times[0].className, "twt-time");
  /* formatTime renders the timestamp through strftime in the local zone, so the
   * expected string is built from the same Date the same way */
  const at = new Date(event.timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  assert.equal(times[0].textContent,
    pad(at.getHours()) + ":" + pad(at.getMinutes()) + ":" + pad(at.getSeconds()),
    "and it is the message's own timestamp");
});

test("a VOD with no channel fetches by the creator id and its emotes render", async () => {
  const page = openSidebar();
  page.fromPlugin("twt:settings", {
    settings: sidebarSettings({ seventvEmotes: true }),
    token: { available: false },
    channel: "",
    currentChannel: "",
    vodReplay: true,
    vodOwnerId: "93869876",
  });

  /* No ROOMSTATE, no IRC join: the owner id alone must start the fetch. */
  const requests = page.posted("twt:http-get");
  assert.deepEqual(requests.map((entry) => entry.url).sort(), [
    "https://7tv.io/v3/emote-sets/global",
    "https://7tv.io/v3/users/twitch/93869876",
  ], "the global and the channel set, keyed by the creator id");

  const answer = async (match, file) => {
    const request = page.posted("twt:http-get").filter((entry) => entry.url.indexOf(match) !== -1).pop();
    assert.ok(request, "expected a provider request for " + match);
    page.fromPlugin("twt:http-result", {
      id: request.id, ok: true, status: 200,
      text: JSON.stringify(fixture(file)),
    });
    await tick();
  };
  await answer("/emote-sets/global", "emotes-7tv-global.json");
  await answer("/users/twitch/93869876", "emotes-7tv-channel-thebausffs.json");

  const index = page.posted("twt:emotes").pop().index;
  assert.equal(index.o7, "https://cdn.7tv.app/emote/01HBFQCZ6R000EE79BCJA0TXN2/2x.webp");
  assert.equal(index.ta, "https://cdn.7tv.app/emote/01J9RAE09G000E6PR9GTQ931HH/2x.webp");
  assert.equal(index.reckH, "https://cdn.7tv.app/emote/01FGH8NE3800064MEQW00DNBNG/2x.webp",
    "the global set is merged with the channel set");

  const overlay = openOverlay();
  overlay.fromPlugin("twt:settings", Object.assign({}, OVERLAY_SETTINGS, {
    currentChannel: "",
    vodReplay: true,
    channelNote: "VOD chat replay",
  }));
  overlay.fromPlugin("twt:emotes", { index });
  overlay.fromPlugin("twt:event", { event: replayEvent("o7 ta", [], 10) });
  const images = overlay.images();
  assert.deepEqual(images.map((img) => img.alt), ["o7", "ta"], "the rendered nodes are emote images");
  assert.equal(images[0].className, "twt-emote");
  assert.equal(images[0].src, index.o7);
  assert.ok(overlay.rendered().endsWith("o7 ta"), "text and emote alts survive the render");

  /* Twitch-native emote tags still take the CDN fallback. */
  overlay.fromPlugin("twt:event", { event: replayEvent("Kappa", [{ id: "25", ranges: [[0, 4]] }], 11) });
  assert.equal(overlay.images().pop().src,
    "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0");
});

test("switching the effective emote id drops the old channel but keeps the globals", async () => {
  const page = openSidebar();
  const settings = sidebarSettings({ seventvEmotes: true });
  page.fromPlugin("twt:settings", {
    settings, token: { available: false }, channel: "", currentChannel: "",
    vodReplay: true, vodOwnerId: "93869876",
  });
  const answer = async (match, file) => {
    const request = page.posted("twt:http-get").filter((entry) => entry.url.indexOf(match) !== -1).pop();
    assert.ok(request, "expected a provider request for " + match);
    page.fromPlugin("twt:http-result", {
      id: request.id, ok: true, status: 200,
      text: JSON.stringify(fixture(file)),
    });
    await tick();
  };
  await answer("/emote-sets/global", "emotes-7tv-global.json");
  await answer("/users/twitch/93869876", "emotes-7tv-channel-thebausffs.json");
  const first = page.posted("twt:emotes").pop().index;
  assert.equal(first.frfr, "https://cdn.7tv.app/emote/01HZ7B6QH0000A5M5H6B6H6B6H/2x.webp");

  /* VOD A -> VOD B: the old channel's names must go, the globals must stay. */
  page.fromPlugin("twt:settings", {
    settings, token: { available: false }, channel: "", currentChannel: "",
    vodReplay: true, vodOwnerId: "92038375",
  });
  const cleared = page.posted("twt:emotes").pop().index;
  assert.equal(cleared.frfr, undefined, "VOD A's channel emote is dropped");
  assert.equal(cleared.ta, undefined, "VOD A's other channel emote is dropped");
  assert.equal(cleared.reckH, "https://cdn.7tv.app/emote/01FGH8NE3800064MEQW00DNBNG/2x.webp",
    "the 7TV global set survives the switch");
  await answer("/users/twitch/92038375", "emotes-7tv-channel.json");
  const second = page.posted("twt:emotes").pop().index;
  assert.equal(second.xdd, "https://cdn.7tv.app/emote/01FF3R5C30000FF5VVCKV49G6J/2x.webp");
  assert.equal(second.frfr, undefined, "VOD B cannot render VOD A's name");
  assert.equal(second.reckH, cleared.reckH, "the global is still present");

  const overlay = openOverlay();
  overlay.fromPlugin("twt:settings", Object.assign({}, OVERLAY_SETTINGS, {
    currentChannel: "", vodReplay: true, channelNote: "VOD chat replay",
  }));
  overlay.fromPlugin("twt:emotes", { index: second });
  overlay.fromPlugin("twt:event", { event: replayEvent("frfr xdd reckH", [], 12) });
  assert.deepEqual(overlay.images().map((img) => img.alt), ["xdd", "reckH"],
    "VOD A's frfr stays text; VOD B's xdd and the global render");

  /* VOD -> live: the live channel's id is used again and the channel URL is
   * refetched because the switch cleared its one-shot fetch flag. */
  page.fromPlugin("twt:settings", {
    settings, token: { available: false }, channel: "caedrel", currentChannel: "caedrel",
    vodReplay: false, vodOwnerId: null,
  });
  page.fromPlugin("twt:command", { command: "connect", channel: "caedrel" });
  page.line(roomState("caedrel", "92038375"));
  const liveRequest = page.posted("twt:http-get").filter((entry) => entry.url.indexOf("/users/twitch/92038375") !== -1).pop();
  page.fromPlugin("twt:http-result", {
    id: liveRequest.id, ok: true, status: 200,
    text: JSON.stringify(fixture("emotes-7tv-channel.json")),
  });
  await tick();
  const live = page.posted("twt:emotes").pop().index;
  assert.equal(live.xdd, second.xdd, "the live channel index is rebuilt");
  assert.equal(live.frfr, undefined, "the VOD channel's names never reach live chat");
  assert.equal(live.reckH, second.reckH, "globals still survive going back to live");
});

/* ------------------------------- adversarial review: per-tab state, races, art
 *
 * Regressions from an adversarial pass over the six-tab sidebar refactor. Each
 * test below reproduced a defect before its fix (noted in the assertion text);
 * they drive the real scripts through the same harness as the tests above.
 */

test("a late follow page cannot repaint over a channel opened meanwhile", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [{ broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" }], pagination: { cursor: "page-two" } },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();
  h.answerPath("/helix/users?login=caedrel", {
    data: { data: [{ id: "9", login: "caedrel", display_name: "Caedrel", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png" }] },
  });
  await tick();
  assert.equal(h.page.find('[data-kind="follow"]').length, 1);

  /* Load more is in flight … */
  const more = h.page.find('[data-action="load-more"]');
  assert.equal(more.length, 1, "page one has a cursor");
  h.page.fire(more[0], "click", {});
  await tick();
  /* … and the user opens a channel before that page lands */
  h.page.fire(h.page.find('[data-kind="follow"]')[0], "click", {});
  await tick();
  /* the overview renders from the tab cache (the batch users call shares the path) */
  assert.equal(h.page.find('[data-role="channel-header"]').length, 1, "the channel header is on screen");
  h.answerPath("/helix/streams?user_login=caedrel", { data: { data: [] } });
  await tick();
  h.answer((path) => path.indexOf("/helix/videos?user_id=9") === 0, { data: { data: [], pagination: {} } });
  await tick();

  /* now the page-two reply arrives, late: it is dropped before it fans out */
  h.answerPath("/helix/channels/followed?user_id=1&first=100&after=page-two", {
    data: { data: [{ broadcaster_id: "7", broadcaster_login: "xqc", broadcaster_name: "xQc" }], pagination: {} },
  });
  await tick();

  assert.equal(h.requests().filter((entry) => entry.path.indexOf("user_login=xqc") !== -1).length, 0,
    "the superseded page never issues its live batch");
  assert.equal(h.page.find('[data-role="channel-header"]').length, 1,
    "the stale page must not clear the channel view");
  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), [],
    "the stale page must not repaint the follow list over the channel view");
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel");
});

test("a late channel lookup cannot clear the view restored by Escape", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [
      { broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" },
      { broadcaster_id: "8", broadcaster_login: "thebausffs", broadcaster_name: "Thebausffs" },
    ], pagination: {} },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, {
    data: { data: [{ id: "9", login: "caedrel", display_name: "Caedrel", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png" }] },
  });
  await tick();
  assert.equal(h.page.find('[data-kind="follow"]').length, 2);

  /* open caedrel, leave its single-channel lookup unanswered, then Escape back */
  h.page.fire(h.page.find('[data-kind="follow"]')[0], "click", {});
  await tick();
  h.page.documentKey("Escape");
  await tick();
  assert.equal(h.page.find('[data-kind="follow"]').length, 2, "Escape restores the Following root");
  assert.equal(h.page.byId("browser-title").textContent, "Following");

  /* the abandoned lookup fails (or times out) — it must not touch the pane */
  h.answerPath("/helix/users?login=caedrel", { ok: false, status: 500, error: "boom" });
  await tick();
  assert.equal(h.page.find('[data-kind="follow"]').length, 2,
    "a stale channel failure must not replace the restored list with an error card");
  assert.equal(h.page.byId("browser-title").textContent, "Following");
  assert.equal(h.page.find('[data-action="retry"]').length, 0, "no stray error card");
});

test("a page answered after a refresh cannot resurrect its rows", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [{ broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" }], pagination: { cursor: "page-two" } },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, { data: { data: [] } });
  await tick();

  /* Load more, left unanswered, then Refresh */
  h.page.fire(h.page.find('[data-action="load-more"]')[0], "click", {});
  await tick();
  h.page.fire(h.page.byId("browser-refresh"), "click", {});
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [{ broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" }], pagination: {} },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, { data: { data: [] } });
  await tick();
  assert.equal(h.page.find('[data-kind="follow"]').length, 1, "the refreshed list is on screen");

  /* the pre-refresh page-two reply finally lands and is dropped */
  h.answerPath("/helix/channels/followed?user_id=1&first=100&after=page-two", {
    data: { data: [
      { broadcaster_id: "3", broadcaster_login: "anna", broadcaster_name: "Anna" },
      { broadcaster_id: "4", broadcaster_login: "high", broadcaster_name: "High" },
    ], pagination: {} },
  });
  await tick();

  assert.equal(h.requests().filter((entry) => /user_login=(anna|high)/.test(entry.path)).length, 0,
    "a superseded page never fans out its live batch");
  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), ["caedrel"],
    "a superseded generation must not repaint the refreshed pane");
  assert.equal(h.page.find('[data-action="load-more"]').length, 0, "and must not take over pagination");
});

test("an older Top payload cannot win after a refresh", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();
  clickTab(h, "top");
  await tick();

  const match = (path) => path === "/helix/streams?first=30";
  assert.equal(h.requests().filter((entry) => match(entry.path)).length, 1, "Top asked once");
  h.page.fire(h.page.byId("browser-refresh"), "click", {});
  const second = h.requests().filter((entry) => match(entry.path));
  assert.equal(second.length, 2, "refresh asks again");

  h.answerAt(match, 1, { data: { data: [{ id: "new", user_login: "chan", user_name: "Chan", viewer_count: 5 }] } });
  await tick();
  assert.equal(h.page.find('[data-kind="stream"]')[0].dataset.id, "new");
  h.answerAt(match, 0, { data: { data: [{ id: "old", user_login: "chan", user_name: "Chan", viewer_count: 5 }] } });
  await tick();
  assert.equal(h.page.find('[data-kind="stream"]')[0].dataset.id, "new",
    "the pre-refresh reply must not overwrite the current list");
});

test("out-of-order search replies keep the newest query", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();
  clickTab(h, "search");
  await tick();

  const input = h.page.find('[data-action="channel-search-input"]')[0];
  input.value = "alpha";
  h.page.fire(input, "input", {});
  h.page.advanceTimers(300);
  input.value = "beta";
  h.page.fire(input, "input", {});
  h.page.advanceTimers(300);

  const alphaPath = "/helix/search/channels?query=alpha&first=20";
  const betaPath = "/helix/search/channels?query=beta&first=20";
  assert.ok(h.requests().some((entry) => entry.path === alphaPath), "the alpha request went out");
  assert.ok(h.requests().some((entry) => entry.path === betaPath), "the beta request went out");

  /* the newest query answers first, the older one later */
  h.answerPath(betaPath, { data: { data: [{ broadcaster_login: "beta", display_name: "Beta", id: "2" }] } });
  await tick();
  h.answerPath(alphaPath, { data: { data: [{ broadcaster_login: "alpha", display_name: "Alpha", id: "1" }] } });
  await tick();

  assert.deepEqual(h.page.find('[data-kind="search-channel"]').map((row) => row.dataset.login), ["beta"],
    "the list must match the query still in the field");
});

test("a pending query debounce is dropped on re-render and asks nothing extra", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: [], pagination: {} } });
  await tick();
  clickTab(h, "search");
  await tick();

  /* type, then refresh before the debounce fires */
  const input = h.page.find('[data-action="channel-search-input"]')[0];
  input.value = "alpha";
  h.page.fire(input, "input", {});
  h.page.fire(h.page.byId("browser-refresh"), "click", {});
  h.page.advanceTimers(300);
  await tick();

  const alphaPath = "/helix/search/channels?query=alpha&first=20";
  assert.equal(h.requests().filter((entry) => entry.path === alphaPath).length, 1,
    "the re-render replaces the debounced run instead of firing a second request");
});

test("the first following page never flashes the empty state while live state is in flight", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [
      { broadcaster_id: "9", broadcaster_login: "caedrel", broadcaster_name: "Caedrel" },
      { broadcaster_id: "8", broadcaster_login: "thebausffs", broadcaster_name: "Thebausffs" },
    ], pagination: { cursor: "page-two" } },
  });
  await tick();
  /* the avatar batch answers first (it is posted first), the live batch is still out */
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, {
    data: { data: [{ id: "9", login: "caedrel", display_name: "Caedrel", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png" }] },
  });
  await tick();

  assert.equal(/You do not follow any channels yet/.test(h.page.byId("pane-following").textContent), false,
    "the empty state must not appear while the page is still loading");
  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), ["caedrel", "thebausffs"],
    "the page renders as soon as the follow list arrives");
  assert.equal(h.page.find('[data-action="load-more"]').length, 1, "and its cursor is usable immediately");

  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();
  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), ["caedrel", "thebausffs"]);
});

test("Following re-sorts pages as a whole, dedupes a repeated login and re-evaluates live state", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  /* page one: two live channels with equal viewer counts (tie -> name) */
  h.answerPath("/helix/channels/followed?user_id=1&first=100", {
    data: { data: [
      { broadcaster_id: "1", broadcaster_login: "zeta", broadcaster_name: "zeta" },
      { broadcaster_id: "2", broadcaster_login: "alpha", broadcaster_name: "alpha" },
    ], pagination: { cursor: "page-two" } },
  });
  await tick();
  h.answerPath("/helix/streams?first=2&user_login=zeta&user_login=alpha", {
    data: { data: [
      { user_login: "zeta", user_name: "zeta", viewer_count: 500 },
      { user_login: "alpha", user_name: "alpha", viewer_count: 500 },
    ] },
  });
  await tick();
  h.answer((path) => path.indexOf("/helix/users?login=") === 0, { data: { data: [] } });
  await tick();

  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), ["alpha", "zeta"],
    "equal viewer counts break the tie by name");
  assert.equal(h.page.find('[data-live="true"]').length, 2);

  /* page two repeats zeta, and the page-two live batch no longer lists it */
  h.page.fire(h.page.find('[data-action="load-more"]')[0], "click", {});
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100&after=page-two", {
    data: { data: [{ broadcaster_id: "1", broadcaster_login: "zeta", broadcaster_name: "zeta" }], pagination: {} },
  });
  await tick();
  h.answerPath("/helix/streams?first=1&user_login=zeta", { data: { data: [] } });
  await tick();

  assert.deepEqual(h.page.find('[data-kind="follow"]').map((row) => row.dataset.login), ["alpha", "zeta"],
    "a repeated login must not render twice");
  assert.deepEqual(h.page.find('[data-live="true"]').map((row) => row.dataset.login), ["alpha"],
    "zeta went offline between pages and is re-evaluated against the page that queried it");
});

test("the VOD of an in-flight broadcast uses the live thumbnail, never the processing URL", async () => {
  const h = await openOverview({ vods: [{
    id: "live-vod", user_login: "caedrel", user_name: "Caedrel", title: "today", duration: "2h",
    published_at: "2024-06-01T00:00:00Z",
    thumbnail_url: "https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png",
  }] });
  const img = h.page.find('[data-kind="vod"]')[0].children[0].children[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.src, "https://static-cdn.jtvnw.net/previews-ttv/live_user_caedrel-160x90.jpg",
    "the processing marker is treated as no thumbnail and the live preview is used");
  assert.equal(img.src.indexOf("404_processing"), -1, "the processing URL is never requested");
});

test("an offline channel's processing thumbnail keeps the placeholder", async () => {
  const h = await openOverview({
    offline: true,
    vods: [{
      id: "v", user_login: "thebausffs", title: "old", duration: "1h", published_at: "2024-01-01T00:00:00Z",
      thumbnail_url: "https://vod-secure.twitch.tv/_404/404_processing_320x180.png",
    }],
  });
  const box = h.page.find('[data-kind="vod"]')[0].children[0];
  assert.ok(box.classList.contains("twt-art-placeholder"), "no invented image");
  assert.equal(box.children.length, 0, "no <img> for the processing marker");
});

test("a failed VOD thumbnail swaps once to the live preview, then to the placeholder", async () => {
  const h = await openOverview({ vods: [{
    id: "v1", user_login: "caedrel", user_name: "Caedrel", title: "t", duration: "1h",
    published_at: "2024-01-01T00:00:00Z",
    thumbnail_url: "https://static-cdn.jtvnw.net/cf_vods/gone-%{width}x%{height}.jpg",
  }] });
  const box = h.page.find('[data-kind="vod"]')[0].children[0];
  const img = box.children[0];
  assert.equal(img.src, "https://static-cdn.jtvnw.net/cf_vods/gone-160x90.jpg");

  h.page.fire(img, "error", {});
  assert.equal(img.hidden, false, "the first failure swaps instead of hiding");
  assert.equal(img.src, "https://static-cdn.jtvnw.net/previews-ttv/live_user_caedrel-160x90.jpg",
    "the one-shot fallback is the live preview");

  h.page.fire(img, "error", {});
  assert.equal(img.hidden, true, "the second failure gives up on the image");
  assert.ok(box.classList.contains("twt-art-placeholder"));
});

test("the Videos tab treats a processing thumbnail as missing and batches its live lookup", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [{ broadcaster_id: "id1", broadcaster_login: "chan1", broadcaster_name: "Chan 1" }];
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answerPath("/helix/videos?user_id=id1&type=archive&first=10", { data: { data: [{
    id: "a1", user_login: "chan1", user_name: "Chan 1", title: "today", duration: "1m",
    published_at: "2024-01-02T00:00:00Z",
    thumbnail_url: "https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png",
  }], pagination: {} } });
  await tick();

  const batch = "/helix/streams?first=1&user_login=chan1";
  assert.equal(h.requests().filter((entry) => entry.path === batch).length, 2,
    "the Videos tab asks for the live state too (one batch here, one for Following)");
  h.answerPath(batch, { data: { data: [{ user_login: "chan1", thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_chan1-%{width}x%{height}.jpg" }] } });
  await tick();

  const img = h.page.find('[data-kind="vod"]')[0].children[0].children[0];
  assert.equal(img.src, "https://static-cdn.jtvnw.net/previews-ttv/live_user_chan1-160x90.jpg",
    "the Videos list also substitutes the live preview for a processing marker");
});

test("duplicate broadcaster ids fan out to one videos request", async () => {
  const h = browserHarness();
  h.answerPath("/identity", { data: { login: "viewer", user_id: "1", scopes: ["user:read:follows"] } });
  await tick();
  const follows = [
    { broadcaster_id: "id1", broadcaster_login: "chan1", broadcaster_name: "Chan 1" },
    { broadcaster_id: "id1", broadcaster_login: "chan1", broadcaster_name: "Chan 1" },
  ];
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();
  h.answer((path) => path.indexOf("/helix/streams?first=") === 0 && path.indexOf("&user_login=") !== -1, { data: { data: [] } });
  await tick();

  clickTab(h, "videos");
  await tick();
  h.answerPath("/helix/channels/followed?user_id=1&first=100", { data: { data: follows, pagination: {} } });
  await tick();

  const vods = "/helix/videos?user_id=id1&type=archive&first=10";
  assert.equal(h.requests().filter((entry) => entry.path === vods).length, 1,
    "the same channel is not fetched twice");
});

test("a following row's avatar is the channel avatar, never the live preview", async () => {
  const h = await followingTab();
  const row = h.page.find('[data-kind="follow"]').filter((candidate) => candidate.dataset.login === "caedrel")[0];
  const avatar = row.children[0].children[0];
  assert.equal(avatar.className, "twt-follow-avatar");
  assert.equal(avatar.src, "https://static-cdn.jtvnw.net/jtv_user_pictures/caedrel-profile_image-300x300.png");
  assert.equal(avatar.src.indexOf("previews-ttv"), -1, "the avatar box never gets a live preview");

  const watch = h.page.find('[data-action="watch"]');
  assert.equal(watch.length, 1, "only the live follow row has a watch affordance");
  assert.equal(watch[0].parentNode.dataset.login, "caedrel", "and it belongs to that row");
  const thumb = watch[0].children[0].children[0];
  assert.equal(thumb.className, "twt-stream-thumb");
  assert.match(thumb.src, /previews-ttv\/live_user_caedrel-/);
});

test("the tab strip keeps aria-selected in step with the visible pane", async () => {
  const h = await followingTab();
  assert.equal(h.page.byId("tab-following").getAttribute("aria-selected"), "true");
  assert.equal(h.page.byId("tab-top").getAttribute("aria-selected"), "false");

  clickTab(h, "top");
  await tick();
  assert.equal(h.page.byId("tab-top").getAttribute("aria-selected"), "true");
  assert.equal(h.page.byId("tab-following").getAttribute("aria-selected"), "false");
});

test("transport.js kept no handler from the removed Browse tab", () => {
  const source = fs.readFileSync(path.join(ROOT, "ui/transport.js"), "utf8");
  for (const gone of ["selectTab", "tab-browser", "tab-settings", "getElementById(\"tab-"]) {
    assert.equal(source.indexOf(gone), -1, "transport.js must not reference " + gone);
  }
});

test("refresh refetches only the active tab and keeps its stack", async () => {
  const h = await openOverview();
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel", "a channel overview is on the stack");
  const paths = () => h.requests().map((entry) => entry.path);
  const count = (prefix) => paths().filter((path) => path.indexOf(prefix) === 0).length;

  const usersBefore = count("/helix/users?login=caedrel");
  const otherTabs = [count("/helix/games/top"), count("/helix/search/categories"),
    count("/helix/search/channels"), count("/helix/videos?user_id=8")];

  h.page.fire(h.page.byId("browser-refresh"), "click", {});
  await tick();

  assert.equal(count("/helix/users?login=caedrel"), usersBefore + 1, "the active view refetches");
  assert.deepEqual([count("/helix/games/top"), count("/helix/search/categories"),
    count("/helix/search/channels"), count("/helix/videos?user_id=8")], otherTabs,
    "no other tab is asked anything");
  assert.equal(h.page.byId("browser-title").textContent, "#caedrel", "the stack survives a refresh");
});
