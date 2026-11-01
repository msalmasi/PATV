// pa.tv as one of the site's own hosts (sharelinks.js canonicalUrl / ownAliasHosts / ALIAS_HOSTS) and the SHORT_LINK_BASE
// allow-list. Cloudflare 302-redirects every https://pa.tv/<path>?<query> to https://publicaccess.tv/<same>, always, so a
// pasted pa.tv link is treated as the publicaccess.tv link it is - except on staging, where pa.tv is prod's.
//   node --test test/share-links-alias.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const repo = path.resolve(__dirname, "..");
const SL = require(path.join(repo, "sharelinks"));

const KEYS = ["STAGING", "SHORT_LINK_BASE", "SITE_URL", "PUBLIC_BASE_URL", "DM_EMBED_HOSTS"];
function withEnv(env, fn) {
  const old = {};
  for (const k of KEYS) { old[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const done = () => { for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = fn(); } catch (e) { done(); throw e; }
  if (r && typeof r.then === "function") return r.finally(done);
  done();
  return r;
}
const PROD = {}, STAGING = { STAGING: "1" };

test("activeBase: only the allow-listed short origin, never on staging", () => withEnv(PROD, () => {
  assert.equal(SL.activeBase(), "");
  for (const ok of ["https://pa.tv", "https://pa.tv/", "HTTPS://PA.TV", " https://pa.tv/ "]) {
    process.env.SHORT_LINK_BASE = ok;
    assert.equal(SL.activeBase(), "https://pa.tv", ok);
    assert.equal(SL.shareUrl("/p/x?a=1#live"), "https://pa.tv/p/x?a=1#live", ok);
  }
  // any other HTTPS host is refused now (it used to be accepted - an admin-only setting, but still): canonical links
  for (const bad of ["https://short.example", "https://pa.tv.evil.com", "https://evilpa.tv", "https://pa.tv:443", "https://pa.tv:8443",
                     "https://pa.tv//", "https://www.pa.tv", "https://publicaccess.tv", "http://pa.tv", "https://pa.tv/p", "https://u@pa.tv",
                     "https://pa.tv@evil.com", "https://pa.tv\\", "https://pa%2etv", "pa.tv", "junk"]) {
    process.env.SHORT_LINK_BASE = bad;
    assert.equal(SL.activeBase(), "", bad);
    assert.equal(SL.shareBase(), "https://publicaccess.tv", bad);
  }
  process.env.SHORT_LINK_BASE = "https://pa.tv";
  process.env.STAGING = "1";
  assert.equal(SL.activeBase(), "");
  assert.equal(SL.shareBase(), "https://staging.publicaccess.tv");
}));

test("canonicalUrl: pa.tv links become their publicaccess.tv address, path / query / fragment kept", () => withEnv(PROD, () => {
  const C = SL.canonicalUrl;
  const same = {
    "https://pa.tv/p/x?a=1#live": "https://publicaccess.tv/p/x?a=1#live",
    "http://pa.tv/p/x": "https://publicaccess.tv/p/x",                       // http too (the redirect is on both)
    "HTTPS://PA.TV/P/Mixed-Case": "https://publicaccess.tv/P/Mixed-Case",   // host any case, path untouched
    "https://pa.tv": "https://publicaccess.tv/",
    "https://pa.tv./feed": "https://publicaccess.tv/feed",                  // one trailing dot
    "https://pa.tv:443/x": "https://publicaccess.tv/x",                      // the default port
    "http://pa.tv:80/x": "https://publicaccess.tv/x",
    "https://pa%2Etv/x": "https://publicaccess.tv/x",                        // an encoded host decodes as a browser does
    "https://pa.tv\\p\\x": "https://publicaccess.tv/p/x",                    // backslashes are slashes in a browser too
    "https://pa.tv/p/x/../y": "https://publicaccess.tv/p/y",
    "  https://pa.tv/u/ann  ": "https://publicaccess.tv/u/ann",
    // www.pa.tv: the same Cloudflare rule (host in {pa.tv, www.pa.tv}) redirects it too
    "https://www.pa.tv/p/lounge/posts/AbCdEf12": "https://publicaccess.tv/p/lounge/posts/AbCdEf12",
    "http://WWW.PA.TV/markets/12?a=1#x": "https://publicaccess.tv/markets/12?a=1#x",
    "https://www.pa.tv./feed": "https://publicaccess.tv/feed",
    "https://www.pa.tv:443/x": "https://publicaccess.tv/x",
  };
  for (const [a, b] of Object.entries(same)) {
    assert.equal(C(a), b, a);
    assert.equal(SL.isOwnAlias(a), true, a);
  }
  // not pa.tv (or not a plain link to it): left exactly as given
  for (const s of ["https://pa.tv.evil.com/p/x", "https://evilpa.tv/p/x", "https://pa.tv@evil.com/p/x", "https://user:pass@pa.tv/p/x",
                   "https://user@pa.tv/p/x", "https://:pw@pa.tv/x", "https://pa.tv:8443/p/x", "http://pa.tv:443/x", "https://pa.tv:80/x",
                   "https://evil.com\\@pa.tv/x", "https://evil.com/pa.tv", "https://evil.com/?u=https://pa.tv/x", "https://pa.tv%2f@evil.com/",
                   "https://pa.tv%40evil.com/", "ftp://pa.tv/x", "javascript:pa.tv", "//pa.tv/x", "/p/x", "pa.tv/p/x", "https://publicaccess.tv/p/x",
                   "https://staging.publicaccess.tv/p/x", "https://pa.tvx/", "https://p a.tv/", "https://www.pa.tv.evil.com/x",
                   "https://wwwpa.tv/x", "https://www.www.pa.tv/x", "https://ww.pa.tv/x", "https://www.pa.tv@evil.com/x",
                   "https://www.pa.tv:8443/x", "https://u@www.pa.tv/x", "https://evil.com/www.pa.tv", ""]) {
    assert.equal(C(s), s, s);
    assert.equal(SL.isOwnAlias(s), false, s);
  }
  for (const v of [null, undefined, 5, {}]) assert.equal(C(v), v);
  // scheme-less only when asked (inputs that already take a scheme-less publicaccess.tv/<path>)
  const S = (s) => C(s, { schemeless: true });
  assert.equal(S("pa.tv/p/x?a=1"), "https://publicaccess.tv/p/x?a=1");
  assert.equal(S("PA.TV/p/x"), "https://publicaccess.tv/p/x");
  assert.equal(S("pa.tv"), "https://publicaccess.tv/");
  assert.equal(S("pa.tv#x"), "https://publicaccess.tv/#x");
  assert.equal(S("www.pa.tv/p/x?a=1"), "https://publicaccess.tv/p/x?a=1");
  assert.equal(S("WWW.PA.TV"), "https://publicaccess.tv/");
  for (const s of ["pa.tv.evil.com/x", "pa.tv@evil.com/x", "pa.tv:8443/x", "evilpa.tv/x", "pa.tvx/x", "pa.tv\\@evil.com",
                   "www.pa.tv.evil.com/x", "wwwpa.tv/x", "www.www.pa.tv/x", "www.pa.tv@evil.com/x", "www.pa.tvx/x"]) assert.equal(S(s), s, s);
  assert.equal(SL.isAliasHost("PA.TV."), true);
  assert.equal(SL.isAliasHost("www.pa.tv"), true);
  assert.equal(SL.isAliasHost("WWW.PA.TV."), true);
  for (const h of ["pa.tv.evil.com", "www.pa.tv.evil.com", "wwwpa.tv", "www.www.pa.tv", "evilpa.tv"]) assert.equal(SL.isAliasHost(h), false, h);
  assert.deepEqual(SL.ownAliasHosts(), ["pa.tv", "www.pa.tv"]);
  // SHORT_LINK_BASE still names the apex only - the www host is a redirect alias, never the base
  assert.deepEqual([...SL.SHORT_ORIGINS], ["https://pa.tv"]);
}));

test("staging: pa.tv points at prod, so it is not one of staging's own links", () => withEnv(STAGING, () => {
  assert.equal(SL.aliasActive(), false);
  assert.deepEqual(SL.ownAliasHosts(), []);
  assert.equal(SL.canonicalUrl("https://pa.tv/p/x"), "https://pa.tv/p/x");
  assert.equal(SL.canonicalUrl("https://www.pa.tv/p/x"), "https://www.pa.tv/p/x");
  assert.equal(SL.canonicalUrl("pa.tv/p/x", { schemeless: true }), "pa.tv/p/x");
  assert.equal(SL.isOwnAlias("https://pa.tv/p/x"), false);
  assert.equal(SL.isAliasHost("pa.tv"), true);          // still a PATV host (onairmedia's live deny list)
}));

test("DM post cards (dmembeds.postIds): pa.tv post links get their card; look-alikes and staging don't", () => {
  const dm = require(path.join(repo, "dmembeds"));
  withEnv(PROD, () => {
    assert.ok(dm.siteHosts().has("pa.tv"));
    assert.deepEqual(dm.postIds("look https://pa.tv/p/room1/posts/PostOk01/great-clip and http://PA.TV/feed/p/PostNsf1."), ["PostOk01", "PostNsf1"]);
    assert.deepEqual(dm.postIds("https://pa.tv/u/ann/posts/PostAbc9"), ["PostAbc9"]);
    // www.pa.tv redirects the same way (one Cloudflare rule for both hosts)
    assert.ok(dm.siteHosts().has("www.pa.tv"));
    assert.deepEqual(dm.postIds("see https://www.pa.tv/p/lounge/posts/AbCdEf12 and HTTP://WWW.PA.TV/feed/p/PostWww2"), ["AbCdEf12", "PostWww2"]);
    assert.deepEqual(dm.postIds("https://pa.tv.evil.com/p/r/posts/PostOk01 https://evilpa.tv/feed/p/PostOk02 https://pa.tv@evil.com/feed/p/PostOk03 " +
                                "https://pa.tv:8443/feed/p/PostOk04 https://pa.tv/p/somepad"), []);
    assert.deepEqual(dm.postIds("https://www.pa.tv.evil.com/feed/p/PostOk01 https://wwwpa.tv/feed/p/PostOk02 https://www.pa.tv@evil.com/feed/p/PostOk03"), []);
    assert.deepEqual(dm.postIds("https://publicaccess.tv/feed/p/PostOk01"), ["PostOk01"]);     // unchanged
  });
  withEnv(STAGING, () => {
    assert.equal(dm.siteHosts().has("pa.tv"), false);
    assert.equal(dm.siteHosts().has("www.pa.tv"), false);
    assert.deepEqual(dm.postIds("https://pa.tv/p/room1/posts/PostOk01 https://www.pa.tv/p/room1/posts/PostOk02"), []);
    assert.deepEqual(dm.postIds("https://staging.publicaccess.tv/feed/p/PostOk01"), ["PostOk01"]);
  });
});

test("frozen-preview gate (embedcards.liveRef): a pa.tv link to a market / bounty / poll / raffle is matched like ours", () => {
  const ec = require(path.join(repo, "embedcards"));
  withEnv(PROD, () => {
    assert.equal(ec.liveRef("https://pa.tv/markets/5"), "M5");
    assert.equal(ec.liveRef("http://PA.TV./bounties/bt3/"), "BT3");
    assert.equal(ec.liveRef("https://pa.tv/polls/poll_ab"), "P:poll_ab");
    assert.equal(ec.liveRef("https://pa.tv/raffles/7"), "R7");
    assert.equal(ec.liveRef("https://www.pa.tv/markets/12"), "M12");
    assert.equal(ec.liveRef("https://evilpa.tv/markets/5"), null);
    assert.equal(ec.liveRef("https://pa.tv.evil.com/markets/5"), null);
    assert.equal(ec.liveRef("https://www.pa.tv.evil.com/markets/5"), null);
    assert.equal(ec.liveRef("https://wwwpa.tv/markets/5"), null);
  });
  withEnv(STAGING, () => {
    assert.equal(ec.liveRef("https://pa.tv/markets/5"), null);
    assert.equal(ec.liveRef("https://www.pa.tv/markets/5"), null);
  });
});

test("feed live cards (public/js/embed-cards.js): every short alias is an own host off staging only", () => {
  const client = require(path.join(repo, "public", "js", "embed-cards.js"));
  // the browser list is a hand-kept copy of sharelinks.ALIAS_HOSTS: the two must not drift apart
  assert.deepEqual(client.ALIASES, [...SL.ALIAS_HOSTS], "public/js/embed-cards.js ALIASES == sharelinks.ALIAS_HOSTS");
  assert.ok(SL.ALIAS_HOSTS.includes("www.pa.tv"), "www.pa.tv redirects like pa.tv");
  const prod = client.ownHosts("publicaccess.tv"), stg = client.ownHosts("staging.publicaccess.tv");
  assert.ok(prod.includes("publicaccess.tv") && stg.includes("staging.publicaccess.tv"));
  const base = "https://publicaccess.tv/feed";
  for (const a of SL.ALIAS_HOSTS) {
    assert.ok(prod.includes(a), a);
    assert.ok(!stg.includes(a), a);
    assert.equal(client.refFromHref(`https://${a}/markets/12`, base, prod), "M12", a);
    assert.equal(client.refFromHref(`https://${a.toUpperCase()}/raffles/r4`, base, prod), "R4", a);
    assert.equal(client.refFromHref(`https://${a}/markets/12`, "https://staging.publicaccess.tv/feed", stg), null, a);
    for (const h of [`https://u@${a}/markets/12`, `https://${a}:8443/markets/12`, `https://evil${a}/markets/12`, `https://${a}.evil.com/markets/12`]) {
      assert.equal(client.refFromHref(h, base, prod), null, h);
    }
  }
  assert.equal(client.refFromHref("https://wwwpa.tv/markets/12", base, prod), null);
  const src = fs.readFileSync(path.join(repo, "public", "js", "embed-cards.js"), "utf8");
  assert.match(src, /var hosts = ownHosts\(location\.hostname\);/, "scan() uses the alias-aware host list");
  assert.match(fs.readFileSync(path.join(repo, "views", "partials", "feed-js.ejs"), "utf8"), /embed-cards\.js\?v=5/, "cache version bumped");
});

test("unfurler (linkpreview.checkUrl): fetches the publicaccess.tv address, never pa.tv's redirect", async () => {
  const lp = require(path.join(repo, "linkpreview"));
  withEnv(PROD, () => {
    assert.equal(lp.checkUrl("https://pa.tv/p/x?a=1#frag").toString(), "https://publicaccess.tv/p/x?a=1");
    assert.equal(lp.checkUrl("pa.tv/markets/5").toString(), "https://publicaccess.tv/markets/5");   // checkUrl adds the scheme itself
    assert.equal(lp.checkUrl("http://PA.TV/x").toString(), "https://publicaccess.tv/x");
    assert.equal(lp.checkUrl("https://www.pa.tv/markets/5?a=1").toString(), "https://publicaccess.tv/markets/5?a=1");
    assert.equal(lp.checkUrl("www.pa.tv/x").toString(), "https://publicaccess.tv/x");
    assert.equal(lp.checkUrl("https://evilpa.tv/x").toString(), "https://evilpa.tv/x");
    assert.equal(lp.checkUrl("https://wwwpa.tv/x").toString(), "https://wwwpa.tv/x");
    assert.throws(() => lp.checkUrl("https://user@pa.tv/x"), lp.PreviewError);
  });
  withEnv(STAGING, () => assert.equal(lp.checkUrl("https://pa.tv/p/x").toString(), "https://pa.tv/p/x"));
  // a preview and a redirect hop that lands on pa.tv both resolve publicaccess.tv, never pa.tv
  const server = http.createServer((req, res) => { res.writeHead(302, { location: "https://pa.tv/p/x" }); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.3", r));
  const port = server.address().port;
  lp._testAllow("127.0.0.3", port);
  try {
    await withEnv(PROD, async () => {
      const seen = [];
      const dns = async (host) => {
        seen.push(host);
        if (host === "redir.example.com") return [{ address: "127.0.0.3", family: 4 }];
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      };
      await assert.rejects(lp.preview("https://pa.tv/p/x", { lookup: dns, fetchImage: false }), (e) => e.code === "dns");
      assert.deepEqual(seen, ["publicaccess.tv"]);
      seen.length = 0;
      await assert.rejects(lp.safeGet(`http://redir.example.com:${port}/go`, { lookup: dns }), (e) => e.code === "dns");
      assert.deepEqual(seen, ["redir.example.com", "redir.example.com", "publicaccess.tv"]);
    });
  } finally { server.close(); }
});

test("Pepe's stream (onairmedia.liveDenied / checkLive): pa.tv can't go on air as a live page, on prod or staging", async () => {
  const M = require(path.join(repo, "onairmedia"));
  const refusedDenied = (e) => e && e.refuse && e.code === "denied";
  const noDns = async () => { throw new Error("no DNS in this test"); };
  for (const env of [PROD, STAGING]) {
    await withEnv(env, async () => {
      assert.equal(M.liveDenied("pa.tv"), true);
      assert.equal(M.liveDenied("www.pa.tv"), true);
      assert.equal(M.liveDenied("evilpa.tv"), false);
      for (const u of ["https://pa.tv/p/x", "http://PA.TV/", "pa.tv/feed"]) await assert.rejects(M.checkLive(u, {}, { lookup: noDns }), refusedDenied, u);
    });
  }
});

test("sign-in return paths stay local: no host is accepted, pa.tv included", () => {
  const guard = require(path.join(repo, "middleware", "authGuard"));
  for (const v of ["https://pa.tv/wallet", "//pa.tv/wallet", "http://pa.tv", "pa.tv/wallet", "/\\pa.tv/x"]) assert.equal(guard.safeNext(v), null, v);
  assert.equal(guard.safeNext("/wallet?tab=x"), "/wallet?tab=x");
});

test("the pad's Copy link uses the share helper (short when the switch is on, else this origin)", () => {
  const src = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(src, /var url = window\.PATVShare \? window\.PATVShare\.url\(path\) : location\.origin \+ path/);
});
