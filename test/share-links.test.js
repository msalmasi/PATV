"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), vm = require("vm"), ejs = require("ejs");
const { shareBase, shareUrl, activeBase } = require("../sharelinks");
const read = p => fs.readFileSync(require("path").join(__dirname, "..", p), "utf8");
test("short origin is opt-in, validated and disabled on staging", () => {
  const keys = ["SHORT_LINK_BASE", "STAGING", "SITE_URL", "PUBLIC_BASE_URL"], old = {};
  keys.forEach(k => { old[k] = process.env[k]; delete process.env[k]; });
  try {
    assert.equal(shareBase(), "https://publicaccess.tv");
    process.env.SHORT_LINK_BASE = "https://pa.tv/";
    assert.equal(shareUrl("/p/x?a=1#live"), "https://pa.tv/p/x?a=1#live");
    process.env.STAGING = "1";
    assert.equal(activeBase(), ""); assert.equal(shareBase(), "https://staging.publicaccess.tv");
    delete process.env.STAGING;
    for (const value of ["junk", "http://pa.tv", "https://pa.tv/path", "https://u:p@pa.tv", "https://pa.tv/?q=x", "https://pa.tv/#x", "https://pa.tv/../", "https://pa.tv?", "https://pa.\ntv", "https://pa.tv\\"]) {
      process.env.SHORT_LINK_BASE = value; assert.equal(shareBase(), "https://publicaccess.tv", value);
    }
    process.env.SITE_URL = "https://custom.example/"; assert.equal(shareBase(), "https://custom.example");
  } finally { keys.forEach(k => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }); }
});
function browser(meta, nav = {}) {
  const calls = [], timers = [], listeners = [], win = { prompt: (...args) => calls.push(args) };
  const ctx = { window: win, navigator: nav, location: { origin: "https://publicaccess.tv" },
    document: { querySelector: () => meta ? { getAttribute: () => meta } : null, addEventListener: (...x) => listeners.push(x) },
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeout() {} };
  vm.runInNewContext(read("public/js/share-link.js"), ctx);
  return { api: win.PATVShare, calls, timers, listeners, ctx };
}
function button(label) { return { textContent: label, querySelector: () => null, classList: { add() {}, remove() {} } }; }
test("browser URL chooses meta or origin and installs only one listener", () => {
  for (const meta of [null, "https://pa.tv"]) {
    const b = browser(meta); assert.equal(b.api.url("/p/x?q=1#live"), (meta || "https://publicaccess.tv") + "/p/x?q=1#live");
    vm.runInNewContext(read("public/js/share-link.js"), b.ctx); assert.equal(b.listeners.length, 1);
  }
});
test("clipboard preserves feed and stream labels, restores after two seconds", async () => {
  for (const label of ["Share", "Share stream"]) {
    let copied; const b = browser(null, { clipboard: { writeText: async x => { copied = x; } } }), btn = button(label);
    b.api.share(btn, b.api.url("/p/x")); await Promise.resolve();
    assert.equal(copied, "https://publicaccess.tv/p/x"); assert.equal(btn.textContent, "Link copied");
    assert.equal(b.timers[0].ms, 2000); b.timers[0].fn(); assert.equal(btn.textContent, label);
  }
});
test("mobile native sharing and both prompt fallbacks", async () => {
  let data; const mobile = browser(null, { userAgent: "Android", share: async x => { data = x; } });
  mobile.api.share(button("Share"), "https://pa.tv/p/x", "A stream"); assert.equal(data.title, "A stream"); assert.equal(data.url, "https://pa.tv/p/x");
  for (const nav of [{}, { clipboard: { writeText: async () => { throw Error("denied"); } } }]) {
    const b = browser(null, nav); b.api.share(button("Share"), "https://pa.tv/p/x"); await Promise.resolve();
    assert.deepEqual(b.calls, [["Copy the link:", "https://pa.tv/p/x"]]);
  }
});
test("slot render shows Share stream only after went_live, resets on end and pad changes", async () => {
  const html = await ejs.renderFile(require("path").join(__dirname, "../views/stageBook.ejs"), {
    user: "u", me: { userId: "u1", points_balance: 0 }, rooms: [], pick: "", C: {}, rtmpServer: "", balance: 0, twitchUrl: null, staff: false
  });
  assert.match(html, /class="btn hide" id="slotShare">Share stream/);
  const nodes = {}, get = id => nodes[id] || (nodes[id] = { textContent: "", addEventListener() {}, attrs: {}, classList: { toggle(k,v) { nodes[id].hidden = v; } }, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; } });
  get("slotShare").textContent = "Share stream";
  get("room").options = [{value: "custom-pad", getAttribute: k => k === "data-id" ? "room-id" : "Pad"}];
  const src = read("public/js/stage-book.js");
  const prefix = src.slice(0, src.indexOf("  // featuring is never sold")) + src.slice(src.indexOf("  function render(d)"), src.indexOf("  var capBusy = false;"));
  const ctx = { document: { getElementById: get, querySelectorAll: () => [], querySelector: () => null }, window: { dispatchEvent() {} }, sessionStorage: { getItem() {} }, CustomEvent: function(){}, Date };
  get("sb").getAttribute = () => "1";
  vm.runInNewContext(prefix + "\nwindow.renderSlot = render; var capBusy = false; }());", ctx);
  for (const went_live of [false, true, false]) {
    ctx.window.renderSlot({ slots: [{status:"active", room_id:"room-id", went_live, mode:"embed"}] });
    assert.equal(get("slotShare").hidden, !went_live);
    assert.equal(get("slotShare").attrs["data-share-path"], went_live ? "/p/custom-pad" : undefined);
  }
  ctx.window.renderSlot({slots:[]}); assert.equal(get("slotShare").hidden, true);
});
test("public pad renders live-header share control, and feed uses shared helper", async () => {
  const html = await ejs.renderFile(require("path").join(__dirname, "../views/room.ejs"), {
    user:null, signedIn:false, linked:false, room:{name:"Pad",slug:"custom-pad",count:0,live:false,topic:""}, initial:{room:{},members:[],mic:[],feed:[],cursor:0},onStage:false,stage:{}
  });
  assert.match(html, /id="rmStageH">[\s\S]*?data-share-path="\/p\/custom-pad"/);
  assert.match(read("public/js/feed.js"), /PATVShare.share\(b, window.PATVShare.url\(b.getAttribute\('data-url'\)\)\)/);
});

test("layout emits the share meta only when the switch is active", () => {
  const head = read("views/layout.ejs").split("\n").find(l => l.includes('name="patv-share-base"'));
  assert.equal(ejs.render(head, {shareLinkBase: () => ""}).trim(), "");
  assert.equal(ejs.render(head, {}).trim(), "");
  assert.match(ejs.render(head, {shareLinkBase: () => "https://pa.tv"}), /content="https:\/\/pa.tv"/);
});
