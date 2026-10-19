// notices.js (1.99ade) - the one-line notice a page shows after a form post ("Sent to Pepe ...", "Saved", an engine's reply).
//
// It used to travel in the address as ?msg=<free text>, and every page printed whatever was there in the site's own notice
// style - so anyone could link a real publicaccess.tv page (/wallet, a market, the shop) saying anything they liked
// ("Your account is suspended - verify at ..."). Escaped, so never markup, but a convincing spoof. Now ?msg= is ignored
// everywhere, and the address carries only ?m=n-<20 hex>: a HELD notice, kept here in memory for the ACCOUNT whose form made
// it, for HELD_MS. It is either
//   * a catalog key, K("act_sent") -> the i18n string notice.<key> (locales/en.json), translated when it is shown, or
//   * an engine's reply (text with names and amounts).
// Anyone else - signed out, another account, a link shared after the fact - sees nothing. 1.99ade: catalog notices are
// held too: as ?m=<key> in the address, fixed but alarming site text ("You're banned from the casino, so no betting.") could
// be linked on any page that shows notices, out of context. Every notice comes from a signed-in form post (each producer
// sends signed-out visitors to /login first), so nothing is lost; with no account, href() adds no notice. A restart forgets
// them, which costs at most a notice nobody needs any more.
// Producers: href(req, path, msg) builds the address to go back to - msg = K("key") for catalog text, else the text.
// Readers: read(req) -> the notice's plain text, or null (views print it escaped, as before).
"use strict";
const crypto = require("crypto");
const EN = require("./locales/en.json");

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const HELD_RE = /^n-[0-9a-f]{20}$/;
const HELD_MS = 15 * 60e3;
const HELD_MAX = 5000;
const TEXT_MAX = 300;
const held = new Map();          // id -> {uid, key | text, at}
let NOW = () => Date.now();

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Is `k` a notice in the catalog? */
const isKey = (k) => KEY_RE.test(String(k || "")) && has(EN, "notice." + k);
/** A catalog notice for href(): K("act_sent"). */
const K = (key) => Object.freeze({ notice: String(key) });

function uidOf(req) { return req && req.user && req.user.userId ? String(req.user.userId) : null; }

/** Keep a notice ({key} or {text}) for this request's account -> its id, or null (no account / nothing to keep). */
function hold(req, entry) {
  const uid = uidOf(req);
  if (!uid || !entry) return null;
  const now = NOW();
  if (held.size >= HELD_MAX) {
    for (const [k, v] of held) { if (now - v.at > HELD_MS || held.size >= HELD_MAX) held.delete(k); else break; }
  }
  const id = "n-" + crypto.randomBytes(10).toString("hex");
  held.set(id, Object.assign({ uid, at: now }, entry));
  return id;
}

/**
 * The address to send someone back to with a notice. path may carry a query and a #hash; msg = K("key") (catalog text),
 * a string (an engine's reply), or null/"" (no notice). Either is held for this request's account.
 */
function href(req, path, msg) {
  const s = String(path || "/");
  const i = s.indexOf("#");
  let p = i >= 0 ? s.slice(0, i) : s;
  const hash = i >= 0 ? s.slice(i) : "";
  // a back address that already carries a notice (the form was on a page showing one) loses it: one ?m= at a time
  const q = p.indexOf("?");
  if (q >= 0) {
    const kept = p.slice(q + 1).split("&").filter((kv) => kv && !/^(m|msg)(=|$)/.test(kv));
    p = p.slice(0, q) + (kept.length ? "?" + kept.join("&") : "");
  }
  let m = null;
  if (msg && typeof msg === "object") {
    if (isKey(msg.notice)) m = hold(req, { key: msg.notice });
    else console.error("[notices] unknown key:", msg.notice);
  } else if (msg != null && String(msg).trim()) {
    const text = String(msg).replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
    m = text ? hold(req, { text }) : null;
  }
  return m ? p + (p.includes("?") ? "&" : "?") + "m=" + m + hash : p + hash;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The catalog's HTML-safe text as plain text (the views escape it again). */
function plain(html) {
  return String(html || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return has(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : all;
  }).replace(/<[^>]*>/g, "");
}

/** A catalog notice as plain text in this request's language (English without one). */
function catalogText(req, key) {
  const t = req && typeof req.t === "function" ? req.t("notice." + key) : EN["notice." + key];
  const s = plain(t === "notice." + key ? EN["notice." + key] : t).trim();
  return s ? s.slice(0, TEXT_MAX) : null;
}

/** The notice this request's address names, as plain text, or null (only the account it was held for ever sees it). */
function read(req) {
  const m = String((req && req.query && req.query.m) || "");
  if (!HELD_RE.test(m)) return null;               // a catalog key in the address (1.99ade 1) is ignored too
  const h = held.get(m);
  if (!h) return null;
  if (NOW() - h.at > HELD_MS) { held.delete(m); return null; }
  if (uidOf(req) !== h.uid) return null;
  return h.key ? catalogText(req, h.key) : h.text;
}

/** The notice an address (a redirect's Location) carries, as the account `userId` would see it ("" = none). Tests, tools. */
function textOf(url, userId) {
  const s = String(url || "");
  const i = s.indexOf("?");
  const qs = new URLSearchParams(i >= 0 ? s.slice(i + 1).split("#")[0] : "");
  return read({ query: { m: qs.get("m") || "" }, user: userId ? { userId: String(userId) } : null }) || "";
}
/** The catalog key a held notice carries (tests: which fixed message a form answered with), or null. */
function keyOf(url) {
  const s = String(url || "");
  const i = s.indexOf("?");
  const id = new URLSearchParams(i >= 0 ? s.slice(i + 1).split("#")[0] : "").get("m") || "";
  const h = HELD_RE.test(id) ? held.get(id) : null;
  return h && h.key ? h.key : null;
}

function _setClock(fn) { NOW = fn; }
function _clear() { held.clear(); }

module.exports = { K, href, read, textOf, keyOf, isKey, plain, HELD_MS, _setClock, _clear };
