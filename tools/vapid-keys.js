#!/usr/bin/env node
// tools/vapid-keys.js — 1.99acd: make the VAPID key pair for browser notifications (webpush.js, QW-1) and write it into an
// env file for the operator. ONE pair per instance (staging and prod each get their own) and it must NOT change once people
// have turned notifications on: a new public key orphans every browser's subscription (docs/webpush.md). Keep a copy in the
// password manager - it moves to notify's secrets at S5. The private key is written to the file only, never printed.
//   node tools/vapid-keys.js --env <path to .env> --subject mailto:<address>          # append the three VAPID_ lines
//   node tools/vapid-keys.js --env <path to .env> --subject <...> --force-rotate      # replace existing VAPID_ lines (everyone
//                                                                                    # must turn notifications on again)
//   node tools/vapid-keys.js --out <new file> --subject https://<site>               # a new file (never overwrites one)
// Then restart the site and look for "[webpush] keys loaded (kid ...)" in its log. New files are written mode 0600.
"use strict";
const fs = require("fs");
const path = require("path");
const C = require(path.join(__dirname, "..", "webpushcrypto"));

const USAGE = "usage: node tools/vapid-keys.js (--env <path to .env> | --out <new file>) --subject mailto:<address>|https://<site> [--force-rotate]";
const VAPID_LINE = /^\s*(?:export\s+)?VAPID_[A-Z_]*\s*=/;

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { o.bad = a; continue; }
    if (m[1] === "force-rotate") { o.rotate = true; continue; }
    o[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return o;
}

/** -> {code, out, err} (exit code, stdout, stderr) - main() prints them; the test calls this directly too. */
function run(argv) {
  const o = args(argv);
  if (o.bad || (!o.env && !o.out) || (o.env && o.out) || !o.subject) return { code: 2, out: "", err: USAGE };
  const subject = String(o.subject).trim();
  if (!C.validSubject(subject)) return { code: 2, out: "", err: "--subject must be mailto:<address> or an https:// URL\n" + USAGE };
  const k = C.generate();
  const lines = [`VAPID_PUBLIC_KEY=${k.publicKey}`, `VAPID_PRIVATE_KEY=${k.privateKey}`, `VAPID_SUBJECT=${subject}`];
  let file, warn = "";
  if (o.out) {
    file = path.resolve(String(o.out));
    if (fs.existsSync(file)) return { code: 1, out: "", err: `${file} already exists - not overwriting it (use --env to add the keys to an env file)` };
    fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  } else {
    file = path.resolve(String(o.env));
    const exists = fs.existsSync(file);
    const cur = exists ? fs.readFileSync(file, "utf8") : "";
    const had = cur.split(/\r?\n/).some((l) => VAPID_LINE.test(l));
    if (had && !o.rotate) {
      return { code: 1, out: "", err: `${file} already has VAPID_ lines - not changing them. Rotating the keys orphans every browser's subscription; if you really mean it, add --force-rotate.` };
    }
    if (had) {
      const kept = cur.split(/\r?\n/).filter((l) => !VAPID_LINE.test(l));
      while (kept.length && kept[kept.length - 1] === "") kept.pop();
      fs.writeFileSync(file, (kept.length ? kept.join("\n") + "\n" : "") + lines.join("\n") + "\n");
      warn = "WARNING: the VAPID keys were ROTATED. Every browser that had notifications on must turn them on again (Messages settings).\n";
    } else if (exists) {
      fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
    } else {
      fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
    }
  }
  return { code: 0, err: "",
           out: warn + `VAPID keys written to ${file} (public key ${k.publicKey}, kid ${k.kid}). The private key is in the file and was not printed. Restart the site to load it.` };
}

if (require.main === module) {
  let r;
  try { r = run(process.argv.slice(2)); } catch (e) { r = { code: 1, out: "", err: "couldn't write the keys: " + e.message }; }
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exit(r.code);
}

module.exports = { run, USAGE };
