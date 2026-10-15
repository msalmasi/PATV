// 1.99abd: a view that hands HTML (a link) to a translated string must use a RAW placeholder ({!name}) in the catalog - with
// {name} the link is HTML-escaped and the page shows the markup itself (seen on the profile's streak card: "Regular at <a href=...").
// Scans every view for t('key', { name: '<tag...' }) and checks en.json's string for that key.
//   node --test test/i18n-rawhtml.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "locales/en.json"), "utf8"));

function views(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) views(p, out);
    else if (/\.(ejs|js)$/.test(f)) out.push(p);
  }
  return out;
}

test("HTML handed to a translated string goes into a raw {!placeholder}", () => {
  const bad = [];
  for (const f of views(path.join(root, "views"))) {
    const src = fs.readFileSync(f, "utf8");
    const re = /\bt\(\s*'([\w.]+)'\s*,\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const key = m[1], args = m[2], val = en[key];
      const am = /(\w+)\s*:\s*[^,]*?['"`]\s*<[a-zA-Z]/g;
      let a;
      while ((a = am.exec(args))) {
        if (typeof val === "string" && val.includes("{" + a[1] + "}") && !val.includes("{!" + a[1] + "}")) {
          bad.push(`${path.relative(root, f)}: ${key} {${a[1]}}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], "use {!name} in the catalog (every language) for these:\n" + bad.join("\n"));
});
