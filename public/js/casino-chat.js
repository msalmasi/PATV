// casino-chat.js — 1.99?? casino2 (owner 2026-11-04, point 18: "Docking chat doesn't stay active between page switches (like going to
// holdem). Would be nice if users could also bring up a chat from the tables."): a table belongs to pads (the rooms it plays in, then
// the rooms it is advertised in - casino/people.js `pads`), and 💬 Chat opens THAT pad's chat beside the table.
//
// The chat is the pad chat window itself (GET /p/<slug>/chat?embed=1, bridge.js: the same page, auth, veils, Reveal, room PM 'only
// you' lines, autocomplete, person menu, rate limits and presence as /p/<slug>/chat; only its frame headers allow this site to frame it)
// in an <iframe> - one copy of the chat's code, and the Room Dock's window channel (dock-link.js) keeps one poller / one audio across a
// pad tab, a chat window and this frame: the newest wins (a newer window says so here: "Chat is open in its own window · Bring it here").
//   desktop (>= 1100px): docked at the inline end, 360px - the felt keeps its shape and shrinks
//   761-1099px:           a 340px float, with Minimize
//   phones (<= 760px):    a non-modal bottom sheet (about half the screen; minimized = a 44px bar with a new-lines dot) that makes room for
//                         the action dock while it's your turn and comes back after your move
// ✕ removes the frame (its poll, audio and presence end with it); room audio is the chat's own ▶ bar and never autoplays, except that a
// chat that came along playing (below) plays here too (a blocked autoplay asks for a tap, as in the window).
// "The chat follows": a pad page whose chat floats leaves sessionStorage 'patv.chat.follow' {room, slug, at, audio} when the tab goes
// (pad-dock.js); this page reads it once (and drops it) - under 2 minutes old and one of this table's pads with a chat: opened, with a
// toast. This page leaves the same mark when it goes with the chat open, so it follows table -> lobby -> table. sessionStorage = this tab.
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
  const $p = (sel) => panel.querySelector(sel);
  const body = $p(".cz-chat-b"), titleEl = $p(".cz-chat-n"), dot = $p(".cz-chat-dot"), bar = $p(".cz-chat-bar");
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };
  const roomKey = (id) => String(id == null ? "" : id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);   // = dock-link.js roomKey
  let pads = [], cur = null, frame = null, ready = false, queue = [], mini = false, autoMini = false, audioOn = false, retired = false;
  // the follow mark is read once, at load (and dropped: a reload doesn't re-open a chat closed meanwhile)
  let follow = null;
  try { follow = JSON.parse(ss.get(FOLLOW) || "null"); } catch (e) { follow = null; }
  ss.del(FOLLOW);
  if (!follow || typeof follow !== "object" || !(Date.now() - Number(follow.at) < FOLLOW_MS)) follow = null;

  const chatPads = () => pads.filter((p) => p && p.chat && p.slug);
  function mode() { const w = window.innerWidth || document.documentElement.clientWidth; return w >= 1100 ? "dock" : w > 760 ? "float" : "sheet"; }
  function layout() {
    const on = !!cur;
    const m = mode();
    const cl = document.body.classList;
    cl.toggle("cz-chat-on", on);
    for (const k of ["dock", "float", "sheet"]) cl.toggle("cz-chat-" + k, on && m === k);
    cl.toggle("cz-chat-mini", on && mini);
    panel.hidden = !on;
    // (↗️ its own window: a desktop thing, as in the Dock - a phone keeps the sheet)
    let fine = false; try { fine = !!(window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches); } catch (e) { fine = false; }
    $p(".cz-chat-win").hidden = m === "sheet" || !fine;
    placeTop();
    btn.setAttribute("aria-expanded", on && !mini ? "true" : "false");
  }
  // (docked: from under the site's header - it scrolls away - to the bottom of the window)
  const nav = document.querySelector(".navbar");
  function placeTop() {
    if (!cur || mode() !== "dock") return;
    const top = nav ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom)) : 0;
    panel.style.setProperty("--czc-top", top + "px");
  }
  window.addEventListener("scroll", placeTop, { passive: true });
  function paintBtn() {
    const list = chatPads();
    btn.hidden = !list.length;
    const lbl = btn.querySelector(".cz-chat-lbl");
    if (lbl) lbl.textContent = list.length === 1 ? T("chat_pad", "Chat · {pad}", { pad: list[0].name }) : T("chat_btn", "Chat");
  }
  function post(m) { if (frame && frame.contentWindow) { try { frame.contentWindow.postMessage(m, location.origin); } catch (e) { /* gone */ } } }
  function send(m) { if (ready) post(m); else queue.push(m); }
  function teardown() {
    if (frame) { const f = frame; frame = null; f.remove(); }
    ready = false; queue = []; audioOn = false; retired = false;
    bar.hidden = true; dot.hidden = true;
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
  /** open pad's chat here (the same pad again: just shown) */
  function open(pad, o) {
    if (!pad) return;
    if (cur && cur.slug === pad.slug && (frame || retired)) { if (retired) mount(pad, o); setMini(false); return; }
    cur = pad;
    ss.set(PICK, pad.slug);
    titleEl.textContent = pad.name;
    $p(".cz-chat-pick").hidden = chatPads().length < 2;
    mini = false; autoMini = false;
    mount(pad, o);
    layout();
  }
  function close() {
    teardown();
    cur = null; mini = false; autoMini = false;
    layout();
    try { btn.focus(); } catch (e) { /* gone */ }
  }
  function setMini(on) {
    mini = !!on;
    if (!mini) dot.hidden = true;
    const b = $p(".cz-chat-min");
    if (b) { const l = mini ? T("chat_expand", "Expand the chat") : T("chat_min", "Minimize the chat"); b.setAttribute("aria-label", l); b.title = l; b.querySelector(".ds-ic").textContent = mini ? "➕" : "➖"; }
    layout();
  }
  /** 💬 with several pads: a small picker (remembered for this table in this tab) */
  function pick(anchor) {
    const old = document.querySelector(".cz-chat-menu");
    if (old) { old.remove(); return; }
    const list = chatPads();
    if (list.length === 1) { open(list[0]); return; }
    const m = document.createElement("div"); m.className = "pm-pop rmd-pm cz-chat-menu"; m.setAttribute("role", "menu"); m.setAttribute("aria-label", T("chat_which", "Which pad's chat?"));
    const roleTxt = { home: T("chat_role_home", "plays here"), pushed: T("chat_role_pushed", "plays here"), advert: T("chat_role_advert", "advertised here") };
    list.forEach((p) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "pm-pop-i"; b.setAttribute("role", "menuitem");
      b.textContent = "💬 " + p.name;
      const w = document.createElement("small"); w.className = "pm-pop-why"; w.textContent = roleTxt[p.role] || ""; b.appendChild(w);
      b.addEventListener("click", () => { m.remove(); open(p); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    m.style.left = (Math.max(8, Math.min(r.left, vw - m.offsetWidth - 8)) + window.scrollX) + "px";
    m.style.top = (r.bottom + 6 + window.scrollY) + "px";
    const first = m.querySelector("button"); if (first) first.focus();
    const done = (e) => {
      if (e.type === "keydown" && e.key !== "Escape") return;
      if (e.type === "pointerdown" && (m.contains(e.target) || anchor.contains(e.target))) return;
      m.remove(); document.removeEventListener("pointerdown", done, true); document.removeEventListener("keydown", done, true);
      if (e.type === "keydown") anchor.focus();
    };
    document.addEventListener("pointerdown", done, true);
    document.addEventListener("keydown", done, true);
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
  }
  window.addEventListener("message", (e) => {
    if (!frame || e.origin !== location.origin || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;
    if (m.t === "patv-chat:ready") { ready = true; const q = queue; queue = []; q.forEach(post); }
    else if (m.t === "patv-chat:closed") {
      if (m.why === "handoff") { close(); CZ.toast(T("chat_back_tab", "The chat went back to the pad tab.")); }
      else close();
    } else if (m.t === "patv-chat:retired") {
      if (m.key === "pop_moved") showBar(T("chat_in_window", "Chat is open in its own window"));
      else if (m.key === "pop_moved_embed") showBar(T("chat_elsewhere", "Chat is open beside another casino table"));
      // (signed out / no access any more: the frame shows its own card and ✕)
    } else if (m.t === "patv-chat:new") { if (mini) dot.hidden = false; }
    else if (m.t === "patv-chat:audio") audioOn = !!m.on;
  });

  // ── wiring ──
  btn.addEventListener("click", () => {
    if (cur && !mini && !retired) { close(); return; }
    if (cur) { open(cur); return; }
    const list = chatPads();
    if (list.length > 1) {
      const saved = ss.get(PICK), p = saved && list.find((x) => x.slug === saved);
      if (p) { open(p); return; }
      pick(btn); return;
    }
    open(list[0]);
  });
  $p(".cz-chat-pick").addEventListener("click", (e) => pick(e.currentTarget));
  $p(".cz-chat-win").addEventListener("click", ownWindow);
  $p(".cz-chat-min").addEventListener("click", () => { autoMini = false; setMini(!mini); });
  $p(".cz-chat-x").addEventListener("click", close);
  bar.querySelector("button").addEventListener("click", () => { if (cur) { retired = false; mount(cur); setMini(false); } });
  $p(".cz-chat-h").addEventListener("dblclick", () => { if (mode() !== "dock") setMini(!mini); });
  window.addEventListener("resize", () => { if (cur) layout(); });
  // a phone: the sheet makes room for the action dock on your turn, and comes back after your move (unless you opened it meanwhile)
  document.addEventListener("cz:state", (e) => {
    if (!cur || mode() !== "sheet") return;
    const myTurn = !!(e.detail && e.detail.myTurn);
    if (myTurn && !mini) { autoMini = true; setMini(true); }
    else if (!myTurn && autoMini) { autoMini = false; setMini(false); }
  });
  function onPeople(d) {
    pads = (d && Array.isArray(d.pads)) ? d.pads : [];
    paintBtn();
    if (cur && !chatPads().some((p) => p.slug === cur.slug)) close();         // (that pad left the table, or its chat isn't yours any more)
    if (follow) {
      const f = follow; follow = null;
      const p = chatPads().find((x) => x.slug === f.slug || roomKey(x.room) === f.room);
      if (p && !cur) { open(p, { audio: !!f.audio }); CZ.toast(T("chat_came", "Your chat came along · ✕ closes it")); }
    }
  }
  document.addEventListener("cz:people", (e) => onPeople(e.detail));
  if (CZ.people && CZ.people()) onPeople(CZ.people());       // (an answer that came before this script)
  // the chat follows this tab on: table -> lobby -> table (a pad's chat open here and not in its own window)
  window.addEventListener("pagehide", () => {
    if (cur && frame && !retired) ss.set(FOLLOW, JSON.stringify({ room: roomKey(cur.room), slug: cur.slug, at: Date.now(), audio: audioOn ? 1 : 0 }));
  });
  window.CZChat = {
    open: (slug) => { const p = chatPads().find((x) => x.slug === slug); if (p) open(p); return !!p; },
    close,
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
