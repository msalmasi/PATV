// 1.99?? roompm: review (privacy) - Pepe's private answers in a pad's chat must reach ONLY their account, and nothing of them may
// outlive what the owner was promised (24 h, gone with the account):
//   * a shared computer: the page drops what it shows when the site stops sending this viewer's block (signed out, switched off)
//     or sends another account's (rpm.w, a per-account tag that is only ever sent to that account) - never one account's answers
//     under another's sign-in; a page put in the back/forward cache drops them too
//   node --test test/roompm-review-privacy.test.js      (a scratch database; no network)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roompm-review-privacy-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const RPM = require(path.join(repo, "roompm"));
const RPM_SRC = fs.readFileSync(path.join(repo, "public", "js", "pad-roompm.js"), "utf8");

const SECRET = "QUOKKA-5531-private";
const typed = (id, userId, roomId = "Pm.Room", text = "!spin") => ({ id, kind: "cmd", userId, roomId, text });
const deep = (x) => JSON.stringify(x, (k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v));

test.before(async () => { await RPM.init(); });

// ── the server's block ──
test("rpm.w: a tag of the viewer's own account - the same for its every answer, another account's differs, never the account id", () => {
  RPM._reset();
  const a1 = RPM.view("u1", "Pm.Room", 0), a2 = RPM.view("u1", "Other.Room", 5), b = RPM.view("u2", "Pm.Room", 0);
  assert.equal(a1.on, 1);
  assert.equal(typeof a1.w, "string");
  assert.match(a1.w, /^[A-Za-z0-9_-]{8,32}$/);
  assert.equal(a1.w, a2.w, "one account: one tag (every pad, every cursor)");
  assert.notEqual(a1.w, b.w, "another account: another tag");
  assert.ok(!a1.w.includes("u1"), "not the account id");
});

// ── the page (pad-roompm.js on its own, in a small fake DOM) ──
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.childNodes = []; this.parentNode = null; this._cls = []; this.style = { setProperty() {} }; }
  get classList() {
    const me = this;
    return { add: (...c) => c.forEach((x) => { if (!me._cls.includes(x)) me._cls.push(x); }), remove: (...c) => { me._cls = me._cls.filter((x) => !c.includes(x)); },
             contains: (c) => me._cls.includes(c), toggle: (c, on) => { const want = on === undefined ? !me._cls.includes(c) : !!on; me._cls = me._cls.filter((x) => x !== c); if (want) me._cls.push(c); return want; } };
  }
  set className(v) { this._cls = String(v).split(/\s+/).filter(Boolean); }
  get className() { return this._cls.join(" "); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get textContent() { return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join(""); }
  set textContent(v) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = v ? [{ nodeType: 3, data: String(v), parentNode: this }] : []; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); return n;
  }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  querySelector(sel) { const c = sel.replace(/^\./, ""); for (const k of this.childNodes) { if (k.nodeType === 1 && k._cls.includes(c)) return k; } return null; }
}
function pageModule() {
  const listeners = {};
  const doc = { createElement: (t) => new El(t) };
  const win = { document: doc, JSON, Math, Date, String, Number, Array, Object, addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  win.window = win;
  vm.runInContext(RPM_SRC, vm.createContext(win), { filename: "pad-roompm.js" });
  const feed = new El("div"), root = new El("main");
  let c = 0;
  const line = (it) => { const n = new El("div"); n.className = "line"; n.setAttribute("data-c", String(++c)); const lt = new El("div"); lt.className = "line-text"; lt.textContent = it.text; n.appendChild(lt); return n; };
  const pm = win.PATVRoomPm.init({ feed, line, root, nearBottom: () => false, toBottom() {} });
  const fire = (t, e) => (listeners[t] || []).forEach((fn) => fn(e || {}));
  return { pm, feed, root, fire, shown: () => feed.childNodes.filter((n) => n._rpm).map((n) => n.textContent) };
}
const row = (id, text) => ({ id, ts: Date.now() - 1000, text, cmd: "!balance" });

test("a shared computer: signed out (no block) - the page drops the private answers it showed, and asks again from the start", () => {
  const P = pageModule();
  P.pm.update({ rpm: { on: 1, w: "aaaa1111", v: 2, rows: [row(1, "Your balance: PAT 9,999 " + SECRET), row(2, "usage: !topic")] } });
  assert.equal(P.shown().length, 2);
  assert.equal(P.pm.query(), "&rpm=2");
  P.pm.update({ feed: [] });                       // the next answer after the sign-out: no rpm block
  assert.deepEqual(P.shown(), [], "nothing of the signed-out account stays on the screen");
  assert.equal(P.root.classList.contains("rpm-on"), false);
  assert.equal(P.pm.query(), "&rpm=0");
});

test("the site switched them off ({on: 0}): the lines already shown go too", () => {
  const P = pageModule();
  P.pm.update({ rpm: { on: 1, w: "aaaa1111", v: 1, rows: [row(1, SECRET)] } });
  P.pm.update({ rpm: { on: 0 } });
  assert.deepEqual(P.shown(), []);
});

test("another account signed in under the open page (rpm.w changed): the first account's answers go, the new one's show", () => {
  const P = pageModule();
  P.pm.update({ rpm: { on: 1, w: "aaaa1111", v: 5, rows: [row(4, "Alice: your balance PAT 9,999 " + SECRET), row(5, "Alice: usage")] } });
  assert.equal(P.shown().length, 2);
  // Bob signs in in another tab; this tab's next answer is Bob's (asked from Alice's cursor: only Bob's newer rows came)
  P.pm.update({ rpm: { on: 1, w: "bbbb2222", v: 7, rows: [row(7, "Bob: you won PAT 50")] } });
  const s = P.shown();
  assert.ok(!s.some((t) => /Alice|QUOKKA/.test(t)), "none of Alice's: " + JSON.stringify(s));
  assert.ok(s.some((t) => /Bob: you won PAT 50/.test(t)));
  assert.equal(P.pm.query(), "&rpm=0", "Bob's older answers come with the next answer (asked from the start)");
  P.pm.update({ rpm: { on: 1, w: "bbbb2222", v: 7, rows: [row(6, "Bob: earlier"), row(7, "Bob: you won PAT 50")] } });
  assert.equal(P.shown().length, 2, "Bob's two, each once");
  assert.equal(P.pm.query(), "&rpm=7");
});

test("a page going into the back/forward cache drops them (a Back after signing out never shows them)", () => {
  const P = pageModule();
  P.pm.update({ rpm: { on: 1, w: "aaaa1111", v: 1, rows: [row(1, SECRET)] } });
  P.fire("pagehide", { persisted: true });
  assert.deepEqual(P.shown(), []);
  assert.equal(P.pm.query(), "&rpm=0");
});
