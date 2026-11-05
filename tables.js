// tables.js — Pepe's casino tables on PATV: /casino, /poker (Texas Hold'em), /blackjack.
//
// The tables themselves run in Pepe (the Camfrog bot): one Hold'em or Blackjack table at a time, in
// one Camfrog room. Pepe pushes the live state here on every change (/api/tables/sync, bot token,
// at most ~2 a second). The page polls /api/tables/state about once a second.
//
// Playing from the site: a signed-in user with a linked Camfrog name posts a seat action to
// /api/tables/act. It is queued as a pepe_actions row of kind "table" (actions.js), which Pepe
// claims on a fast lane (/api/tables/claim, every second while a table is open) and runs as that
// Camfrog name through the very same chat command — same rules, fees, timers and escrow — so web
// and Camfrog players sit at the same table. The result comes back through /api/actions/ack.
//
// TABLES ARE A COLLECTION: the sync body is a list of tables with ids; each has a HOME (where it's
// played: a Camfrog room today, "web" reserved for later) and a FEATURED flag (the table on the main
// stage: this site's main view and the stream overlay). Pepe caps how many can be open (max_tables,
// 1 for now). Every page action carries the id of the table it was aimed at, so a click on a table
// that has since closed can never land on a new one. /casino/t/<id> is a table's own page. Admins
// can feature/unfeature a table or push it to another Camfrog room (game "admin").
//
// PRIVACY: a Hold'em player's hole cards arrive in the sync body's `private` map, keyed by the PATV
// account that paid for the seat. That map is kept in memory only, apart from the public state, and
// /api/tables/state hands a signed-in user ONLY their own entry. It is never written to the
// database, never rendered into page HTML, and never included in anything another user can fetch.
// 1.99?? casmask: the sync's `who` (which login / account key sits in which seat, who hosts) is server only too - WHO, read
// by the site's own veils (view) and never part of the public state.
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const actions = require("./actions");

const STALE_MS = 45 * 1000;           // no sync for this long = Pepe is offline / restarting
const EXPIRE_MS = 60 * 1000;          // a table action nobody claimed within this is dropped
const CARD = /^[2-9TJQKA][shdc]$/;
const VERBS = {
  holdem: { start: ["room", "blinds"], sit: ["int"], stand: [], deal: [], end: [], check: [], call: [],
            fold: [], allin: [], bet: ["int"], raise: ["int"] },
  bj: { start: ["room"], bet: ["int"], autobet: ["intoff"], deal: [], hit: [], stand: [], double: [],
        split: [], insurance: [], leave: [], end: [] },
  admin: { feature: [], unfeature: [], push: ["room"] },
};

let STATE = null;                      // the latest public state
let PRIV = new Map();                  // PATV username (lowercase) -> [that player's own seats, one per table]
let RECEIVED = 0;

// ── 1.99?? casmask (the 1.99ajw verifier's gap a): Pepe's own tables masked by the SITE's veils too ──
// Pepe masks his tables before he syncs them (pepe_tables.py, privacy fix 2: "someone" / "someone N" for everyone private by HIS
// checks). The site applies its own veils on top, at every read, with the rule casino/veil.js uses (veil.kindOf: padweb.hiddenKey or
// Pepe's incognito report, for the seat's login, its account's key "u:<id>" and the account's linked login): a seat the site finds
// veiled - or can't check - reads as "someone" / "someone N" (numbered after Pepe's own labels), and so does its name in the turn,
// the host, the result, the felt's last round and the public log. Who sits where comes from the sync's SERVER-ONLY `who`
// ({<table id>: {seats: [<login> | "u:<id>"], host}} - kept in WHO, never in STATE, never on a page); a table without it (an older
// Pepe) has every seat and its host masked (fail closed). /api/tables/state and the homepage read the tables through view().
// 1.99?? casmask review fixes:
//   * STICKY for the table's life (Pepe's own rule, _game_veil_map): a person the site masked at a table (a confirmed veil -
//     incognito / !bridge hide) stays masked there under the same label - after they stand up, after their veil is switched off, in
//     its final round, its linger and every log line it wrote (kept while a line of that table can still be in Pepe's log). Masks
//     that come from a check that can't say (no `who`, no read yet, a failed read) are for that answer only, never sticky.
//   * the host: masked with their seat (the same key, else the same name) or by their own key / typed login (who.host_login)
//   * labels numbered after EVERY label of Pepe's that table shows anywhere (seats, host, turn, result, last round, its log lines),
//     never one he uses for someone else
//   * a log line is masked by ITS OWN table (Pepe's `tid`; an older Pepe's line: every table of its game)
//   * Pepe is told: the sync answer's {"veil": {<table id>: [seat keys]}} (confirmed veils only - his veil is sticky) and a website
//     action's `veil: 1` in /api/tables/claim - so his OBS board, his synced public part and (for a website player) his Camfrog lines
//     mask them too (pepe_tables._tables_site_veil)
const KEY_LOGIN = /^[\w.\-]{1,40}$/, KEY_ACCT = /^u:([A-Za-z0-9-]{6,64})$/;
const KIND_MS = 2000, LINK_MS = 60 * 1000, STICKY_MAX = 100, STICKY_SLACK_MS = 120 * 1000;
const PEPE_LABEL = /^someone(?: (\d{1,3}))?$/;
const PEPE_LABEL_IN = /(?<![\w])someone(?: (\d{1,3}))?(?![\w])/g;
let WHO = new Map();                   // table id -> {seats: [key | null], host: key | null, logins, host_login}
const STICKY = new Map();              // table id -> {game, ids: Map(person id -> Set(names shown)), lab: Map(person id -> label), seen}
let SKEW = 0;                          // our clock - Pepe's (ms), from the last sync: a log line's time on our clock
const KIND = new Map();                // key -> {k, at}: incognito | out | unknown | null (veil.kindOf)
const LINKS = new Map();               // key -> {keys, at}
let kindsP = null;
const cleanKey = (v) => { const k = String(v == null ? "" : v).trim().toLowerCase(); return KEY_LOGIN.test(k) || KEY_ACCT.test(k) ? k : null; };
function cleanWho(w, ids) {
  const out = new Map();
  if (!w || typeof w !== "object") return out;
  for (const id of ids) {
    const x = w[id];
    if (!x || typeof x !== "object") continue;
    // (logins: the login a seat typed from where it differs from its key - an alias Pepe's memory store folds in; both are checked)
    out.set(id, { seats: Array.isArray(x.seats) ? x.seats.slice(0, 12).map(cleanKey) : [], host: cleanKey(x.host),
                  logins: Array.isArray(x.logins) ? x.logins.slice(0, 12).map(cleanKey) : [], host_login: cleanKey(x.host_login) });
  }
  return out;
}
/** a seat key's chat keys: the login + its live account's key, or the account key + the account's linked login (cached a minute) */
async function keysOfKey(key) {
  const c = LINKS.get(key), now = Date.now();
  if (c && now - c.at < LINK_MS) return c.keys;
  const PR = require("./personref");
  const keys = [key];
  const m = KEY_ACCT.exec(key);
  if (m) {
    const a = await PR.accountById(m[1]);
    if (a && a.camfrogUsername) keys.push(String(a.camfrogUsername).toLowerCase());
  } else {
    const a = await PR.linkedAccount(key);
    if (a && a.userId) keys.push("u:" + String(a.userId).toLowerCase());
  }
  LINKS.set(key, { keys, at: now });
  if (LINKS.size > 2000) LINKS.delete(LINKS.keys().next().value);
  return keys;
}
/** re-read the kind of every seat key / host the current tables have (at most every KIND_MS each; one read at a time) */
function refreshKinds() {
  if (kindsP) return kindsP;
  kindsP = (async () => {
    const V = require("./casino/veil");
    const ids = new Set([...((STATE && STATE.tables) || []), ...((STATE && STATE.closed) || [])].map((t) => t.id));
    const keys = new Set();
    for (const id of ids) {
      const w = WHO.get(id);
      if (w) { for (const k of w.seats.concat(w.logins || [])) if (k) keys.add(k); if (w.host) keys.add(w.host); if (w.host_login) keys.add(w.host_login); }
    }
    for (const k of keys) {
      const c = KIND.get(k);
      if (c && Date.now() - c.at < KIND_MS) continue;
      let kind;
      try { kind = await V.kindOf(await keysOfKey(k)); } catch (e) { kind = "unknown"; }
      KIND.set(k, { k: kind == null ? null : kind, at: Date.now() });
    }
    if (KIND.size > 2000) for (const k of [...KIND.keys()].slice(0, KIND.size - 2000)) KIND.delete(k);
  })().catch((e) => { console.error("[tables] veils:", e.message); }).finally(() => { kindsP = null; });
  return kindsP;
}
/** masked now (fails closed: no key, never read, a failed read) */
const veiledKey = (k) => { if (!k) return true; const c = KIND.get(k); return !c || c.k === "incognito" || c.k === "out" || c.k === "unknown"; };
/** a CONFIRMED veil (incognito / !bridge hide read for this key) - what may stick, and what Pepe is told */
const confirmedKey = (k) => { if (!k) return false; const c = KIND.get(k); return !!(c && (c.k === "incognito" || c.k === "out")); };
const isLabel = (n) => PEPE_LABEL.test(String(n == null ? "" : n));
/** the highest "someone N" of Pepe's in these names / texts (a bare "someone" is 1) -> {top, any} */
function pepeLabels(names, texts) {
  let top = 0, any = false;
  for (const n of names) {
    const m = PEPE_LABEL.exec(String(n == null ? "" : n));
    if (m) { any = true; top = Math.max(top, m[1] ? Number(m[1]) : 1); }
  }
  for (const t of texts) {
    for (const m of String(t || "").matchAll(PEPE_LABEL_IN)) { any = true; top = Math.max(top, m[1] ? Number(m[1]) : 1); }
  }
  return { top, any };
}
/** one table (a copy) with the site's masks, `lines` = the texts of its log lines: -> [[a name it showed, its label], ...] for the log */
function maskTable(t, lines) {
  const w = WHO.get(t.id) || null;
  const seats = Array.isArray(t.seats) ? t.seats : [];
  const seatKey = (i) => (w ? w.seats[i] || null : null);
  const alt = (i) => (w && Array.isArray(w.logins) ? w.logins[i] || null : null);
  const st = STICKY.get(t.id) || { game: t.game, ids: new Map(), lab: new Map(), seen: 0 };
  // one id per person: a seat's key (else its name, with no key)
  const idOf = (i) => (w && seatKey(i) ? "k:" + seatKey(i) : "n:" + seats[i].name);
  // why each seat is masked: "sticky" (masked at this table before), "veil" (a confirmed veil - sticky from now on), "closed" (no
  // `who` / no key / no read yet / a failed read - this answer only), null (named)
  const why = seats.map((s, i) => {
    if (!s || !s.name || isLabel(s.name)) return null;
    if (st.ids.has(idOf(i))) return "sticky";
    if (!w || !seatKey(i)) return "closed";
    const ks = [seatKey(i), alt(i)].filter(Boolean);
    if (ks.some(confirmedKey)) return "veil";
    return ks.some(veiledKey) ? "closed" : null;
  });
  // the host: the same person as the seat with their key (else, with no key, their name) - masked with it, or by their own key /
  // typed login (casmask review: an alias host - the seat masked by its typed login - was named in the host field); a masked seat
  // showing the host's name masks the host too (fails closed)
  let hostWhy = null, hostId = null;
  if (t.host && !isLabel(t.host)) {
    const hk = w ? w.host : null;
    let hs = -1;
    seats.forEach((s, i) => { if (hs < 0 && s && s.name && (hk ? seatKey(i) === hk : s.name === t.host)) hs = i; });
    hostId = hs >= 0 ? idOf(hs) : hk ? "k:" + hk : "n:" + t.host;
    const hks = [hk, w ? w.host_login : null].filter(Boolean);
    if (hs >= 0 && why[hs]) hostWhy = why[hs];
    else if (st.ids.has(hostId)) hostWhy = "sticky";
    else if (!w) hostWhy = "closed";
    else if (!hk) hostWhy = hs >= 0 ? null : "closed";                 // (no key: the seat showing their name decides)
    else if (hks.some(confirmedKey)) hostWhy = "veil";
    else if (hks.some(veiledKey)) hostWhy = "closed";
    if (!hostWhy && seats.some((s, i) => why[i] && s.name === t.host)) {
      hostWhy = "closed";
      const j = seats.findIndex((s, i) => why[i] && s.name === t.host);
      hostId = idOf(j);
    }
    // ... and a masked host's own seat (its host mark would name them) is masked with them
    if (hostWhy && hs >= 0 && !why[hs]) why[hs] = hostWhy;
  }
  // the sticky ones: kept for the table's life, with every name they were shown under
  const keep = (id, name) => { if (!st.ids.has(id)) st.ids.set(id, new Set()); if (name) st.ids.get(id).add(String(name)); };
  seats.forEach((s, i) => { if (why[i] === "veil" || why[i] === "sticky") keep(idOf(i), s.name); });
  if (hostWhy === "veil" || hostWhy === "sticky") keep(hostId, t.host);
  // this answer's masked people: the sticky ones first (in the order they were first masked - also those who left: their lines
  // stay), then this answer's own
  const order = [...st.ids.keys()], names = new Map();
  for (const [id, ns] of st.ids) names.set(id, new Set(ns));
  const add = (id, name) => { if (!order.includes(id)) order.push(id); if (!names.has(id)) names.set(id, new Set()); if (name) names.get(id).add(String(name)); };
  seats.forEach((s, i) => { if (why[i]) add(idOf(i), s.name); });
  if (hostWhy) add(hostId, t.host);
  if (st.ids.size) { st.seen = Date.now(); STICKY.set(t.id, st); }
  if (!order.length) return [];
  // labels: after every label of Pepe's this table shows (seats, host, turn, result, last round, its log lines) - "someone" alone
  // only when nobody else at it is masked
  const shown = seats.map((s) => s && s.name).concat([t.host, t.turn && t.turn.name]);
  for (const part of [t.result, t.last_round]) {
    if (!part || typeof part !== "object") continue;
    for (const f of ["winners", "players", "shown"]) if (Array.isArray(part[f])) for (const x of part[f]) shown.push(x && x.name);
  }
  const { top, any } = pepeLabels(shown, lines || []);
  const lab = new Map();
  order.forEach((id, j) => lab.set(id, !any && order.length === 1 ? "someone" : "someone " + (top + j + 1)));
  st.lab = lab;
  const pairs = [], byName = new Map();
  for (const id of order) for (const n of names.get(id) || []) { if (!byName.has(n)) { byName.set(n, lab.get(id)); pairs.push([n, lab.get(id)]); } }
  seats.forEach((s, i) => { if (why[i]) s.name = lab.get(idOf(i)); });
  if (hostWhy) t.host = lab.get(hostId);
  const nm = (x) => { if (x && typeof x === "object" && typeof x.name === "string" && byName.has(x.name)) x.name = byName.get(x.name); return x; };
  if (t.turn) {
    const i = Number(t.turn.seat);
    if (Number.isInteger(i) && seats[i]) { if (why[i]) t.turn.name = seats[i].name; }     // (by its seat: a named seat keeps its name)
    else nm(t.turn);
  }
  for (const part of [t.result, t.last_round]) {
    if (!part || typeof part !== "object") continue;
    for (const f of ["winners", "players", "shown"]) if (Array.isArray(part[f])) part[f].forEach(nm);
  }
  return pairs;
}
/** a table no longer in the state: its sticky names under their last labels (for the log lines it wrote) */
function stickyPairs(st) {
  const out = [];
  for (const [id, ns] of st.ids) for (const n of ns) out.push([n, (st.lab && st.lab.get(id)) || "someone"]);
  return out;
}
/** drop the sticky record of a table that is gone and whose lines can no longer be in Pepe's log; at most STICKY_MAX */
function pruneSticky(live, log) {
  for (const [id, st] of [...STICKY]) {
    if (live.has(id)) continue;
    const mine = log.some((l) => l && (l.tid ? l.tid === id
      : l.game === st.game && Number(l.ts) * 1000 + SKEW <= st.seen + STICKY_SLACK_MS));
    if (!mine) STICKY.delete(id);
  }
  if (STICKY.size > STICKY_MAX) for (const [id] of [...STICKY].sort((a, b) => a[1].seen - b[1].seen).slice(0, STICKY.size - STICKY_MAX)) STICKY.delete(id);
}
/** the public state as a page may see it (a copy): every table masked by the site's veils too, the log with them */
function maskState(out) {
  const o = JSON.parse(JSON.stringify(out));
  const log = Array.isArray(o.log) ? o.log : [];
  const pairsBy = new Map(), gameBy = new Map(), live = new Set();
  for (const t of (o.tables || []).concat(o.closed || [])) {
    live.add(t.id); gameBy.set(t.id, t.game);
    const lines = log.filter((l) => l && typeof l.text === "string" && (l.tid ? l.tid === t.id : l.game === t.game)).map((l) => l.text);
    try { pairsBy.set(t.id, maskTable(t, lines)); }
    catch (e) {
      // (can't be made safe: every name on it "someone")
      const pairs = [];
      for (const s of t.seats || []) if (s && s.name) { pairs.push([s.name, "someone"]); s.name = "someone"; }
      if (t.host) { pairs.push([t.host, "someone"]); t.host = "someone"; }
      t.turn = t.turn ? Object.assign(t.turn, { name: "someone" }) : t.turn;
      t.result = null; t.last_round = null;
      const st = STICKY.get(t.id);
      pairsBy.set(t.id, st ? stickyPairs(st).map(([n]) => [n, "someone"]).concat(pairs) : pairs);
    }
  }
  for (const [id, st] of STICKY) if (!live.has(id)) { pairsBy.set(id, stickyPairs(st)); gameBy.set(id, st.game); }
  if (Array.isArray(o.log)) {
    const V = require("./casino/veil");
    o.log = o.log.map((l) => {
      if (!l || typeof l.text !== "string") return l;
      // each line by its own table (Pepe's tid); an older Pepe's line without one: every table of its game
      let pairs = [];
      if (l.tid) pairs = pairsBy.get(l.tid) || [];
      else for (const [id, ps] of pairsBy) if (gameBy.get(id) === l.game) pairs = pairs.concat(ps);
      return { ts: l.ts, game: l.game, text: pairs.length ? V.maskWith(l.text, pairs) : l.text };     // (the tid stays here)
    });
  }
  pruneSticky(live, log);
  return o;
}
/** what /api/tables/state and the homepage read: the public state, the site's veils re-read first (at most every 2 s) */
async function view() {
  try { await refreshKinds(); } catch (e) { /* the masks fail closed on what isn't read */ }
  return maskState(publicState());
}
/** 1.99?? casmask review: the sync answer's {<table id>: [seat keys]} - the seats (and host) the site finds veiled, CONFIRMED veils
 *  only (incognito / !bridge hide - never a check that couldn't say: Pepe's veil is sticky for the table's life), and the ones it
 *  keeps masked there (STICKY). Pepe adds them to that table's veil (pepe_tables._tables_site_veils). */
function veilReport() {
  const out = {};
  for (const [id, w] of WHO) {
    const keys = new Set();
    w.seats.forEach((k, i) => { if (k && (confirmedKey(k) || confirmedKey((w.logins || [])[i]))) keys.add(k); });
    if (w.host && (confirmedKey(w.host) || confirmedKey(w.host_login))) keys.add(w.host);
    const st = STICKY.get(id);
    if (st) for (const pid of st.ids.keys()) if (pid.startsWith("k:")) keys.add(pid.slice(2));
    if (keys.size) out[id] = [...keys].slice(0, 24);
  }
  return out;
}
/** 1.99?? casmask review: a website table action's player as the site's veils see them (their login, their account, its linked
 *  login) - true for a CONFIRMED veil only (a check that can't say, or fails: false - Pepe's own checks still apply, and the web
 *  view masks them anyway). Pepe puts them in the table's veil before the action's first room line. */
async function actorVeiled(a) {
  try {
    const keys = new Set();
    const login = cleanKey(a && a.camfrog);
    if (login) for (const k of await keysOfKey(login)) keys.add(k);
    const acct = a && a.user_id ? cleanKey("u:" + a.user_id) : null;
    if (acct) for (const k of await keysOfKey(acct)) keys.add(k);
    if (!keys.size) return false;
    const k = await require("./casino/veil").kindOf([...keys]);
    return k === "incognito" || k === "out";
  } catch (e) { return false; }
}

// ── cleaning (the bot is trusted, but nothing malformed should reach a page) ──
const int = (v, lo = 0, hi = 1e12) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const str = (v, n = 80) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
const bool = (v) => !!v;
const cards = (a, n = 12) => (Array.isArray(a) ? a.slice(0, n).map(String).filter((c) => CARD.test(c)) : []);
const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n).filter((x) => x && typeof x === "object") : []);

const OUTCOMES = new Set(["win", "lose", "push", "blackjack", "bust", "surrender"]);
const outcome = (v) => (OUTCOMES.has(String(v)) ? String(v) : null);

// the finished round, kept on the felt until the next deal (or ~30 s after the table closes).
// Everything in it was already public: Pepe's revealed hand / the hands turned up at showdown.
function cleanLastHoldem(l) {
  if (!l || typeof l !== "object") return null;
  return {
    hand_no: int(l.hand_no), uncontested: bool(l.uncontested), board: cards(l.board, 5), pot: int(l.pot), rake: int(l.rake),
    shown: bool(l.uncontested) ? [] : arr(l.shown, 12).map((x) => ({ name: str(x.name), cards: cards(x.cards, 2), hand: str(x.hand) })),
    winners: arr(l.winners, 12).map((w) => ({ name: str(w.name), amount: int(w.amount), hand: str(w.hand), pot: str(w.pot, 20) })),
  };
}

function cleanLastBj(l) {
  if (!l || typeof l !== "object") return null;
  const d = l.dealer && typeof l.dealer === "object" ? l.dealer : {};
  return {
    round_no: int(l.round_no),
    dealer: { cards: cards(d.cards, 12), value: int(d.value), bust: bool(d.bust), blackjack: bool(d.blackjack) },
    players: arr(l.players, 8).map((p) => ({
      name: str(p.name), net: Math.round(Number(p.net) || 0), total_bet: int(p.total_bet), total_payout: int(p.total_payout),
      insurance: p.insurance && typeof p.insurance === "object"
        ? { amount: int(p.insurance.amount), won: bool(p.insurance.won), payout: int(p.insurance.payout) } : null,
      hands: arr(p.hands, 4).map((h) => ({
        cards: cards(h.cards, 12), value: int(h.value), bet: int(h.bet), payout: int(h.payout),
        net: Math.round(Number(h.net) || 0), outcome: outcome(h.outcome), is_bj: bool(h.is_bj), doubled: bool(h.doubled), split: bool(h.split),
      })),
    })),
  };
}

function siteTime(botTs, botNow, recv) {
  // the bot's clock -> ours: a deadline N seconds after the bot's "now" is N seconds after we got it
  const t = Number(botTs), b = Number(botNow);
  if (!Number.isFinite(t) || !Number.isFinite(b) || t <= 0) return null;
  return Math.round(recv + (t - b) * 1000);
}

function cleanMeta(t) {
  const h = t.home && typeof t.home === "object" ? t.home : {};
  return { home: { kind: h.kind === "web" ? "web" : "room", room: h.room ? str(h.room, 64) : null, room_name: str(h.room_name || h.room, 64) },
           featured: t.featured !== false };
}

function cleanHoldem(t, botNow, recv) {
  const turn = t.turn && typeof t.turn === "object" ? {
    seat: int(t.turn.seat, 0, 20), name: str(t.turn.name), to_call: int(t.turn.to_call), can_check: bool(t.turn.can_check),
    current_bet: int(t.turn.current_bet), min_to: int(t.turn.min_to), max_to: int(t.turn.max_to), paid: int(t.turn.paid),
    can_raise: bool(t.turn.can_raise), deadline: siteTime(t.turn.deadline, botNow, recv),
  } : null;
  const res = t.result && typeof t.result === "object" ? {
    hand_no: int(t.result.hand_no), uncontested: bool(t.result.uncontested), rake: int(t.result.rake),
    winners: arr(t.result.winners, 12).map((w) => ({ name: str(w.name), amount: int(w.amount), hand: str(w.hand), pot: str(w.pot, 20) })),
  } : null;
  return {
    id: str(t.id, 16), game: "holdem", room: str(t.room, 64), room_name: str(t.room_name, 64), phase: str(t.phase, 16),
    hand_no: int(t.hand_no), sb: int(t.sb), bb: int(t.bb), min_buy: int(t.min_buy), max_buy: int(t.max_buy),
    high_stakes: bool(t.high_stakes), host: str(t.host), board: cards(t.board, 5), pot: int(t.pot),
    pots: arr(t.pots, 10).map((p) => ({ amount: int(p.amount), players: int(p.players, 0, 20) })),
    current_bet: int(t.current_bet), max_seats: int(t.max_seats, 0, 20), act_secs: int(t.act_secs, 0, 600),
    rake_pct: Number(t.rake_pct) || 0, can_deal: bool(t.can_deal), next_at: siteTime(t.next_at, botNow, recv),
    turn, result: res, last_round: ["between", "closed"].includes(String(t.phase)) ? cleanLastHoldem(t.last_round) : null, ...cleanMeta(t),
    seats: arr(t.seats, 12).map((s) => ({
      name: str(s.name), stack: int(s.stack), bet: int(s.bet), status: str(s.status, 12), cards_down: bool(s.cards_down),
      button: bool(s.button), blind: s.blind === "SB" || s.blind === "BB" ? s.blind : null, turn: bool(s.turn),
      leaving: bool(s.leaving), host: bool(s.host), shown: s.shown ? cards(s.shown, 2) : null,
      hand: s.hand ? str(s.hand) : null, winner: bool(s.winner),
    })),
  };
}

function cleanBj(t, botNow, recv) {
  const d = t.dealer && typeof t.dealer === "object" ? t.dealer : {};
  const turn = t.turn && typeof t.turn === "object" ? {
    seat: int(t.turn.seat, 0, 20), name: str(t.turn.name), hand_index: int(t.turn.hand_index, 0, 8),
    num_hands: int(t.turn.num_hands, 0, 8), can_double: bool(t.turn.can_double), can_split: bool(t.turn.can_split),
    deadline: siteTime(t.turn.deadline, botNow, recv),
  } : null;
  const res = t.result && typeof t.result === "object" ? {
    round_no: int(t.result.round_no),
    dealer: { value: int((t.result.dealer || {}).value), bust: bool((t.result.dealer || {}).bust), blackjack: bool((t.result.dealer || {}).blackjack) },
    players: arr(t.result.players, 12).map((p) => ({
      name: str(p.name), net: Math.round(Number(p.net) || 0),
      hands: arr(p.hands, 8).map((h) => ({ value: int(h.value), outcome: str(h.outcome, 12) })),
      insurance: p.insurance == null ? null : bool(p.insurance),
    })),
  } : null;
  const hidden = bool(d.hidden);
  return {
    id: str(t.id, 16), game: "bj", room: str(t.room, 64), room_name: str(t.room_name, 64), phase: str(t.phase, 16),
    round_no: int(t.round_no), min_bet: int(t.min_bet), max_bet: int(t.max_bet), high_stakes: bool(t.high_stakes), host: str(t.host),
    max_seats: int(t.max_seats, 0, 20), act_secs: int(t.act_secs, 0, 600), decks: int(t.decks, 0, 12),
    // while Pepe's hole card is down only the upcard is kept, whatever arrives
    dealer: { cards: cards(d.cards, hidden ? 1 : 12), down: hidden ? int(d.down, 0, 1) : 0, value: int(d.value), hidden,
              bust: bool(d.bust), blackjack: bool(d.blackjack) },
    turn, result: res, ...cleanMeta(t),
    // never while a round is live (Pepe's hole card would be down)
    last_round: ["betting", "idle", "done", "closed"].includes(String(t.phase)) ? cleanLastBj(t.last_round) : null,
    bet_deadline: siteTime(t.bet_deadline, botNow, recv), ins_deadline: siteTime(t.ins_deadline, botNow, recv),
    seats: arr(t.seats, 8).map((s) => ({
      name: str(s.name), bet: int(s.bet), pending: int(s.pending), insured: bool(s.insured), autobet: bool(s.autobet),
      turn: bool(s.turn), leaving: bool(s.leaving), host: bool(s.host),
      hands: arr(s.hands, 4).map((h) => ({
        cards: cards(h.cards, 12), value: int(h.value), soft: bool(h.soft), bet: int(h.bet), outcome: outcome(h.outcome),
        payout: h.payout == null ? null : int(h.payout), is_bj: bool(h.is_bj), doubled: bool(h.doubled), split: bool(h.split),
        current: bool(h.current),
      })),
    })),
  };
}

function cleanPrivate(p, tableIds) {
  const out = new Map();
  if (!p || typeof p !== "object") return out;
  for (const [u, list] of Object.entries(p).slice(0, 60)) {
    const seats = (Array.isArray(list) ? list : [list]).slice(0, 8)
      .filter((v) => v && typeof v === "object" && tableIds.has(String(v.table)))
      .map((v) => ({
        table: str(v.table, 16), game: v.game === "bj" ? "bj" : "holdem", seat: int(v.seat, 0, 20), name: str(v.name),
        cards: v.game === "bj" ? [] : cards(v.cards, 2), hand_no: int(v.hand_no), folded: bool(v.folded), leaving: bool(v.leaving),
        autobet: bool(v.autobet), lastbet: int(v.lastbet), pending: int(v.pending), insurance: int(v.insurance),
      }));
    if (seats.length) out.set(String(u).toLowerCase().slice(0, 80), seats);
  }
  return out;
}

function cleanSync(b) {
  const recv = Date.now();
  const botNow = Number(b.bot_now) || recv / 1000;
  const tables = arr(b.tables, 4).map((t) => (t.game === "bj" ? cleanBj(t, botNow, recv) : cleanHoldem(t, botNow, recv)));
  // tables that just closed after a round: their final round lingers on the page until linger_until
  const closed = arr(b.closed, 4).map((t) => {
    const c = t.game === "bj" ? cleanBj(Object.assign({}, t, { phase: "closed" }), botNow, recv) : cleanHoldem(t, botNow, recv);
    return Object.assign(c, { phase: "closed", closed: true, turn: null, can_deal: false,
                              linger_until: siteTime(t.linger_until, botNow, recv) || recv + 30000 });
  }).filter((t) => t.last_round && !tables.some((o) => o.id === t.id));
  const cfg = b.config && typeof b.config === "object" ? b.config : {};
  const h = cfg.holdem || {}, j = cfg.bj || {};
  return {
    state: {
      tables, closed, max_tables: int(b.max_tables || 1, 1, 50),
      rooms: arr(b.rooms, 30).map((r) => ({ id: str(r.id, 64), name: str(r.name, 64), holdem: bool(r.holdem), bj: bool(r.bj) })),
      busy: b.busy ? str(b.busy, 40) : null,
      // (1.99?? casmask review: + the line's table - server side only, maskState masks a line by its own table)
      log: arr(b.log, 40).map((l) => Object.assign({ ts: int(l.ts), game: l.game === "bj" ? "bj" : "holdem", text: str(l.text, 200) },
                                                     /^[0-9a-f]{6,16}$/.test(String(l.tid || "")) ? { tid: String(l.tid) } : {})),
      config: {
        holdem: { sb_cap: int(h.sb_cap), bb_cap: int(h.bb_cap), min_buy_bb: int(h.min_buy_bb), max_buy_bb: int(h.max_buy_bb),
                  act_secs: int(h.act_secs), max_seats: int(h.max_seats), next_hand_secs: int(h.next_hand_secs),
                  hr_ladder: arr(h.hr_ladder, 12).map((x) => [int(Array.isArray(x) ? x[0] : 0), int(Array.isArray(x) ? x[1] : 0)]) },
        bj: { min_bet: int(j.min_bet), max_bet: int(j.max_bet), hr_min_bet: int(j.hr_min_bet), hr_max_bet: int(j.hr_max_bet),
              act_secs: int(j.act_secs), bet_secs: int(j.bet_secs),
              open_secs: int(j.open_secs), max_seats: int(j.max_seats), ins_secs: int(j.ins_secs) },
      },
    },
    priv: cleanPrivate(b.private, new Set(tables.map((t) => t.id))),
    who: cleanWho(b.who, [...tables, ...closed].map((t) => t.id)),        // 1.99?? casmask: server only (see WHO)
  };
}

// ── validation of a player's request (Pepe validates again) ──
function buildArgs(b, isAdmin) {
  const game = String(b.game || "");
  const verb = String(b.verb || "");
  const spec = (VERBS[game] || {})[verb];
  if (!spec) return { error: "That can't be done from the site." };
  if (game === "admin" && !isAdmin) return { error: "Only admins can change the main stage." };
  // the table this was aimed at (every action but "start" needs one that's still open)
  let table = null;
  if (verb !== "start") {
    const tables = (STATE && STATE.tables) || [];
    const want = String(b.table || "");
    table = want ? tables.find((t) => t.id === want) : null;
    if (!want && game !== "admin") {
      const same = tables.filter((t) => t.game === game);
      table = same.length === 1 ? same[0] : null;
    }
    if (!table) return { error: want ? "That table has closed." : "Which table? Reload the page." };
    if (game !== "admin" && table.game !== game) return { error: "That's a different game's table." };
  }
  const args = [game, verb];
  for (const kind of spec) {
    if (kind === "int" || kind === "intoff") {
      const raw = String(b.amount == null ? "" : b.amount).replace(/,/g, "").trim();
      if (kind === "intoff" && raw.toLowerCase() === "off") { args.push("off"); continue; }
      if (!/^\d{1,11}$/.test(raw) || Number(raw) <= 0) return { error: "Enter a whole number of PAT." };
      args.push(String(Number(raw)));
    } else if (kind === "room") {
      const room = String(b.room || "");
      const known = STATE && STATE.rooms.find((r) => r.id === room);
      if (!known) return { error: "Pick one of the rooms Pepe is in." };
      const g = game === "admin" ? table.game : game;
      if (!known[g]) return { error: `${g === "bj" ? "Blackjack" : "Hold'em"} is switched off in ${known.name}.` };
      args.push(room);
    } else if (kind === "blinds") {
      const m = /^\s*(\d{1,9})\s*\/\s*(\d{1,9})\s*$/.exec(String(b.blinds || ""));
      if (!m || Number(m[1]) < 1 || Number(m[2]) <= Number(m[1])) return { error: "Blinds look like 25/50 (small below big)." };
      args.push(`${Number(m[1])}/${Number(m[2])}`);
    }
  }
  if (table) args.push("t=" + table.id);
  const label = game === "admin" ? `!stage ${verb}${verb === "push" ? " " + args[2] : ""}` : (game === "bj" ? "!bj " : "!holdem ") + args.slice(1).filter((a) => !a.startsWith("t=")).join(" ");
  return { args, label };
}

function publicState() {
  const now = Date.now();
  if (!STATE) return { now, stale: true, updated: null, tables: [], closed: [], rooms: [], busy: null, log: [], config: null };
  return Object.assign({ now, updated: RECEIVED, stale: now - RECEIVED > STALE_MS }, STATE,
                       { closed: (STATE.closed || []).filter((t) => t.linger_until > now) });
}

function register(app, { isBotToken, addUser }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  app.post("/api/tables/sync", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    let ok = false;
    try {
      const { state, priv, who } = cleanSync(b);
      STATE = state;
      PRIV = priv;           // replaced wholesale: a player who left loses their entry at once
      WHO = who;             // 1.99?? casmask: who sits where - server only, for the site's own veils (view)
      RECEIVED = Date.now();
      SKEW = Number(b.bot_now) > 0 ? RECEIVED - Number(b.bot_now) * 1000 : 0;
      ok = true;
    } catch (e) {
      console.error("[tables] sync:", e.message);
      return res.status(400).json({ ok: false });
    }
    // 1.99?? casmask review: the site's veils for these tables go back to Pepe (veilReport) - read first (at most 1.5 s)
    let tm = null;
    try { await Promise.race([refreshKinds(), new Promise((r) => { tm = setTimeout(r, 1500); if (tm.unref) tm.unref(); })]); } catch (e) { /* as read */ }
    if (tm) clearTimeout(tm);
    let veil = {};
    try { maskState(publicState()); } catch (e) { /* (the sticky masks as of this sync - a read does the same) */ }
    try { veil = veilReport(); } catch (e) { veil = {}; }
    res.json(Object.keys(veil).length ? { ok, veil } : { ok });
  });

  // Pepe's fast lane: website table actions only. Old ones are dropped, not run late.
  app.post("/api/tables/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    require("./actorcap").note(req.body);        // 1.99wv (actorcap.js)
    try {
      const now = Date.now();
      await runQuery(`UPDATE pepe_actions SET status = 'failed', message = ?, updated = ?
                      WHERE kind = 'table' AND ((status = 'pending' AND created < ?) OR (status = 'claimed' AND claimed < ?))`,
        ["Pepe didn't get to it in time — nothing happened. Try again.", now, now - EXPIRE_MS, now - EXPIRE_MS]);
      const rows = await getQuery("SELECT * FROM pepe_actions WHERE kind = 'table' AND status = 'pending' ORDER BY id LIMIT 10");
      for (const a of rows) await runQuery("UPDATE pepe_actions SET status = 'claimed', claimed = ?, updated = ? WHERE id = ? AND status = 'pending'", [now, now, a.id]);
      const out = [];
      for (const a of rows) {
        let args = [];
        try { args = JSON.parse(a.args); } catch (e) { args = []; }
        const x = { id: a.id, kind: "table", args, username: a.username, camfrog: a.camfrog, site_admin: !!a.site_admin,
                    user_id: a.user_id, actor: { userId: a.user_id, username: a.username, login: a.camfrog || null, display: null } };   // 1.99wv
        if (await actorVeiled(a)) x.veil = 1;      // 1.99?? casmask review: the site's veil - Pepe masks them from the first line
        out.push(x);
      }
      res.json({ actions: out });
    } catch (e) {
      console.error("[tables] claim:", e.message);
      res.status(500).json({ actions: [] });
    }
  });

  // The live table + (for a signed-in player) their own seat and recent requests. Per-user: never cache.
  app.get("/api/tables/state", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const out = await view();           // 1.99?? casmask: masked by the site's veils too (see WHO)
    out.me = null;
    if (req.user && req.user.userId) {
      try {
        const u = (await getQuery("SELECT username, camfrogUsername, casino_banned, class FROM users WHERE userId = ?", [req.user.userId]))[0];
        if (u) {
          const acts = await actions.recentFor(req.user.userId, "casino", 6);
          out.me = {
            username: u.username, camfrog: u.camfrogUsername || null, banned: !!u.casino_banned, admin: SP.can(u, "casino.admin"),
            // 1.99wv: who the page plays as - the chat login, else the PATV account while Pepe acts for accounts
            playAs: u.camfrogUsername || (require("./actorcap").on() ? "🌐 " + u.username : null),
            seats: PRIV.get(String(u.username).toLowerCase()) || [],            // ONLY this user's own seats
            // 1.99ep: a failure shows the friendly message + its error code (weberrors.js)
            actions: acts.map((a) => ({ id: a.id, label: a.label, status: a.status, message: a.err ? a.err.message : a.message,
                                        code: a.err ? a.err.code : null, incident: a.err ? a.err.incident : null, created: a.created })),
          };
        }
      } catch (e) {
        console.error("[tables] state/me:", e.message);
      }
    }
    res.json(out);
  });

  // A seat action from the page. JSON only (a cross-site form can't send it), signed in, linked.
  app.post("/api/tables/act", addUser, async (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const u = (await getQuery("SELECT camfrogUsername, casino_banned, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!u) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const isAdmin = SP.can(u, "casino.admin");
    const adminAct = String((req.body || {}).game) === "admin";
    // 1.99wv (connections audit C): with no chat login the PATV account plays (Pepe seats "🌐 <name>", charged from the account)
    if (!adminAct && !u.camfrogUsername && !require("./actorcap").on()) return res.status(403).json({ ok: false, error: "Link a chat account first (Settings → Account → Connections; for Camfrog, type !verify in a room with Pepe) — you play as that name." });
    if (!adminAct && u.casino_banned) return res.status(403).json({ ok: false, error: "You're banned from the casino." });
    const built = buildArgs(req.body || {}, isAdmin);
    if (built.error) return res.status(400).json({ ok: false, error: built.error });
    if (!STATE || Date.now() - RECEIVED > STALE_MS) return res.status(503).json({ ok: false, error: "Pepe is offline right now — try again in a minute." });
    try {
      const id = await actions.queue(req.user.userId, { kind: "table", args: built.args, tag: "casino", label: built.label });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false, error: e.message === "busy" ? "You already have a few moves waiting — give Pepe a second." : "Something went wrong — nothing was sent." });
    }
  });

  const page = (focus) => async (req, res) => {
    const tableId = req.params && req.params.id && /^[0-9a-f]{6,16}$/.test(req.params.id) ? req.params.id : null;
    if (req.params && req.params.id && !tableId) return res.redirect("/tables");
    // 1.99ol: the casino FRONT END (casino_settings bj_front / hm_front, /admin/games): a game set to the PATV casino sends
    // /blackjack and /poker to /casino/<game> (and /tables too once both are), unless an admin adds ?preview=1.
    // A table's own page (/casino/t/:id) always opens.
    if (!tableId) {
      try {
        const csvc = require("./casino/service");
        const st = await csvc.loadSettings();
        const to = focus === "lobby" ? csvc.frontPath(st, "lobby") : csvc.frontOf(st, focus) === "patv" ? csvc.frontPath(st, focus) : null;
        if (to && to.startsWith("/casino/") && !(req.query && req.query.preview && req.user && await csvc.isSiteAdmin(req.user.userId))) {
          return res.redirect(to);
        }
      } catch (e) { console.error("[tables] front end:", e.message); }
    }
    try {
      let me = null;
      if (req.user && req.user.userId) {
        me = (await getQuery("SELECT username, camfrogUsername, points_balance, casino_banned FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
        if (me) me.playAs = me.camfrogUsername || (require("./actorcap").on() ? "🌐 " + me.username : null);   // 1.99wv
      }
      let pokerNow = [];
      if (focus === "holdem") {
        try {
          pokerNow = await getQuery(`SELECT p.url, p.blinds, p.date_created, u.displayname, u.username FROM poker_now_games p
                                     JOIN users u ON p.userId = u.userId ORDER BY p.date_created DESC LIMIT 10`);
        } catch (e) { pokerNow = []; }
      }
      const titles = { holdem: "Texas Hold'em", bj: "Blackjack", lobby: "Casino tables" };
      res.locals.og = { title: `${titles[focus]} with Pepe — publicaccess.tv`,
                        description: "Play Pepe's No-Limit Hold'em and Blackjack tables from the web or from Camfrog chat — same table, same chips (PAT).",
                        image: res.locals.ogBase + require("./og").pageUrl(titles[focus]),
                        url: res.locals.ogBase + res.locals.ogPath };
      res.render("casino", { user: req.user ? req.user.username : null, me, focus, title: titles[focus], pokerNow, tableId });
    } catch (e) {
      console.error("[tables] page:", e);
      res.status(500).send("Something went wrong.");
    }
  };
  // the lobby: /tables (publicaccess.tv/casino exactly is redirected away at the CDN, so links use /tables)
  app.get(["/tables", "/casino"], addUser, page("lobby"));
  app.get("/casino/t/:id", addUser, page("lobby"));            // one table's own page
  app.get("/poker", addUser, page("holdem"));
  app.get(["/blackjack", "/bj"], addUser, page("bj"));
}

module.exports = { register, cleanSync, buildArgs, view, maskState, _state: () => ({ STATE, PRIV, WHO, STICKY }),
  _reset: () => { KIND.clear(); LINKS.clear(); STICKY.clear(); kindsP = null; },
  _kinds: () => { KIND.clear(); LINKS.clear(); kindsP = null; } };          // (tests: a veil changed - the sticky masks stay)
