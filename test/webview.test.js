"use strict";

/*
 * Tests for lib/webview.js - the codec that keeps a payload alive inside IINA's
 * web-view bridge.
 *
 * IINA 1.5.0 (JavascriptMessageHub.postMessage + bridgeScript._emit) evaluates
 *   window.iina._emit(`name`, String.raw`<json>`)
 * and the bridge then JSON.parses the string it receives. Two sequences in the
 * JSON text break that template literal - a backtick ends it, and "${" is still
 * an interpolation inside String.raw - which either mangles the data or throws
 * ("Request to run JavaScript failed" in WebKit's log), so those strings travel
 * base64 encoded as {__b64}. The last test here replays the bridge verbatim.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const webview = require("../lib/webview.js");

/* ui/protocol.js decodes the markers in the web view; the same step here. */
function decodeForView(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeForView);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "__b64") return Buffer.from(String(value.__b64), "base64").toString("utf8");
  const out = {};
  for (const key of keys) out[key] = decodeForView(value[key]);
  return out;
}

/* JavascriptMessageHub.postMessage + the bridge's _emit, replayed. */
function throughBridge(name, encodedPayload) {
  const json = JSON.stringify(encodedPayload);
  const script = "window.iina._emit(`" + name + "`, String.raw`" + json + "`)";
  const seen = [];
  const fakeWindow = {
    iina: { _emit: (eventName, dataString) => seen.push({ name: eventName, data: JSON.parse(dataString) }) }
  };
  new Function("window", script)(fakeWindow);
  return seen[0];
}

test("encodeForWebview only rewrites what would break the template literal", () => {
  assert.equal(webview.encodeForWebview("plain"), "plain");
  assert.equal(webview.encodeForWebview("a $ b {c}"), "a $ b {c}", "a lone $ and bare braces are safe");
  assert.equal(webview.encodeForWebview("back\\slash"), "back\\slash");
  assert.equal(webview.encodeForWebview(12), 12);
  assert.equal(webview.encodeForWebview(true), true);
  assert.equal(webview.encodeForWebview(null), null);
  assert.deepEqual(webview.encodeForWebview("tick`"), { __b64: webview.base64Encode("tick`") });
  assert.deepEqual(webview.encodeForWebview("${x}"), { __b64: webview.base64Encode("${x}") });
});

test("encodeForWebview walks arrays and objects and drops undefined members", () => {
  const encoded = webview.encodeForWebview({ a: ["x`", { b: "${y}" }], c: undefined, d: 1 });
  assert.equal(encoded.c, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(encoded, "c"), false, "undefined members are dropped, not encoded");
  assert.deepEqual(decodeForView(encoded), { a: ["x`", { b: "${y}" }], d: 1 });
});

test("base64Encode round trips multi-byte text", () => {
  for (const text of ["ascii", "tick`", "${x}", "emoji \u{1F600} and \u00e4\u00f6\u00fc", "line\nbreak\ttab"]) {
    assert.equal(Buffer.from(webview.base64Encode(text), "base64").toString("utf8"), text);
  }
});

test("every hostile payload survives IINA's bridge verbatim", () => {
  const payloads = [
    { event: { kind: "message", text: "price ${nope} and ${1+1}" } },
    { event: { kind: "message", text: "tick` and \\ backslash" } },
    { event: { kind: "message", text: "\u{1F600} ${'x'}" } },
    { settings: { chat: { palette: "x`y" } }, note: "${1+1}" },
    ["${a}", "`b`", 3],
    "bare ${string}"
  ];
  for (const payload of payloads) {
    const encoded = webview.encodeForWebview(payload);
    const bridged = throughBridge("twt:event", encoded);
    assert.equal(bridged.name, "twt:event");
    assert.deepEqual(decodeForView(bridged.data), JSON.parse(JSON.stringify(payload)),
      "the view receives exactly what was sent: " + JSON.stringify(payload));
  }
});
