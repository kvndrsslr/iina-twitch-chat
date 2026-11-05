#!/usr/bin/env node
/* Checks the payload after IINA's installer unpack: required Info.json fields,
 * entry files, and (in the Makefile) that packaged bytes match the working tree.
 * Usage: node scripts/verify-package.js <unpacked-plugin-dir>
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = process.argv[2];
if (!root) {
  console.error("verify: usage: node scripts/verify-package.js <plugin-dir>");
  process.exit(1);
}

const bad = (m) => {
  console.error("verify: FAIL - " + m);
  process.exit(1);
};

let j;
try {
  j = JSON.parse(fs.readFileSync(path.join(root, "Info.json"), "utf8"));
} catch (e) {
  bad("cannot read Info.json: " + e.message);
}

for (const k of ["name", "identifier", "version", "entry"]) {
  if (typeof j[k] !== "string" || j[k].length === 0) bad("Info.json has no string " + k);
}
if (!j.author || typeof j.author.name !== "string" || j.author.name.length === 0) {
  bad("Info.json has no author.name");
}
if (!j.identifier.split(".").every((s) => s.length > 0 && [...s].every((c) => /[A-Za-z0-9_-]/.test(c)))) {
  bad("identifier is not reverse-DNS");
}
if (!fs.existsSync(path.join(root, j.entry))) bad("entry file " + j.entry + " is missing");
if (
  typeof j.globalEntry === "string" &&
  j.globalEntry.length > 0 &&
  !fs.existsSync(path.join(root, j.globalEntry))
) {
  bad("globalEntry file " + j.globalEntry + " is missing");
}

console.log("verify: Info.json required fields decode");
