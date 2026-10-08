#!/usr/bin/env node
// deploy/restream/set-key.js - PATV 1.99fk: save a Twitch destination from a FILE, through the site's own storage
// (restream.saveDest: encrypted with the site's RESTREAM_SECRET). For keys that come from somewhere other than the
// web form - Pepe's main stream's key, read out of his OBS. The key never touches a command line or the output.
//   cd /home/PATV && node deploy/restream/set-key.js --owner @main --file /root/twitch.env [--shred]
// The file (0600, owned by the caller) holds:
//   KEY=<stream key>
//   SERVER=rtmp://live.twitch.tv/app      (optional; blank = Twitch's nearest ingest)
// --shred overwrites and deletes the file afterwards (also on failure). Prints only the masked result.
"use strict";
const fs = require("fs");
const path = require("path");

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
const owner = arg("--owner");
const file = arg("--file");
const shred = process.argv.includes("--shred");

function wipe(f) {
  try {
    const n = fs.statSync(f).size;
    const fd = fs.openSync(f, "r+");
    fs.writeSync(fd, Buffer.alloc(Math.max(n, 64), 0), 0, Math.max(n, 64), 0);
    fs.fsyncSync(fd); fs.closeSync(fd);
    fs.unlinkSync(f);
    console.log("key file shredded");
  } catch (e) { console.error("could not shred the key file:", e.code || e.message); }
}

(async () => {
  let code = 0;
  try {
    if (!owner || !file) throw new Error("usage: --owner <userId|@main> --file <path> [--shred]");
    const st = fs.statSync(file);
    if ((st.mode & 0o077) !== 0) throw new Error("the key file must be 0600");
    const txt = fs.readFileSync(file, "utf8");
    const get = (k) => { const m = new RegExp("^" + k + "=(.*)$", "m").exec(txt); return m ? m[1].trim() : ""; };
    const key = get("KEY"), server = get("SERVER");
    if (!key) throw new Error("no KEY= line in the file");
    process.chdir(path.resolve(__dirname, "..", ".."));       // the site's folder: ./myapp.db, ./.env
    require("dotenv").config();
    const R = require(path.resolve("restream.js"));
    if (!R.configured()) throw new Error("RESTREAM_SECRET isn't set in this site's .env");
    if (owner !== R.MAIN_OWNER) {
      const { getQuery } = require(path.resolve("dbUtils.js"));
      if (!(await getQuery("SELECT 1 FROM users WHERE userId = ?", [owner])).length) throw new Error("no such user id");
    }
    const v = await R.saveDest(owner, { server, key }, "set-key.js");
    // round trip: what the worker would get decrypts back to the same key (compared, never printed)
    const row = await R.destRow(owner);
    if (R.decrypt(row.key_enc, owner) !== key) throw new Error("round-trip check failed");
    console.log(`saved for ${owner}: server ${v.server}, key ${v.key} (round-trip ok)`);
  } catch (e) {
    console.error("set-key failed:", e.message);
    code = 1;
  } finally {
    if (shred && file && fs.existsSync(file)) wipe(file);
  }
  setTimeout(() => process.exit(code), 200);
})();
