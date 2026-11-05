/*
 * lib/webview.js - the text codec for IINA's web-view bridge.
 *
 * IINA forwards postMessage() payloads into a web view by evaluating
 *   window.iina._emit(`name`, String.raw`<json>`)
 * so a payload is interpolated as a template literal and two sequences in the
 * JSON text break it (chat text and media titles are attacker controlled):
 *   - a literal backtick ends the template literal, and
 *   - "${" still starts an interpolation even inside String.raw, so the JSON is
 *     either mangled (the expression is evaluated into the data) or the whole
 *     evaluation throws, which WebKit reports as "Request to run JavaScript
 *     failed" and the view silently never receives that message.
 * Strings containing either sequence are therefore shipped base64 encoded as
 * {__b64: "..."} and decoded by ui/protocol.js in the web view. Everything else
 * travels as plain JSON: String.raw keeps backslashes intact for the view's
 * JSON.parse.
 *
 * Both entries (main.js and global.js) post into web views, so this lives in
 * lib/ and runs unchanged in IINA's JavaScriptCore, Node and a WKWebView.
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.webview = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function utf8Bytes(str) {
    var bytes = [];
    var i, code;
    for (i = 0; i < str.length; i++) {
      code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var low = str.charCodeAt(i + 1);
        var point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
        bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
    }
    return bytes;
  }

  function base64Encode(str) {
    var bytes = utf8Bytes(str);
    var out = "";
    var i, b0, b1, b2;
    for (i = 0; i < bytes.length; i += 3) {
      b0 = bytes[i];
      b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
      b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
      out += B64_ALPHABET.charAt(b0 >> 2);
      out += B64_ALPHABET.charAt(((b0 & 3) << 4) | (b1 === -1 ? 0 : b1 >> 4));
      out += b1 === -1 ? "=" : B64_ALPHABET.charAt(((b1 & 15) << 2) | (b2 === -1 ? 0 : b2 >> 6));
      out += b2 === -1 ? "=" : B64_ALPHABET.charAt(b2 & 63);
    }
    return out;
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function encodeForWebview(value) {
    if (typeof value === "string") {
      var unsafe = value.indexOf("`") !== -1 || value.indexOf("${") !== -1;
      return unsafe ? { __b64: base64Encode(value) } : value;
    }
    if (value === null || typeof value !== "object") return value;
    var i, keys, out;
    if (isArray(value)) {
      out = [];
      for (i = 0; i < value.length; i++) out.push(encodeForWebview(value[i]));
      return out;
    }
    out = {};
    keys = Object.keys(value);
    for (i = 0; i < keys.length; i++) {
      if (value[keys[i]] === undefined) continue;
      out[keys[i]] = encodeForWebview(value[keys[i]]);
    }
    return out;
  }

  return {
    base64Encode: base64Encode,
    encodeForWebview: encodeForWebview
  };
});
