// 1.99?? (privacy controls, review 5 - the independent review of round 4 and S3; G:/ops/privacy-controls-spec-2026-11-02.md section 5
// "S3"). The pure mic-stage engine (micfollow-core.js) on a fake clock, and the English locale file:
//   opted_out   with micfollow_cfg withheld_cover on, a hold / relay of a mic holder that Pepe refuses "opted_out" (his own opt-out list
//               can be ahead of the site's: a room line's !livecam off, a sync on its way) is the withheld card - and stays it: no new
//               hold every step (the site's rules still say ok), one more try per consent cooldown (cooldown_s), the cadence a CUT gave
//               with the switch off; never a still meanwhile
//   still       ... a still of theirs goes at once (still_stop), as the cut took it with the switch off
//   off         the switch off: a CUT and its cooldown, exactly as before
//   en.json     no staging line rewritten by the S3 commit (mf.notice.once_title keeps its "key": "value" spacing)
//   node --test test/privm-review5.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
delete process.env.STAGING;
const repo = path.resolve(__dirname, "..");

test("S3 review 5: en.json - the S3 commit rewrites no staging line (every entry keeps the \"key\": \"value\" spacing)", () => {
  const lines = fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8").split(/\r?\n/);
  const bad = lines.filter((l) => /^ {2}"[^"]+":(?! )/.test(l));
  assert.deepEqual(bad.map((l) => l.slice(0, 40)), [], "entries without the space after the colon");
  assert.ok(lines.includes('  "mf.notice.once_title": "🎙 Pads on PATV may show your cam while you hold the mic",'), "once_title as staging has it");
});
