"use strict";
// 1.99?? dockpol (the owner's 2026-11-04 tweaks to the Room Dock): the controller's new pieces in the deterministic DOM (fixtures/pad-dock),
// chat-lines.js's tap menu, room-bridge.js's command hook, and the static rules the browser evidence relies on.
//   node --test test/pad-dock-pol.test.js
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { harness, Event, Document } = require("./fixtures/pad-dock/dom.cjs");
const F = require("./fixtures/pad-dock/room.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const menuOf = (doc) => doc.querySelector(".rmd-menu");
// (the fixture DOM's selectors have no ^= / :not(): filter in script)
const labels = (m) => m.querySelectorAll("[role]").filter((b) => /^menuitem/.test(b.getAttribute("role"))).map((b) => b.getAttribute("aria-label") || b.textContent.replace(/^\p{Extended_Pictographic}\uFE0F?/u, "").trim());
const bare = (n) => !n.querySelectorAll("button, a").some((b) => !b.classList.contains("la-btn"));

// ── item 2: "Show real names" is the chat ⋯'s, never a banner; one notice when it changes ──
test("item 2: Show real names is a chat ⋯ checkbox only while a reveal is offered; it calls the page's flip; its notices sit in the chat card", () => {
  let offered = false, on = null, flips = 0, hear = null;
  const reveal = { offered: () => offered, state: () => on, busy: () => false, flip() { flips++; }, onChange(f) { hear = f; } };
  const h = harness({ opts: { reveal } });
  h.button("Chat options").click();
  assert.ok(!labels(menuOf(h.doc)).includes("Show real names"), "not offered: no item");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  offered = true; on = false; h.button("Chat options").click();
  const it = menuOf(h.doc).querySelectorAll("[role=menuitemcheckbox]").find((b) => b.getAttribute("aria-label") === "Show real names");
  assert.ok(it, "offered: a checkbox item"); assert.equal(it.getAttribute("aria-checked"), "false"); assert.match(it.textContent, /every reveal is logged/);
  it.click(); assert.equal(flips, 1, "the page's own flip (the same POST, audit row and reason prompt)");
  assert.equal(typeof hear, "function", "the Dock listens for its state");
  hear({ type: "on" });
  const notes = () => h.doc.querySelectorAll(".rmd-log > .rmd-toasts .rmd-ct");
  assert.equal(notes().length, 1); assert.match(notes()[0].textContent, /Showing who.s behind frog names on this pad - every reveal is logged\./);
  hear({ type: "off" }); assert.equal(notes().length, 1, "the same notice, updated in place"); assert.match(notes()[0].textContent, /Frog names are hidden again/);
  h.tick(); assert.equal(notes().length, 0, "it goes by itself");
  assert.equal(h.doc.querySelectorAll(".veil-banner").length, 0, "no banner in the Dock");
  on = true; h.button("Chat options").click();
  assert.equal(menuOf(h.doc).querySelectorAll("[role=menuitemcheckbox]")[0].getAttribute("aria-checked"), "true");
});
test("item 2 (room.ejs): the Dock never draws the banner; roomReveal goes to the Dock; the legacy view keeps its bar", () => {
  const room = read("views", "room.ejs");
  assert.match(room, /function draw\(\) \{\n\s+offered = true;\n\s+if \(dockMode\) \{ emit\('state'\); return; \}\n\s+if \(!bar\) \{ bar = el\('div', 'veil-banner'\);/);
  assert.match(room, /reveal: roomReveal,/);
  assert.match(room, /stPost\('\/api\/chatlog\/seethrough', \{ room: slug, on: !on \}\)/, "the same audited switch");
  assert.doesNotMatch(read("public", "css", "pad-dock.css").replace(/\/\*[\s\S]*?\*\//g, ""), /\.veil-banner/, "no Dock banner rules left");
});

// ── items 3 / 12: the log sticks to its newest line through late growth; only the reader unpins it ──
test("items 3, 12 (room.ejs): one pinned state - the reader's own scroll unpins, content growth re-pins, a deep link stays put", () => {
  const room = read("views", "room.ejs");
  assert.match(room, /function toBottom\(\) \{[^}]*pinned = true; \}/);
  assert.match(room, /function stickNow\(\) \{ return dockMode \? pinned \|\| nearBottom\(\) : nearBottom\(\); \}/);
  assert.match(room, /var stick = first \|\| stickNow\(\);/, "addFeed");
  assert.match(room, /var stick = stickNow\(\), detached = !!\(padHist && padHist\.detached\(\)\)/, "a held grab / drop line");
  assert.match(room, /nearBottom: stickNow, toBottom: toBottom/, "room PM rows");
  assert.match(room, /\[scrollEl, feedEl, olderEl\]\.forEach\(function \(n\) \{ if \(n\) ro\.observe\(n\); \}\);/, "the box AND its content are watched");
  assert.match(room, /if \(pinned && scrollEl\.clientHeight && !wantLine && !\(padHist && \(padHist\.reading\(\) \|\| padHist\.detached\(\)\)\)\) toBottom\(\);/);
  // (1.99?? dockpol fix (review): ANY scroll away from the end that isn't ours (toBottom's mark) or the box's own height change unpins - Tab into
  // the log, find-in-page, a screen reader, scrollIntoView too; the end's 2px bounce never does)
  assert.match(room, /scrollEl\.__rmdProg = scrollEl\.scrollTop;/, "toBottom marks its own scroll");
  assert.match(room, /if \(scrollEl\.__rmdProg != null && Math\.abs\(top - scrollEl\.__rmdProg\) < 1\) \{ scrollEl\.__rmdProg = null; lastCh = ch; pinned = true; return; \}/);
  assert.match(room, /if \(dist <= 2\) pinned = true;\s*else if \(d < 0\) pinned = false;/, "away from the end unpins");
  assert.match(room, /jump\.style\.display = 'block'; pinned = false;/, "a ?line= deep link is never pulled to the end");
});

// ── item 22: command acknowledgements are toasts ──
test("item 22: a command's toast updates in place; Pepe's private answers stay content (room PM on: no repeat; off: a sticky toast)", () => {
  const h = harness(), notes = () => h.doc.querySelectorAll(".rmd-log > .rmd-toasts .rmd-ct");
  h.controller.cmd({ id: "j1", text: "!spin", st: "waiting for Pepe…", ok: null, replies: [] });
  assert.equal(notes().length, 1); assert.match(notes()[0].textContent, /› !spin · waiting for Pepe…/);
  h.controller.cmd({ id: "j1", text: "!spin", st: "done", ok: true, replies: [] });
  assert.equal(notes().length, 1, "in place"); assert.match(notes()[0].textContent, /› !spin · done/);
  h.tick(); assert.equal(notes().length, 0, "done goes by itself");
  h.controller.cmd({ id: "j2", text: "!heist", st: "not run — refused", ok: false, replies: [] });
  assert.ok(notes()[0].classList.contains("rmd-ct-bad"));
  h.tick();
  h.root.classList.add("rpm-on");
  h.controller.cmd({ id: "j3", text: "!bal", st: "", ok: true, replies: ["Your balance: 5 PAT"] });
  assert.equal(notes().length, 1, "room PM on: the answer is a line in the log already"); assert.match(notes()[0].textContent, /answered privately in the chat/);
  assert.doesNotMatch(notes()[0].textContent, /Your balance/);
  h.tick(); h.root.classList.remove("rpm-on");
  h.controller.cmd({ id: "j4", text: "!bal", st: "", ok: true, replies: ["Your balance: 5 PAT"] });
  const sticky = notes().filter((n) => n.classList.contains("rmd-ct-sticky"));
  assert.equal(sticky.length, 1); assert.match(sticky[0].textContent, /🔒 Your balance: 5 PAT/);
  h.tick(); assert.equal(notes().filter((n) => n.classList.contains("rmd-ct-sticky")).length, 1, "a private answer stays until ✕");
  h.button("Dismiss", sticky[0]).click(); assert.equal(notes().length, 0);
  for (let i = 0; i < 4; i++) h.controller.cmd({ id: "x" + i, text: "!np", st: "waiting for Pepe…", ok: null, replies: [] });
  assert.equal(notes().length, 2, "at most two");
  // (1.99?? dockpol fix (review): the visible stack is no live region - a separate polite one, there from the start, gets only the words)
  const host = h.doc.querySelector(".rmd-toasts"); assert.equal(host.getAttribute("role"), null);
  const sr = h.doc.querySelector(".rmd-log > .rmd-toasts-sr"); assert.equal(sr.getAttribute("role"), "status"); assert.equal(sr.getAttribute("aria-live"), "polite");
  h.tick(); assert.match(sr.textContent, /› !np · waiting for Pepe…/); assert.doesNotMatch(sr.textContent, /Dismiss/);
  // a sticky private answer is never pushed out by newer notices
  h.tick(); for (const n of notes()) h.button("Dismiss", n).click();
  h.controller.cmd({ id: "s1", text: "!bal", st: "", ok: true, replies: ["Your balance: 5 PAT"] });
  for (let i = 0; i < 5; i++) h.controller.cmd({ id: "y" + i, text: "!np", st: "waiting for Pepe…", ok: null, replies: [] });
  assert.equal(notes().filter((n) => n.classList.contains("rmd-ct-sticky")).length, 1, "the private answer stays");
  assert.equal(notes().filter((n) => !n.classList.contains("rmd-ct-sticky")).length, 2, "two passing notices beside it");
});
test("item 22 (room-bridge.js): opts.onCmd hears new and changed command rows, never ones finished before the page; the list is hidden", async () => {
  const doc = new Document(), win = { document: doc, addEventListener() {}, navigator: {} };
  const ctx = { window: win, document: doc, navigator: {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, console, JSON, Date, Math, Promise,
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, error: "nope" }) }) };
  win.fetch = ctx.fetch;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  const host = doc.createElement("div"); doc.body.appendChild(host);
  const rows = [];
  const R = win.PATVRoom.relay(host, "alpha", { onCmd: (r) => rows.push(r) });
  const feedList = host.querySelector(".rb-cmdfeed"); assert.ok(feedList.hidden, "the composer's own list is off");
  const room = { relay: true, cmds: { "!spin": 0 } };
  R.update({ room, mine: [{ kind: "cmd", id: 1, at: 1, text: "!old", state: "done", ok: true, replies: [] }] });
  assert.equal(rows.length, 0, "finished before this page: not news");
  R.update({ room, mine: [{ kind: "cmd", id: 1, at: 1, text: "!old", state: "done", ok: true, replies: [] }, { kind: "cmd", id: 2, at: 2, text: "!spin", state: "pending" }] });
  assert.equal(rows.length, 1); assert.equal(rows[0].text, "!spin"); assert.equal(rows[0].ok, null); assert.equal(rows[0].id, "j2");
  R.update({ room, mine: [{ kind: "cmd", id: 2, at: 2, text: "!spin", state: "done", ok: true, replies: [] }] });
  assert.equal(rows.length, 2); assert.equal(rows[1].ok, true); assert.equal(rows[1].st, "done");
  R.sendCmd("!nope"); await flush(); await flush();
  assert.equal(rows.at(-1).text, "!nope"); assert.equal(rows.at(-1).ok, false, "a refusal from the site says why");
});

// ── item 6 / 7: the line menu - Copy, one message's clip, a tap on touch ──
function linesPage(opts = {}) {
  const doc = new Document(), win = { document: doc, addEventListener() {}, removeEventListener() {}, innerWidth: opts.width || 390, navigator: { clipboard: { writeText: (s) => { calls.copied.push(s); return Promise.resolve(); } } },
    matchMedia: (q) => ({ matches: /pointer: coarse/.test(q) ? !!opts.coarse : false }), getSelection: () => ({ toString: () => opts.sel || "" }) };
  const calls = { copied: [], quote: [], mic: [], toast: [] };
  const feed = doc.createElement("div"); feed.id = "rmFeed"; doc.body.appendChild(feed);
  const CL = require(path.join(repo, "public", "js", "chatlog-core.js")), h = CL.domH(doc);
  for (const it of F.initial().feed) { const n = CL.renderItem(it, {}, h); if (n) feed.appendChild(n); }
  const clip = { canQuote: () => !!opts.quote, canMic: () => !!opts.mic, quoteOne: (n, b) => calls.quote.push(n), micOne: (n) => calls.mic.push(n) };
  const ctx = { window: win, document: doc, MutationObserver: class { observe() {} }, setTimeout: () => 0, clearTimeout() {}, Promise, JSON, console, fetch: () => new Promise(() => {}) };
  win.MutationObserver = ctx.MutationObserver;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "chat-lines.js"), "utf8"), ctx);
  const L = win.PATVChatLines.init({ feed, slug: "alpha", dock: opts.dock !== false, tapOpen: opts.dock !== false, clip, toast: (s) => calls.toast.push(s) });
  L.update({ history: { acts: opts.acts || null } });
  return { doc, win, feed, L, calls };
}
test("item 6: in the Dock every line with words gets 📋 Copy text (signed out too); on touch a tap opens the menu as a sheet, never on a name or a button", async () => {
  const P = linesPage({ coarse: true });
  const line = P.feed.querySelectorAll(".line[data-text]").find((n) => bare(n) && n.getAttribute("data-text"));
  assert.ok(line.querySelector(".la-btn.la-tap"), "the ⋯ stays for screen readers, marked for the tap");
  line.querySelector(".line-text").click();
  const pop = P.doc.querySelector(".la-pop"); assert.ok(pop, "a tap opens it"); assert.ok(pop.classList.contains("la-sheet"), "a bottom sheet on a phone");
  assert.equal(line.hasAttribute("data-la-open"), true, "its line is marked");
  assert.deepEqual(pop.querySelectorAll("[role=menuitem]").map((b) => b.textContent), ["📋 Copy text"], "signed out: Copy only");
  pop.querySelector("[role=menuitem]").click(); await flush();
  assert.deepEqual(P.calls.copied, [line.getAttribute("data-text")]); assert.deepEqual(P.calls.toast, ["Copied"]);
  assert.equal(line.hasAttribute("data-la-open"), false);
  line.querySelector(".who").click(); assert.equal(P.doc.querySelector(".la-pop"), null, "a name opens its person, not the line menu");
  for (const n of P.feed.querySelectorAll(".line[data-vc]")) { n.querySelector(".body").click(); const m = P.doc.querySelector(".la-pop"); assert.ok(!m || !/Copy/.test(m.textContent), "a masked bar has no words to copy"); }
  P.feed.classList.add("cc-on"); line.querySelector(".line-text").click(); assert.equal(P.doc.querySelector(".la-pop"), null, "✂️ Clip chat is picking lines");
  const D = linesPage({ coarse: false, width: 1280 }); D.feed.querySelectorAll(".line[data-text]")[0].querySelector(".line-text").click();
  assert.equal(D.doc.querySelector(".la-pop"), null, "a mouse never opens it by a click on the words (the hover ⋯ does)");
  const legacy = linesPage({ dock: false }); assert.equal(legacy.feed.querySelectorAll(".la-btn").length, 0, "the legacy view: no acts, no ⋯ (as before)");
});
test("item 7: ✂️ Clip this message / 🔊 Clip the audio hand the line to chat-clip.js's own flows, offered only where it allows them", () => {
  const P = linesPage({ coarse: true, quote: true, mic: true, acts: { report: true } });
  const tx = P.feed.querySelectorAll(".line.tx[data-c]").find((n) => n.getAttribute("data-tx"));
  const msg = P.feed.querySelectorAll(".line[data-c]").find((n) => !n.classList.contains("tx") && bare(n) && n.getAttribute("data-own") !== "1");
  msg.querySelector(".line-text").click();
  assert.deepEqual(P.doc.querySelector(".la-pop").querySelectorAll("[role=menuitem]").map((b) => b.textContent), ["📋 Copy text", "✂️ Clip this message", "⚑ Report…"]);
  P.doc.querySelector(".la-pop").querySelectorAll("[role=menuitem]")[1].click(); assert.deepEqual(P.calls.quote, [msg]);
  if (tx) { tx.querySelector(".line-text").click(); const it = P.doc.querySelector(".la-pop").querySelectorAll("[role=menuitem]").find((b) => /Clip the audio/.test(b.textContent)); assert.ok(it); it.click(); assert.deepEqual(P.calls.mic, [tx]); }
  const N = linesPage({ coarse: true, quote: false, mic: false });
  N.feed.querySelectorAll(".line[data-c]").find((n) => bare(n)).querySelector(".line-text").click();
  assert.doesNotMatch(N.doc.querySelector(".la-pop").textContent, /Clip/, "not allowed here: not offered");
  const cc = read("public", "js", "chat-clip.js");
  assert.match(cc, /q = \{ key: cs\.join\(','\), shown: false, all: false, one: true \};\n\s+qc\.open\(/, "the same card as Clip N lines");
  assert.match(cc, /micOne: function \(r, opener\) \{ var tx = r && r\.getAttribute && r\.getAttribute\('data-tx'\); if \(tx && linked && canMic && !on\) micClip\(tx, opener\); \}/);
});

// ── items 5 / 21: the holder chips ──
test("items 5, 21: a holder chip is [🎙][avatar][name + flair], says 'on the mic', and rings the one the mic stage says is talking; veiled: no ring, no flair", () => {
  let asked = [];
  const h = harness({ opts: { person: (u, o) => { asked.push(o); return null; } } });
  const d = F.initial(); h.controller.mic([]); asked = []; h.controller.mic(d.mic);
  const chips = h.doc.querySelectorAll(".rmd-holder");
  assert.ok(chips.length >= 1);
  for (const c of chips) { assert.equal(c.firstChild.className, "rmd-mic-b"); assert.equal(c.firstChild.getAttribute("aria-hidden"), "true"); assert.match(c.textContent, /on the mic/); }
  const named = d.mic.find((u) => !u.veil && !u.anon), veiled = d.mic.find((u) => u.veil || u.anon);
  assert.ok(asked.some((o) => o && o.flair === true), "a named holder is drawn with its flair");
  if (veiled) assert.ok(asked.some((o) => o && o.flair === false), "a veiled one without");
  h.controller.talking({ src: [{ id: "a", login: named.login, ring: true }, { id: "c", kind: "cover", ring: true }] });
  const ringed = h.doc.querySelectorAll(".rmd-holder.rmd-talking"); assert.equal(ringed.length, 1, "only the named holder the stage rings");
  h.controller.talking(null); assert.equal(h.doc.querySelectorAll(".rmd-holder.rmd-talking").length, 0);
});

// ── item 15 / 17: the cam strip's size; a pinned cam pops out ──
test("item 15: the cam strip's size is a visible S / M / L / ▦ control on the strip, remembered for the viewer, mirrored in Stage ⋯ › Pinned cams", () => {
  const store = {};
  const h = harness();
  const seg = h.strip.querySelector(".rmd-pin-size"); assert.ok(seg, "on the strip row"); assert.equal(seg.getAttribute("role"), "radiogroup");
  assert.deepEqual(seg.querySelectorAll("button").map((b) => b.getAttribute("aria-label")), ["Small", "Medium", "Large", "Grid"]);
  assert.equal(h.strip.getAttribute("data-rmd-layout"), "small");
  seg.querySelectorAll("button")[1].click();
  assert.equal(h.strip.getAttribute("data-rmd-layout"), "medium"); assert.equal(h.root.getAttribute("data-rmd-pins"), "medium");
  assert.equal(seg.querySelectorAll("button")[1].getAttribute("aria-checked"), "true");
  h.menuPick("Stage options", "Pinned cams");
  const radios = menuOf(h.doc).querySelectorAll("[role=menuitemradio]");
  assert.deepEqual(radios.map((b) => b.getAttribute("aria-label")), ["Small", "Medium", "Large", "Grid"]);
  assert.equal(radios[1].getAttribute("aria-checked"), "true", "the same state");
  radios[2].click(); assert.equal(seg.querySelectorAll("button")[2].getAttribute("aria-checked"), "true");
  const js = read("public", "js", "pad-dock.js");
  assert.match(js, /store\(PIN_KEY, v\);/); assert.match(js, /pinSize\(store\(PIN_KEY\) \|\| 'small'\);/, "a reload keeps it");
  void store;
});
test("item 17: a pinned cam's ⋯ pops it out - the SAME tile node into Document PiP (no new ticket), back to the strip on close", async () => {
  const h = harness({ pip: true }), tile = h.tile, video = tile.querySelector("video");
  h.button("Cam options", tile).click();
  const item = menuOf(h.doc).querySelectorAll("[role=menuitem]").find((b) => b.getAttribute("aria-label") === "Pop out (picture-in-picture)");
  assert.ok(item); item.click(); await flush();
  assert.equal(h.pipDoc.querySelector(".cs-tile") === tile, true, "the same node"); assert.equal(tile.querySelector("video") === video, true);
  assert.equal(h.doc.querySelectorAll(".cs-tile").length, 0);
  h.pipWin.close(); assert.equal(h.strip.contains(tile), true, "back in the strip");
  const plain = harness(); plain.button("Cam options", plain.tile).click();
  assert.ok(!labels(menuOf(plain.doc)).includes("Pop out (picture-in-picture)"), "no PiP at all: no item");
});

// ── items 26, 27, 29, 30: the composer's apps, 🎡 Spin and Create ──
test("items 26, 27: 💲 Showdown starts the price game (!pricegame); no 😀 tool; 🎡 Spin asks once, then sends !spin through the relay", () => {
  const h = harness({ data: (d) => { d.room.cmds = { "!spin": 5000, "!pricegame": 0, "!guess": 0 }; } });
  const tools = h.compose.querySelector(".rmd-tools");
  assert.equal(tools.querySelector('[data-rmd-tool="emoji"]'), null, "no 😀 - 🧸 has the Emoji tab");
  const spin = tools.querySelector('[data-rmd-tool="spin"]'); assert.ok(spin && !spin.hidden); assert.equal(spin.querySelector(".ds-ic").textContent, "🎡");
  spin.click(); const pop = menuOf(h.doc); assert.match(pop.textContent, /Spin the wheel · 5,000 PAT/); assert.equal(h.calls.send.length, 0, "a tap never sends by itself");
  h.button("Cancel", pop).click(); assert.equal(h.calls.send.length, 0);
  spin.click(); h.button("Spin", menuOf(h.doc)).click(); assert.deepEqual(h.calls.send, ["!spin"]);
  h.button("Chat apps").click(); const apps = h.doc.querySelector(".rmd-layer");
  // (1.99?? dockpol fix (review): the tile shows the command it inserts - !pricegame until Pepe's relay offers !showdown itself)
  const sd = h.button("Showdown (!pricegame), free", apps); assert.doesNotMatch(apps.textContent, /Guess|!showdown/);
  sd.click(); assert.equal(h.input.value, "!pricegame", "the web relay's name for the same game (never sent)"); assert.equal(h.calls.send.length, 1);
  const d2 = F.initial(); d2.room.cmds = Object.assign({}, d2.room.cmds, { "!showdown": 0, "!pricegame": 0 }); h.controller.update(d2);
  h.button("Chat apps").click(); const sd2 = h.button("Showdown (!showdown), free", h.doc.querySelector(".rmd-layer")); sd2.click(); assert.equal(h.input.value, "!showdown");
  const d = F.initial(); d.room.cmds = { "!pricegame": 0 }; h.controller.update(d); assert.equal(tools.querySelector('[data-rmd-tool="spin"]').hidden, true);
});
test("item 27: one sheet header - the title's emoji is its icon, ✕ an icon-only Close; specific titles", () => {
  const h = harness();
  h.button("Tip").click();
  const box = h.doc.querySelector(".rmd-layer .ds-modal"), head = box.querySelector(".rmd-sheet-h");
  assert.ok(head); assert.equal(box.getAttribute("aria-label"), "Tip someone");
  assert.equal(head.querySelector("h2 .ds-ic").textContent, "💸"); assert.equal(head.querySelector("h2 .ds-ic").getAttribute("aria-hidden"), "true");
  const x = head.querySelector("button"); assert.equal(x.getAttribute("aria-label"), "Close"); assert.ok(x.classList.contains("rmd-icon"), "icon only");
});
test("item 29: 🎧 DJ - one tile; its sheet inserts Pepe's music commands (never sends), staff tiles only for Pepe's admins / owners here", () => {
  const h = harness({ data: (d) => { d.room.cmds = { "!find": 0, "!play": 500, "!np": 0, "!skip": 0, "!dj": 0, "!shuffle": 0 }; } });
  h.button("Chat apps").click(); assert.match(h.doc.querySelector(".rmd-layer").textContent, /Music/);
  h.button("DJ", h.doc.querySelector(".rmd-layer")).click();
  const sheet = h.doc.querySelector(".rmd-layer");
  assert.match(sheet.textContent, /No music in this room right now/, "no booth here");
  for (const name of ["Find a song (!find), free", "Request a song (!play), 500 PAT", "Now playing (!np), free", "Vote skip (!skip), free"]) h.button(name, sheet);
  assert.doesNotMatch(sheet.textContent, /Auto-DJ|Shuffle/, "no staff tiles without the role");
  h.button("Find a song (!find), free", sheet).click(); assert.equal(h.input.value, "!find "); assert.equal(h.calls.send.length, 0);
  const d = F.initial(); d.room.cmds = { "!dj": 0, "!shuffle": 0, "!np": 0 }; d.mod = { actions: ["kick"], roles: ["admin"] }; h.controller.update(d);
  h.button("Chat apps").click(); h.button("DJ", h.doc.querySelector(".rmd-layer")).click();
  const s2 = h.doc.querySelector(".rmd-layer"); h.button("Auto-DJ on (!dj on), free", s2).click(); assert.equal(h.input.value, "!dj on");
  assert.equal(h.calls.send.length, 0);
});
test("item 30: ＋ › Create - a poll / wager / bounty form sends the typed command after one press (a million asks again); a market opens /markets", () => {
  const h = harness({ data: (d) => { d.room.cmds = { "!poll": 0, "!wager": 0, "!bounty": 0, "!market": 0 }; } });
  h.button("Add to the chat").click(); const m = menuOf(h.doc);
  assert.match(m.textContent, /Create/); assert.deepEqual(labels(m).slice(-4), ["Poll…", "Wager…", "Bounty…", "Market ↗"]);
  const mk = m.querySelectorAll("a").find((a) => /Market/.test(a.textContent)); assert.equal(mk.getAttribute("href"), "/markets?pad=night-orchard"); assert.equal(mk.target, "_blank");
  h.button("Poll…", m).click();
  let sheet = h.doc.querySelector(".rmd-layer"), ins = sheet.querySelectorAll("input");
  // (1.99?? dockpol fix (review): Pepe reads the question to its FIRST "?" and splits options at commas - both are said, never changed)
  ins[0].value = "Pizza or tacos? Or neither"; ins[1].value = "Pizza"; ins[2].value = "Tacos obviously";
  sheet.querySelector("form").dispatchEvent(new Event("submit")); assert.equal(h.calls.send.length, 0); assert.match(sheet.textContent, /one question mark/);
  ins[0].value = "Pizza or tacos?"; ins[2].value = "Tacos, obviously";
  sheet.querySelector("form").dispatchEvent(new Event("submit")); assert.equal(h.calls.send.length, 0); assert.match(sheet.textContent, /comma/);
  ins[2].value = "Tacos obviously";
  sheet.querySelector("form").dispatchEvent(new Event("submit")); assert.deepEqual(h.calls.send, ["!poll Pizza or tacos? Pizza, Tacos obviously"]);
  h.button("Add to the chat").click(); h.button("Wager…", menuOf(h.doc)).click();
  sheet = h.doc.querySelector(".rmd-layer");
  const [who, judge] = sheet.querySelectorAll("select"), texts = sheet.querySelectorAll("input");
  const people = F.initial().members.filter((u) => u && !u.veil && !u.anon && !u.self && u.login);
  assert.deepEqual(who.children.slice(1).map((o) => o.value), people.map((u) => u.login), "named Camfrog members only");
  // (1.99?? dockpol fix (review): a judge is required - Pepe (his AI judge) is the first choice and the default)
  assert.equal(judge.value, "pepe"); assert.equal(judge.children[1].value, "pepe");
  who.value = people[0].login; texts[0].value = "2m"; texts[1].value = "the Bills win"; judge.value = "";
  const form = sheet.querySelector("form"); form.dispatchEvent(new Event("submit"));
  assert.equal(h.calls.send.length, 1, "no judge: nothing sent"); assert.match(sheet.textContent, /Pick a judge/);
  judge.value = people[1].login; form.dispatchEvent(new Event("submit"));
  assert.equal(h.calls.send.length, 1, "a million or more: press again"); assert.match(sheet.textContent, /press again/);
  form.dispatchEvent(new Event("submit")); assert.equal(h.calls.send[1], "!wager @" + people[0].login + " 2000000 the Bills win judge @" + people[1].login);
  h.button("Add to the chat").click(); h.button("Bounty…", menuOf(h.doc)).click();
  sheet = h.doc.querySelector(".rmd-layer"); const bi = sheet.querySelectorAll("input"); bi[0].value = "someone sings it"; bi[1].value = "5k"; sheet.querySelector("select").value = "2d";
  h.button("Cancel", sheet).click(); assert.equal(h.calls.send.length, 2, "Cancel sends nothing");
  h.button("Add to the chat").click(); h.button("Bounty…", menuOf(h.doc)).click();
  sheet = h.doc.querySelector(".rmd-layer"); const b2 = sheet.querySelectorAll("input"); b2[0].value = "someone sings it"; b2[1].value = "5k"; sheet.querySelector("select").value = "2d";
  sheet.querySelector("form").dispatchEvent(new Event("submit")); assert.equal(h.calls.send[2], "!bounty someone sings it 5000 by 2d");
  const off = harness({ opts: { linked: false }, data: (d) => { d.room.cmds = { "!poll": 0 }; } }); off.button("Add to the chat").click();
  assert.doesNotMatch(menuOf(off.doc).textContent, /Create|Poll/, "only what this viewer may use");
});

// ── items 13, 14, 19: focus, the chat header, the people header ──
test("item 13: a sheet a pointer opened starts on its box (never ✕ with a ring) and gives focus back quietly; a keyboard one returns as before", () => {
  const h = harness(), tip = h.button("Tip", h.compose.querySelector(".rmd-tools"));
  h.doc.dispatchEvent(new Event("pointerdown", { bubbles: true })); tip.click(); h.tick();
  const box = h.doc.querySelector(".rmd-layer .ds-modal"); assert.equal(h.doc.activeElement === box, true, "the box, not ✕");
  h.button("Close", box).click(); assert.equal(h.doc.activeElement === tip, true); assert.equal(tip.hasAttribute("data-rmd-quiet"), true, "no ring after a tap");
  tip.dispatchEvent(new Event("keydown", { key: "Tab" })); assert.equal(tip.hasAttribute("data-rmd-quiet"), false, "the next key brings the ring back");
  h.doc.dispatchEvent(new Event("keydown", { key: "Enter" })); tip.click(); h.tick();
  assert.equal(h.doc.activeElement.getAttribute("aria-label"), "Close", "keyboard: the first control, as before");
  h.button("Close", h.doc.querySelector(".rmd-layer")).click(); assert.equal(tip.hasAttribute("data-rmd-quiet"), false);
});
test("items 14, 19: no visible CHAT word (it stays the section's name); an editor gets ✏️ Set a topic; the people heading has no ℹ️ and a count badge", () => {
  let can = true;
  const h = harness({ mod: true, opts: { canTopic: () => can } });
  const word = h.chatH.querySelector(".rmd-chat-t"); assert.ok(word.classList.contains("ds-sr-only")); assert.equal(word.textContent, "Chat");
  const d = F.initial(); d.room.topic = ""; h.doc.getElementById("rmTopic").textContent = ""; h.controller.update(d);
  const set = h.chatH.querySelector(".rmd-set-topic"); assert.ok(set && !set.hidden, "an editor: ✏️ Set a topic");
  set.click(); h.tick(); assert.equal(h.calls.topic, 1, "the same editor");
  can = false; h.controller.update(d); assert.equal(set.hidden, true, "everyone else: nothing");
  assert.equal(h.chatH.querySelector(".rmd-topic-line").hidden, false, "the empty row keeps the buttons at the end");
  assert.equal(h.ppl.querySelector(".rmd-info"), null); assert.ok(h.doc.getElementById("rmPplN").classList.contains("rmd-count"));
});

// ── items 9, 11: the navbar on a phone's Live view, Feed / About's slim header ──
test("item 9: the navbar steps aside only on a phone's Live view and comes back; the pad menu offers ☰ Site menu meanwhile; never hidden from the DOM", () => {
  const h = harness({ fine: false, width: 390 });
  h.win.matchMedia = (q) => ({ matches: /max-width: 760px/.test(q) });
  const h2 = harness();   // (a fresh controller after matchMedia exists)
  void h2;
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /body\.pad-dock-live\.rmd-nav-auto > header \{ transition: margin-block-start 180ms var\(--ds-ease\); \}/);
  const js = read("public", "js", "pad-dock.js");
  assert.match(js, /if \(acc >= 24\) \{ acc = 0; setNav\(true\); \} else if \(acc <= -48\) \{ acc = 0; setNav\(false\); \}/, "24px toward newer lines hides it, 48px back shows it");
  assert.match(js, /if \(!navOk\(\) \|\| Date\.now\(\) - userAt > 1500 \|\| !d\) return;/, "only the reader's own scrolling counts");
  assert.match(js, /on\(navHeader, 'focusin', function \(\) \{ setNav\(false\); \}\);/, "focus in the navbar brings it back");
  assert.match(js, /if \(navOff && navHeader\) menuItem\(box, '☰', 'site_menu', 'Site menu'/);
  assert.doesNotMatch(js, /navHeader\.(hidden|inert)|setAttribute\('inert'/, "never hidden or inert");
  assert.match(js, /return mq && D\.body\.classList\.contains\('pad-dock-live'\) && !\(current && \(current\.kind === 'full' \|\| current\.kind === 'float'\)\) && !inPip\(\);/);
});
test("item 11: Feed / About share Live's frame (width, no footer) and a tab switch goes through the page's top in a view transition", () => {
  const css = read("public", "css", "pad-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /main\.rm\.rm-dock:not\(\.rmd-home\):not\(\.rmd-popout\) \{ --ds-w: min\(1600px, 100%\); max-inline-size: min\(1600px, 100%\); \}/);
  assert.match(css, /body\.rmd-dock-pad \.site-foot \{ display: none; \}/);
  const tabs = read("public", "js", "pad-tabs.js");
  assert.match(tabs, /var sw = root\.PATVPadSwitch;\n\s+if \(typeof sw === 'function' && t !== current\)/);
  const js = read("public", "js", "pad-dock.js");
  assert.match(js, /try \{ W\.scrollTo\(0, 0\); \} catch/); assert.match(js, /if \(!reduce && D\.startViewTransition\) \{ try \{ D\.startViewTransition\(fn\); return; \}/);
  const h = harness({ feed: true }); assert.equal(h.doc.body.classList.contains("rmd-dock-pad"), true);
});

// ── H5 / H6: the homepage ──
test("H5 (bridge.js, home.js): the homepage asks for the capture surface; the mic stage only for a signed-in viewer with access", () => {
  const b = read("bridge.js");
  assert.match(b, /const home = req\.query\.home === "1";/); assert.match(b, /surface: home \? "capture" : "pad"/);
  assert.match(b, /stageProgram\(prog, R, userId, L, F, opts\.surface === "capture" \? "capture" : "pad"\)/);
  const h = read("home.js");
  assert.match(h, /const homeMic_ = !!\(me && padDockOn_ && roomOnStage_ && roomLive && roomGate === "ok" && PA\.full\(viewer, front\.id\)\);/);
  const hd = read("public", "js", "home-dock.js");
  assert.match(hd, /\(I\.micStage \? '&home=1' : ''\)/);
  assert.match(hd, /k !== 'manage' && k !== 'report'/); assert.match(hd, /j !== 'rv' && j !== 'ex' && j !== 'cv' && j !== 'self'/, "no cover controls ever reach it");
  assert.match(hd, /W\.PATVAvSync\.gateProgram\(slug, prog, show\)/, "the same A/V gate as the pad page");
});
test("H6 (home.js, home.ejs): GET /?dock=1 renders the Dock block alone - the same gates, private and never stored", async () => {
  const h = read("home.js");
  assert.match(h, /const frag = req\.query\.dock === "1";/);
  assert.match(h, /if \(!padDockOn_\) return res\.status\(404\)/); assert.match(h, /res\.set\("Cache-Control", "private, no-store"\)/);
  const ejs = require("ejs"), BM = require(path.join(repo, "boostmark")), UL = require(path.join(repo, "userlinks"));
  const room = { id: "Alpha", slug: "alpha", name: "Alpha Room", count: 4, micCount: 1, live: true, topic: "Tonight" };
  const html = await ejs.renderFile(path.join(repo, "views", "home.ejs"), { username: null, me: null, mine: null, S: {}, rooms: [room], room, roomLive: F.initial(), roomGate: "ok", stage: { active: true }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: true, stageAdmin: null, frontInfo: { id: "Alpha", slug: "alpha", title: "Alpha Room", pinned: false, owner: null, boost: 0 }, pepeHere: true,
    slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "", boostMark: BM.boostMark, ul: UL, nextUp: null, padDockOn: true, dockFragment: true });
  assert.match(html, /id="hmDock"/); assert.match(html, /<script id="hmdInit" type="application\/json">/);
  assert.doesNotMatch(html, /<header|<nav|stageSide|id="stageShow"|class="card me"|<script src=/, "the block alone - no navbar, side widgets, cards or scripts");
  const js = read("public", "js", "home-dock.js");
  assert.match(js, /fetch\('\/\?dock=1', \{ credentials: 'same-origin', cache: 'no-store'/);
  assert.match(js, /if \(cur && cur\.busy\(\)\) \{ offerSwitch\(f\); return; \}/, "busy: a Switch chip instead");
  assert.match(js, /if \(cur\) cur\.teardown\(\);/);
  assert.match(read("public", "js", "stage-room.js"), /function destroy\(\) \{\n\s+dead = true; clearInterval\(pollTimer\);/);
});
test("H7: the scrolling homepage sizes in svh (a vh fallback first) - the URL bar collapsing never grows the chat card", () => {
  const css = read("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /dvh/, "no dvh on the homepage");
  assert.match(css, /block-size: clamp\(360px, 62vh, 520px\); block-size: clamp\(360px, 62svh, 520px\);/);
  assert.match(css, /max-block-size: min\(560px, calc\(100vh - 140px\)\); max-block-size: min\(560px, calc\(100svh - 140px\)\);/);
});
