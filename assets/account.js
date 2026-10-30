// Member login and account page (/account/).
// - Log in with email + password (Supabase Auth). The login is kept in this browser's
//   storage so members stay logged in until they log out.
// - "Forgot password?" asks the site-forms function to email a set-password link. That
//   link comes back here as ?verify=<token>&type=recovery; we exchange it with Supabase
//   Auth and show the "Set a new password" form.
// - Logged in, members read and save their own sign-up through two database functions
//   (my_account, update_my_account), change their password, or delete the account.
// Older emailed login links (#access_token=… in the address) still work.
(function () {
  var root = document.querySelector('[data-account]');
  if (!root) return;
  var API = root.getAttribute('data-supabase');
  var KEY = root.getAttribute('data-key');
  var FORMS = root.getAttribute('data-endpoint');
  var PATH = root.getAttribute('data-path') || '';
  var STORE = 'ah-session';
  var started = Date.now();
  var session = null;

  var views = {};
  Array.prototype.forEach.call(root.querySelectorAll('[data-view]'), function (v) { views[v.getAttribute('data-view')] = v; });
  var title = document.querySelector('[data-account-title]');
  var lede = document.querySelector('[data-account-lede]');
  var acct = root.querySelector('[data-account-form]');
  var favInput = acct.querySelector('#m-fav');
  var favList = acct.querySelector('[data-fav-list]');
  var favorites = [];

  var COPY = {
    login: ['Log in', 'Log in with the email and password you signed up with.'],
    forgot: ['Reset your password', "We'll email you a link to set a new one."],
    setpw: ['Set a new password', 'Choose a new password for your account.'],
    loading: ['Your account', ''],
    account: ['Your account', 'Upcoming signings for your favorite teams and players, soonest first.'],
  };
  var head = document.querySelector('[data-account-head]');
  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    // The login view has its own big "Welcome back" heading, so the page title only shows on the others.
    if (head) head.hidden = name === 'login';
    title.textContent = COPY[name][0];
    lede.textContent = COPY[name][1];
    lede.hidden = !COPY[name][1];
  }
  function status(el, message, kind) {
    el.hidden = !message;
    el.className = 'f-status ' + (kind || '');
    el.textContent = message || '';
  }
  function statusOf(form) { return form.querySelector('.f-status'); }
  function strong(form, a, b) {
    var p1 = form.elements[a].value;
    var p2 = form.elements[b].value;
    if (p1.length < 8) { form.elements[a].focus(); return 'Use at least 8 characters.'; }
    if (p1 !== p2) { form.elements[b].focus(); return "The two passwords don't match."; }
    return '';
  }

  // ---- session (storage can be blocked in private windows; then the login lasts for this page)
  function now() { return Math.floor(Date.now() / 1000); }
  function readStore() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function writeStore(s) {
    session = s;
    try { if (s) localStorage.setItem(STORE, JSON.stringify(s)); else localStorage.removeItem(STORE); } catch (e) { /* blocked */ }
  }
  function keep(j) {
    writeStore({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || now() + (j.expires_in || 3600) });
  }
  function auth(path, body, method, token) {
    var headers = { apikey: KEY, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + '/auth/v1/' + path, { method: method || 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
      });
  }
  function expired() { var e = new Error('Your login has expired. Please log in again.'); e.expired = true; return e; }
  function token() {
    if (!session) return Promise.reject(expired());
    if (session.expires_at - 60 > now()) return Promise.resolve(session.access_token);
    return auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(function (r) {
      if (!r.ok) throw expired();
      keep(r.body);
      return session.access_token;
    });
  }
  function rpc(name, args) {
    return token().then(function (t) {
      return fetch(API + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw expired();
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.message) || 'Something went wrong.');
        return j;
      });
    });
  }
  function loggedOut(message, kind) {
    writeStore(null);
    showView('login');
    status(statusOf(views.login), message || '', kind || (message ? 'is-error' : ''));
  }

  // ---- switching between log in and forgot password
  Array.prototype.forEach.call(root.querySelectorAll('[data-show]'), function (b) {
    b.addEventListener('click', function () {
      var to = b.getAttribute('data-show');
      var from = to === 'forgot' ? views.login : views.forgot;
      if (from.elements.email.value) views[to].elements.email.value = from.elements.email.value;
      showView(to);
      views[to].elements.email.focus();
    });
  });

  // ---- log in
  views.login.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = views.login;
    var st = statusOf(f);
    var email = f.elements.email.value.trim();
    var password = f.elements.password.value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { f.elements.email.focus(); status(st, 'Please enter a valid email address.', 'is-error'); return; }
    if (!password) { f.elements.password.focus(); status(st, 'Please enter your password.', 'is-error'); return; }
    var b = f.querySelector('button[type="submit"]');
    b.disabled = true;
    status(st, 'Logging in…', '');
    auth('token?grant_type=password', { email: email, password: password }).then(function (r) {
      if (!r.ok) {
        status(st, r.status === 429 ? 'Too many tries. Wait a few minutes, then try again.'
          : 'Wrong email or password. Forgot it? Use "Forgot password?" to set a new one.', 'is-error');
        return;
      }
      keep(r.body);
      f.elements.password.value = '';
      status(st, '', '');
      loadAccount();
    }).catch(function () {
      status(st, "We couldn't reach the server. Check your connection and try again.", 'is-error');
    }).then(function () { b.disabled = false; });
  });

  // ---- forgot password: emailed link
  views.forgot.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = views.forgot;
    var st = statusOf(f);
    var email = f.elements.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { f.elements.email.focus(); status(st, 'Please enter a valid email address.', 'is-error'); return; }
    var b = f.querySelector('button[type="submit"]');
    b.disabled = true;
    status(st, 'Sending…', '');
    fetch(FORMS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ form: 'reset', email: email, path: PATH, elapsed_ms: Date.now() - started, website: f.elements.website.value }),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; });
    }).then(function (r) {
      status(st, (r && r.message) || 'Something went wrong. Please try again in a minute.', r && r.ok ? 'is-success' : 'is-error');
    }).catch(function () {
      status(st, "We couldn't reach the server. Check your connection and try again.", 'is-error');
    }).then(function () { b.disabled = false; });
  });

  // ---- set a new password (after the emailed link)
  views.setpw.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = views.setpw;
    var st = statusOf(f);
    var problem = strong(f, 'password', 'password2');
    if (problem) { status(st, problem, 'is-error'); return; }
    var b = f.querySelector('button[type="submit"]');
    b.disabled = true;
    changePassword(f.elements.password.value).then(function () {
      f.reset();
      loadAccount('Your new password is saved.');
    }).catch(function (err) {
      if (err.expired) loggedOut('That link has expired. Use "Forgot password?" to get a new one.');
      else status(st, err.message, 'is-error');
    }).then(function () { b.disabled = false; });
  });

  function changePassword(pw) {
    return token().then(function (t) { return auth('user', { password: pw }, 'PUT', t); }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw expired();
      if (!r.ok) {
        var m = r.body.msg || r.body.message || r.body.error_description || '';
        throw new Error(/same/i.test(m) ? 'That is already your password. Choose a different one.' : m || "Couldn't save the password.");
      }
    });
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

  // ---- tabs: Your Feed / Change Preferences
  var tabs = root.querySelectorAll('[role="tab"][data-tab]');
  var panes = root.querySelectorAll('[data-pane]');
  function selectTab(name) {
    Array.prototype.forEach.call(tabs, function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name)); });
    Array.prototype.forEach.call(panes, function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
    lede.textContent = name === 'feed'
      ? 'Upcoming signings for your favorite teams and players, soonest first.'
      : 'Change your favorites, pause alerts, or update your password.';
  }
  Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) {
    b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
  });
  Array.prototype.forEach.call(tabs, function (t, i) {
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      selectTab(next.getAttribute('data-tab'));
    });
  });

  // ---- Your Feed: show the upcoming signings whose signer (or a team they played for)
  // matches a favorite. "Broncos" matches "Denver Broncos". Same rule as the alert emails.
  var feedCards = Array.prototype.slice.call(root.querySelectorAll('[data-feed] .card'));
  function renderFeed(favs) {
    var wanted = (favs || []).map(function (f) { return String(f).toLowerCase().trim(); }).filter(function (f) { return f.length >= 3; });
    var shown = 0;
    feedCards.forEach(function (c) {
      var terms = (c.getAttribute('data-terms') || '').split('|');
      var hit = wanted.length > 0 && terms.some(function (t) {
        return t.length >= 3 && wanted.some(function (f) { return t.indexOf(f) !== -1 || (t.length >= 4 && f.indexOf(t) !== -1); });
      });
      c.hidden = !hit;
      if (hit) shown++;
    });
    root.querySelector('[data-feed-count]').textContent = shown
      ? shown + (shown === 1 ? ' upcoming signing' : ' upcoming signings') + ' for your favorites'
      : '';
    root.querySelector('[data-feed-empty]').hidden = shown !== 0;
    var list = root.querySelector('[data-feed-favs]');
    list.textContent = '';
    (favs || []).forEach(function (f) {
      var li = document.createElement('li');
      li.textContent = f;
      list.appendChild(li);
    });
  }

  function fill(data) {
    // Stored as one "First Last" string: the first word is the first name, the rest the last name.
    var parts = String(data.name || '').trim().split(/\s+/);
    acct.elements.first_name.value = parts[0] || '';
    acct.elements.last_name.value = parts.slice(1).join(' ');
    acct.querySelector('[data-email]').textContent = data.email || '';
    acct.elements.alerts.checked = !!data.alerts;
    favorites = Array.isArray(data.favorites) ? data.favorites.slice() : [];
    renderFavorites();
    renderFeed(favorites);
  }

  function loadAccount(message) {
    showView('loading');
    rpc('my_account').then(function (data) {
      if (!data) {
        loggedOut("We couldn't find an alert sign-up for this login. Sign up first, then log in.");
        return;
      }
      fill(data);
      showView('account');
      selectTab('feed');
      var first = String(data.name || '').trim().split(/\s+/)[0];
      if (first) title.textContent = 'Hi, ' + first;
      status(views.account.querySelector('[data-account-status]'), message || '', message ? 'is-success' : '');
    }).catch(function (e) {
      loggedOut(e.expired ? 'Your login has expired. Please log in again.' : "We couldn't load your account. Please try again.");
    });
  }

  // ---- save details
  acct.addEventListener('submit', function (e) {
    e.preventDefault();
    var st = acct.querySelector('[data-save-status]');
    if (favInput.value.trim()) addFavorite(favInput.value);
    var firstName = acct.elements.first_name.value.trim();
    var lastName = acct.elements.last_name.value.trim();
    if (!firstName) { acct.elements.first_name.focus(); status(st, 'Please enter your first name.', 'is-error'); return; }
    if (!lastName) { acct.elements.last_name.focus(); status(st, 'Please enter your last name.', 'is-error'); return; }
    var name = firstName + ' ' + lastName;
    var button = acct.querySelector('button[type="submit"]');
    button.disabled = true;
    status(st, 'Saving…', '');
    rpc('update_my_account', { p_name: name, p_favorites: favorites, p_alerts: acct.elements.alerts.checked })
      .then(function (data) {
        if (data) fill(data);
        status(st, 'Saved.', 'is-success');
      })
      .catch(function (err) {
        if (err.expired) loggedOut(err.message);
        else status(st, err.message || 'Something went wrong. Please try again.', 'is-error');
      })
      .then(function () { button.disabled = false; });
  });

  // ---- change password while logged in
  acct.querySelector('[data-change-pw-save]').addEventListener('click', function () {
    var st = acct.querySelector('[data-pw-status]');
    var problem = strong(acct, 'newpassword', 'newpassword2');
    if (problem) { status(st, problem, 'is-error'); return; }
    var b = this;
    b.disabled = true;
    changePassword(acct.elements.newpassword.value).then(function () {
      acct.elements.newpassword.value = '';
      acct.elements.newpassword2.value = '';
      status(st, 'Password changed.', 'is-success');
    }).catch(function (err) {
      if (err.expired) loggedOut(err.message);
      else status(st, err.message, 'is-error');
    }).then(function () { b.disabled = false; });
  });

  root.querySelector('[data-logout]').addEventListener('click', function () {
    var t = session && session.access_token;
    if (t) fetch(API + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } }).catch(function () {});
    loggedOut("You're logged out.", 'is-success');
  });

  // ---- delete: two steps (no browser pop-ups)
  var del = acct.querySelector('[data-delete]');
  var delYes = acct.querySelector('[data-delete-confirm]');
  var delNo = acct.querySelector('[data-delete-cancel]');
  function confirming(on) { del.hidden = on; delYes.hidden = !on; delNo.hidden = !on; }
  del.addEventListener('click', function () { confirming(true); delYes.focus(); });
  delNo.addEventListener('click', function () { confirming(false); del.focus(); });
  delYes.addEventListener('click', function () {
    var st = acct.querySelector('[data-save-status]');
    delYes.disabled = true;
    status(st, 'Deleting…', '');
    token().then(function (t) {
      return fetch(FORMS, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ form: 'delete_account', access_token: t }),
      });
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; });
    }).then(function (r) {
      if (r && r.ok) loggedOut(r.message, 'is-success');
      else status(st, (r && r.message) || 'Something went wrong. Please try again.', 'is-error');
    }).catch(function () {
      status(st, 'Your login has expired. Log in again, then delete.', 'is-error');
    }).then(function () { delYes.disabled = false; confirming(false); });
  });

  // ---- start
  function clearAddress() {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  }
  var params = new URLSearchParams(location.search);
  var hash = new URLSearchParams(location.hash.slice(1));
  var verify = params.get('verify');
  var welcome = params.get('welcome');

  if (verify) {
    // Emailed set-password link.
    clearAddress();
    showView('loading');
    auth('verify', { type: params.get('type') === 'recovery' ? 'recovery' : 'signup', token_hash: verify }).then(function (r) {
      if (!r.ok || !r.body.access_token) {
        loggedOut('That link has expired or was already used. Use "Forgot password?" to get a new one.');
        return;
      }
      keep(r.body);
      showView('setpw');
      views.setpw.elements.password.focus();
    }).catch(function () { loggedOut("We couldn't reach the server. Please try the link again."); });
    return;
  }
  if (hash.get('error') || hash.get('error_description')) {
    clearAddress();
    loggedOut('That link has expired or was already used. Log in with your email and password, or use "Forgot password?".');
    return;
  }
  if (hash.get('access_token')) {
    // Older emailed login links.
    clearAddress();
    writeStore({
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token') || '',
      expires_at: Number(hash.get('expires_at')) || now() + Number(hash.get('expires_in') || 3600),
    });
  } else {
    session = readStore();
  }
  if (welcome) clearAddress();
  if (session) loadAccount(welcome ? "Welcome! You're signed up and logged in." : '');
  else showView('login');
})();
