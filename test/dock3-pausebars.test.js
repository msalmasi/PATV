"use strict";
// pausebars (owner 2026-11-05, about the Room Dock's bottom audio bar eq meter - the mic bars: "Let's remove them from paused audio anyway"):
// while the room audio is PAUSED there are no bars on any device (desktop, Android, iPhone), whoever holds the mic; while it PLAYS, dock3
// 1.99akf is unchanged - the real analyser level (desktop / Android: rb-lvl), the animated "on the mic" bars without one (iOS: rb-nolvl), a
// still eq shape under reduced motion. The holder chips, the avatar's talking ring and the screen-reader "on the mic" stay as they were.
// The meter now comes and goes with ▶ / ❚❚, so the holder chips' flair fit runs again then (pad-dock.js decorateAudio).
// Browser evidence (Chromium, Pixel 7 + iPhone CriOS UA, the dock fixture kit): paused + holder -> display none (and under reduced motion);
// .on + holder -> shown, 5 running animations (no rb-lvl) / still under reduced motion; .on + nobody -> the real-level meter (Pixel), hidden (iPhone).
// micvad 1.99akk: an iPhone can have a real level now too (Pepe's levels on the MP3 relay, ⚡'s getStats - rb-lvl): playing, it draws the meter like
// desktop, holders or not; paused, still none (pausebars); without one, 1.99akf's bars as before.
//   node --test test/dock3-pausebars.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { harness } = require("./fixtures/pad-dock/dom.cjs");
const F = require("./fixtures/pad-dock/room.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");

// ── a small cascade for ONE element (the meter): every rule in room-bridge.css + pad-dock.css whose subject compound names .rb-meter and that
// sets display, matched against the meter's real ancestor chain (read from Chromium on the fixture pad / homepage). Anything this model can't
// evaluate (a sibling combinator, :has, @container, an unknown media feature) in such a rule fails the test rather than being skipped. ──
function splitTop(s, ch) {
  const out = []; let d = 0, cur = "";
  for (const c of s) { if (c === "(" || c === "[") d++; else if (c === ")" || c === "]") d--; if (c === ch && d === 0) { out.push(cur); cur = ""; } else cur += c; }
  out.push(cur); return out.map((x) => x.trim()).filter(Boolean);
}
function blocks(css, media, out, file) {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i); if (open < 0) break;
    let head = css.slice(i, open); const semi = head.lastIndexOf(";"); if (semi >= 0) head = head.slice(semi + 1); head = head.trim();
    let depth = 1, j = open + 1;
    for (; j < css.length && depth; j++) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; }
    const body = css.slice(open + 1, j - 1);
    if (/^@media\b/.test(head)) blocks(body, media.concat(head.slice(6).trim()), out, file);
    else if (/^@(supports|container|layer|scope)\b/.test(head)) blocks(body, media.concat(head), out, file);   // (evaluated only if a meter rule is inside: it throws)
    else if (!head.startsWith("@")) out.push({ head, body, media, file });   // (@keyframes / @starting-style / @font-face: no display of the meter)
    i = j;
  }
  return out;
}
function subjectText(sel) {
  let d = 0, last = 0;
  for (let k = 0; k < sel.length; k++) { const c = sel[k]; if (c === "(" || c === "[") d++; else if (c === ")" || c === "]") d--; else if (d === 0 && /[\s>+~]/.test(c)) last = k + 1; }
  return sel.slice(last);
}
function closeParen(s, at) { let d = 0; for (let k = at; k < s.length; k++) { if (s[k] === "(") d++; else if (s[k] === ")" && --d === 0) return k; } throw new Error("unbalanced " + s); }
function parseCompound(s) {
  const c = { tag: null, ids: [], cls: [], attrs: [], nots: [], iss: [], pe: false };
  let k = 0; const t = /^(\*|[a-zA-Z][\w-]*)/.exec(s); if (t) { c.tag = t[1] === "*" ? null : t[1].toLowerCase(); k = t[0].length; }
  while (k < s.length) {
    const r = s.slice(k); let x;
    if ((x = /^#([\w-]+)/.exec(r))) c.ids.push(x[1]);
    else if ((x = /^\.([\w-]+)/.exec(r))) c.cls.push(x[1]);
    else if ((x = /^\[([\w-]+)(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(r))) c.attrs.push({ name: x[1], op: x[2] || null, val: x[3] ?? x[4] ?? x[5] });
    else if ((x = /^::[\w-]+/.exec(r)) || (x = /^:(before|after|first-line|first-letter)\b/.exec(r))) c.pe = true;
    else if ((x = /^:(not|is|where)\(/.exec(r))) { const end = closeParen(r, x[0].length - 1); (x[1] === "not" ? c.nots : c.iss).push({ where: x[1] === "where", list: splitTop(r.slice(x[0].length, end), ",").map(parseComplex) }); x = [r.slice(0, end + 1)]; }
    else throw new Error("unsupported selector syntax in a meter rule: " + r + " - extend the model");
    k += x[0].length;
  }
  return c;
}
function parseComplex(sel) {
  const comps = [], combs = []; let d = 0, cur = "", pend = null;
  const flush = () => { if (cur) { comps.push(parseCompound(cur)); cur = ""; } };
  for (const c of sel.trim()) {
    if (d === 0 && /\s/.test(c)) { flush(); if (comps.length && !pend) pend = " "; continue; }
    if (d === 0 && /[>+~]/.test(c)) { flush(); pend = c; continue; }
    if (!cur && comps.length) { combs.push(pend || " "); pend = null; }
    if (c === "(" || c === "[") d++; else if (c === ")" || c === "]") d--;
    cur += c;
  }
  flush(); return { comps, combs };
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function specC(c) {
  let s = [c.ids.length, c.cls.length + c.attrs.length, c.tag ? 1 : 0];
  for (const g of [...c.nots, ...c.iss]) if (!g.where) s = add(s, g.list.map(specX).sort(cmp).at(-1));
  return s;
}
function specX(x) { return x.comps.map(specC).reduce(add, [0, 0, 0]); }
function attrOk(a, el) { const v = el.attrs[a.name]; if (v == null) return false; if (!a.op) return true; if (a.op === "=") return v === a.val; throw new Error("attr op " + a.op); }
function matchC(c, chain, i) {
  const el = chain[i];
  if (c.pe) return false;
  if (c.tag && c.tag !== el.tag) return false;
  if (c.ids.some((id) => id !== el.id) || c.cls.some((k) => !el.cls.has(k)) || c.attrs.some((a) => !attrOk(a, el))) return false;
  if (c.nots.some((g) => g.list.some((x) => matchX(x, chain, i)))) return false;
  if (c.iss.some((g) => !g.list.some((x) => matchX(x, chain, i)))) return false;
  return true;
}
function matchX(x, chain, at) {
  const go = (k, i) => {
    if (i < 0 || !matchC(x.comps[k], chain, i)) return false;
    if (k === 0) return true;
    const comb = x.combs[k - 1];
    if (comb === ">") return go(k - 1, i - 1);
    if (comb === " ") { for (let j = i - 1; j >= 0; j--) if (go(k - 1, j)) return true; return false; }
    throw new Error("sibling combinator '" + comb + "' in a meter rule - extend the model");
  };
  return go(x.comps.length - 1, at);
}
function mediaOk(conds, env) {
  return conds.every((q) => {
    if (q.startsWith("@")) throw new Error("a meter display rule inside " + q + " - extend the model");
    return splitTop(q, ",").some((one) => one.split(/\s+and\s+/).every((f) => {
      f = f.trim(); if (f === "screen" || f === "all") return true;
      const m = /^\(\s*([\w-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(f); if (!m) throw new Error("media query " + f);
      const name = m[1], val = m[2];
      if (name === "prefers-reduced-motion") return val == null ? env.reduce : val === (env.reduce ? "reduce" : "no-preference");
      if (name === "forced-colors") return val === (env.forced ? "active" : "none");
      if (name === "max-width") return env.width <= parseFloat(val);
      if (name === "min-width") return env.width >= parseFloat(val);
      if (name === "max-height") return env.height <= parseFloat(val);
      if (name === "min-height") return env.height >= parseFloat(val);
      if (name === "pointer") return val === (env.coarse ? "coarse" : "fine");
      if (name === "hover") return val === (env.coarse ? "none" : "hover");
      if (name === "orientation") return val === (env.width > env.height ? "landscape" : "portrait");
      throw new Error("media feature " + name + " in a meter rule - extend the model");
    }));
  });
}
/** sources: [[name, css text]] in load order */
function meterRules(sources) {
  const out = [];
  for (const [f, src] of sources) {
    for (const r of blocks(src.replace(/\/\*[\s\S]*?\*\//g, ""), [], [], f)) {
      const decl = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!\s*important)?\s*(?:;|$)/.exec(r.body.trim());
      if (!decl) continue;
      const items = splitTop(r.head, ",").filter((s) => /\.rb-meter(?![\w-])/.test(subjectText(s)));
      if (!items.length) continue;
      out.push({ file: f, media: r.media, display: decl[1], important: !!decl[2], items: items.map((s) => ({ s, x: parseComplex(s) })), order: out.length });
    }
  }
  return out;
}
const E = (tag, id, cls, attrs) => ({ tag, id: id || null, cls: new Set(cls || []), attrs: attrs || {} });
// (the real chains, Chromium on the fixture: the pad and the homepage's Room Dock)
function chain(where, s) {
  const bar = E("div", null, ["rb-audio", "rmd-bar"].concat(s.playing ? ["on"] : []));
  const now = E("div", null, ["rmd-now"].concat(s.holders ? ["rmd-talk", "rmd-has-holders"] : []));
  const meter = E("span", null, ["rb-meter"].concat(s.ios ? ["rb-nolvl"] : [], s.lvl ? ["rb-lvl"] : []), { "aria-hidden": "true" });
  const top = where === "home"
    ? [E("html"), E("body"), E("main", null, ["hm", "ds-page", "rm", "rm-dock", "rmd-home", "pad-acc"]), E("div", "hmdGrid", ["hmd-grid"]), E("section", "hmDock", ["rmd-hm"]), E("section", "rmChat", ["card", "rm-chat", "chatlog"])]
    : [E("html", null, ["hop-js"]), E("body", null, ["pad-dock-live", "rmd-dock-pad", "rmd-nav-auto"]), E("main", null, ["ds-page", "rm", "chatlog", "pad-acc", "rm-dock", "rpm-on"]), E("section", "padPanel-live", ["ppanel"]),
      E("div", null, ["grid", "rm-live", "rmd-body"]), E("div", null, ["rm-main"]), E("section", "rmChat", ["card", "rm-chat"])];
  return top.concat([E("div", "rmAudioBox", ["rm-audio"]), bar, now, meter]);
}
function display(rules, where, s, env) {
  const ch = chain(where, s), at = ch.length - 1;
  let win = null;
  for (const r of rules) {
    if (!mediaOk(r.media, env)) continue;
    const hit = r.items.filter((it) => matchX(it.x, ch, at)).map((it) => specX(it.x)).sort(cmp).at(-1);
    if (!hit) continue;
    const cand = { r, spec: hit };
    if (!win || (cand.r.important !== win.r.important ? cand.r.important : (cmp(cand.spec, win.spec) || cand.r.order - win.r.order) > 0)) win = cand;
  }
  return win ? win.r.display : "inline";
}

test("pausebars: the meter's cascade - paused: NO bars on any device, holders or not; playing: dock3 1.99akf unchanged (both stylesheet orders: the pad loads pad-dock.css first, the homepage room-bridge.css first)", () => {
  for (const order of [["pad-dock.css", "room-bridge.css"], ["room-bridge.css", "pad-dock.css"]]) {
    const rules = meterRules(order.map((f) => [f, read("public", "css", f)]));
    assert.ok(rules.length >= 5, "the meter's display rules were found (" + rules.length + ")");
    for (const where of ["pad", "home"]) {
      for (const ios of [false, true]) for (const reduce of [false, true]) for (const coarse of [false, true]) {
        const env = { reduce, coarse, forced: false, width: coarse ? 412 : 1440, height: coarse ? 839 : 900 };
        const tag = (s) => [where, ios ? "iPhone" : "desktop/Android", reduce ? "reduced motion" : "motion", coarse ? "phone" : "wide", order[0] + " first", JSON.stringify(s)].join(" | ");
        // paused: hidden - with someone on the mic too (the owner's ask), and whatever level state is left
        for (const holders of [true, false]) for (const lvl of [false, true]) {
          const s = { playing: false, holders, ios, lvl };
          assert.equal(display(rules, where, s, env), "none", "paused: no bars - " + tag(s));
        }
        // playing + someone on the mic: the bars (a real level - desktop / Android, micvad 1.99akk: iOS too -, the animation without one, still
        // under reduced motion)
        for (const lvl of [false, true]) {
          const s = { playing: true, holders: true, ios, lvl };
          assert.equal(display(rules, where, s, env), "inline-flex", "playing + a holder: the bars - " + tag(s));
        }
        // playing + nobody: the real level as before (desktop / Android; room-bridge.css hides it under reduced motion), never on iOS (rb-nolvl)
        const s = { playing: true, holders: false, ios, lvl: !ios && !reduce };
        assert.equal(display(rules, where, s, env), ios || reduce ? "none" : "inline-flex", "playing + nobody: as in 1.99akf - " + tag(s));
        // micvad 1.99akk: an iPhone with a real level (never under reduced motion - the page doesn't ask for one then): like desktop
        if (ios && !reduce) {
          const r = { playing: true, holders: false, ios, lvl: true };
          assert.equal(display(rules, where, r, env), "inline-flex", "playing + nobody + iPhone with a real level: the meter - " + tag(r));
        }
      }
    }
  }
});

test("pausebars: the cascade model itself - the old 1.99akf rule pair would have SHOWN a paused bar with a holder (so the test above can tell)", () => {
  const css = read("public", "css", "pad-dock.css");
  const old = css.replace("main.rm.rm-dock #rmAudioBox .rb-audio:not(.on) .rmd-now > .rb-meter { display: none; }", "main.rm.rm-dock #rmAudioBox .rb-audio:not(.on) .rmd-now:not(.rmd-talk) > .rb-meter { display: none; }")
    .replace("main.rm.rm-dock #rmAudioBox .rb-audio.on .rmd-now.rmd-talk > .rb-meter { display: inline-flex; }", "main.rm.rm-dock #rmAudioBox .rb-audio .rmd-now.rmd-talk > .rb-meter { display: inline-flex; }");
  assert.equal(old.split("rmd-now:not(.rmd-talk)").length, 2, "both rules found to swap back");
  const rules = meterRules([["pad-dock.css (1.99akf)", old], ["room-bridge.css", read("public", "css", "room-bridge.css")]]);
  const env = { reduce: false, coarse: true, forced: false, width: 390, height: 664 };
  assert.equal(display(rules, "pad", { playing: false, holders: true, ios: true, lvl: false }, env), "inline-flex", "1.99akf: a paused iPhone bar with a holder drew the bars");
  assert.equal(display(rules, "pad", { playing: false, holders: false, ios: false, lvl: false }, env), "none", "1.99akf: paused + nobody was already hidden (1.99ajf)");
});

test("pausebars: the rules as written - paused hides the meter whoever holds the mic, the 'on the mic' show rule is .on only, the motion / still-shape rules are 1.99akf's", () => {
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /\nmain\.rm\.rm-dock #rmAudioBox \.rb-audio:not\(\.on\) \.rmd-now > \.rb-meter \{ display: none; \}\n/);
  assert.match(css, /\nmain\.rm\.rm-dock #rmAudioBox \.rb-audio\.on \.rmd-now\.rmd-talk > \.rb-meter \{ display: inline-flex; \}\n/);
  assert.doesNotMatch(css, /rmd-now:not\(\.rmd-talk\)/, "no paused exception for holders");
  assert.equal(css.split("animation: rmdEq").length, 2, "the one animation rule (1.99akf)");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  main\.rm\.rm-dock \.rmd-now\.rmd-talk > \.rb-meter > i \{ transition: none; animation: none; transform: none; \}/, "C5's still shape stays");
  // the holder chips, the ring and "on the mic" don't depend on play / pause
  assert.match(css, /main\.rm\.rm-dock \.rmd-holder\.rmd-talking \.av \{ box-shadow: 0 0 0 2px var\(--ds-surface\), 0 0 0 4px var\(--ds-ac\); \}/);
  assert.doesNotMatch(css, /\.rb-audio(?::not\(\.on\)|\.on)[^{]*\.rmd-holder/, "no holder chip rule keyed on play / pause");
});

test("pausebars: a paused bar with a holder keeps its chip, ring and 'on the mic' text (rmd-talk) - only the meter goes; ▶ / ❚❚ re-runs the holder flair fit", () => {
  let d = null;   // (the fixture document - extra.setup hands it over before the Dock starts and draws the first holders)
  const person = (u) => { const n = d.createElement("span"); n.className = "rmd-person"; const nm = d.createElement("span"); nm.className = "rmd-person-name"; n.appendChild(nm);
    const who = d.createElement("span"); who.className = "who"; who.textContent = (u && (u.display || u.alias)) || "?"; nm.appendChild(who);
    if (u && !u.veil && !u.anon) { const fl = d.createElement("span"); fl.className = "ufl"; const w = d.createElement("span"); w.className = "ufl-n"; w.textContent = "Supporter"; fl.appendChild(w); nm.appendChild(fl); }
    return n; };
  const h = harness({ mo: true, setup: (x) => { d = x.doc; }, opts: { person } });
  h.tick();
  const bar = h.doc.querySelector("#rmAudioBox .rb-audio"), now = h.doc.querySelector("#rmAudioBox .rmd-now");
  assert.ok(bar && now, "the decorated bar");
  assert.equal(bar.classList.contains("on"), false, "paused (the fixture's start)");
  assert.ok(now.classList.contains("rmd-talk"), "a holder: rmd-talk is still set while paused (the CSS hides the meter, not the class)");
  const chips = h.doc.querySelectorAll("#rmAudioBox .rmd-holder"); assert.ok(chips.length >= 1, "the holder chips stay");
  for (const c of chips) assert.match(c.textContent, /on the mic/, "the screen-reader 'on the mic' stays");
  const named = F.initial().mic.find((u) => !u.veil && !u.anon); assert.ok(named, "the fixture has a named holder");
  h.controller.talking({ src: [{ id: "a", login: named.login, ring: true }] });
  assert.equal(h.doc.querySelectorAll("#rmAudioBox .rmd-holder.rmd-talking").length, 1, "paused: the talking ring still rings the one talking");
  const fl = h.doc.querySelector("#rmAudioBox .rmd-holders .rmd-person-name > .ufl"); assert.ok(fl, "a named holder's flair");
  // a stale fit (measured with the other meter state): a mutation that is not ▶ / ❚❚ leaves it; ▶ refits; ❚❚ refits again
  fl.classList.add("rmd-ufl-off");
  now.classList.add("rmd-x"); h.mutate(now); h.tick();
  assert.ok(fl.classList.contains("rmd-ufl-off"), "no refit for other changes in the bar (rb-lvl, the state words, ...)");
  bar.classList.add("on"); h.mutate(bar); h.tick();
  assert.equal(fl.classList.contains("rmd-ufl-off"), false, "▶: the fit runs again (the meter now takes its room)");
  fl.classList.add("rmd-ufl-e"); h.mutate(bar); h.tick();
  assert.ok(fl.classList.contains("rmd-ufl-e"), "still playing: no refit");
  bar.classList.remove("on"); h.mutate(bar); h.tick();
  assert.equal(fl.classList.contains("rmd-ufl-e"), false, "❚❚: the fit runs again (the meter's room is back)");
  const js = read("public", "js", "pad-dock.js");
  assert.match(js, /var wasOn = row\.classList\.contains\('on'\);\n\s+observe\(row, function \(\) \{\n\s+var on = row\.classList\.contains\('on'\); if \(on !== wasOn\) \{ wasOn = on; if \(holderBox\) fitSoon\(holderBox\); \}/);
});

test("pausebars: cache-busters - pad-dock.css v11+ on the pad, the homepage and both casino tables (ptttoast review F1: v12); pad-dock.js v11+ on the pad and the homepage (plexreplace: v12; ptttoast: v13)", () => {
  const room = read("views", "room.ejs"), home = read("views", "home.ejs");
  assert.match(room, /<link rel="stylesheet" href="\/public\/css\/pad-dock\.css\?v=12">/);
  assert.match(room, /<script src="\/public\/js\/pad-dock\.js\?v=13"><\/script>/);
  assert.match(home, /<link rel="stylesheet" href="\/public\/css\/pad-dock\.css\?v=12">/);
  assert.match(home, /<script src="\/public\/js\/pad-dock\.js\?v=13"><\/script>/);
  for (const f of ["casino-bj.ejs", "casino-hm.ejs"]) assert.match(read("views", f), /<link rel="stylesheet" href="\/public\/css\/pad-dock\.css\?v=12">/, f);
  for (const f of ["room.ejs", "home.ejs", "casino-bj.ejs", "casino-hm.ejs"]) {
    assert.doesNotMatch(read("views", f), /pad-dock\.css\?v=(?!12")\d+/, f + ": one css version everywhere (ptttoast review F1: v12)");
    assert.doesNotMatch(read("views", f), /pad-dock\.js\?v=(?!13")\d+/, f + ": one js version everywhere (plexreplace: v12; ptttoast: v13)");
  }
});
