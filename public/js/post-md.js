// Post and comment spoilers. Delegation also covers newly inserted posts and comments.
(function () {
  'use strict';
  if (window.patvPostMarkdown) return;
  window.patvPostMarkdown = true;
  document.addEventListener('click', function (ev) {
    var button = ev.target.closest('.postmd-spoiler > button');
    if (!button) return;
    var content = button.nextElementSibling;
    if (!content) return;
    var open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    content.hidden = !open;
  });
})();
