// public/js/crypto-link.js — 1.99ks: link a crypto wallet by SIGNING (cryptoweb.js / cryptopay.js), copy receiving addresses,
// refresh the viewer's donation statuses on /support. No library: an injected EVM wallet (window.ethereum, EIP-1193) signs
// the server's EIP-4361 text with personal_sign; Phantom / Solflare sign the Solana text with signMessage. Nothing here
// can move funds - no transaction is ever built or requested.
(function () {
  'use strict';
  var _t = window.__t || function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, x) { return v && v[x] != null ? v[x] : m; }); };
  function msgEl(from) {
    var box = from && from.closest ? from.closest('[data-crypto-box]') : null;
    return (box && box.querySelector('[data-crypto-msg]')) || document.querySelector('[data-crypto-msg]');
  }
  function say(from, text, bad) { var m = msgEl(from); if (m) { m.textContent = text; m.className = 'status' + (bad ? ' err' : ' ok'); } }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }
  function hex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2); return s; }
  function utf8Hex(str) { return '0x' + hex(new TextEncoder().encode(str)); }
  function walletError(e) {
    if (e && (e.code === 4001 || /reject|denied|cancel/i.test(String(e.message || '')))) return _t('js.crypto.cancelled', 'Cancelled in the wallet - nothing was linked.');
    return (e && e.message) || _t('js.crypto.failed', 'Linking failed.');
  }

  function linkEvm(btn) {
    var eth = window.ethereum;
    if (!eth || !eth.request) { say(btn, _t('js.crypto.no_evm', 'No Ethereum wallet found in this browser. Install MetaMask (or a similar wallet), or open this page in your wallet app’s browser.'), true); return Promise.resolve(); }
    var address, nonce;
    say(btn, _t('js.crypto.connecting', 'Asking your wallet…'));
    return eth.request({ method: 'eth_requestAccounts' })
      .then(function (acc) { address = acc && acc[0]; if (!address) throw new Error(_t('js.crypto.no_account', 'The wallet shared no account.')); return post('/api/crypto/link/start', { family: 'evm', address: address }); })
      .then(function (j) { nonce = j.nonce; say(btn, _t('js.crypto.sign', 'Sign the message in your wallet (it’s free and can’t move funds).')); return eth.request({ method: 'personal_sign', params: [utf8Hex(j.message), address] }); })
      .then(function (signature) { return post('/api/crypto/link/finish', { nonce: nonce, signature: signature }); });
  }
  function solProvider() {
    if (window.phantom && window.phantom.solana && window.phantom.solana.signMessage) return window.phantom.solana;
    if (window.solflare && window.solflare.signMessage) return window.solflare;
    if (window.solana && window.solana.signMessage) return window.solana;
    return null;
  }
  function linkSol(btn) {
    var p = solProvider();
    if (!p) { say(btn, _t('js.crypto.no_sol', 'No Solana wallet found in this browser. Install Phantom or Solflare, or open this page in the wallet app’s browser.'), true); return Promise.resolve(); }
    var address, nonce;
    say(btn, _t('js.crypto.connecting', 'Asking your wallet…'));
    return Promise.resolve(p.connect())
      .then(function (r) { var pk = (r && r.publicKey) || p.publicKey; address = pk && pk.toString(); if (!address) throw new Error(_t('js.crypto.no_account', 'The wallet shared no account.')); return post('/api/crypto/link/start', { family: 'sol', address: address }); })
      .then(function (j) { nonce = j.nonce; say(btn, _t('js.crypto.sign', 'Sign the message in your wallet (it’s free and can’t move funds).')); return p.signMessage(new TextEncoder().encode(j.message), 'utf8'); })
      .then(function (r) { var s = (r && r.signature) || r; return post('/api/crypto/link/finish', { nonce: nonce, signature: hex(new Uint8Array(s)) }); });
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-crypto-link], [data-crypto-unlink], [data-copy]');
    if (!b) return;
    if (b.hasAttribute('data-copy')) {
      var v = b.getAttribute('data-copy');
      var done = function () { var o = b.textContent; b.textContent = _t('js.crypto.copied', 'Copied'); setTimeout(function () { b.textContent = o; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () { window.prompt('', v); });
      else window.prompt('', v);
      return;
    }
    if (b.hasAttribute('data-crypto-unlink')) {
      if (!window.confirm(_t('js.crypto.unlink_confirm', 'Unlink this wallet? Donations it sends afterwards won’t be credited until it’s linked again.'))) return;
      b.disabled = true;
      post('/api/crypto/unlink', { id: Number(b.getAttribute('data-crypto-unlink')) })
        .then(function () { location.reload(); }, function (e) { b.disabled = false; say(b, e.message, true); });
      return;
    }
    var fam = b.getAttribute('data-crypto-link');
    b.disabled = true;
    (fam === 'sol' ? linkSol(b) : linkEvm(b))
      .then(function (j) {
        b.disabled = false;
        if (!j) return;
        var n = (j.claimed || []).filter(function (c) { return c.status === 'credited'; }).length;
        say(b, n ? _t('js.crypto.linked_claimed', 'Wallet linked - {n} earlier donation(s) credited.', { n: n }) : _t('js.crypto.linked', 'Wallet linked.'));
        setTimeout(function () { location.reload(); }, 1200);
      }, function (e) { b.disabled = false; say(b, walletError(e), true); });
  });

  // /support refreshes the statuses live itself (public/js/support.js, 1.99mn) - no full-page reload here any more
})();
