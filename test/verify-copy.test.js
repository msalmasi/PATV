// verifyfix (owner, 2026-11-08: "when i click the 'copy' button on the verify code it just copies the word 'Copy'"). The box's
// button (partials/account-flash.ejs, Settings -> Account and Edit profile) wrote "!verify CODE" from an inline onclick, then the
// click bubbled to public/js/crypto-link.js (loaded on Settings -> Account when crypto wallets are on), whose document-wide
// [data-copy] handler copied the ATTRIBUTE - data-copy held the label "Copy" - over it. Now:
//   * the button carries no inline handler and no data-copy: data-verify-copy="!verify CODE" + its labels; public/js/verify-copy.js
//     copies it (navigator.clipboard, else a hidden-textarea copy, else the command is SELECTED for a manual copy) and shows
//     "Copied!" for a moment
//   * crypto-link.js only copies its own buttons (data-crypto-copy, /support's wallet addresses) - no other page's [data-copy]
//   * cache-busters: verify-copy.js?v=1, crypto-link.js?v=3
//   node --test test/verify-copy.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
const CODE_MSG = 'Verify ownership of "LavCF" to complete the link. !verify A1B2C3';
const ACC = { username: "lav", displayname: "Lav", email: "l@example.test", camfrogUsername: "", twitchDisplayname: null, discordUsername: null,
              errors: [], success: [CODE_MSG], plex: null, plexLink: false, telegram: { linked: false, handle: null, signin: false }, google: null,
              cryptoW: { wallets: [], on: true }, plexPin: null, user: "lav" };
const EN = JSON.parse(read("locales/en.json"));

// ── a tiny DOM: elements with attributes, a parent chain, closest() / querySelector() for [attr], .class and tag selectors ──
function matches(e, sel) {
  return sel.split(",").map((s) => s.trim()).some((s) => {
    const m = s.match(/^\[([\w-]+)\]$/);
    if (m) return e.attrs[m[1]] != null;
    if (s[0] === ".") return (` ${e.attrs.class || ""} `).includes(` ${s.slice(1)} `);
    return e.tag === s.toLowerCase();
  });
}
function mk(tag, attrs = {}, text = "") {
  const e = { tag, attrs: Object.assign({}, attrs), children: [], parent: null, textContent: text, style: {}, value: "",
    get dataset() { const o = {}; for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("data-")) o[k.slice(5).replace(/-([a-z])/g, (x, c) => c.toUpperCase())] = v; return o; },
    getAttribute(k) { return this.attrs[k] == null ? null : String(this.attrs[k]); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return this.attrs[k] != null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; },
    remove() { if (this.parent) this.parent.removeChild(this); },
    closest(sel) { let x = this; while (x) { if (x.tag && matches(x, sel)) return x; x = x.parent; } return null; },
    querySelector(sel) { for (const c of this.children) { if (matches(c, sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; },
    select() { this.selected = true; }, setSelectionRange() { this.selected = true; }, focus() {} };
  return e;
}
/** The verify box's button exactly as the view renders it (attributes parsed from the HTML). */
function buttonFrom(html) {
  const m = html.match(/<button type="button" class="verify-copy"([^>]*)>([^<]*)<\/button>/);
  assert.ok(m, "the verify box has its Copy button");
  const attrs = { type: "button", class: "verify-copy" };
  for (const a of m[1].matchAll(/\s([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&#34;/g, '"').replace(/&amp;/g, "&");
  return { attrs, label: m[2] };
}
function page({ html, clipboard = "ok", execOk = false, secure = true }) {
  const listeners = [], timers = [], writes = [], selections = [];
  const body = mk("body");
  const doc = { body, readyState: "complete", activeElement: body,
    addEventListener(t, f) { if (t === "click") listeners.push(f); },
    querySelector(sel) { return body.querySelector(sel); }, getElementById() { return null; },
    createElement(tag) { return mk(tag); },
    createRange() { return { selectNodeContents(n) { this.node = n; } }; },
    execCommand(c) { doc.execCalls = (doc.execCalls || 0) + 1; if (c === "copy" && execOk) { const ta = body.children.find((x) => x.tag === "textarea"); writes.push(ta ? ta.value : "?"); } return execOk; } };
  const wrap = body.appendChild(mk("div", { class: "verify-code-wrap" }));
  const cmd = wrap.appendChild(mk("span", { class: "verify-cmd" }, "!verify A1B2C3"));
  const b = buttonFrom(html);
  const btn = wrap.appendChild(mk("button", b.attrs, b.label));
  // a crypto box with its own copy button (as /support has)
  const box = body.appendChild(mk("div", { "data-crypto-box": "" }));
  box.appendChild(mk("p", { "data-crypto-msg": "" }));
  const addr = box.appendChild(mk("button", { "data-crypto-copy": "0xABCDEF" }, "Copy"));
  const nav = {};
  if (clipboard) nav.clipboard = { writeText: (v) => (clipboard === "ok" ? (writes.push(v), Promise.resolve()) : Promise.reject(new Error("NotAllowedError"))) };
  const win = { isSecureContext: secure, getSelection: () => ({ removeAllRanges() {}, addRange(r) { selections.push(r.node); } }),
                prompt(m, v) { win.prompted = v; }, confirm: () => false };
  const sandbox = { document: doc, window: win, navigator: nav, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
                    console, Promise, TextEncoder, fetch: async () => ({ ok: true, json: async () => ({}) }), location: { reload() {} } };
  win.navigator = nav; win.document = doc;
  const ctx = vm.createContext(sandbox);
  return {
    ctx, btn, cmd, addr, writes, selections, timers, doc, win,
    run(file) { vm.runInContext(read(file), ctx, { filename: file }); },
    async click(target) {
      const ev = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      // the inline handler (if the markup still had one) runs first, then the event bubbles to document
      if (target.attrs.onclick) vm.runInContext(`(function(){${target.attrs.onclick}}).call(__t)`, Object.assign(ctx, { __t: target }));
      for (const f of listeners) f(ev);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      return ev;
    },
    flush() { while (timers.length) timers.shift()(); },
  };
}

const render = (view, locals) => ejs.renderFile(path.join(repo, "views", view), locals);

test("the verify box's button: no inline handler, no data-copy - the command in data-verify-copy, its labels, the script (?v=1)", async () => {
  const ac = await render("settingsAccount.ejs", ACC);
  const b = buttonFrom(ac);
  assert.equal(b.attrs.onclick, undefined, "no inline onclick");
  assert.equal(b.attrs["data-copy"], undefined, "no data-copy (crypto-link.js used to copy THAT - the word Copy)");
  assert.equal(b.attrs["data-copied"], undefined);
  assert.equal(b.attrs["data-verify-copy"], "!verify A1B2C3");
  assert.equal(b.attrs["data-verify-label"], EN["settings.verify.copy"]);
  assert.equal(b.attrs["data-verify-done"], EN["settings.verify.copied"]);
  assert.equal(b.attrs["data-verify-manual"], EN["settings.verify.copy_manual"]);
  assert.equal(b.label, EN["settings.verify.copy"]);
  assert.match(ac, /<script src="\/public\/js\/verify-copy\.js\?v=1" defer><\/script>/);
  assert.match(ac, /<script src="\/public\/js\/crypto-link\.js\?v=3" defer><\/script>/, "crypto-link.js changed: its cache-buster moved");
  const box = ac.slice(ac.indexOf('id="cf-verify"'), ac.indexOf("</div>", ac.indexOf('class="verify-expires"')));
  assert.doesNotMatch(box, /\son[a-z]+=/i, "no inline event handlers in the box");
  const ed = await render("editProfile.ejs", { username: "lav", displayname: "Lav", camfrogUsername: "", avatar: "", level: 3, classh: "pleb",
    profileCosmetics: null, layout: null, sections: [], subSections: {}, privPanels: [], errors: [], success: [CODE_MSG] });
  assert.equal(buttonFrom(ed).attrs["data-verify-copy"], "!verify A1B2C3", "Edit profile renders the same box");
  assert.match(ed, /verify-copy\.js\?v=1/);
  const none = await render("settingsAccount.ejs", Object.assign({}, ACC, { success: ["Camfrog username unlinked."] }));
  assert.doesNotMatch(none, /verify-copy\.js/, "no code, no script");
  assert.match(read("views/partials/account-css.ejs"), /\.verify-cmd \{[^}]*user-select: all/, "a tap selects the whole command (the manual copy)");
});

test("clicking Copy copies '!verify CODE' - once, never the label - even with crypto-link.js on the page (Settings -> Account)", async () => {
  const ac = await render("settingsAccount.ejs", ACC);
  const P = page({ html: ac });
  P.run("public/js/crypto-link.js");                     // loaded first on the page? the order doesn't matter - try both
  P.run("public/js/verify-copy.js");
  const ev = await P.click(P.btn);
  assert.deepEqual(P.writes, ["!verify A1B2C3"], "exactly the command (it used to end up as 'Copy')");
  assert.equal(P.btn.textContent, EN["settings.verify.copied"], "visible feedback");
  assert.equal(ev.defaultPrevented, true);
  P.flush();
  assert.equal(P.btn.textContent, EN["settings.verify.copy"], "and back");
  // the other order
  const Q = page({ html: ac });
  Q.run("public/js/verify-copy.js");
  Q.run("public/js/crypto-link.js");
  await Q.click(Q.btn);
  assert.deepEqual(Q.writes, ["!verify A1B2C3"]);
  // a click on the code text itself (inside the box, not the button) copies nothing
  await Q.click(Q.cmd);
  assert.deepEqual(Q.writes, ["!verify A1B2C3"]);
});

test("the clipboard refuses (WebKit without a gesture, an http page): a hidden-textarea copy, else the command is selected", async () => {
  const ac = await render("settingsAccount.ejs", ACC);
  // writeText rejects, execCommand works
  let P = page({ html: ac, clipboard: "reject", execOk: true });
  P.run("public/js/verify-copy.js");
  await P.click(P.btn);
  assert.deepEqual(P.writes, ["!verify A1B2C3"], "copied through the textarea");
  assert.equal(P.btn.textContent, EN["settings.verify.copied"]);
  assert.equal(P.doc.body.children.some((c) => c.tag === "textarea"), false, "the helper textarea is gone again");
  // nothing works: the command is selected for a manual copy, and the button says so
  P = page({ html: ac, clipboard: "reject", execOk: false });
  P.run("public/js/verify-copy.js");
  await P.click(P.btn);
  assert.deepEqual(P.writes, []);
  assert.deepEqual(P.selections, [P.cmd], "the '!verify CODE' text is selected");
  assert.equal(P.btn.textContent, EN["settings.verify.copy_manual"]);
  P.flush();
  assert.equal(P.btn.textContent, EN["settings.verify.copy"]);
  // no Clipboard API at all (older browsers)
  P = page({ html: ac, clipboard: null, execOk: true });
  P.run("public/js/verify-copy.js");
  await P.click(P.btn);
  assert.deepEqual(P.writes, ["!verify A1B2C3"]);
});

test("crypto-link.js copies only its own buttons (data-crypto-copy) - /support's wallet addresses still copy", async () => {
  const ac = await render("settingsAccount.ejs", ACC);
  const P = page({ html: ac });
  P.run("public/js/crypto-link.js");
  await P.click(P.addr);
  assert.deepEqual(P.writes, ["0xABCDEF"]);
  // a [data-copy] that isn't crypto-link's (help-page.js / stage-book.js / onair-bar.js own those) is left alone
  const other = P.doc.body.appendChild(mk("button", { "data-copy": "rtmpUrl" }, "Copy"));
  await P.click(other);
  assert.deepEqual(P.writes, ["0xABCDEF"], "crypto-link.js no longer copies other pages' [data-copy]");
  const js = read("public/js/crypto-link.js");
  assert.doesNotMatch(js, /\[data-copy\]/, "no document-wide [data-copy] delegation");
  const sup = read("views/support.ejs");
  assert.match(sup, /data-crypto-copy="<%= c\.address %>"/);
  assert.doesNotMatch(sup, /\sdata-copy=/);
  assert.match(sup, /crypto-link\.js\?v=3/);
});
