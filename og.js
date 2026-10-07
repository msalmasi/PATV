// og.js — link previews (1.91). Pages pass an `og` object to the layout, which writes the Open Graph /
// Twitter tags; the preview images are drawn here as SVG and turned into 1200x630 PNGs with sharp
// (Discord, iMessage, X, Slack and Telegram don't render SVG previews). Images are cached for a
// few minutes so a link pasted into a busy chat doesn't re-render for every unfurl.
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

function profileCard(u) {
  const t = wrap(u.displayname || u.username, 24, 1);
  const body = title(t, 240, 72)
    + `<text x="64" y="300" font-family="${FONT}" font-size="34" fill="#9a9a9a">@${esc(u.username)}${u.camfrogUsername ? " · " + esc(u.camfrogUsername) + " on Camfrog" : ""}</text>
    <text x="64" y="430" font-family="${FONT}" font-size="30" fill="#9a9a9a">LEVEL</text>
    <text x="64" y="500" font-family="${FONT}" font-size="76" font-weight="bold" fill="#ffffff">${u.level || 0}</text>
    <text x="360" y="430" font-family="${FONT}" font-size="30" fill="#9a9a9a">PAT</text>
    <text x="360" y="500" font-family="${FONT}" font-size="76" font-weight="bold" fill="#ffd700">${fmt(u.points_balance)}</text>`;
  return frame("PATV PROFILE", "#81c784", body);
}

function siteCard(heading, sub) {
  return frame("PUBLIC ACCESS TV", "#81c784", title(wrap(heading, 26, 2), 230, 72)
    + `<text x="64" y="${H - 60}" font-family="${FONT}" font-size="32" fill="#9a9a9a">${esc(sub)}</text>`);
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

function forProfile(req, u) {
  return meta(req, { title: `${u.displayname || u.username} on Public Access`, description: `Level ${u.level || 0} · ${fmt(u.points_balance)} PAT`, image: `/og/profile/${encodeURIComponent(u.username)}.png` });
}

function forPage(req, heading, description) {
  return meta(req, { title: heading, description, image: `/og/page.png?t=${encodeURIComponent(heading)}&d=${encodeURIComponent(description.slice(0, 120))}` });
}

function register(app) {
  const send = (res, buf) => { res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=300"); res.send(buf); };
  const fail = (res, e) => { console.error("[og]", e); res.status(500).end(); };

  app.get("/og/market/:id.png", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const rows = id ? await getQuery("SELECT data, updated FROM markets WHERE id = ?", [id]) : [];
      if (!rows.length) return res.status(404).end();
      send(res, await png(`m${id}:${rows[0].updated}`, () => marketCard(JSON.parse(rows[0].data))));
    } catch (e) { fail(res, e); }
  });
  app.get("/og/bounty/:id.png", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const rows = id ? await getQuery("SELECT data, updated FROM bounties WHERE id = ?", [id]) : [];
      if (!rows.length) return res.status(404).end();
      send(res, await png(`b${id}:${rows[0].updated}`, () => bountyCard(JSON.parse(rows[0].data))));
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
      const rows = await getQuery("SELECT username, displayname, level, points_balance, camfrogUsername FROM users WHERE username = ?", [req.params.username]);
      if (!rows.length) return res.status(404).end();
      const u = rows[0];
      send(res, await png(`p:${u.username}:${u.level}:${Math.floor(u.points_balance)}`, () => profileCard(u)));
    } catch (e) { fail(res, e); }
  });
  app.get("/og/page.png", async (req, res) => {
    try {
      const t = String(req.query.t || "Public Access TV").slice(0, 80), d = String(req.query.d || "").slice(0, 120);
      send(res, await png(`s:${t}:${d}`, () => siteCard(t, d)));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, forMarket, forBounty, forProfile, forPage, origin };
