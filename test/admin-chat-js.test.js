// S1 V1 (after its review): /admin/chat's PAGE SCRIPT (public/js/admin-chat.js), run in a vm with a small fake DOM and a
// mocked fetch. The server enforces the confirm step; this pins the page's half of it: a first post to turn anything ON never
// carries confirm, the question is asked with the server's preview, only a yes posts again with confirm: true, a no posts
// nothing more; turning OFF is one post; a reason is asked for when the field is empty; refusals read in the page's language.
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-chat-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "admin-chat.js"), "utf8");
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
const tick = () => new Promise((r) => setTimeout(r, 15));

function msgEl() { return { textContent: "", className: "" }; }
function button(attrs) {
  const msg = msgEl();
  const b = { disabled: false, attrs, msg,
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    getAttribute(k) { return this.hasAttribute(k) ? this.attrs[k] : null; },
    closest() { return this; } };
  b.parentNode = { querySelector: (s) => (s === ".adm-msg" ? msg : null) };
  return b;
}

/** Boot the script. replies: what the mocked fetch answers, in order; confirmAnswer: the window.confirm answer. */
function boot({ replies = [], reason = "rollback", confirmAnswer = true, promptAnswer = "", pad = "", withT = false } = {}) {
  const els = { acReason: { value: reason }, acMovePad: { value: pad } };
  let onClick = null;
  const document = { getElementById: (id) => els[id] || null, addEventListener: (t, f) => { if (t === "click") onClick = f; } };
  const posts = [], asked = [], prompts = [], timers = [];
  const queue = replies.slice();
  const fetch = (p, o) => {
    posts.push({ p, body: JSON.parse(o.body), headers: o.headers, method: o.method, credentials: o.credentials });
    const j = queue.length ? queue.shift() : { ok: true, changed: true };
    return Promise.resolve({ json: () => Promise.resolve(j) });
  };
  const window = {
    confirm: (q) => { asked.push(q); return confirmAnswer; },
    prompt: (q) => { prompts.push(q); return promptAnswer; },
  };
  if (withT) {
    window.__t = (k, d, v) => {
      const s = EN[k] != null && EN[k] !== "" ? EN[k] : d;
      return String(s).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m));
    };
  }
  vm.runInNewContext(SRC, { document, fetch, window, location: { reload() {} }, setTimeout: (f) => { timers.push(f); }, console });
  const click = (b) => onClick({ target: b });
  return { els, posts, asked, prompts, click };
}

test("turning the chat hub ON: the first post carries no confirm; the server's preview is asked; a yes posts again with confirm: true", async () => {
  const P = { ok: false, code: "confirm", error: "Confirm turning the chat hub on.", preview: { pads: ["Staff room"], n: 1 } };
  const s = boot({ replies: [P, { ok: true, changed: true, value: "on" }] });
  const b = button({ "data-hub-on": "1" });
  s.click(b);
  await tick();
  assert.equal(s.posts.length, 2);
  assert.deepEqual(s.posts[0].body, { on: true, reason: "rollback" }, "no confirm on the first post");
  assert.equal(s.posts[0].p, "/api/admin/chat/hub");
  assert.equal(s.posts[0].method, "POST");
  assert.equal(s.posts[0].credentials, "same-origin");
  assert.equal(s.posts[0].headers["X-Requested-With"], "fetch");
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], /Staff room/, "asked with the server's preview");
  assert.deepEqual(s.posts[1].body, { on: true, reason: "rollback", confirm: true });
  assert.equal(b.msg.textContent, "Saved.");
});

test("a no at the confirm step posts nothing more", async () => {
  const s = boot({ confirmAnswer: false, replies: [{ ok: false, code: "confirm", preview: { pads: [], n: 0 } }] });
  s.click(button({ "data-hub-on": "1" }));
  await tick();
  assert.equal(s.posts.length, 1);
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], /No pad is on the hub yet/);
});

test("a pad to the hub: the same confirm step (the pad picked in the list), and a pad back to v1 is one post", async () => {
  const s = boot({ pad: "patv:staff", replies: [{ ok: false, code: "confirm", preview: { title: "Staff room", slug: "staff", chat_hub: true } }, { ok: true, changed: true }] });
  s.click(button({ "data-pad-backend": "hub" }));
  await tick();
  assert.deepEqual(s.posts.map((x) => x.body), [{ room_id: "patv:staff", backend: "hub", reason: "rollback" },
                                                 { room_id: "patv:staff", backend: "hub", reason: "rollback", confirm: true }]);
  assert.match(s.asked[0], /Move Staff room to the chat hub\? The chat hub is on/);
  const t = boot();
  t.click(button({ "data-pad-backend": "v1", "data-room": "patv:canary" }));
  await tick();
  assert.deepEqual(t.posts.map((x) => [x.p, x.body]), [["/api/admin/chat/pad", { room_id: "patv:canary", backend: "v1", reason: "rollback" }]]);
  assert.equal(t.asked.length, 0, "no question to go back");
  const u = boot({ pad: "" });
  const mb = button({ "data-pad-backend": "hub" });
  u.click(mb);
  await tick();
  assert.equal(u.posts.length, 0);
  assert.equal(mb.msg.textContent, "Pick a pad first.");
});

test("turning the chat hub OFF is one post, never a question; an empty reason is asked for, and none posts nothing", async () => {
  const s = boot({ replies: [{ ok: true, changed: true, value: "off" }] });
  s.click(button({ "data-hub-on": "0" }));
  await tick();
  assert.deepEqual(s.posts.map((x) => x.body), [{ on: false, reason: "rollback" }]);
  assert.equal(s.asked.length, 0);
  const t = boot({ reason: "  ", promptAnswer: "" });
  const b = button({ "data-hub-on": "0" });
  t.click(b);
  await tick();
  assert.equal(t.prompts.length, 1);
  assert.equal(t.posts.length, 0);
  assert.equal(b.msg.textContent, "Type a reason first.");
  const u = boot({ reason: "", promptAnswer: "hub errors" });
  u.click(button({ "data-hub-on": "0" }));
  await tick();
  assert.deepEqual(u.posts[0].body, { on: false, reason: "hub errors" });
  assert.equal(u.els.acReason.value, "hub errors", "kept for the next change");
  const d = button({ "data-hub-on": "0" });
  d.disabled = true;
  u.click(d);
  await tick();
  assert.equal(u.posts.length, 1, "a disabled button does nothing");
});

test("refusals: a known code reads from js.admchat.e.<code> (the missing switches filled in), an unknown one shows the server's text", async () => {
  const s = boot({ withT: true, replies: [{ ok: false, code: "chat_hub_needs", missing: ["pads", "roles"], error: "server words" }] });
  const b = button({ "data-hub-on": "1" });
  s.click(b);
  await tick();
  assert.equal(b.msg.textContent, EN["js.admchat.e.chat_hub_needs"].replace("{list}", "pads, roles"));
  assert.match(b.msg.className, /err/);
  const t = boot({ withT: true, replies: [{ ok: false, code: "something_new", error: "server words" }] });
  const c = button({ "data-hub-on": "0" });
  t.click(c);
  await tick();
  assert.equal(c.msg.textContent, "server words");
  // without the page's translations (no window.__t) the server's own text
  const u = boot({ replies: [{ ok: false, code: "owner_only", error: "Only a Pepe owner turns the chat hub on." }] });
  const e = button({ "data-hub-on": "1" });
  u.click(e);
  await tick();
  assert.equal(e.msg.textContent, "Only a Pepe owner turns the chat hub on.");
  for (const code of ["cross_site", "auth", "admin_only", "owner_only", "reason_required", "bad_request", "bad_backend", "hub_read_s2", "no_pad",
                      "site_pads_only", "chat_hub_needs", "internal"]) {
    assert.ok(EN["js.admchat.e." + code], code);
    assert.ok(SRC.includes("'" + code + "'"), "the page knows " + code);
  }
});
