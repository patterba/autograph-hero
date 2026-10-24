// Member login and account page (/account/).
// 1. A member asks for a login link (sent by the site-forms Supabase function, only
//    to emails that signed up for alerts).
// 2. The emailed link comes back here with a login token in the address (#access_token=…).
//    We keep it in this browser's storage and use it to read and save the member's own
//    sign-up through two database functions (my_account, update_my_account).
(function () {
  var root = document.querySelector('[data-account]');
  if (!root) return;
  var API = root.getAttribute('data-supabase');
  var KEY = root.getAttribute('data-key');
  var FORMS = root.getAttribute('data-endpoint');
  var PATH = root.getAttribute('data-path') || '';
  var STORE = 'ah-session';
  var started = Date.now();

  var views = {
    login: root.querySelector('[data-view="login"]'),
    loading: root.querySelector('[data-view="loading"]'),
    account: root.querySelector('[data-view="account"]'),
  };
  var title = document.querySelector('[data-account-title]');
  var lede = document.querySelector('[data-account-lede]');
  var acct = views.account;
  var favInput = acct.querySelector('#m-fav');
  var favList = acct.querySelector('[data-fav-list]');
  var favorites = [];
  var session = null;

  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    if (name === 'account') {
      title.textContent = 'Your account';
      lede.textContent = 'Change your favorites, pause alerts, or delete your account.';
    } else {
      title.textContent = 'Log in';
      lede.textContent = "Signed up for alerts? Enter your email and we'll send you a link to log in. No password needed.";
    }
  }

  function status(form, message, kind) {
    var el = form.querySelector('.f-status');
    el.hidden = !message;
    el.className = 'f-status ' + (kind || '');
    el.textContent = message || '';
  }

  // ---- session storage (may be blocked in private windows; then the login lasts for this page only)
  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; }
  }
  function writeStore(s) {
    session = s;
    try {
      if (s) localStorage.setItem(STORE, JSON.stringify(s));
      else localStorage.removeItem(STORE);
    } catch (e) { /* storage blocked */ }
  }
  function now() { return Math.floor(Date.now() / 1000); }

  function fromHash() {
    if (!location.hash || location.hash.length < 2) return null;
    var h = new URLSearchParams(location.hash.slice(1));
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    if (h.get('error') || h.get('error_description')) return { error: true };
    var token = h.get('access_token');
    if (!token) return null;
    return {
      access_token: token,
      refresh_token: h.get('refresh_token') || '',
      expires_at: Number(h.get('expires_at')) || now() + Number(h.get('expires_in') || 3600),
    };
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new Error('no session'));
    return fetch(API + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    }).then(function (r) {
      if (!r.ok) throw new Error('refresh failed');
      return r.json();
    }).then(function (j) {
      writeStore({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || now() + (j.expires_in || 3600) });
    });
  }

  function token() {
    if (!session) return Promise.reject(new Error('no session'));
    if (session.expires_at - 60 > now()) return Promise.resolve(session.access_token);
    return refresh().then(function () { return session.access_token; });
  }

  function rpc(name, args) {
    return token().then(function (t) {
      return fetch(API + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) { var e = new Error('expired'); e.expired = true; throw e; }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.message) || 'Something went wrong.');
        return j;
      });
    });
  }

  function loggedOut(message) {
    writeStore(null);
    showView('login');
    status(views.login, message || '', message ? 'is-error' : '');
  }

  // ---- favorites chips
  function addFavorite(value) {
    var v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!v) return;
    var exists = favorites.some(function (f) { return f.toLowerCase() === v.toLowerCase(); });
    if (!exists && favorites.length < 25) favorites.push(v);
    favInput.value = '';
    renderFavorites();
  }
  function renderFavorites() {
    favList.textContent = '';
    favorites.forEach(function (f, i) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = f;
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + f);
      remove.textContent = '×';
      remove.addEventListener('click', function () {
        favorites.splice(i, 1);
        renderFavorites();
        favInput.focus();
      });
      li.appendChild(span);
      li.appendChild(remove);
      favList.appendChild(li);
    });
  }
  acct.querySelector('[data-fav-add]').addEventListener('click', function () { addFavorite(favInput.value); favInput.focus(); });
  favInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addFavorite(favInput.value); }
  });

  function fill(data) {
    acct.elements.name.value = data.name || '';
    acct.querySelector('[data-email]').textContent = data.email || '';
    acct.elements.alerts.checked = !!data.alerts;
    favorites = Array.isArray(data.favorites) ? data.favorites.slice() : [];
    renderFavorites();
  }

  function loadAccount() {
    showView('loading');
    rpc('my_account').then(function (data) {
      if (!data) {
        loggedOut("We couldn't find an alert sign-up for that email. Sign up first, then log in.");
        return;
      }
      fill(data);
      showView('account');
    }).catch(function (e) {
      loggedOut(e.expired || /session|refresh/.test(e.message) ? 'Your login has expired. Enter your email for a new link.' : "We couldn't load your account. Please try again.");
    });
  }

  // ---- login form
  views.login.addEventListener('submit', function (e) {
    e.preventDefault();
    var form = views.login;
    var email = form.elements.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      form.elements.email.setAttribute('aria-invalid', 'true');
      form.elements.email.focus();
      status(form, 'Please enter a valid email address.', 'is-error');
      return;
    }
    form.elements.email.removeAttribute('aria-invalid');
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status(form, 'Sending…', '');
    fetch(FORMS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ form: 'login', email: email, path: PATH, elapsed_ms: Date.now() - started, website: form.elements.website.value }),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; });
    }).then(function (r) {
      status(form, (r && r.message) || 'Something went wrong. Please try again in a minute.', r && r.ok ? 'is-success' : 'is-error');
    }).catch(function () {
      status(form, "We couldn't reach the server. Check your connection and try again.", 'is-error');
    }).then(function () { button.disabled = false; });
  });

  // ---- account form
  acct.addEventListener('submit', function (e) {
    e.preventDefault();
    if (favInput.value.trim()) addFavorite(favInput.value);
    var name = acct.elements.name.value.trim();
    if (!name) { acct.elements.name.focus(); status(acct, 'Please enter your name.', 'is-error'); return; }
    var button = acct.querySelector('button[type="submit"]');
    button.disabled = true;
    status(acct, 'Saving…', '');
    rpc('update_my_account', { p_name: name, p_favorites: favorites, p_alerts: acct.elements.alerts.checked })
      .then(function (data) {
        if (data) fill(data);
        status(acct, 'Saved.', 'is-success');
      })
      .catch(function (err) {
        if (err.expired) loggedOut('Your login has expired. Enter your email for a new link.');
        else status(acct, err.message || 'Something went wrong. Please try again.', 'is-error');
      })
      .then(function () { button.disabled = false; });
  });

  acct.querySelector('[data-logout]').addEventListener('click', function () {
    var t = session && session.access_token;
    if (t) fetch(API + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } }).catch(function () {});
    loggedOut('');
    status(views.login, "You're logged out.", 'is-success');
  });

  // Delete: two steps (no browser pop-ups).
  var del = acct.querySelector('[data-delete]');
  var delYes = acct.querySelector('[data-delete-confirm]');
  var delNo = acct.querySelector('[data-delete-cancel]');
  function confirming(on) { del.hidden = on; delYes.hidden = !on; delNo.hidden = !on; }
  del.addEventListener('click', function () { confirming(true); delYes.focus(); });
  delNo.addEventListener('click', function () { confirming(false); del.focus(); });
  delYes.addEventListener('click', function () {
    delYes.disabled = true;
    status(acct, 'Deleting…', '');
    token().then(function (t) {
      return fetch(FORMS, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ form: 'delete_account', access_token: t }),
      });
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; });
    }).then(function (r) {
      if (r && r.ok) {
        loggedOut('');
        status(views.login, r.message, 'is-success');
      } else {
        status(acct, (r && r.message) || 'Something went wrong. Please try again.', 'is-error');
      }
    }).catch(function () {
      status(acct, 'Your login has expired. Log in again, then delete.', 'is-error');
    }).then(function () { delYes.disabled = false; confirming(false); });
  });

  // ---- start
  var incoming = fromHash();
  if (incoming && incoming.error) {
    writeStore(null);
    showView('login');
    status(views.login, 'That login link has expired or was already used. Enter your email for a new one.', 'is-error');
    return;
  }
  if (incoming) writeStore(incoming);
  else session = readStore();
  if (session) loadAccount();
  else showView('login');
})();
