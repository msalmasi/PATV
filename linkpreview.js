// linkpreview.js — link previews for feed posts (1.99bv): a server-side fetch of a pasted link that
// pulls the page's title, description, site name and preview image, with SSRF protection.
//
// Safety rules (everything a user pastes is hostile until proven otherwise):
//   * http / https only, ports 80 / 443 only, no user:password@, at most 2048 chars
//   * the host is resolved here, and EVERY address it resolves to must be public unicast: no
//     loopback, private (RFC 1918), CGNAT, link-local (cloud metadata 169.254.169.254), multicast,
//     reserved, documentation, benchmark, unique-local / site-local IPv6, NAT64 or IPv4-mapped forms
//     of any of those. The connection then goes to the address we checked (the `lookup` hook hands
//     the socket that exact address), so a DNS answer that changes between check and connect
//     (rebinding) can't slip through.
//   * redirects are followed by hand, at most 3, and every hop is checked again
//   * 5 s for the whole fetch, the body is cut off after 512 KB (HTML) or 5 MB (an image); anything
//     compressed is refused rather than inflated (Accept-Encoding: identity)
//   * only text/html (or xhtml) is parsed; a direct image link becomes an image preview
//   * the preview IMAGE is fetched the same way and re-encoded to a small webp by the caller
//     (feedmedia.js) - viewers never load a third-party image (no tracking pixels, no IP leaks)
//
// YouTube / Twitch links are recognised by stageembed.parse (the stage's sanitizer) and carry a
// click-to-play embed {p, t, id}; their page title is still fetched for the card.
"use strict";
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");

const MAX_URL = 2048;
const HTML_MAX = 512 * 1024;
const IMAGE_MAX = 5 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (compatible; PATVLinkPreview/1.0; +https://publicaccess.tv/about)";

class PreviewError extends Error {
  constructor(msg, code) { super(msg); this.code = code || "bad_link"; }
}

// ── address checks ──
// two lists: Node's BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules
const BLOCK4 = new net.BlockList(), BLOCK6 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32],
]) BLOCK4.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) BLOCK6.addSubnet(a, p, "ipv6");

/** "::ffff:a9fe:a9fe" -> [0,0,0,0,0,0xffff,0xa9fe,0xa9fe] (null if not IPv6) */
function v6groups(ip) {
  let s = String(ip).toLowerCase().split("%")[0];
  const m4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m4) {
    const o = m4[2].split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    s = m4[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const g = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail].map((x) => parseInt(x || "0", 16));
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}

// tests only: addresses treated as public (a local fixture server on 127.0.0.1). Empty in production.
const TEST_ALLOW = new Set(), TEST_PORTS = new Set();
function _testAllow(ip, port) { if (process.env.NODE_ENV === "production") return; TEST_ALLOW.add(ip); if (port) TEST_PORTS.add(String(port)); }

/** true when `ip` (a literal) is a public unicast address we may connect to. */
function isPublicIp(ip) {
  const fam = net.isIP(String(ip || ""));
  if (!fam) return false;
  if (TEST_ALLOW.size && TEST_ALLOW.has(String(ip).replace(/^::ffff:/i, ""))) return true;
  const s = String(ip);
  if (fam === 6) {
    const g = v6groups(s);
    if (!g) return false;
    // IPv4-mapped (::ffff:a.b.c.d, in any spelling) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] || g[7] > 1)))) {
      return isPublicIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    return !BLOCK6.check(s, "ipv6");
  }
  return !BLOCK4.check(s, "ipv4");
}

/** Resolve a hostname; every answer must be public. Returns the list ([{address, family}]). */
async function resolvePublic(host, lookup = dns.promises.lookup) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  if (net.isIP(h)) {
    if (!isPublicIp(h)) throw new PreviewError("That link points at a private address.", "private");
    return [{ address: h, family: net.isIP(h) }];
  }
  if (!/^[a-z0-9.-]{1,253}$/i.test(h) || !h.includes(".") || /\.(local|localhost|internal|lan|home|arpa|test|invalid|onion)$/i.test(h) || /^localhost$/i.test(h)) {
    throw new PreviewError("That link's host isn't a public website.", "private");
  }
  let addrs;
  try { addrs = await lookup(h, { all: true, verbatim: true }); } catch (e) { throw new PreviewError("Couldn't find that website.", "dns"); }
  if (!addrs || !addrs.length) throw new PreviewError("Couldn't find that website.", "dns");
  for (const a of addrs) if (!isPublicIp(a.address)) throw new PreviewError("That link points at a private address.", "private");
  return addrs;
}

/** Normalise a pasted link -> URL object (throws PreviewError). */
function checkUrl(input) {
  let s = String(input == null ? "" : input).trim();
  if (!s) throw new PreviewError("Paste a link first.");
  if (s.length > MAX_URL) throw new PreviewError("That link is too long.");
  if (/[\s<>"'`\\\u0000-\u001f\u007f]/.test(s)) throw new PreviewError("That doesn't look like a link.");
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9.-]+:\d+/i.test(s)) throw new PreviewError("Only http and https links.");
    s = "https://" + s;
  }
  let u;
  try { u = new URL(s); } catch (e) { throw new PreviewError("That doesn't look like a link."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new PreviewError("Only http and https links.");
  if (u.username || u.password) throw new PreviewError("Links with a username or password aren't allowed.");
  if (u.port && u.port !== "80" && u.port !== "443" && !TEST_PORTS.has(u.port)) throw new PreviewError("Only links on the normal web ports.");
  u.hash = "";
  return u;
}

// ── one guarded GET ──
function getOnce(u, { maxBytes, accept, lookup, deadline }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let picked = null;
    const req = lib.request({
      protocol: u.protocol, hostname: host, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "GET", servername: net.isIP(host) ? undefined : host,
      headers: { "User-Agent": UA, Accept: accept, "Accept-Encoding": "identity", "Accept-Language": "en;q=0.9,*;q=0.5" },
      // the socket connects to the address we checked - resolved again here, every answer re-checked
      lookup: (hostname, opts, cb) => {
        resolvePublic(hostname, lookup).then((addrs) => {
          picked = addrs[0];
          if (opts && opts.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
          else cb(null, picked.address, picked.family);
        }, (e) => cb(e));
      },
      agent: false,
    });
    const left = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => { req.destroy(new PreviewError("That website took too long to answer.", "timeout")); }, left);
    req.on("error", (e) => { clearTimeout(timer); reject(e instanceof PreviewError ? e : new PreviewError("Couldn't load that link.", "fetch")); });
    req.on("socket", (sock) => {
      sock.on("connect", () => {
        // belt and braces: the peer we actually reached must be public too
        if (!isPublicIp(sock.remoteAddress)) req.destroy(new PreviewError("That link points at a private address.", "private"));
      });
    });
    req.on("response", (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        return resolve({ redirect: String(res.headers.location), status });
      }
      if (status < 200 || status >= 300) {
        res.resume(); clearTimeout(timer);
        return reject(new PreviewError(`That website answered ${status}.`, "status"));
      }
      const enc = String(res.headers["content-encoding"] || "identity").toLowerCase();
      if (enc !== "identity" && enc !== "") { res.destroy(); clearTimeout(timer); return reject(new PreviewError("Couldn't read that page.", "encoding")); }
      const len = Number(res.headers["content-length"] || 0);
      const ct = String(res.headers["content-type"] || "").toLowerCase();
      const chunks = [];
      let got = 0, cut = false;
      if (len && len > maxBytes && !/text\/html|xhtml/.test(ct)) {
        res.destroy(); clearTimeout(timer);
        return reject(new PreviewError("That file is too big to preview.", "size"));
      }
      res.on("data", (c) => {
        if (cut) return;
        got += c.length;
        if (got > maxBytes) {
          cut = true;
          chunks.push(c.subarray(0, c.length - (got - maxBytes)));
          res.destroy();
          clearTimeout(timer);
          return resolve({ status, ct, body: Buffer.concat(chunks), truncated: true, url: u.toString() });
        }
        chunks.push(c);
      });
      res.on("end", () => { clearTimeout(timer); if (!cut) resolve({ status, ct, body: Buffer.concat(chunks), truncated: false, url: u.toString() }); });
      res.on("error", () => { clearTimeout(timer); if (!cut) reject(new PreviewError("Couldn't load that link.", "fetch")); });
    });
    req.end();
  });
}

/** GET with redirects, every hop checked. opts: {maxBytes, accept, lookup, timeoutMs} */
async function safeGet(input, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs || TIMEOUT_MS);
  let u = input instanceof URL ? input : checkUrl(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await resolvePublic(u.hostname, opts.lookup);            // fail fast before opening a socket
    const r = await getOnce(u, { maxBytes: opts.maxBytes || HTML_MAX, accept: opts.accept || "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
                                 lookup: opts.lookup, deadline });
    if (!r.redirect) return r;
    let next;
    try { next = new URL(r.redirect, u); } catch (e) { throw new PreviewError("That link redirects somewhere odd.", "redirect"); }
    u = checkUrl(next.toString());
  }
  throw new PreviewError("That link redirects too many times.", "redirect");
}

// ── HTML meta parsing (no DOM: small, bounded regexes over the first 512 KB) ──
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z0-9]{2,8});/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
  });
}
const tidy = (s, n) => decodeEntities(s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : null;
}

function parseMeta(html, baseUrl) {
  const head = String(html || "").slice(0, HTML_MAX);
  const meta = {};
  const tags = head.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*'){0,2000}>/gi) || [];
  for (const t of tags.slice(0, 400)) {
    const key = (attr(t, "property") || attr(t, "name") || "").toLowerCase();
    const val = attr(t, "content");
    if (key && val != null && !(key in meta)) meta[key] = val;
  }
  const titleTag = (head.match(/<title[^>]*>([\s\S]{0,600}?)<\/title>/i) || [])[1] || "";
  let image = meta["og:image:secure_url"] || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["twitter:image:src"] || null;
  let imageUrl = null;
  if (image) {
    try {
      const iu = new URL(decodeEntities(image).trim(), baseUrl);
      if (iu.protocol === "https:" || iu.protocol === "http:") imageUrl = iu.toString().slice(0, MAX_URL);
    } catch (e) { imageUrl = null; }
  }
  return {
    title: tidy(meta["og:title"] || meta["twitter:title"] || titleTag, 200),
    description: tidy(meta["og:description"] || meta["twitter:description"] || meta.description || "", 300),
    site: tidy(meta["og:site_name"] || "", 80),
    imageUrl,
  };
}

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch (e) { return ""; } };

/**
 * Preview a link: {url, domain, title, description, site, imageUrl, image: Buffer|null, embed}.
 * `fetchImage` (default true) also downloads the preview image (bounded) for the caller to re-encode.
 * opts.lookup lets tests fake DNS.
 */
async function preview(input, opts = {}) {
  const u = checkUrl(input);
  const out = { url: u.toString(), domain: domainOf(u.toString()), title: "", description: "", site: "", imageUrl: null, image: null, embed: null };
  try { out.embed = require("./stageembed").parse(u.toString()); } catch (e) { out.embed = null; }
  let r;
  try {
    r = await safeGet(u, { lookup: opts.lookup, timeoutMs: opts.timeoutMs });
  } catch (e) {
    if (out.embed) return out;          // a YouTube/Twitch link still embeds without its title
    throw e;
  }
  out.url = r.url;
  out.domain = domainOf(r.url);
  if (/^image\//.test(r.ct)) {
    // a direct image link: the image IS the preview (fetched again with the image cap)
    out.imageUrl = r.url;
  } else if (/text\/html|application\/xhtml/.test(r.ct) || !r.ct) {
    Object.assign(out, parseMeta(r.body.toString("utf8"), r.url));
  }
  if (!out.title) out.title = out.site || out.domain;
  if (out.imageUrl && opts.fetchImage !== false) {
    try {
      const im = await safeGet(out.imageUrl, { maxBytes: IMAGE_MAX, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8", lookup: opts.lookup, timeoutMs: opts.timeoutMs });
      if (/^image\//.test(im.ct) && !im.truncated && im.body.length) out.image = im.body;
    } catch (e) { out.image = null; }
  }
  return out;
}

module.exports = { preview, safeGet, checkUrl, isPublicIp, resolvePublic, parseMeta, decodeEntities, domainOf, PreviewError,
                   HTML_MAX, IMAGE_MAX, TIMEOUT_MS, _testAllow };
