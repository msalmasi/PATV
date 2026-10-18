// 1.99acd: the browser side of Web Push (QW-1), checked at the source and in a sandbox:
//   - public/js/push-sw.js (served as /sw.js): no fetch handler, no caches, no importScripts; shows a push, skips a focused tab
//     on the same page (never a test push), opens only local paths, re-subscribes on pushsubscriptionchange
//   - public/js/webpush.js (the Messages ⚙ widget): Notification.requestPermission exactly once, inside the "Turn on" click
//     handler; no innerHTML; failures shown by the server's code in the page's language, saying what failed (run in a
//     sandbox); the not-offered mode (data-push-off) with only "Turn off everywhere"
//   - every push string the code uses exists in en.json, with the placeholders the code fills
//   node --test test/webpush-client.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
const EN = JSON.parse(read("locales/en.json"));
const SW = read("public/js/push-sw.js");
const WIDGET = read("public/js/webpush.js");

/** Run the service worker in a sandbox: -> {fire(type, event) -> Promise, shown, posted, opened, focused, fetched} */
function sandbox({ clients = [], subscribe = null } = {}) {
  const handlers = {}, shown = [], posted = [], opened = [], fetched = [];
  const self = {
    location: { origin: "https://publicaccess.tv" },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => {},
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(clients),
      openWindow: (u) => { opened.push(u); return Promise.resolve(null); },
    },
    registration: {
      showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); },
      pushManager: { subscribe: subscribe || (() => Promise.resolve({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: {} }) })) },
    },
  };
  const ctx = vm.createContext({ self, URL, atob: (s) => Buffer.from(s, "base64").toString("binary"), Uint8Array, Promise, Date, JSON, Number, String,
                                 fetch: (u, o) => { fetched.push({ u, o }); return Promise.resolve({ json: () => Promise.resolve({ ok: true, key: "BAAA" }) }); } });
  vm.runInContext(SW, ctx);
  const fire = (type, ev) => {
    const waits = [];
    handlers[type](Object.assign({ waitUntil: (p) => waits.push(p) }, ev));
    return Promise.all(waits);
  };
  return { fire, handlers, shown, posted, opened, fetched };
}
const pushEv = (payload) => ({ data: { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) } });
const client = (url, focused = true, extra = {}) => Object.assign({ url, focused, visibilityState: focused ? "visible" : "hidden",
  postMessage: function (m) { (this.got = this.got || []).push(m); }, focus: function () { this.wasFocused = true; return Promise.resolve(this); } }, extra);

test("the service worker never touches page loads: no fetch handler, no caches, no importScripts", () => {
  assert.doesNotMatch(SW, /addEventListener\(\s*['"]fetch['"]/);
  assert.doesNotMatch(SW, /\bonfetch\b/);
  assert.doesNotMatch(SW, /\bcaches\./);
  assert.doesNotMatch(SW, /importScripts/);
  assert.doesNotMatch(SW, /`/, "no template strings");
  const s = sandbox();
  assert.deepEqual(Object.keys(s.handlers).sort(), ["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
});

test("a push: shown with the payload's generic text, tag, direction and a local link", async () => {
  const s = sandbox();
  await s.fire("push", pushEv({ v: 1, k: "dm", t: "New message", b: "Open PATV to see it.", u: "/messages/c/abcdef0123456789", tag: "dm:abcdef0123456789", ts: 5, d: "rtl" }));
  assert.equal(s.shown.length, 1);
  assert.equal(s.shown[0].title, "New message");
  const o = s.shown[0].opts;
  assert.equal(o.body, "Open PATV to see it.");
  assert.equal(o.tag, "dm:abcdef0123456789");
  assert.equal(o.renotify, true);
  assert.equal(o.dir, "rtl");
  assert.equal(o.timestamp, 5);
  assert.equal(o.icon, "/public/img/icon-192.png");
  assert.equal(o.data.u, "/messages/c/abcdef0123456789");
  // only local paths, ever
  for (const bad of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "javascript:alert(1)", 42]) {
    const t = sandbox();
    await t.fire("push", pushEv({ v: 1, k: "dm", t: "x", u: bad }));
    assert.equal(t.shown[0].opts.data.u, "/", String(bad));
  }
  // junk data: a plain "PATV" notification that opens the home page
  const j = sandbox();
  await j.fire("push", { data: { json: () => { throw new Error("not json"); } } });
  assert.equal(j.shown[0].title, "PATV");
  assert.equal(j.shown[0].opts.data.u, "/");
});

test("a focused, visible tab already on that page gets a message instead of a notification - never for a test push", async () => {
  const c = client("https://publicaccess.tv/messages/c/abc");
  const s = sandbox({ clients: [c] });
  await s.fire("push", pushEv({ v: 1, k: "dm", t: "New message", u: "/messages/c/abc", tag: "dm:abc" }));
  assert.equal(s.shown.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(c.got)), [{ t: "push", k: "dm", u: "/messages/c/abc" }]);   // (an object from the sandbox)
  const other = sandbox({ clients: [client("https://publicaccess.tv/messages/c/zzz"), client("https://publicaccess.tv/messages/c/abc", false)] });
  await other.fire("push", pushEv({ v: 1, k: "dm", t: "New message", u: "/messages/c/abc" }));
  assert.equal(other.shown.length, 1, "another conversation focused, or this one in a background tab: shown");
  const t = sandbox({ clients: [client("https://publicaccess.tv/messages")] });
  await t.fire("push", pushEv({ v: 1, k: "test", t: "PATV notifications work", u: "/messages?settings=1#push" }));
  assert.equal(t.shown.length, 1, "a test push always shows");
});

test("a click opens the link: focuses a tab on that page (moving it to the exact address) or opens a new one", async () => {
  const notif = (u) => ({ notification: { data: { u }, close() { this.closed = true; } } });
  const s = sandbox();
  const ev = notif("/p/mention-room?tab=live&line=5");
  await s.fire("notificationclick", ev);
  assert.ok(ev.notification.closed);
  assert.deepEqual(s.opened, ["/p/mention-room?tab=live&line=5"]);
  const nav = [];
  const c = client("https://publicaccess.tv/p/mention-room", false, { navigate: (u) => { nav.push(u); return Promise.resolve(c); } });
  const t = sandbox({ clients: [c] });
  await t.fire("notificationclick", notif("/p/mention-room?tab=live&line=5"));
  assert.ok(c.wasFocused);
  assert.deepEqual(nav, ["https://publicaccess.tv/p/mention-room?tab=live&line=5"]);
  assert.deepEqual(t.opened, []);
  const x = sandbox();
  await x.fire("notificationclick", notif("https://evil.example/"));
  assert.deepEqual(x.opened, ["/"], "never off-site");
});

test("pushsubscriptionchange: re-subscribes with the same key and tells the site which row it replaces", async () => {
  let asked = null;
  const s = sandbox({ subscribe: (o) => { asked = o; return Promise.resolve({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } }) }); } });
  const key = new Uint8Array([4, 1, 2]);
  await s.fire("pushsubscriptionchange", { oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/old", options: { applicationServerKey: key } } });
  assert.equal(asked.userVisibleOnly, true);
  assert.equal(asked.applicationServerKey, key);
  const post = s.fetched.find((f) => f.u === "/api/push/resubscribe");
  assert.ok(post);
  assert.equal(post.o.method, "POST");
  assert.equal(post.o.credentials, "same-origin");
  assert.equal(post.o.headers["X-Requested-With"], "fetch");
  assert.deepEqual(JSON.parse(post.o.body), { old_endpoint: "https://fcm.googleapis.com/fcm/send/old", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } } });
});

test("the widget: the permission prompt only from the Turn-on click, no innerHTML, saves on its own endpoints", () => {
  const calls = WIDGET.match(/Notification\.requestPermission\s*\(/g) || [];
  assert.equal(calls.length, 1, "requestPermission is called in exactly one place");
  const fn = /function enable\(\) \{[\s\S]*?\r?\n  \}\r?\n/.exec(WIDGET);
  assert.ok(fn, "the enable() handler");
  assert.match(fn[0], /Notification\.requestPermission\(/, "inside enable()");
  assert.match(WIDGET, /button\(_t\('js\.push\.enable', 'Turn on for this browser'\), enable\)/, "enable() is the Turn-on button's click handler");
  assert.doesNotMatch(WIDGET, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(WIDGET, /userVisibleOnly: true/);
  assert.match(WIDGET, /register\('\/sw\.js', \{ scope: '\/' \}\)/);
  for (const p of ["/api/push/state", "/api/push/subscribe", "/api/push/unsubscribe", "/api/push/test"]) assert.ok(WIDGET.includes("'" + p + "'"), p);
  assert.match(WIDGET, /window\.PATVPush = \{ clear: clear \}/);
  // public/js/messages.js clears a conversation's notifications when it's opened
  assert.match(read("public/js/messages.js"), /window\.PATVPush\.clear\('dm:' \+ id\)/);
});

/** Run the widget against a tiny fake page: -> {st, acts, fetched, click(label) -> Promise}. __t returns the key, so what the
 *  status line shows is the catalog key the code picked (never the server's English text). */
function widget({ off = false, answer = () => ({ status: 200, body: { ok: true } }) } = {}) {
  const el = (tag) => ({ tag, textContent: "", disabled: false, hidden: false, className: "", kids: [], handlers: {},
    addEventListener(t, fn) { this.handlers[t] = fn; }, appendChild(c) { this.kids.push(c); return c; } });
  const acts = el("div"), st = el("span");
  Object.defineProperty(acts, "textContent", { get() { return ""; }, set() { this.kids = []; } });
  const fs = { hasAttribute: (a) => a === "data-push-off" && off, getAttribute: (a) => ({ "data-key": "BAAA", "data-kinds": "dm,mention" })[a] || null,
               querySelector: (q) => (q === ".dm-push-acts" ? acts : q === ".dm-push-st" ? st : null) };
  const fetched = [];
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/me", options: { applicationServerKey: null }, toJSON() { return { endpoint: this.endpoint }; },
                unsubscribe: () => Promise.resolve(true) };
  const reg = { pushManager: { getSubscription: () => Promise.resolve(sub) } };
  const window = { __t: (k) => k, isSecureContext: true, PushManager: function () {}, Notification: { permission: "granted" } };
  const ctx = vm.createContext({
    window, document: { querySelector: (q) => (q === "[data-push]" ? fs : null), createElement: el }, location: { pathname: "/messages" },
    navigator: { userAgent: "test", serviceWorker: { getRegistration: () => Promise.resolve(reg) } }, Notification: window.Notification,
    atob: (s) => Buffer.from(s, "base64").toString("binary"), Uint8Array, Promise, JSON, String, Number, Array, Error, setTimeout, clearTimeout,
    fetch: (u, o) => {
      fetched.push({ u, body: JSON.parse(o.body) });
      const a = answer(u);
      return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
    },
  });
  vm.runInContext(WIDGET, ctx);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const click = async (key) => {
    const b = acts.kids.find((k) => k.textContent === key);
    assert.ok(b, "a " + key + " button: " + acts.kids.map((k) => k.textContent).join(", "));
    b.handlers.click();
    await settle();
  };
  return { st, acts, fetched, click, settle };
}

test("the widget shows a failure in the page's language by the server's code, and says what failed (on / test / off / save)", async () => {
  // every code the user routes answer with has its own catalog line, mapped in the widget
  const src = read("webpush.js");
  const codes = new Set([...src.matchAll(/code: "(E_[A-Z]+)"/g), ...src.matchAll(/new Refuse\(\d+, [^\n]*?, "(E_[A-Z]+)"\)/g)].map((m) => m[1]));
  for (const c of ["E_OFF", "E_RATE", "E_SESSION", "E_ENDPOINT", "E_KEYS", "E_KINDS", "E_NODEVICE"]) assert.ok(codes.has(c), c + " is a server code");
  for (const c of codes) assert.match(WIDGET, new RegExp(c + ": \\['js\\.push\\.err\\.[a-z_]+'"), c + " has a translated line");
  assert.doesNotMatch(WIDGET, /e\.message|\.error\b(?!\s*\|\|)/, "the server's English text is never shown");
  for (const ctx of ["test", "off", "save"]) assert.match(WIDGET, new RegExp("\\.catch\\(fail\\('" + ctx + "'\\)\\)"), ctx);
  // in a sandbox: a refused test shows the test's own rate line; a failed turn-off says turning OFF failed
  const w = widget({ answer: (u) => (u === "/api/push/state" ? { status: 200, body: { ok: true, mine: { known: true, kinds: ["dm"] }, others: 0 } }
                                   : u === "/api/push/test" ? { status: 429, body: { ok: false, code: "E_RATE", error: "That's enough tests for now - try again in a few minutes." } }
                                   : { status: 500, body: { ok: false, error: "Something went wrong." } }) });
  await w.settle();
  assert.equal(w.st.textContent, "js.push.on");
  await w.click("js.push.test");
  assert.equal(w.st.textContent, "js.push.err.test_rate js.push.on");
  await w.click("js.push.disable");
  assert.equal(w.st.textContent, "js.push.off_failed js.push.on", "not \"Couldn't turn notifications on\"");
  const k = widget({ answer: (u) => (u === "/api/push/state" ? { status: 200, body: { ok: true, mine: { known: true, kinds: ["dm"] }, others: 0 } }
                                   : { status: 400, body: { ok: false, code: "E_KEYS", error: "This browser sent keys that can't be used." } }) });
  await k.settle();
  await k.click("js.push.off_all");
  assert.equal(k.st.textContent, "js.push.err.keys js.push.on", "a known code: its own line, never the English text");
});

test("the widget while not offered (data-push-off): only Turn off everywhere, which needs no permission and removes every browser", async () => {
  let fail = true;
  const w = widget({ off: true, answer: () => (fail ? { status: 429, body: { ok: false, code: "E_RATE", error: "Too many tries - wait a minute." } } : { status: 200, body: { ok: true, removed: 2 } }) });
  assert.deepEqual(w.acts.kids.map((k) => k.textContent), ["js.push.off_all"]);
  assert.equal(w.fetched.length, 0, "nothing asked until the click (no /state: it isn't offered)");
  await w.click("js.push.off_all");
  assert.deepEqual(w.fetched[0], { u: "/api/push/unsubscribe", body: { all: true } });
  assert.equal(w.st.textContent, "js.push.err.rate");
  fail = false;
  await w.click("js.push.off_all");
  assert.equal(w.st.textContent, "js.push.off_done");
  assert.equal(w.acts.kids.length, 0, "done: the button goes");
});

test("every push string the code uses is in en.json, with the placeholders it fills", () => {
  const KINDS = JSON.parse(/const KINDS = Object\.freeze\((\[[^\]]*\])\)/.exec(read("webpush.js"))[1].replace(/'/g, '"'));   // (no require: it opens a database)
  assert.deepEqual(KINDS, ["dm", "mention", "keyword"]);
  const used = new Set();
  for (const src of [WIDGET, read("public/js/messages.js"), read("views/messages.ejs"), read("views/mentions.ejs"), read("webpush.js"), read("settingshub.js")]) {
    for (const m of src.matchAll(/['"`]((?:js\.push|push\.generic|push\.test|msg\.set\.push|settings\.mentions\.push|sethub\.st\.push)[a-z0-9_.]*)['"`]/g)) used.add(m[1]);
  }
  for (const k of KINDS) { used.add("msg.set.push_" + k); used.add("push.generic." + k); }
  for (const k of ["mention", "keyword"]) used.add(`push.generic.${k}_in`);
  used.add("sethub.e.push"); used.add("sethub.d.push");
  for (const k of used) {
    if (/[._]$/.test(k)) continue;            // a prefix the code completes (msg.set.push_ + kind, push.generic.${kind}...)
    assert.ok(k in EN, k + " missing from en.json");
  }
  assert.ok(used.size >= 30, "found the keys: " + used.size);
  for (const k of ["push.generic.mention_in", "push.generic.keyword_in"]) assert.match(EN[k], /\{!pad\}/, k);
  for (const k of ["msg.set.push_kinds_note", "settings.mentions.push"]) assert.match(EN[k], /\{!link\}/, k + ": HTML goes in raw");
  assert.deepEqual(Object.keys(EN["js.push.others"]).sort(), ["one", "other"]);
  assert.deepEqual(Object.keys(EN["sethub.st.push_n"]).sort(), ["one", "other"]);
  for (const k of Object.keys(EN).filter((x) => x.startsWith("push."))) assert.doesNotMatch(EN[k], /[<&]/, k + ": plain text for a notification");
});
