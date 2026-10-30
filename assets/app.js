// Installable app: registers the offline worker (/sw.js) and offers "Add to Home Screen".
// Android/Chrome get a one-tap Install button; iPhone/iPad get the Share → Add to Home Screen steps,
// both in the bar that slides up from the bottom of the screen on phones.
(function () {
  var root = document.documentElement;
  var base = root.getAttribute('data-base') || '';
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) root.classList.add('is-app');

  // Service workers need HTTPS (localhost is allowed for testing).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(base + '/sw.js', { scope: base + '/', updateViaCache: 'none' }).catch(function () {});
    });
  }

  // Logged-in members: "Log In" in the header becomes a highlighted "Hi, <first name>" (or
  // "My Account") and the footer link "My Account". Same 72-hour rule as account.js.
  function loginState() {
    var s = null, first = '';
    try { s = JSON.parse(localStorage.getItem('ah-session') || 'null'); first = localStorage.getItem('ah-first-name') || ''; } catch (e) { s = null; }
    var ok = !!(s && s.access_token && (!s.signed_in_at || Date.now() / 1000 - s.signed_in_at <= 72 * 3600));
    Array.prototype.forEach.call(document.querySelectorAll('[data-login-link]'), function (a) {
      var label = a.querySelector('[data-login-label]');
      if (!label) return;
      a.classList.toggle('is-logged-in', ok);
      label.textContent = !ok ? 'Log In' : (first && !a.hasAttribute('data-login-short') ? 'Hi, ' + first : 'My Account');
      if (ok) a.setAttribute('aria-label', 'My account'); else a.removeAttribute('aria-label');
    });
  }
  loginState();
  window.addEventListener('ah-login', loginState);
  window.addEventListener('storage', function (e) { if (!e.key || e.key === 'ah-session' || e.key === 'ah-first-name') loginState(); });

  var ua = navigator.userAgent;
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var android = /Android/i.test(ua);
  var inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|Snapchat|Twitter/i.test(ua);
  var deferred = null;
  var KEY = 'ah-install-dismissed';

  function dismissedRecently() {
    try { var t = Number(localStorage.getItem(KEY)); return t > 0 && Date.now() - t < 14 * 864e5; } catch (e) { return false; }
  }
  function rememberDismiss() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
  }

  var SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/></svg>';
  var ADD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>';
  var IOS_STEPS = '<ol class="app-steps"><li>Tap <strong>Share</strong> ' + SHARE + ' in Safari. Don\'t see it? Tap <strong>•••</strong> or <strong>☰</strong> to open the menu, then tap Share.</li><li>Scroll down and tap <strong>Add to Home Screen</strong> ' + ADD + '</li><li>Tap <strong>Add</strong>. Autograph Hero opens full screen from your home screen.</li></ol>';

  function install() {
    if (!deferred) return Promise.resolve('unavailable');
    deferred.prompt();
    return deferred.userChoice.then(function (c) { deferred = null; refreshButtons(); return c.outcome; });
  }

  // "Get the app" page: show the right steps or button for this device.
  function refreshButtons() {
    var panel = document.querySelector('[data-app-panel]');
    if (!panel) return;
    var html;
    if (standalone) html = '<p class="app-done">You are using the app. Nice.</p>';
    else if (deferred) html = '<button type="button" class="btn btn-accent" data-install>Install Autograph Hero</button>';
    else if (inApp) html = '<p class="app-note">You are in an app\'s built-in browser. Open this page in ' + (ios ? 'Safari' : 'Chrome') + ' (tap ••• or ⋮, then "Open in browser") to install.</p>';
    else if (ios) html = '<div class="app-card"><p class="eyebrow accent">On this iPhone</p>' + IOS_STEPS + '</div>';
    else if (android) html = '<div class="app-card"><p class="eyebrow accent">On this phone</p><ol class="app-steps"><li>Open this page in <strong>Chrome</strong> and tap the <strong>⋮</strong> menu.</li><li>Tap <strong>Add to home screen</strong>, then <strong>Install</strong>.</li></ol></div>';
    else html = '<p class="app-note">Open <strong>autographhero.com/app/</strong> on your phone to add Autograph Hero to your home screen.</p>';
    panel.innerHTML = html;
    var btn = panel.querySelector('[data-install]');
    if (btn) btn.addEventListener('click', install);
  }

  // The bar that slides up from the bottom on phones once the header scrolls away (built into
  // every page as .submit-bar, shown and hidden by its own script). When the app can be installed,
  // it asks for that instead of "Submit A Signing"; closing it brings the submit bar back.
  var NO_INSTALL = /\/(app|add|signup|admin|offline|unsubscribe|reminder)\/$/;
  var bar = document.querySelector('.submit-bar');
  var submitHtml = bar ? bar.innerHTML : '';
  function canAsk() {
    return !standalone && !dismissedRecently() && !NO_INSTALL.test(location.pathname) && ((ios && !inApp) || (android && deferred));
  }
  function showSubmit() {
    if (!bar || !bar.classList.contains('is-install')) return;
    bar.classList.remove('is-install');
    bar.removeAttribute('aria-label');
    bar.innerHTML = submitHtml;
  }
  function showInstall() {
    if (!bar || bar.classList.contains('is-install') || !canAsk()) return;
    bar.classList.add('is-install');
    bar.setAttribute('aria-label', 'Install the Autograph Hero app');
    bar.innerHTML =
      '<div class="flyup-steps" hidden>' + IOS_STEPS + '</div>' +
      '<div class="flyup-row">' +
      '<img src="' + base + '/assets/app/icon-192.png" alt="" width="40" height="40">' +
      '<span class="flyup-copy"><strong>Get the app</strong><span>Free. Signings one tap away.</span></span>' +
      (android && deferred
        ? '<button type="button" class="btn btn-accent btn-sm" data-act="install">Install</button>'
        : '<button type="button" class="btn btn-accent btn-sm" data-act="how" aria-expanded="false">How to install</button>') +
      '<button type="button" class="flyup-close" data-act="close" aria-label="Not now"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>';
  }
  if (bar) {
    bar.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act || !bar.classList.contains('is-install')) return;
      var a = act.getAttribute('data-act');
      if (a === 'close') { rememberDismiss(); showSubmit(); }
      if (a === 'install') install().then(function (o) { if (o === 'dismissed') rememberDismiss(); if (o !== 'unavailable') showSubmit(); });
      if (a === 'how') {
        var steps = bar.querySelector('.flyup-steps');
        steps.hidden = !steps.hidden;
        act.textContent = steps.hidden ? 'How to install' : 'Hide steps';
        act.setAttribute('aria-expanded', String(!steps.hidden));
      }
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    refreshButtons();
    showInstall();
  });
  window.addEventListener('appinstalled', function () {
    deferred = null;
    showSubmit();
  });

  refreshButtons();
  if (ios) showInstall();
})();
