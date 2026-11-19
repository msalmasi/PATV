"use strict";
// 1.99aot gifs: the browser half of the FREE mode, in the deterministic DOM (fixtures/pad-dock/dom.cjs) with a fake fetch:
//   * the picker (pad-picker.js): the one-time KLIPY notice BEFORE any KLIPY request (trending too), recorded on the site; KLIPY's own
//     API from the browser with the pad's rating, no customer id / locale / cookies; results in KLIPY's order (malformed items skipped);
//     a pick hands the relay the token + the GIF's details; the share trigger only once the site took the line (q = the search words,
//     '' for trending); partner mode unchanged;
//   * the relay outbox (room-bridge.js): the details ride with the line (and its retry), the sender's pending line shows the picture,
//     onPosted fires once;
//   * chatlog-core.js: "GIF no longer available" for a GIF removed everywhere and for a picture that no longer loads; data-gif;
//   * chat-lines.js: 🚫 Remove this GIF everywhere… on GIF lines for whoever may hide them, and its POST.
//   NODE_PATH=G:/PATV/node_modules node --test test/gifs-free-ui.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Document, Event } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
const picker = fs.readFileSync(path.join(repo, "public/js/pad-picker.js"), "utf8");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const KEY = "fixtureBrowserKey_0123456789", API = "https://api.klipy.com/api/v1/" + KEY + "/gifs/";
// KLIPY's CDN shape (docs.klipy.com trending example): every size and format of one GIF in /ii/<32 hex>/<2 hex>/<2 hex>/
const hashOf = (slug) => require("node:crypto").createHash("md5").update(slug).digest("hex");
const dirOf = (slug) => "/ii/" + hashOf(slug) + "/aa/bb/";
const item = (slug, over = {}) => ({ id: 1000 + slug.length, slug, title: "<b>" + slug + "</b>", type: "gif", tags: [], blur_preview: "data:image/jpeg;base64,AA==",
  file: { xs: { gif: { url: "https://static.klipy.com" + dirOf(slug) + slug.replace(/[^A-Za-z0-9]/g, "") + "xs.gif", width: 90, height: 60, size: 1 }, webp: { url: "https://static.klipy.com" + dirOf(slug) + slug.replace(/[^A-Za-z0-9]/g, "") + "xs.webp", width: 90, height: 60, size: 1 } },
          sm: { gif: { url: "https://static2.klipy.com" + dirOf(slug) + slug.replace(/[^A-Za-z0-9]/g, "") + "sm.gif", width: 220, height: 146, size: 1 }, webp: { url: "https://static2.klipy.com" + dirOf(slug) + slug.replace(/[^A-Za-z0-9]/g, "") + "sm.webp", width: 220, height: 146, size: 1 } } }, ...over });
const klipyBody = (rows) => ({ result: true, data: { data: rows, current_page: 1, per_page: 24, has_next: false } });
const answer = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

function pickerPage(room, onFetch) {
  const doc = new Document(), root = doc.createElement("main"); root.className = "rm rm-dock"; doc.body.appendChild(root);
  const input = doc.createElement("input"); input.value = "draft"; root.appendChild(input);
  const calls = { requests: [], send: [], closed: 0 };
  const win = { URL, fetch(url, opts) { calls.requests.push({ url, opts }); return onFetch ? onFetch(url, opts) : answer(klipyBody([])); } };
  vm.runInNewContext(picker, { window: win });
  let sheet;
  const opts = { root, signed: true, slug: "night-orchard", data: { room: Object.assign({ relay: true, gifPicker: true }, room) },
    relay: { getInput: () => input, _send(token, extra) { calls.send.push({ token, extra }); return true; }, insert: () => "" },
    sheet() { sheet = doc.createElement("section"); sheet.className = "ds-modal"; root.appendChild(sheet); return sheet; },
    closeLayer() { calls.closed++; if (sheet) sheet.remove(); }, tab: "gifs" };
  const p = win.PATVPadPicker.open(opts);
  return { doc, win, calls, opts, picker: p, get sheet() { return sheet; } };
}

test("free picker: the KLIPY notice comes first - no request to KLIPY (not even trending) until it's accepted; accepting records it on the site", async () => {
  const h = pickerPage({ gifFree: { k: KEY, r: "high", n: false } }, (url) => (/^https:\/\/api\.klipy\.com\//.test(url) ? answer(klipyBody([item("wave-hi")])) : answer({ ok: true })));
  await flush();
  assert.equal(h.picker.current(), "gifs");
  assert.deepEqual(h.calls.requests, [], "nothing at all before the notice is accepted");
  assert.match(h.sheet.textContent, /GIF search is provided by KLIPY\. When you search or browse GIFs, what you type and your IP address go to KLIPY/);
  const link = h.sheet.querySelector("a"); assert.equal(link.href, "https://klipy.com/support/privacy-policy"); assert.equal(link.rel, "noopener noreferrer"); assert.equal(link.target, "_blank");
  assert.equal(h.sheet.querySelector("input"), null, "no search box yet");
  const ok = h.sheet.querySelectorAll("button").find((b) => /OK, show GIFs/.test(b.textContent));
  ok.click(); await flush();
  assert.equal(h.calls.requests[0].url, "/api/gifs/notice"); assert.equal(h.calls.requests[0].opts.method, "POST");
  assert.equal(h.calls.requests[0].opts.headers["X-Requested-With"], "fetch"); assert.equal(h.calls.requests[0].opts.credentials, "same-origin");
  assert.equal(h.calls.requests[1].url, API + "trending?per_page=24&content_filter=high&format_filter=gif,webp", "then KLIPY's trending, from the browser");
  assert.equal(h.opts.data.room.gifFree.n, true, "this page won't ask again");
  // a member who saw it already: straight to trending
  const seen = pickerPage({ gifFree: { k: KEY, r: "low", n: true } }, () => answer(klipyBody([])));
  await flush();
  assert.equal(seen.calls.requests.length, 1); assert.equal(seen.calls.requests[0].url, API + "trending?per_page=24&content_filter=low&format_filter=gif,webp", "an 18+ pad: low");
});

test("free picker: KLIPY's own API with the pad's rating, no cookies / customer id / locale; results in KLIPY's order, malformed items skipped, attribution kept", async () => {
  const rows = [item("first-one"), item("bad-host", { file: { sm: { gif: { url: "https://static.klipy.com.evil.invalid/x.gif", width: 1, height: 1 } } } }),
    item("ad-item", { type: "ad" }), item("bad slug!"), item("second-one"), item("no-file", { file: null }),
    item("bad-dims", { file: { sm: { gif: { url: "https://static.klipy.com" + dirOf("bad-dims") + "b.gif", width: 0, height: 9 } } } }), item("third-one", { title: "<img onerror=alert(1)>Third" }),
    item("odd-path", { file: { sm: { gif: { url: "https://static.klipy.com/anything/at/all/x.gif", width: 9, height: 9 } } } })];
  const h = pickerPage({ gifFree: { k: KEY, r: "high", n: true } }, () => answer(klipyBody(rows)));
  await flush();
  const first = h.calls.requests[0];
  assert.equal(first.opts.credentials, "omit"); assert.equal(first.opts.method, "GET"); assert.equal(first.opts.cache, "no-store");
  assert.equal(first.opts.headers["X-Requested-With"], undefined, "no site headers to KLIPY"); assert.doesNotMatch(first.url, /customer_id|locale/);
  const tiles = h.sheet.querySelectorAll(".rmp-grid button");
  assert.deepEqual(tiles.map((b) => b.title), ["first-one", "second-one", "Third"], "KLIPY's order; malformed ones skipped");
  assert.equal(tiles[0].querySelector("img").src, "https://static.klipy.com" + dirOf("first-one") + "firstonexs.webp", "the small preview, webp first");
  assert.equal(h.sheet.querySelector("input").placeholder, "Search KLIPY", "KLIPY's required placeholder"); assert.match(h.sheet.textContent, /via KLIPY/);
  const input = h.sheet.querySelector("input"); input.value = "  cats & dogs  ";
  h.sheet.querySelector("form").dispatchEvent(new Event("submit")); await flush();
  assert.equal(h.calls.requests[1].url, API + "search?q=cats%20%26%20dogs&per_page=24&content_filter=high&format_filter=gif,webp");
  assert.equal(h.calls.requests.length, 2, "typing alone never searches");
});

test("free picker: a pick sends the token + the GIF's details through the relay; the share trigger goes only once the site took it (q = the search words, '' for trending)", async () => {
  const h = pickerPage({ gifFree: { k: KEY, r: "high", n: true } }, () => answer(klipyBody([item("wave-hi")])));
  await flush();
  h.sheet.querySelectorAll(".rmp-grid button")[0].click();
  assert.equal(h.calls.send.length, 1); assert.equal(h.calls.closed, 1, "the sheet closes back to the composer");
  const { token, extra } = h.calls.send[0];
  assert.equal(token, "[gif:wave-hi]");
  assert.deepEqual(JSON.parse(JSON.stringify(extra.gif)), { src: "https://static2.klipy.com" + dirOf("wave-hi") + "wavehism.webp", w: 220, h: 146, title: "wave-hi", page: "https://klipy.com/gifs/wave-hi" });
  assert.equal(h.calls.requests.length, 1, "no share trigger before the site took the line");
  extra.onPosted(); await flush();
  const share = h.calls.requests[1];
  assert.equal(share.url, API + "share/wave-hi"); assert.equal(share.opts.method, "POST"); assert.equal(share.opts.credentials, "omit");
  assert.equal(share.opts.keepalive, true); assert.equal(share.opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(share.opts.body), { q: "" }, "trending: empty q, no customer id");
  // a searched one: q = the words
  const s = pickerPage({ gifFree: { k: KEY, r: "high", n: true } }, () => answer(klipyBody([item("cat-nap")])));
  await flush();
  const box = s.sheet.querySelector("input"); box.value = "sleepy cat"; s.sheet.querySelector("form").dispatchEvent(new Event("submit")); await flush();
  box.value = "something else typed later";
  s.sheet.querySelectorAll(".rmp-grid button")[0].click(); s.calls.send[0].extra.onPosted(); await flush();
  assert.deepEqual(JSON.parse(s.calls.requests.at(-1).opts.body), { q: "sleepy cat" }, "the words the results came from");
  // a failed share is swallowed (the line is sent already)
  const f = pickerPage({ gifFree: { k: KEY, r: "high", n: true } }, (url) => (/share/.test(url) ? Promise.reject(new Error("offline")) : answer(klipyBody([item("wave-hi")]))));
  await flush(); f.sheet.querySelectorAll(".rmp-grid button")[0].click(); f.calls.send[0].extra.onPosted(); await flush();
});

test("free picker: KLIPY unavailable says so plainly; a malformed browser key means the partner picker (the site's search), as before", async () => {
  const h = pickerPage({ gifFree: { k: KEY, r: "high", n: true } }, () => answer({ result: false }, 429));
  await flush();
  assert.match(h.sheet.textContent, /Could not load this right now/); assert.doesNotMatch(h.sheet.textContent, new RegExp(KEY));
  const p = pickerPage({ gifFree: { k: "bad key!", r: "high", n: true } }, () => answer([]));
  await flush();
  assert.equal(p.calls.requests[0].url, "/api/gifs/search", "no free picker without a valid key");
  const partner = pickerPage({}, () => answer([{ id: "gif_safe", title: "Safe", preview: { src: "https://static.klipy.com/safe.gif" } }]));
  await flush();
  assert.equal(partner.calls.requests[0].url, "/api/gifs/search"); assert.equal(partner.calls.requests[0].opts.method, "POST");
  partner.sheet.querySelectorAll(".rmp-grid button")[0].click();
  assert.equal(partner.calls.send.length, 1); assert.equal(partner.calls.send[0].token, "[gif:gif_safe]"); assert.equal(partner.calls.send[0].extra.gif, undefined, "partner picks send the token only (no details)");
  assert.equal(partner.win.PATVPadPicker._cdnOk("https://STATIC.klipy.com/a.gif"), false);
  assert.equal(partner.win.PATVPadPicker._cdnOk("https://static.klipy.com" + dirOf("x") + "b.webp"), true);
  // review: KLIPY's path only (the server's cdnSrc) - never any other file on the CDN
  assert.equal(partner.win.PATVPadPicker._cdnOk("https://static.klipy.com/ii/a/b.webp"), false);
  assert.equal(partner.win.PATVPadPicker._cdnOk("https://static.klipy.com/anything/at/all/x.gif"), false);
  assert.doesNotMatch(picker, /innerHTML|localStorage|sessionStorage|KLIPY_API_KEY|KLIPY_PUBLIC_KEY|customer_id/);
});

// owner 2026-11-19 ("lets stick to their rules"): KLIPY's rules say Search and Trending results are never removed, suppressed or filtered.
// A GIF removed on PATV stays in its place among KLIPY's results (both modes); the site refuses to send it, and picking it again on the
// same page says so plainly in the picker - no second send. (The site's side of it - the refusal and its words - is gifs-free.test.js.)
const tileTitles = (h) => h.sheet.querySelectorAll(".rmp-grid button").map((x) => x.title);
const statusOf = (h) => h.sheet.querySelector("[role=status]");
test("owner: the free picker draws KLIPY's answer in KLIPY's order, a GIF removed on PATV included; refused once, picking it again says so - no second send", async () => {
  const rows = [item("keep-one"), item("gone-one"), item("keep-two", { id: 424242 })];
  // a page data object that still carries a list of removed GIFs (an older server's): ignored - nothing is left out
  const h = pickerPage({ gifFree: { k: KEY, r: "high", n: true, b: ["gone-one", hashOf("gone-one") + "/aa/bb", "424242"] } }, () => answer(klipyBody(rows)));
  await flush();
  assert.deepEqual(tileTitles(h), ["keep-one", "gone-one", "keep-two"], "KLIPY's order, all of it");
  assert.deepEqual([...h.win.PATVPadPicker._freeRows(klipyBody(rows))].map((r) => r.id), ["keep-one", "gone-one", "keep-two"]);   // (the page's realm)
  // the pick goes to the site, which refuses it as removed everywhere (gif_removed)
  h.sheet.querySelectorAll(".rmp-grid button")[1].click();
  assert.equal(h.calls.send.length, 1); assert.equal(h.calls.send[0].token, "[gif:gone-one]"); assert.equal(h.calls.closed, 1);
  assert.equal(typeof h.calls.send[0].extra.onPosted, "function", "the share trigger still waits for the site");
  h.calls.send[0].extra.onRefused("gif_removed");
  // the sheet again: still offered in its place; picking it says so, plainly, and sends nothing
  h.win.PATVPadPicker.open(h.opts); await flush();
  assert.deepEqual(tileTitles(h), ["keep-one", "gone-one", "keep-two"], "never left out, never re-ranked");
  h.sheet.querySelectorAll(".rmp-grid button")[1].click();
  assert.equal(h.calls.send.length, 1, "no second send"); assert.equal(h.calls.closed, 1, "the sheet stays open to say why");
  assert.equal(statusOf(h).textContent, "This GIF was removed on PATV."); assert.equal(statusOf(h).hidden, false);
  // any other refusal is not "removed": that GIF can be picked again
  h.sheet.querySelectorAll(".rmp-grid button")[2].click();
  assert.equal(h.calls.send.length, 2); h.calls.send[1].extra.onRefused("gif");
  h.win.PATVPadPicker.open(h.opts); await flush();
  h.sheet.querySelectorAll(".rmp-grid button")[2].click();
  assert.equal(h.calls.send.length, 3, "an ordinary refusal: picked again, sent again"); assert.equal(h.calls.send[2].token, "[gif:keep-two]");
  assert.doesNotMatch(picker, /gifFree\.b|goneHere|pageBlocks/, "no list of removed GIFs in the picker");
});

test("owner: partner mode the same - the site's search answer drawn as it comes, a removed GIF included; picked again, the picker says so", async () => {
  const rows = [{ id: "gif_one", title: "One", preview: { src: "https://static.klipy.com/one.gif" } }, { id: "gif_gone", title: "Gone", preview: { src: "https://static.klipy.com/gone.gif" } },
    { id: "gif_two", title: "Two", preview: { src: "https://static2.klipy.com/two.gif" } }];
  const h = pickerPage({}, () => answer(rows));
  await flush();
  assert.equal(h.calls.requests[0].url, "/api/gifs/search");
  assert.deepEqual(tileTitles(h), ["One", "Gone", "Two"], "the server's (KLIPY's) order, all of it");
  h.sheet.querySelectorAll(".rmp-grid button")[1].click();
  assert.equal(h.calls.send.length, 1); assert.equal(h.calls.send[0].token, "[gif:gif_gone]"); assert.equal(h.calls.send[0].extra.gif, undefined);
  h.calls.send[0].extra.onRefused("gif_removed");
  h.win.PATVPadPicker.open(h.opts); await flush();
  assert.deepEqual(tileTitles(h), ["One", "Gone", "Two"], "still offered in its place");
  h.sheet.querySelectorAll(".rmp-grid button")[1].click();
  assert.equal(h.calls.send.length, 1, "no second send"); assert.equal(statusOf(h).textContent, "This GIF was removed on PATV.");
  h.sheet.querySelectorAll(".rmp-grid button")[0].click(); assert.equal(h.calls.send.length, 2, "another GIF goes as usual");
});

test("review: the notice, once accepted on this page, stays accepted - a sheet opened with a newer data object (n still false) goes straight to GIFs", async () => {
  const h = pickerPage({ gifFree: { k: KEY, r: "high", n: false } }, (url) => (/^https:\/\/api\.klipy\.com\//.test(url) ? answer(klipyBody([item("wave-hi")])) : answer({ ok: true })));
  await flush();
  h.sheet.querySelectorAll("button").find((b) => /OK, show GIFs/.test(b.textContent)).click(); await flush();
  const before = h.calls.requests.length;
  h.opts.closeLayer();
  // a live poll replaced the Dock's data while the notice was up: a fresh object, its n still false
  const again = h.win.PATVPadPicker.open(Object.assign({}, h.opts, { data: { room: { relay: true, gifPicker: true, gifFree: { k: KEY, r: "high", n: false } } } }));
  assert.ok(again); await flush();
  assert.doesNotMatch(h.sheet.textContent, /GIF search is provided by KLIPY/, "not asked again");
  assert.equal(h.calls.requests.length, before + 1); assert.match(h.calls.requests.at(-1).url, /\/gifs\/trending\?/);
});

test("review: after 'OK, show GIFs' focus goes to the search box (a fine pointer) or the panel (touch: no uninvited keyboard)", async () => {
  for (const [fine, want] of [[true, "INPUT"], [false, "panel"], [null, "panel"]]) {
    const h = pickerPage({ gifFree: { k: KEY, r: "high", n: false } }, () => answer(klipyBody([])));
    if (fine !== null) h.win.matchMedia = (q) => ({ matches: q === "(pointer: fine)" && fine });
    await flush();
    const ok = h.sheet.querySelectorAll("button").find((b) => /OK, show GIFs/.test(b.textContent));
    ok.focus(); ok.click(); await flush();
    const a = h.doc.activeElement;
    if (want === "INPUT") { assert.equal(a.tagName.toUpperCase(), "INPUT"); assert.equal(a.placeholder, "Search KLIPY"); }
    else { assert.ok(a.classList.contains("rmp-body"), "the panel: " + a.tagName); assert.equal(a.tabIndex, -1); }
    assert.ok(a.isConnected, "never a removed node");
  }
});

// ── the relay outbox ──
function relayPage(onPost) {
  const doc = new Document(), win = { document: doc, addEventListener() {}, navigator: {} };
  const posted = [];
  const ctx = { window: win, document: doc, navigator: {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, console, JSON, Date, Math, Promise,
    fetch: (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return onPost(posted.length); } };
  win.fetch = ctx.fetch;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  const CL = require(path.join(repo, "public", "js", "chatlog-core.js")), h = CL.domH(doc);
  win.PATVChatlog = CL;                                   // (the page's renderer, as chatlog-core.js sets it)
  const host = doc.createElement("div"), feed = doc.createElement("div"); doc.body.appendChild(host); doc.body.appendChild(feed);
  const R = win.PATVRoom.relay(host, "alpha", { feed, line: (it) => CL.renderItem(it, {}, h) });
  R.update({ room: { relay: true }, mine: [] });
  return { doc, R, posted, feed };
}
test("relay: a GIF pick's details ride with the line (and a retry); the pending line shows the picture; onPosted once, only when the site took it", async () => {
  let n = 0;
  const P = relayPage((i) => Promise.resolve({ status: i === 1 ? 403 : 200, json: () => Promise.resolve(i === 1 ? { ok: false, code: "gif", error: "That GIF isn't available here." } : { ok: true, id: "w0123456789abcdef" }) }));
  const gif = { src: "https://static2.klipy.com/ii/aa/bb/wave.webp", w: 220, h: 146, title: "Wave", page: "https://klipy.com/gifs/wave-hi" };
  assert.equal(P.R._send("[gif:wave-hi]", { gif, onPosted: () => n++ }), true);
  await flush();
  assert.deepEqual(P.posted[0].body.gif, gif); assert.equal(P.posted[0].body.text, "[gif:wave-hi]");
  assert.equal(n, 0, "refused: no share trigger");
  const pending = P.feed.querySelector("[data-cid]");
  assert.ok(pending && pending.classList.contains("rb-opt-failed"), "refused: the line says so");
  assert.ok(pending.querySelector("img.gif"), "the sender sees the picture while it's on its way");
  assert.equal(pending.querySelector("img.gif").getAttribute("src"), gif.src);
  pending.querySelectorAll("button").find((b) => /Retry/.test(b.textContent)).click(); await flush();
  assert.deepEqual(P.posted[1].body.gif, gif, "the retry carries them again");
  assert.equal(n, 1, "accepted: once");
  // an ordinary line's body is unchanged
  P.R._send("hello"); await flush();
  assert.deepEqual(Object.keys(P.posted[2].body).sort(), ["cid", "text"]);
});

test("review: a pick of a GIF moderators removed everywhere - its picture gives way to 'GIF no longer available', the line says it was removed on PATV, and no Retry (it can never be sent)", async () => {
  const P = relayPage(() => Promise.resolve({ status: 403, json: () => Promise.resolve({ ok: false, code: "gif_removed", error: "This GIF was removed on PATV." }) }));
  const gif = { src: "https://static2.klipy.com" + dirOf("wave-hi") + "wave.webp", w: 220, h: 146, title: "Wave", page: "https://klipy.com/gifs/wave-hi" };
  const heard = [];
  P.R._send("[gif:wave-hi]", { gif, onRefused: (code) => heard.push(code) }); await flush();
  assert.deepEqual(heard, ["gif_removed"], "the picker hears why (picked again on this page, it says so)");
  const pending = P.feed.querySelector("[data-cid]");
  assert.ok(pending.classList.contains("rb-opt-failed"));
  assert.equal(pending.querySelector("img"), null, "no picture of a removed GIF"); assert.equal(pending.querySelector(".gif-gone").textContent, "GIF no longer available");
  assert.match(pending.textContent, /not sent — This GIF was removed on PATV\./, "plainly: PATV removed it, not KLIPY");
  const labels = pending.querySelectorAll("button").map((b) => b.textContent);
  assert.ok(!labels.some((l) => /Retry/.test(l)), "no Retry"); assert.ok(labels.includes("✕"), "✕ still drops it");
  // any other refusal keeps its Retry
  const Q = relayPage(() => Promise.resolve({ status: 403, json: () => Promise.resolve({ ok: false, code: "gif", error: "That GIF isn't available here." }) }));
  Q.R._send("[gif:wave-hi]", { gif }); await flush();
  assert.ok(Q.feed.querySelector("[data-cid]").querySelectorAll("button").some((b) => /Retry/.test(b.textContent)));
  assert.ok(Q.feed.querySelector("[data-cid] img.gif"));
});

// ── the admin card ──
function adminCard(data) {
  const doc = new Document(), ids = {};
  for (const id of ["paddockForm", "paddockFields", "paddockMessage", "paddockAudit", "paddockReset", "paddockGifs"]) ids[id] = doc.createElement(id === "paddockForm" ? "form" : id === "paddockReset" ? "button" : "div");
  doc.getElementById = (id) => ids[id] || null;
  const form = ids.paddockForm; form.appendChild(ids.paddockFields); form.appendChild(ids.paddockGifs); form.appendChild(ids.paddockReset);
  Object.defineProperty(form, "elements", { get: () => Object.fromEntries([...form.querySelectorAll("input"), ...form.querySelectorAll("select")].map((n) => [n.name, n])) });
  const fields = { mode: { def: "off", choices: ["off", "staff", "everyone"] }, cfstickers: { def: false }, gifs: { def: "off", choices: ["off", "free", "partner"] } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public/js/admin-paddock.js"), "utf8"), { window: {}, document: doc,
    fetch: async () => ({ json: async () => ({ ok: true, fields, audit: [], ...data }) }) });
  return ids;
}
test("review: the admin card's missing-key warning names the mode and the variable plainly; a browser key equal to the server key says so; no reasons listed", async () => {
  const st = (free, partner) => ({ keys: { free, partner }, on: false, blocks: [{ id: "gone-1", at: 1, room: "Fixture.Room", kind: "mod", why: "a reason naming someone" }] });
  let ids = adminCard({ cfg: { mode: "everyone", cfstickers: false, gifs: "partner" }, gifs: st("set", "missing") });
  await flush();
  assert.match(ids.paddockGifs.textContent, /⚠️ GIFs are not on: Partner mode needs KLIPY_API_KEY \(missing\)\./);
  assert.doesNotMatch(ids.paddockGifs.textContent, /the Partner — /, "never the long option label inside the sentence");
  assert.doesNotMatch(ids.paddockGifs.textContent, /a reason naming someone/, "the block list shows no reasons");
  assert.match(ids.paddockGifs.textContent, /gone-1/);
  ids = adminCard({ cfg: { mode: "everyone", cfstickers: false, gifs: "free" }, gifs: st("same_as_server", "set") });
  await flush();
  assert.match(ids.paddockGifs.textContent, /GIFs are not on: Free mode needs KLIPY_PUBLIC_KEY \(the same as KLIPY_API_KEY — not used/);
  ids = adminCard({ cfg: { mode: "off", cfstickers: false, gifs: "free" }, gifs: st("set", "set") });
  await flush();
  assert.match(ids.paddockGifs.textContent, /GIFs are not on: the Room Dock is off\./);
});

test("review: no raw bidirectional / zero-width control characters in this feature's source (escapes only - the repo is public)", () => {
  const files = ["gifs.js", "linkpreview.js", "public/js/pad-picker.js", "public/js/chatlog-core.js", "public/js/room-bridge.js", "public/js/chat-lines.js", "public/js/admin-paddock.js",
    "test/gifs-free.test.js", "test/gifs-free-line.test.js", "test/gifs-free-ui.test.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    const bad = src.match(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g);
    assert.equal(bad, null, f + ": " + (bad || []).map((c) => "U+" + c.charCodeAt(0).toString(16)).join(","));
    // (a backslash, "u0000-", then a raw space - built from pieces so this file doesn't match itself)
    assert.doesNotMatch(src, new RegExp(String.fromCharCode(92, 92) + "u0000-" + String.fromCharCode(32)), f + ": a raw space closing a NUL range");
  }
});

// ── chatlog-core: the placeholder ──
test("chatlog-core: a GIF removed everywhere or whose picture no longer loads is a plain 'GIF no longer available'; GIF lines carry data-gif", () => {
  const CL = require(path.join(repo, "public", "js", "chatlog-core.js"));
  const doc = new Document(), h = CL.domH(doc);
  const base = { k: "msg", c: 5, ts: Date.now(), u: { login: "alicecf", display: "Alice", web: true }, text: "[gif:wave-hi]", md: "gif" };
  const gone = CL.renderItem({ ...base, gif: { gone: 1 } }, {}, h);
  assert.equal(gone.querySelector("img"), null); assert.equal(gone.querySelector(".gif-gone").textContent, "GIF no longer available");
  assert.equal(gone.getAttribute("data-gif"), "1");
  const line = CL.renderItem({ ...base, gif: { src: "https://static1.klipy.com/ii/aa/bb/x.webp", w: 220, h: 146, title: "Wave" } }, {}, h);
  doc.body.appendChild(line);
  const img = line.querySelector("img.gif"); assert.ok(img); assert.match(line.textContent, /via KLIPY/);
  img.dispatchEvent(new Event("error"));
  assert.equal(line.querySelector("img"), null, "never a broken image"); assert.equal(line.querySelector(".gif-gone").textContent, "GIF no longer available");
  assert.doesNotMatch(line.textContent, /via KLIPY/, "the credit goes with the picture");
  // the server's HTML (downloads) never draws media; a plain line has no data-gif
  assert.doesNotMatch(String(CL.renderItem({ ...base, gif: { gone: 1 } }, { data: false }, CL.htmlH)), /gif-gone|data-gif|<img/);
  assert.equal(CL.renderItem({ k: "msg", c: 6, ts: 1, u: { login: "b", display: "B" }, text: "[gif:wave-hi]" }, {}, h).getAttribute("data-gif"), null, "a typed token: words, no mark");
  const css = fs.readFileSync(path.join(repo, "public", "css", "chatlog.css"), "utf8");
  assert.match(css, /\.chatlog \.gif-gone \{/);
});

// ── chat-lines: 🚫 ──
function linesPage(acts) {
  const doc = new Document(), win = { document: doc, addEventListener() {}, removeEventListener() {}, innerWidth: 1280, navigator: {}, matchMedia: () => ({ matches: false }), getSelection: () => ({ toString: () => "" }) };
  const posts = [];
  const feed = doc.createElement("div"); doc.body.appendChild(feed);
  const CL = require(path.join(repo, "public", "js", "chatlog-core.js")), h = CL.domH(doc);
  feed.appendChild(CL.renderItem({ k: "msg", c: 11, ts: 1, u: { login: "alicecf", display: "Alice", web: true }, text: "[gif:wave-hi]", md: "gif", gif: { src: "https://static1.klipy.com/ii/aa/bb/x.webp", w: 2, h: 2, title: "W" } }, {}, h));
  feed.appendChild(CL.renderItem({ k: "msg", c: 12, ts: 1, u: { login: "bobcf", display: "Bob" }, text: "plain words" }, {}, h));
  const ctx = { window: win, document: doc, MutationObserver: class { observe() {} }, setTimeout: () => 0, clearTimeout() {}, Promise, JSON, console,
    fetch: (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, blocked: true }) }); } };
  win.MutationObserver = ctx.MutationObserver;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "chat-lines.js"), "utf8"), ctx);
  const gone = [];
  const L = win.PATVChatLines.init({ feed, slug: "alpha", onGone: (c) => gone.push(c) });
  L.update({ history: { acts } });
  return { doc, feed, posts, gone };
}
const menuItems = (P, c) => {
  const line = P.feed.querySelectorAll(".line").find((n) => n.getAttribute("data-c") === String(c));
  const b = line && line.querySelector(".la-btn"); if (!b) return [];
  b.click();
  const pop = P.doc.querySelector(".la-pop");
  return pop ? pop.querySelectorAll("[role=menuitem]").map((x) => x.textContent) : [];
};
test("chat-lines: 🚫 Remove this GIF everywhere… only on GIF lines, only for whoever may hide; it posts gifblock and the line leaves", async () => {
  const M = linesPage({ report: 1, hide: 1, purge: 0 });
  assert.ok(menuItems(M, 11).includes("🚫 Remove this GIF everywhere…"));
  M.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.ok(!menuItems(linesPage({ report: 1, hide: 1, purge: 0 }), 12).includes("🚫 Remove this GIF everywhere…"), "not on a plain line");
  assert.ok(!menuItems(linesPage({ report: 1, hide: 0, purge: 0 }), 11).includes("🚫 Remove this GIF everywhere…"), "a member: Report only");
  assert.ok(menuItems(linesPage({ report: 1, hide: 0, purge: 0 }), 11).includes("⚑ Report…"), "⚑ Report on a GIF line");
  const P = linesPage({ report: 1, hide: 1, purge: 0 });
  menuItems(P, 11);
  P.doc.querySelector(".la-pop").querySelectorAll("[role=menuitem]").find((x) => /Remove this GIF/.test(x.textContent)).click();
  const dlg = P.doc.querySelector(".ds-modal"); assert.ok(dlg); assert.match(dlg.textContent, /GIF no longer available/);
  dlg.querySelector("input").value = " not here ";
  dlg.querySelectorAll("button").find((b) => /Remove the GIF/.test(b.textContent)).click(); await flush();
  assert.deepEqual(P.posts.map((x) => [x.url, x.body.why]), [["/api/rooms/alpha/chatlog/11/gifblock", "not here"]]);
  assert.deepEqual(P.gone, [11]);
});

test("every new picker / chat / admin string exists in English", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const m of picker.matchAll(/\bt\('([a-z_]+)',/g)) assert.equal(typeof en["js.pad.picker." + m[1]], "string", m[1]);
  for (const f of ["public/js/chat-lines.js", "public/js/chatlog-core.js", "public/js/admin-paddock.js"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    for (const m of src.matchAll(/_t\('((?:js\.pad\.chat\.gif|js\.pad\.dock\.admin\.(?:gifs|key))[a-z_.]*)',\s*'((?:[^'\\]|\\.)*)'/g)) {
      assert.equal(typeof en[m[1]], "string", f + ": " + m[1]);
    }
  }
});
