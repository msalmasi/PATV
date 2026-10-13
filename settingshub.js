"use strict";
// settingshub.js - GET /settings: one page that points at every account / preference page on the site (1.99vz).
//
// The settings themselves stay where they live (Edit profile's cards, /settings/likeness, /settings/mentions,
// /settings/telegram, the 💬 Messages settings dialog, /subscriptions, /language ...). This page is the map: grouped
// sections, one row per page with an icon, a title, a one-line description and - where it's cheap - its current state
// ("Telegram: linked", "Likeness: 5 of 5 on"). Every state read is guarded: a module that fails leaves its row without a
// state, never breaks the page.
//
// hub(user, ctx) -> [{ id, entries: [{ id, icon, href, title, desc, state: { k, v, tone } | null }] }]
//   title / desc / state.k are i18n keys under sethub.* (the view translates them); entries with a raw title (a pad name)
//   carry `raw: true`. tests: test/settingshub.test.js (renders, redirects, and every link resolves to a real route).

const { getQuery } = require("./dbUtils");

const SECTIONS = ["account", "profile", "notify", "privacy", "wallet", "pads", "prefs"];

const safe = async (fn, dflt = null) => { try { return await fn(); } catch (e) { return dflt; } };

async function hub(user, ctx = {}) {
  const uid = String(user.userId);
  const me = encodeURIComponent(user.username);
  const edit = "/u/" + me + "/edit";
  const ACCT = "/settings/account";
  const row = (await safe(() => getQuery("SELECT username, camfrogUsername, twitchDisplayname, discordUsername, points_balance FROM users WHERE userId = ?", [uid]), []))[0] || {};
  const st = (k, v, tone) => ({ k: "sethub.st." + k, v: v || {}, tone: tone || "" });
  const E = (id, icon, href, state, extra) => Object.assign({ id, icon, href, title: "sethub.e." + id, desc: "sethub.d." + id, state: state || null }, extra || {});

  // ── Account & sign-in (one home: /settings/account) ──
  const pwSet = await safe(() => require("./ssolinks").passwordSet(uid));
  const chatOn = await safe(() => require("./chatsignin").enabledFor(uid));
  const tg = await safe(() => require("./telegram").linkOf(uid));
  const plex = await safe(() => require("./plexmembers").mine(uid));
  const google = await safe(() => require("./ssolinks").linkOf("google", uid));
  const devices = await safe(async () => (await require("./sessions").list(uid)).length);
  const conns = [!!row.camfrogUsername, !!row.twitchDisplayname, !!row.discordUsername, !!(plex && plex.rows && plex.rows.length), !!tg, !!google];
  const linked = conns.filter(Boolean).length;
  const account = [
    E("account", "👤", ACCT + "#account", st("handle", { name: "@" + (row.username || user.username) })),
    E("connections", "🔗", ACCT + "#connections", st("linked_n", { count: linked, total: conns.length }, linked ? "ok" : "")),
    E("camfrog", "🐸", ACCT + "#camfrogDiv", row.camfrogUsername ? st("as", { name: row.camfrogUsername }, "ok") : st("not_linked")),
    E("password", "🔑", ACCT + "#password", pwSet === null ? null : pwSet ? st("pw_set", null, "ok") : st("pw_unset", null, "warn")),
    E("chatsignin", "💬", ACCT + "#security", chatOn === null ? null : chatOn ? st("on", null, "ok") : st("off")),
    // 1.99wj: your devices (sessions.js), your data (accountexport.js), delete account (accountdelete.js)
    E("devices", "🖥️", ACCT + "#devices", devices === null ? null : st("devices_n", { count: devices })),
    E("data", "📦", ACCT + "#data"),
    E("delete", "🗑️", "/settings/account/delete"),
  ];

  // ── Profile: how others see you (one home: Edit profile - linked, never copied here) ──
  const profile = [
    E("profile", "✏️", edit),
    E("feed", "📝", "/u/" + me + "/posts#profile-settings"),
    E("cosmetics", "🎨", "/cosmetics"),
    E("stickers", "🧸", "/cosmetics?tab=stickers"),
  ];

  // ── Notifications ──
  const dm = await safe(() => require("./messages").prefs(uid));
  const mn = await safe(() => require("./mentions").get(uid));
  const tgPrefs = tg ? await safe(() => require("./telegram").prefs(uid)) : null;
  const notify = [
    E("messages", "📨", "/messages?settings=1", dm ? st("dm_" + dm.who) : null),
    E("mentions", "📣", "/settings/mentions", mn ? (mn.prefs.enabled ? st("on", null, "ok") : st("off")) : null),
    E("telegram", "✈️", "/settings/telegram", tg ? st("tg_linked", { name: tg.handle ? "@" + tg.handle : "" }, "ok") : st("not_linked")),
  ];
  if (tg && Array.isArray(tgPrefs) && tgPrefs.length) {
    notify.push(E("tgalerts", "🔔", "/settings/telegram#alerts", st("n_of_on", { count: tgPrefs.filter((p) => p.on).length, total: tgPrefs.length })));
  }

  // ── Privacy & likeness ──
  const lk = await safe(() => require("./likeness").prefsOf(uid));
  const lkVals = lk ? Object.values(lk) : null;
  // 1.99wa: incognito - Pepe's last report for the linked chat login (incognito.js; its one home is /settings/privacy)
  const inc = await safe(() => require("./incognito").stateOf(uid));
  const incSt = !inc ? null : !inc.linked ? st("not_linked") : inc.waiting ? st("waiting") : inc.on === null ? null : inc.on ? st("on", null, "ok") : st("off");
  const privacy = [
    E("incognito", "🕶️", "/settings/privacy", incSt),
    E("likeness", "🪞", "/settings/likeness", lkVals ? st("n_of_on", { count: lkVals.filter(Boolean).length, total: lkVals.length }) : null),
    E("voice", "🗣️", "/voices/mine"),
    E("clone", "🎙️", "/voices/clone"),
    E("policy", "📄", "/privacy"),
  ];

  // ── Wallet & subscriptions (PAT is points) ──
  const wallet = [
    E("wallet", "👛", "/wallet", row.points_balance != null ? st("pat", { n: Math.round(Number(row.points_balance) || 0) }, "gold") : null),
    E("subscriptions", "🔁", "/subscriptions"),
    E("premium", "💎", "/premium"),
  ];
  const cr = ctx.creatorNav ? await safe(() => ctx.creatorNav(user.username)) : null;
  if (cr && cr.on) wallet.push(cr.creator ? E("creator", "⭐", "/creator") : E("creators", "🌟", "/creators#apply"));
  const CP = await safe(() => require("./cryptopay"));
  const cpOn = CP ? await safe(() => CP.enabled()) : false;
  const cpW = CP ? await safe(() => CP.wallets(uid), []) : [];
  if (cpOn || (cpW && cpW.length)) wallet.push(E("crypto", "🪙", ACCT + "#cryptoDiv", st("wallets_n", { count: (cpW || []).length })));
  if (ctx.supportOn && (await safe(() => ctx.supportOn()))) wallet.push(E("support", "💖", "/support"));

  // ── Your pads ──
  const mine = ctx.myPads ? (await safe(() => ctx.myPads(user.username), [])) || [] : [];
  const pads = mine.map((p) => ({ id: "pad:" + p.slug, icon: "👑", href: p.href, title: p.title, raw: true, desc: "sethub.d.pad", state: null }));
  pads.push(E("newpad", "🆕", "/pads/new"), E("ownerguide", "📘", "/pads/owner-guide"));

  // ── Preferences ──
  const prefs = [
    E("language", "🌐", "/language?next=%2Fsettings", ctx.langName ? st("plain", { name: ctx.langName }) : null),
    E("timezone", "🕒", ACCT + "#timezone", ctx.tz ? st(ctx.tzAuto ? "tz_auto" : "plain", { name: String(ctx.tz).replace(/_/g, " ") }) : null),
  ];

  const by = { account, profile, notify, privacy, wallet, pads, prefs };
  return SECTIONS.map((id) => ({ id, entries: by[id] }));
}

function register(app, { addUser }) {
  app.get("/settings", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings"));
      res.set("Cache-Control", "private, no-store");
      const L = res.locals || {};
      let langName = null;
      try {
        const code = L.lang || "en";
        const hit = require("./i18n").LANGS.find((l) => (Array.isArray(l) ? l[0] : l.code) === code);
        langName = hit ? (Array.isArray(hit) ? hit[1] : hit.name) : code;
      } catch (e) { langName = null; }
      const ctx = {
        creatorNav: app.locals && app.locals.creatorNav, supportOn: app.locals && app.locals.supportOn, myPads: app.locals && app.locals.myPads,
        langName, tz: L.tz || null, tzAuto: !L.tzSaved,
      };
      res.render("settingsHub", { user: req.user.username, sections: await hub(req.user, ctx) });
    } catch (e) { next(e); }
  });
}

module.exports = { register, hub, SECTIONS };
