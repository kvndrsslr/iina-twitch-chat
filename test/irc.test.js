"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const irc = require("../lib/irc.js");

function harness() {
  const sockets = [];
  const timers = [];
  let timerId = 0;
  const client = irc.createClient({
    socketFactory: (url) => {
      const s = {
        url,
        sent: [],
        readyState: 0,
        send(d) { this.sent.push(d); },
        close() { this.readyState = 3; if (this.onclose) this.onclose({ reason: "closed" }); },
      };
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
    now: () => 1700000000000,
    setTimer: (fn, ms) => {
      timerId += 1;
      timers.push({ id: timerId, fn, ms });
      return timerId;
    },
    clearTimer(id) {
      for (let i = 0; i < timers.length; i++) {
        if (timers[i].id === id) { timers.splice(i, 1); break; }
      }
    },
  });
  return { client, sockets, timers };
}

function feed(socket, line) {
  socket.onmessage({ data: line + "\r\n" });
}

function openSocket(s) {
  s.readyState = 1; // W3C OPEN
  s.onopen();
}

function connectedAuth() {
  const h = harness();
  const p = h.client.connect({ token: "abc123", login: "mybot", channel: "dallas" });
  const s = h.sockets[0];
  openSocket(s);
  feed(s, ":tmi.twitch.tv 001 mybot :Welcome, GLHF!");
  return { h, s, p };
}

/* ------------------------------------------------------------------ tags */

test("parseTags unescapes IRCv3 escapes and empty values", () => {
  const tags = irc.parseTags('@color=#00FF00;display-name=Hello\\sWorld;badges=;mod;room-id=123');
  assert.equal(tags.color, "#00FF00");
  assert.equal(tags["display-name"], "Hello World");
  assert.equal(tags.badges, "");
  assert.equal(tags.mod, "");
  assert.equal(tags["room-id"], "123");
});

test("parseTags handles backslash, quote, CR, LF escapes", () => {
  const tags = irc.parseTags('@a=x\\\\y;b=a\\"b;c=line1\\nline2');
  assert.equal(tags.a, "x\\y");
  assert.equal(tags.b, 'a"b');
  assert.equal(tags.c, "line1\nline2");
});

test("escapeTagValue escapes and round-trips", () => {
  assert.equal(irc.escapeTagValue("a b"), "a\\sb");
  assert.equal(irc.escapeTagValue("x\\y"), "x\\\\y");
  assert.equal(irc.escapeTagValue("a;b"), "a\\:b");
  assert.equal(irc.escapeTagValue("q\"q"), "q\\\"q");
  const raw = 'color=#00FF00;text=hello\\sworld;q=x\\"y';
  assert.equal(irc.escapeTagValue('hello world'), "hello\\sworld");
  assert.equal(irc.escapeTagValue(undefined), "");
});

/* ------------------------------------------------------------- messages */

test("parseMessage parses prefix, numeric command and trailing param", () => {
  const m = irc.parseMessage(":tmi.twitch.tv 001 mybot :Welcome, GLHF!");
  assert.equal(m.prefix.nick, "tmi.twitch.tv");
  assert.equal(m.prefix.user, "");
  assert.equal(m.prefix.host, "");
  assert.equal(m.command, "001");
  assert.deepEqual(m.params, ["mybot", "Welcome, GLHF!"]);
});

test("parseMessage parses nick!user@host prefix", () => {
  const m = irc.parseMessage(":foo!foo@foo.tmi.twitch.tv PRIVMSG #bar :HeyGuys");
  assert.deepEqual(m.prefix, { nick: "foo", user: "foo", host: "foo.tmi.twitch.tv" });
  assert.equal(m.command, "PRIVMSG");
  assert.deepEqual(m.params, ["#bar", "HeyGuys"]);
});

test("parseMessage handles no-prefix and tags", () => {
  const m = irc.parseMessage("@msg-id=subgift;room-id=1 :tmi.twitch.tv NOTICE #dallas :msg");
  assert.equal(m.prefix.nick, "tmi.twitch.tv");
  assert.equal(m.tags["msg-id"], "subgift");
  assert.equal(m.command, "NOTICE");
});

test("parseMessage uppercases words and keeps numerics", () => {
  assert.equal(irc.parseMessage("ping :tmi.twitch.tv").command, "PING");
  assert.equal(irc.parseMessage(":x 353 foo = #bar :foo").command, "353");
});

test("parseMessage returns null for empty/whitespace lines", () => {
  assert.equal(irc.parseMessage(""), null);
  assert.equal(irc.parseMessage("   \r\n"), null);
  assert.equal(irc.parseMessage(null), null);
});

/* ---------------------------------------------------------- splitLines */

test("splitLines splits on CRLF and bare LF with rest", () => {
  const r = irc.splitLines("one\r\ntwo\nthree\r");
  assert.deepEqual(r.lines, ["one", "two"]);
  assert.equal(r.rest, "three\r");
  const r2 = irc.splitLines("four");
  assert.deepEqual(r2.lines, []);
  assert.equal(r2.rest, "four");
});

test("splitLines across chunk boundaries keeps partial", () => {
  const r1 = irc.splitLines("PRIVMSG #a :hel");
  assert.deepEqual(r1.lines, []);
  assert.equal(r1.rest, "PRIVMSG #a :hel");
  const r2 = irc.splitLines(r1.rest + "lo\r\nPING :tmi.twitch.tv\r");
  assert.deepEqual(r2.lines, ["PRIVMSG #a :hello"]);
  assert.equal(r2.rest, "PING :tmi.twitch.tv\r");
});

/* ----------------------------------------------------------- ChatEvent */

test("toChatEvent PRIVMSG with badges, emotes, bits, first-msg, timestamp", () => {
  const line = fs.readFileSync(path.join(__dirname, "fixtures", "irc.txt"), "utf8").split("\n")[0];
  const ev = irc.toChatEvent(irc.parseMessage(line));
  assert.equal(ev.kind, "message");
  assert.equal(ev.channel, "dallas");
  assert.equal(ev.timestamp, 1643904084794);
  assert.equal(ev.id, "a1b2c3");
  assert.equal(ev.userId, "713936733");
  assert.equal(ev.login, "forstycup");
  assert.equal(ev.displayName, "Forstycup");
  assert.equal(ev.color, "#0000FF");
  assert.deepEqual(ev.badges, [{ name: "broadcaster", version: "1" }]);
  assert.equal(ev.isMod, false);
  assert.equal(ev.isSubscriber, false);
  assert.equal(ev.isBroadcaster, true);
  assert.equal(ev.isTurbo, false);
  assert.equal(ev.isFirstMessage, true);
  assert.equal(ev.text, "Kappa Keepo Kappa");
  assert.deepEqual(ev.emotes, [
    { id: "25", ranges: [[0, 4], [12, 16]] },
    { id: "1902", ranges: [[6, 10]] },
  ]);
  assert.equal(ev.bits, 0);
  assert.equal(ev.isAction, false);
  assert.equal(ev.isWhisper, false);
  assert.equal(ev.roomId, "713936733");
});

test("toChatEvent PRIVMSG with bits and empty colour", () => {
  const line = fs.readFileSync(path.join(__dirname, "fixtures", "irc.txt"), "utf8").split("\n")[2];
  const ev = irc.toChatEvent(irc.parseMessage(line));
  assert.equal(ev.text, "cheer100");
  assert.equal(ev.bits, 100);
  assert.equal(ev.color, "#FF4500");
});

test("toChatEvent strips CTCP ACTION and shifts emote ranges", () => {
  const line = fs.readFileSync(path.join(__dirname, "fixtures", "irc.txt"), "utf8").split("\n")[3];
  const ev = irc.toChatEvent(irc.parseMessage(line));
  assert.equal(ev.isAction, true);
  assert.equal(ev.text, "Kappa keeps you going");
  assert.deepEqual(ev.emotes, [{ id: "25", ranges: [[0, 4]] }]);
});

test("toChatEvent USERNOTICE sub with system message", () => {
  const line = "@badge-info=;badges=staff/1,broadcaster/1,turbo/1;color=#008000;display-name=ronni;emotes=;id=db25007f;login=ronni;mod=0;msg-id=resub;msg-param-cumulative-months=6;msg-param-sub-plan=Prime;room-id=12345678;subscriber=1;system-msg=ronni\\shas\\ssubscribed;tmi-sent-ts=1507246572675;turbo=1;user-id=87654321;user-type=staff :tmi.twitch.tv USERNOTICE #dallas :Great stream -- keep it up!";
  const ev = irc.toChatEvent(irc.parseMessage(line));
  assert.equal(ev.kind, "usernotice");
  assert.equal(ev.login, "ronni");
  assert.equal(ev.msgId, "resub");
  assert.equal(ev.systemMessage, "ronni has subscribed");
  assert.equal(ev.isRaid, false);
  assert.equal(ev.raidCount, null);
  assert.equal(ev.text, "Great stream -- keep it up!");
});

test("toChatEvent USERNOTICE raid carries raidCount", () => {
  const line = "@msg-id=raid;msg-param-viewerCount=1234;room-id=5;tmi-sent-ts=1 :tmi.twitch.tv USERNOTICE #dallas";
  const ev = irc.toChatEvent(irc.parseMessage(line));
  assert.equal(ev.isRaid, true);
  assert.equal(ev.raidCount, 1234);
  assert.equal(ev.text, "");
});

test("toChatEvent NOTICE", () => {
  const ev = irc.toChatEvent(irc.parseMessage("@msg-id=delete_message_success :tmi.twitch.tv NOTICE #bar :The message from foo is now deleted."));
  assert.equal(ev.kind, "notice");
  assert.equal(ev.msgId, "delete_message_success");
  assert.equal(ev.text, "The message from foo is now deleted.");
  assert.equal(ev.channel, "bar");
});

test("toChatEvent CLEARCHAT timeout vs permanent vs clear-all", () => {
  const timeout = irc.toChatEvent(irc.parseMessage("@ban-duration=350;room-id=123 :tmi.twitch.tv CLEARCHAT #dallas :ronni"));
  assert.equal(timeout.kind, "clearchat");
  assert.equal(timeout.bannedUser, "ronni");
  assert.equal(timeout.duration, 350);
  assert.equal(timeout.isTimeout, true);
  assert.equal(timeout.isPermanent, false);

  const permanent = irc.toChatEvent(irc.parseMessage("@room-id=123 :tmi.twitch.tv CLEARCHAT #dallas :ronni"));
  assert.equal(permanent.isTimeout, false);
  assert.equal(permanent.isPermanent, true);

  const all = irc.toChatEvent(irc.parseMessage("@room-id=123 :tmi.twitch.tv CLEARCHAT #dallas"));
  assert.equal(all.bannedUser, undefined);
});

test("toChatEvent CLEARMSG", () => {
  const ev = irc.toChatEvent(irc.parseMessage("@login=foo;room-id=123;target-msg-id=abc-123-def;tmi-sent-ts=5 :tmi.twitch.tv CLEARMSG #bar :what a great day"));
  assert.equal(ev.kind, "clearmsg");
  assert.equal(ev.id, "abc-123-def");
  assert.equal(ev.login, "foo");
  assert.equal(ev.text, "what a great day");
  assert.equal(ev.timestamp, 5);
});

test("toChatEvent ROOMSTATE", () => {
  const ev = irc.toChatEvent(irc.parseMessage("@emote-only=0;followers-only=-1;r9k=0;room-id=123;slow=10;subs-only=1 :tmi.twitch.tv ROOMSTATE #dallas"));
  assert.equal(ev.kind, "roomstate");
  assert.equal(ev.roomId, "123");
  assert.equal(ev.emoteOnly, false);
  assert.equal(ev.followersOnly, -1);
  assert.equal(ev.r9k, false);
  assert.equal(ev.slow, 10);
  assert.equal(ev.subsOnly, true);
});

test("toChatEvent USERSTATE", () => {
  const ev = irc.toChatEvent(irc.parseMessage("@badges=moderator/1;color=#0D4200;display-name=ronni;login=ronni;mod=1;room-id=123;subscriber=1 :tmi.twitch.tv USERSTATE #dallas"));
  assert.equal(ev.kind, "userstate");
  assert.equal(ev.isMod, true);
  assert.equal(ev.isSubscriber, true);
  assert.equal(ev.login, "ronni");
  assert.equal(ev.color, "#0D4200");
});

test("toChatEvent PING/PONG/RECONNECT and fallback timestamp", () => {
  const ping = irc.toChatEvent(irc.parseMessage("PING :tmi.twitch.tv"), 999);
  assert.equal(ping.kind, "ping");
  assert.equal(ping.payload, "tmi.twitch.tv");
  assert.equal(ping.timestamp, 999);

  const rec = irc.toChatEvent(irc.parseMessage(":tmi.twitch.tv RECONNECT"), 10);
  assert.equal(rec.kind, "reconnect");

  const other = irc.toChatEvent(irc.parseMessage(":x.y 372 foo :-"), 1);
  assert.equal(other.kind, "other");
  assert.equal(other.command, "372");

  const bad = irc.toChatEvent(null);
  assert.equal(bad, null);
});

/* --------------------------------------------------------- formatting */

test("formatMessage builds lines with escaping and trailing colons", () => {
  assert.equal(irc.formatMessage("PASS", ["oauth:abc"]), "PASS oauth:abc");
  assert.equal(irc.formatMessage("JOIN", ["#dallas"]), "JOIN #dallas");
  assert.equal(irc.formatMessage("PRIVMSG", ["#dallas", "hello"]), "PRIVMSG #dallas :hello");
  assert.equal(irc.formatMessage("CAP", ["REQ", "twitch.tv/tags twitch.tv/commands"]), "CAP REQ :twitch.tv/tags twitch.tv/commands");
  assert.equal(
    irc.formatMessage("PRIVMSG", ["#dallas", "hi"], { "reply-parent-msg-id": "abc 1" }),
    "@reply-parent-msg-id=abc\\s1 PRIVMSG #dallas :hi"
  );
});

test("formatMessage trailing-param rules: exact wire strings, no CRLF", () => {
  const cases = [
    [["PART", ["#chan"]], "PART #chan"],
    [["PART", ["#chan", "bye"]], "PART #chan :bye"],
    [["JOIN", ["#chan"]], "JOIN #chan"],
    [["PRIVMSG", ["#chan", "hi there"]], "PRIVMSG #chan :hi there"],
    [["PRIVMSG", ["#chan", "hi"]], "PRIVMSG #chan :hi"],
    [["QUIT", ["bye"]], "QUIT :bye"],
  ];
  for (const [args, expected] of cases) {
    const line = irc.formatMessage(args[0], args[1]);
    assert.equal(line, expected);
    assert.ok(!line.includes("\r"), "no CR in " + line);
    assert.ok(!line.includes("\n"), "no LF in " + line);
  }
  assert.equal(irc.formatMessage("NOTICE", ["#chan", "note"]), "NOTICE #chan :note");
  assert.equal(irc.formatMessage("USERNOTICE", ["#chan", "sub"]), "USERNOTICE #chan :sub");
  assert.equal(irc.formatMessage("TOPIC", ["#chan", "new topic"]), "TOPIC #chan :new topic");
});

/* ------------------------------------------------------------- client */

test("client sends exact handshake anonymously", () => {
  const h = harness();
  const p = h.client.connect({ channel: "twitch" });
  const s = h.sockets[0];
  openSocket(s);
  assert.deepEqual(s.sent, [
    "CAP REQ :twitch.tv/tags twitch.tv/commands\r\n",
    "NICK justinfan55555\r\n",
    "JOIN #twitch\r\n",
  ]);
  feed(s, ":tmi.twitch.tv 001 justinfan55555 :Welcome, GLHF!");
  return p.then(() => assert.equal(h.client.state, "connected"));
});

test("client sends exact handshake authenticated and avoids double oauth:", () => {
  const h = harness();
  h.client.connect({ token: "abc123", login: "mybot", channel: "dallas" });
  const s = h.sockets[0];
  openSocket(s);
  assert.deepEqual(s.sent.slice(0, 2), [
    "CAP REQ :twitch.tv/tags twitch.tv/commands\r\n",
    "PASS oauth:abc123\r\n",
  ]);
  assert.deepEqual(s.sent.slice(2), ["NICK mybot\r\n", "JOIN #dallas\r\n"]);

  const h2 = harness();
  h2.client.connect({ token: "oauth:xyz", login: "bot2" });
  const s2 = h2.sockets[0];
  openSocket(s2);
  assert.equal(s2.sent[1], "PASS oauth:xyz\r\n");
});

test("client replies PONG to PING with the payload", () => {
  const { h, s } = connectedAuth();
  feed(s, "PING :tmi.twitch.tv");
  assert.ok(s.sent.includes("PONG :tmi.twitch.tv\r\n"));
});

test("client queues JOIN/PART/PRIVMSG before 001 and flushes after", () => {
  const h = harness();
  h.client.connect({ token: "t", login: "b", channel: "dallas" });
  const s = h.sockets[0];
  openSocket(s);
  assert.equal(h.client.say("hello before 001"), true);
  h.client.join("foo");
  h.client.part("bar", "bye");
  assert.equal(s.sent.length, 4); // nothing flushed yet
  feed(s, ":tmi.twitch.tv 001 b :Welcome");
  assert.deepEqual(s.sent.slice(4), [
    "PRIVMSG #dallas :hello before 001\r\n",
    "JOIN #foo\r\n",
    "PART #bar :bye\r\n",
  ]);
});

test("client says sends PRIVMSG, /me as ACTION, refuses without token", () => {
  const { h, s } = connectedAuth();
  assert.equal(h.client.say("hello chat"), true);
  assert.ok(s.sent.includes("PRIVMSG #dallas :hello chat\r\n"));

  assert.equal(h.client.say("/me waves"), true);
  assert.ok(s.sent.includes("PRIVMSG #dallas :\u0001ACTION waves\u0001\r\n"));

  const anon = harness();
  anon.client.connect({ channel: "x" });
  const as = anon.sockets[0];
  openSocket(as);
  feed(as, ":tmi.twitch.tv 001 x :Welcome");
  assert.equal(anon.client.say("nope"), false);
});

test("client splits long messages at 500 chars", () => {
  const { h, s } = connectedAuth();
  const long = "x".repeat(1200);
  assert.equal(h.client.say(long), true);
  const privmsgs = s.sent.filter((d) => d.startsWith("PRIVMSG #dallas :"));
  assert.equal(privmsgs.length, 3);
  for (const msg of privmsgs) {
    assert.ok(msg.length <= 500 + "PRIVMSG #dallas :\r\n".length);
  }
});

test("client state transitions and rejects on close before 001", async () => {
  const h = harness();
  const p = h.client.connect({ channel: "x" });
  const s = h.sockets[0];
  openSocket(s);
  assert.equal(h.client.state, "connecting");
  s.onclose({ reason: "eof" });
  await assert.rejects(p, /closed before/);
  assert.equal(h.client.state, "closed");
});

test("client reconnects with exponential backoff on unexpected close", () => {
  const { h, s } = connectedAuth();
  s.onclose({ reason: "eof" });
  assert.equal(h.client.state, "reconnecting");
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 1000);
  h.timers[0].fn(); // fire backoff
  assert.equal(h.sockets.length, 2);
  const s2 = h.sockets[1];
  assert.equal(s2.sent.length, 0);
  openSocket(s2);
  assert.deepEqual(s2.sent, [
    "CAP REQ :twitch.tv/tags twitch.tv/commands\r\n",
    "PASS oauth:abc123\r\n",
    "NICK mybot\r\n",
    "JOIN #dallas\r\n",
  ]);
});

test("client reconnects immediately on RECONNECT and re-authenticates", () => {
  const { h, s } = connectedAuth();
  feed(s, ":tmi.twitch.tv RECONNECT");
  assert.equal(h.sockets.length, 2);
  const s2 = h.sockets[1];
  openSocket(s2);
  assert.deepEqual(s2.sent[1], "PASS oauth:abc123\r\n");
  feed(s2, ":tmi.twitch.tv 001 mybot :Welcome");
  assert.equal(h.client.state, "connected");
});

test("client disconnect does not reconnect", () => {
  const { h, s } = connectedAuth();
  const before = h.sockets.length;
  h.client.disconnect();
  assert.equal(h.client.state, "closed");
  assert.equal(h.sockets.length, before);
  assert.equal(h.timers.length, 0);
});

test("client emits raw/event/notice and state events", () => {
  const events = [];
  const h = harness();
  h.client.on("event", (e) => events.push(e.kind));
  h.client.on("notice", (e) => events.push("notice:" + e.kind));
  const raw = [];
  h.client.on("raw", (l) => raw.push(l));
  const states = [];
  h.client.on("state", (s) => states.push(s));
  h.client.connect({ channel: "x" });
  const s = h.sockets[0];
  openSocket(s);
  feed(s, ":tmi.twitch.tv 001 x :Welcome");
  feed(s, "@msg-id=subgift :tmi.twitch.tv NOTICE #x :A gifted sub");
  assert.deepEqual(states, ["connecting", "connected"]);
  assert.ok(raw.some((l) => l.includes("NOTICE")));
  assert.ok(events.includes("notice"));
  assert.ok(events.includes("notice:notice"));
});
