// dock-link.js - 1.99ajh dockpop (owner P1): the Room Dock's windows talk to each other in this browser only - a pad tab, the pad's chat
// in its own window (/p/<slug>/chat) and the homepage's Dock. One BroadcastChannel ('patv-dock'); without it a localStorage 'storage'
// event (written, then removed at once); with neither nothing is coordinated and every page just works on its own.
//   PATVDockLink.open({ room, tag, role: 'tab' | 'pop' | 'home', onMsg, onForeign, onSession }) -> { id, ok, send(type, extra), close() }
// A message is {v: 1, t, room, tag, id, at, ...}: room = the pad's ROOM id (pad-dock.js roomKey - the homepage and a pad page can know a
// pad by different slugs), tag = the viewer tag (roompm.tag, never the account id; '' signed out), id = random per window.
// Messages carry NO chat content: the only text is the viewer's own unsent draft (draft / handoff / pop-closed), and only between windows
// of the same tag. A receiver hears its own room and tag only; another tag is a re-check trigger (onForeign: someone else signed in under
// this browser, or this window is the stale one) - except 'audio-on', which reaches every window of the room (one room is never heard
// twice). 'session' (views/partials/chat-sweep.ejs: the first page after a sign-out) has no room or tag. 'tab-gone' (review): a pad tab
// leaving (pagehide) - its window no longer offers "Back in the pad tab". Plain ES5, no dependencies.
(function (W) {
  'use strict';
  var NAME = 'patv-dock', KEY = 'patv.dock.msg', MAX_DRAFT = 300;
  var TYPES = { 'pop-open': 1, 'pop-alive': 1, 'pop-closed': 1, who: 1, 'tab-here': 1, 'tab-gone': 1, 'pop-close-req': 1, handoff: 1, draft: 1, 'audio-on': 1, session: 1 };
  var TEXT = { 'pop-closed': 1, handoff: 1, draft: 1 };     // the only messages that may carry the viewer's own unsent draft
  function rid() {
    try { var a = new Uint32Array(2); W.crypto.getRandomValues(a); return a[0].toString(36) + a[1].toString(36); }
    catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  }
  function str(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
  /** a message as this file sends it, or null - anything else on the channel is ignored */
  function clean(m) {
    if (!m || typeof m !== 'object' || m.v !== 1 || typeof m.t !== 'string' || !TYPES[m.t]) return null;
    var o = { v: 1, t: m.t, room: str(m.room, 120), tag: str(m.tag, 40), id: str(m.id, 40), at: Number(m.at) || 0 };
    if (m.t === 'session') return o;
    if (!o.id) return null;
    if (m.audio != null) o.audio = m.audio === true || m.audio === 1 ? 1 : 0;
    if (m.t === 'handoff' && typeof m.to === 'string') o.to = m.to.slice(0, 40);      // (the tab that asked for it, or '*')
    if ((m.t === 'pop-alive' || m.t === 'pop-open') && m.slow) o.slow = 1;            // (a hidden window: the browser slows its timers)
    if (TEXT[m.t] && typeof m.draft === 'string') o.draft = m.draft.slice(0, MAX_DRAFT);
    return o;
  }
  function busOf() { try { return W.BroadcastChannel ? new W.BroadcastChannel(NAME) : null; } catch (e) { return null; } }
  function storage() { try { var s = W.localStorage; return s && typeof s.setItem === 'function' ? s : null; } catch (e) { return null; } }
  function post(bc, m) {
    if (bc) { try { bc.postMessage(m); return true; } catch (e) { return false; } }
    var s = storage(); if (!s) return false;
    try { s.setItem(KEY, JSON.stringify(m)); s.removeItem(KEY); return true; } catch (e) { return false; }
  }
  function open(o) {
    o = o || {};
    var id = rid(), room = String(o.room || ''), tag = o.tag == null ? '' : String(o.tag), closed = false;
    var bc = busOf(), ls = bc ? null : storage();
    function deliver(raw) {
      if (closed) return;
      var m = clean(raw); if (!m || m.id === id) return;
      if (m.t === 'session') { if (o.onSession) o.onSession(m); return; }
      if (m.tag !== tag) {
        delete m.draft; delete m.to;                // (another viewer's words never reach this window, not even as a trigger)
        if (o.onForeign) o.onForeign(m);
        if (m.t !== 'audio-on' || m.room !== room) return;
      }
      if (m.room !== room) return;
      if (o.onMsg) o.onMsg(m);
    }
    function onMessage(e) { deliver(e && e.data); }
    function onStorage(e) {
      if (!e || e.key !== KEY || !e.newValue) return;
      var m = null; try { m = JSON.parse(e.newValue); } catch (x) { m = null; }
      deliver(m);
    }
    if (bc) bc.addEventListener('message', onMessage);
    else if (ls && W.addEventListener) W.addEventListener('storage', onStorage);
    function send(t, extra) {
      if (closed || !TYPES[t] || t === 'session') return false;
      var m = { v: 1, t: t, room: room, tag: tag, id: id, at: Date.now() };
      if (extra && extra.audio != null) m.audio = extra.audio ? 1 : 0;
      if (t === 'handoff' && extra && extra.to) m.to = String(extra.to).slice(0, 40);
      if ((t === 'pop-alive' || t === 'pop-open') && extra && extra.slow) m.slow = 1;
      if (TEXT[t] && extra && typeof extra.draft === 'string' && extra.draft) m.draft = extra.draft.slice(0, MAX_DRAFT);
      return post(bc, m);
    }
    function close() {
      if (closed) return; closed = true;
      if (bc) { try { bc.removeEventListener('message', onMessage); bc.close(); } catch (e) { /* gone */ } }
      else if (W.removeEventListener) W.removeEventListener('storage', onStorage);
    }
    return { id: id, ok: !!(bc || ls), send: send, close: close, room: room, tag: tag };
  }
  /** every Dock window re-checks who is signed in (chat-sweep.ejs sends the same message itself) */
  function session() { var bc = busOf(); var ok = post(bc, { v: 1, t: 'session' }); if (bc) { try { bc.close(); } catch (e) { /* gone */ } } return ok; }
  /** a pad's room id as the window name and the channel's room ([^A-Za-z0-9_-] -> _) */
  function roomKey(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100); }
  W.PATVDockLink = { open: open, session: session, roomKey: roomKey, _clean: clean, NAME: NAME, KEY: KEY };
})(window);
