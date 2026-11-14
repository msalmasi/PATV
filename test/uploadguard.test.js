// 1.99anw uploadguard.js: the site's two multer routes - a member's profile photo (POST /api/u/:username/update/avatar) and the
// admin badge form (POST /api/badges/add) - in a CHILD process (test/fixtures/uploadguard-server.js: index.js's pieces in index.js's
// order, pinned below). The review's hostile bodies - each cap followed by a malformed part header, too many files, a file part with
// no closing boundary (multer 1.4.5-lts.1's uncaught "Unexpected end of form"), a form without the picture (req.file.path threw - an
// unhandled rejection), a cut-off body, an upload that stops half-way - never end the process and are answered 4xx; an anonymous or
// non-manager badge form is refused before its body is read; the normal profile photo (S3 faked) and badge form still work.
//   npm ci (multer 2.5.0), then: NODE_PATH=<repo>/node_modules TZ=UTC node --test test/uploadguard.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uploadguard-test-"));
const SECRET = "uploadguard-test-secret";
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const UG = require(path.join(repo, "uploadguard"));
const rd = (p) => fs.readFileSync(path.join(repo, p), "utf8").replace(/\r\n/g, "\n");

const cookie = (userId, username, cls = null) => "jwt=" + jwt.sign({ userId, username, class: cls }, SECRET, { expiresIn: "1h" });
const MEMBER = cookie("u-member", "member1");
const STAFF = cookie("u-staff", "staff1", "Staff");
const AVATAR = "/api/u/member1/update/avatar";
const BADGE = "/api/badges/add";

// ── multipart bodies, by hand ──
const B = "uploadguardFixture";
const TYPE = "multipart/form-data; boundary=" + B;
const field = (name, value) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
const file = (name, data, type = "image/png", filename = "a.png") => Buffer.concat([
  Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
  Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from("\r\n")]);
const END = Buffer.from(`--${B}--\r\n`);
const MALFORMED = Buffer.from(`--${B}\r\nthis header line has no colon\r\n\r\nx\r\n--${B}--\r\n`);
const body = (...parts) => Buffer.concat(parts);
const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// ── the child ──
let child = null, port = 0, out = "", err = "", exited = null;
async function waitFor(cond, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "fixtures", "uploadguard-server.js")], {
    cwd: tmp, env: { ...process.env, SECRET_KEY: SECRET }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  await waitFor(() => /PORT \d+/.test(out) || exited, "the child to listen");
  assert.equal(exited, null, "the child started: " + err);
  port = Number(/PORT (\d+)/.exec(out)[1]);
});
test.after(() => { if (child && !exited) child.kill(); });
const why = () => err.split("\n").filter((l) => /Error|Unhandled|uncaught/i.test(l)).slice(0, 3).join(" | ") || err.slice(-300);
const alive = (what) => assert.equal(exited, null, `${what}: the process is still running (${JSON.stringify(exited)}; ${why()})`);

/** One request: { status, json, location }. A refused body is answered even while it is still being sent. */
function send(p, { data = Buffer.alloc(0), type = TYPE, cookie: c = MEMBER, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST",
      headers: { "Content-Type": type, "Content-Length": data.length, ...(c ? { Cookie: c } : {}), ...headers } }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { s += d; });
      res.on("end", () => { let json = null; try { json = JSON.parse(s); } catch (_) { json = null; } resolve({ status: res.statusCode, json, location: res.headers.location }); });
    });
    req.on("error", (e) => resolve({ status: "error " + e.code }));
    req.end(data);
  });
}
/** A raw request: the head, then `sent` (part of a body of `length` bytes); resolves with the status line the server answered with
 *  before the rest was sent (or "none" after `waitMs`), then cuts the connection. */
function partial(p, { length, sent, c = null, waitMs = 1500 }) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let got = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => finish("none"), waitMs);
    sock.on("data", (d) => {
      got += d;
      const m = /^HTTP\/1\.1 (\d{3})/.exec(got), loc = /\r\nLocation: ([^\r]+)/i.exec(got);
      if (m && /\r\n\r\n/.test(got)) finish(m[1] + (loc ? " " + loc[1] : ""));
    });
    sock.on("error", () => finish("error"));
    sock.on("connect", () => {
      sock.write(`POST ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: ${TYPE}\r\nContent-Length: ${length}\r\n${c ? "Cookie: " + c + "\r\n" : ""}\r\n`);
      sock.write(sent);
    });
  });
}
const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 140, b: 70 } } }).png().toBuffer();

test("the installed multer is the one package.json pins (2.5.0, one busboy) - run npm ci after pulling this", () => {
  const pkg = JSON.parse(rd("package.json"));
  const lock = JSON.parse(rd("package-lock.json"));
  assert.equal(pkg.dependencies.multer, "2.5.0", "pinned exactly");
  assert.equal(lock.packages[""].dependencies.multer, "2.5.0");
  assert.equal(lock.packages["node_modules/multer"].version, "2.5.0");
  assert.equal(lock.packages["node_modules/busboy"].version, pkg.dependencies.busboy, "plexhook.js's busboy is the one multer uses");
  assert.deepEqual(Object.keys(lock.packages).filter((k) => /(^|\/)busboy$/.test(k)), ["node_modules/busboy"], "one busboy in the tree");
  assert.equal(require("multer/package.json").version, "2.5.0", "node_modules is stale: run npm ci (multer 1.4.5-lts.1 ends the process on these bodies)");
});

test("the profile photo: every hostile body is answered 4xx and the process keeps running", async () => {
  const pic = await png();
  // 178 KB on the wire, 61 Mpx decoded (sharp's own default cap is 268 Mpx - about 0.8 GB a request); imagesafety.js's 60 Mpx
  const bomb = await sharp({ create: { width: 7800, height: 7800, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 1024 * 1024, "small enough for nginx's 1 MB");
  const cases = {
    // the two that ended the process on 19d5e055 first
    no_closing_boundary: [400, body(file("avatar", pic)).subarray(0, -2)],                          // multer 1.4.5-lts.1: uncaught exception
    text_only: [400, body(field("avatar", "not a file"), END)],                                      // req.file undefined: unhandled rejection
    fields: [413, body(...times(5, (i) => field("f" + i, "x")), MALFORMED)],                         // 5 fields (limit 4)
    fieldkey: [413, body(field("k".repeat(101), "x"), MALFORMED)],                                   // a field name over 100
    fieldsize: [413, body(field("note", "v".repeat(5000)), MALFORMED)],                              // a value over 4 KB
    files: [413, body(file("avatar", pic), file("avatar", pic), MALFORMED)],                         // 2 files (limit 1)
    parts: [413, body(...times(4, (i) => field("f" + i, "x")), file("avatar", pic), file("avatar", pic), MALFORMED)],   // 6 parts
    filesize: [413, body(file("avatar", Buffer.alloc(8 * 1024 * 1024 + 1, 7)), END)],              // a picture over 8 MB
    malformed_only: [400, body(field("note", "x"), MALFORMED)],
    no_closing_boundary_field: [400, body(field("note", "hello")).subarray(0, -2)],
    not_a_picture: [400, body(file("avatar", "hello", "text/plain", "a.txt"), END)],
    svg: [400, body(file("avatar", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", "a.svg"), END)],
    other_file_field: [400, body(file("photo", pic), END)],
    empty_form: [400, END],
    not_decodable: [400, body(file("avatar", "this is no PNG at all", "image/png"), END)],
    pixel_bomb: [400, body(file("avatar", bomb), END)],
    bad_boundary: [400, Buffer.from("--someOtherBoundary\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nx\r\n--someOtherBoundary--\r\n")],
  };
  for (const [name, [want, data]] of Object.entries(cases)) {
    const r = await send(AVATAR, { data });
    await new Promise((res) => setTimeout(res, 30));
    alive(name);
    assert.equal(r.status, want, `${name} -> ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json && r.json.success, false, name + ": a JSON refusal");
  }
  // a boundary-less multipart type
  const nb = await send(AVATAR, { data: body(file("avatar", pic), END), type: "multipart/form-data" });
  alive("no boundary");
  assert.equal(nb.status, 400);
  // cut off: the declared length is the bytes sent, the body just stops (busboy: "Unexpected end of form")
  const cut = await send(AVATAR, { data: body(file("avatar", pic), END).subarray(0, 120) });
  alive("truncated");
  assert.equal(cut.status, 400, "a cut-off body");
  // declared over the cap: refused before anything is parsed
  assert.match(await partial(AVATAR, { length: 9 * 1024 * 1024, sent: file("avatar", "x".repeat(100)), c: MEMBER }), /^413/, "a Content-Length over the cap");
  alive("declared too big");
  // an upload that stops half-way: the sender goes away mid-file
  for (let i = 0; i < 3; i++) {
    assert.equal(await partial(AVATAR, { length: 200000, sent: file("avatar", Buffer.alloc(50000, 1)), c: MEMBER, waitMs: 150 }), "none");
  }
  await new Promise((res) => setTimeout(res, 200));
  alive("aborted uploads");
  assert.doesNotMatch(err, /uncaught|Unhandled|ERR_UNHANDLED_ERROR|Unexpected end of form|Malformed part header/i, err);
  // nothing left behind in uploads/ by the refusals
  const left = fs.existsSync(path.join(tmp, "uploads")) ? fs.readdirSync(path.join(tmp, "uploads")) : [];
  assert.deepEqual(left, [], "the refused uploads were removed");
});

test("the profile photo: a normal upload still works (S3 faked) - resized, stored, the temporary copy removed", async () => {
  const r = await send(AVATAR, { data: body(file("avatar", await png(300, 200)), END) });
  alive("a good picture");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.message, "Avatar uploaded successfully.");
  const keys = await new Promise((res) => http.get({ host: "127.0.0.1", port, path: "/test/s3" }, (x) => { let s = ""; x.on("data", (d) => { s += d; }); x.on("end", () => res(JSON.parse(s).keys)); }));
  assert.equal(keys.length, 1, "one S3 upload");
  assert.match(keys[0], /^avatars\/u-member-\d+\.jpeg$/);
  const row = await new Promise((res) => http.get({ host: "127.0.0.1", port, path: "/test/avatar/u-member" }, (x) => { let s = ""; x.on("data", (d) => { s += d; }); x.on("end", () => res(JSON.parse(s))); }));
  assert.equal(row.avatar, "https://test-bucket/" + keys[0], "the member's avatar URL");
  // a JPEG and a WebP are pictures too
  for (const [type, buf] of [["image/jpeg", await sharp(await png()).jpeg().toBuffer()], ["image/webp", await sharp(await png()).webp().toBuffer()]]) {
    const x = await send(AVATAR, { data: body(file("avatar", buf, type, "a.img"), END) });
    assert.equal(x.status, 200, type + " " + JSON.stringify(x.json));
  }
  await waitFor(() => !fs.existsSync(path.join(tmp, "uploads")) || fs.readdirSync(path.join(tmp, "uploads")).length === 0 || process.platform === "win32", "uploads/ to empty", 3000);
  if (process.platform !== "win32") assert.deepEqual(fs.readdirSync(path.join(tmp, "uploads")), [], "multer's copy is removed once read");
  // signed out: the sign-in page, nothing read
  const anon = await send(AVATAR, { data: body(file("avatar", await png()), END), cookie: null });
  assert.equal(anon.status, 302);
  assert.equal(anon.location, "/login");
  alive("signed out");
});

test("the badge form: no sign-in (or no badge rights) is refused before the body is read; a manager's hostile bodies are 4xx", async () => {
  // the answer comes while the body is still on its way: nothing waits for (or parses) it
  assert.equal(await partial(BADGE, { length: 100000, sent: field("name", "x") }), "302 /login", "anonymous: refused before the body");
  assert.equal(await partial(BADGE, { length: 100000, sent: field("name", "x"), c: MEMBER }), "302 /login", "a member without badges.manage: refused before the body");
  alive("refused early");
  const hostile = {
    fields: [413, body(...times(11, (i) => field("f" + i, "x")), MALFORMED)],                        // 11 fields (limit 10)
    fieldkey: [413, body(field("k".repeat(101), "x"), MALFORMED)],
    fieldsize: [413, body(field("description", "d".repeat(17 * 1024)), MALFORMED)],                  // over 16 KB
    files: [413, body(file("icon", "GIF89a", "image/gif", "i.gif"), MALFORMED)],                     // any file (text only)
    parts: [413, body(...times(10, (i) => field("f" + i, "x")), file("icon", "x"), MALFORMED)],      // 11 parts
    malformed_only: [400, body(field("name", "x"), MALFORMED)],
    no_closing_boundary: [400, body(field("name", "hello")).subarray(0, -2)],
    no_closing_boundary_file: [413, body(file("icon", "x".repeat(500), "application/octet-stream", "a.bin")).subarray(0, -2)],
  };
  for (const who of [null, MEMBER, STAFF]) {
    for (const [name, [want, data]] of Object.entries(hostile)) {
      const r = await send(BADGE, { data, cookie: who });
      await new Promise((res) => setTimeout(res, 30));
      alive(`${name} (${who === STAFF ? "manager" : who ? "member" : "anonymous"})`);
      if (who !== STAFF) { assert.equal(r.status, 302, name + ": the sign-in page"); continue; }
      assert.equal(r.status, want, `${name} -> ${r.status} ${JSON.stringify(r.json)}`);
      assert.equal(r.json && r.json.success, false);
    }
  }
  const cut = await send(BADGE, { data: body(field("name", "x"), END).subarray(0, 40), cookie: STAFF });
  assert.equal(cut.status, 400, "a cut-off body");
  assert.match(await partial(BADGE, { length: 300 * 1024, sent: field("name", "x"), c: STAFF }), /^413/, "a Content-Length over the cap");
  for (let i = 0; i < 3; i++) assert.equal(await partial(BADGE, { length: 50000, sent: field("description", "d".repeat(2000)), c: STAFF, waitMs: 150 }), "none");
  await new Promise((res) => setTimeout(res, 200));
  alive("aborted forms");
  assert.doesNotMatch(err, /uncaught|Unhandled|ERR_UNHANDLED_ERROR|Unexpected end of form|Malformed part header/i, err);
});

test("the badge form: a manager's form still arrives as before (the admin page's FormData)", async () => {
  const data = body(field("name", "Night Owl"), field("points", "50"), field("icon", "https://example.test/owl.png"), field("requirement", "be up late"),
    field("description", "Seen at 4 am"), END);
  const r = await send(BADGE, { data, cookie: STAFF });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.message, "Badge created successfully.");
  assert.deepEqual(r.json.body, { name: "Night Owl", points: "50", icon: "https://example.test/owl.png", requirement: "be up late", description: "Seen at 4 am" });
  alive("a good badge form");
});

test("index.js runs the same chain as the fixture: auth before multer, every multer middleware behind UG.guard, the handler behind UG.safe", () => {
  const src = rd("index.js");
  const fx = rd("test/fixtures/uploadguard-server.js");
  assert.match(src, /\nconst UG = require\("\.\/uploadguard"\);\nconst upload = UG\.badgeFormUpload\(multer\);\n/);
  assert.match(src, /app\.post\(\n {2}"\/api\/u\/:username\/update\/avatar",\n {2}authenticateToken,\n {2}addUser,\n {2}UG\.guard\(avatarUpload\.single\("avatar"\), UG\.AVATAR, "avatar"\),[^\n]*\n {2}UG\.safe\(updateAvatar, "avatar"\)\n\);/);
  assert.match(src, /app\.post\("\/api\/badges\/add", authenticateToken, addUser, badgeManager, UG\.guard\(upload\.none\(\), UG\.BADGE_FORM, "badge form"\), async \(req, res\) => \{/);
  const mgr = (s) => (/function badgeManager\(req, res, next\) \{[\s\S]*?\n\}/.exec(s) || [""])[0];
  assert.ok(mgr(src).length > 40);
  assert.equal(mgr(src), mgr(fx), "the fixture's badgeManager is index.js's");
  assert.match(fx, /UG\.guard\(avatarUpload\.single\("avatar"\), UG\.AVATAR, "avatar"\),\n\s*UG\.safe\(updateAvatar, "avatar"\)/);
  assert.match(fx, /authenticateToken, addUser, badgeManager, UG\.guard\(upload\.none\(\), UG\.BADGE_FORM, "badge form"\)/);
  // user.controller's multer is the capped one; no bare multer({ dest }) left anywhere
  const uc = rd("user.controller.js");
  assert.match(uc, /const avatarUpload = require\('\.\/uploadguard'\)\.avatarUpload\(multer\);/);
  for (const [f, s] of [["index.js", src], ["user.controller.js", uc]]) assert.doesNotMatch(s, /multer\(\{\s*dest/, f + ": an uncapped multer");
  assert.match(uc, /if \(!req\.file \|\| !req\.file\.path\) return res\.status\(400\)/, "the missing-picture guard");
  assert.match(uc, /sharp\(filePath, \{ limitInputPixels: 60e6 \}\)/, "the decode cap (imagesafety.js's)");
});

test("uploadguard: the caps and the error answers", () => {
  assert.deepEqual({ ...UG.AVATAR.limits }, { fileSize: 8 * 1024 * 1024, files: 1, fields: 4, fieldSize: 4096, fieldNameSize: 100, parts: 5, headerPairs: 20 });
  assert.equal(UG.BADGE_FORM.limits.files, 0, "the badge form takes no files");
  assert.ok(UG.AVATAR.maxBody > UG.AVATAR.limits.fileSize && UG.BADGE_FORM.maxBody >= 10 * UG.BADGE_FORM.limits.fieldSize);
  const me = (code) => Object.assign(new Error(code), { name: "MulterError", code });
  for (const c of ["LIMIT_FILE_SIZE", "LIMIT_FILE_COUNT", "LIMIT_PART_COUNT", "LIMIT_FIELD_KEY", "LIMIT_FIELD_VALUE", "LIMIT_FIELD_COUNT"]) assert.equal(UG.classify(me(c))[0], 413, c);
  for (const c of ["LIMIT_UNEXPECTED_FILE", "MISSING_FIELD_NAME", "INVALID_FIELD_NAME"]) assert.equal(UG.classify(me(c))[0], 400, c);
  assert.equal(UG.classify(new Error("Unexpected end of form"))[0], 400);
  assert.equal(UG.classify(new Error("Malformed part header"))[0], 400);
  assert.equal(UG.classify(Object.assign(new Error("no space"), { code: "ENOSPC", errno: -28, syscall: "write" }))[0], 500, "the disk failing is the site's fault");
  const ok = [], no = [];
  for (const t of ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "IMAGE/PNG"]) UG.avatarFilter({}, { fieldname: "avatar", mimetype: t }, (e, y) => (e ? no : ok).push(t));
  for (const t of ["image/svg+xml", "text/html", "application/octet-stream", "image/heic", ""]) UG.avatarFilter({}, { fieldname: "avatar", mimetype: t }, (e) => (e ? no : ok).push(t));
  UG.avatarFilter({}, { fieldname: "photo", mimetype: "image/png" }, (e) => (e ? no : ok).push("photo"));
  assert.deepEqual(ok, ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "IMAGE/PNG"]);
  assert.equal(no.length, 6);
});
