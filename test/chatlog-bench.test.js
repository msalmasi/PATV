// CL2 tools/chatlog-bench.js, small: the archive's real DDL with a few thousand synthetic rows; every read path's query has the
// planned shape (EXPLAIN QUERY PLAN): history pages on chat_log_room with both c bounds, floors and at= on chat_log_room_ts,
// search through the FTS index with rowid bounds and chat_log by its primary key, the drift counts on primary-key ranges, the
// duplicate checks on chat_log_eid / chat_log_tx, the per-login tool on chat_log_who - never a scan of chat_log. Timings are
// printed by the tool itself at full size (node tools/chatlog-bench.js --rows=2000000); they are not asserted.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-bench.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-bench-test-")));
delete process.env.CHATLOG_DB;
const B = require(path.join(repo, "tools", "chatlog-bench"));

test("every archive query has its planned shape (no scan of chat_log, no temp sort)", async () => {
  const lines = [];
  const r = await B.run({ rows: 6000, log: (s) => lines.push(s) });
  assert.equal(r.rows, 6000);
  const bad = Object.entries(r.shapes).filter(([, ok]) => !ok).map(([k]) => `${k}: ${r.plans[k].join(" | ")}`);
  assert.deepEqual(bad, [], "query plans");
  for (const k of ["history_page", "history_after", "history_hidden", "search_room_token", "search_post_filter", "search_last_prefix", "search_from",
    "search_single_prefix", "search_single_exact", "search_hidden", "search_from_fts", "like_window"]) {
    assert.ok(!r.plans[k].some((d) => /TEMP B-TREE/.test(d)), `${k} reads in index order: ${r.plans[k].join(" | ")}`);
  }
  assert.match(r.plans.history_page.join(" "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/, "both cursor bounds");
  // CL8: chatloghist's real page query (the per-class floors in a CASE never split it into rowid ranges), both directions
  assert.match(r.plans.history_after.join(" "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/, "oldest first: both bounds too");
  assert.match(r.plans.history_start.join(" "), /chat_log_room \(rk=\? AND c<\?\)/, "the start-of-history probe");
  // CL8 fix-up: the hidden set's NOT IN lists stay residual filters - the page still walks chat_log_room between both bounds
  assert.match(r.plans.history_hidden.join(" "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/, "with the hidden lists: both bounds");
  assert.match(r.plans.search_room_token.join(" "), /SEARCH l USING INTEGER PRIMARY KEY/);
  // CL9: chatlogsearch's real queries - the index always drives (never chat_log_who / chat_log_room for From or the room), and the
  // LIKE fallback's window reads chat_log_room with both cursor bounds
  for (const k of ["search_room_token", "search_post_filter", "search_last_prefix", "search_single_prefix", "search_single_exact", "search_hidden", "search_from_fts"]) {
    assert.match(r.plans[k][0], /^SCAN f VIRTUAL TABLE INDEX/, `${k}: the FTS index first: ${r.plans[k].join(" | ")}`);
    assert.ok(!r.plans[k].some((d) => /chat_log_(who|room)\b/.test(d)), `${k}: no chat_log index drives it: ${r.plans[k].join(" | ")}`);
  }
  // CL9 fix-up: From reads the speaker's own lines on chat_log_who, both c bounds, in index order (one statement per key)
  assert.match(r.plans.search_from.join(" "), /chat_log_who \(who=\? AND c>\? AND c<\?\)/, r.plans.search_from.join(" | "));
  assert.match(r.plans.like_window.join(" "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/, "the LIKE window: both cursor bounds");
  assert.match(r.plans.like_window_end.join(" "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/);
  assert.ok(Object.keys(r.rt).length === 4, "the room-token comparison is reported");
  // CL7: the retention purge walks a room's rows below the cutoff on chat_log_room_ts, oldest first, without a sort; the report's
  // day counts too; one delete batch is timed for the record
  for (const k of ["purge_scan_chat", "purge_scan_tx", "purge_count"]) {
    assert.match(r.plans[k].join(" "), /chat_log_room_ts \(rk=\? AND ts>\? AND ts<\?\)/, `${k}: ${r.plans[k].join(" | ")}`);
    assert.ok(!r.plans[k].some((d) => /TEMP B-TREE/.test(d)), `${k} reads in index order: ${r.plans[k].join(" | ")}`);
  }
  assert.ok(r.purge && r.purge.rows > 0 && r.purge.ms >= 0, "a purge batch was timed");
  assert.ok(lines.some((l) => /every|ok/.test(l)));
});
