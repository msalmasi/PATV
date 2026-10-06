// profilelayout.js — per-user profile layout (2.00): the order of the profile's sections and which
// ones visitors see. Edited on /u/:username/profile/edit, honoured by /u/:username/profile.
//
// Stored per user in profile_layout (user_id -> JSON {order: [...], hidden: [...]}). Everything is
// validated against SECTIONS / SUBS below: unknown ids are dropped, missing ones are appended in the
// default order (so a section added later shows up for everyone), duplicates are ignored.
//
// Rules:
//   * the hero card always comes first and can't be hidden
//   * plain sections / panels are Public or Hidden
//   * privacy panels (PRIV below: top words, moderated against, the itemised mod-action list,
//     moderation & admin commands) have three states (1.99h):
//       public  - everyone sees it (the DEFAULT, like everything else)
//       private - only the owner and site admins ("Only you & admins can see this")
//       hidden  - nobody but the owner/admins, and they only see it greyed ("Hidden from visitors")
//     Stored as {priv: [...ids set to private]} next to hidden; an id missing from both is public, so
//     layouts saved before 1.99h (no priv list, these ids never in hidden) come out all-public, and
//     anything they hid stays hidden.
//   * the server only puts a panel's data in the page when the viewer may see it (userstats.forProfile
//     takes view().show) - the template never gets data it would have to hide
//   * the owner (and site admins) still see hidden sections, greyed out with a "Hidden from visitors"
//     tag; the owner can preview the page as a visitor (?preview=visitor)
const { runQuery, getQuery } = require("./dbUtils");

const SECTIONS = [
  { id: "stats", label: "Stat tiles", desc: "PAT balance, level and badge count", icon: "📊" },
  { id: "level", label: "Level & XP bar", desc: "Progress to the next level", icon: "⭐" },
  { id: "avatar", label: "GTF avatar", desc: "Your Grand Theft Frogger avatar and what it's wearing", icon: "🐸" },
  { id: "analytics", label: "Analytics", desc: "Camfrog chat, mic and command activity", icon: "📈" },
  { id: "gtf", label: "Grand Theft Frogger", desc: "Heist sheet and GTF links", icon: "🥷" },
  { id: "badges", label: "Badges", desc: "Every badge you've earned", icon: "🏅" },
  { id: "posts", label: "Posts", desc: "Your latest feed posts (1.99bz)", icon: "📝" },
];
// Panels inside a section that can be hidden on their own (not reordered).
const SUBS = {
  stats: [
    { id: "stats_balance", label: "PAT balance tile" },
  ],
  analytics: [
    { id: "an_tiles", label: "Summary tiles" },
    { id: "an_chat", label: "Messages per day chart" },
    { id: "an_mic", label: "Mic time per day chart" },
    { id: "an_hours", label: "Time of day" },
    { id: "an_rooms", label: "Rooms" },
    { id: "an_cmds", label: "Commands" },
    { id: "an_mod", label: "Mod actions taken" },
  ],
};
// Privacy panels (all inside Analytics): Public / Only me & admins / Hidden.
const PRIV = [
  { id: "an_words", label: "Top words", icon: "💬", desc: "Your most-used words in chat (never recorded while you're !incognito)" },
  { id: "an_modon", label: "Moderated against", icon: "🛡", desc: "Shows kicks, bans, mutes and strikes others did to you" },
  { id: "an_modlist", label: "Mod actions taken — itemised", icon: "📋", desc: "Each kick, ban or topic change you made, with who and where (the totals are always shown)" },
  { id: "an_modcmds", label: "Moderation & admin commands", icon: "🔨", desc: "Your moderation and admin commands in the Commands panel" },
];
const STATES = ["public", "private", "hidden"];
const SECTION_IDS = SECTIONS.map((s) => s.id);
const SUB_IDS = Object.values(SUBS).flat().map((s) => s.id);
const PRIV_IDS = PRIV.map((p) => p.id);
const ALL_IDS = new Set([...SECTION_IDS, ...SUB_IDS, ...PRIV_IDS]);
const DEFAULT = Object.freeze({ order: SECTION_IDS.slice(), hidden: [], priv: [] });

const ready = runQuery(`CREATE TABLE IF NOT EXISTS profile_layout (
  user_id TEXT PRIMARY KEY, layout TEXT NOT NULL, updated INTEGER)`).catch((e) => console.error("[profilelayout] init:", e));

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => String(x).slice(0, 32));

/** Any input -> a valid {order, hidden, priv}. Unknown ids are dropped; hidden beats private. */
function sanitize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const order = [];
  for (const id of list(r.order).slice(0, 50)) if (SECTION_IDS.includes(id) && !order.includes(id)) order.push(id);
  for (const id of SECTION_IDS) if (!order.includes(id)) order.push(id);
  const hidden = [];
  for (const id of list(r.hidden).slice(0, 50)) if (ALL_IDS.has(id) && !hidden.includes(id)) hidden.push(id);
  const priv = [];
  for (const id of list(r.priv).slice(0, 50)) if (PRIV_IDS.includes(id) && !hidden.includes(id) && !priv.includes(id)) priv.push(id);
  return { order, hidden, priv };
}

/** "public" | "private" | "hidden" for any id (plain ids are never private). */
function stateOf(layout, id) {
  const l = layout || DEFAULT;
  if ((l.hidden || []).includes(id)) return "hidden";
  if ((l.priv || []).includes(id)) return "private";
  return "public";
}

/**
 * A form post -> {order, hidden, priv}: order[] in DOM order, show[] checkboxes for the plain
 * sections/panels, and one vis_<id> radio (public|private|hidden) per privacy panel.
 * Throws (code BAD_STATE) on a state that isn't one of the three, so nothing is saved; a privacy panel
 * missing from the post is treated like an unticked checkbox: hidden (fails closed).
 */
function fromForm(body) {
  const b = body || {};
  const shown = new Set(list(b.show));
  const hidden = [...SECTION_IDS, ...SUB_IDS].filter((id) => !shown.has(id));
  const priv = [];
  for (const id of PRIV_IDS) {
    const raw = b["vis_" + id];
    const st = raw == null || raw === "" ? "hidden" : String(Array.isArray(raw) ? raw[raw.length - 1] : raw);
    if (!STATES.includes(st)) { const e = new Error("bad visibility state"); e.code = "BAD_STATE"; throw e; }
    if (st === "hidden") hidden.push(id);
    else if (st === "private") priv.push(id);
  }
  return sanitize({ order: list(b.order), hidden, priv });
}

async function get(userId) {
  if (!userId) return sanitize(DEFAULT);
  await ready;
  const row = (await getQuery("SELECT layout FROM profile_layout WHERE user_id = ?", [String(userId)]))[0];
  if (!row) return sanitize(DEFAULT);
  try { return sanitize(JSON.parse(row.layout)); } catch (e) { return sanitize(DEFAULT); }
}

async function save(userId, layout) {
  await ready;
  const clean = sanitize(layout);
  await runQuery(`INSERT INTO profile_layout (user_id, layout, updated) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout, updated = excluded.updated`,
    [String(userId), JSON.stringify(clean), Date.now()]);
  return clean;
}

async function reset(userId) {
  await ready;
  await runQuery("DELETE FROM profile_layout WHERE user_id = ?", [String(userId)]);
}

/**
 * What the profile template needs. viewer: { owner, admin, preview } — preview = the owner looking at
 * their page as a visitor would.
 *   order        section ids, in order (hero excluded)
 *   show(id)     render this section / panel at all? (also decides whether its data is loaded)
 *   hidden(id)   is it hidden from visitors? (rendered greyed for the owner/admins)
 *   priv(id)     is it "only me & admins"? (rendered with a lock tag for the owner/admins)
 */
function view(layout, viewer) {
  const l = sanitize(layout);
  const hid = new Set(l.hidden);
  const prv = new Set(l.priv);
  const v = viewer || {};
  const seesHidden = !v.preview && !!(v.owner || v.admin);
  return {
    order: l.order,
    hidden: (id) => hid.has(id),
    priv: (id) => prv.has(id),
    show: (id) => (!hid.has(id) && !prv.has(id)) || seesHidden,
    seesHidden,
    owner: !v.preview && !!v.owner,
    anyHidden: l.hidden.length > 0,
  };
}

function sameSite(req) {
  // same as cosmetics.js: the login cookie is SameSite=Lax; this is a second check when the browser
  // sends Origin/Referer
  const host = req.get("host");
  const src = req.get("origin") || req.get("referer");
  if (!src || !host) return true;
  try { return new URL(src).host === host; } catch (e) { return false; }
}

function register(app, { addUser }) {
  app.post("/api/u/:username/update/layout", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    const back = `/u/${encodeURIComponent(req.user.username)}/profile/edit#layout`;
    if (req.user.username !== req.params.username) return res.redirect(back);
    if (!sameSite(req)) return res.status(403).send("Forbidden");
    try {
      if (String((req.body || {}).reset || "") === "1") {
        await reset(req.user.userId);
        req.flash("success", "Profile layout reset to the default.");
      } else {
        await save(req.user.userId, fromForm(req.body));
        req.flash("success", "Profile layout saved.");
      }
    } catch (e) {
      if (!e || e.code !== "BAD_STATE") console.error("[profilelayout] save:", e);
      req.flash("error", "Couldn't save the layout — nothing changed.");
    }
    res.redirect(back);
  });
}

module.exports = { SECTIONS, SUBS, PRIV, STATES, SECTION_IDS, SUB_IDS, PRIV_IDS, DEFAULT, sanitize, stateOf, fromForm, get, save, reset, view, register };
