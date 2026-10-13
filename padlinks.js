// padlinks.js — which pad a prediction market, betting pool or poll belongs to.
//
// Pads are the product; a Camfrog room is one connected service. Every market / pool (the `markets` table, M ids) and every
// poll (the `polls` table) carries its pad in a `pad` COLUMN next to the JSON row. The column is the site's link:
//   * written when the row is first stored, from the record: its `pad` (picked on the website's create forms, or a chat
//     create's room - Pepe sends the room id, which IS the pad id of a Camfrog pad), else its `room` mapped to a pad
//     (resolve() below: the registry id, a pad's slug / old slug, or a pad's exact title - the bad rows hold display names
//     like "PepeLab");
//   * never overwritten by a later mirror write (ON CONFLICT ... pad = COALESCE(pad, excluded.pad)): the engines (Pepe's
//     snapshot, capital/markets.js, escrow/pools.js) rewrite the JSON on every trade and know nothing about re-keys;
//   * moved by padrekey.js when a pad changes id (any column named `pad` moves with the pad), so a site pad that connects
//     its Camfrog room keeps its markets.
// NULL = site-wide (no pad). tools/backfill-market-pads.js fills / fixes the column for old rows (dry run by default).
"use strict";
const rooms = require("./rooms");

const str = (v) => String(v == null ? "" : v).trim();

async function ready() { await rooms.init(); }

/** A pad's registry view by id, slug or old slug (cached; call ready() first). Profile pads count too. */
function lookup(word) {
  const s = str(word);
  if (!s) return null;
  const byId = rooms.getCached(s);
  if (byId) return byId;
  const low = s.toLowerCase();
  const all = rooms.listCached();
  const ci = all.filter((p) => String(p.id).toLowerCase() === low);
  if (ci.length === 1) return ci[0];
  const bySlug = rooms.bySlugCached(low) || rooms.bySlugCached(rooms.slugify(s));
  if (bySlug && (bySlug.slug === low || bySlug.slug === rooms.slugify(s) || String(bySlug.id).toLowerCase() === low)) return bySlug;
  return null;
}

/** A display name (a pad's title) -> that pad, only when exactly one pad has it. */
function byTitle(word) {
  const low = str(word).toLowerCase();
  if (!low) return null;
  const hits = rooms.listCached().filter((p) => String(p.title || "").toLowerCase() === low);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The pad id a record belongs to, or null (site-wide). Order: its explicit `pad`, then its `room` (id / slug / unique title).
 * -> {pad, how} where how = "pad" | "room" | "room-slug" | "room-title" | null
 */
function resolveHow(rec) {
  if (!rec || typeof rec !== "object") return { pad: null, how: null };
  const p = lookup(rec.pad);
  if (p) return { pad: p.id, how: "pad" };
  const room = str(rec.room);
  if (!room) return { pad: null, how: null };
  const direct = rooms.getCached(room);
  if (direct) return { pad: direct.id, how: "room" };
  const l = lookup(room);
  if (l) return { pad: l.id, how: "room-slug" };
  const t = byTitle(room);
  if (t) return { pad: t.id, how: "room-title" };
  return { pad: null, how: null };
}
const resolve = (rec) => resolveHow(rec).pad;

/** What a card / page shows for a pad id: {id, slug, title, url} or null (site-wide / a pad that's gone). */
function view(padId) {
  const p = padId ? rooms.getCached(String(padId)) : null;
  if (!p) return null;
  const title = p.profile && p.profile.username ? "u/" + p.profile.username : p.title;
  return { id: p.id, slug: p.slug, title, url: p.profile && p.profile.username ? "/u/" + encodeURIComponent(p.profile.username) : "/p/" + encodeURIComponent(p.slug) };
}

/** A ?pad= value (slug, old slug or id) -> the pad's id, "" for site-wide ("none"/"site"), null for no filter / unknown. */
function fromParam(v) {
  const s = str(v).toLowerCase();
  if (!s || s === "all") return null;
  if (s === "none" || s === "site" || s === "sitewide") return "";
  const p = lookup(v);
  return p ? p.id : null;
}

/**
 * The pads a user can pick on a create form, and the default:
 *   wanted (a ?pad= from the pad page's "Create" button) when they may see it -> their own pad -> site-wide ("").
 * -> {choices: [{id, title, mine}], def: padId | ""}
 */
async function choicesFor(user, wanted) {
  await ready();
  let access = null;
  try { access = require("./padaccess"); await access.init(); } catch (e) { access = access || null; }
  const u = user && user.userId ? user : null;
  const visible = (p) => !access || !access.canSee || access.canSee(u, p.id);
  const all = rooms.listCached().filter(visible);
  const mineIds = new Set();
  if (u) {
    for (const p of all) if (p.owner && String(p.owner.userId) === String(u.userId)) mineIds.add(p.id);
  }
  const choices = all.map((p) => ({ id: p.id, title: p.title, slug: p.slug, mine: mineIds.has(p.id) }))
    .sort((a, b) => (b.mine - a.mine) || String(a.title).localeCompare(String(b.title)));
  let def = "";
  const w = wanted ? lookup(wanted) : null;
  if (w && (visible(w) || (u && w.owner && String(w.owner.userId) === String(u.userId)))) {
    def = w.id;
    if (!choices.some((c) => c.id === w.id)) choices.unshift({ id: w.id, title: w.title, slug: w.slug, mine: mineIds.has(w.id) });
  } else if (mineIds.size) def = [...mineIds][0];
  return { choices, def };
}

/** A form's pad value -> a pad id the user may use, "" (site-wide), or null when it names a pad they can't use. */
async function checkPick(user, v) {
  const s = str(v);
  if (!s) return "";
  await ready();
  const p = lookup(s);
  if (!p) return null;
  let access = null;
  try { access = require("./padaccess"); await access.init(); } catch (e) { access = access || null; }
  const u = user && user.userId ? user : null;
  if (access && access.canSee && !access.canSee(u, p.id)) return null;
  return p.id;
}

module.exports = { ready, resolve, resolveHow, view, fromParam, choicesFor, checkPick, lookup };
