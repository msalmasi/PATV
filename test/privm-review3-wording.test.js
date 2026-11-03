// 1.99?? (privacy controls, round 3 - the final verify's F3 wording; G:/ops/privacy-controls-spec-2026-11-02.md section 8 and the
// owner's 22:05Z "yes": staff, pad owners and room mods may reveal text too - S4t, switch text_reveal_roles). Rendered pages, the switches
// as the views get them:
//   F3  /privacy section 9's row names who reveals (PATV administrators and staff, pad owners and room moderators) while text reveal roles
//       are on; the S4t "Who can see through it" bullet has no double space in any combination; /admin/bridge's transcripts-bar card
//       names staff and mods while text reveal roles are on (trOn) and the text-reveal card no longer says the report queues stay as they are
//   every switch off: the sentences as before
//   node --test test/privm-review3-wording.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret";
const TERMS = require(path.join(repo, "terms"));
const D = (y, m, d) => Date.UTC(y, m - 1, d, 12);
const PFN = path.join(repo, "views", "privacy.ejs");
const strip = (h) => h.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
function privacy(extra) {
  const L0 = { user: null, title: "Privacy Policy", VERSION: TERMS.VERSION, UPDATED: TERMS.PRIVACY_UPDATED, enforced: false, chatlog: null,
               hubErasure: null, micrec: null, memory: null, privwire: { on: true, g: D(2026, 10, 28), g_day: "28 October 2026" }, evidence: null,
               policyDates: {}, ogBase: "http://test" };
  return ejs.render(fs.readFileSync(PFN, "utf8"), Object.assign(L0, extra || {}), { filename: PFN });
}
const ROW_OLD = "Log of reveals by pad owners and administrators";
const ROW_NEW = "Log of reveals by PATV administrators and staff, pad owners and room moderators";

test("F3: /privacy section 9's reveal-log row names every revealer while text reveal roles are on; off: as before", () => {
  const off = privacy({});
  assert.ok(off.includes(ROW_OLD) && !off.includes(ROW_NEW), "off: the row as before");
  const on = privacy({ textreveal: { on: true } });
  assert.ok(on.includes(ROW_NEW) && !on.includes(ROW_OLD), "on: staff and room moderators too");
  const both = privacy({ textreveal: { on: true }, camreveal: { on: true } });
  assert.ok(both.includes(ROW_NEW + ", and of moderation views of hidden cams"), "with cam reveals: the cam views too");
});

test("F3: the 'Who can see through it' bullet never has a double space - text reveal roles / cam reveals in every combination", () => {
  for (const textreveal of [null, { on: true }]) {
    for (const camreveal of [null, { on: true }]) {
      const html = privacy({ textreveal, camreveal, pv3: null });
      const li = (/<li><b>Who can see through it:<\/b>([\s\S]*?)<\/li>/.exec(html) || [])[1];
      assert.ok(li, "the bullet is there");
      assert.doesNotMatch(strip(li), / {2}/, `no double space (text ${!!textreveal}, cam ${!!camreveal}): ${strip(li)}`);
    }
  }
  const html = privacy({ textreveal: { on: true }, camreveal: null });
  assert.match(strip(html), /limited and watched\. Every reveal is logged and the log is kept for 180 days\./);
});

test("F3: /admin/bridge - the transcripts-bar card names staff and room moderators while text reveal roles are on (trOn); the text-reveal card's report-queue note", () => {
  const page = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.ok(page.includes("<% if (locals.trOn) { %>PATV admins and staff (every pad), a pad's owner and the room's moderators (their own pad) can reveal the words"),
            "the card's who-can-reveal sentence follows the switch");
  assert.ok(page.includes("<% } else { %>PATV admins, and a pad's owner in their own pad, can reveal the words (logged).<% } %>"), "off: as before");
  assert.ok(!page.includes("the report queues and Pepe's analytics notes stay as they are"), "the report queue's note changes with it now");
  const aw = fs.readFileSync(path.join(repo, "adminweb.js"), "utf8");
  assert.match(aw, /trOn: await safe\(\(\) => require\("\.\/textreveal"\)\.isOn\(\) === true, false\)/, "the page gets the switch");
});
