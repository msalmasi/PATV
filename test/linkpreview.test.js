// Offline tests for link previews' SSRF protection (linkpreview.js, 1.99bv): schemes, ports and
// credentials; private / loopback / link-local / metadata / IPv6 / mapped / encoded addresses; DNS
// answers checked (all of them, and again at connect time: rebinding); redirects re-checked; size,
// time and encoding caps; meta parsing. A local fixture server stands in for "the internet": only its
// exact address + port are whitelisted through the test-only hook.
//   node --test test/linkpreview.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const lp = require(path.join(path.resolve(__dirname, ".."), "linkpreview"));

let server, port;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000000000200015e2c0a5a0000000049454e44ae426082", "hex");
test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<html><head><title>Fallback &amp; title</title>
        <meta property="og:title" content="Frogs &amp; Friends &#8212; live">
        <meta name="description" content="A page about &quot;frogs&quot;">
        <meta property="og:site_name" content="FrogNet">
        <meta property="og:image" content="http://img.example.com:${port}/i.png">
        </head><body>hi</body></html>`);
    }
    if (u.pathname === "/i.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
    if (u.pathname === "/to-localhost") { res.writeHead(301, { location: `http://localhost:${port}/page` }); return res.end(); }
    if (u.pathname === "/to-loop2") { res.writeHead(302, { location: `http://127.0.0.2:${port}/page` }); return res.end(); }
    if (u.pathname === "/to-file") { res.writeHead(302, { location: "file:///etc/passwd" }); return res.end(); }
    if (u.pathname === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
    if (u.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<title>Big one</title>");
      const chunk = "x".repeat(64 * 1024);
      let n = 0;
      const pump = () => { while (n < 64) { n++; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
      res.on("error", () => {});
      return pump();
    }
    if (u.pathname === "/slow") { return setTimeout(() => { try { res.end("late"); } catch (e) { /* closed */ } }, 3000); }
    if (u.pathname === "/gz") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); return res.end(Buffer.from([0x1f, 0x8b, 0, 0])); }
    if (u.pathname === "/404") { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": "text/plain" }); res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.3", r));
  port = server.address().port;
  lp._testAllow("127.0.0.3", port);            // the fixture only: 127.0.0.1/.2, ::1, 10.x, 169.254.x stay blocked
});
test.after(() => server.close());

// fake DNS: *.example.com -> the fixture (or whatever a test says)
const fakeDns = (map) => async (host) => {
  const v = map[host];
  if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return (Array.isArray(v) ? v : [v]).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
};
const DNS = fakeDns({ "page.example.com": "127.0.0.3", "img.example.com": "127.0.0.3", "redir.example.com": "127.0.0.3" });

test("addresses: only public unicast passes", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.ok(lp.isPublicIp(ip), ip);
  for (const ip of ["127.0.0.2", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.149", "169.254.169.254", "100.64.0.1", "100.73.124.19",
                    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
                    "::ffff:127.0.0.2", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::127.0.0.2", "0:0:0:0:0:ffff:7f00:2", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "ff02::1", "not-an-ip"]) {
    assert.equal(lp.isPublicIp(ip), false, ip);
  }
});

test("urls: http(s) only, normal ports, no credentials, odd encodings normalised then checked", async () => {
  for (const bad of ["ftp://example.com/x", "javascript:alert(1)", "file:///etc/passwd", "gopher://x.y/", "data:text/html,hi",
                     "https://user:pw@example.com/", "https://example.com:8080/", "http://example.com:22/", "https://exa mple.com/",
                     "https://example.com/<script>", "x".repeat(3000)]) {
    assert.throws(() => lp.checkUrl(bad), lp.PreviewError, bad.slice(0, 40));
  }
  assert.equal(lp.checkUrl("example.com/a#frag").toString(), "https://example.com/a");
  // integer / octal / hex / short forms of loopback and the metadata address all resolve to blocked IPs
  for (const enc of ["http://2130706433/", "http://0177.0.0.1/", "http://0x7f.1/", "http://127.1/", "http://[::1]/", "http://[::ffff:169.254.169.254]/",
                     "http://169.254.169.254/latest/meta-data/", "http://2852039166/", "http://localhost/", "http://foo.localhost/", "http://router.lan/",
                     "http://metadata.google.internal/"]) {
    const u = lp.checkUrl(enc);
    await assert.rejects(lp.resolvePublic(u.hostname, DNS), (e) => e instanceof lp.PreviewError && e.code === "private", enc);
  }
});

test("DNS: every answer must be public (a public + private mix is refused)", async () => {
  const dns = fakeDns({ "mixed.example.com": ["93.184.216.34", "10.0.0.5"], "priv.example.com": "192.168.0.10", "v6.example.com": "::1" });
  for (const h of ["mixed.example.com", "priv.example.com", "v6.example.com"]) {
    await assert.rejects(lp.resolvePublic(h, dns), (e) => e.code === "private", h);
  }
  await assert.rejects(lp.resolvePublic("nx.example.com", dns), (e) => e.code === "dns");
});

test("DNS rebinding: the address is re-resolved and re-checked when the socket connects", async () => {
  let calls = 0;
  const flip = async () => { calls++; return [{ address: calls === 1 ? "127.0.0.3" : "10.0.0.7", family: 4 }]; };
  await assert.rejects(lp.preview(`http://rebind.example.com:${port}/page`, { lookup: flip, timeoutMs: 2000 }), (e) => e.code === "private");
  assert.ok(calls >= 2);
});

test("a normal page: title/description/site/image parsed, the image fetched through the same guard", async () => {
  const r = await lp.preview(`http://page.example.com:${port}/page`, { lookup: DNS });
  assert.equal(r.title, "Frogs & Friends — live");
  assert.equal(r.description, 'A page about "frogs"');
  assert.equal(r.site, "FrogNet");
  assert.equal(r.domain, "page.example.com");
  assert.ok(Buffer.isBuffer(r.image) && r.image.equals(PNG));
});

test("redirects are followed and re-checked: to the metadata IP, localhost, another loopback, file: - all refused", async () => {
  for (const p of ["/to-metadata", "/to-localhost", "/to-loop2"]) {
    await assert.rejects(lp.preview(`http://redir.example.com:${port}${p}`, { lookup: DNS }), (e) => e instanceof lp.PreviewError && e.code === "private", p);
  }
  await assert.rejects(lp.preview(`http://redir.example.com:${port}/to-file`, { lookup: DNS }), lp.PreviewError);
  await assert.rejects(lp.preview(`http://redir.example.com:${port}/loop`, { lookup: DNS }), (e) => e.code === "redirect");
});

test("caps: a huge page is cut at 512 KB, a slow one times out, compressed bodies are refused, errors are friendly", async () => {
  const big = await lp.safeGet(`http://page.example.com:${port}/big`, { lookup: DNS });
  assert.ok(big.truncated);
  assert.equal(big.body.length, lp.HTML_MAX);
  const t0 = Date.now();
  await assert.rejects(lp.safeGet(`http://page.example.com:${port}/slow`, { lookup: DNS, timeoutMs: 400 }), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 2500);
  await assert.rejects(lp.safeGet(`http://page.example.com:${port}/gz`, { lookup: DNS }), (e) => e.code === "encoding");
  await assert.rejects(lp.safeGet(`http://page.example.com:${port}/404`, { lookup: DNS }), (e) => e.code === "status");
});

test("YouTube / Twitch links carry the stage's sanitised embed even when the page can't be fetched", async () => {
  const r = await lp.preview("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { lookup: fakeDns({}) , fetchImage: false });
  assert.deepEqual(r.embed, { p: "youtube", t: "video", id: "dQw4w9WgXcQ" });
  const t = await lp.preview("https://twitch.tv/SomeStreamer", { lookup: fakeDns({}) });
  assert.deepEqual(t.embed, { p: "twitch", t: "channel", id: "somestreamer" });
});

test("meta parsing is bounded and never returns markup or non-http image links", () => {
  const m = lp.parseMeta(`<meta property="og:title" content="<script>x</script>  spaced\n\ttitle"><meta property="og:image" content="javascript:alert(1)">`, "https://a.b/");
  assert.equal(m.title, "<script>x</script> spaced title");      // plain text: the templates escape it
  assert.equal(m.imageUrl, null);
  assert.equal(lp.parseMeta('<meta property="og:image" content="/rel.png">', "https://a.b/x/").imageUrl, "https://a.b/rel.png");
});
