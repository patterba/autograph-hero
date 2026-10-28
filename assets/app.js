// Installable app: registers the offline worker (/sw.js) and offers "Add to Home Screen".
// Android/Chrome get a one-tap Install button; iPhone/iPad get the Share → Add to Home Screen steps.
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
  var IOS_STEPS = '<ol class="app-steps"><li>Tap <strong>Share</strong> ' + SHARE + ' in Safari. On newer iPhones, tap <strong>•••</strong> first, then Share.</li><li>Scroll down and tap <strong>Add to Home Screen</strong> ' + ADD + '</li><li>Tap <strong>Add</strong>. Autograph Hero opens full screen from your home screen.</li></ol>';

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

  // Bottom banner on phones, a few seconds after the page opens.
  var NO_BANNER = /\/(app|add|signup|admin|offline|unsubscribe)\/$/;
  function showBanner() {
    if (standalone || dismissedRecently() || NO_BANNER.test(location.pathname)) return;
    if (!((ios && !inApp) || (android && deferred))) return;
    if (document.querySelector('.app-banner')) return;
    var el = document.createElement('section');
    el.className = 'app-banner';
    el.setAttribute('aria-label', 'Install the Autograph Hero app');
    el.innerHTML =
      '<div class="app-banner-row">' +
      '<img src="' + base + '/assets/app/icon-192.png" alt="" width="52" height="52">' +
      '<div class="app-banner-copy"><strong>Get the app</strong><span>Signings, one tap from your home screen.</span></div>' +
      (android && deferred
        ? '<button type="button" class="btn btn-accent btn-sm" data-act="install">Install</button>'
        : '<button type="button" class="btn btn-ink btn-sm" data-act="how" aria-expanded="false">How</button>') +
      '<button type="button" class="app-banner-close" data-act="close" aria-label="Not now"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div><div class="app-banner-steps" hidden>' + IOS_STEPS + '</div>';
    document.body.appendChild(el);
    root.classList.add('has-app-banner');
    function close() { el.remove(); root.classList.remove('has-app-banner'); }
    el.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'close') { rememberDismiss(); close(); }
      if (a === 'install') install().then(function (o) { if (o === 'dismissed') rememberDismiss(); if (o !== 'unavailable') close(); });
      if (a === 'how') {
        var steps = el.querySelector('.app-banner-steps');
        steps.hidden = !steps.hidden;
        act.textContent = steps.hidden ? 'How' : 'Hide';
        act.setAttribute('aria-expanded', String(!steps.hidden));
      }
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    refreshButtons();
    setTimeout(showBanner, 2500);
  });
  window.addEventListener('appinstalled', function () {
    deferred = null;
    var b = document.querySelector('.app-banner');
    if (b) b.remove();
    root.classList.remove('has-app-banner');
  });

  refreshButtons();
  if (ios) setTimeout(showBanner, 2500);
})();
