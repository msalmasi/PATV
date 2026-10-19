// og.js — link previews (1.91). Pages pass an `og` object to the layout, which writes the Open Graph /
// Twitter tags; the preview images are drawn here as SVG and turned into 1200x630 PNGs with sharp
// (Discord, iMessage, X, Slack and Telegram don't render SVG previews). Images are cached for a
// few minutes so a link pasted into a busy chat doesn't re-render for every unfurl.
//
// 1.99ade (privacy / phishing):
//   * the images answer as a SIGNED-OUT visitor would see the thing: a market / pool or a bounty on an Approved pad gets
//     exactly the answer of a missing id (404, no body, no cache header) - the ids are sequential, so a different answer
//     would confirm what exists. The pages set their `og` only after their own access check.
//   * a profile's card and description show the PAT balance only when the member shows it to visitors ("stats" +
//     "stats_balance", views/profile.ejs's rule); the layout unreadable -> no balance. The level number and the Camfrog
//     login are on every visitor's view of the profile (only the XP bar can be hidden), so they stay.
//   * /og/page.png draws only text the site signed: pageUrl(t, d) adds e (the last day it's good for, 14 days on) and
//     s = HMAC(key, len(t)|t|len(d)|d|e) with a key derived in-process from SECRET_KEY (label "og-page-v1", never stored).
//     A missing / bad / expired signature gets the generic card (not an error - links unfurled before this keep an image),
//     and drawing new cards is limited per client (an IPv6 one by its /64) and site-wide. Only site text is signed: the
//     layout's default card (defaultCard) signs a page's title only for a 2xx, parameterless, query-free, signed-out
//     render; a feed post's card is /og/post/<id>.png, which looks the post up on every draw.
const crypto = require("crypto");
const sharp = require("sharp");
const { getQuery } = require("./dbUtils");

const W = 1200, H = 630;
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();          // key -> { at, png }
const FONT = "DejaVu Sans, Ubuntu, Liberation Sans, Arial, sans-serif";
const COLORS = ["#4caf50", "#e57373", "#64b5f6", "#ffd54f", "#ba68c8", "#4dd0e1"];

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Math.floor(Number(n) || 0).toLocaleString("en-US");
// strip emoji/symbols the renderer may not have glyphs for
const plain = (s) => String(s || "").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "").trim();

/** Greedy word-wrap to at most `lines` lines of ~`width` characters (ellipsis on overflow). */
function wrap(text, width, lines) {
  const words = plain(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width && cur) {
      out.push(cur);
      cur = w;
      if (out.length === lines) break;
    } else cur = (cur + " " + w).trim();
  }
  if (out.length < lines && cur) out.push(cur);
  const used = out.join(" ").split(/\s+/).length;
  if (used < words.length && out.length) out[out.length - 1] = out[out.length - 1].replace(/\s*\S*$/, "") + "…";
  return out;
}

function frame(kicker, accent, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="g" cx="0" cy="0" r="1.2"><stop offset="0" stop-color="#173019"/><stop offset="0.6" stop-color="#0d0f0d"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="0" y="0" width="${W}" height="10" fill="${accent}"/>
  <text x="64" y="86" font-family="${FONT}" font-size="26" font-weight="bold" fill="${accent}" letter-spacing="3">${esc(kicker)}</text>
  <text x="${W - 64}" y="86" font-family="${FONT}" font-size="26" font-weight="bold" fill="#4caf50" text-anchor="end">publicaccess.tv</text>
  ${body}
</svg>`;
}

function title(lines, y = 160, size = 54) {
  return lines.map((l, i) => `<text x="64" y="${y + i * (size + 12)}" font-family="${FONT}" font-size="${size}" font-weight="bold" fill="#ffffff">${esc(l)}</text>`).join("");
}

const cachedPng = (key) => { const hit = cache.get(key); return !!(hit && Date.now() - hit.at < CACHE_MS); };
async function png(key, makeSvg) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.png;
  const svg = await makeSvg();
  const out = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  cache.set(key, { at: Date.now(), png: out });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return out;
}

// ── cards ──
function marketCard(m) {
  const lmsr = m.model === "lmsr";
  let opts;
  if (lmsr) {
    const b = m.b || 50000, q = m.q || {};
    const mx = Math.max(...m.options.map((o) => (q[o] || 0) / b));
    const ex = m.options.map((o) => Math.exp((q[o] || 0) / b - mx));
    const s = ex.reduce((a, v) => a + v, 0);
    opts = m.options.map((o, i) => ({ name: o, p: ex[i] / s }));
    // 1.99do: a resolved share market shows its result (winner 100%, the rest 0), not the last trade
    const st = require("./markets").settlement(m);
    if (st && st.kind === "won") opts = opts.map((o) => ({ ...o, p: o.name === st.result ? 1 : 0 }));
  } else {
    const pools = Object.fromEntries(m.options.map((o) => [o, 0]));
    for (const x of m.bets || []) pools[x.option] = (pools[x.option] || 0) + (Number(x.amount) || 0);
    const tot = Object.values(pools).reduce((a, v) => a + v, 0);
    opts = m.options.map((o) => ({ name: o, p: tot ? pools[o] / tot : 1 / m.options.length }));
  }
  const t = wrap(m.question, 34, 2);
  const top = 160 + t.length * 66 + 10;
  const rows = opts.slice(0, 4).map((o, i) => {
    const y = top + i * 72, w = Math.max(6, Math.round(o.p * 700));
    const col = m.result === o.name ? "#ffd700" : COLORS[i % COLORS.length];
    return `<text x="64" y="${y + 30}" font-family="${FONT}" font-size="32" fill="#e6e6e6">${esc(plain(o.name).slice(0, 18))}</text>
      <rect x="360" y="${y + 6}" width="700" height="32" rx="16" fill="#1d1d1d"/>
      <rect x="360" y="${y + 6}" width="${w}" height="32" rx="16" fill="${col}"/>
      <text x="1136" y="${y + 33}" font-family="${FONT}" font-size="32" font-weight="bold" fill="#ffffff" text-anchor="end">${Math.round(o.p * 100)}%</text>`;
  }).join("");
  const status = m.status === "open" ? (lmsr ? "Trading open" : "Betting open") : m.status === "settled" ? `Resolved: ${plain(m.result)}` : m.status === "void" ? "Voided" : "Closed";
  const vol = lmsr ? `Volume ${fmt(m.volume)} PAT` : `Pot ${fmt((m.bets || []).reduce((a, x) => a + (Number(x.amount) || 0), 0))} PAT`;
  const foot = `<text x="64" y="${H - 50}" font-family="${FONT}" font-size="28" fill="#9a9a9a">${esc(status)} · ${esc(vol)}${m.ai_judge ? " · judged by Pepe (AI)" : ""}</text>`;
  return frame(`${lmsr ? "PREDICTION MARKET" : "BETTING POOL"} · M${m.id}`, lmsr ? "#81c784" : "#ffb74d", title(t) + rows + foot);
}

function bountyCard(b) {
  const pot = (b.pot || []).reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const t = wrap(b.task, 30, 3);
  const body = title(t, 170, 58)
    + `<text x="64" y="${170 + t.length * 70 + 70}" font-family="${FONT}" font-size="84" font-weight="bold" fill="#ffd700">${fmt(pot)} PAT</text>`
    + `<text x="64" y="${H - 50}" font-family="${FONT}" font-size="28" fill="#9a9a9a">Posted by ${esc(plain(b.creator))} · ${(b.claims || []).length} claim(s) · ${esc(b.status === "open" ? "open" : b.status)}</text>`;
  return frame(`BOUNTY · BT${b.id}`, "#e0a030", body);
}

function lottoCard(d) {
  const last = (d.history || [])[0];
  const balls = last ? last.white.map((n, i) => `<circle cx="${100 + i * 110}" cy="470" r="44" fill="#f5f5f5"/><text x="${100 + i * 110}" y="484" font-family="${FONT}" font-size="38" font-weight="bold" fill="#111" text-anchor="middle">${n}</text>`).join("")
    + `<circle cx="${100 + 4 * 110 + 20}" cy="470" r="44" fill="#4caf50"/><text x="${120 + 4 * 110}" y="484" font-family="${FONT}" font-size="38" font-weight="bold" fill="#fff" text-anchor="middle">${last.pb}</text>
       <text x="${200 + 5 * 110}" y="482" font-family="${FONT}" font-size="30" fill="#9a9a9a">last draw #${last.draw}</text>` : "";
  const body = `<text x="64" y="200" font-family="${FONT}" font-size="40" fill="#e6e6e6">This week's jackpot</text>
    <text x="64" y="320" font-family="${FONT}" font-size="120" font-weight="bold" fill="#ffd700">${fmt(d.jackpot)} PAT</text>` + balls
    + `<text x="64" y="${H - 40}" font-family="${FONT}" font-size="28" fill="#9a9a9a">Pick 4 of 1-30 + a Pepe Ball · draws Sunday 9pm ET · !lotto quick 5</text>`;
  return frame("PAT LOTTO", "#ffd54f", body);
}

/** u: the users row; vis: profileVis() - what the member shows visitors (1.99ade: a hidden balance never reaches the card). */
function profileCard(u, vis) {
  const v = vis || NONE;
  const t = wrap(u.displayname || u.username, 24, 1);
  const body = title(t, 240, 72)
    + `<text x="64" y="300" font-family="${FONT}" font-size="34" fill="#9a9a9a">@${esc(u.username)}${u.camfrogUsername ? " · " + esc(u.camfrogUsername) + " on Camfrog" : ""}</text>
    <text x="64" y="430" font-family="${FONT}" font-size="30" fill="#9a9a9a">LEVEL</text>
    <text x="64" y="500" font-family="${FONT}" font-size="76" font-weight="bold" fill="#ffffff">${u.level || 0}</text>`
    + (v.balance ? `<text x="360" y="430" font-family="${FONT}" font-size="30" fill="#9a9a9a">PAT</text>
    <text x="360" y="500" font-family="${FONT}" font-size="76" font-weight="bold" fill="#ffd700">${fmt(u.points_balance)}</text>` : "");
  return frame("PATV PROFILE", "#81c784", body);
}

function siteCard(heading, sub) {
  return frame("PUBLIC ACCESS TV", "#81c784", title(wrap(heading, 26, 2), 230, 72)
    + `<text x="64" y="${H - 60}" font-family="${FONT}" font-size="32" fill="#9a9a9a">${esc(sub)}</text>`);
}

// ── who may see what (1.99ade) ──
const NONE = Object.freeze({ balance: false });

/**
 * What a profile's preview may show beyond what every visitor sees: {balance} - the PAT balance only when the member's
 * layout shows it to a signed-out visitor ("stats" and "stats_balance", views/profile.ejs's rule). Unreadable -> NONE.
 */
async function profileVis(userId) {
  try {
    const PL = require("./profilelayout");
    const L = PL.view(await PL.get(userId), {});
    return { balance: !!(L.show("stats") && L.show("stats_balance")) };
  } catch (e) {
    console.error("[og] profile layout:", e && e.message);
    return NONE;
  }
}
const visTag = (v) => (v && v.balance ? 1 : 0);

/** Is this pad's content hidden from a signed-out visitor (an Approved pad)? null pad = site-wide = no. Errors: hidden. */
async function anonHidden(padId) {
  if (!padId) return false;
  try {
    const PA = require("./padaccess");
    await PA.init();
    return !PA.canSee(null, padId);
  } catch (e) { return true; }
}
/** A markets row's pad (the column, else resolved from its record - markets.js's rule) and a bounty's (its room). */
async function marketPad(row, rec) {
  const padlinks = require("./padlinks");
  await padlinks.ready();
  return (row && row.pad) || padlinks.resolve(rec || {}) || null;
}
async function bountyPad(rec) {
  const padlinks = require("./padlinks");
  await padlinks.ready();
  return padlinks.resolve({ room: rec && rec.room }) || null;
}

// ── signed page cards (1.99ade) ──
const PAGE_T_MAX = 80, PAGE_D_MAX = 120;
const GENERIC = Object.freeze({ t: "Public Access TV", d: "" });
const GENERIC_PATH = "/og/page.png";
// 1.99ade: a signature expires PAGE_TTL_DAYS after the day it was made (e = that last day, in whole days since 1970, inside
// the MAC). A page re-signs its card on every render, so a live page's card never runs out; an address copied from a page
// whose text is gone (a deleted post, a renamed pad) draws the generic card within the TTL. One e per day keeps the
// address stable for caches.
const PAGE_TTL_DAYS = 14, DAY_MS = 86400e3;
let NOW = () => Date.now();
const today = () => Math.floor(NOW() / DAY_MS);
let PAGE_KEY = null;
/** The page-card key: HMAC(SECRET_KEY, "og-page-v1"), derived here and never written anywhere. No SECRET_KEY: random per process. */
function pageKey() {
  if (!PAGE_KEY) {
    const base = process.env.SECRET_KEY;
    PAGE_KEY = base ? crypto.createHmac("sha256", String(base)).update("og-page-v1").digest() : crypto.randomBytes(32);
  }
  return PAGE_KEY;
}
// lengths go first so the t / d / e split can't be moved
const pageSig = (t, d, e) => crypto.createHmac("sha256", pageKey()).update(`${t.length}|${t}|${d.length}|${d}|${e}`).digest("base64url").slice(0, 32);
function sigOk(t, d, e, s) {
  if (!/^\d{1,7}$/.test(String(e || ""))) return false;
  const day = Number(e), now = today();
  if (day < now || day > now + PAGE_TTL_DAYS + 1) return false;          // expired, or not one this site would have made
  const want = Buffer.from(pageSig(t, d, String(day)));
  const got = Buffer.from(String(s || ""));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// cut to n UTF-16 units without leaving half an emoji (encodeURIComponent throws on a lone surrogate)
const clip = (s, n) => String(s == null ? "" : s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  .slice(0, n).replace(/[\uD800-\uDBFF]$/, "");
/**
 * The signed /og/page.png address for a heading (and an optional line under it). Text the SITE chose - catalog text, a
 * fixed heading - never a query param, a path segment or member-written text (a post title, a gang or raffle name: those
 * get the generic card, or a card route that re-checks the object, like /og/post/<id>.png).
 */
function pageUrl(heading, description) {
  const t = clip(plain(heading) || GENERIC.t, PAGE_T_MAX), d = clip(plain(description), PAGE_D_MAX);
  const e = String(today() + PAGE_TTL_DAYS);
  return "/og/page.png?t=" + encodeURIComponent(t) + (d ? "&d=" + encodeURIComponent(d) : "") + "&e=" + e + "&s=" + pageSig(t, d, e);
}

/**
 * 1.99ade: the layout's DEFAULT card (a page that sets no `og`): its title signed only when that title can only be site
 * text - the page answered 2xx (a 404 / error page may echo the address: /gtf/sheet/<any text> rendered "<any text> · Heist
 * sheet"), the address has no query string (tracking parameters aside: ?utm_*, ?fbclid ...), the route has no parameters (a /:param route's title is built from the address
 * or from what members wrote there - a gang's name, a raffle's title, a GTF display name), and nobody is signed in (a signed-in
 * page may carry the viewer's own display name; link unfurlers fetch signed out, so public previews are unchanged).
 * Anything else: the plain generic card. index.js hands it to the views as ogPage(title).
 */
// campaign / click-tracking parameters a shared link picks up (?utm_source=..., ?fbclid=...) - no page reads them, so they
// don't count as a query string here (a link shared with them keeps its titled card)
const TRACKING_PARAM = /^(?:utm_[a-z_]{1,20}|fbclid|gclid|dclid|gbraid|wbraid|msclkid|igshid|twclid|ttclid|li_fat_id|mc_cid|mc_eid)$/i;
function onlyTracking(url) {
  const i = url.indexOf("?");
  if (i < 0) return true;
  const qs = url.slice(i + 1).split("#")[0];
  return qs.split("&").every((kv) => !kv || TRACKING_PARAM.test(decodeSafe(kv.split("=")[0])));
}
const decodeSafe = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
function defaultSignable(req, res) {
  const st = Number(res && res.statusCode) || 200;
  if (st < 200 || st >= 300) return false;
  if (!onlyTracking(String((req && req.originalUrl) || ""))) return false;
  const r = req && req.route;
  if (!r) return false;
  const paths = Array.isArray(r.path) ? r.path : [r.path];
  if (!paths.length || !paths.every((p) => typeof p === "string")) return false;     // a RegExp route
  // the matched path had parameters (an array route's other paths leave theirs undefined)
  if (req.params && Object.values(req.params).some((v) => v !== undefined)) return false;
  if ((req.user && req.user.userId) || (req.cookies && req.cookies.jwt)) return false;
  return true;
}
function defaultCard(req, res, heading) {
  return defaultSignable(req, res) ? pageUrl(heading) : GENERIC_PATH;
}

// new cards drawn (a cached card costs nothing and isn't counted): per client - an IPv6 client by its /64, which one
// subscriber line usually has whole - and for the whole site
const RENDER_MAX = 60, RENDER_GLOBAL_MAX = 600, RENDER_WINDOW_MS = 60e3;
let renders = null, rendersAll = null;
const AG = () => require("./middleware/authGuard");
const limiter = () => (renders = renders || AG().limiter({ max: RENDER_MAX, windowMs: RENDER_WINDOW_MS }));
const limiterAll = () => (rendersAll = rendersAll || AG().limiter({ max: RENDER_GLOBAL_MAX, windowMs: RENDER_WINDOW_MS }));
function ipOf(req) {
  try { return AG().clientIp(req); } catch (e) { return (req.socket && req.socket.remoteAddress) || "?"; }
}
/** The key a client is counted under: an IPv4 address as it is; an IPv6 address by its first 64 bits. */
function clientKey(ip) {
  let s = String(ip || "?").trim().toLowerCase().split("%")[0];
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1];
  if (!s.includes(":")) return s;
  const dbl = s.indexOf("::");
  const head = (dbl >= 0 ? s.slice(0, dbl) : s).split(":").filter((g) => g !== "");
  const tail = dbl >= 0 ? s.slice(dbl + 2).split(":").filter((g) => g !== "") : [];
  const groups = dbl >= 0 ? head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail) : head;
  return "v6:" + groups.slice(0, 4).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? g.replace(/^0+(?=.)/, "") : "?")).join(":") + "::/64";
}
/** May this request draw a new card now? Counts it if so. false = over a budget (the caller serves the generic card). */
function renderBudget(req) {
  const L = limiter(), A = limiterAll(), k = clientKey(ipOf(req));
  if (L.blocked(k) || A.blocked("*")) return false;
  L.hit(k); A.hit("*");
  return true;
}

// ── meta for pages ──
function origin(req) {
  const host = req.get("host") || "publicaccess.tv";
  const proto = req.get("x-forwarded-proto") || (/^(localhost|127\.)/.test(host) ? req.protocol : "https");
  return `${proto}://${host}`;
}

function meta(req, { title: t, description, image }) {
  const o = origin(req);
  return { title: plain(t).slice(0, 120), description: plain(description).slice(0, 300), image: o + image, url: o + req.originalUrl.split("?")[0] };
}

function forMarket(req, m) {
  const lmsr = m.model === "lmsr";
  let desc;
  if (lmsr) {
    const b = m.b || 50000, q = m.q || {};
    const mx = Math.max(...m.options.map((o) => (q[o] || 0) / b));
    const ex = m.options.map((o) => Math.exp((q[o] || 0) / b - mx));
    const s = ex.reduce((a, v) => a + v, 0);
    desc = m.options.map((o, i) => `${o} ${Math.round(ex[i] / s * 100)}%`).join(" · ") + ` — volume ${fmt(m.volume)} PAT. Trade it on PATV.`;
  } else {
    desc = `Betting pool: ${m.options.join(" / ")}. Winners split the losing side's pot.`;
  }
  const st = lmsr ? require("./markets").settlement(m) : null;
  if (st && st.kind === "won") desc = `Resolved: ${st.result}. Each ${st.result} share paid 1 PAT; the rest are worth 0. Volume ${fmt(m.volume)} PAT.`;
  else if (st) desc = `Voided: holders were refunded. Volume ${fmt(m.volume)} PAT.`;
  else if (m.status === "settled") desc = `Resolved: ${m.result}. ` + desc;
  // v=…s2 (1.99do): busts unfurl caches that kept the last-trade bars of a settled market
  return meta(req, { title: `M${m.id}: ${m.question}`, description: desc, image: `/og/market/${m.id}.png?v=${Math.floor((m.ended || m.created || 0) / 60)}s2` });
}

function forBounty(req, b) {
  const pot = (b.pot || []).reduce((a, c) => a + (Number(c.amount) || 0), 0);
  return meta(req, { title: `Bounty BT${b.id}: ${b.task}`, description: `${fmt(pot)} PAT for whoever pulls it off. Posted by ${b.creator}. Chip in or claim it on PATV.`, image: `/og/bounty/${b.id}.png` });
}

/**
 * A profile's preview. vis = await profileVis(u.userId) (1.99ade): a balance the member hides from visitors is in neither
 * the description nor the image (whose ?v= changes with the switch, so unfurl caches fetch the image again).
 */
function forProfile(req, u, vis) {
  const v = vis || NONE;
  return meta(req, { title: `${u.displayname || u.username} on Public Access`,
                     description: `Level ${u.level || 0}` + (v.balance ? ` · ${fmt(u.points_balance)} PAT` : ""),
                     image: `/og/profile/${encodeURIComponent(u.username)}.png?v=${visTag(v)}` });
}

function forPage(req, heading, description) {
  return meta(req, { title: heading, description, image: pageUrl(heading, String(description || "").slice(0, PAGE_D_MAX)) });
}

/** Catalog text as plain text (the catalog is HTML-safe; the layout escapes the tags again). en = the fallback. */
const tr = (req, key, en) => {
  let s = "";
  try { s = req && typeof req.t === "function" ? require("./notices").plain(req.t(key)) : ""; } catch (e) { s = ""; }
  return s && s !== key ? s : en;
};
/**
 * 1.99ade: a FIXED preview for a page whose title carries request text (/search?q=, /feed?tag=): catalog title and
 * description, the signed card of a catalog heading, the page's own path. [key, en] pairs.
 */
function forFixed(req, res, { title, description, heading, path }) {
  const base = (res && res.locals && res.locals.ogBase) || origin(req);
  return { title: tr(req, title[0], title[1]), description: tr(req, description[0], description[1]),
           image: base + pageUrl(tr(req, heading[0], heading[1])), url: base + path };
}

function register(app) {
  const send = (res, buf) => { res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=300"); res.send(buf); };
  const fail = (res, e) => { console.error("[og]", e); res.status(500).end(); };
  // 1.99ade: what a missing id gets - and, word for word, an item a signed-out visitor may not see
  const missing = (res) => res.status(404).end();

  app.get("/og/market/:id.png", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const rows = id ? await getQuery("SELECT data, updated, pad FROM markets WHERE id = ?", [id]) : [];
      if (!rows.length) return missing(res);
      const rec = JSON.parse(rows[0].data);
      if (await anonHidden(await marketPad(rows[0], rec))) return missing(res);
      send(res, await png(`m${id}:${rows[0].updated}`, () => marketCard(rec)));
    } catch (e) { fail(res, e); }
  });
  app.get("/og/bounty/:id.png", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const rows = id ? await getQuery("SELECT data, updated FROM bounties WHERE id = ?", [id]) : [];
      if (!rows.length) return missing(res);
      const rec = JSON.parse(rows[0].data);
      if (await anonHidden(await bountyPad(rec))) return missing(res);
      send(res, await png(`b${id}:${rows[0].updated}`, () => bountyCard(rec)));
    } catch (e) { fail(res, e); }
  });
  app.get("/og/lotto.png", async (req, res) => {
    try {
      const rows = await getQuery("SELECT data, updated FROM lotto_state WHERE id = 1");
      const d = rows.length ? JSON.parse(rows[0].data) : { jackpot: 0, history: [] };
      send(res, await png(`l:${rows.length ? rows[0].updated : 0}`, () => lottoCard(d)));
    } catch (e) { fail(res, e); }
  });
  app.get("/og/profile/:username.png", async (req, res) => {
    try {
      const rows = await getQuery("SELECT userId, username, displayname, level, points_balance, camfrogUsername FROM users WHERE username = ?", [req.params.username]);
      if (!rows.length) return res.status(404).end();
      const u = rows[0];
      const vis = await profileVis(u.userId);          // 1.99ade: the ?v= in the address is never trusted - the layout decides
      const key = `p:${u.username}:${u.level}:${vis.balance ? Math.floor(u.points_balance) : "-"}`;
      send(res, await png(key, () => profileCard(u, vis)));
    } catch (e) { fail(res, e); }
  });
  const generic = async () => png("s:generic", () => siteCard(GENERIC.t, GENERIC.d));
  // a card not drawn yet, within the render budget (else the generic card, not cached in between: the same address draws
  // properly later)
  async function budgeted(req, res, key, makeSvg) {
    if (!cachedPng(key) && !renderBudget(req)) {
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "no-store");
      return res.send(await generic());
    }
    send(res, await png(key, makeSvg));
  }
  // 1.99ade: signed, unexpired text only (pageUrl); anything else - no signature, a bad or expired one, text over the limits -
  // is the generic card
  app.get("/og/page.png", async (req, res) => {
    try {
      const q = req.query || {};
      const str = (v) => (typeof v === "string" ? v : "");
      const t = str(q.t), d = str(q.d), e = str(q.e), s = str(q.s);
      const signed = !!t && t.length <= PAGE_T_MAX && d.length <= PAGE_D_MAX && sigOk(t, d, e, s);
      if (!signed) return send(res, await generic());
      await budgeted(req, res, JSON.stringify(["s", t, d]), () => siteCard(t, d));
    } catch (e) { fail(res, e); }
  });
  // 1.99ade: a feed post's card - its title as a SIGNED-OUT visitor sees it (feedstore.get + pageVisible, the post page's
  // rule), looked up on every draw: a deleted, hidden, members-only or 18+ post - or no such post - is the plain
  // "PATV feed" card, the same as an untitled post, so nothing about what exists can be read off it. (The page used to sign
  // the title into an /og/page.png address, which stayed valid after the post was gone.)
  app.get("/og/post/:id.png", async (req, res) => {
    try {
      const id = String(req.params.id || "");
      let heading = "";
      if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        const store = require("./feedstore");
        const p = await store.get(id, null).catch(() => null);
        if (p && store.pageVisible(p, null, null)) heading = clip(plain(p.title || ""), 60);
      }
      heading = heading || POST_DEFAULT;
      await budgeted(req, res, JSON.stringify(["p", heading]), () => siteCard(heading, ""));
    } catch (e) { fail(res, e); }
  });
}
const POST_DEFAULT = "PATV feed";
/** 1.99ade: a post's card address (the ?v= changes with the title, so unfurl caches fetch the new one). */
function postImage(p) {
  const v = crypto.createHash("sha256").update(String((p && p.title) || "")).digest("base64url").slice(0, 8);
  return "/og/post/" + encodeURIComponent(String((p && p.id) || "")) + ".png?v=" + v;
}

module.exports = { register, forMarket, forBounty, forProfile, forPage, forFixed, pageUrl, defaultCard, postImage, profileVis, anonHidden,
                   marketPad, bountyPad, origin, clientKey,
                   PAGE_T_MAX, PAGE_D_MAX, PAGE_TTL_DAYS, RENDER_MAX, RENDER_GLOBAL_MAX,
                   // tests: the SVG builders, the render budgets (fresh limiters: per client `max`, site-wide `all`), the clock
                   _svg: { profileCard, siteCard, marketCard, bountyCard },
                   _setRenderLimit: (max, all) => {
                     renders = AG().limiter({ max: max || RENDER_MAX, windowMs: RENDER_WINDOW_MS });
                     rendersAll = AG().limiter({ max: all || RENDER_GLOBAL_MAX, windowMs: RENDER_WINDOW_MS });
                   },
                   _setClock: (fn) => { NOW = fn || (() => Date.now()); },
                   _clearCache: () => cache.clear() };
