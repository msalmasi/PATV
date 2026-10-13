#!/usr/bin/env node
// tools/feedfilter-lists.js — the content filter's built-in word lists (feedfilter.js, data/feedfilter-lists.json).
// The file is base64-encoded JSON so the slur list isn't plain text in this public repo. Keep the plain copy OUT of
// the repo (a temp folder); admins can also edit the live lists from /feed/admin/filter (stored in the DB, not here).
//   node tools/feedfilter-lists.js decode > /tmp/lists.json      # the plain lists
//   node tools/feedfilter-lists.js encode /tmp/lists.json        # write data/feedfilter-lists.json (checks it compiles)
//   node tools/feedfilter-lists.js test "some text"              # what the built-in lists catch
"use strict";
const fs = require("fs");
const F = require("../feedfilter");

const [cmd, arg] = process.argv.slice(2);
if (cmd === "decode") {
  process.stdout.write(JSON.stringify(F.decodeFile(JSON.parse(fs.readFileSync(F.LIST_FILE, "utf8"))), null, 1) + "\n");
} else if (cmd === "encode" && arg) {
  const lists = F.cleanLists(JSON.parse(fs.readFileSync(arg, "utf8")));
  const bad = F.listProblem(lists);
  if (bad) { console.error("Doesn't compile: " + bad); process.exit(1); }
  fs.writeFileSync(F.LIST_FILE, JSON.stringify(F.encodeFile({ v: 1, ...lists }), null, 1) + "\n");
  console.log("wrote " + F.LIST_FILE + ": " + F.LIST_KEYS.map((k) => k + "=" + lists[k].length).join(" "));
} else if (cmd === "test" && arg != null) {
  console.log(JSON.stringify(F.scan(arg), null, 1));
} else {
  console.error("usage: feedfilter-lists.js decode | encode <plain.json> | test <text>");
  process.exit(2);
}
