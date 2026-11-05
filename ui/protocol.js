/*
 * ui/protocol.js - web view side of the plugin <-> web view protocol.
 *
 * The plugin script cannot hand a backtick to IINA's postMessage() bridge
 * (it splices the JSON payload into a JS template literal), so strings that
 * contain one arrive base64 encoded as {__b64: "..."}. TwitchProtocol.decode()
 * turns those back into plain strings and is applied by protocol.onMessage()
 * to every incoming message, so the rest of the UI only ever sees plain data.
 */

(function (global) {
  "use strict";

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function decodeBase64(encoded) {
    var bytes = [];
    var i, c, buffer = 0, bits = 0;
    for (i = 0; i < encoded.length; i++) {
      c = B64.indexOf(encoded.charAt(i));
      if (c === -1) continue;
      buffer = (buffer << 6) | c;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    var percent = "";
    for (i = 0; i < bytes.length; i++) {
      percent += "%" + (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    try {
      return decodeURIComponent(percent);
    } catch (e) {
      var out = "";
      for (i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
  }

  function decode(value) {
    if (value === null || typeof value !== "object") return value;
    var i, keys, out;
    if (Object.prototype.toString.call(value) === "[object Array]") {
      out = [];
      for (i = 0; i < value.length; i++) out.push(decode(value[i]));
      return out;
    }
    keys = Object.keys(value);
    if (keys.length === 1 && typeof value.__b64 === "string") {
      return decodeBase64(value.__b64);
    }
    out = {};
    for (i = 0; i < keys.length; i++) out[keys[i]] = decode(value[keys[i]]);
    return out;
  }

  global.TwitchProtocol = {
    decode: decode,
    /* Subscribe to a plugin -> web view message with payloads decoded. */
    onMessage: function (name, callback) {
      global.iina.onMessage(name, function (data) {
        callback(decode(data));
      });
    },
    /* Web view -> plugin; JSON.stringify() on the web view side is escape safe. */
    postMessage: function (name, data) {
      global.iina.postMessage(name, data === undefined ? {} : data);
    }
  };
})(typeof window !== "undefined" ? window : this);
