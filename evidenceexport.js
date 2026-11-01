// evidenceexport.js - wave 2 WP-5 (incognito / mic-stage spec E.4; owner J-9 as answered): the ADMIN evidence export of one pad's chat
// for a time range - with REAL names behind frog names and hidden people's words. It is separate from the member download
// (chatlogexport.js, unchanged: frog names and bars for every role, the owner too - downloads are uncontrolled copies).
//
//   POST /api/admin/evidence-export {room (pad address or room id), from, to (ms, ISO-8601 or YYYY-MM-DD[THH:MM], UTC), fmt: txt | jsonl,
//        reason (>= 3 characters)}  -> {ok, url: "/admin/evidence-export/dl/<token>", from, to, cut?}
//        chatlog.see_through only (Admins, locked "privacy"), a same-origin fetch, no-store. Single-use link, 2 minutes, that admin only.
//   GET  /admin/evidence-export/dl/:token -> the file (attachment; Cache-Control: private, no-store; noindex; no-referrer)
// The seethrough_log row (scope export_evidence: every login in the file, the veiled ones first; ref exp:<id>) and the admin_audit row
// (evidence.export) are written in ONE transaction BEFORE the first byte - a file that is never logged is never sent.
// What is in it: the pad's archive (chat_log + chat_log_veil) when it has lines in the range, else the live ring (bridge_feed's items +
// bridge_veil, owner question Q12). A veiled line shows its real login and display name (and a hidden speaker's words) when its identity
// row is still there; lines revealLookup would refuse stay OUT and are counted: taken down (rm_at) or purged ("removed"), left out for
// members now - forget-me, account deletion, a staff hide, !transcripts off ("privacy"); a veiled line whose identity is gone (said
// before G, or its row went) is shown as it is shown to members, counted "can't be revealed". Names of veiled people INSIDE other lines
// stay "someone" (see-through covers speakers, not mentions - spec A.3). The watermark line "Evidence export by <admin>, <time>, <pad>"
// is the first line of the TXT (and its last), the JSONL header's `watermark` (and the footer line's). Limits: 31 days (a longer
// range is cut and says where to continue), 50,000 lines, 10 a day per admin (counted from admin_audit, so a restart forgets nothing).
// Nothing here logs a line, a login or a name.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { getQuery, tx } = require("./dbUtils");

const DAYS_MAX = 31, LINES_MAX = 50000, PER_DAY = 10, PAGE = 1000;
const TOKEN_TTL_MS = 2 * 60e3;
const DAY = 864e5;
const FMTS = { txt: { ext: "txt", type: "text/plain; charset=utf-8" }, jsonl: { ext: "jsonl", type: "application/x-ndjson; charset=utf-8" } };
const KIND = { msg: "chat", tx: "mic", join: "join", leave: "leave", mic: "mic_grab", unmic: "mic_drop", topic: "topic" };
let clock = () => Date.now();
const now = () => clock();
const TOKENS = new Map();                 // token -> {userId, username, roomId, slug, pad, from, to, fmt, reason, cut, exp}
const limits = { linesMax: LINES_MAX, perDay: PER_DAY };
class Refuse extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; this.refuse = true; } }
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const iso = (ms) => new Date(Number(ms)).toISOString();

/** "from" / "to" -> ms (UTC). Accepts ms, ISO-8601 and YYYY-MM-DD[THH:MM]. */
function parseWhen(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d{10,14}$/.test(String(v))) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s);
  if (m) { const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)); return Number.isFinite(t) ? t : null; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** The pad: {roomId, slug, pad} from a pad address, a slug or a room id (the live rooms first, then the archive's). */
async function padOf(ref, bySlug) {
  const s = clean(ref, 120).replace(/^.*\/p\//, "").replace(/[/?#].*$/, "");
  if (!s) return null;
  let R = null;
  try { R = bySlug ? bySlug(s.toLowerCase()) : null; } catch (e) { R = null; }
  if (!R) { try { R = require("./bridge")._rooms.get(s) || null; } catch (e) { R = null; } }
  if (R) return { roomId: R.id, slug: R.slug || null, pad: R.name || R.title || R.slug || R.id, R };
  const r = (await getQuery("SELECT room_id FROM chatlog_rooms WHERE room_id = ?", [s]).catch(() => []))[0];
  return r ? { roomId: r.room_id, slug: null, pad: r.room_id, R: null } : null;
}

/** One line as the file shows it. who = {login, display} (null for Pepe's own topic lines), veil = {kind, alias} | null. */
function lineOf({ ts, k, who, veil, text, words, unrevealable }) {
  const o = { ts: Number(ts), kind: KIND[k] || String(k), login: who && who.login ? String(who.login) : null, display: who && who.display ? String(who.display) : null };
  if (veil) { o.veil = veil.kind; if (veil.alias) o.alias = veil.alias; }
  if (unrevealable) o.unrevealable = true;
  if (veil && veil.kind === "hidden") { if (typeof words === "string") o.text = words; else o.masked = true; }
  else if (text != null) o.text = String(text);
  return o;
}

/** Collect the range's lines (<= linesMax) -> {lines, left: {removed, privacy, unrevealable}, source, truncated, next} */
async function collect(pad, from, to) {
  const CV = require("./chatlogview");
  const out = { lines: [], left: { removed: 0, privacy: 0, unrevealable: 0 }, source: "archive", truncated: false, next: null };
  let rk = null;
  try { const r = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [pad.roomId]))[0]; rk = r ? Number(r.rk) : null; } catch (e) { rk = null; }
  let any = false;
  if (rk != null) {
    try { any = (await getQuery("SELECT 1 FROM chat_log WHERE rk = ? AND ts >= ? AND ts < ? LIMIT 1", [rk, from, to])).length > 0; } catch (e) { any = false; }
  }
  if (any) {
    let pos = 0;
    for (;;) {
      const rows = await getQuery(`SELECT l.c, l.ts, l.k, l.who, l.text, l.d, l.tx, l.aud, l.rm_at, l.rm_by, l.rm_why, l.purged, v.login AS v_login,
                                   v.display AS v_display, v.kind AS v_kind, v.words AS v_words
                                   FROM chat_log l LEFT JOIN chat_log_veil v ON v.c = l.c
                                   WHERE l.rk = ? AND l.ts >= ? AND l.ts < ? AND l.c > ? ORDER BY l.c LIMIT ?`, [rk, from, to, pos, PAGE]);
      if (!rows.length) break;
      pos = Number(rows[rows.length - 1].c);
      for (const r of rows) {
        if (r.purged || r.rm_at != null) { out.left.removed++; continue; }
        const it = CV.itemOf(r);
        if (CV.privacyOf(it) === "out") { out.left.privacy++; continue; }
        if (out.lines.length >= limits.linesMax) { out.truncated = true; out.next = Number(r.ts); return out; }
        const vk = it.u && it.u.veil ? String(it.u.veil) : null;
        if (r.v_login) {
          out.lines.push(lineOf({ ts: r.ts, k: r.k, who: { login: r.v_login, display: r.v_display }, veil: { kind: r.v_kind, alias: it.u && it.u.alias },
                                  text: it.text, words: r.v_words == null ? null : String(r.v_words) }));
        } else if (vk || (it.u && it.u.anon) || it.ah) {
          out.left.unrevealable++;
          out.lines.push(lineOf({ ts: r.ts, k: r.k, who: { login: null, display: (it.u && (it.u.alias || it.u.display)) || "someone" }, veil: { kind: vk || "incognito", alias: it.u && it.u.alias },
                                  text: it.text, unrevealable: true }));
        } else {
          out.lines.push(lineOf({ ts: r.ts, k: r.k, who: it.u ? { login: it.u.login || null, display: it.u.display || it.u.login || null } : null, veil: null, text: it.text }));
        }
      }
      if (rows.length < PAGE) break;
      await new Promise((res) => setImmediate(res));
    }
    return out;
  }
  // the live ring (no archive for this pad, or none in the range): the items' own identities (bridge_veil), revealLookup's rules
  out.source = "live";
  const R = pad.R || (() => { try { return require("./bridge")._rooms.get(pad.roomId) || null; } catch (e) { return null; } })();
  const feed = R && Array.isArray(R.feed) ? R.feed.filter((it) => it && Number(it.ts) >= from && Number(it.ts) < to).sort((a, b) => Number(a.c) - Number(b.c)) : [];
  const ids = new Set();
  if (feed.some((it) => it._vz)) {
    const cs = feed.filter((it) => it._vz).map((it) => Number(it.c));
    for (let i = 0; i < cs.length; i += 400) {
      const part = cs.slice(i, i + 400);
      for (const r of await getQuery(`SELECT c FROM bridge_veil WHERE c IN (${part.map(() => "?").join(",")})`, part).catch(() => [])) ids.add(Number(r.c));
    }
  }
  for (const it of feed) {
    if (it.rm_at != null || it.purged) { out.left.removed++; continue; }
    if (!KIND[it.k]) continue;                                           // (live notices, Pepe's notes: not chat)
    if (CV.privacyOf(it) === "out") { out.left.privacy++; continue; }
    if (out.lines.length >= limits.linesMax) { out.truncated = true; out.next = Number(it.ts); break; }
    if (it._vz && ids.has(Number(it.c))) {
      out.lines.push(lineOf({ ts: it.ts, k: it.k, who: { login: it._vz.login, display: it._vz.display }, veil: { kind: it._vz.kind, alias: it.u && it.u.alias },
                              text: it.text, words: typeof it._vw === "string" ? it._vw : null }));
    } else if (it.u && (it.u.anon || it.u.veil)) {
      out.left.unrevealable++;
      out.lines.push(lineOf({ ts: it.ts, k: it.k, who: { login: null, display: it.u.alias || it.u.display || "someone" }, veil: { kind: it.u.veil || "incognito", alias: it.u.alias },
                              text: it.text, unrevealable: true }));
    } else {
      out.lines.push(lineOf({ ts: it.ts, k: it.k, who: it.u ? { login: it.u.login || null, display: it.u.display || it.u.login || null } : null, veil: null, text: it.text }));
    }
  }
  return out;
}

const SYS = { join: "joined", leave: "left", mic_grab: "grabbed the mic", mic_drop: "dropped the mic" };
function txtLine(o) {
  const t = iso(o.ts).slice(0, 19).replace("T", " ");
  const who = o.login ? o.login + (o.display && o.display !== o.login ? ` (${o.display})` : "") : (o.display || "someone");
  const tag = o.veil ? ` [${o.veil}${o.alias ? " as " + o.alias : ""}${o.unrevealable ? ", can't be revealed" : ""}]` : "";
  if (o.kind === "topic") return `[${t}] topic: ${o.text || ""}`;
  if (SYS[o.kind]) return `[${t}] ${who}${tag} ${SYS[o.kind]}`;
  const body = o.masked ? "[hidden]" : (o.text || "");
  return `[${t}] ${o.kind === "mic" ? "🎙 " : ""}${who}${tag}: ${body}`;
}

/** The file's text (it is small enough for memory: <= 50,000 lines). */
function render(fmt, meta, got) {
  const wm = meta.watermark;
  if (fmt === "jsonl") {
    const head = { format: "patv-evidence/1", watermark: wm, by: meta.by, at: iso(meta.at), pad: meta.pad, room: meta.roomId, from: iso(meta.from), to: iso(meta.to),
                   source: got.source, lines: got.lines.length, left_out: got.left, truncated: got.truncated, ...(got.next ? { next: iso(got.next) } : {}),
                   ...(meta.cut ? { cut_next: iso(meta.cut) } : {}), reason: meta.reason };
    return [JSON.stringify(head), ...got.lines.map((o) => JSON.stringify(Object.assign({}, o, { ts: iso(o.ts) }))), JSON.stringify({ footer: wm })].join("\n") + "\n";
  }
  const out = [wm,
    "PATV evidence export - real names behind frog names and hidden people's words. For moderation and legal use only; do not share.",
    `Pad: ${meta.pad} (${meta.roomId}) · ${iso(meta.from)} to ${iso(meta.to)} (UTC) · source: ${got.source === "live" ? "the live chat" : "the chat archive"} · reason: ${meta.reason}`,
    `Lines: ${got.lines.length} · left out: removed ${got.left.removed}, privacy ${got.left.privacy} · shown as members see them (identity gone): ${got.left.unrevealable}` +
      (got.truncated ? ` · cut at ${LINES_MAX.toLocaleString("en-US")} lines - continue from ${iso(got.next)}` : "") + (meta.cut ? ` · range cut at ${DAYS_MAX} days - continue from ${iso(meta.cut)}` : ""),
    "Names of veiled people inside other people's lines stay \"someone\".",
    "----"];
  for (const o of got.lines) out.push(txtLine(o));
  out.push("----", wm);
  return out.join("\n") + "\n";
}

function register(app, { addUser, bySlug }) {
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "4kb" });
  const may = async (user) => { if (!user || !user.userId) return false; try { return !!(await SP.canId(user.userId, "chatlog.see_through")); } catch (e) { return false; } };
  const priv = (res) => { res.set("Cache-Control", "private, no-store"); res.set("Referrer-Policy", "no-referrer"); res.set("X-Robots-Tag", "noindex"); res.set("X-Content-Type-Options", "nosniff"); };
  setInterval(() => { const t = now(); for (const [k, v] of TOKENS) if (v.exp < t) TOKENS.delete(k); }, 60e3).unref();

  app.post("/api/admin/evidence-export", addUser, json, async (req, res) => {
    priv(res);
    try {
      if (!req.is("application/json") || !guard.sameOriginFetch(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
      if (!(await may(req.user))) return res.status(403).json({ ok: false, error: "Admins only." });
      const b = req.body || {};
      const fmt = FMTS[b.fmt] ? b.fmt : null;
      if (!fmt) return res.status(400).json({ ok: false, code: "fmt", error: "Pick txt or jsonl." });
      const reason = clean(b.reason, 200);
      if (reason.length < 3) return res.status(400).json({ ok: false, code: "why", error: "Give the reason (the request, the report, the case) - it's in the file and the log." });
      let from = parseWhen(b.from), to = parseWhen(b.to);
      if (from == null || to == null || !(to > from)) return res.status(400).json({ ok: false, code: "range", error: "Give a from and a to (to after from)." });
      to = Math.min(to, now() + 60e3);
      let cut = null;
      if (to - from > DAYS_MAX * DAY) { cut = from + DAYS_MAX * DAY; to = cut; }
      const pad = await padOf(b.room, bySlug);
      if (!pad) return res.status(404).json({ ok: false, code: "pad", error: "No such pad." });
      await require("./adminaudit").init();
      const n = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'evidence.export' AND admin_id = ? AND at > ?", [String(req.user.userId), now() - DAY]))[0].n;
      if (Number(n) >= limits.perDay) return res.status(429).json({ ok: false, code: "limit_day", error: `That's ${limits.perDay} evidence exports in a day - try again tomorrow.` });
      const tok = crypto.randomBytes(24).toString("base64url");
      TOKENS.set(tok, { userId: String(req.user.userId), username: req.user.username || null, roomId: pad.roomId, slug: pad.slug, pad: pad.pad, from, to, fmt, reason, cut,
                        exp: now() + TOKEN_TTL_MS });
      res.json({ ok: true, url: "/admin/evidence-export/dl/" + tok, from, to, ...(cut ? { cut } : {}) });
    } catch (e) {
      console.error(`[evidenceexport] request failed (${String((e && (e.code || e.name)) || "error").replace(/[^\w.]/g, "").slice(0, 40)})`);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });

  app.get("/admin/evidence-export/dl/:token", addUser, async (req, res) => {
    priv(res);
    try {
      const tok = String(req.params.token || "");
      const T = TOKENS.get(tok);
      if (T) TOKENS.delete(tok);                                          // single use, whatever happens next
      if (!T || T.exp < now() || !req.user || String(req.user.userId) !== T.userId) return res.status(404).type("text/plain").send("That download link has expired or was already used.");
      if (!(await may(req.user))) return res.status(403).type("text/plain").send("Admins only.");
      const got = await collect({ roomId: T.roomId, slug: T.slug, pad: T.pad, R: null }, T.from, T.to);
      const at = now();
      const id = crypto.randomBytes(6).toString("hex");
      const meta = { watermark: `Evidence export by ${T.username || T.userId}, ${iso(at)}, ${T.pad}`, by: T.username || T.userId, at, pad: T.pad, roomId: T.roomId,
                     from: T.from, to: T.to, reason: T.reason, cut: T.cut };
      // the log BEFORE the first byte: every login in the file, the revealed (veiled) ones first so the 200-login cap never drops them
      const veiled = [], named = [];
      for (const o of got.lines) if (o.login) (o.veil ? veiled : named).push(o.login.toLowerCase());
      const logins = [...new Set([...veiled, ...named])];
      const ST = require("./seethrough"), AA = require("./adminaudit");
      await ST.init(); await AA.init();
      await tx(async () => {
        const st = await ST.log({ userId: T.userId, role: "admin", scope: "export_evidence", roomId: T.roomId, logins, reason: T.reason, ref: "exp:" + id });
        if (!st) throw new Error("evidence export: no see-through row");
        await AA.record({ userId: T.userId, username: T.username }, "evidence.export", null,
                        { id, room: T.roomId, from: T.from, to: T.to, fmt: T.fmt, lines: got.lines.length, revealed: new Set(veiled).size, source: got.source, st }, T.reason);
      });
      const body = render(T.fmt, meta, got);
      const F = FMTS[T.fmt];
      const d8 = (ms) => iso(ms).slice(0, 10).replace(/-/g, "");
      const name = `patv-evidence-${String(T.slug || T.roomId).replace(/[^\w.-]/g, "_").slice(0, 40)}-${d8(T.from)}-${d8(T.to)}.${F.ext}`;
      res.set("Content-Type", F.type);
      res.set("Content-Disposition", `attachment; filename="${name}"`);
      res.send(body);
      console.log(`[evidenceexport] export ${id} sent (${got.lines.length} lines, ${got.source})`);
    } catch (e) {
      console.error(`[evidenceexport] download failed (${String((e && (e.code || e.name)) || "error").replace(/[^\w.]/g, "").slice(0, 40)})`);
      if (!res.headersSent) res.status(500).type("text/plain").send("Something went wrong - nothing was sent.");
    }
  });
}

module.exports = { register, collect, render, parseWhen, padOf, txtLine, DAYS_MAX, LINES_MAX, PER_DAY, _tokens: TOKENS, _limits: limits,
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
