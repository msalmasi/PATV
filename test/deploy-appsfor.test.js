// 1.99anx review (G3 / PRIV-L1 / R-2): deploy/patv-update.sh's apps_for - which pm2 apps a changed file restarts. A root file that
// the Twitch bot (pm2 'twitch', twitchbot/twitch.js) or the webhook server (pm2 'server', server.js) loads has to restart them
// too: otherwise they keep running the old copy until something else restarts them (a processguard.js-only fix - the crash
// guard's log redaction - would never reach them), the updater's health check never covers them for that change, and a fault
// in it surfaces at that later restart, when the updater rolls back and marks the WRONG commit bad.
//   * the script's own function (cut out of it and run in bash; skipped without bash) for the rows 1.99anx added
//   * every root file twitchbot/twitch.js and server.js load - their relative requires followed, lazy ones too (an
//     over-approximation), but not into user.controller.js: its own requires are most of the site, its row already restarts all
//     three, and that site code is a separate, known gap of the map - restarts index + that bot's app
//   NODE_PATH=G:/PATV/node_modules node --test test/deploy-appsfor.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const SCRIPT = path.join(repo, "deploy", "patv-update.sh");
const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
const FN = (/^apps_for\(\) \{\n[\s\S]*?\n\}\n/m.exec(src) || [""])[0];
const hasBash = spawnSync("bash", ["-c", "true"], { stdio: "ignore", input: "", timeout: 10000 }).status === 0;

/** apps_for(path) for each path, run by the script's own function in bash -> Map path -> "app app" ("" = nothing). */
function appsFor(paths, onlyApp = "") {
  const body = `ONLY_APP='${onlyApp}'\n${FN}\nfor p in "$@"; do printf '%s=%s\\n' "$p" "$(apps_for "$p")"; done\n`;
  const r = spawnSync("bash", ["-c", body, "apps_for", ...paths], { encoding: "utf8", input: "", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = new Map();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    out.set(line.slice(0, i), line.slice(i + 1).trim().split(/\s+/).filter(Boolean).join(" "));
  }
  assert.equal(out.size, new Set(paths).size, "one answer per path");
  return out;
}

/** The repo files an entry loads: relative requires followed (lazy ones too), not into user.controller.js (see the header). */
function loads(entry) {
  const rel = (f) => path.relative(repo, f).split(path.sep).join("/");
  const seen = new Set(), todo = [path.join(repo, entry)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    if (rel(f) === "user.controller.js") continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const p = path.resolve(path.dirname(f), m[1]);
      todo.push(/\.js$/.test(p) ? p : p + ".js");
    }
  }
  return [...seen].map(rel).sort();
}

test("the script still has apps_for (the function this file runs)", () => {
  assert.match(FN, /^apps_for\(\) \{\n  if \[ -n "\$ONLY_APP" \]; then/);
  assert.match(FN, /\*\)\s+echo index ;;\n  esac\n\}\n$/);
});

test("apps_for: the crash guard and the other shared root files restart the bots too; the rest is unchanged", { skip: !hasBash && "needs bash" }, () => {
  const A = appsFor(["processguard.js", "errorhandler.js", "shutdown.js", "sqlitecfg.js", "listen.js", "dbUtils.js", "user.controller.js",
                     "members.js", "index.js", "server.js", "twitchbot/channelpoints.js", "package.json", "deploy/patv-update.sh",
                     "public/js/admin-members.js", "locales/en.json"]);
  assert.equal(A.get("processguard.js"), "index twitch server", "server.js and twitch.js load it through twitchbot/channelpoints.js");
  assert.equal(A.get("errorhandler.js"), "index twitch server");
  assert.equal(A.get("shutdown.js"), "index twitch server", "dbUtils.js loads it");
  assert.equal(A.get("sqlitecfg.js"), "index twitch server", "dbUtils.js loads it");
  assert.equal(A.get("listen.js"), "index server");
  assert.equal(A.get("dbUtils.js"), "index twitch server");
  assert.equal(A.get("user.controller.js"), "index twitch server");
  assert.equal(A.get("members.js"), "index");
  assert.equal(A.get("index.js"), "index");
  assert.equal(A.get("server.js"), "server");
  assert.equal(A.get("twitchbot/channelpoints.js"), "twitch server");
  assert.equal(A.get("package.json"), "index server");
  assert.equal(A.get("deploy/patv-update.sh"), "");
  assert.equal(A.get("public/js/admin-members.js"), "");
  assert.equal(A.get("locales/en.json"), "index");
  // staging (ONLY_APP): every site file restarts that one app; the bots don't run there
  const S = appsFor(["processguard.js", "listen.js", "members.js", "twitchbot/channelpoints.js", "server.js"], "patv-staging");
  assert.equal(S.get("processguard.js"), "patv-staging");
  assert.equal(S.get("listen.js"), "patv-staging");
  assert.equal(S.get("members.js"), "patv-staging");
  assert.equal(S.get("twitchbot/channelpoints.js"), "");
  assert.equal(S.get("server.js"), "");
});

test("every root file the Twitch bot and the webhook server load restarts that bot (and the site)", { skip: !hasBash && "needs bash" }, () => {
  const root = (f) => !f.includes("/");
  const twitch = loads("twitchbot/twitch.js").filter(root);
  const server = loads("server.js").filter(root).filter((f) => f !== "server.js");
  assert.ok(twitch.includes("processguard.js") && twitch.includes("dbUtils.js"), "the walk finds them: " + twitch.join(" "));
  assert.ok(server.includes("processguard.js") && server.includes("listen.js"), "the walk finds them: " + server.join(" "));
  const A = appsFor([...new Set([...twitch, ...server])]);
  for (const f of twitch) {
    const apps = A.get(f).split(" ");
    assert.ok(apps.includes("twitch") && apps.includes("index"), `${f} (twitch.js loads it) restarts ${A.get(f) || "nothing"}`);
  }
  for (const f of server) {
    const apps = A.get(f).split(" ");
    assert.ok(apps.includes("server") && apps.includes("index"), `${f} (server.js loads it) restarts ${A.get(f) || "nothing"}`);
  }
});
