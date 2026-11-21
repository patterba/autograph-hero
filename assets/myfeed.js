// Home page "All signings / My favorites" toggle, shown only to logged-in members.
// "My favorites" shows the upcoming signings whose signer (or a team they played for) matches
// one of the member's favorites, with the same rule as the account page feed and the alert
// emails. Favorites come from the copy account.js keeps in localStorage ('ah-favorites') so the
// toggle works right away, then are checked against the account (public.my_account()).
// The choice is remembered on this device ('ah-home-view').
(function () {
  var toggle = document.querySelector('[data-my-toggle]');
  if (!toggle) return;
  var API = toggle.getAttribute('data-supabase');
  var KEY = toggle.getAttribute('data-key');
  var MAX_AGE = 72 * 3600; // logins last 72 hours (account.js)
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-my-feed] .card'));
  var countEl = document.querySelector('[data-my-count]');
  var favsEl = document.querySelector('[data-my-favs]');
  var emptyEl = document.querySelector('[data-my-empty]');

  function nowS() { return Math.floor(Date.now() / 1000); }
  function read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function write(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked */ } }

  var session = read('ah-session');
  if (!session || !session.access_token) return;
  if (session.signed_in_at && nowS() - session.signed_in_at > MAX_AGE) return;

  // A fresh access token for the member, renewed if needed. Resolves to '' when logged out.
  function token() {
    var s = read('ah-session');
    if (!s || !s.access_token) return Promise.resolve('');
    if (!s.signed_in_at) s.signed_in_at = nowS();
    if (nowS() - s.signed_in_at > MAX_AGE) return Promise.resolve('');
    if (s.expires_at && s.expires_at - 60 > nowS()) return Promise.resolve(s.access_token);
    if (!s.refresh_token) return Promise.resolve('');
    return fetch(API + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.access_token) {
        var again = read('ah-session'); // another tab may have just renewed it
        return again && again.refresh_token !== s.refresh_token && again.expires_at - 60 > nowS() ? again.access_token : '';
      }
      write('ah-session', {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: j.expires_at || nowS() + (j.expires_in || 3600),
        signed_in_at: s.signed_in_at,
      });
      return j.access_token;
    }).catch(function () { return ''; });
  }

  var favorites = read('ah-favorites') || [];

  function render() {
    var wanted = favorites.map(function (f) { return String(f).toLowerCase().trim(); }).filter(function (f) { return f.length >= 3; });
    var shown = 0;
    cards.forEach(function (c) {
      var terms = (c.getAttribute('data-terms') || '').split('|');
      var hit = wanted.length > 0 && terms.some(function (t) {
        return t.length >= 3 && wanted.some(function (f) { return t.indexOf(f) !== -1 || (t.length >= 4 && f.indexOf(t) !== -1); });
      });
      c.hidden = !hit;
      if (hit) shown++;
    });
    countEl.textContent = shown
      ? shown + (shown === 1 ? ' upcoming signing' : ' upcoming signings') + ' for your favorites, soonest first.'
      : 'Signings for your favorites show here.';
    emptyEl.hidden = shown !== 0;
    favsEl.textContent = '';
    favorites.forEach(function (f) {
      var li = document.createElement('li');
      li.textContent = f;
      favsEl.appendChild(li);
    });
    favsEl.hidden = !favorites.length;
  }

  function show(view) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-home-pane]'), function (el) {
      el.hidden = el.getAttribute('data-home-pane') !== view;
    });
    Array.prototype.forEach.call(toggle.querySelectorAll('[data-view]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view));
    });
    write('ah-home-view', view);
  }

  toggle.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-view]') : null;
    if (b) show(b.getAttribute('data-view'));
  });

  render();
  toggle.hidden = false;
  show(read('ah-home-view') === 'mine' ? 'mine' : 'all');

  // Check the favorites against the account (they may have changed on another device).
  token().then(function (t) {
    if (!t) return null;
    return fetch(API + '/rest/v1/rpc/my_account', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: '{}',
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) return 'logged-out';
      return r.ok ? r.json() : null;
    });
  }).then(function (data) {
    if (data === 'logged-out') { show('all'); toggle.hidden = true; return; }
    if (!data || !Array.isArray(data.favorites)) return;
    favorites = data.favorites;
    write('ah-favorites', favorites);
    // The header's "Hi, <first name>" (assets/app.js).
    var first = String(data.name || '').trim().split(/\s+/)[0];
    if (first) {
      try { localStorage.setItem('ah-first-name', first); window.dispatchEvent(new Event('ah-login')); } catch (e) { /* blocked */ }
    }
    render();
  }).catch(function () { /* offline: keep the saved copy */ });
})();
