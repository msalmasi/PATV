// pepelabels.js — 1.99wq: Pepe flairs and tags his own posts, in ANY pad, by that pad's rules.
//
// For a post of his (pepefeed.post, automkt.announce) in pad P:
//   FLAIR  only one of P's own post flairs (padflair.js), never one he makes up:
//          1. the deterministic pick for the post's KIND (KIND_FLAIR: names / emoji a pad tends to use - "📰 News" for news,
//             "Recap" for a recap ...), else
//          2. Pepe's own choice (the bot's model picks from the list it was given) - kept only when it IS one of P's flairs, else
//          3. nothing - unless P requires a flair: then a general one (GENERAL) or the first he may use.
//          A "mods only" flair only where he may use it (a house pad: he is the house - padflair.mayModFlair). With none he may
//          use in a pad that requires one, he gets none and the post is refused (feedstore.create) - never a rule broken.
//   TAGS   only P's vocabulary: its own tags (feedtags.padTags) + its conventions (tags used on 2+ live posts there lately).
//          A pad that uses no tags gets none. From that vocabulary: the kind's tags (KIND_TAGS), Pepe's own picks, then tags
//          whose words appear in the post - at most MAX_PEPE_TAGS.
// The pad owner's "Pepe on your pad's page" switch `labels` (padsite.js, default on) turns his OPTIONAL labels off; a flair
// the pad requires is still put on (a post without it would break the pad's rule).
"use strict";

const MAX_PEPE_TAGS = 3;
const KIND_FLAIR = Object.freeze({
  news: { names: ["news", "headlines", "current events", "world news", "in the news"], emoji: ["📰", "🗞️", "🗞"] },
  recap: { names: ["recap", "daily recap", "recaps", "highlights", "room recap", "summary"], emoji: ["📊", "📝", "🗒️"] },
  question: { names: ["question", "questions", "discussion", "ask", "q&a", "debate", "poll"], emoji: ["❓", "💬", "🤔"] },
  dj: { names: ["music", "dj", "now playing", "tunes", "songs", "playlist"], emoji: ["🎵", "🎶", "🎧"] },
  snaps: { names: ["snaps", "clips", "captures", "stage", "media", "pics"], emoji: ["📸", "🎬", "📷"] },
  markets: { names: ["markets", "market", "predictions", "prediction markets", "bets", "polls"], emoji: ["🔮", "📈"] },
  golive: { names: ["stage", "live", "streams", "going live"], emoji: ["🎬", "🔴", "📺"] },
});
// a pad that requires a flair and has nothing for this kind: one of these (Pepe's own first), else the first usable one
const GENERAL = ["pepe says", "pepe", "discussion", "general", "chat", "misc", "other", "announcement", "announcements"];
const KIND_TAGS = Object.freeze({
  news: ["news", "headlines"], recap: ["recap", "daily-recap", "highlights"], question: ["question", "discussion"],
  dj: ["music", "dj"], snaps: ["snaps", "clips", "stage"], markets: ["markets", "predictions", "polls"], golive: ["stage", "live"],
});
const STOP = new Set("the a an and or of to in on for with at by from is are was were be it this that its as about into over after new just not no".split(" "));

const PF = () => require("./padflair");
const TG = () => require("./feedtags");
const bare = (x) => String(x || "").normalize("NFKC").replace(/\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The deterministic flair for a post kind among `flairs` (exact name, then a name that starts with / contains a word, then the emoji). */
function kindFlair(kind, flairs) {
  const K = KIND_FLAIR[kind];
  if (!K || !flairs || !flairs.length) return null;
  for (const n of K.names) { const f = flairs.find((x) => bare(x.name) === n); if (f) return f; }
  for (const n of K.names) {
    const f = flairs.find((x) => { const b = bare(x.name); return b.split(/[^\p{L}\p{N}&]+/u).includes(n) || (n.includes(" ") && b.includes(n)); });
    if (f) return f;
  }
  for (const e of K.emoji) { const f = flairs.find((x) => x.emoji && x.emoji.replace(/️/g, "") === e.replace(/️/g, "")); if (f) return f; }
  return null;
}
function generalFlair(flairs) {
  for (const n of GENERAL) { const f = flairs.find((x) => bare(x.name) === n); if (f) return f; }
  return flairs[0] || null;
}
const words = (s) => new Set(String(s || "").toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));

/** What Pepe may use in this pad: {flairs (usable), required, tags (vocabulary), own (the pad's own tags)}. */
async function forPad(roomId, { actor = { userId: "pepe-bot" } } = {}) {
  const out = { flairs: [], required: false, tags: [], own: [] };
  if (!roomId) return out;
  try {
    const R = await PF().postRules(roomId);
    const mod = await PF().mayModFlair(actor, roomId);
    out.required = R.required;
    out.flairs = R.flairs.filter((f) => mod || !f.mod_only);
    out.allFlairs = R.flairs;
  } catch (e) { /* no flair */ }
  try {
    out.own = await TG().padTags(roomId);
    const pop = (await TG().popular(roomId, { limit: 15 })).filter((r) => r.n >= 2).map((r) => r.tag);
    out.tags = [...out.own, ...pop.filter((t) => !out.own.includes(t))].slice(0, 20);
  } catch (e) { /* no tags */ }
  return out;
}
/** The labels-on switch for Pepe's optional flair / tags in this pad (padsite `labels`, stored in his scope settings). */
async function labelsOn(roomId) {
  try { const S = await require("./pepefeed").scopeSettings(roomId); return S.labels !== false; } catch (e) { return true; }
}

/**
 * Pick his labels. o: {roomId, kind, flair (his choice: id / name), tags (his choices), title, body}
 * -> {flair: flair|null, tags: [..], required, why}
 */
async function pick(o = {}) {
  const P = o.pad || (await forPad(o.roomId));
  const on = o.labelsOn != null ? o.labelsOn : await labelsOn(o.roomId);
  let flair = null, why = "none";
  if (P.flairs.length && (on || P.required)) {
    const k = kindFlair(o.kind, P.flairs);
    if (k) { flair = k; why = "kind"; }
    else if (o.flair != null && o.flair !== "") {
      const f = PF().findPostFlair(P.flairs, o.flair);
      if (f) { flair = f; why = "pepe"; }
    }
    if (!flair && P.required) { flair = generalFlair(P.flairs); why = flair ? "required" : "none"; }
  }
  const tags = [];
  if (on && P.tags.length) {
    const vocab = new Set(P.tags);
    const add = (t) => { const n = TG().normTag(t); if (n && vocab.has(n) && !tags.includes(n) && tags.length < MAX_PEPE_TAGS) tags.push(n); };
    for (const t of KIND_TAGS[o.kind] || []) add(t);
    for (const t of Array.isArray(o.tags) ? o.tags.slice(0, 10) : String(o.tags || "").split(/[,#\s]+/)) add(t);
    const w = words(`${o.title || ""} ${o.body || ""}`);
    for (const t of P.tags) if (t.split("-").every((x) => w.has(x))) add(t);
  }
  return { flair, tags, required: P.required, why };
}

module.exports = { pick, forPad, kindFlair, generalFlair, labelsOn, KIND_FLAIR, KIND_TAGS, GENERAL, MAX_PEPE_TAGS };
