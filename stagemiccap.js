// Server-built captures of the viewer's mic stage. The browser supplies no media. A snap re-reads
// the viewer's program after obtaining frames; a forward clip fixes its layout, rechecks consent
// every 500 ms, and permanently blanks a tile when it leaves or becomes private. Covers never
// resolve an identity or open a camera. Only cams actually drawn enter stage_capture_people.
// Temporary loopback RTSP permissions exist only while their job holds a path. Readers copy the
// live streams without occupying feedmedia's encoding queue; the final composition uses that queue.
// Room audio is future-only, with hidden/private turns muted. Missing hm metadata drops ALL audio.
// stagecap owns database rows, previews, billing and publishing; this module owns only active jobs.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const W = 1280, H = 720, FOOT = 32, DARK = "#10151d", CLIP_MIN = 3;
const MIC_LAG = 2;   // review fix: Pepe's mic list reaches the site up to ~2 s after a grab (s)
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const JOBS = new Map(), SNAP_AT = new Map();
const CID = /^c[a-f0-9]{20}$/, LOGIN = /^[a-z0-9_.-]{1,64}$/i;
const MSG = {
  empty: "Nobody is on the mic right now.", home: "Open the pad to snap or clip its mic stage",
  disabled: "Mic-stage captures are off right now.", busy: "Busy — try again in a minute.",
  denied: "This pad is not available to this account.", unavailable: "Captures are unavailable in this pad.",
  recording: "Someone is clipping this stage right now — try again in {secs} s",
  snap_wait: "Please wait a moment before snapping this stage again.",
  short: "The recording stopped before there was enough to keep.",
  failed: "Couldn’t capture the mic stage just now — nothing was charged.",
  revoked: "Someone in this capture turned off captures of their cam."
};
let deps = {
  now: () => Date.now(), config: () => require("./mainstage").config(),
  eligibility: u => require("./stagecap").eligibility(u), killed: k => require("./stagecap").killed(k),
  roomOff: id => require("./stagecap").roomOff(id),
  resolveRoom: id => require("./roomsweb").resolveRoom(id),
  account: async id => (await require("./dbUtils").getQuery("SELECT * FROM users WHERE userId = ?", [id]))[0],
  people: async id => (await require("./dbUtils").getQuery("SELECT login FROM stage_capture_people WHERE capture_id = ?", [id])).map(x => x.login),
  full: async (u, id) => { const p = require("./padaccess"); await p.init(); return p.full(u, id); },
  block: (id, u, kind) => require("./bridgeblocks").refusal(id, u, kind),
  clipSwitch: id => require("./bridge").clipSwitch(id), clipOffText: id => require("./bridge").clipOffText(id),
  liveShown: id => { try { const B = require("./bridge"), r = B._rooms.get(id); return !!r && B.isLiveShown(r); } catch (_) { return false; } },
  // review fix 2: the 💎 Prime Time Plus bridge perk alone (what bridge.bridgeOk asks; failing closed here) - no liveness in it
  bridgeOk: id => { try { return require("./premium").bridgeAllowed(String(id)) === true; } catch (_) { return false; } },
  program: (id, u) => require("./bridge").stageProgramFor(id, u),
  camRefusal: (l, u, o) => require("./camviewers").camRefusal(l, u, o),
  hidden: l => require("./quotes").isHidden(l),
  exact: (id, l) => require("./livecam").mfState(id, l).exact === true,
  pin: (id, l) => require("./micfollow").pinOf(id, l),
  camPath: (id, l) => require("./livecam").pathFor(id, l),
  still: (id, l) => require("./bridge-relay").mfFrame(id, l),
  audioTap: (id, fn, u) => require("./bridge").audioTap(id, fn, u),
  offset: (id, p) => require("./avsync").serverOffsetMs(id, p, "mp3"),
  mic: id => { const r = require("./bridge")._rooms.get(id); return r && r.mic; },
  privateLogins: ls => privateLoginsStrict(ls),
  note: (kind, id, l, u) => require("./camviewers").noteViewers(kind, id, l, [String(u)]),
  fm: () => require("./feedmedia"), reader: null,
  privacyWaitMs: 1500   // review fix 2: how long a cut waits for a private-profile lookup still in flight (settlePrivacy)
};
const DEFAULT_DEPS = Object.freeze({ ...deps });   // review fix 2: (tests) the real checks, to put back after a stub
function configure(d) { deps = { ...deps, ...d }; }
// stories.privateLogins intentionally tolerates a missing users table for its feed callers. A
// recorder cannot interpret that database failure as public consent. Apply its same two profile
// sections here, retaining errors so privateSample can mute the complete unknown interval.
async function privateLoginsStrict(logins, read, layout) {
  const ls = [...new Set(logins.map(l => String(l).toLowerCase()).filter(l => LOGIN.test(l)))];
  if (!ls.length) return new Set();
  const query = read || require("./dbUtils").getQuery;
  const users = await query(`SELECT userId, camfrogUsername FROM users WHERE lower(camfrogUsername) IN (${ls.map(() => "?").join(",")})`, ls);
  const pl = layout || require("./profilelayout"), out = new Set();
  for (const u of users) {
    const L = layout ? await pl.get(u.userId) : await privateLayoutStrict(u.userId, query, pl);
    if (pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden") out.add(String(u.camfrogUsername).toLowerCase());
  }
  return out;
}
async function privateLayoutStrict(userId, query, pl) {
  await pl.ready;
  const row = (await query("SELECT layout FROM profile_layout WHERE user_id = ?", [String(userId)]))[0];
  if (!row) return pl.sanitize(pl.DEFAULT); // no saved preference uses the site's public default
  const raw = JSON.parse(row.layout); // profilelayout.get falls back to public for corrupt JSON
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw.hidden != null && !Array.isArray(raw.hidden))) throw Error("Unreadable privacy preference");
  return pl.sanitize(raw);
}
function refuse(key, status = 403, vars) {
  const e = new Error((MSG[key] || key).replace(/\{(\w+)\}/g, (m, k) => vars && vars[k] != null ? vars[k] : m));
  Object.assign(e, { status, refuse: true, i18n: MSG[key] ? "stagecap.mic." + key : undefined, vars }); return e;
}
function sanitize(s) { return String(s || "").replace(/stagecap(?::|%3a)[^\s/@]*@/ig, "stagecap:[redacted]@"); }
function text(s, limit = 40) {
  // Pictographs are omitted: production servers need no emoji font. Slice Unicode code points.
  const a = Array.from(String(s || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u0000-\u001f\u007f]/gu, "").trim());
  return (a.length > limit ? a.slice(0, limit - 1).join("") + "…" : a.join("")).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}
function entries(p) {
  return (p && Array.isArray(p.src) ? p.src : []).filter(e => e && typeof e.id === "string" && /^[\w.-]{1,64}$/.test(e.id) && e.watch !== "hidden")
    .slice(0, 9).sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
}
function speaking(p) { return p && (p.speaking === "someone" || p.speaking === "pepe") ? p.speaking : null; }
function usable(p) { return !!(p && !p.signin && !p.blocked && p.on !== false && (entries(p).length || speaking(p))); }
async function programFor(R, user) { return deps.program(R.id, user.userId); }

/** CSS grid rectangles, including the intentional picture-in-picture overlap. No DOM required. */
function rects(program, width = W, height = H) {
  const es = entries(program), n = es.length, out = [], gap = 2;
  if (!n) return out;
  const dyn = program.dyn, d = dyn && dyn.n === n && dyn.t === "d" + n ? n : 0;
  const main = d ? es.find(e => e.id === dyn.main) || es[0] : es.find(e => e.newest) || es.filter(e => !e.pin).at(-1) || es[0];
  const add = (e, x, y, w, h) => out.push({ id: e.id, x: Math.round(x), y: Math.round(y),
    w: Math.max(2, Math.min(width, Math.round(x + w)) - Math.round(x)), h: Math.max(2, Math.min(height, Math.round(y + h)) - Math.round(y)) });
  if (!d && program.layout === "pip") {
    add(main, 0, 0, width, height);
    es.filter(e => e !== main).forEach(e => add(e, width * .7 - 8, height * .7 - 8, width * .3, height * .3));
    return out;
  }
  let cols = [1], rows = 1, cells = [];
  if (d) {
    if (d === 2) { cols = [1, 1]; cells = [[0, 0, 1, 1], [1, 0, 1, 1]]; }
    if (d === 3 || d === 4 || d === 7) {
      cols = d === 3 ? [2, 1] : d === 4 ? [3, 1] : [2, 1, 1]; rows = d === 3 ? 2 : 3;
      cells = [[0, 0, 1, rows]];
      for (let y = 0; y < rows; y++) for (let x = 1; x < cols.length; x++) cells.push([x, y, 1, 1]);
    }
    if (d === 5) { cols = [2, 1, 1]; rows = 2; cells = [[0, 0, 1, 2], [1, 0, 1, 1], [2, 0, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]]; }
    if (d === 6 || d === 8 || d === 9) {
      cols = Array(d === 6 ? 3 : 4).fill(1); rows = d === 8 ? 4 : 3;
      const span = d === 8 ? 3 : 2; cells = [[0, 0, span, span]];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols.length; x++) if (x >= span || y >= span) cells.push([x, y, 1, 1]);
    }
  } else {
    const c = program.layout === "grid9" ? 3 : program.layout === "grid4" || program.layout === "split" ? 2 : 1;
    cols = Array(c).fill(1); rows = program.layout === "grid9" ? 3 : program.layout === "grid4" ? 2 : Math.ceil(n / c);
  }
  if (!cells.length) for (let i = 0; i < n; i++) cells.push([i % cols.length, Math.floor(i / cols.length), 1, 1]);
  const unit = (width - gap * (cols.length - 1)) / cols.reduce((a, b) => a + b, 0), rh = (height - gap * (rows - 1)) / rows;
  const xs = [0]; for (const c of cols) xs.push(xs[xs.length - 1] + c * unit + gap);
  const ordered = d ? [main, ...es.filter(e => e !== main)] : es;
  ordered.forEach((e, i) => { const [x, y, cw, ch] = cells[i]; add(e, xs[x], y * (rh + gap), xs[x + cw] - xs[x] - gap, ch * rh + (ch - 1) * gap); });
  return out;
}
/** Central alignment point for WP-4. Deliberately never reads a cover's login or id as identity. */
function coverArt(entry) {
  const valid = (entry.veil === "incognito" || entry.veil === "hidden") && Number.isInteger(entry.hood) && entry.hood >= 0 && entry.hood <= 7;
  const file = valid ? path.join(__dirname, "public", "img", "anon", "hood-" + (entry.veil === "hidden" ? "shadow-" : "peek-") + entry.hood + ".svg") : null;
  let art = null;
  try { if (file && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()) art = fs.readFileSync(file); } catch (_) { /* WP-4 not installed yet */ }
  return { art, label: String(entry.name || "") + (valid ? " · " + entry.veil : "") };
}
async function consent(login, userId) {
  // review fix: camRefusal treats a failed private-profile lookup as public. The strict lookup throws instead, which refuses here.
  try {
    return !(await deps.hidden(login)) && !(await deps.privateLogins([login])).has(String(login).toLowerCase()) &&
      !(await deps.camRefusal(login, userId, { strict: true }));
  } catch (_) { return false; }
}
async function tileFor(e, R, user) {
  const t = { id: e.id, mode: "blank", newest: !!e.newest, pin: !!e.pin, name: "", source: e };
  if (e.kind === "cover") { const c = coverArt(e); return { ...t, mode: "cover", name: c.label, image: c.art }; }
  if (e.kind !== "cam" || (e.watch !== "ok" && e.watch !== "notice")) return t;
  const login = String(e.login || e.id).toLowerCase();
  if (!LOGIN.test(login) || !(await consent(login, user.userId))) return t;
  Object.assign(t, { login, name: String(e.name || login), mode: "card" });
  if (e.watch === "notice") return t;
  if (e.video === "live") {
    let allowed = false;
    try { allowed = e.pin ? !!deps.pin(R.id, login) : deps.exact(R.id, login) === true; } catch (_) { /* card */ }
    if (allowed) { t.mode = "live"; t.path = deps.camPath(R.id, login); }
  } else if (e.video === "still") {
    try {
      const s = await deps.still(R.id, login);
      if (s && s.state === "ok" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.img) && s.img.length <= 8 * 1024 * 1024) {
        t.image = Buffer.from(s.img.slice(s.img.indexOf(",") + 1), "base64"); t.mode = "still";
      }
    } catch (_) { /* name card */ }
  }
  return t;
}
async function tilesFor(p, R, user) { return Promise.all(entries(p).map(e => tileFor(e, R, user))); }
async function gate(R, user, kind, surface, { live = false } = {}) {
  if (!R || !user || !user.userId) throw refuse("Sign in first.", 401);
  if (deps.config().stagecap_mic !== true) throw refuse("disabled");
  if (surface === "home") throw refuse("home");
  const why = deps.killed(kind) || deps.roomOff(R.id) || deps.eligibility(user);
  if (why) throw refuse(why);
  // review fix: the 💎 Prime Time Plus bridge gate the cam captures obey: no shown bridge room, no capture.
  // review fix 2: the perk itself (bridgeOk, like livecam's cam captures) - bridge.isLiveShown also needs a Pepe sync within 90 s, and
  // a Pepe restart then revoked every pending preview through recheck. Pepe live (`live`) only where a capture needs him now: start,
  // each recording sample, availability and stagecap's check before it writes anything.
  if (!deps.bridgeOk(R.id) || (live && !deps.liveShown(R.id))) throw refuse("unavailable");
  if (!(await deps.full(user, R.id))) throw refuse("denied");
  const block = await deps.block(R.id, user.userId, kind === "clip" ? "clips" : "snapshots");
  if (block) throw refuse(typeof block === "string" ? block : block.error || "unavailable");
  if (kind === "clip" && deps.clipSwitch(R.id) !== true) throw refuse(deps.clipOffText(R.id));
}
async function availability(R, user, surface, translate) {
  if (deps.config().stagecap_mic !== true) return null;
  const view = { snap: false, clip: false, why: null };
  for (const k of ["snap", "clip"]) try { await gate(R, user, k, surface, { live: true }); view[k] = true; } catch (e) {   // review fix 2: + live
    const why = e.i18n && translate ? translate(e.i18n, e.vars) : e.message;
    view[k + "_why"] = why; if (!view.why) view.why = why;
  }
  return view;
}
async function recheck(capture) {
  try {
    const u = await deps.account(capture.user_id), R = await deps.resolveRoom(capture.room_id);
    await gate(R, u, capture.kind === "clip" ? "clip" : "snap", "pad");
    for (const login of await deps.people(capture.id)) if (!(await consent(login, u.userId))) return MSG.revoked;
    return null;
  } catch (_) { return MSG.revoked; }
}

function loopback(ip) {
  const s = String(ip || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (s === "::1" || s === "0:0:0:0:0:0:0:1") return true;
  const v4 = s.replace(/^::ffff:/, ""); return net.isIP(v4) === 4 && v4.split(".")[0] === "127";
}
function rtspBase(raw = process.env.STAGECAP_RTSP_BASE || "rtsp://127.0.0.1:8554") {
  const u = new URL(raw), host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "rtsp:" || !net.isIP(host) || !loopback(host) || u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) throw refuse("failed", 500);
  return u.origin === "null" ? "rtsp://" + u.host : u.origin;
}
function password(job, p) { return crypto.createHmac("sha256", SECRET).update("stagecap-read:" + p + ":" + job.id + ":" + job.expiry).digest("hex"); }
function rtspAuth(b, p) {
  if (!b || !loopback(b.ip)) return 403;
  if (!b.user && !b.password) return 401;
  if (b.user !== "stagecap" || typeof b.password !== "string" || !/^[a-f0-9]{64}$/.test(b.password)) return 403;
  const now = deps.now();
  for (const j of JOBS.values()) if (!j.cancelled && j.reading && j.paths.has(p) && j.expiry > now && j.expiry - now <= (j.kind === "clip" ? j.secs : 6) * 1000 + 15000) {
    const expected = password(j, p);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(b.password))) return 200;
  }
  return 403;
}
function readerArgs(job, tile, file) {
  const u = new URL(rtspBase()); u.username = "stagecap"; u.password = password(job, tile.path); u.pathname = "/" + tile.path;
  const a = ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "rtsp,tcp,rtp", "-rtsp_transport", "tcp", "-f", "rtsp", "-i", u.toString(), "-map", "0:v:0", "-an", "-map_metadata", "-1"];
  return a.concat(job.kind === "snap" ? ["-frames:v", "1", "-c:v", "png", "-f", "image2", "-y", file] : ["-c:v", "copy", "-progress", "pipe:1", "-f", "mpegts", "-y", file]);
}
function readerTimeoutMs(job) {
  // Authentication expiry also bounds already-open readers; a large measured offset may keep
  // the overall job alive longer, but never extends the camera-reading permission.
  return Math.max(1, Math.min(job.deadline + (job.kind === "snap" ? 0 : 500), job.expiry) - deps.now());
}
function spawnReader(job, tile, file) {
  const fm = deps.fm(), a = readerArgs(job, tile, file), ff = fm.bin("ffmpeg");
  const nice = process.platform === "linux" && !process.env.FEED_NO_NICE;
  const cp = spawn(nice ? "nice" : ff, nice ? ["-n", "10", ff, ...a] : a, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "", progress = "", settled = false, timer, firstAt = null;
  const kill = () => { if (!settled) try { cp.kill("SIGKILL"); } catch (_) { /* already closed */ } };
  const done = new Promise(resolve => {
    cp.stderr.on("data", b => { err = sanitize(err + b.toString()).slice(-4096); });
    cp.stdout.on("data", b => {
      progress = (progress + b.toString()).slice(-8192);
      const m = /out_time_us=(\d+)/.exec(progress);
      if (firstAt == null && m && Number(m[1]) > 0) firstAt = Math.max(0, (deps.now() - job.started) / 1000 - Number(m[1]) / 1e6);
    });
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: code === 0, file, firstAt: firstAt == null ? 0 : firstAt, error: err }); };
    cp.once("error", () => finish(-1)); cp.once("close", finish);
    timer = setTimeout(kill, readerTimeoutMs(job));
  });
  return { done, kill, file, get firstAt() { return firstAt; } };
}
let snapReaders = 0;
const snapWait = [];
async function snapSlot() {
  if (snapReaders >= 4) await new Promise(r => snapWait.push(r));
  else snapReaders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = snapWait.shift();
    if (next) next(); // transfer the reserved permit; a fresh caller cannot steal it
    else snapReaders--;
  };
}
function imageRect(r) { return { x: r.x + 3, y: r.y + 3, w: Math.max(2, r.w - 6), h: Math.max(2, r.h - 37) }; }
function svg(body, width = W, height = H) { return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`); }
function svgText(x, y, value, size = 22, anchor = "middle", fill = "#edf2f7", limit = 40) { return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="sans-serif" font-size="${size}" fill="${fill}">${text(value, limit)}</text>`; }
function pinSvg(r) { return `<path d="M${r.x + 17} ${r.y + 11}h12l-2 12 5 5h-9v11l-3-11h-8l7-5z" fill="#d8e1ec"/>`; }
async function renderFrame(p, tiles, R, out, opts = {}) {
  const sharp = require("sharp"), rs = rects(p, W, H - FOOT), byId = new Map(tiles.map(t => [t.id, t]));
  const layers = [{ input: svg(`<rect width="${W}" height="${H}" fill="${DARK}"/>`), left: 0, top: 0 }];
  for (const r of rs) {
    const t = byId.get(r.id); if (!t) continue;
    const ir = imageRect(r);
    let tile = `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${DARK}"/>`, picture = null;
    if (t.image && ["still", "live", "cover"].includes(t.mode)) {
      try {
        const data = await sharp(t.image, { limitInputPixels: 30e6 }).resize(ir.w, ir.h, { fit: "contain", background: DARK }).png().toBuffer();
        picture = { input: data, left: ir.x, top: ir.y };
      } catch (_) { if (t.mode !== "cover") t.mode = "card"; }
    }
    if (t.mode === "card") {
      const initials = String(t.name).trim().split(/\s+/).map(x => Array.from(x)[0]).slice(0, 2).join("").toUpperCase();
      tile += `<circle cx="${r.x + r.w / 2}" cy="${r.y + r.h / 2 - 20}" r="${Math.min(48, r.h / 5)}" fill="#293747"/>` + svgText(r.x + r.w / 2, r.y + r.h / 2 - 10, initials, Math.min(32, r.h / 7));
    }
    layers.push({ input: svg(tile), left: 0, top: 0 });
    if (picture) layers.push(picture);
    if (t.mode !== "blank") {
      let label = `<rect x="${r.x + 3}" y="${r.y + r.h - 34}" width="${r.w - 6}" height="31" fill="#0a1018" fill-opacity=".88"/>` + svgText(r.x + 12, r.y + r.h - 12, t.name, Math.min(22, Math.max(12, r.w / 18)), "start");
      if (t.pin) label += pinSvg(r);
      if (!opts.noRing && t.newest) label += `<rect x="${r.x + 2}" y="${r.y + 2}" width="${r.w - 4}" height="${r.h - 4}" fill="none" stroke="#65dca4" stroke-width="4"/>`;
      layers.push({ input: svg(label), left: 0, top: 0 });
    }
  }
  let top = "";
  const speak = speaking(p);
  if (speak && !opts.noSpeaking) top += speakingSvg(speak, !!rs.length);
  const padTitle = Array.from(String(R.title || R.name || "")).slice(0, 40).join("");
  top += `<rect y="${H - FOOT}" width="${W}" height="${FOOT}" fill="#090f17"/>` + svgText(16, H - 10, "On the mic · " + padTitle + " · publicaccess.tv", 17, "start", "#aebdcd", 100);
  layers.push({ input: svg(top), left: 0, top: 0 });
  const image = sharp({ create: { width: W, height: H, channels: 4, background: DARK } }).composite(layers);
  if (out) return path.extname(out) === ".webp" ? image.webp({ quality: 82 }).toFile(out) : image.png().toFile(out);
  return image.png().toBuffer();
}
function speakingSvg(kind, dim) {
  return (dim ? `<rect width="${W}" height="${H - FOOT}" fill="#000" fill-opacity=".6"/>` : "") +
    `<rect x="260" y="${dim ? 20 : 290}" width="760" height="70" rx="12" fill="#172332"/>` + svgText(W / 2, dim ? 64 : 334, kind === "pepe" ? "Pepe is on the mic" : "Someone is speaking", 32);
}

/** Decode-byte ranges, not arrival estimates, determine where an MP3 chunk lands in the output. */
function mergeWindows(windows, duration) {
  const out = [];
  for (const w of windows.map(([a, b]) => [Math.max(0, a), Math.min(duration, b)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]; if (last && w[0] <= last[1] + .001) last[1] = Math.max(last[1], w[1]); else out.push(w);
  }
  return out;
}
function shifts(offsets) {
  const vals = offsets.map(v => Number.isFinite(v) ? v / 1000 : 0);
  const audio = Math.max(0, -Math.min(0, ...vals));
  const video = vals.map(v => v + audio);
  return { audio, video, extra: Math.max(audio, ...video, 0) };
}
function audioPlan(chunks, packets, privateHistory, duration, audioShift = 0) {
  if (!chunks.length) return { reason: "off", muted: [], segments: [], muted_s: 0 };
  if (chunks.some(c => c.hm !== 0 && c.hm !== 1)) return { reason: "outdated", muted: [], segments: [], muted_s: 0 };
  const ranges = chunks.map(c => ({ ...c, begin: Infinity, end: -Infinity }));
  let time = 0;
  for (const p of packets) {
    const dt = Number(p.duration_time), pos = Number(p.pos), size = Number(p.size);
    if (!(dt > 0) || !Number.isFinite(pos) || !(size > 0)) continue;
    for (const c of ranges) if (pos < c.offset + c.bytes && pos + size > c.offset) { c.begin = Math.min(c.begin, time); c.end = Math.max(c.end, time + dt); }
    time += dt;
  }
  if (!time || ranges.some(c => !Number.isFinite(c.begin))) return { reason: "outdated", muted: [], segments: [], muted_s: 0 };
  const muted = [], segments = [];
  // A chunk's arrival marks the end of that chunk, not the start. Accommodate interrupted posts
  // without pulling later sound earlier: contiguous decoded ranges share one placement segment.
  let anchor = Math.max(0, ranges[0].at - (ranges[0].end - ranges[0].begin));
  let seg = { begin: 0, end: 0, at: anchor + audioShift };
  for (const c of ranges) {
    const arrivalStart = Math.max(0, c.at - (c.end - c.begin));
    if (arrivalStart - (anchor + c.begin) > .5) { seg.end = c.begin; if (seg.end > seg.begin) segments.push(seg); anchor = arrivalStart - c.begin; seg = { begin: c.begin, end: c.end, at: arrivalStart + audioShift }; }
    seg.end = Math.max(seg.end, c.end);
    const begin = anchor + c.begin + audioShift, end = anchor + c.end + audioShift;
    if (c.hm === 1) muted.push([begin - .25, end + .25]);
    const latency = c.lat && c.lat.mp3_ms;
    if (!Number.isFinite(latency)) { muted.push([begin, end]); continue; }
    // Look BACK from audio arrival to the mic roster that produced it. A grab at 5 s and
    // a 1 s MP3 delay mutes sound arriving around 6 s, never sound that arrived at 4 s.
    const sourceA = arrivalStart - latency / 1000, sourceB = c.at - latency / 1000;
    let coveredUntil = sourceA;
    for (let i = 0; i < privateHistory.length; i++) {
      const h = privateHistory[i], next = privateHistory[i + 1];
      const a = h.at, b = next ? next.at : duration + 20;
      if (a <= coveredUntil && b > coveredUntil) coveredUntil = b;
      if (h.private && sourceA < b + .5 && sourceB >= a - .5) muted.push([begin - .5, end + .5]);
    }
    if (coveredUntil < sourceB) muted.push([begin - .5, end + .5]);
  }
  if (seg.end > seg.begin) segments.push(seg);
  const merged = mergeWindows(muted, duration);
  return { reason: null, muted: merged, segments, muted_s: merged.reduce((n, w) => n + w[1] - w[0], 0) };
}
/** review fix: every observation from `from` (job s) on is private, and the sorted history gets that boundary too. */
function privateSince(history, from) {
  let i = history.findIndex(h => h.at >= from);
  if (i < 0) i = history.length;
  for (let k = i; k < history.length; k++) history[k].private = true;
  if (!history[i] || history[i].at > from) history.splice(i, 0, { at: from, private: true });
}
function privateSample(job) {
  // review fix 2: the lookup in flight stays on the job (its promise, and the sample's time in privacyAt), so a cut can wait for
  // the private look-back it carries (settlePrivacy) instead of planning the audio without it
  if (job.privacyPending) return job.privacyPending;
  const p = privateSampleNow(job).finally(() => { if (job.privacyPending === p) job.privacyPending = null; });
  job.privacyPending = p;
  return p;
}
/** review fix 2: before the audio plan, a sample whose profile lookup is still pending - its private holder's look-back (from the
 *  hold's since) lands only when it resolves. Waited up to deps.privacyWaitMs; still pending, it counts as a private holder from
 *  MIC_LAG before that sample (privateSample's unknown-since rule). -> true when nothing was left pending */
async function settlePrivacy(job) {
  const p = job.privacyPending;
  if (!p) return true;
  let timer;
  const settled = await Promise.race([p.then(() => true, () => true), new Promise(r => { timer = setTimeout(() => r(false), Math.max(0, Number(deps.privacyWaitMs) || 0)); })]);
  clearTimeout(timer);
  if (!settled) privateSince(job.privateHistory, Math.max(0, job.privacyAt - MIC_LAG));
  return settled;
}
async function privateSampleNow(job) {
  const at = (deps.now() - job.started) / 1000;
  job.privacyAt = at;
  const previous = job.privateHistory.at(-1);
  if (previous && at - previous.at > 1) job.privateHistory.push({ at: previous.at + .5, private: true });
  // Unknown until the lookup completes. A cut that starts while this promise is pending must
  // not extend the last known-public roster over sound we have not checked yet.
  const observation = { at, private: true };
  job.privateHistory.push(observation);
  let priv = true, from = Math.max(0, at - MIC_LAG);
  try {
    const mic = deps.mic(job.R.id);
    if (Array.isArray(mic)) {
      const holders = mic.filter(x => x && !x.anon && LOGIN.test(String(x.login || "")));
      const found = await deps.privateLogins(holders.map(x => String(x.login).toLowerCase()));
      priv = found.size > 0;
      // review fix: a private holder's turn starts at their hold's `since` (epoch ms -> job time, never before the job), not
      // at this sample: Pepe's mic list reaches the site up to MIC_LAG after the grab. Unknown since: MIC_LAG back.
      const starts = holders.filter(x => found.has(String(x.login).toLowerCase())).map(x => {
        const s = Number(x.since);
        return Number.isFinite(s) && s > 0 ? Math.max(0, (s - job.started) / 1000) : Math.max(0, at - MIC_LAG);
      });
      if (starts.length) from = Math.min(at, ...starts);
    }
  } catch (_) { /* unavailable mic list is private */ }
  observation.private = priv;
  if (priv && from < at) privateSince(job.privateHistory, from);
  // The roster was observed before the lookup, not after it. If the lookup consumed more than
  // a polling interval, the unobserved remainder is private until the next successful sample.
  if ((deps.now() - job.started) / 1000 - at > .5) job.privateHistory.push({ at: at + .5, private: true });
}
function stopTile(job, t, at) {
  if (t.stop != null) return; t.stop = Math.max(0, at); job.paths.delete(t.path);
  if (t.reader) t.reader.kill();
}
async function sample(job) {
  if (job.sampling || job.cancelled || !job.reading) return;
  job.sampling = true;
  try {
    const at = (deps.now() - job.started) / 1000;
    privateSample(job).catch(() => {});
    const user = await deps.account(job.user.userId);
    await gate(job.R, user, job.kind, job.surface, { live: true });   // review fix 2: a recording needs Pepe live
    const p = await programFor(job.R, user);
    if (!usable(p)) throw refuse("empty", 409);
    const current = new Map((await tilesFor(p, job.R, user)).map(t => [t.id, t]));
    for (const t of job.tiles) {
      const next = current.get(t.id);
      if (t.stop == null && (!next || next.mode === "blank" || next.mode !== t.mode || next.login !== t.login || next.path !== t.path || next.source.watch !== t.source.watch)) stopTile(job, t, at);
      if (t.stop == null && !!next.newest !== t.lastNewest) { t.rings.push({ at, on: !!next.newest }); t.lastNewest = !!next.newest; }
    }
    const s = speaking(p);
    if (s !== job.lastSpeaking) { job.speaking.push({ at, kind: s }); job.lastSpeaking = s; }
    if (!job.tiles.some(t => t.stop == null && t.mode !== "blank") && !s) job.finishEarly(at);
  } catch (_) { job.finishEarly((deps.now() - job.started) / 1000); }
  finally { job.sampling = false; }
}
function finishReaders(job) { job.reading = false; job.paths.clear(); for (const t of job.tiles) if (t.reader) t.reader.kill(); if (job.untap) { job.untap(); job.untap = null; } clearInterval(job.timer); }
function removeFile(p) { try { fs.unlinkSync(p); } catch (_) { /* absent */ } }
function cleanJob(job) {
  finishReaders(job);
  // Only files created directly in this job's own, validated directory are removed.
  try { for (const name of fs.readdirSync(job.dir)) { const p = path.join(job.dir, name); if (fs.lstatSync(p).isFile()) removeFile(p); } fs.rmdirSync(job.dir); } catch (_) { /* retry on startup */ }
}
function cancel(id) {
  const j = JOBS.get(String(id)); if (!j) return false;
  j.cancelled = true; finishReaders(j); j.finishEarly(0); removeFile(j.out); return true;
}
async function init(tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const name of fs.readdirSync(tmpDir)) if (/^mic-c[a-f0-9]{20}$/.test(name)) {
    const dir = path.join(path.resolve(tmpDir), name);
    if (fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink()) cleanJob({ dir, tiles: [], paths: new Set() });
  }
}
async function snap(job) {
  job.finishEarly = at => { for (const t of job.tiles) stopTile(job, t, at); finishReaders(job); };
  job.timer = setInterval(() => { sample(job).catch(() => {}); }, 500);
  await Promise.all(job.tiles.filter(t => t.mode === "live").map(async (t, i) => {
    const release = await snapSlot();
    try {
      if (job.cancelled || t.stop != null || deps.now() >= job.deadline) return;
      const file = path.join(job.dir, "frame-" + i + ".png");
      t.reader = (deps.reader || spawnReader)(job, t, file);
      const result = await t.reader.done;
      if (result.ok && !job.cancelled && t.stop == null) try { t.image = fs.readFileSync(file); } catch (_) { /* card */ }
    } finally { release(); }
  }));
  finishReaders(job);
  if (job.cancelled) throw refuse("failed", 409);
  const user = await deps.account(job.user.userId); await gate(job.R, user, "snap", job.surface);
  const p = await programFor(job.R, user); if (!usable(p)) throw refuse("empty", 409);
  const final = await tilesFor(p, job.R, user), old = new Map(job.tiles.map(t => [t.id, t]));
  for (const t of final) if (t.mode === "live") {
    const prior = old.get(t.id);
    if (prior && prior.stop == null && prior.mode === "live" && prior.path === t.path && prior.source.watch === t.source.watch && prior.image) t.image = prior.image;
    else t.mode = "card";
  }
  await renderFrame(p, final, job.R, job.out);
  const people = [...new Set(final.filter(t => t.login && t.image && (t.mode === "live" || t.mode === "still")).map(t => t.login))];
  return { secs: 0, bytes: fs.statSync(job.out).size, people, audio: null };
}

function intervals(changes, end, key = "on") {
  const out = []; changes.forEach((c, i) => { const b = Math.min(end, changes[i + 1] ? changes[i + 1].at : end); if (c[key] && b > c.at) out.push([c.at, b, c[key]]); }); return out;
}
const num = n => Math.max(0, Number(n) || 0).toFixed(4);
/** One final filter graph. File-only inputs and forced demuxers; no user strings in expressions. */
function composeArgs({ base, tiles, rectangles, duration, audioFile, audio, speakingFiles = {}, speakingChanges = [], out }) {
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-filter_complex_threads", "1", "-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "15", "-f", "image2", "-i", base];
  const f = ["[0:v]format=yuv420p,setpts=PTS-STARTPTS[v0]"];
  let index = 1, v = 0;
  // Paint each entire tile in CSS z-order. In PiP, a stopped main may be blanked without
  // painting over the still-active inset that comes afterwards.
  for (const r of rectangles) {
    const t = tiles.find(x => x.id === r.id); if (!t) continue;
    if (t.staticFile) {
      args.push("-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "15", "-f", "image2", "-i", t.staticFile);
      f.push(`[v${v}][${index}:v]overlay=${r.x}:${r.y}[v${++v}]`); index++;
    }
    if (t.file) {
      const ir = imageRect(r), w = Math.floor(ir.w / 2) * 2, h = Math.floor(ir.h / 2) * 2;
      args.push("-protocol_whitelist", "file", "-f", "mpegts", "-i", t.file);
      const start = Math.max(0, t.firstAt || 0) + (t.shift || 0), end = Math.min(duration, t.stop == null ? duration : t.stop);
      f.push(`[${index}:v]setpts=PTS-STARTPTS+${num(start)}/TB,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x10151d,setsar=1[t${index}]`);
      f.push(`[v${v}][t${index}]overlay=${ir.x}:${ir.y}:eof_action=pass:enable='between(t,${num(start)},${num(end)})'[v${++v}]`); index++;
    }
    if (t.mode === "blank") continue;
    for (const [a, b] of intervals(t.rings || [], Math.min(duration, t.stop == null ? duration : t.stop))) {
      f.push(`[v${v}]drawbox=x=${r.x + 2}:y=${r.y + 2}:w=${r.w - 4}:h=${r.h - 4}:color=0x65dca4:t=4:enable='between(t,${num(a)},${num(b)})'[v${++v}]`);
    }
    if (t.stop != null && t.stop < duration) f.push(`[v${v}]drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=0x10151d:t=fill:enable='gte(t,${num(t.stop)})'[v${++v}]`);
  }
  for (const kind of ["someone", "pepe"]) {
    const wins = intervals(speakingChanges, duration, "kind").filter(x => x[2] === kind); if (!wins.length || !speakingFiles[kind]) continue;
    args.push("-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "15", "-f", "image2", "-i", speakingFiles[kind]);
    f.push(`[v${v}][${index}:v]overlay=0:0:enable='${wins.map(([a, b]) => `between(t,${num(a)},${num(b)})`).join("+")}'[v${++v}]`); index++;
  }
  let hasAudio = !!(audioFile && audio && !audio.reason && audio.segments.length);
  if (hasAudio) {
    args.push("-protocol_whitelist", "file", "-f", "mp3", "-i", audioFile);
    const n = audio.segments.length;
    f.push(`[${index}:a]asplit=${n}${audio.segments.map((_, i) => `[as${i}]`).join("")}`);
    // review fix: the VPS's ffmpeg 4.2 has neither adelay's all= (4.3+) nor amix's normalize= (4.4+). Delay both MP3
    // channels explicitly and pad every input to the clip's length: amix then scales by a constant 1/N (no input ever
    // drops out), and volume=N restores the plain sum.
    audio.segments.forEach((s, i) => {
      const d = Math.round(s.at * 1000);
      f.push(`[as${i}]atrim=start=${num(s.begin)}:end=${num(s.end)},asetpts=PTS-STARTPTS,adelay=${d}|${d},apad,atrim=end=${num(duration)}[ad${i}]`);
    });
    // review fix 2: volume's enable is tested once per frame, at its start. After the first segment amix passes on apad's
    // 4096-sample packets, so a mute began up to ~85 ms late (186 ms at 22.05 kHz); 256-sample frames (asetnsamples, 4.2 has
    // it; p=0: no padding) mute within ~5 ms. It only re-cuts the frames - the levels are unchanged.
    f.push(audio.segments.map((_, i) => `[ad${i}]`).join("") + `amix=inputs=${n},volume=${n},apad,atrim=duration=${num(duration)}` +
      (audio.muted.length ? `,asetnsamples=n=256:p=0,volume=0:enable='${audio.muted.map(([a, b]) => `between(t,${num(a)},${num(b)})`).join("+")}'` : "") + "[audio]");
  }
  args.push("-filter_complex", f.join(";"), "-map", `[v${v}]`);
  if (hasAudio) args.push("-map", "[audio]", "-c:a", "aac", "-b:a", "128k", "-ac", "2"); else args.push("-an");
  return args.concat(["-t", num(duration), "-r", "15", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4", "-y", out]);
}
async function clip(job, hooks) {
  const sharp = require("sharp"), fm = deps.fm(), base = path.join(job.dir, "base.png"), audioFile = path.join(job.dir, "audio.mp3");
  const shiftsByTile = job.shifts;
  job.deadline = job.started + (job.secs + shiftsByTile.extra + 1) * 1000;
  let vi = 0;
  for (const t of job.tiles) if (t.mode === "live") { t.shift = shiftsByTile.video[vi++]; t.reader = (deps.reader || spawnReader)(job, t, path.join(job.dir, "video-" + vi + ".ts")); }
  let offset = 0, audioEnded = false;
  const chunks = [];
  const tap = (buf, meta) => {
    if (audioEnded || !job.reading || job.cancelled || !Buffer.isBuffer(buf) || offset + buf.length > 8 * 1024 * 1024) return;
    try {
      fs.appendFileSync(audioFile, buf);
      chunks.push({ offset, bytes: buf.length, hm: meta && meta.hm, lat: meta && meta.lat ? { ...meta.lat } : null, at: (deps.now() - job.started) / 1000 }); offset += buf.length;
    } catch (_) { audioEnded = true; chunks.push({ hm: null }); }
  };
  tap.end = () => { audioEnded = true; };
  job.untap = deps.audioTap(job.R.id, tap, job.user);
  privateSample(job).catch(() => {});
  const elapsed = await new Promise(resolve => {
    let finished = false;
    const stop = value => { if (finished) return; finished = true; clearTimeout(job.endTimer); resolve(value); };
    job.finishEarly = stop;
    job.endTimer = setTimeout(() => stop(job.secs), Math.max(0, job.deadline - deps.now()));
    job.timer = setInterval(() => { sample(job).catch(() => {}); }, 500);
    if (job.cancelled) stop(0);
  });
  finishReaders(job);
  const results = await Promise.all(job.tiles.filter(t => t.reader).map(async t => ({ t, result: await t.reader.done })));
  if (job.cancelled) throw refuse("failed", 409);
  const duration = Math.min(job.secs, elapsed);
  if (duration < CLIP_MIN) throw refuse("short", 409);
  // review fix 2: no sample starts after finishReaders; the last one's lookup may still be in flight with its private look-back
  await settlePrivacy(job);
  if (hooks.cutting) await hooks.cutting();
  const release = await fm.slot();
  try {
    if (job.cancelled) throw refuse("failed", 409);
    for (const { t, result } of results) {
      try { const p = await fm.probe(result.file, "mpegts"); if (p.video && p.secs > 0) { t.file = result.file; t.firstAt = result.firstAt || 0; } } catch (_) { /* unreadable relay becomes a name card */ }
      if (!t.file && t.stop == null) t.mode = "card";
    }
    await renderFrame(job.program, job.tiles, job.R, base, { noRing: true, noSpeaking: true });
    if (job.program.layout === "pip" && !job.program.dyn) for (const r of rects(job.program, W, H - FOOT)) {
      const t = job.tiles.find(x => x.id === r.id); if (!t) continue;
      t.staticFile = path.join(job.dir, "static-" + job.tiles.indexOf(t) + ".png");
      await sharp(base).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png().toFile(t.staticFile);
    }
    const speakingFiles = {};
    for (const kind of ["someone", "pepe"]) if (job.speaking.some(c => c.kind === kind)) {
      const f = path.join(job.dir, "speaking-" + kind + ".png"); await sharp(svg(speakingSvg(kind, !!job.tiles.length))).png().toFile(f); speakingFiles[kind] = f;
    }
    let packets = [];
    if (chunks.length && chunks.every(c => c.hm === 0 || c.hm === 1)) try {
      const data = await fm.run(fm.bin("ffprobe"), ["-v", "error", "-protocol_whitelist", "file", "-f", "mp3", "-show_packets", "-show_entries", "packet=pos,size,duration_time", "-of", "json", audioFile], { timeoutMs: 10000, maxOut: 2 * 1024 * 1024 });
      packets = JSON.parse(data.out || "{}").packets || [];
    } catch (_) { /* audioPlan drops undecodable/unmapped audio */ }
    const audio = audioPlan(chunks, packets, job.privateHistory, duration, shiftsByTile.audio);
    fs.writeFileSync(path.join(job.dir, "audio-timeline.json"), JSON.stringify(chunks));
    await fm.run(fm.bin("ffmpeg"), composeArgs({ base, tiles: job.tiles, rectangles: rects(job.program, W, H - FOOT), duration, audioFile, audio, speakingFiles, speakingChanges: job.speaking, out: job.out }), { timeoutMs: 90000 });
    if (job.cancelled) throw refuse("failed", 409);
    const people = [...new Set(job.tiles.filter(t => t.login && (t.file || (t.image && t.mode === "still")) &&
      Math.min(duration, t.stop == null ? duration : t.stop) > (t.file ? (t.firstAt || 0) + (t.shift || 0) : 0)).map(t => t.login))];
    return { secs: duration, bytes: fs.statSync(job.out).size, people, audio: { reason: audio.reason, muted_s: audio.muted_s } };
  } finally { release(); }
}
async function start(opts, hooks = {}) {
  const { R, user } = opts, kind = opts.kind === "clip" ? "clip" : "snap", secs = [10, 20, 30].includes(Number(opts.secs)) ? Number(opts.secs) : 20;
  await gate(R, user, kind, opts.surface, { live: true });   // review fix 2: a capture starts only while Pepe is live
  const program = await programFor(R, user); if (!usable(program)) throw refuse("empty", 409);
  const tiles = await tilesFor(program, R, user), now = deps.now();
  const offsets = shifts(tiles.filter(t => t.mode === "live").map(t => { try { return deps.offset(R.id, t.path); } catch (_) { return null; } }));
  if (!CID.test(opts.id)) throw refuse("failed", 500);
  const active = [...JOBS.values()];
  if (active.filter(j => j.kind === kind).length >= 2) throw refuse("busy", 429);
  if (kind === "clip") {
    const existing = active.find(j => j.kind === "clip" && j.R.id === R.id);
    if (existing) throw refuse("recording", 429, { secs: Math.max(1, Math.ceil((existing.deadline - now) / 1000)) });
  } else if (SNAP_AT.has(R.id) && now - SNAP_AT.get(R.id) < 3000) throw refuse("snap_wait", 429);
  const dir = path.join(path.resolve(opts.tmpDir), "mic-" + opts.id);
  if (fs.existsSync(dir)) throw refuse("failed", 409);
  const job = { ...opts, id: opts.id, R, user, kind, secs, program, tiles, dir, shifts: offsets, started: now, deadline: now + (kind === "snap" ? 6 : secs + offsets.extra + 1) * 1000,
    expiry: now + (kind === "snap" ? 21 : secs + 15) * 1000, paths: new Set(tiles.filter(t => t.path).map(t => t.path)), reading: true, cancelled: false,
    privateHistory: [], speaking: [{ at: 0, kind: speaking(program) }], lastSpeaking: speaking(program), finishEarly: () => {} };
  tiles.forEach(t => { t.stop = null; t.rings = [{ at: 0, on: t.newest }]; t.lastNewest = t.newest; });
  JOBS.set(job.id, job); if (kind === "snap") SNAP_AT.set(R.id, now);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { JOBS.delete(job.id); throw refuse("failed", 500); }
  const done = Promise.resolve().then(() => kind === "snap" ? snap(job) : clip(job, hooks)).then(async info => {
    if (job.cancelled) throw refuse("failed", 409);
    const current = await deps.account(user.userId);
    await gate(R, current, kind, job.surface);
    for (const login of info.people) if (!(await consent(login, current.userId))) throw refuse("revoked");
    for (const l of info.people) await deps.note(kind, R.id, l, user.userId);
    return info;
  }).catch(e => { removeFile(job.out); if (e.refuse) throw e; const err = refuse("failed", 500); err.cause = sanitize(e.message); throw err; })
    .finally(() => { cleanJob(job); clearTimeout(job.endTimer); JOBS.delete(job.id); });
  return { ready_by: job.deadline, done, cancel: () => cancel(job.id) };
}
module.exports = { configure, init, start, gate, cancel, stop: cancel, availability, recheck, programFor, rtspAuth,
  rects, coverArt, renderFrame, audioPlan, shifts, composeArgs, sanitize,
  _test: { defaults: DEFAULT_DEPS, entries, tileFor, tilesFor, consent, gate, loopback, rtspBase, readerArgs, readerTimeoutMs, spawnReader, snapSlot, password, sample, privateSample, privateLoginsStrict, privateLayoutStrict, jobs: JOBS, snapAt: SNAP_AT, text, intervals, mergeWindows, MSG, W, H } };
