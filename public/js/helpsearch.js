// helpsearch.js - the /help page's search + the prompter's local ranking (1.99fq). One file for the browser (the
// page's instant filter and the "ask" box's instant answer) and the server (help.js picks the cards Pepe may answer
// from with the same ranking). No dependencies; UMD.
//   rank(entries, q, {limit}) -> [{score, entry}] best first      (OR: any word helps; commands/keywords weigh most)
//   matches(haystack, q) -> bool                                  (AND: every word must appear - the page filter)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HelpSearch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var STOP = {};
  ("a an and are as at be by can do does for from get go how i if in into is it its me my of on or please should so " +
   "some the their them then there this to up use using want way what when where which who why will with would you " +
   "your pepe pepefrog command commands cmd im ive id").split(" ").forEach(function (w) { STOP[w] = 1; });

  // a few everyday words -> the words the help uses
  var SYN = {
    bet: ["wager", "market", "pool", "bet"], betting: ["wager", "market", "pool"], gamble: ["casino", "spin", "bet"],
    money: ["pat"], coins: ["pat"], points: ["pat"], cash: ["pat"], tokens: ["pat"], balance: ["balance", "pat"],
    pay: ["tip"], give: ["tip", "gift"], send: ["tip"], transfer: ["tip"],
    song: ["queue", "music", "song"], songs: ["queue", "music"], music: ["queue", "music", "dj"], track: ["queue", "song"],
    picture: ["snap", "imagine", "image"], photo: ["snap"], screenshot: ["snap"], pic: ["snap", "imagine"],
    image: ["imagine", "snap"], record: ["clip"], recording: ["clip"], video: ["clip", "video"],
    cam: ["cam", "snap", "look"], camera: ["cam", "snap", "look"], webcam: ["cam", "snap", "look"],
    poker: ["holdem", "poker"], cards: ["blackjack", "holdem", "cards"], "21": ["blackjack"],
    rob: ["heist"], robbery: ["heist"], steal: ["heist"], crew: ["gang"], territory: ["turf"],
    talk: ["say", "mic", "tts"], speak: ["say", "tts"], voice: ["say", "voices", "tts"],
    boot: ["kick"], remove: ["kick", "remove"], mute: ["punish", "blockmic", "mute"],
    loan: ["loan", "borrow"], lend: ["loan"], borrow: ["borrow", "loan"],
    remind: ["remind"], reminder: ["remind"], message: ["relay", "msg", "dm"], prize: ["prizes", "redeem", "shop"],
    prizes: ["prizes", "redeem"], buy: ["buy", "redeem", "shop"], shop: ["shop", "prizes"], stream: ["stream", "stage"],
    level: ["xp", "level"], rank: ["top", "level"], leaderboard: ["top", "heisttop", "gangtop"], link: ["verify"],
    account: ["verify", "profile"], name: ["displayname", "alias"], rename: ["displayname"], lottery: ["lotto"],
    poll: ["poll", "vote"], vote: ["vote", "poll"], promote: ["boost"], feature: ["boost"],
  };

  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[‘’']/g, ""); }
  function stem(w) {
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }
  /** the query's words: lowercase, no stop words, commands kept with their "!" stripped */
  function words(q) {
    var out = [];
    (norm(q).match(/!?[a-z0-9]+/g) || []).forEach(function (t) {
      var w = t.replace(/^!/, "");
      if (w && !STOP[w] && out.indexOf(w) < 0) out.push(w);
    });
    return out;
  }
  function has(hay, w) {
    if (!hay) return false;
    var i = hay.indexOf(w);
    while (i >= 0) {
      if (i === 0 || !/[a-z0-9]/.test(hay.charAt(i - 1))) return true;     // a word start
      i = hay.indexOf(w, i + 1);
    }
    return false;
  }
  function prep(e) {
    if (e.__hs) return e.__hs;
    var names = [].concat(e.commands || [], e.aliases || []).map(function (c) { return norm(c).replace(/^!/, ""); });
    var p = {
      names: names,
      first: names[0] || "",
      title: norm(e.title || "") + " " + norm((e.syntax || []).join(" ")),
      kw: (e.keywords || []).map(norm),
      kwText: norm((e.keywords || []).join(" ")),
      summary: norm(e.summary || ""),
      details: norm(e.details || "").slice(0, 1500),
      cat: norm(e.category || ""),
    };
    try { Object.defineProperty(e, "__hs", { value: p, enumerable: false }); } catch (x) { /* frozen: no cache */ }
    return p;
  }
  function scoreWord(p, w, weight) {
    var s = 0, st = stem(w);
    if (p.names.indexOf(w) >= 0 || (st !== w && p.names.indexOf(st) >= 0)) s += (p.first === w || p.first === st) ? 40 : 28;
    else if (has(p.title, st)) s += 10;
    if (has(p.kwText, st)) s += 7;
    if (has(p.summary, st)) s += 4;
    else if (has(p.details, st)) s += 1;
    return s * weight;
  }
  /** -> [{score, entry}] best first */
  function rank(entries, q, opts) {
    var limit = (opts && opts.limit) || 10;
    var ws = words(q);
    var qn = " " + norm(q).replace(/[^a-z0-9! ]+/g, " ").replace(/\s+/g, " ") + " ";
    if (!ws.length) return [];
    var bare = (norm(q).match(/^\s*!?([a-z0-9_]+)\s*$/) || [])[1] || "";
    var staffQ = !!bare || /\b(admin|admins|mod|mods|moderator|owner|owners|staff)\b/.test(norm(q));
    var out = [];
    (entries || []).forEach(function (e) {
      var p = prep(e), sc = 0, hit = 0;
      ws.forEach(function (w) {
        var s = scoreWord(p, w, 1);
        (SYN[w] || SYN[stem(w)] || []).forEach(function (x) { if (x !== w) s = Math.max(s, scoreWord(p, x, 0.6)); });
        if (s > 0) hit++;
        sc += s;
      });
      p.kw.forEach(function (k) { if (k && qn.indexOf(" " + k + " ") >= 0) sc += 25; });     // a whole keyword phrase
      if (bare && p.names.indexOf(bare) >= 0) sc += p.first === bare ? 100 : 70;            // just "!spin" / "spin"
      if (!sc) return;
      if (hit === ws.length && ws.length > 1) sc *= 1.25;                                   // every word found
      if (e.role === "everyone") sc += 1;                                                  // ties: what anyone can use
      else if (!staffQ) sc *= 0.75;                       // mod/admin tools only lead when the question is about them
      out.push({ score: Math.round(sc * 10) / 10, entry: e });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit);
  }
  /** the page filter: every word (or one of its synonyms) somewhere in the card's text */
  function matches(haystack, q) {
    var ws = words(q);
    if (!ws.length) return true;
    var h = norm(haystack);
    return ws.every(function (w) {
      if (has(h, stem(w)) || has(h, w)) return true;
      return (SYN[w] || []).some(function (x) { return has(h, x); });
    });
  }
  return { rank: rank, matches: matches, words: words, stem: stem };
});
