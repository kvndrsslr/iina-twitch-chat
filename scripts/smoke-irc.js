#!/usr/bin/env node
/* Live smoke test for lib/irc.js using the real Twitch IRC WebSocket.
 * Usage: node scripts/smoke-irc.js [channel]
 * Connects anonymously, joins #<channel>, prints raw lines + ChatEvents for
 * ~25 seconds, then exits 0.
 */
"use strict";

const irc = require("../lib/irc.js");

const channel = process.argv[2] || "twitch";
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);

let wsAvail;
if (typeof WebSocket === "function") {
  wsAvail = "global WebSocket available unflagged";
} else if (nodeMajor === 21) {
  wsAvail = "WebSocket requires --experimental-websocket (not present)";
} else {
  wsAvail = "WebSocket unavailable (node < 21)";
}
console.log(`[smoke] node ${process.version} (major ${nodeMajor}); ${wsAvail}`);

if (typeof WebSocket !== "function") {
  console.error("[smoke] no WebSocket global; cannot run live smoke");
  process.exit(1);
}

const client = irc.createClient({
  socketFactory: (u) => new WebSocket(u),
});

client.on("state", (state, info) => {
  let extra = "";
  if (info && info.attempt !== undefined) extra = ` (attempt ${info.attempt})`;
  console.log(`[state] ${state}${extra}`);
});
client.on("raw", (line) => console.log(`[raw] ${line}`));
client.on("event", (ev) => {
  const parts = [];
  parts.push(ev.kind);
  if (ev.channel) parts.push(`#${ev.channel}`);
  if (ev.login) parts.push(`<${ev.login}>`);
  if (ev.displayName) parts.push(`[${ev.displayName}]`);
  if (ev.text) parts.push(`: ${ev.text}`);
  if (ev.kind === "usernotice") parts.push(`(msg-id=${ev.msgId})`);
  console.log(`[event] ${parts.join(" ")}`);
});
client.on("error", (err) => console.log(`[error] ${err.message}`));

(async () => {
  await client.connect({ channel });
  console.log(`[smoke] connected anonymously, joined #${channel}`);
  await new Promise((resolve) => setTimeout(resolve, 25000));
  client.disconnect();
  console.log("[smoke] done");
  process.exit(0);
})().catch((err) => {
  console.error(`[smoke] failed: ${err}`);
  process.exit(1);
});
