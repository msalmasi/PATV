// 1.99aoj review: /admin/casino/owed's PAGE SCRIPT (public/js/admin-owed.js), run in a vm with a small fake DOM and a mocked fetch (the
// server side is test/casino-owed-admin.test.js):
//   * every answer goes on the item's OWN status line, beside its buttons, scrolled into view (the list's status line at the top was
//     out of view on a phone: a wrong password or an unknown username changed nothing visible); after the list is redrawn the line
//     follows the item, or the list's line takes it (scrolled into view) when the item is gone
//   * the password is cleared only after it was used (a success, a wrong password) - another refusal keeps it for the resubmit
//   * a recipient that is site-banned / scheduled for deletion (E_TO_LOCKED): "Pay this account anyway" appears, unticked; ticked, the
//     resubmit carries locked_ok: true; another name hides and unticks it again
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-owed-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "admin-owed.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 20));

function El(props) {
  return Object.assign({ textContent: "", className: "", hidden: false, disabled: false, dataset: {}, value: "", checked: false, scrolled: 0, _l: {},
                         scrollIntoView() { this.scrolled += 1; }, focus() {}, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } }, props || {});
}
/** one drawn item (<article class="owed-item">) with its buttons, its two forms and its status line */
function makeArt(id, table, amount) {
  const art = El({ dataset: { id, table, amount: String(amount) } });
  art.msg = El({ className: "adm-msg owed-msg" });
  const mkForm = (op, redirect) => {
    const f = El({ hidden: true, dataset: { op } });
    f.to = redirect ? El({ name: "to" }) : null;
    f.reason = El({ name: "reason" });
    f.pw = El({ name: "password", type: "password" });
    f.cb = redirect ? El({ name: "locked_ok", type: "checkbox" }) : null;
    f.box = redirect ? El({ hidden: true, dataset: {}, querySelector: (s) => (s === "input[type=checkbox]" ? f.cb : null) }) : null;
    f.submit = El({ type: "submit" });
    f.querySelector = (s) => (s === "input" ? f.to || f.reason : s === "input[name=locked_ok]" ? f.cb : s === "button[type=submit]" ? f.submit : s === "input[type=password]" ? f.pw : null);
    f.closest = (s) => (s === ".owed-form" ? f : s === ".owed-item" ? art : null);
    f._entries = () => [...(f.to ? [["to", f.to.value]] : []), ["reason", f.reason.value], ["password", f.pw.value], ...(f.cb && f.cb.checked ? [["locked_ok", "on"]] : [])];
    for (const x of [f.to, f.reason, f.pw, f.cb, f.submit].filter(Boolean)) x.closest = (s) => (s === ".owed-item" ? art : s === ".owed-form" ? f : s === "button" && x === f.submit ? x : null);
    return f;
  };
  art.forms = { redirect: mkForm("redirect", true), writeoff: mkForm("writeoff", false) };
  art.btn = {};
  for (const [k, ds] of [["retry", { op: "retry" }], ["redirect", { open: "redirect" }], ["writeoff", { open: "writeoff" }]]) {
    const b = El({ type: "button", dataset: ds });
    b.closest = (s) => (s === "button" ? b : s === ".owed-item" ? art : null);
    art.btn[k] = b;
  }
  art.querySelector = (s) => {
    if (s === ".owed-msg") return art.msg;
    if (s === ".owed-anyway") return art.forms.redirect.box;
    let m = /^\.owed-form\[data-op="(\w+)"\] input\[type=password\]$/.exec(s);
    if (m) return art.forms[m[1]] ? art.forms[m[1]].pw : null;
    m = /^\.owed-form\[data-op="(\w+)"\]$/.exec(s);
    if (m) return art.forms[m[1]] || null;
    throw new Error("unexpected selector " + s);
  };
  art.querySelectorAll = (s) => (s === ".owed-form" ? Object.values(art.forms) : []);
  return art;
}

function boot(items) {
  const st = { items, answers: [], posts: [], nonces: [] };
  let html = "";
  const list = El({ arts: [], getAttribute: (k) => (k === "data-owner" ? "1" : null) });
  Object.defineProperty(list, "innerHTML", {
    get() { return html; },
    set(v) {
      html = String(v);
      list.arts = [...html.matchAll(/<article class="owed-item" data-id="([^"]*)" data-table="([^"]*)" data-amount="([^"]*)">/g)].map((m) => makeArt(m[1], m[2], Number(m[3])));
    },
  });
  list.querySelector = (s) => {
    const m = /^\.owed-item\[data-id="([^"]*)"\]$/.exec(s);
    if (!m) throw new Error("unexpected selector " + s);
    return list.arts.find((a) => a.dataset.id === m[1]) || null;
  };
  const els = { owedList: list, owedStatus: El({ className: "adm-msg" }), owedCount: El(), owedRecentList: El() };
  const fetch = (url, o) => {
    const method = (o && o.method) || "GET";
    const body = o && o.body ? JSON.parse(o.body) : null;
    let j;
    if (method === "GET" && url === "/api/casino/admin/owed") j = { ok: true, items: st.items, recent: [], owner: true, now: 1 };
    else if (url === "/api/admin/stepup/nonce") { st.nonces.push(body); j = { ok: true, nonce: "n" + st.nonces.length }; }
    else if (url.startsWith("/api/casino/admin/owed/")) { st.posts.push({ op: url.split("/").pop(), body }); j = st.answers.shift() || { ok: false, error: "no answer queued" }; }
    else j = { ok: false, error: "404" };
    return Promise.resolve({ status: j.ok ? 200 : 409, json: () => Promise.resolve(JSON.parse(JSON.stringify(j))) });
  };
  function FormData(f) { this._e = f._entries(); }
  FormData.prototype.entries = function () { return this._e[Symbol.iterator](); };
  const window = { confirm: () => true, crypto: { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0; return b; } } };
  vm.runInNewContext(SRC, { window, document: { getElementById: (i) => els[i] || null }, fetch, FormData, console, setTimeout });
  const fire = (type, target) => (list._l[type] || []).forEach((f) => f({ target, preventDefault() {} }));
  return { st, els, list, fire, art: () => list.arts[0] };
}
const ITEM = { id: "0123456789abcdef", table: "abcdef0123", game: "bj", url: "/casino/blackjack/t/abcdef0123", kind: "payout", round: 1, what: "round 1 payout",
               member: { name: null, missing: true, ref: "a1b2c3d4" }, amount: 2000, since: 1, tries: 1, code: "E_TARGET_NOT_FOUND", next: 2, closing: true };

test("an answer goes on the item's own line, beside its buttons, and is scrolled into view - the list's top line stays quiet", async () => {
  const P = boot([ITEM]);
  await tick();
  assert.equal(P.list.arts.length, 1);
  // retry now, still refused: the list is redrawn (tries changed) - the line follows the item
  P.st.answers.push({ ok: false, code: "E_REFUSED", error: "Still refused (E_TARGET_NOT_FOUND) - it stays owed, and it is tried again automatically." });
  P.fire("click", P.art().btn.retry);
  await tick();
  assert.equal(P.st.posts[0].op, "retry");
  assert.deepEqual(Object.keys(P.st.posts[0].body).sort(), ["amount", "idem", "item", "table"]);
  const a = P.art();
  assert.match(a.msg.textContent, /Still refused/);
  assert.match(a.msg.className, /\berr\b/);
  assert.ok(a.msg.scrolled >= 1, "scrolled into view");
  assert.equal(P.els.owedStatus.textContent, "", "not (only) at the top of the list");
});

test("a wrong password: said beside the form (it used to show only at the list's top, out of view on a phone) and the password is cleared to type again", async () => {
  const P = boot([ITEM]);
  await tick();
  const a = P.art();
  P.fire("click", a.btn.redirect);
  const f = a.forms.redirect;
  assert.equal(f.hidden, false, "the form opens");
  Object.assign(f.to, { value: "bob" }); Object.assign(f.reason, { value: "member's new account" }); Object.assign(f.pw, { value: "secret-pw" });
  P.st.answers.push({ ok: false, code: "password", error: "Wrong password." });
  P.fire("submit", f);
  await tick();
  assert.deepEqual(P.st.nonces, [{ for: "casino_owed" }]);
  const b = P.st.posts[0].body;
  assert.equal(b.nonce, "n1");
  assert.equal(b.to, "bob");
  assert.equal(b.password, "secret-pw");
  assert.equal(b.locked_ok, undefined);
  assert.equal(a.msg.textContent, "Wrong password.");
  assert.ok(a.msg.scrolled >= 1);
  assert.equal(f.pw.value, "", "cleared: it was used");
  assert.equal(P.els.owedStatus.textContent, "");
});

test("another refusal (an unknown username) keeps the password, so the corrected resubmit works", async () => {
  const P = boot([ITEM]);
  await tick();
  const a = P.art();
  const f = a.forms.redirect;
  Object.assign(f.to, { value: "nobody" }); Object.assign(f.reason, { value: "member's new account" }); Object.assign(f.pw, { value: "secret-pw" });
  P.st.answers.push({ ok: false, code: "E_TO", error: "No account called nobody." });
  P.fire("submit", f);
  await tick();
  assert.equal(a.msg.textContent, "No account called nobody.");
  assert.match(a.msg.className, /\berr\b/);
  assert.equal(f.pw.value, "secret-pw", "kept");
  // a reason too short: refused on the page, beside the form
  f.reason.value = "short";
  P.fire("submit", f);
  await tick();
  assert.match(a.msg.textContent, /at least 8 characters/);
  assert.equal(P.st.posts.length, 1, "nothing sent");
});

test("a site-banned / deletion-scheduled recipient: 'Pay this account anyway' appears unticked; ticked, the resubmit says locked_ok: true; another name hides it again", async () => {
  const P = boot([ITEM]);
  await tick();
  const a = P.art();
  const f = a.forms.redirect;
  Object.assign(f.to, { value: "Bob" }); Object.assign(f.reason, { value: "member's new account" }); Object.assign(f.pw, { value: "secret-pw" });
  assert.equal(f.box.hidden, true);
  P.st.answers.push({ ok: false, code: "E_TO_LOCKED", lock: "ban", error: "bob is site-banned. Tick \"Pay this account anyway\" to pay it all the same." });
  P.fire("submit", f);
  await tick();
  assert.equal(f.box.hidden, false, "shown");
  assert.equal(f.cb.checked, false, "unticked");
  assert.match(a.msg.textContent, /site-banned/);
  // resubmitted unticked: no locked_ok
  P.st.answers.push({ ok: false, code: "E_TO_LOCKED", lock: "ban", error: "bob is site-banned." });
  P.fire("submit", f);
  await tick();
  assert.equal(P.st.posts[1].body.locked_ok, undefined);
  // ticked: locked_ok true (a boolean, never "on")
  f.cb.checked = true;
  P.st.answers.push({ ok: false, code: "E_REASON", error: "x" });
  P.fire("submit", f);
  await tick();
  assert.equal(P.st.posts[2].body.locked_ok, true);
  // a different name: the box goes, unticked
  f.to.value = "carl";
  P.fire("input", f.to);
  assert.equal(f.box.hidden, true);
  assert.equal(f.cb.checked, false);
  P.st.answers.push({ ok: false, code: "E_TO", error: "No account called carl." });
  f.cb.checked = true;                         // (even a stale tick under a hidden box is not sent)
  P.fire("submit", f);
  await tick();
  assert.equal(P.st.posts[3].body.locked_ok, undefined);
});

test("a success: the item leaves the list - the message goes to the list's line, scrolled into view; the password is cleared", async () => {
  const P = boot([ITEM]);
  await tick();
  const a = P.art();
  const f = a.forms.writeoff;
  Object.assign(f.reason, { value: "account purged, nobody to pay" }); Object.assign(f.pw, { value: "secret-pw" });
  P.st.items = [];
  P.st.answers.push({ ok: true, message: "Written off: 2,000 PAT went back to the House." });
  P.fire("submit", f);
  await tick();
  assert.equal(P.list.arts.length, 0, "redrawn without it");
  assert.match(P.list.innerHTML, /Nothing is owed at the blackjack or Hold'em tables/);
  assert.match(P.els.owedStatus.textContent, /went back to the House/);
  assert.match(P.els.owedStatus.className, /\bok\b/);
  assert.ok(P.els.owedStatus.scrolled >= 1, "scrolled into view");
  assert.equal(f.pw.value, "", "cleared");
});
