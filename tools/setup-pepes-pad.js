#!/usr/bin/env node
// tools/setup-pepes-pad.js — 1.99wq: dress Pepe's own pad as the SHOWCASE pad - every pad feature, set up the way we'd tell an
// owner to - so other owners have an example to copy. Prod: PepeFrog.Room (Pepe's Pad). Staging: PepeBeta.Room (PepeLab).
//
//   node tools/setup-pepes-pad.js --actor=<site admin>                       DRY RUN (default): what would change, nothing written
//   node tools/setup-pepes-pad.js --actor=<site admin> --apply               a DB backup first (dbbackup.js), then apply
//        [--dir=<site dir>]      the directory with the site's myapp.db + .env (default: the current directory)
//        [--pad=<room id>]       default rooms.HOUSE_ROOM (PepeBeta.Room with STAGING=1, else PepeFrog.Room); must be a HOUSE pad
//        [--skip=a,b]            leave steps out (names below)
//
// Run it as the site's own user with the site's environment (STAGING, PAD_DIR ...), from the site directory, so the pictures
// land where the site serves them. Then restart the site (pm2 restart <app>): the pad look and access level are cached in the
// running process (padlook / padaccess load them at start).
//
// Steps - each reads the current value first and only writes what differs (running it twice changes nothing):
//   page       title (Pepe's Pad on PepeFrog.Room; other house pads keep theirs) + description (with the links)
//   rules      the pad's intro + house rules (padrules.js)
//   look       avatar + banner (tools/pepespad/*.png, drawn by tools/gen-pepespad-art.py) + the frog accent (padlook.js)
//   plus       💎 Prime Time Plus, comped with no end date when the pad doesn't have it (comps.compPremium: free, audited; no PAT)
//   cosmetics  the Plus frame + glow and three perk badges (padcosmetics.equip - perk items only, nothing bought)
//   flair      post flairs (📰 News, 🎰 Casino, 🔮 Markets ...), member flairs, the pad's own tags (padflair.js / feedtags.js)
//   stage      3 slots, bookings need an OK, free, auto-feature when idle (rooms.setStage)
//   soundboard a starter set of TTS clips on the pad's board (Pepe renders them) (soundboards.addRoomClip)
//   pepe       Pepe on the pad's page: his posts (every kind, 5 a day), flair + tags, comments, replies, announcements, automod
//   access     Public (padaccess.js)
//   welcome    Pepe's pinned welcome post explaining the pad (feedstore.create as Pepe, free; pinned with roomMod)
// Never touches another pad, never charges PAT (no buy / top-up path is used anywhere).
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const flag = (k) => process.argv.includes(`--${k}`);
const DIR = path.resolve(arg("dir") || process.cwd());
const APPLY = flag("apply");
const SKIP = new Set(String(arg("skip") || "").split(",").map((s) => s.trim()).filter(Boolean));
const ART = path.join(__dirname, "pepespad");

if (!fs.existsSync(path.join(DIR, "myapp.db"))) { console.error(`no myapp.db in ${DIR} - run it in the site directory (or --dir=)`); process.exit(2); }
process.chdir(DIR);
const ROOT = path.join(__dirname, "..");                     // the site's code (this checkout); the DB is DIR's myapp.db
try { require("dotenv").config({ path: path.join(DIR, ".env") }); } catch (e) { /* no dotenv / .env: the shell's environment */ }
const M = (n) => require(path.join(ROOT, n));

// ── the showcase ──
const DESCRIPTION = [
  "Pepe's own pad - the house room of PATV. Pepe runs the games, posts the news, recaps the night and keeps the stage going.",
  "Casino: /casino · Markets: /markets · Pepeball: /lotto · Grand Theft Frogger: /gtf · Stickers: /stickers · Help: /help",
].join("\n");
const RULES = {
  intro: "Pepe's Pad is the house room: loud, friendly and a bit unhinged. Have fun - just don't make it worse for anyone else. Padiquette applies on top of these.",
  rules: [
    { title: "Be a good roommate", desc: "Roasts and banter are welcome; harassment, slurs aimed at people and pile-ons aren't. If someone asks you to stop, stop." },
    { title: "Flair your post", desc: "Pick the flair that fits (📰 News, 🎰 Casino, 🔮 Markets ...) so people can filter the feed. Mods may change it." },
    { title: "Keep it SFW here", desc: "No nudity or sexual content in this pad - posts and comments are read by everyone, everywhere." },
    { title: "PAT is points", desc: "PAT has no cash value. No selling, buying or trading PAT for money, and no begging for it in posts." },
    { title: "No spam or self-promo floods", desc: "One post per thing. Streams belong on the stage - book a slot, it's free here." },
    { title: "Private stays private", desc: "No screenshots of DMs, no personal info about anyone (real names, addresses, jobs) without their OK." },
    { title: "Pepe is a bot", desc: "Pepe posts and comments with a 🤖 badge. Mute him on a thread with the post's menu; tell a mod if he gets something wrong." },
  ],
};
const POST_FLAIRS = [
  { name: "News", emoji: "📰", color: "#2196f3" },
  { name: "Casino", emoji: "🎰", color: "#ffcf40" },
  { name: "Markets", emoji: "🔮", color: "#9575cd" },
  { name: "Stage", emoji: "🎬", color: "#e53935" },
  { name: "Stickers", emoji: "🧸", color: "#ff8fab" },
  { name: "Pepe Says", emoji: "🐸", color: "#4caf50" },
  { name: "Recap", emoji: "📊", color: "#26a69a" },
  { name: "Question", emoji: "❓", color: "#4fc3f7" },
  { name: "Music", emoji: "🎵", color: "#ab47bc" },
  { name: "Heist", emoji: "💰", color: "#ff8a3d" },
  { name: "Snaps", emoji: "📸", color: "#90a4ae" },
  { name: "Announcement", emoji: "📣", color: "#ef5350", mod_only: true },
];
const USER_FLAIRS = [
  { name: "Regular", emoji: "🐸", color: "#4caf50", self: true },
  { name: "On the Mic", emoji: "🎙️", color: "#ab47bc", self: true },
  { name: "High Roller", emoji: "🎰", color: "#ffcf40", self: true },
  { name: "Night Owl", emoji: "🦉", color: "#5c6bc0", self: true },
  { name: "Crew", emoji: "🛠️", color: "#ef5350", self: false },
];
const PAD_TAGS = ["news", "markets", "casino", "heist", "recap", "music", "stage", "stickers", "gtf", "pepeball"];
const STAGE = { slot_count: 3, approval: true, slot_price: 0, takeover: "when_idle", slot_max_min: "" };
const COSMETICS = ["pp_frame", "pp_glow", "pp_headliner", "pp_redcarpet", "pt_onair"];
const SOUNDBOARD = [
  { label: "Breaking news", emoji: "📰", text: "Breaking news! Pepe has an announcement." },
  { label: "Jackpot", emoji: "🎰", text: "Jackpot! Somebody call the Fed." },
  { label: "Ribbit", emoji: "🐸", text: "Ribbit." },
  { label: "On air", emoji: "🔴", text: "We are live. Everybody act natural." },
  { label: "Knox Knox", emoji: "🏦", text: "Knox knox. Who's there? Not your PAT." },
  { label: "Applause", emoji: "👏", text: "Give it up for the stage!" },
];
const PEPE_SITE = [["feed", true], ["posts", true], ["posts_per_day", 5], ["labels", true], ["announce", true], ["replies", true],
                   ["comments", true], ["comment_rate", "normal"], ["automod", true], ["automod_level", "standard"]];
const WELCOME_TITLE = "👋 Welcome to Pepe's Pad - start here";
const welcomeBody = (slug, tags) => [
  "This is my pad - the house room of PATV, and the example pad for every owner. Everything a pad can do is switched on here, so have a look around:",
  "",
  "📰 Feed - post anything. Pick a flair (News, Casino, Markets, Stage, Stickers, Pepe Says ...) and tap one to filter the feed. Mods-only flairs (📣 Announcement) are for news from the crew.",
  `🏷️ Tags - ${tags.map((t) => "#" + t).join(" ")}. Tap one to see everything about it.`,
  "🎬 Stage - go live here for free. Book a slot from the Stage tab; an idle stage features whoever's live.",
  "🔊 Soundboard - press a clip in the room and I'll play it on the mic.",
  "🎖️ Flair - pick your own (Regular, On the Mic, High Roller, Night Owl) from the Feed tab.",
  "🤖 Me - I post the news, the night's recap, market picks and questions here, and I flair and tag my own posts like everyone else. Mute me on any thread from the post's menu.",
  "",
  "Own a pad? Copy anything you like: it's all in your pad's ⚙ Settings (Flair & tags, Stage, Pepe, Rules).",
  `Pad rules: /p/${slug}?tab=about#rules · Help: /help`,
].join("\n");

const fmt = (v) => (typeof v === "string" ? JSON.stringify(v.length > 60 ? v.slice(0, 57) + "..." : v) : JSON.stringify(v));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);
let changes = 0;
const plan = (step, what) => { changes++; console.log(`  ${APPLY ? "~" : "would"} ${step}: ${what}`); };
const same = (step, what) => console.log(`  = ${step}: ${what}`);

(async () => {
  const { getQuery, runQuery } = M("dbUtils");
  const rooms = M("rooms");
  await rooms.init();
  const actorName = arg("actor");
  if (!actorName) throw new Error("say who is doing it: --actor=<site admin username>");
  const admin = (await getQuery("SELECT userId, username, class FROM users WHERE LOWER(username) = LOWER(?)", [actorName]))[0];
  if (!admin) throw new Error(`no account called ${actorName}`);
  if (admin.class !== "Admin") throw new Error(`${admin.username} isn't a site admin`);
  const padId = arg("pad") || rooms.HOUSE_ROOM;
  const R0 = await rooms.get(padId);
  if (!R0) throw new Error(`no pad ${padId}`);
  if (!R0.house) throw new Error(`${padId} isn't a house pad - this script only dresses Pepe's own pads`);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · pad ${R0.title} [${R0.id}] p/${R0.slug} · as ${admin.username} · STAGING=${process.env.STAGING ? 1 : 0} · ${DIR}`);
  if (APPLY) {
    const file = await M("dbbackup").backupDb("pepes-pad");
    console.log(`backup: ${file}`);
  }
  const step = (n) => !SKIP.has(n);

  // ── page ──
  if (step("page")) {
    const want = { description: DESCRIPTION };
    if (R0.id === "PepeFrog.Room") want.title = "Pepe's Pad";
    const diff = Object.keys(want).filter((k) => (R0[k] || "") !== want[k]);
    if (diff.length) { plan("page", diff.map((k) => `${k} -> ${fmt(want[k])}`).join(", ")); if (APPLY) await rooms.setPage(R0.id, want, admin.username + " (setup)"); }
    else same("page", "title + description");
  }
  // ── rules ──
  if (step("rules")) {
    const PR = M("padrules");
    const cur = await PR.get(R0.id);
    const want = PR.clean(RULES);
    const norm = (x) => JSON.stringify({ intro: (x && x.intro) || "", rules: ((x && x.rules) || []).map((r) => [r.title, r.desc]) });
    if (norm(cur) !== norm(want)) { plan("rules", `intro + ${want.rules.length} rules`); if (APPLY) await PR.set(admin, R0.id, RULES); }
    else same("rules", `${want.rules.length} rules`);
  }
  // ── look ──
  if (step("look")) {
    const PL = M("padlook");
    await PL.init();
    const row = (await getQuery("SELECT * FROM pad_looks WHERE room_id = ?", [R0.id]))[0] || {};
    const marks = JSON.parse((await rooms.kvGet("pepespad:art:" + R0.id)) || "{}");
    for (const kind of ["avatar", "banner"]) {
      const f = path.join(ART, kind + ".png");
      const h = sha(f);
      if (row[kind] && marks[kind] === h) { same("look", `${kind} (${h})`); continue; }
      plan("look", `${kind} <- tools/pepespad/${kind}.png (${h})`);
      if (APPLY) {
        await PL.setImage(R0.id, kind, fs.readFileSync(f), { userId: admin.userId, actor: admin.username + " (setup)", bannerY: 50 });
        marks[kind] = h;
        await rooms.kvSet("pepespad:art:" + R0.id, JSON.stringify(marks));
      }
    }
    const acc = PL.guardAccent((PL.PALETTE.find((x) => x.id === "frog") || {}).hex);
    if (!acc || row.accent !== acc.hex) { plan("look", `accent -> frog`); if (APPLY) await PL.setStyle(R0.id, { accent: "frog" }, admin.username + " (setup)"); }
    else same("look", "accent frog");
  }
  // ── 💎 Plus ──
  const P = M("premium");
  await P.init();
  if (step("plus")) {
    const sub = await P.subRow("prime_plus", R0.id);
    if (sub && Date.now() < P.endsAt(sub)) same("plus", `Prime Time Plus ${P.statusOf(sub)}${sub.comped ? " (comped)" : ""}`);
    else {
      plan("plus", "comp 💎 Prime Time Plus with no end date (free, admin audit)");
      if (APPLY) { await M("comps").compPremium(admin, { tier: "prime_plus", pad: R0.id, mode: "lifetime", reason: "Pepe's Pad showcase (setup-pepes-pad.js)" }); await P.loadCache(); }
    }
  }
  // ── cosmetics (perk items only) ──
  if (step("cosmetics")) {
    const PC = M("padcosmetics");
    await PC.init();
    const cur = M("padlook").cosmeticsOf(R0.id);
    const plus = P.isPrimePlus(R0.id);
    for (const id of COSMETICS) {
      const item = PC.CAT.byId[id];
      if (!item) { console.log(`  ! cosmetics: ${id} isn't in the catalog - skipped`); continue; }
      const on = item.kind === "pad_badge" ? (cur.pad_badge || []).includes(id) : cur[item.kind] === id;
      if (on) { same("cosmetics", id); continue; }
      if (!plus && !APPLY) { plan("cosmetics", `equip ${id} (after the Plus comp)`); continue; }
      plan("cosmetics", `equip ${id}`);
      if (APPLY) { try { await PC.equip(admin, R0.id, id, true); } catch (e) { console.log(`  ! cosmetics: ${id}: ${e.message}`); } }
    }
  }
  // ── flair + tags ──
  if (step("flair")) {
    const FL = M("padflair");
    await FL.init();
    const have = await getQuery("SELECT * FROM pad_flairs WHERE room_id = ?", [R0.id]);
    const sync = async (list, kind) => {
      for (const f of list) {
        const ex = have.find((h) => (h.kind || "user") === kind && String(h.name).toLowerCase() === f.name.toLowerCase());
        const input = { kind, name: f.name, emoji: f.emoji, color: f.color, self: !!f.self, mod_only: !!f.mod_only };
        const color = FL.cleanColor(f.color);
        if (ex && ex.emoji === f.emoji && ex.color === (color && color.hex) && !!ex.self_assign === (kind === "user" && !!f.self) && !!ex.mod_only === (kind === "post" && !!f.mod_only)) {
          same("flair", `${kind} ${f.emoji} ${f.name}`); continue;
        }
        plan("flair", `${ex ? "update" : "add"} ${kind} flair ${f.emoji} ${f.name}${f.mod_only ? " (mods only)" : ""}${f.self ? " (members pick it)" : ""}`);
        if (APPLY) await FL.save(admin, R0.id, ex ? { ...input, id: ex.id } : input);
      }
    };
    await sync(POST_FLAIRS, "post");
    await sync(USER_FLAIRS, "user");
    const TG = M("feedtags");
    await TG.init();
    const tags = await TG.padTags(R0.id);
    if (JSON.stringify(tags) !== JSON.stringify(PAD_TAGS)) { plan("flair", `pad tags -> ${PAD_TAGS.map((t) => "#" + t).join(" ")}`); if (APPLY) await TG.setPadTags(admin, R0.id, PAD_TAGS); }
    else same("flair", `pad tags ${PAD_TAGS.length}`);
  }
  // ── stage ──
  if (step("stage")) {
    const stage = M("mainstage");
    await stage.init();
    const C = stage.config();
    const caps = { maxSlots: C.max_slots_per_room + P.padPerks(R0.id).extraSlots, maxPrice: C.price_per_min, maxMinutes: C.pad_max_minutes };
    const R = await rooms.get(R0.id);
    const diff = [];
    if (R.slot_count !== STAGE.slot_count) diff.push(`slots ${R.slot_count} -> ${STAGE.slot_count}`);
    if (!!R.approval !== STAGE.approval) diff.push(`approval -> ${STAGE.approval}`);
    if (Number(R.slot_price) !== STAGE.slot_price) diff.push(`price -> ${STAGE.slot_price}`);
    if ((R.takeover || "") !== STAGE.takeover) diff.push(`auto-feature -> ${STAGE.takeover}`);
    if (diff.length) { plan("stage", diff.join(", ")); if (APPLY) await rooms.setStage(R0.id, STAGE, admin.username + " (setup)", caps); }
    else same("stage", "3 slots, approval, free, auto-feature when idle");
  }
  // ── soundboard ──
  if (step("soundboard")) {
    const SB = M("soundboards");
    await SB.init();
    const live = await getQuery("SELECT label FROM sb_clips WHERE board = ? AND status IN ('render','active','hidden')", ["room:" + R0.id]);
    for (const c of SOUNDBOARD) {
      if (live.some((x) => String(x.label).toLowerCase() === c.label.toLowerCase())) { same("soundboard", c.label); continue; }
      plan("soundboard", `add TTS clip ${c.emoji} ${c.label} (500 PAT a play; Pepe renders it)`);
      if (APPLY) { try { await SB.addRoomClip(R0.id, { userId: admin.userId, staff: true }, { kind: "tts", label: c.label, emoji: c.emoji, text: c.text, price: 500 }); } catch (e) { console.log(`  ! soundboard: ${c.label}: ${e.message}`); } }
    }
  }
  // ── Pepe on the pad's page ──
  if (step("pepe")) {
    const PS = M("padsite");
    const st = await PS.state(R0.id);
    // a house pad without settings of its own FOLLOWS the site-wide (All) ones; the first change gives it its own row (from the
    // defaults), so then every key here is written - not only the ones that differ from what it inherited
    await M("feedstore").init();
    const inherited = (await M("feedstore").kvGet("pepe:scope:" + R0.id)) == null;
    for (const [k, v] of PEPE_SITE) {
      const cur = st.values[k] ? st.values[k].value : undefined;
      if (!inherited && JSON.stringify(cur) === JSON.stringify(v)) { same("pepe", `${k} = ${fmt(v)}`); continue; }
      plan("pepe", `${k} ${fmt(cur)} -> ${fmt(v)}`);
      if (APPLY) await PS.set(admin, R0.id, k, v);
    }
    if (st.values.post_kinds && st.values.post_kinds.value !== null) {
      plan("pepe", "post_kinds -> every kind");
      if (APPLY) await PS.set(admin, R0.id, "post_kinds", M("pepefeed").KINDS.slice());
    } else same("pepe", "post_kinds = every kind");
  }
  // ── access ──
  if (step("access")) {
    const PA = M("padaccess");
    await PA.init();
    if (PA.levelOf(R0.id) !== "public") { plan("access", `${PA.levelOf(R0.id)} -> public`); if (APPLY) await PA.setLevel(admin, await rooms.get(R0.id), "public"); }
    else same("access", "public");
  }
  // ── the pinned welcome post ──
  if (step("welcome")) {
    const store = M("feedstore");
    await store.init();
    const pf = M("pepefeed");
    const acct = await pf.ensureAccount();
    const R = await rooms.get(R0.id);
    const body = welcomeBody(R.slug, PAD_TAGS);
    const flair = "Announcement";
    const tags = ["news", "stage", "casino"];
    const ex = (await getQuery("SELECT id, body FROM feed_posts WHERE author_id = ? AND home_pad = ? AND title = ? AND deleted_at IS NULL ORDER BY created LIMIT 1",
                               [acct.userId, R0.id, WELCOME_TITLE]))[0];
    let id = ex ? ex.id : null;
    if (!ex) {
      plan("welcome", `Pepe posts "${WELCOME_TITLE}" (📣 Announcement, #${tags.join(" #")})`);
      if (APPLY) {
        const FL = M("padflair"); FL._clear();
        const p = await store.create(acct.userId, { title: WELCOME_TITLE, body, community: R0.id, nsfw: false, announce: [], tags, flair }, { free: true });
        id = p.id;
      }
    } else if (ex.body !== body) {
      plan("welcome", "update the welcome post's text");
      if (APPLY) await store.edit({ userId: acct.userId }, ex.id, { title: WELCOME_TITLE, body, tags, flair });
    } else same("welcome", `post ${ex.id}`);
    if (id) {
      const pin = (await getQuery("SELECT pinned_at FROM feed_post_rooms WHERE post_id = ? AND room_id = ?", [id, R0.id]))[0];
      if (!pin || !pin.pinned_at) { plan("welcome", "pin it"); if (APPLY) await store.roomMod(admin, R0.id, "pin", { post: id }); }
      else same("welcome", "pinned");
    } else if (!APPLY) plan("welcome", "pin it");
  }

  console.log(changes ? (APPLY ? `done: ${changes} change(s). Restart the site so the look / access caches reload (pm2 restart <app>).`
                                : `${changes} change(s) - run again with --apply to make them`) : "nothing to change - the pad is set up");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e && e.stack ? e.stack : e); process.exit(1); });
