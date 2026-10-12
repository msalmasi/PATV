// padguide.js — /pads/owners: the PAD OWNERS GUIDE (1.99uj), the benefit-led page for people who run (or might run) a pad.
//
// The technical list of every owner command and switch stays at /pads/owner-guide ("Pad owner reference", padowner.js);
// the two link to each other. Everything this page says about numbers or switches is read from where it is enforced, never
// written into copy:
//   roomvaults.overview()   pad vaults on/off, the vault cap, the payout recipe's slices and rules (Pepe's last sync),
//                           whether activity top-ups reach pad vaults (recipe.activity_pads)
//   roomvaults.RATE         the payout rate bounds the owner picks from
//   funding.state.launchpad whether the pad launchpad (owner deposit matching, newcomer welcomes) is live
//   premium.config()        Prime Time / Plus prices, the period, the Plus bridge gate; premium.plusSpots() the spots left
//   padrules / mainstage    the house-rule count and the most stage slots a pad can have
//
// CONNECTED CHAT SERVICES: Pepe's command docs are per service. Adding a service is one entry in SERVICES (+ its
// owners.svc.<id>_d string): the "What you can do with Pepe" cards link every goal to each service's command guide.
"use strict";

// One entry per chat service a pad can connect to and Pepe supports today. `help` = that service's command guide,
// `cats` maps a goal to the guide's section anchor (null = the guide's top), `reference` = the owner reference.
const SERVICES = Object.freeze([
  { id: "camfrog", icon: "📹", name: "Camfrog", help: "/help", reference: "/pads/owner-guide",
    cats: { grow: "#cat-chat", fun: "#cat-games", show: "#cat-stage", safe: "#cat-moderation", vibe: "#cat-moderation", vault: "#cat-wallet" } },
]);

// The goal cards: what an owner wants, the Pepe features behind it (strings owners.goal.<id>.*) and the owner reference's
// entry for it (/pads/owner-guide#cap-<id>, padowner.js / data/owner-capabilities.json ids).
const GOALS = Object.freeze([
  { id: "grow", icon: "🌱", items: 4, cap: "room_features" },
  { id: "fun", icon: "🎲", items: 4, cap: "room_games" },
  { id: "show", icon: "🎬", items: 4, cap: "stage" },
  { id: "safe", icon: "🛡️", items: 4, cap: "room_mod" },
  { id: "vibe", icon: "🎭", items: 4, cap: "roomvibe" },
  { id: "vault", icon: "🏦", items: 4, cap: "topup_web" },
]);

const safe = async (fn, d) => { try { const v = await fn(); return v === undefined || v === null ? d : v; } catch (e) { return d; } };

/** Every live number and switch the page shows. */
async function facts() {
  const ov = await safe(() => require("./roomvaults").overview(0), {});
  const rc = (ov && ov.recipe) || {};
  const cfg = rc.cfg || {};
  const pct = (k, d) => { const v = Number(cfg[k]); return Math.round(100 * (Number.isFinite(v) && v > 0 && v <= 1 ? v : d)); };
  const rate = await safe(() => require("./roomvaults").RATE, { default: 10, min: 2, max: 15 });
  const rules = await safe(() => require("./padrules").MAX_RULES, 15);
  const P = require("./premium");
  const pc = await safe(() => P.config(), {});
  const spots = await safe(() => P.plusSpots(), { left: 0, max: 5, soldOut: false });
  const lp = await safe(() => require("./funding").state.launchpad, null);
  const stageMax = await safe(() => require("./mainstage").config().max_slots_per_room, 4);
  const gatePlatforms = Array.isArray(pc.plus_gate_platforms) ? pc.plus_gate_platforms : ["camfrog"];
  return {
    vaultLive: !!(ov && ov.live), cap: (ov && ov.cap) || 50000000,
    recipeLive: !!rc.on, activityPads: !!rc.activity_pads,
    owner: pct("owner_pct", 0.15), gang: pct("gang_pct", 0.15), streamers: pct("streamer_pct", 0.25), people: pct("people_pct", 0.35),
    games: pct("games_pct", 0.10), capPct: pct("cap_i7", 0.25), ownerDays: Number(cfg.owner_days) || 3, eligDays: Number(cfg.elig_days) || 3,
    rate,
    launchpad: !!(lp && lp.on && lp.live),
    sales: pc.sales !== false, primePrice: Number(pc.prime_price) || 0, plusPrice: Number(pc.plus_price) || 0, days: Number(pc.period_days) || 30,
    plusGate: pc.plus_bridge_gate === true && gatePlatforms.includes("camfrog"),
    spots: { left: Number(spots.left) || 0, max: Number(spots.max) || 5, soldOut: !!spots.soldOut },
    rules: Number(rules) || 15, stageMax: Number(stageMax) || 4,
  };
}

function register(app, { addUser }) {
  app.get("/pads/owners", addUser, async (req, res) => {
    try {
      const username = req.user ? req.user.username : null;
      const mine = username ? await safe(() => require("./padowner").myPads(username), []) : [];
      res.set("Cache-Control", "private, max-age=0, must-revalidate");
      res.render("padGuide", { user: username, F: await facts(), SERVICES, GOALS, mine });
    } catch (e) {
      console.error("[padguide]", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

module.exports = { register, facts, SERVICES, GOALS };
