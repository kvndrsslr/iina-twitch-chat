"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const sf = require("../lib/strftime.js");

function date() {
  // Sunday, 18 October 2026, 21:03:12 local time.
  return new Date(2026, 9, 18, 21, 3, 12);
}

test("default twitch-tui format renders locale-independently", () => {
  assert.equal(sf.strftime("%a %b %e %T %Y", date()), "Sun Oct 18 21:03:12 2026");
});

test("day and month names are English", () => {
  const d = date();
  assert.equal(sf.strftime("%A %B", d), "Sunday October");
  assert.equal(sf.strftime("%a %b", d), "Sun Oct");
});

test("numeric padding: %e is space padded, %d zero padded", () => {
  const fifth = new Date(2026, 0, 5);
  assert.equal(sf.strftime("%e", fifth), " 5");
  assert.equal(sf.strftime("%d", fifth), "05");
  assert.equal(sf.strftime("%e %d", date()), "18 18");
});

test("composed specifiers", () => {
  const d = date();
  assert.equal(sf.strftime("%c", d), "Sun Oct 18 21:03:12 2026");
  assert.equal(sf.strftime("%F", d), "2026-10-18");
  assert.equal(sf.strftime("%T", d), "21:03:12");
  assert.equal(sf.strftime("%R", d), "21:03");
  assert.equal(sf.strftime("%r", d), "09:03:12 PM");
});

test("time specifiers", () => {
  const d = date();
  assert.equal(sf.strftime("%H %I %k %l %M %S %p %P", d), "21 09 21  9 03 12 PM pm");
});

test("calendar specifiers", () => {
  const d = date();
  assert.equal(sf.strftime("%Y %C %y %m %d %u %w", d), "2026 20 26 10 18 7 0");
  const sunday = new Date(2021, 7, 8); // Sunday 2021-08-08
  assert.equal(sf.strftime("%u", sunday), "7");
  assert.equal(sf.strftime("%w", sunday), "0");
});

test("day-of-year, week numbers", () => {
  assert.equal(sf.strftime("%j", new Date(2026, 0, 1)), "001");
  assert.equal(sf.strftime("%j", new Date(2024, 1, 1)), "032"); // leap year
  assert.equal(sf.strftime("%U", new Date(2026, 0, 1)), "00"); // Thu
  assert.equal(sf.strftime("%V", new Date(2021, 0, 1)), "53"); // ISO 53
});

test("%s is Unix seconds independent of timezone", () => {
  assert.equal(sf.formatTimestamp(0, "%s"), "0");
  assert.equal(sf.strftime("%s", new Date(0)), "0");
});

test("%z and %Z derive from the Date object", () => {
  const d = date();
  assert.match(sf.strftime("%z", d), /^[+-]\d{4}$/);
  assert.match(sf.strftime("%Z", d), /^[A-Z]{2,5}$|^GMT[+-]\d{4}$/);
});

test("literal output specifiers", () => {
  assert.equal(sf.strftime("%n", date()), "\n");
  assert.equal(sf.strftime("%t", date()), "\t");
  assert.equal(sf.strftime("%%", date()), "%");
  assert.equal(sf.strftime("%f", date()), "000000");
});

test("unknown specifiers are emitted literally", () => {
  assert.equal(sf.strftime("%q", date()), "%q");
  assert.equal(sf.strftime("100%q%", date()), "100%q%");
});

test("formatTimestamp converts ms to a date", () => {
  const d = date();
  assert.equal(sf.formatTimestamp(d.getTime(), "%a %b %e %T %Y"), "Sun Oct 18 21:03:12 2026");
  assert.equal(sf.formatTimestamp(NaN, "%Y"), "");
});
