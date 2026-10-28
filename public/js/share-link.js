/* Shared human-facing links: feed posts and streams. */
(function () {
  'use strict';
  if (window.PATVShare) return;
  function t(key, fallback) { return typeof window.__t === 'function' ? window.__t(key, fallback) : fallback; }
  function url(path) {
    var meta = document.querySelector('meta[name="patv-share-base"]');
    var base = meta ? meta.getAttribute('content') : location.origin;
    return base.replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');
  }
  function share(btn, link, title) {
    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
      var data = { url: link }; if (title) data.title = title;
      navigator.share(data).catch(function () {}); return;
    }
    var lbl = btn.querySelector('.lbl') || btn;
    var original = btn._shareLabel || lbl.textContent || t('js.feed.share', 'Share');
    btn._shareLabel = original;
    function promptLink() { window.prompt(t('js.feed.copy_link', 'Copy the link:'), link); }
    function done() {
      clearTimeout(btn._shareTimer);
      lbl.textContent = t('js.feed.link_copied', 'Link copied'); btn.classList.add('done');
      btn._shareTimer = setTimeout(function () { lbl.textContent = original; btn.classList.remove('done'); }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, promptLink);
    else promptLink();
  }
  window.PATVShare = { url: url, share: share };
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-share-path]');
    if (btn) { e.preventDefault(); share(btn, url(btn.getAttribute('data-share-path'))); }
  });
}());
