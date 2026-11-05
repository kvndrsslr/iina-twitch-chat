"use strict";

/*
 * Tests for lib/helix.js - the Twitch proxy both entries share.
 *
 * The allowlist, the absolute-URL check, the token choice and the request
 * engine (validate once per token, inject user_id, the frozen error strings,
 * the 10 s / 4 MiB discipline, never logging the token) are all policy that
 * must not diverge between the player entry and the standalone host, so they
 * are pinned here rather than through one host's harness.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const helix = require("../lib/helix.js");

const VALIDATE = helix.VALIDATE_URL;
const identityBody = () => JSON.stringify({ client_id: "cid", login: "me", user_id: "42", scopes: ["chat:read"] });

function engine(options) {
  const calls = { http: [], log: [], warn: [] };
  const opts = options || {};
  const token = opts.token === undefined ? "tok" : opts.token;
  const instance = helix.create({
    http: {
      get(url, config) {
        calls.http.push({ url, headers: (config && config.headers) || {} });
        return opts.respond(url);
      }
    },
    token: typeof token === "function" ? token : function () { return token; },
    log: (m) => calls.log.push(String(m)),
    warn: (m) => calls.warn.push(String(m)),
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout
  });
  return { instance, calls };
}

const ok = (body) => ({ statusCode: 200, text: body });

test("the allowlist is the paths the browsers call", () => {
  assert.deepEqual(helix.ALLOWED_PATHS, [
    "/identity",
    "/helix/users",
    "/helix/streams",
    "/helix/videos",
    "/helix/games/top",
    "/helix/channels/followed",
    "/helix/search/channels",
    "/helix/search/categories"
  ]);
  assert.equal(helix.allowedPath("/helix/users/follows"), false, "the retired endpoint stays out");
});

test("pathSpec accepts allowed paths with queries and rejects everything else", () => {
  assert.deepEqual(helix.pathSpec("/helix/streams?user_login=a&first=20"),
    { path: "/helix/streams", query: "user_login=a&first=20" });
  assert.deepEqual(helix.pathSpec("/identity"), { path: "/identity", query: "" });
  assert.equal(helix.pathSpec("/helix/chat/messages"), null);
  assert.equal(helix.pathSpec("/helix/users/../streams"), null);
  assert.equal(helix.pathSpec("//evil.com/helix/users"), null);
  assert.equal(helix.pathSpec("https://api.twitch.tv/helix/users"), null, "an absolute URL is not a path");
  assert.equal(helix.pathSpec(""), null);
  assert.equal(helix.pathSpec(undefined), null);
});

test("urlSpec validates the same allowlist plus the origin", () => {
  assert.deepEqual(helix.urlSpec("https://api.twitch.tv/helix/videos?first=20"),
    { path: "/helix/videos", query: "first=20" });
  assert.deepEqual(helix.urlSpec("https://id.twitch.tv/oauth2/validate"), { path: "/identity", query: "" });
  assert.deepEqual(helix.urlSpec("https://api.twitch.tv:443/helix/users"), { path: "/helix/users", query: "" });
  assert.equal(helix.urlSpec("https://evil.com/helix/users"), null);
  assert.equal(helix.urlSpec("https://api.twitch.tv.evil.com/helix/users"), null);
  assert.equal(helix.urlSpec("https://api.twitch.tv/helix/users/follows"), null, "origin is not enough: the path must be listed");
  assert.equal(helix.urlSpec("https://user@api.twitch.tv/helix/users"), null);
  assert.equal(helix.urlSpec("https://api.twitch.tv:8443/helix/users"), null);
  assert.equal(helix.urlSpec("http://api.twitch.tv/helix/users"), null);
  assert.equal(helix.urlSpec("/helix/users"), null, "a path is not a URL");
});

test("requestSpec prefers path over url and needs one of them", () => {
  assert.deepEqual(helix.requestSpec({ path: "/helix/users" }), { path: "/helix/users", query: "" });
  assert.deepEqual(helix.requestSpec({ path: "/nope", url: "https://api.twitch.tv/helix/users" }), null,
    "a bad path is not rescued by a good url");
  assert.deepEqual(helix.requestSpec({ url: "https://api.twitch.tv/helix/users" }), { path: "/helix/users", query: "" });
  assert.equal(helix.requestSpec({ id: "x" }), null);
  assert.equal(helix.requestSpec(null), null);
});

test("cleanToken and pickToken follow the IRC path's rule", () => {
  assert.equal(helix.cleanToken("oauth:abc"), "abc");
  assert.equal(helix.cleanToken(" abc \n"), "abc");
  assert.equal(helix.cleanToken(undefined), "");
  assert.deepEqual(helix.pickToken("cfgtok", "keytok"), { value: "cfgtok", source: "config" });
  assert.deepEqual(helix.pickToken("", "keytok"), { value: "keytok", source: "keychain" });
  assert.deepEqual(helix.pickToken("   ", "  "), { value: null, source: "none" });
});

test("twitchMediaUrl accepts only https twitch.tv pages", () => {
  assert.equal(helix.twitchMediaUrl("https://www.twitch.tv/someone"), "https://www.twitch.tv/someone");
  assert.equal(helix.twitchMediaUrl("https://twitch.tv/videos/123"), "https://twitch.tv/videos/123");
  assert.equal(helix.twitchMediaUrl("http://twitch.tv/x"), null);
  assert.equal(helix.twitchMediaUrl("https://evil.com/x"), null);
  assert.equal(helix.twitchMediaUrl("https://www.twitch.tv.evil.com/x"), null);
  assert.equal(helix.twitchMediaUrl("https://www.twitch.tv:8443/x"), null);
  assert.equal(helix.twitchMediaUrl("javascript:alert(1)"), null);
});

test("logUrl strips the query, so a logged line can never carry a parameter", () => {
  assert.equal(helix.logUrl("https://api.twitch.tv/helix/streams?user_login=secret"), "api.twitch.tv/helix/streams");
  assert.equal(helix.logUrl("https://id.twitch.tv/oauth2/validate"), "id.twitch.tv/oauth2/validate");
  assert.equal(helix.logUrl(null), "?");
});

test("a request validates once then calls Helix with both headers", async () => {
  const { instance, calls } = engine({ respond: (url) => Promise.resolve(ok(url === VALIDATE ? identityBody() : JSON.stringify({ data: [{ id: "s1" }] }))) });
  const result = await new Promise((resolve) => instance.request({ path: "/helix/streams", query: "first=1" }, (error, status, data) => resolve({ error, status, data })));
  assert.equal(result.error, null);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { data: [{ id: "s1" }] });
  assert.deepEqual(calls.http.map((c) => c.url), [VALIDATE, "https://api.twitch.tv/helix/streams?first=1"]);
  assert.deepEqual(calls.http[0].headers, { Authorization: "OAuth tok" });
  assert.deepEqual(calls.http[1].headers, { "Client-Id": "cid", Authorization: "Bearer tok" });
  assert.deepEqual(Object.keys(calls.http[0].headers), ["Authorization"]);
});

test("a burst of requests shares one validate call", async () => {
  const { instance, calls } = engine({ respond: (url) => Promise.resolve(ok(url === VALIDATE ? identityBody() : "{}")) });
  await Promise.all([
    new Promise((r) => instance.request({ path: "/helix/users", query: "login=a" }, r)),
    new Promise((r) => instance.request({ path: "/helix/streams", query: "first=1" }, r)),
    new Promise((r) => instance.request({ path: "/helix/games/top", query: "" }, r))
  ]);
  assert.equal(calls.http.filter((c) => c.url === VALIDATE).length, 1, "one validate for the burst");
  assert.equal(calls.http.length, 4);
  assert.equal(instance.cachedIdentity().userId, "42");
});

test("/identity is answered from the validate call alone", async () => {
  const { instance, calls } = engine({ respond: (url) => Promise.resolve(ok(url === VALIDATE ? identityBody() : "{}")) });
  const result = await new Promise((resolve) => instance.request({ path: "/identity", query: "" }, (error, status, data) => resolve({ error, status, data })));
  assert.deepEqual(result.data, { userId: "42", login: "me", clientId: "cid", scopes: ["chat:read"] });
  assert.equal(calls.http.length, 1, "no Helix call");
});

test("the followed channels get the validated user id, explicitly or injected", async () => {
  const { instance, calls } = engine({ respond: (url) => Promise.resolve(ok(url === VALIDATE ? identityBody() : "{}")) });
  await new Promise((r) => instance.request({ path: "/helix/channels/followed", query: "first=20" }, r));
  await new Promise((r) => instance.request({ path: "/helix/channels/followed", query: "user_id=99" }, r));
  assert.deepEqual(calls.http.filter((c) => c.url.indexOf("https://api.twitch.tv") === 0).map((c) => c.url), [
    "https://api.twitch.tv/helix/channels/followed?first=20&user_id=42",
    "https://api.twitch.tv/helix/channels/followed?user_id=99"
  ]);
});

test("a 401 from validate answers token invalid and drops the cache", async () => {
  let validations = 0;
  const { instance } = engine({
    respond: (url) => {
      if (url !== VALIDATE) return Promise.resolve(ok("{}"));
      validations++;
      return validations === 1
        ? Promise.reject({ statusCode: 401, text: "{}" })
        : Promise.resolve(ok(identityBody()));
    }
  });
  const first = await new Promise((r) => instance.request({ path: "/helix/users" }, (error, status) => r({ error, status })));
  assert.deepEqual(first, { error: "token invalid", status: 401 });
  assert.equal(instance.cachedIdentity(), null);
  const second = await new Promise((r) => instance.request({ path: "/helix/users" }, (error) => r(error)));
  assert.equal(second, null, "the next request re-validates and succeeds");
  assert.equal(validations, 2);
});

test("no token, transport failures, non-JSON and the body cap use the frozen strings", async () => {
  const noToken = engine({ token: "" });
  const missing = await new Promise((r) => noToken.instance.request({ path: "/helix/users" }, (error) => r(error)));
  assert.equal(missing, "no token");
  assert.equal(noToken.calls.http.length, 0, "no request without a token");

  const cases = [
    ["network", () => Promise.reject(new Error("offline"))],
    ["invalid json", () => Promise.resolve(ok("<html>nope</html>"))],
    ["http 500", () => Promise.resolve({ statusCode: 500, text: "{}" })]
  ];
  for (const entry of cases) {
    const { instance } = engine({ respond: entry[1] });
    const error = await new Promise((r) => instance.request({ path: "/helix/users" }, (err) => r(err)));
    assert.equal(error, entry[0]);
  }

  const capped = engine({
    maxBytes: 16,
    respond: () => Promise.resolve(ok(JSON.stringify({ data: new Array(50).fill("x") })))
  });
  const error = await new Promise((r) => capped.instance.request({ path: "/helix/users" }, (err) => r(err)));
  assert.equal(error, "invalid json", "an oversized body is not parsed");
});

test("a request that never answers times out through the injected timer", async () => {
  let fire = null;
  const { instance, calls } = engine({
    respond: () => new Promise(() => {}),
    setTimeout: (fn) => { fire = fn; return 1; },
    clearTimeout: () => {}
  });
  const pending = new Promise((r) => instance.request({ path: "/helix/users" }, (error) => r(error)));
  assert.equal(typeof fire, "function");
  fire();
  assert.equal(await pending, "timeout");
  assert.equal(calls.http.length, 1);
});

test("the token and the Authorization header never reach the log", async () => {
  const { instance, calls } = engine({
    token: "SECRETTOKEN",
    respond: (url) => Promise.resolve(ok(url === VALIDATE ? identityBody() : "{}"))
  });
  await new Promise((r) => instance.request({ path: "/helix/users", query: "login=SECRETTOKEN" }, r));
  const logged = calls.log.concat(calls.warn).join("\n");
  assert.equal(/SECRETTOKEN/.test(logged), false, "neither the token nor a query parameter is logged:\n" + logged);
  assert.ok(/twitch api: api\.twitch\.tv\/helix\/users -> 200/.test(logged), "the host and path are logged");
});
