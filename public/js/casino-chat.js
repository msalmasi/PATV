// casino-chat.js — 1.99ajw casino2 (owner 2026-11-04, point 18: "Docking chat doesn't stay active between page switches (like going to
// holdem). Would be nice if users could also bring up a chat from the tables."): a table belongs to pads (the rooms it plays in, then
// the rooms it is advertised in - casino/people.js `pads`), and 💬 Chat opens THAT pad's chat beside the table.
// tablechat (owner 2026-11-07: "Also for poker table chats, let users pull up any pad chats regardless if its been advertised or added to a
// room chat"): the panel's picker (▾, or 💬 with no pad of the table's own) lists EVERY pad chat this viewer may open - the table's own pads
// on top, then the ones recently opened from a table, then the rest, most people first (GET /api/casino/t/:id/chatpads, casino/chatpads.js:
// the chat window's gate and not banned from that pad, unlisted pads only where the viewer could reach them). The search box filters that
// list here (nothing typed is sent); "p/<address>" (or a pasted pad link, or Enter with no match) asks for that one pad. The frame is gated
// again by the server (the chat embed asks the same gate), so a pad id from this page is never trusted. Recent pads: localStorage
// 'patv.cz.chat.recent' {u: the viewer's name, s: [slugs]} (another account's list is ignored; the server checks each again).
// Review fixes (access + UX reviews): this tab's pick for the table (sessionStorage 'patv.cz.chat.<table>' {u, slug}) is its viewer's and
// carries no name; one that isn't the table's own pad is confirmed by the server (?slug=) before 💬 names or opens it; a chat that closes
// to you (the frame's card: offline, banned, its level, the Dock) is forgotten - the pick and Recent - and the picker opens to choose
// another; an address is matched by its start as you type it and asked of the server only after a pause with no pad of that start (or on
// Enter) - a 429 / a failure says so and is never "no pad"; the picker never grows over the action dock while the table needs you; the
// header says when a chat isn't this table's pad.
//
// The chat is the pad chat window itself (GET /p/<slug>/chat?embed=1, bridge.js: the same page, auth, veils, Reveal, room PM 'only
// you' lines, autocomplete, person menu, rate limits and presence as /p/<slug>/chat; only its frame headers allow this site to frame it)
// in an <iframe> - one copy of the chat's code, and the Room Dock's window channel (dock-link.js) keeps one poller / one audio across a
// pad tab, a chat window and this frame: the newest wins (a newer window says so here: "Chat is open in its own window · Bring it here").
//   desktop (>= 1100px): docked at the inline end, 360px - the felt keeps its shape and shrinks
//   761-1099px:           a 340px float, with Minimize
//   phones (<= 760px):    a non-modal bottom sheet (60% of the screen; minimized = a 44px bar with a new-lines dot)
// The float and the sheet make room for the action dock while the table needs you (your turn, a Blackjack bet, insurance) and come back
// after; a sheet opened in the chat (⚔️ Duel's stake) makes the panel taller while it's open; a chat in its own window leaves the bar.
// The picker makes the float / the sheet tall too (room above a phone's keyboard).
// ✕ removes the frame (its poll, audio and presence end with it); room audio is the chat's own ▶ bar and never autoplays, except that a
// chat that came along playing (below) plays here too (a blocked autoplay asks for a tap, as in the window).
// "The chat follows": a pad page whose chat floats leaves sessionStorage 'patv.chat.follow' {room, slug, at, audio} when the tab goes
// (pad-dock.js); this page reads it once (and drops it) - under 2 minutes old: one of this table's pads with a chat, or (tablechat) any
// pad the server says this viewer may open here - opened, with a toast. This page leaves the same mark when it goes with the chat open,
// so it follows table -> lobby -> table. sessionStorage = this tab.
// The frame and this page talk by postMessage (same origin, this frame only): up ready / closed / retired / new / audio, down pvp / focus.
// No chat content ever crosses. Strings: CZ.T('js.casino.chat_*'), defaults = locales/en.json.
(function () {
  "use strict";
  const CZ = window.CZ;
  const root = document.getElementById("cb");
  const panel = document.getElementById("cz-chat");
  const btn = document.getElementById("cz-chatbtn");
  if (!CZ || !root || !CZ.tableId || !panel || !btn) return;
  const T = CZ.T;
  const FOLLOW = "patv.chat.follow", FOLLOW_MS = 120000, PICK = "patv.cz.chat." + CZ.tableId;
  const RECENT = "patv.cz.chat.recent", RECENT_MAX = 6, LIST_MS = 30000, ADDR_MS = 700;   // (review: 700 ms - a phone typist's pauses ran 420 ms)
  const TABLE_ROLES = { home: 1, pushed: 1, advert: 1 };
  const $p = (sel) => panel.querySelector(sel);
  const body = $p(".cz-chat-b"), titleEl = $p(".cz-chat-n"), dot = $p(".cz-chat-dot"), bar = $p(".cz-chat-bar");
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };
  const ls = {
    get(k) { try { const s = window.localStorage; return s ? s.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { const s = window.localStorage; if (s) s.setItem(k, v); } catch (e) { /* blocked */ } },
  };
  const roomKey = (id) => String(id == null ? "" : id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);   // = dock-link.js roomKey
  let pads = [], cur = null, frame = null, ready = false, queue = [], mini = false, autoMini = false, audioOn = false, retired = false;
  // review fixes: act = the table needs you now (your turn, a Blackjack bet before the deadline, insurance - cz:state from casinohm /
  // casinobj); tall = a sheet is open in the chat (⚔️ Duel's stake...) and needs the height
  let act = false, tall = false;
  // tablechat: more = other pads' chats exist for this viewer (the people / pads answer); the picker's state
  let more = false, picking = false, pk = null, pickFrom = null, all = null, allAt = 0, loading = null, failed = false, addrT = null, asking = null;
  const addrDone = new Map();          // address -> its pad entry | null (this picker session; only the server's real answers)
  // review fixes: addrFail = address -> "rate" | "error" (a lookup that got no answer - said so, tried again on Enter / Try again);
  // addrWait = the address whose lookup waits for a pause in the typing; known = slug -> a pad entry the server gave this page (its list,
  // a lookup, the table's pads) - the only names 💬 shows for a saved pick; confirming = the saved pick's lookup in flight; opening = a 💬
  // press waiting for it; mountedBy = "user" | "follow" (a chat that came along by itself doesn't open the picker when it closes to you)
  const addrFail = new Map(), known = new Map(), confirmTried = new Set();
  let addrWait = null, confirming = null, opening = false, mountedBy = "user";
  // the follow mark is read once, at load (and dropped: a reload doesn't re-open a chat closed meanwhile)
  let follow = null;
  try { follow = JSON.parse(ss.get(FOLLOW) || "null"); } catch (e) { follow = null; }
  ss.del(FOLLOW);
  if (!follow || typeof follow !== "object" || !(Date.now() - Number(follow.at) < FOLLOW_MS)) follow = null;

  const chatPads = () => pads.filter((p) => p && p.chat && p.slug);
  const isTable = (p) => !!(p && TABLE_ROLES[p.role]);
  const okPad = (p) => !!(p && typeof p.slug === "string" && p.slug && typeof p.name === "string");
  const viewer = () => String(CZ.me || "").toLowerCase();
  const norm = (s) => { let v = String(s == null ? "" : s).toLowerCase(); try { v = v.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) { /* old engine */ } return v.trim(); };
  /** an address as typed or pasted (night-orchard, p/night-orchard, a pad link) -> its slug, or null (= casino/chatpads.js addressOf) */
  function addressOf(raw) {
    let s = String(raw == null ? "" : raw).trim().toLowerCase().slice(0, 300);
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/, "").replace(/[?#].*$/, "").replace(/^\/+/, "").replace(/^p\//, "").replace(/\/+$/, "");
    return /^[a-z0-9][a-z0-9-]{0,79}$/.test(s) ? s : null;
  }
  /** typed as an address on purpose: p/…, /p/… or a pad link - the part after p/ may still be empty (a plain word is a name search) */
  const addrForm = (raw) => /^\s*(?:[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/|[\w.-]+\.[a-z]{2,}\/|\/)?p\//i.test(String(raw || ""));
  /** the pad this table's tab last opened here: {slug} - this viewer's only (review: another account or a guest in the tab never gets it,
   *  and it carries no name - 💬 names a pad only as the server gave it); {slug, legacy} = 1.99ajw's bare slug: one of the table's pads only */
  function savedPick() {
    const v = ss.get(PICK);
    if (!v) return null;
    let o = null;
    try { o = JSON.parse(v); } catch (e) { o = null; }
    if (o && typeof o === "object") return typeof o.slug === "string" && o.slug && o.u === viewer() ? { slug: o.slug } : null;
    return { slug: String(typeof o === "string" ? o : v), legacy: true };
  }
  const atTable = (p) => !!(p && pads.some((x) => x && x.slug === p.slug));
  const saidNo = (slug) => pads.some((x) => x && x.slug === slug && !x.chat);       // (a table pad whose chat isn't this viewer's)
  /** the saved pick as the server last gave it to this page (a table pad with a chat, a pad of the list or a lookup) - or null */
  function pickedPad() {
    const s = savedPick();
    if (!s) return null;
    const tp = chatPads().find((x) => x.slug === s.slug);
    if (tp || s.legacy || saidNo(s.slug)) return tp || null;
    return known.get(s.slug) || null;
  }
  /** review: the saved pick, confirmed - a table pad with a chat at once; any other pad is asked of the server (?slug=) -> its entry, null
   *  (not open to this viewer here: forgotten) or undefined (no answer: kept, and the picker opens) */
  function confirmPick() {
    const s = savedPick();
    if (!s) return Promise.resolve(null);
    const p0 = pickedPad();
    if (p0) return Promise.resolve(p0);
    if (s.legacy) return Promise.resolve(null);
    if (saidNo(s.slug)) { forget(s.slug); return Promise.resolve(null); }
    if (confirming && confirming.slug === s.slug) return confirming.p;
    const p = lookup(s.slug).then((r) => {
      if (confirming && confirming.p === p) confirming = null;
      if (!r.ok) return undefined;
      if (!r.pad) { forget(s.slug); return null; }
      known.set(s.slug, r.pad); known.set(r.pad.slug, r.pad);
      paintBtn();
      return r.pad;
    });
    confirming = { slug: s.slug, p };
    return p;
  }
  /** review: a pad whose chat closed to this viewer here - this tab's pick (when it names it) and Recent let it go */
  function forget(slug) {
    if (!slug) return;
    const s = savedPick();
    if (s && s.slug === slug) ss.del(PICK);
    known.delete(slug);
    const r = recentList();
    if (r.includes(slug)) ls.set(RECENT, JSON.stringify({ u: viewer(), s: r.filter((x) => x !== slug) }));
    if (all) all = all.filter((x) => x.slug !== slug);
    paintBtn();
  }
  function recentList() {
    let o = null;
    try { o = JSON.parse(ls.get(RECENT) || "null"); } catch (e) { o = null; }
    if (!o || typeof o !== "object" || o.u !== viewer() || !Array.isArray(o.s)) return [];
    return o.s.filter((x) => typeof x === "string" && addressOf(x) === x).slice(0, RECENT_MAX);
  }
  function remember(slug) {
    const s = addressOf(slug);
    if (!s || s !== slug) return;
    ls.set(RECENT, JSON.stringify({ u: viewer(), s: [s].concat(recentList().filter((x) => x !== s)).slice(0, RECENT_MAX) }));
  }

  function mode() { const w = window.innerWidth || document.documentElement.clientWidth; return w >= 1100 ? "dock" : w > 760 ? "float" : "sheet"; }
  function fineHover() { try { return !!(window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches); } catch (e) { return false; } }
  function layout() {
    const on = !!cur || picking;
    const m = mode();
    const cl = document.body.classList;
    cl.toggle("cz-chat-on", on);
    for (const k of ["dock", "float", "sheet"]) cl.toggle("cz-chat-" + k, on && m === k);
    // (review: a chat that moved to its own window collapses to its bar - Bring it here - and a docked table gets its width back;
    // tablechat: the picker over it shows instead)
    cl.toggle("cz-chat-mini", on && (mini || (retired && !picking)));
    cl.toggle("cz-chat-retired", on && retired && !picking);
    cl.toggle("cz-chat-act", on && act);
    // (review: the picker grows only while the table doesn't need you - on your turn a tall sheet covered Fold / Call / Raise)
    cl.toggle("cz-chat-tall", on && (tall || (picking && !act)) && !(retired && !picking));
    cl.toggle("cz-chat-pk-on", on && picking);
    panel.hidden = !on;
    if (pk) pk.el.hidden = !picking;
    // (↗️ its own window: a desktop thing, as in the Dock - a phone keeps the sheet; not while only the picker is open)
    $p(".cz-chat-win").hidden = m === "sheet" || !fineHover() || !cur;
    const pick = $p(".cz-chat-pick");
    pick.hidden = !(picking || more || chatPads().length > 1 || (cur && !isTable(cur)));
    pick.setAttribute("aria-expanded", picking ? "true" : "false");
    placeTop();
    btn.setAttribute("aria-expanded", on && !mini && (!retired || picking) ? "true" : "false");
  }
  // (docked: from under the site's header - it scrolls away - to the bottom of the window)
  const nav = document.querySelector(".navbar");
  function placeTop() {
    if (!(cur || picking) || mode() !== "dock") return;
    const top = nav ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom)) : 0;
    panel.style.setProperty("--czc-top", top + "px");
  }
  window.addEventListener("scroll", placeTop, { passive: true });
  function paintBtn() {
    const list = chatPads();
    btn.hidden = !list.length && !more && !cur;
    const lbl = btn.querySelector(".cz-chat-lbl");
    // (the pad 💬 opens: the one this tab last opened at this table - review: by the name the server gave, never a stored one - else the
    // table's only pad; a saved pick not yet confirmed: plain "Chat")
    const s = savedPick(), sp = pickedPad();
    const pending = !!(s && !sp && !s.legacy && !saidNo(s.slug));
    const one = sp || (!pending && list.length === 1 ? list[0] : null);
    if (lbl) lbl.textContent = one ? T("chat_pad", "Chat · {pad}", { pad: one.name }) : T("chat_btn", "Chat");
  }
  function post(m) { if (frame && frame.contentWindow) { try { frame.contentWindow.postMessage(m, location.origin); } catch (e) { /* gone */ } } }
  function send(m) { if (ready) post(m); else queue.push(m); }
  function teardown() {
    if (frame) { const f = frame; frame = null; f.remove(); }
    ready = false; queue = []; audioOn = false; retired = false; tall = false;
    bar.hidden = true; dot.hidden = true;
  }
  /** the panel's title: the pad's name, a link to the pad (a new tab - the table stays; the frame's own pad chip is left out, embed CSS) */
  function paintTitle(pad) {
    titleEl.textContent = "";
    if (!pad) { titleEl.textContent = T("chat_pick_title", "Pick a pad's chat"); return; }
    const a = document.createElement("a");
    a.href = "/p/" + encodeURIComponent(pad.slug); a.target = "_blank"; a.rel = "noopener";
    a.textContent = pad.name; a.title = T("chat_open_pad", "Open the pad: {pad}", { pad: pad.name });
    titleEl.appendChild(a);
    // (review: a pad that isn't this table's - the people at the table may not be there; say where you'd be typing)
    if (!atTable(pad)) {
      const n = document.createElement("span");
      n.className = "cz-chat-sub";
      n.textContent = T("chat_not_table", "Not this table's chat · p/{slug}", { slug: pad.slug });
      n.title = n.textContent;
      titleEl.appendChild(n);
    }
  }
  function mount(pad, o) {
    teardown();
    frame = document.createElement("iframe");
    frame.className = "cz-chat-f";
    frame.setAttribute("title", T("chat_frame", "Chat: {pad}", { pad: pad.name }));
    frame.setAttribute("allow", "autoplay");
    frame.setAttribute("referrerpolicy", "same-origin");
    frame.setAttribute("src", "/p/" + encodeURIComponent(pad.slug) + "/chat?embed=1" + (o && o.audio ? "#listen" : ""));
    body.appendChild(frame);
  }
  function stopAddr() { clearTimeout(addrT); addrWait = null; asking = null; }
  /** review (UX 5): after a pick the focus goes to ▾ (or the title's link) - not lost to the page */
  function focusAfterPick() {
    const pick = $p(".cz-chat-pick"), a = titleEl.querySelector("a");
    const t = pick && !pick.hidden ? pick : a;
    try { if (t) t.focus(); } catch (e) { /* gone */ }
  }
  /** review nit: a pad just opened from the picker is under Recent at once (not after the list's 30 s cache) */
  function toRecent(p) {
    if (!all || isTable(p) || atTable(p)) return;
    const i = all.findIndex((x) => x.slug === p.slug);
    if (i >= 0 && isTable(all[i])) return;
    const e = Object.assign({}, i >= 0 ? all[i] : p, { role: "recent" });
    if (i >= 0) all.splice(i, 1);
    let at = 0;
    while (at < all.length && isTable(all[at])) at++;
    all.splice(at, 0, e);
  }
  /** open pad's chat here (the same pad again: just shown); pad = an entry the server gave (o.via "follow": the chat came along) */
  function open(pad, o) {
    if (!pad) return;
    const fromPick = picking;
    picking = false;
    stopAddr();
    mountedBy = o && o.via === "follow" ? "follow" : "user";
    if (cur && cur.slug === pad.slug && (frame || retired)) { paintTitle(cur); if (retired) mount(pad, o); setMini(false); if (fromPick) focusAfterPick(); return; }
    cur = { room: String(pad.room || ""), slug: pad.slug, name: String(pad.name || pad.slug), role: String(pad.role || "pad") };
    known.set(cur.slug, Object.assign({}, pad));
    // (review: the viewer's, and no name - a pad's title never outlives what the server says to whoever is signed in here)
    ss.set(PICK, JSON.stringify({ u: viewer(), slug: cur.slug }));
    remember(cur.slug);
    toRecent(cur);
    paintTitle(cur);
    mini = false; autoMini = false;
    mount(cur, o);
    layout();
    paintBtn();
    if (fromPick) focusAfterPick();
  }
  function close() {
    teardown();
    cur = null; mini = false; autoMini = false; picking = false;
    stopAddr();
    layout();
    paintBtn();
    try { btn.focus(); } catch (e) { /* gone */ }
  }
  function setMini(on) {
    mini = !!on;
    if (!mini) dot.hidden = true;
    const b = $p(".cz-chat-min");
    if (b) { const l = mini ? T("chat_expand", "Expand the chat") : T("chat_min", "Minimize the chat"); b.setAttribute("aria-label", l); b.title = l; b.querySelector(".ds-ic").textContent = mini ? "➕" : "➖"; }
    layout();
  }

  // ── tablechat: the picker - every pad chat this viewer may open, in the panel ──
  const mk = (tag, cls, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (parent) parent.appendChild(n); return n; };
  function ensurePicker() {
    if (pk) return pk;
    const el = mk("div", "cz-chat-pk");
    el.id = "cz-chat-pk"; el.hidden = true;
    el.setAttribute("role", "region"); el.setAttribute("aria-label", T("chat_which", "Which pad's chat?")); el.setAttribute("tabindex", "-1");
    const top = mk("div", "cz-pk-top", el);
    const back = mk("button", "cz-pk-back", top); back.setAttribute("type", "button"); back.hidden = true;
    const ql = mk("label", "cz-pk-ql", top);
    const ic = mk("span", "ds-ic", ql); ic.setAttribute("aria-hidden", "true"); ic.textContent = "🔎";
    const q = mk("input", "cz-pk-q", ql);
    q.setAttribute("type", "search"); q.setAttribute("autocomplete", "off"); q.setAttribute("autocapitalize", "off"); q.setAttribute("spellcheck", "false");
    q.setAttribute("enterkeyhint", "go"); q.setAttribute("maxlength", "200");
    q.setAttribute("aria-label", T("chat_find", "Find a pad")); q.setAttribute("placeholder", T("chat_find_ph", "Find a pad · name or p/address"));
    const list = mk("div", "cz-pk-l", el);
    const st = mk("p", "cz-pk-st", el); st.setAttribute("role", "status");
    const foot = mk("p", "cz-pk-foot", el); foot.hidden = true;
    if (!CZ.signed) {
      const a = mk("a", null, foot);
      a.href = "/login?next=" + encodeURIComponent(location.pathname || "/");
      a.textContent = T("chat_signin_more", "Sign in for members' pads");
      foot.hidden = false;
    }
    panel.insertBefore(el, body);
    back.addEventListener("click", () => closePicker(true));
    q.addEventListener("input", () => { render(); });
    el.addEventListener("keydown", onKey);
    pk = { el, back, q, list, st, foot };
    return pk;
  }
  function onKey(e) {
    const items = pk.list.querySelectorAll(".cz-pk-i");
    const arr = Array.prototype.slice.call(items);
    const i = arr.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      if (e.target === pk.q && pk.q.value) { pk.q.value = ""; render(); return; }
      closePicker(true); return;
    }
    if (e.key === "Enter" && e.target === pk.q) {
      e.preventDefault();
      if (arr.length) { arr[0].click(); return; }
      const a = addressOf(pk.q.value);       // (a full address with no match: ask for that one pad now - again after a failed ask)
      if (a) { addrFail.delete(a); if (!addrDone.has(a)) askAddress(a, 0); render(); }
      return;
    }
    if (!arr.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); arr[Math.min(arr.length - 1, i + 1)].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) pk.q.focus(); else arr[i - 1].focus(); }
    else if ((e.key === "Home" || e.key === "End") && i >= 0) { e.preventDefault(); arr[e.key === "Home" ? 0 : arr.length - 1].focus(); }
  }
  /** o.auto: opened by the page (a chat that just closed to you) - on your turn it starts minimized beside the action dock */
  function openPicker(from, o) {
    ensurePicker();
    pickFrom = from || btn;
    picking = true; mini = false; autoMini = false;
    addrDone.clear(); addrFail.clear(); stopAddr();
    pk.q.value = "";
    pk.back.hidden = !cur;
    if (cur) pk.back.textContent = "‹ " + T("chat_back", "Back to {pad}", { pad: cur.name });
    paintTitle(null);
    render();
    layout();
    load(false);
    if (o && o.auto && act && mode() !== "dock") { autoMini = true; setMini(true); return; }
    try { if (fineHover()) pk.q.focus(); else pk.el.focus(); } catch (e) { /* gone */ }
  }
  function closePicker(refocus) {
    if (!picking) return;
    picking = false;
    stopAddr();
    if (!cur) { close(); return; }
    paintTitle(cur);
    layout();
    if (refocus) { try { (pickFrom && !pickFrom.hidden ? pickFrom : btn).focus(); } catch (e) { /* gone */ } }
  }
  /** the server's list (GET /api/casino/t/:id/chatpads - the recent slugs ride along; each is checked there again) */
  function load(force) {
    if (loading) return loading;
    if (!force && all && Date.now() - allAt < LIST_MS) return Promise.resolve(all);
    if (typeof fetch !== "function") { failed = true; render(); return Promise.resolve(null); }
    failed = false;
    const rec = recentList();
    loading = fetch("/api/casino/t/" + encodeURIComponent(CZ.tableId) + "/chatpads" + (rec.length ? "?recent=" + encodeURIComponent(rec.join(",")) : ""),
                    { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r && r.status === 429 ? "rate" : r && r.ok ? r.json() : null))
      .then((j) => {
        if (j === "rate") failed = "rate";
        else if (j && j.ok && Array.isArray(j.pads)) { all = j.pads.filter(okPad); allAt = Date.now(); for (const p of all) known.set(p.slug, p); paintBtn(); }
        else failed = true;
      })
      .catch(() => { failed = true; })
      .then(() => { loading = null; if (picking) render(); return all; });
    render();
    return loading;
  }
  /** one pad by its exact address (?slug=); never a name search -> {ok: true, pad: entry | null} = the server's answer, or {ok: false,
   *  why: "rate" | "error"} = no answer (review: never taken for "no such pad") */
  function lookup(a) {
    if (!a || typeof fetch !== "function") return Promise.resolve({ ok: false, why: "error" });
    return fetch("/api/casino/t/" + encodeURIComponent(CZ.tableId) + "/chatpads?slug=" + encodeURIComponent(a), { credentials: "same-origin", cache: "no-store" })
      .then((r) => {
        if (r && r.status === 429) return { ok: false, why: "rate" };
        if (!r || !r.ok) return { ok: false, why: "error" };
        return r.json().then((j) => (j && j.ok ? { ok: true, pad: okPad(j.pad) ? j.pad : null } : { ok: false, why: "error" }));
      })
      .catch(() => ({ ok: false, why: "error" }));
  }
  /** ask for address a after `wait` ms (a pause in the typing - each new address restarts it; Enter: 0) */
  function askAddress(a, wait) {
    if (asking === a || (addrWait === a && wait > 0)) return;
    clearTimeout(addrT); addrWait = null;
    const go = () => {
      addrWait = null; asking = a;
      if (picking) render();
      lookup(a).then((r) => {
        if (asking === a) asking = null;
        if (r.ok) { addrDone.set(a, r.pad); addrFail.delete(a); if (r.pad) known.set(r.pad.slug, r.pad); }
        else addrFail.set(a, r.why);
        if (picking) render();
      });
    };
    if (wait > 0) { addrWait = a; addrT = setTimeout(go, wait); } else go();
  }
  function metaOf(p) {
    const roleTxt = { home: T("chat_role_home", "plays here"), pushed: T("chat_role_pushed", "plays here"), advert: T("chat_role_advert", "advertised here") };
    const bits = [];
    if (roleTxt[p.role]) bits.push(roleTxt[p.role]);
    bits.push("p/" + p.slug);
    const n = Number(p.count);
    if (n > 0) bits.push(T("chat_count", "{n} in the room", { n: String(Math.floor(n)) }));
    return bits.join(" · ");
  }
  function itemOf(p) {
    const b = mk("button", "cz-pk-i");
    b.setAttribute("type", "button");
    b.setAttribute("data-slug", p.slug);
    const here = !!(cur && cur.slug === p.slug);
    if (here) b.setAttribute("aria-current", "true");
    const ic = mk("span", "cz-pk-ic", b); ic.setAttribute("aria-hidden", "true"); ic.textContent = here ? "✓" : "💬";
    const t = mk("span", "cz-pk-t", b);
    mk("span", "cz-pk-n", t).textContent = p.name;
    mk("span", "cz-pk-m", t).textContent = metaOf(p);
    b.addEventListener("click", () => open(p));
    return b;
  }
  function render() {
    if (!pk) return;
    const raw = pk.q.value, q = norm(raw), a = addressOf(raw), form = addrForm(raw);
    // the list: the server's (every pad), or the table's own until it comes
    const base = all ? all.slice() : chatPads().map((p) => ({ room: p.room, slug: p.slug, name: p.name, role: p.role }));
    if (cur && !base.some((p) => p.slug === cur.slug)) base.push(Object.assign({}, cur, { role: isTable(cur) ? cur.role : "recent" }));
    const dash = q.replace(/\s+/g, "-");
    // (review: an address typed - p/…, a pasted link - matches the pads whose address STARTS so, as you type it; a word matches anywhere in
    // the name or the address)
    const hit = form ? (p) => !a || p.slug.indexOf(a) === 0 : (p) => !q || norm(p.name).indexOf(q) >= 0 || p.slug.indexOf(dash) >= 0 || (a && p.slug === a);
    const items = base.filter(hit);
    // an address no pad here has (typed as one: no pad here starts so): ask for that one pad - after a pause in the typing, or on Enter
    // (unlisted pads are reached this way); a plain word is asked only on Enter
    let byAddr = null, aMsg = "", aRetry = null;
    const noMatch = () => T("chat_no_match", "No pad matches “{q}”.", { q: String(raw).trim().slice(0, 60) });
    const wanted = a && !base.some((p) => p.slug === a) && !(form && items.length) ? a : null;
    if (addrWait && addrWait !== wanted) { clearTimeout(addrT); addrWait = null; }        // (typed on past it: not asked)
    if (wanted) {
      if (addrDone.has(a)) { byAddr = addrDone.get(a); if (!byAddr && !items.length) aMsg = noMatch(); }
      else if (addrFail.has(a)) {
        aMsg = addrFail.get(a) === "rate" ? T("chat_slow", "Slow down - try p/{slug} again in a minute.", { slug: a }) : T("chat_look_failed", "Couldn't look up p/{slug}.", { slug: a });
        aRetry = a;
      } else if (asking === a) aMsg = T("chat_looking", "Looking up p/{slug}…", { slug: a });
      else if (form) { askAddress(a, ADDR_MS); aMsg = T("chat_enter_look", "Press Enter to look up p/{slug}", { slug: a }); }
    }
    const groups = [["table", T("chat_sec_table", "At this table"), (p) => isTable(p)], ["recent", T("chat_sec_recent", "Recent"), (p) => p.role === "recent"],
                    ["pad", T("chat_sec_pads", "More pads"), (p) => !isTable(p) && p.role !== "recent"]];
    pk.list.textContent = "";
    let shown = 0;
    const group = (key, label, list) => {
      if (!list.length) return;
      const g = mk("div", "cz-pk-g", pk.list);
      g.setAttribute("role", "group");
      const h = mk("div", "cz-pk-h", g); h.id = "cz-pk-h-" + key; h.textContent = label;
      g.setAttribute("aria-labelledby", h.id);
      list.forEach((p) => { g.appendChild(itemOf(p)); shown++; });
    };
    for (const [key, label, test] of groups) group(key, label, items.filter(test));
    if (byAddr && !items.some((p) => p.slug === byAddr.slug)) group("addr", T("chat_sec_address", "By address"), [byAddr]);
    // the status line under it
    pk.st.textContent = "";
    let msg = "", retry = null;
    if (aMsg) { msg = aMsg; if (aRetry) retry = () => { addrFail.delete(aRetry); askAddress(aRetry, 0); render(); }; }
    else if (loading && !shown) msg = T("chat_loading", "Loading pads…");
    else if (failed && !all) { msg = failed === "rate" ? T("chat_slow_list", "Slow down - try again in a minute.") : T("chat_load_failed", "Couldn't load the pads."); if (!loading) retry = () => load(true); }
    else if (!shown && q && !(form && !a)) msg = noMatch();
    else if (!shown) msg = T("chat_no_pads", "No pad chats are open to you right now.");
    else if (loading) msg = T("chat_loading", "Loading pads…");
    pk.st.textContent = msg;
    pk.st.hidden = !msg;
    if (retry) {
      const r = mk("button", "cz-btn sm ghost cz-pk-retry", pk.st);
      r.setAttribute("type", "button"); r.textContent = T("chat_retry", "Try again");
      r.addEventListener("click", retry);
    }
  }

  /** ↗️ the pad's chat in its own window (the Room Dock's window - the same name, so a window the pad tab opened is reused); its
   *  newer heartbeat retires this frame, which then offers Bring it here */
  function ownWindow() {
    if (!cur) return;
    const w = 420, h = Math.min(760, (screen.availHeight || 800) - 80);
    const x = (window.screenX || 0) + (window.outerWidth || 1280) - w - 24, y = (window.screenY || 0) + 80;
    let win = null;
    try { win = window.open("/p/" + encodeURIComponent(cur.slug) + "/chat" + (audioOn ? "#listen" : ""), "patv-chat-" + roomKey(cur.room), `popup,width=${w},height=${h},left=${x},top=${y}`); } catch (e) { win = null; }
    if (!win || win.closed) CZ.toast(T("chat_pop_blocked", "Pop-ups are blocked for this site, so the chat stays here."), true);
  }
  function showBar(text) {
    teardown();
    retired = true;
    bar.hidden = false;
    bar.querySelector(".cz-chat-bar-t").textContent = text;
    layout();
  }
  window.addEventListener("message", (e) => {
    if (!frame || e.origin !== location.origin || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;
    if (m.t === "patv-chat:ready") { ready = true; const q = queue; queue = []; q.forEach(post); }
    else if (m.t === "patv-chat:closed") {
      if (m.why === "handoff") { close(); CZ.toast(T("chat_back_tab", "The chat went back to the pad tab.")); }
      else if (m.why === "gate") {
        // (review F7: the pad's chat isn't open to you any more - offline, signed out elsewhere, the Dock changed; the frame answered a
        // small card, never the pad page) - the table's pads are asked again (tablechat: and the picker's list)
        // tablechat review: and this tab's pick and Recent let it go (💬 kept reopening it), then the picker - choose another pad (not
        // for a chat that came along by itself)
        const was = cur, by = mountedBy;
        all = null;
        if (was) forget(was.slug);
        close(); CZ.toast(T("chat_none", "That pad's chat isn't open to you here."), true);
        if (CZ.loadPeople) CZ.loadPeople();
        if (by !== "follow" && (more || chatPads().some((x) => !was || x.slug !== was.slug))) openPicker(btn, { auto: true });
      } else if (m.why === "pop_unavail") {
        // (tablechat review: the frame's own "isn't available to you any more" card - a 403 mid-chat - and its ✕: forgotten the same way)
        const was = cur;
        all = null;
        if (was) forget(was.slug);
        close();
      } else close();
    } else if (m.t === "patv-chat:tall") { tall = !!m.on; if (tall && mini) { autoMini = false; setMini(false); } else layout(); }
    else if (m.t === "patv-chat:retired") {
      if (m.key === "pop_moved") showBar(T("chat_in_window", "Chat is open in its own window"));
      else if (m.key === "pop_moved_embed") showBar(T("chat_elsewhere", "Chat is open beside another casino table"));
      // (signed out / no access any more: the frame shows its own card and ✕)
    } else if (m.t === "patv-chat:new") { if (mini) dot.hidden = false; }
    else if (m.t === "patv-chat:audio") audioOn = !!m.on;
  });

  // ── wiring ──
  btn.addEventListener("click", () => {
    // (review: the picker over an open chat closes alone - a second press closes the chat)
    if (picking && cur) { closePicker(false); return; }
    if (picking || (cur && !mini && !retired)) { close(); return; }
    if (cur) { open(cur); return; }
    if (opening) return;
    const list = chatPads(), s = savedPick(), tp = pickedPad();
    // the pad this tab last opened at this table: a table pad with a chat, or one the server gave this page, at once; any other only after
    // the server says it is still open to this viewer here (review: a dead pick kept reopening) - no: the picker (the frame's gate decides
    // again anyway, and a no there forgets it)
    if (tp) { open(tp); return; }
    if (s && saidNo(s.slug)) forget(s.slug);
    else if (s && !s.legacy) {
      opening = true;
      confirmPick().then((p) => { opening = false; if (cur || picking) return; if (p) open(p); else openPicker(btn); });
      return;
    }
    if (list.length === 1) { open(list[0]); return; }
    openPicker(btn);
  });
  $p(".cz-chat-pick").addEventListener("click", (e) => { if (picking) closePicker(true); else openPicker(e.currentTarget); });
  $p(".cz-chat-win").addEventListener("click", ownWindow);
  $p(".cz-chat-min").addEventListener("click", () => { autoMini = false; setMini(!mini); });
  $p(".cz-chat-x").addEventListener("click", close);
  bar.querySelector("button").addEventListener("click", () => { if (cur) { retired = false; mountedBy = "user"; mount(cur); setMini(false); } });
  $p(".cz-chat-h").addEventListener("dblclick", () => { if (mode() !== "dock") setMini(!mini); });
  window.addEventListener("resize", () => { if (cur || picking) layout(); });
  // the sheet (phones) and the float (761-1099px) make room for the action dock while the table needs you - your turn, a Blackjack bet
  // before the deadline, insurance (review: the float covered Raise / All-in, the sheet the Blackjack chips) - and come back after (unless
  // you opened it meanwhile); a phone's sticky dock also rides above a sheet you open while it needs you (cz-chat-act)
  document.addEventListener("cz:state", (e) => {
    const d = e.detail || {};
    act = !!(d.act != null ? d.act : d.myTurn);
    if (!cur && !picking) return;
    if (mode() === "dock" || retired) { layout(); return; }
    if (act && !mini) { autoMini = true; setMini(true); }
    else if (!act && autoMini) { autoMini = false; setMini(false); }
    else layout();
  });
  /** the chat came along (the follow mark) */
  function came(p, f) {
    open(p, { audio: !!f.audio, via: "follow" }); CZ.toast(T("chat_came", "Your chat came along · ✕ closes it"));
    // (review: it came along while the table needs you - it starts minimized beside the action dock and opens after your move)
    if (act && mode() !== "dock") { autoMini = true; setMini(true); }
  }
  function onPeople(d) {
    pads = (d && Array.isArray(d.pads)) ? d.pads : [];
    more = !!(d && d.more);
    // (tablechat: a pad that left the table stays open - any pad's chat may be here; one whose chat isn't yours any more closes - the frame
    // also shows its own card)
    // (review: that one is forgotten too - this tab's pick and Recent; the header's "not this table's chat" note follows the table's pads)
    if (cur) {
      const e = pads.find((p) => p && p.slug === cur.slug);
      if (e && !e.chat) { forget(cur.slug); close(); }
      else { if (!e && isTable(cur)) cur.role = "pad"; if (!picking) paintTitle(cur); }
    }
    paintBtn();
    if (cur || picking) layout();
    // (review: a saved pick that isn't one of the table's pads - the server is asked once whether it is still open to this viewer here,
    // so 💬 can name it; a no forgets it)
    const s = savedPick();
    if (s && !s.legacy && !cur && !confirmTried.has(s.slug) && !pickedPad()) { confirmTried.add(s.slug); confirmPick(); }
    if (follow) {
      const f = follow; follow = null;
      const p = chatPads().find((x) => x.slug === f.slug || roomKey(x.room) === f.room);
      if (p) { if (!cur && !picking) came(p, f); }
      else {
        // tablechat: a pad this table doesn't play in - the server says whether this viewer may open it here (never one of the table's own
        // pads whose chat just said no)
        const a = addressOf(f.slug);
        if (a && a === f.slug && !pads.some((x) => x && x.slug === a)) lookup(a).then((x) => { if (x.ok && x.pad && !cur && !picking) { known.set(x.pad.slug, x.pad); came(x.pad, f); } });
      }
    }
  }
  document.addEventListener("cz:people", (e) => onPeople(e.detail));
  if (CZ.people && CZ.people()) onPeople(CZ.people());       // (an answer that came before this script)
  // the chat follows this tab on: table -> lobby -> table (a pad's chat open here and not in its own window)
  window.addEventListener("pagehide", () => {
    if (cur && frame && !retired) ss.set(FOLLOW, JSON.stringify({ room: roomKey(cur.room), slug: cur.slug, at: Date.now(), audio: audioOn ? 1 : 0 }));
  });
  window.CZChat = {
    open: (slug) => { const p = chatPads().find((x) => x.slug === slug) || (all || []).find((x) => x.slug === slug); if (p) open(p); return !!p; },
    close,
    /** tablechat: the picker (every pad chat this viewer may open) */
    pick: () => openPicker(btn),
    /** ⚔️ Duel / 🥊 Brawl from a seat's person menu: in the pad's chat, where the stake sheet, its second confirm for a million or more and
     *  the challenge's answers are (the chat re-checks the person is a named member and the command is offered) */
    pvp(slug, kind, login) {
      const p = chatPads().find((x) => x.slug === slug);
      if (!p) { CZ.toast(T("chat_none", "That pad's chat isn't open to you here."), true); return; }
      open(p);
      setMini(false);
      send({ t: "patv-chat:pvp", kind, login });
    },
  };
})();
