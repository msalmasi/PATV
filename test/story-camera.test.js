// Story camera (1.99??): Story Studio opens on a live camera, like IG / Snapchat (public/js/story-camera.js). The real page
// scripts (story-camera.js + story-studio.js) run in a VM with fakes for getUserMedia, MediaRecorder, the <video> element,
// canvas.toBlob, pointer events, page visibility and a clock the tests move by hand. The fake DOM is copied from
// story-studio-client.test.js. The WebM length fix and the server's packet-length read also run against real ffmpeg output
// when ffmpeg and ffprobe are on PATH.
//   TZ=UTC node --test test/story-camera.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const SRC = (f) => fs.readFileSync(path.join(repo, "public", "js", f), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-camera-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.FEED_DIR = path.join(tmp, "feed"); process.env.MEDIA_DIR = path.join(tmp, "stories"); process.env.FEED_NO_NICE = "1";
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
let HAVE_FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true }); execFileSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true }); } catch (_) { HAVE_FFMPEG = false; }
const videoOptions = { skip: !HAVE_FFMPEG && "no ffmpeg" };

// ── a small fake DOM ──
function parseList(sel) {                       // "a, b c" -> [[compound, compound], ...]
  const out = []; let cur = "", depth = 0, q = null;
  for (const ch of sel) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean).map(splitDesc);
}
function splitDesc(s) {
  const parts = []; let cur = "", depth = 0, q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}
function matchCompound(el, c) {
  if (!el || !el.attrs) return false;
  let rest = c;
  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tag) { if (tag[1] !== "*" && el.localName !== tag[1].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { if (el.getAttribute("id") !== m[1]) return false; }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { if (!el.classList.contains(m[1])) return false; }
    else if ((m = /^\[([\w-]+)(?:([\^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) {
      const v = el.getAttribute(m[1]);
      if (v === null) return false;
      const want = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5];
      if (m[2] === "=" && v !== want) return false;
      if (m[2] === "^=" && !v.startsWith(want)) return false;
    } else if ((m = /^:not\(([^)]*)\)/.exec(rest))) { if (matchCompound(el, m[1])) return false; }
    else throw new Error("unsupported selector part: " + rest);
    rest = rest.slice(m[0].length);
  }
  return true;
}
function matches(el, sel) {
  return parseList(sel).some((parts) => {
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let n = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) { while (n && !matchCompound(n, parts[i])) n = n.parentNode; if (!n) return false; n = n.parentNode; }
    return true;
  });
}
class Ev {
  constructor(type, init) { Object.assign(this, init || {}); this.type = type; this.defaultPrevented = false; this._stop = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
}
class TextNode { constructor(t) { this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }
const BOOL = { disabled: "disabled", hidden: "hidden", noValidate: "novalidate" };
const STR = { id: "id", type: "type", href: "href", src: "src", alt: "alt", title: "title", autocomplete: "autocomplete", rows: "rows", maxLength: "maxlength", tabIndex: "tabindex" };
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.localName = String(tag).toLowerCase(); this.tagName = this.localName.toUpperCase();
    this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = []; this.value = "";
    const self = this;
    const st = {}; st.setProperty = (k, v) => { st[k] = v; }; st.removeProperty = (k) => { delete st[k]; }; this.style = st;
    this.classList = {
      contains: (c) => self.className.split(/\s+/).includes(c),
      add: (...cs) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); self.className = [...s].join(" "); },
      remove: (...cs) => { self.className = self.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(" "); },
      toggle: (c, force) => { const on = force === undefined ? !self.classList.contains(c) : !!force; if (on) self.classList.add(c); else self.classList.remove(c); return on; },
    };
  }
  get className() { return this.attrs.get("class") || ""; }
  set className(v) { this.attrs.set("class", String(v)); }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v != null && v !== "") this.appendChild(new TextNode(v)); }
  set innerHTML(v) {                         // a tiny parser: enough for the viewer's own fixed markup (the sign-in prompt)
    this.textContent = ""; this._html = v;
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(String(v)))) {
      const top = stack[stack.length - 1];
      if (m[4]) { top.appendChild(new TextNode(m[4])); continue; }
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const e = new El(this.ownerDocument, m[2]);
      for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) e.setAttribute(a[1], a[2]);
      top.appendChild(e);
      if (!/\/$/.test(m[3].trim()) && !/^(img|br|input)$/i.test(m[2])) stack.push(e);
    }
  }
  get innerHTML() { return this._html || ""; }
  get scrollHeight() { return 20; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  replaceChild(n, old) { this.insertBefore(n, old); this.removeChild(old); return old; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) { if (this.parentNode) this.parentNode.replaceChild(n, this); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!(opt && opt.capture) }); }
  removeEventListener(type, fn, opt) { const cap = opt === true || !!(opt && opt.capture); this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === cap)); }
  dispatchEvent(ev) { return dispatch(this, ev); }
  click() { return dispatch(this, new Ev("click", { bubbles: true, button: 0 })); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  matches(sel) { return matches(this, sel); }
  closest(sel) { let n = this; while (n && n instanceof El) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
  all() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter((e) => matches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  get offsetParent() {
    if (!this.isConnected) return null;
    for (let n = this; n && n instanceof El; n = n.parentNode) if (n.hasAttribute("hidden") || n.classList.contains("hide")) return null;
    return this.ownerDocument.body;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 500, right: 300, bottom: 500 }; }
}
for (const [p, a] of Object.entries(BOOL)) Object.defineProperty(El.prototype, p, { get() { return this.hasAttribute(a); }, set(v) { if (v) this.setAttribute(a, ""); else this.removeAttribute(a); } });
for (const [p, a] of Object.entries(STR)) Object.defineProperty(El.prototype, p, { get() { return this.getAttribute(a) || ""; }, set(v) { this.setAttribute(a, v); } });
function dispatch(target, ev) {
  ev.target = target;
  const pathUp = []; for (let n = target; n; n = n.parentNode) pathUp.push(n);
  const doc = target.ownerDocument;
  if (target.isConnected) pathUp.push(doc);
  for (const n of pathUp.slice().reverse()) {                       // capture
    if (n === target) break;
    for (const l of (n.listeners || []).filter((x) => x.type === ev.type && x.capture)) { ev.currentTarget = n; l.fn.call(n, ev); if (ev._stop) return !ev.defaultPrevented; }
  }
  for (const n of pathUp) {                                         // target + bubble
    for (const l of (n.listeners || []).filter((x) => x.type === ev.type && (n === target || !x.capture))) { ev.currentTarget = n; l.fn.call(n, ev); }
    if (ev._stop || (n !== target && ev.bubbles === false)) break;
  }
  return !ev.defaultPrevented;
}
function makeDoc(me) {
  const doc = { listeners: [], readyState: "complete", hidden: false };
  doc.createElement = (t) => new El(doc, t);
  doc.createElementNS = (ns, t) => new El(doc, t);
  doc.createTextNode = (t) => new TextNode(t);
  doc.documentElement = new El(doc, "html");
  doc.head = doc.documentElement.appendChild(new El(doc, "head"));
  doc.body = doc.documentElement.appendChild(new El(doc, "body"));
  // like a browser: a focused element that is removed or disabled drops the focus to <body>
  let active = doc.body;
  Object.defineProperty(doc, "activeElement", { configurable: true, get() { return active && active.isConnected && !active.disabled ? active : doc.body; },
                                                set(v) { active = v; } });
  doc.querySelectorAll = (s) => [doc.documentElement].concat(doc.documentElement.all()).filter((e) => matches(e, s));
  doc.querySelector = (s) => doc.querySelectorAll(s)[0] || null;
  doc.getElementById = (id) => doc.querySelector("#" + id);
  doc.addEventListener = (type, fn, opt) => doc.listeners.push({ type, fn, capture: opt === true || !!(opt && opt.capture) });
  doc.removeEventListener = (type, fn, opt) => { const cap = opt === true || !!(opt && opt.capture); doc.listeners = doc.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === cap)); };
  doc.currentScript = null;
  doc._me = me;
  return doc;
}
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── a clock the tests move: the hold threshold, the shortest clip, the limit stop and the page's other timers ──
function makeClock() {
  const C = { t: 1000, q: [], n: 0 };
  C.setTimeout = (fn, ms) => { const id = ++C.n; C.q.push({ id, at: C.t + Math.max(0, Number(ms) || 0), fn }); return id; };
  C.clearTimeout = (id) => { C.q = C.q.filter((x) => x.id !== id); };
  C.tick = async (ms) => {
    const end = C.t + ms;
    for (;;) {
      await flush();
      C.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = C.q[0];
      if (!next || next.at > end) break;
      C.q.shift(); C.t = next.at; next.fn();
    }
    C.t = end; await flush();
  };
  return C;
}

// ── tiny WebM (EBML) builders and readers: a Chrome MediaRecorder file has no SeekHead, an unknown-size Segment and
//    Cluster, and no Duration in its Info ──
function vsize(n) {
  for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) {
    const b = Buffer.alloc(len); let v = n;
    for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
    b[0] |= 0x80 >> (len - 1); return b;
  }
  throw new Error("too big");
}
const E = (id, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([Buffer.from(id, "hex"), vsize(body.length), body]); };
const UNKNOWN = Buffer.from("01ffffffffffffff", "hex");
function chromeWebm({ duration } = {}) {
  const info = [E("2AD7B1", Buffer.from([0x0f, 0x42, 0x40])), E("4D80", "Chrome"), E("5741", "Chrome")];
  if (duration != null) { const d = Buffer.alloc(8); d.writeDoubleBE(duration); info.push(E("4489", d)); }
  return Buffer.concat([E("1A45DFA3", E("4286", Buffer.from([1])), E("4282", "webm")), Buffer.from("18538067", "hex"), UNKNOWN,
    E("1549A966", ...info), E("1654AE6B", E("AE", E("D7", Buffer.from([1])), E("86", "V_VP8"))),
    Buffer.from("1F43B675", "hex"), UNKNOWN, E("E7", Buffer.from([0])), E("A3", Buffer.from([0x81, 0, 0, 0x80, 1, 2, 3, 4, 5, 6]))]);
}
const mp4Bytes = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12), Buffer.from("moov")]);
function readVint(b, at) {
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b[at] & mask)) { len++; mask >>= 1; }
  let v = b[at] & (mask - 1), ones = v === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[at + i]; if (b[at + i] !== 0xff) ones = false; }
  return { len, v, unknown: ones };
}
function readId(b, at) { const f = b[at], len = f & 0x80 ? 1 : f & 0x40 ? 2 : f & 0x20 ? 3 : 4; return { len, hex: b.subarray(at, at + len).toString("hex").toUpperCase() }; }
function children(b, from, to) {
  const out = [];
  for (let p = from; p < to;) {
    const id = readId(b, p), sz = readVint(b, p + id.len), data = p + id.len + sz.len;
    out.push({ hex: id.hex, at: p, data, end: sz.unknown ? to : data + sz.v, size: sz });
    if (sz.unknown || id.hex === "1F43B675") break;
    p = data + sz.v;
  }
  return out;
}
/** The Segment's top-level elements up to the first Cluster, and where the Segment's data starts. */
function segment(b) {
  const head = children(b, 0, b.length)[0], seg = readId(b, head.end), ss = readVint(b, head.end + seg.len), start = head.end + seg.len + ss.len;
  return { start, kids: children(b, start, b.length) };
}
function webmInfo(b) {
  const info = segment(b).kids.find((k) => k.hex === "1549A966"), out = {};
  for (const c of children(b, info.data, info.end)) {
    if (c.hex === "4489") out.duration = c.size.v === 8 ? b.readDoubleBE(c.data) : b.readFloatBE(c.data);
    if (c.hex === "2AD7B1") out.scale = b.readUIntBE(c.data, c.size.v);
  }
  return out;
}
const ffprobeSecs = (file) => Number(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]).toString()).format.duration);
const streamedWebm = (file, secs, size = "320x568") => fs.writeFileSync(file, execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error",
  "-f", "lavfi", "-i", `color=c=green:s=${size}:r=10:d=${secs}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`,
  "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", "-shortest", "-f", "webm", "pipe:1"], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }));

// ── fake media devices ──
function fakeTrack(kind, settings) {
  return { kind, readyState: "live", stopped: false, settings, ls: [],
    stop() { this.stopped = true; this.readyState = "ended"; },
    getSettings() { return Object.assign({}, this.settings); },
    addEventListener(type, fn) { this.ls.push({ type, fn }); }, removeEventListener(type, fn) { this.ls = this.ls.filter((l) => l.fn !== fn); } };
}
function fakeStream(constraints) {
  const v = constraints.video || {}, fm = v.facingMode && (v.facingMode.ideal || v.facingMode.exact || v.facingMode);
  const tracks = [fakeTrack("video", { facingMode: typeof fm === "string" ? fm : undefined, width: 1080, height: 1920, deviceId: fm === "user" ? "cam-front" : "cam-back" })];
  if (constraints.audio) tracks.push(fakeTrack("audio", {}));
  return { constraints, getTracks: () => tracks.slice(), getVideoTracks: () => tracks.filter((t) => t.kind === "video"), getAudioTracks: () => tracks.filter((t) => t.kind === "audio") };
}
const liveTracks = (s) => s.getTracks().filter((t) => !t.stopped).length;
function recorderClass(P, supported) {
  return class FakeRecorder {
    constructor(stream, options) { this.stream = stream; this.options = options || {}; this.mimeType = this.options.mimeType || "video/webm"; this.state = "inactive"; this.stops = 0; P.recorders.push(this); }
    static isTypeSupported(t) { return supported.includes(t); }
    start(slice) { this.state = "recording"; this.slice = slice; this.startedAt = P.clock.t; queueMicrotask(() => { if (this.onstart) this.onstart({ type: "start" }); }); }
    stop() {
      if (this.state === "inactive") throw new Error("InvalidStateError");
      this.state = "inactive"; this.stops++; this.stoppedAt = P.clock.t;
      const body = /mp4/.test(this.mimeType) ? mp4Bytes() : chromeWebm();
      queueMicrotask(() => { if (this.ondataavailable) this.ondataavailable({ data: new Blob([body], { type: this.mimeType }) }); if (this.onstop) this.onstop({ type: "stop" }); });
    }
  };
}

const TARGETS = { ok: true, pads: [
  { id: "u/pixelotter", title: "Your profile", profile: true, label: "u/pixelotter", look: { avatar: "/profile.webp", accent: null, ink: null } },
  { id: "aurora.pad", title: "Aurora Workshop", href: "/p/aurora-workshop", label: "p/aurora-workshop", look: { avatar: "/aurora.webp", accent: "#26c6da", ink: "#000000" } }
], caps: { secs: 30, imageMb: 10, videoMb: 60, srcSecs: 180, srcVideoMb: 100, overlayMb: 2, textsMax: 3, textLen: 120, stickersMax: 10, mentionsMax: 5, studio: true }, as: "Pixel Otter" };

/** A page with the strip's "+ Your story" button, story-camera.js and story-studio.js, and fakes for everything the camera touches. */
function camPage(options = {}) {
  const doc = makeDoc("pixelotter"), clock = makeClock();
  const P = { doc, clock, calls: [], uploaded: [], puts: [], gum: [], streams: [], recorders: [], snaps: [], draws: [], blobs: new Map(), events: [],
    winListeners: [], session: {}, pickClicks: { camera: 0, gallery: 0 } };
  doc.visibilityState = "visible"; doc.hidden = false;
  doc.dispatchEvent = (ev) => { for (const l of doc.listeners.filter((x) => x.type === ev.type)) l.fn(ev); P.events.push(ev); return !ev.defaultPrevented; };
  doc.fonts = { load: async () => {} };
  const normalCreate = doc.createElement;
  let urlN = 0, uploadN = 0;
  doc.createElement = (tag) => {
    const node = normalCreate(tag);
    node.setPointerCapture = (id) => { node.captured = id; }; node.releasePointerCapture = () => { node.captured = null; };
    if (tag === "canvas") {
      const ctx = { font: "700 72px Ubuntu", fillStyle: "", save() {}, restore() {}, clearRect() {}, fillRect() {}, fillText() {}, strokeText() {},
        measureText(t) { return { width: Array.from(t).length * 30 }; }, drawImage(...a) { P.draws.push({ canvas: node, args: a }); } };
      node.getContext = () => ctx;
      node.toBlob = (cb, type, quality) => {
        P.snaps.push({ canvas: node, type, quality, w: node.width, h: node.height });
        const body = type === "image/jpeg" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) : Buffer.from("overlay");
        queueMicrotask(() => cb(options.toBlobFails && type === "image/jpeg" ? null : new Blob([body], { type })));
      };
    }
    if (tag === "img" || tag === "video") {
      let object = null;
      Object.defineProperty(node, "srcObject", { configurable: true, get: () => object, set: (v) => {
        object = v || null; node.videoWidth = 0; node.videoHeight = 0; node.readyState = 0; if (!v) return;
        queueMicrotask(() => { if (object !== v) return; const [w, h] = options.frame || [1080, 1920]; node.videoWidth = w; node.videoHeight = h; node.readyState = 4;
          node.dispatchEvent(new Ev("loadedmetadata")); node.dispatchEvent(new Ev("playing")); });
      } });
      Object.defineProperty(node, "src", { configurable: true, get: () => node.getAttribute("src"), set: (v) => {
        node.setAttribute("src", v); if (!String(v).startsWith("blob:")) return;
        const file = P.blobs.get(v);
        queueMicrotask(() => {
          node.naturalWidth = 1080; node.naturalHeight = 1920; node.videoWidth = 1080; node.videoHeight = 1920; node.currentTime = 0; node.paused = true;
          // a fresh browser recording reports no length (Chrome WebM before the header fix, some MP4s): the studio uses the measured one
          node.duration = file && /^story-video-/.test(file.name || "") ? (options.recordedDuration != null ? options.recordedDuration : Infinity) : (options.duration || 12);
          if (node.onload) node.onload(); node.dispatchEvent(new Ev(tag === "video" ? "loadedmetadata" : "load"));
        });
      } });
      node.play = () => { node.paused = false; node.plays = (node.plays || 0) + 1; return Promise.resolve(); };
      node.pause = () => { node.paused = true; };
    }
    if (tag === "input") node.addEventListener("click", () => { const k = node.getAttribute("data-pick"); if (k) P.pickClicks[k]++; });
    return node;
  };
  const supported = options.types || ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8", "video/webm"];
  const devices = options.cams === 1 ? [{ kind: "videoinput", deviceId: "cam-back" }] : [{ kind: "videoinput", deviceId: "cam-front" }, { kind: "videoinput", deviceId: "cam-back" }];
  const navigator = { userAgent: options.ua || "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    vendor: options.vendor || "Google Inc.", permissions: { query: async (d) => ({ state: (options.permissions || {})[d.name] || "prompt" }) } };
  if (!options.noMedia) navigator.mediaDevices = {
    getUserMedia: (c) => {
      P.gum.push(JSON.parse(JSON.stringify(c)));
      const refusal = options.gum && options.gum(c, P.gum.length);
      if (refusal) return Promise.reject(refusal);
      const s = fakeStream(c); P.streams.push(s); return Promise.resolve(s);
    },
    enumerateDevices: async () => devices.concat([{ kind: "audioinput", deviceId: "mic" }]),
  };
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => body });
  const win = { document: doc, navigator, console, Promise, JSON, Math, Date, Object, Array, String, Number, Error, encodeURIComponent, isFinite, parseInt, Intl,
    Blob, File, Uint8Array, DataView, ArrayBuffer, Response,
    isSecureContext: !options.insecure, MediaRecorder: options.noRecorder ? undefined : recorderClass(P, supported),
    performance: { now: () => clock.t }, getComputedStyle: () => ({ direction: "ltr" }), innerHeight: 812,
    URL: { createObjectURL: (blob) => { const u = "blob:local-" + ++urlN; P.blobs.set(u, blob); return u; }, revokeObjectURL: (u) => { P.blobs.delete(u); } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: (f) => setImmediate(f), cancelAnimationFrame: (id) => clearImmediate(id),
    addEventListener: (type, fn) => P.winListeners.push({ type, fn }),
    removeEventListener: (type, fn) => { P.winListeners = P.winListeners.filter((l) => !(l.type === type && l.fn === fn)); },
    confirm: () => true,
    sessionStorage: { getItem: (k) => (k in P.session ? P.session[k] : null), setItem: (k, v) => { P.session[k] = String(v); }, removeItem: (k) => { delete P.session[k]; } },
    location: { reload() { throw new Error("must never reload"); }, pathname: "/feed", href: "/feed" },
    CustomEvent: class extends Ev { constructor(type, o) { super(type, o); } },
    Image: function () { return doc.createElement("img"); },
    fetch: async (url, opt = {}) => {
      const method = opt.method || "GET", body = typeof opt.body === "string" ? JSON.parse(opt.body) : opt.body;
      P.calls.push({ url, method, body });
      if (url.startsWith("/api/stories/targets")) return response(200, JSON.parse(JSON.stringify(options.targets || TARGETS)));
      if (url === "/api/feed/uploads") { const id = (++uploadN).toString(16).padStart(24, "0"); P.uploaded.push({ id, body }); return response(200, { ok: true, id, chunk: 4 }); }
      if (method === "PUT") { P.puts.push(opt.body); return response(200, { ok: true, received: Number(url.split("offset=")[1]) + opt.body.size }); }
      if (/\/finish$|\/discard$/.test(url)) return response(200, { ok: true });
      if (/^\/api\/feed\/uploads\//.test(url)) return response(200, { ok: true, state: "ready" });
      if (url === "/api/stories/mine") return response(200, { ok: true, story: { id: "new-story", scope: "aurora.pad", href: "/media/new-story", circle: { id: "aurora.pad", title: "Aurora Workshop" }, item: { id: "new-story", kind: "photo", src: "/new.webp" } } });
      return response(404, { ok: false, error: "missing test route" });
    },
  };
  win.window = win; P.win = win; P.context = vm.createContext(win);
  vm.runInContext(SRC("story-camera.js"), P.context);
  vm.runInContext(SRC("story-studio.js"), P.context);
  P.opener = doc.body.appendChild(doc.createElement("button")); P.opener.setAttribute("data-story-compose", ""); P.opener.setAttribute("data-pad", "aurora.pad"); P.opener.focus();
  return P;
}
const fire = (node, type, extra) => { const e = new Ev(type, Object.assign({ bubbles: true, pointerId: 1, button: 0, isPrimary: true }, extra || {})); node.dispatchEvent(e); return e; };
const cam = (P) => P.doc.querySelector(".scam");
const shutter = (P) => P.doc.querySelector(".scam-shutter");
const jpegs = (P) => P.snaps.filter((x) => x.type === "image/jpeg").length;
const pageEvent = (P, type) => { for (const l of P.winListeners.filter((x) => x.type === type)) l.fn({ type }); };
const visibility = (P, state) => { P.doc.visibilityState = state; P.doc.hidden = state === "hidden"; P.doc.dispatchEvent(new Ev("visibilitychange")); };
async function openStudio(P) { P.opener.click(); await flush(10); const root = P.doc.querySelector(".sst"); assert.ok(root, "the studio opened"); return root; }
/** A real tap: down, a short wait, up, then the click the browser sends after it. */
async function tap(P, ms = 120) { const s = shutter(P); fire(s, "pointerdown"); await P.clock.tick(ms); fire(s, "pointerup"); fire(s, "click", { detail: 1 }); await flush(12); }
async function sent(P) { return Buffer.concat(await Promise.all(P.puts.map(async (b) => Buffer.from(await b.arrayBuffer())))); }
function pickFile(P, type, name) { const f = new Blob([new Uint8Array(16)], { type }); f.name = name; const g = P.doc.querySelector('[data-pick="gallery"]'); g.files = [f]; g.dispatchEvent(new Ev("change")); return f; }
/** story-camera.js alone, in a bare VM (no DOM): the WebM header fix. */
function webmFix() {
  const win = { Blob, Promise, Uint8Array, DataView, ArrayBuffer, Math, Number, Object, Array, String, Error, isFinite, Response, console };
  win.window = win; const context = vm.createContext(win); vm.runInContext(SRC("story-camera.js"), context);
  return async (buf, secs) => Buffer.from(await (await win.patvStoryCamera._webmDuration(new Blob([buf], { type: "video/webm" }), secs)).arrayBuffer());
}

// ── the camera view ──
test("Story camera: opening Story Studio goes straight to the live back camera; the editor waits behind it", async () => {
  const P = camPage(), root = await openStudio(P), view = cam(P);
  assert.ok(view, "the camera view"); assert.equal(view.parentNode, root); assert.ok(root.classList.contains("scam-open"));
  assert.equal(P.gum.length, 1); assert.deepEqual(P.gum[0].video.facingMode, { ideal: "environment" }); assert.ok(P.gum[0].audio, "camera and mic in one prompt");
  const video = view.querySelector(".scam-video"); assert.equal(video.srcObject, P.streams[0]);
  assert.ok(video.muted); assert.ok(video.hasAttribute("playsinline")); assert.ok(video.hasAttribute("autoplay")); assert.ok(video.plays >= 1);
  assert.ok(view.classList.contains("scam-ready")); assert.equal(view.getAttribute("data-facing"), "environment");
  assert.equal(P.doc.activeElement, shutter(P)); assert.match(shutter(P).getAttribute("aria-label"), /photo/i); assert.match(shutter(P).getAttribute("aria-label"), /hold/i);
  assert.match(view.querySelector(".scam-hint").textContent, /hold/i);
  assert.ok(!view.querySelector(".scam-flip").hidden, "two cameras: flip is offered");
  for (const b of view.querySelectorAll("button")) assert.ok(b.getAttribute("aria-label"), "every camera control has a name");
  assert.ok(P.calls.some((c) => c.url.startsWith("/api/stories/targets")), "the studio still loads where it can post");
  assert.equal(root.querySelector(".sst-status").textContent, "");
});

test("Story camera: a tap takes one JPEG at the stream's own size through the chosen-file path, and every track stops", async () => {
  const P = camPage(), root = await openStudio(P), s = shutter(P), video = cam(P).querySelector(".scam-video");
  fire(s, "pointerdown"); assert.equal(s.captured, 1, "the press keeps its pointer");
  await P.clock.tick(120); fire(s, "pointerup");
  const extra = fire(s, "click", { detail: 1 }); assert.ok(extra.defaultPrevented); await flush(12);
  assert.equal(jpegs(P), 1, "one photo - the click after the tap is not a second one");
  const snap = P.snaps.find((x) => x.type === "image/jpeg"); assert.equal(snap.w, 1080); assert.equal(snap.h, 1920); assert.ok(snap.quality >= 0.85 && snap.quality <= 0.95);
  const drawn = P.draws.find((d) => d.canvas === snap.canvas); assert.equal(drawn.args[0], video); assert.deepEqual(drawn.args.slice(1), [0, 0, 1080, 1920]);
  assert.equal(P.recorders.length, 0); assert.equal(liveTracks(P.streams[0]), 0, "released after the capture");
  assert.equal(cam(P), null); assert.ok(!root.classList.contains("scam-open"));
  assert.ok(root.querySelector("img.sst-source"), "the editor shows the photo"); assert.ok(root.classList.contains("sst-has-media"));
  assert.match(root.querySelector(".sst-filename").textContent, /^story-photo-\d{8}-\d{6}\.jpg$/);
  assert.ok(!root.querySelector('[data-picker="retake"]').hidden, "Retake is offered after a capture");
  root.querySelector(".sst-post").click(); await flush(24);
  assert.equal(P.uploaded.length, 1); const up = P.uploaded[0].body;
  assert.equal(up.kind, "image"); assert.equal(up.purpose, "story"); assert.match(up.name, /^story-photo-.*\.jpg$/); assert.ok(up.edit, "an edited Studio upload");
  const bytes = await sent(P); assert.equal(bytes.length, up.size); assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], "the bytes are the JPEG");
  assert.equal(P.doc.querySelector(".sst"), null, "posted");
});

test("Story camera: Retake and 📷 Camera come back to the camera; ✕ there keeps the draft; a chosen file is not a capture", async () => {
  const P = camPage(), root = await openStudio(P); await tap(P);
  const retake = root.querySelector('[data-picker="retake"]'); retake.click(); await flush(10);
  assert.ok(cam(P)); assert.equal(P.gum.length, 2); assert.ok(cam(P).classList.contains("scam-ready")); assert.ok(root.classList.contains("scam-open"));
  cam(P).querySelector(".scam-close").click(); await flush();
  assert.equal(cam(P), null); assert.ok(P.doc.querySelector(".sst"), "the studio stays, with the draft"); assert.ok(root.querySelector(".sst-source"));
  assert.equal(liveTracks(P.streams[1]), 0); assert.equal(P.doc.activeElement, retake);
  root.querySelector('[data-picker="camera"]').click(); await flush(10);
  assert.ok(cam(P), "📷 Camera opens the live camera"); assert.equal(P.pickClicks.camera, 0, "not the phone's capture input"); assert.equal(P.gum.length, 3);
  await tap(P); assert.equal(jpegs(P), 2); assert.equal(root.querySelectorAll(".sst-source").length, 1, "the new capture replaced the old one");
  pickFile(P, "image/jpeg", "garden.jpg"); await flush(10);
  assert.ok(root.querySelector('[data-picker="retake"]').hidden); assert.equal(root.querySelector(".sst-filename").textContent, "garden.jpg");
});

test("Story camera: press and hold records WebM with sound while held, stops on release, and the clip reaches the editor with its length", async () => {
  const P = camPage(), root = await openStudio(P), s = shutter(P);
  const menu = fire(s, "contextmenu"); assert.ok(menu.defaultPrevented, "no long-press menu on the shutter");
  fire(s, "pointerdown"); await P.clock.tick(200); assert.equal(P.recorders.length, 0, "not a hold yet");
  await P.clock.tick(100); assert.equal(P.recorders.length, 1, "a hold past 250 ms records");
  const r = P.recorders[0];
  assert.equal(r.state, "recording"); assert.equal(r.options.mimeType, "video/webm;codecs=vp8,opus"); assert.equal(r.stream, P.streams[0]); assert.equal(r.stream.getAudioTracks().length, 1);
  assert.ok(cam(P).classList.contains("scam-recording")); assert.match(s.getAttribute("aria-label"), /record/i);
  assert.ok(cam(P).querySelector(".scam-flip").disabled); assert.ok(cam(P).querySelector(".scam-gallery").disabled);
  await P.clock.tick(4000); assert.match(cam(P).querySelector(".scam-time").textContent, /0:04 \/ 0:30/);
  fire(s, "pointerup"); assert.equal(r.stops, 1, "let go = stop"); fire(s, "click", { detail: 1 }); await flush(16);
  assert.equal(jpegs(P), 0, "a hold is not also a photo");
  assert.equal(cam(P), null); assert.equal(liveTracks(P.streams[0]), 0);
  assert.ok(root.classList.contains("sst-video")); assert.match(root.querySelector(".sst-filename").textContent, /^story-video-\d{8}-\d{6}\.webm$/);
  assert.ok(!root.querySelector(".sst-post").disabled, "valid although the element reports no length (the measured one is used)");
  root.querySelector(".sst-post").click(); await flush(24);
  const up = P.uploaded[0].body; assert.equal(up.kind, "video"); assert.deepEqual(up.edit.trim, { start: 0, end: 4.05 });
  const bytes = await sent(P); assert.equal(bytes.length, up.size);
  const info = webmInfo(bytes); assert.equal(info.scale, 1e6); assert.ok(Math.abs(info.duration - 4050) < 1e-6, "the WebM header says how long it is: " + info.duration);
});

test("Story camera: an iPhone records MP4, and a hold stops itself just inside the story limit the server sends", async () => {
  const targets = JSON.parse(JSON.stringify(TARGETS)); targets.caps.secs = 15;
  const P = camPage({ targets, vendor: "Apple Computer, Inc.", types: ["video/mp4"],
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1" });
  const root = await openStudio(P), s = shutter(P);
  fire(s, "pointerdown"); await P.clock.tick(300); const r = P.recorders[0]; assert.equal(r.options.mimeType, "video/mp4");
  await P.clock.tick(14500); assert.equal(r.stops, 0);
  await P.clock.tick(300); assert.equal(r.stops, 1, "stopped by itself");
  assert.ok(r.stoppedAt - r.startedAt < 15000 && r.stoppedAt - r.startedAt >= 14500, String(r.stoppedAt - r.startedAt));
  await flush(16); assert.equal(cam(P), null); assert.match(root.querySelector(".sst-filename").textContent, /^story-video-.*\.mp4$/);
  fire(s, "pointerup"); await flush(); assert.equal(P.recorders.length, 1, "letting go later does nothing");
  assert.equal(root.getAttribute("data-sheet"), null, "inside the limit: no trim needed");
  root.querySelector(".sst-post").click(); await flush(24);
  const up = P.uploaded[0].body; assert.equal(up.kind, "video"); assert.ok(up.edit.trim.end <= 15 && up.edit.trim.end > 14.5);
  assert.equal((await sent(P)).subarray(4, 8).toString(), "ftyp", "the MP4 goes as recorded");
});

test("Story camera: a quick press-and-hold still makes a clip of at least 1.2 s; a photo-only browser takes a photo on a hold", async () => {
  const P = camPage(), root = await openStudio(P), s = shutter(P);
  fire(s, "pointerdown"); await P.clock.tick(300); fire(s, "pointerup");
  assert.equal(P.recorders[0].stops, 0, "keeps going to the shortest clip");
  await P.clock.tick(1200); assert.equal(P.recorders[0].stops, 1); await flush(16);
  root.querySelector(".sst-post").click(); await flush(24); assert.deepEqual(P.uploaded[0].body.edit.trim, { start: 0, end: 1.2 });
  const Q = camPage({ noRecorder: true }), root2 = await openStudio(Q);
  assert.match(cam(Q).querySelector(".scam-hint").textContent, /photo/i); assert.doesNotMatch(cam(Q).querySelector(".scam-hint").textContent, /hold/i);
  const t = shutter(Q); fire(t, "pointerdown"); await Q.clock.tick(900); fire(t, "pointerup"); await flush(12);
  assert.equal(jpegs(Q), 1); assert.ok(root2.querySelector("img.sst-source"));
});

test("Story camera: Enter and Space take a photo, and so does a click from assistive tech", async () => {
  const P = camPage(), root = await openStudio(P);
  const enter = fire(shutter(P), "keydown", { key: "Enter" }); assert.ok(enter.defaultPrevented); await flush(12);
  assert.equal(jpegs(P), 1); assert.ok(root.querySelector(".sst-source"));
  root.querySelector('[data-picker="retake"]').click(); await flush(10);
  fire(shutter(P), "keydown", { key: " ", repeat: true }); await flush(12); assert.equal(jpegs(P), 0 + 1, "a held-down key repeats nothing");
  fire(shutter(P), "keydown", { key: " " }); await flush(12); assert.equal(jpegs(P), 2);
  root.querySelector('[data-picker="retake"]').click(); await flush(10);
  fire(shutter(P), "click", { detail: 0 }); await flush(12); assert.equal(jpegs(P), 3);
});

test("Story camera: every track stops when the studio closes (✕ or Escape), on a hidden page and on pagehide; it starts again on return", async () => {
  const P = camPage(); await openStudio(P);
  cam(P).querySelector(".scam-close").click(); await flush();
  assert.equal(P.doc.querySelector(".sst"), null, "✕ with no draft closes the studio"); assert.equal(liveTracks(P.streams[0]), 0);
  assert.equal(P.doc.listeners.filter((l) => l.type === "visibilitychange").length, 0, "the camera's page listeners are gone");
  assert.equal(P.winListeners.filter((l) => /^page(?:hide|show)$/.test(l.type)).length, 0);
  await openStudio(P); assert.equal(P.gum.length, 2); fire(P.doc.activeElement, "keydown", { key: "Escape" }); await flush();
  assert.equal(P.doc.querySelector(".sst"), null, "Escape on the camera closes it (and the studio, with no draft)"); assert.equal(liveTracks(P.streams[1]), 0);
  await openStudio(P); const view = cam(P);
  visibility(P, "hidden"); await flush();
  assert.equal(liveTracks(P.streams[2]), 0, "hidden page: camera off"); assert.equal(cam(P), view, "the view stays"); assert.ok(!view.classList.contains("scam-ready"));
  visibility(P, "visible"); await flush(10);
  assert.equal(P.gum.length, 4); assert.equal(liveTracks(P.streams[3]), 2); assert.ok(view.classList.contains("scam-ready"));
  pageEvent(P, "pagehide"); await flush(); assert.equal(liveTracks(P.streams[3]), 0);
  pageEvent(P, "pageshow"); await flush(10); assert.equal(P.gum.length, 5); assert.ok(view.classList.contains("scam-ready"));
  // hidden in the middle of a recording: what was filmed is kept
  const s = shutter(P); fire(s, "pointerdown"); await P.clock.tick(2500); assert.equal(P.recorders.length, 1);
  visibility(P, "hidden"); await flush(16);
  assert.equal(P.recorders[0].stops, 1); assert.equal(liveTracks(P.streams[4]), 0); assert.equal(cam(P), null);
  assert.ok(P.doc.querySelector(".sst-video"), "the clip is in the editor");
});

test("Story camera: flip releases the camera before opening the other one; only the front preview is mirrored", async () => {
  const P = camPage(), root = await openStudio(P), view = cam(P), flip = view.querySelector(".scam-flip");
  flip.click(); await flush(10);
  assert.equal(liveTracks(P.streams[0]), 0, "the back camera is released first"); assert.deepEqual(P.gum[1].video.facingMode, { ideal: "user" });
  assert.equal(view.getAttribute("data-facing"), "user"); assert.ok(view.classList.contains("scam-ready")); assert.ok(P.gum[1].audio);
  await tap(P);
  const snap = P.snaps.find((x) => x.type === "image/jpeg"), drawn = P.draws.find((d) => d.canvas === snap.canvas);
  assert.deepEqual(drawn.args.slice(1), [0, 0, 1080, 1920], "the saved selfie reads the right way round (not mirrored)");
  root.querySelector('[data-picker="retake"]').click(); await flush(10);
  assert.deepEqual(P.gum[2].video.facingMode, { ideal: "environment" }, "every open starts on the back camera");
  cam(P).querySelector(".scam-flip").click(); await flush(10); cam(P).querySelector(".scam-flip").click(); await flush(10);
  assert.deepEqual(P.gum[4].video.facingMode, { ideal: "environment" }); assert.equal(cam(P).getAttribute("data-facing"), "environment");
  const one = camPage({ cams: 1 }); await openStudio(one); assert.ok(cam(one).querySelector(".scam-flip").hidden, "one camera: no flip");
});

test("Story camera: a refused camera leaves the picker with the reason, and the refusal is remembered for the session", async () => {
  const P = camPage({ gum: () => ({ name: "NotAllowedError", message: "Permission denied" }), permissions: { camera: "denied" } }), root = await openStudio(P);
  assert.equal(cam(P), null); assert.ok(!root.classList.contains("scam-open")); assert.equal(P.gum.length, 1, "no second prompt");
  const status = root.querySelector(".sst-status"); assert.match(status.textContent, /camera/i); assert.ok(!status.classList.contains("sst-error"));
  assert.ok(!root.querySelector('[data-picker="camera"]').hidden && !root.querySelector('[data-picker="gallery"]').hidden);
  assert.equal(P.session["patv.storycam"], "denied");
  fire(P.doc.activeElement, "keydown", { key: "Escape" }); await flush(); assert.equal(P.doc.querySelector(".sst"), null);
  const again = await openStudio(P);
  assert.equal(P.gum.length, 1, "remembered: no prompt on the next open"); assert.match(again.querySelector(".sst-status").textContent, /camera/i);
  again.querySelector('[data-picker="camera"]').click(); await flush();
  assert.equal(P.pickClicks.camera, 1, "📷 Camera opens the phone's own camera (the capture input)"); assert.equal(P.gum.length, 1);
});

test("Story camera: no getUserMedia, an insecure page, no camera or a busy one all fall back to the picker; only a refusal is remembered", async () => {
  for (const options of [{ noMedia: true }, { insecure: true }]) {
    const P = camPage(options), root = await openStudio(P);
    assert.equal(cam(P), null); assert.equal(P.gum.length, 0); assert.match(root.querySelector(".sst-status").textContent, /live camera/i);
    root.querySelector('[data-picker="camera"]').click(); assert.equal(P.pickClicks.camera, 1);
  }
  const N = camPage({ gum: () => ({ name: "NotFoundError" }) }), root = await openStudio(N);
  assert.equal(cam(N), null); assert.equal(N.gum.length, 2, "with the mic, then the camera alone"); assert.equal(N.gum[1].audio, false);
  assert.match(root.querySelector(".sst-status").textContent, /no camera/i); assert.equal(N.session["patv.storycam"], undefined);
  fire(N.doc.activeElement, "keydown", { key: "Escape" }); await flush(); await openStudio(N); assert.equal(N.gum.length, 4, "not remembered: tried again");
  const B = camPage({ gum: () => ({ name: "NotReadableError" }) }), busy = await openStudio(B);
  assert.equal(cam(B), null); assert.match(busy.querySelector(".sst-status").textContent, /another app/i);
  const F = camPage({ targets: { ok: true, refusal: "Sign in first.", pads: [] } }), refused = await openStudio(F);
  assert.equal(cam(F), null, "nowhere to post: the camera closes"); assert.equal(liveTracks(F.streams[0]), 0);
  assert.match(refused.querySelector(".sst-status").textContent, /Sign in first/);
});

test("Story camera: a refused microphone records silent video and says so, without asking again", async () => {
  const P = camPage({ gum: (c) => (c.audio ? { name: "NotAllowedError" } : null), permissions: { camera: "granted" } }), root = await openStudio(P);
  assert.equal(P.gum.length, 2); assert.equal(P.gum[1].audio, false); assert.ok(cam(P).classList.contains("scam-ready"));
  assert.match(cam(P).querySelector(".scam-hint").textContent, /no sound/i);
  const s = shutter(P); fire(s, "pointerdown"); await P.clock.tick(2000); fire(s, "pointerup"); await flush(16);
  const r = P.recorders[0]; assert.equal(r.stream.getAudioTracks().length, 0); assert.equal(r.options.mimeType, "video/webm;codecs=vp8");
  assert.ok(root.classList.contains("sst-video"));
  fire(P.doc.activeElement, "keydown", { key: "Escape" }); await flush(); await openStudio(P);
  assert.equal(P.gum[2].audio, false, "the mic refusal is remembered for the session too");
});

test("Story camera: 🖼️ opens the studio's file picker and keeps the camera until a file is chosen", async () => {
  const P = camPage(), root = await openStudio(P);
  cam(P).querySelector(".scam-gallery").click(); assert.equal(P.pickClicks.gallery, 1); assert.ok(cam(P), "cancelling the picker leaves the camera");
  pickFile(P, "video/mp4", "pond.mp4"); await flush(10);
  assert.equal(cam(P), null); assert.equal(liveTracks(P.streams[0]), 0); assert.ok(root.querySelector("video.sst-source"));
  assert.ok(root.querySelector('[data-picker="retake"]').hidden);
});

test("Story camera: a photo that can't be encoded says so and the camera starts again", async () => {
  const P = camPage({ toBlobFails: true }); await openStudio(P); await tap(P); await flush(10);
  assert.ok(cam(P), "still on the camera"); assert.match(cam(P).querySelector(".scam-note").textContent, /didn't work/i);
  assert.equal(P.gum.length, 2); assert.ok(cam(P).classList.contains("scam-ready"));
});

// ── the WebM length fix (Chrome / Android / Firefox recordings) ──
test("Story camera: a Chrome-style WebM gets its length written into its header; anything else is left as it is", async () => {
  const fix = webmFix(), src = chromeWebm(), out = await fix(src, 4.05);
  const info = webmInfo(out); assert.equal(info.scale, 1e6); assert.ok(Math.abs(info.duration - 4050) < 1e-6);
  const clusters = (b) => b.subarray(b.indexOf(Buffer.from("1F43B675", "hex")));
  assert.deepEqual(clusters(out), clusters(src), "the media itself is byte for byte the same");
  const zero = chromeWebm({ duration: 0 }), filled = await fix(zero, 2.5); assert.equal(filled.length, zero.length); assert.equal(webmInfo(filled).duration, 2500);
  const kept = chromeWebm({ duration: 1234 }); assert.equal(webmInfo(await fix(kept, 9)).duration, 1234);
  for (const other of [mp4Bytes(), Buffer.from("not a video at all, honestly"), src.subarray(0, 40)]) assert.deepEqual(await fix(other, 3), other);
});

test("Story camera: a real streamed WebM (no length, a SeekHead) reads its length after the fix and still plays to the end", videoOptions, async () => {
  const file = path.join(tmp, "streamed.webm"); streamedWebm(file, 2);
  assert.ok(!(ffprobeSecs(file) > 0), "like a MediaRecorder file: ffprobe finds no length");
  const out = await webmFix()(fs.readFileSync(file), 2), fixed = path.join(tmp, "fixed.webm"); fs.writeFileSync(fixed, out);
  assert.ok(Math.abs(ffprobeSecs(fixed) - 2) < 0.01, String(ffprobeSecs(fixed)));
  const { start, kids } = segment(out), seek = kids.find((k) => k.hex === "114D9B74");
  assert.ok(seek, "this file has a SeekHead");
  for (const entry of children(out, seek.data, seek.end).filter((c) => c.hex === "4DBB")) {
    const parts = children(out, entry.data, entry.end), id = parts.find((p) => p.hex === "53AB"), pos = parts.find((p) => p.hex === "53AC");
    const want = out.subarray(id.data, id.end), at = start + out.readUIntBE(pos.data, pos.size.v);
    assert.deepEqual(out.subarray(at, at + want.length), want, "every SeekHead entry still points at its element");
  }
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-xerror", "-i", fixed, "-f", "null", "-"], { windowsHide: true });
});

// ── the server ──
test("Story camera: the server measures a recording with no length in its header from its packets, and composes it", videoOptions, async () => {
  const media = require(path.join(repo, "feedmedia")), compose = require(path.join(repo, "storycompose"));
  media.dir();
  const file = path.join(tmp, "recorded.webm"); streamedWebm(file, 3, "360x640");
  const sn = media.sniff(fs.readFileSync(file).subarray(0, 4096)); assert.equal(sn.fmt, "webm");
  assert.ok(!((await media.probe(file, sn.ffmt)).secs > 0), "no length in the header");
  const secs = await compose.packetSecs(file, sn.ffmt); assert.ok(Math.abs(secs - 3) < 0.2, String(secs));
  const out = await compose.process(file, sn, { owner_id: "u_camera", kind: "video", edit: JSON.stringify({ v: 1, pad: "profile", fit: "fit", text: [], stickers: [], trim: { start: 0, end: 3 } }) }, { max_video_secs: 180 });
  assert.equal(out.w, 720); assert.equal(out.h, 1280); assert.ok(Math.abs(out.secs - 3) < 0.3, String(out.secs));
  media.removeFiles([out.file, out.thumb, out.poster]);
  // an edit past the measured end is still refused
  await assert.rejects(compose.process(file, sn, { owner_id: "u_camera", kind: "video", edit: JSON.stringify({ v: 1, pad: "profile", fit: "fit", text: [], stickers: [], trim: { start: 0, end: 9 } }) }, { max_video_secs: 180 }), /past the end/);
});

test("Story camera: packetSecs asks ffprobe only what 4.2 understands (one video stream's packet times, demuxer forced, local file only)", async () => {
  const media = require(path.join(repo, "feedmedia")), compose = require(path.join(repo, "storycompose")), calls = [], oldRun = media.run;
  media.run = async (cmd, args) => { calls.push(args); return { out: "0.000000,0.033000\n1.000000,N/A\n2.966000,0.034000\nN/A,N/A\n" }; };
  try { assert.equal(await compose.packetSecs("x.webm", "matroska"), 3); } finally { media.run = oldRun; }
  const args = calls[0];
  assert.equal(args[args.indexOf("-f") + 1], "matroska"); assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
  assert.equal(args[args.indexOf("-select_streams") + 1], "v:0"); assert.equal(args[args.indexOf("-show_entries") + 1], "packet=pts_time,duration_time");
  assert.ok(!args.some((a) => /side_data/.test(a)));
});

// ── loading, the switch, headers ──
test("Story camera: the strip loads the camera with the studio while story_camera is on (on by default, switched in /feed/admin)", async () => {
  const ejs = require("ejs"), stripFile = path.join(repo, "views/partials/story-strip.ejs"), source = fs.readFileSync(stripFile, "utf8");
  const locals = { story: { signed: true, compose: true, rooms: [], caps: [], room: "studio-test-pad" }, user: "maplecanvas" };
  const render = (extra) => ejs.render(source, Object.assign({}, locals, extra), { filename: stripFile });
  const on = render({ storyStudioOn: () => true, storyCameraOn: () => true });
  assert.match(on, /story-camera\.js\?v=1/); assert.match(on, /story-camera\.css\?v=1/); assert.match(on, /story-studio\.js\?v=4/);
  assert.ok(on.indexOf("story-camera.js") < on.indexOf("story-studio.js"));
  for (const extra of [{ storyStudioOn: () => true, storyCameraOn: () => false }, { storyStudioOn: () => true }, { storyStudioOn: () => false, storyCameraOn: () => true }, {}])
    assert.doesNotMatch(render(extra), /story-camera\./);
  const store = require(path.join(repo, "feedstore")), US = require(path.join(repo, "userstories"));
  assert.equal(store.DEFAULTS.story_camera, true);
  await store.init();
  await store.setConfig({ story_studio: true }, "test"); assert.equal(US.cameraOn(), true);
  await store.setConfig({ story_camera: false }, "test"); assert.equal(US.cameraOn(), false);
  await store.setConfig({ story_camera: true, story_studio: false }, "test"); assert.equal(US.cameraOn(), false, "never without the studio");
  assert.match(fs.readFileSync(path.join(repo, "views/feedAdmin.ejs"), "utf8"), /name="story_camera"/);
  assert.match(fs.readFileSync(path.join(repo, "userstories.js"), "utf8"), /app\.locals\.storyCameraOn\s*=/);
});

test("Story camera: nothing the site sends blocks the camera or the microphone (Permissions-Policy / Feature-Policy)", () => {
  const files = [];
  for (const f of fs.readdirSync(repo)) if (/\.js$/.test(f)) files.push(path.join(repo, f));
  for (const d of ["middleware", "deploy"]) {
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(?:js|conf|sh|example)$/.test(e.name)) files.push(p); } };
    if (fs.existsSync(path.join(repo, d))) walk(path.join(repo, d));
  }
  assert.ok(files.some((f) => /index\.js$/.test(f)));
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:Permissions|Feature)-Policy["'`,:\s]+([^\n]*)/gi)) {
      assert.doesNotMatch(m[1], /\b(?:camera|microphone)\s*=\s*\(\s*\)/i, path.relative(repo, f) + " turns the camera / mic off");
      if (/\bcamera\b/i.test(m[1])) assert.match(m[1], /camera\s*=\s*\((?:[^)]*\bself\b|\s*\*)/i, path.relative(repo, f));
      if (/\bmicrophone\b/i.test(m[1])) assert.match(m[1], /microphone\s*=\s*\((?:[^)]*\bself\b|\s*\*)/i, path.relative(repo, f));
    }
    if (/require\(["']helmet["']\)/.test(text)) assert.match(text, /permissionsPolicy|camera/i, path.relative(repo, f) + " uses helmet: check its Permissions-Policy");
  }
});

test("Story camera: CSS uses ds tokens, keeps the safe areas and stops the long-press callout on the shutter", () => {
  const css = fs.readFileSync(path.join(repo, "public/css/story-camera.css"), "utf8");
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|--ds-green|@import/i);
  assert.doesNotMatch(css, /(?:^|[;{])\s*(?:left|right|margin-left|margin-right|padding-left|padding-right)\s*:/m);
  assert.doesNotMatch(css, /z-index:\s*\d/); assert.doesNotMatch(css, /font-weight:\s*(?!400\b|500\b|700\b)\d+/);
  for (const m of css.matchAll(/border-radius:([^;}]+)/g)) assert.match(m[1].trim(), /^(?:var\(--ds-r-[\w-]+\)|50\s*%)$/);
  for (const n of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(+n[1] >= 11);
  for (const side of ["top", "bottom", "left", "right"]) assert.match(css, new RegExp("env\\(safe-area-inset-" + side));
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /background:\s*var\(--ds-media-bg\)/);
  const shutterRules = [...css.matchAll(/\.scam-shutter\s*\{([^}]+)\}/g)].map((m) => m[1]).join(";");
  assert.match(shutterRules, /touch-action:\s*none/); assert.match(shutterRules, /-webkit-touch-callout:\s*none/); assert.match(shutterRules, /user-select:\s*none/);
  assert.match(css, /\[data-facing="user"\][^{]*\.scam-video[^{]*\{[^}]*scaleX\(-1\)/, "the front preview is mirrored");
  assert.match(css, /\.sst\.scam-open\s*>\s*\.sst-card\s*\{[^}]*visibility:\s*hidden/, "the editor behind is out of the way (and out of the tab order)");
  const js = SRC("story-camera.js"); assert.doesNotMatch(js, /localStorage|innerHTML|location\.reload|eval\(/);
});
