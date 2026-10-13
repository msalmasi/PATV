// banner-admin.js — /admin/banner (1.99kk, banner.js): approve / reject / take down bookings, settings, house promos.
(function () {
  'use strict';
  function jpost(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Something went wrong.'); return j; });
  }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  function act(btn, url, body) {
    btn.disabled = true;
    jpost(url, body).then(function () { location.reload(); }).catch(function (e) { btn.disabled = false; window.alert(e.message); });
  }
  each('[data-approve]', function (b) {
    b.addEventListener('click', function () {
      if (!window.confirm('Approve this banner? Its PAT are routed now and it shows on its days.')) return;
      act(b, '/api/banner/admin/decide', { id: b.getAttribute('data-approve'), approve: true });
    });
  });
  each('[data-reject]', function (b) {
    b.addEventListener('click', function () {
      var why = window.prompt('Why is it rejected? The buyer sees this; their PAT are refunded in full.');
      if (!why) return;
      act(b, '/api/banner/admin/decide', { id: b.getAttribute('data-reject'), approve: false, reason: why });
    });
  });
  each('[data-takedown]', function (b) {
    b.addEventListener('click', function () {
      var why = window.prompt('Why is it taken down? The buyer sees this. There is no automatic refund.');
      if (!why) return;
      act(b, '/api/banner/admin/takedown', { id: b.getAttribute('data-takedown'), reason: why });
    });
  });
  var set = document.getElementById('bnSettings');
  if (set) set.addEventListener('submit', function (e) {
    e.preventDefault();
    var E = set.elements, msg = document.getElementById('bnSetMsg');
    var body = { banner_enabled: E.banner_enabled.checked, banner_paid_enabled: E.banner_paid_enabled.checked, banner_chat_sponsor: E.banner_chat_sponsor.checked,
                 banner_chat_sponsor_mic: E.banner_chat_sponsor_mic.checked, banner_chat_house_promos: E.banner_chat_house_promos.checked,
                 banner_chat_house_promos_mic: E.banner_chat_house_promos_mic.checked,
                 banner_price_per_day: Number(E.banner_price_per_day.value), banner_max_days: Number(E.banner_max_days.value),
                 banner_max_bookings: Number(E.banner_max_bookings.value), banner_lead_days: Number(E.banner_lead_days.value) };
    msg.textContent = 'Saving…'; msg.className = 'adm-msg';
    jpost('/api/banner/admin/config', body).then(function () { msg.textContent = 'Saved.'; msg.className = 'adm-msg ok'; setTimeout(function () { location.reload(); }, 600); })
      .catch(function (x) { msg.textContent = x.message; msg.className = 'adm-msg err'; });
  });
  var pmsg = document.getElementById('bnPromoMsg');
  each('tr[data-promo] [data-save]', function (b) {
    b.addEventListener('click', function () {
      var tr = b.closest('tr'), q = function (n) { return tr.querySelector('[name=' + n + ']'); };
      var body = { id: tr.getAttribute('data-promo'), kind: tr.getAttribute('data-kind'), enabled: q('enabled').checked, headline: q('headline').value,
                   line: q('line').value, link: q('link').value, weight: Number(q('weight').value), sort: Number(q('sort').value) };
      b.disabled = true;
      jpost('/api/banner/admin/promo', body).then(function () { pmsg.textContent = 'Saved.'; pmsg.className = 'adm-msg ok'; if (!body.id) location.reload(); })
        .catch(function (x) { pmsg.textContent = x.message; pmsg.className = 'adm-msg err'; }).then(function () { b.disabled = false; });
    });
  });
  each('tr[data-promo] [data-del]', function (b) {
    b.addEventListener('click', function () {
      if (!window.confirm('Delete this promo?')) return;
      act(b, '/api/banner/admin/promo/delete', { id: b.closest('tr').getAttribute('data-promo') });
    });
  });
})();
