// Owner's admin page (/admin/): review submitted signings and see alert sign-ups.
// Logs in with email + password through Supabase Auth. The database functions
// admin_queue and admin_decide check for the admin role on the login, so this page
// can't do anything for anyone else. All text from the database is put on the page
// with textContent (never as HTML), because it comes from the public forms.
(function () {
  var root = document.querySelector('[data-admin]');
  if (!root) return;
  var API = root.getAttribute('data-supabase');
  var KEY = root.getAttribute('data-key');
  var STORE = 'ah-admin-session';
  var TYPE = { public: 'In person', private: 'Private signing', 'mail-in': 'Mail-in', unknown: 'Not sure' };
  var session = null;

  var views = {
    login: root.querySelector('[data-view="login"]'),
    loading: root.querySelector('[data-view="loading"]'),
    panel: root.querySelector('[data-view="panel"]'),
  };
  var title = document.querySelector('[data-admin-title]');
  var panes = {};
  Array.prototype.forEach.call(root.querySelectorAll('[data-pane]'), function (p) { panes[p.getAttribute('data-pane')] = p; });
  var panelStatus = root.querySelector('[data-panel-status]');

  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    title.textContent = name === 'panel' ? 'Review signings' : 'Admin log in';
  }
  function status(el, message, kind) {
    el.hidden = !message;
    el.className = 'f-status ' + (kind || '');
    el.textContent = message || '';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function safeHref(u) {
    try {
      var x = new URL(String(u));
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
    } catch (e) { return null; }
  }
  function day(d) {
    if (!d) return '';
    var x = new Date(String(d).length === 10 ? d + 'T12:00:00' : d);
    return isNaN(x) ? String(d) : x.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function names(a) { return Array.isArray(a) ? a.join(', ') : ''; }

  // ---- session
  function now() { return Math.floor(Date.now() / 1000); }
  function save(s) {
    session = s;
    try { if (s) localStorage.setItem(STORE, JSON.stringify(s)); else localStorage.removeItem(STORE); } catch (e) { /* blocked */ }
  }
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function keep(j) {
    save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || now() + (j.expires_in || 3600) });
  }
  function auth(path, body) {
    return fetch(API + '/auth/v1/' + path, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, body: j }; });
    });
  }
  function token() {
    if (!session) return Promise.reject(expired());
    if (session.expires_at - 60 > now()) return Promise.resolve(session.access_token);
    return auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(function (r) {
      if (!r.ok) throw expired();
      keep(r.body);
      return session.access_token;
    });
  }
  function expired() { var e = new Error('Your login has expired. Please log in again.'); e.expired = true; return e; }
  function rpc(name, args) {
    return token().then(function (t) {
      return fetch(API + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.status === 401 || r.status === 403 || (j && j.code === '42501')) {
          var e = new Error(j && /not an admin/.test(j.message || '') ? "This login doesn't have admin access." : 'Your login has expired. Please log in again.');
          e.expired = true;
          throw e;
        }
        if (!r.ok) throw new Error((j && j.message) || 'Something went wrong.');
        return j;
      });
    });
  }
  function loggedOut(message, kind) {
    save(null);
    showView('login');
    status(views.login.querySelector('.f-status'), message || '', kind || (message ? 'is-error' : ''));
  }

  // ---- login
  views.login.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = views.login;
    var st = f.querySelector('.f-status');
    var email = f.elements.email.value.trim();
    var password = f.elements.password.value;
    if (!email || !password) { status(st, 'Enter your email and password.', 'is-error'); return; }
    var b = f.querySelector('button[type="submit"]');
    b.disabled = true;
    status(st, 'Logging in…', '');
    auth('token?grant_type=password', { email: email, password: password }).then(function (r) {
      if (!r.ok) {
        status(st, r.status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : 'Wrong email or password.', 'is-error');
        return;
      }
      keep(r.body);
      f.elements.password.value = '';
      status(st, '', '');
      refresh();
    }).catch(function () {
      status(st, "We couldn't reach the server. Check your connection and try again.", 'is-error');
    }).then(function () { b.disabled = false; });
  });

  // ---- tabs
  var tabs = root.querySelectorAll('[data-tab]');
  Array.prototype.forEach.call(tabs, function (t) {
    t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); });
  });
  function selectTab(name) {
    Array.prototype.forEach.call(tabs, function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name)); });
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
  }

  // ---- data
  function refresh(message) {
    if (views.panel.hidden) showView('loading');
    return rpc('admin_queue').then(function (q) {
      renderPending(q.pending || []);
      renderReviewed(q.reviewed || []);
      renderFans(q.fans || [], q.tally || []);
      showView('panel');
      status(panelStatus, message || '', message ? 'is-success' : '');
    }).catch(function (e) {
      if (e.expired) loggedOut(e.message);
      else { showView('panel'); status(panelStatus, e.message, 'is-error'); }
    });
  }

  function row(dl, label, value, node) {
    if (!value && !node) return;
    dl.appendChild(el('dt', null, label));
    var dd = el('dd', null, node ? null : value);
    if (node) dd.appendChild(node);
    dl.appendChild(dd);
  }

  function renderPending(list) {
    var pane = panes.pending;
    pane.textContent = '';
    root.querySelector('[data-count="pending"]').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) { pane.appendChild(el('p', 'empty', 'Nothing waiting. New submissions show up here.')); return; }
    list.forEach(function (s) {
      var card = el('article', 'admin-card');
      var head = el('div', 'admin-card-head');
      head.appendChild(el('h2', null, names(s.athlete_names) || 'Unnamed signing'));
      head.appendChild(el('span', 'badge badge-outline', TYPE[s.signing_type] || s.signing_type || ''));
      card.appendChild(head);
      if (s.possible_duplicate) card.appendChild(el('p', 'notice', 'Possible duplicate: a signing with the same name and date is already listed.'));
      var dl = el('dl', 'admin-dl');
      row(dl, 'Sport', s.sport);
      row(dl, 'Date', day(s.event_date));
      row(dl, 'Time', s.event_time_text);
      row(dl, 'Order by', day(s.order_deadline));
      row(dl, 'Where', [s.venue, s.city, s.state].filter(Boolean).join(', '));
      row(dl, 'Prices', s.price_text);
      row(dl, 'Notes', s.notes);
      var href = safeHref(s.source_url);
      if (href) {
        var a = el('a', null, href.length > 70 ? href.slice(0, 67) + '…' : href);
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        row(dl, 'Source', null, a);
      } else row(dl, 'Source', s.source_url);
      row(dl, 'Sent by', [s.submitter_name, s.submitter_email].filter(Boolean).join(' · '));
      row(dl, 'Sent', day(s.created_at));
      card.appendChild(dl);

      var noteId = 'note-' + s.id;
      var lab = el('label', 'f-label', 'Note (optional, only you see it)');
      lab.htmlFor = noteId;
      var note = el('textarea');
      note.id = noteId; note.rows = 2; note.maxLength = 1000;
      var nf = el('div', 'f-field'); nf.appendChild(lab); nf.appendChild(note);
      card.appendChild(nf);

      var actions = el('div', 'f-actions');
      var approve = el('button', 'btn btn-accent', 'Approve');
      var reject = el('button', 'btn btn-ghost', 'Reject');
      var yes = el('button', 'btn btn-ink', 'Yes');
      var cancel = el('button', 'btn btn-ghost', 'Cancel');
      [approve, reject, yes, cancel].forEach(function (b) { b.type = 'button'; actions.appendChild(b); });
      yes.hidden = cancel.hidden = true;
      var choice = null;
      function ask(isApprove) {
        choice = isApprove;
        approve.hidden = reject.hidden = true;
        yes.hidden = cancel.hidden = false;
        yes.textContent = isApprove ? 'Yes, put it on the calendar' : 'Yes, reject it';
        yes.focus();
      }
      approve.addEventListener('click', function () { ask(true); });
      reject.addEventListener('click', function () { ask(false); });
      cancel.addEventListener('click', function () {
        approve.hidden = reject.hidden = false;
        yes.hidden = cancel.hidden = true;
      });
      yes.addEventListener('click', function () {
        yes.disabled = cancel.disabled = true;
        rpc('admin_decide', { p_id: s.id, p_approve: choice, p_note: note.value.trim() || null }).then(function () {
          refresh(choice ? 'Approved. It goes live with the next hourly site update.' : 'Rejected.');
        }).catch(function (e) {
          if (e.expired) loggedOut(e.message);
          else { status(panelStatus, e.message, 'is-error'); yes.disabled = cancel.disabled = false; }
        });
      });
      card.appendChild(actions);
      pane.appendChild(card);
    });
  }

  function renderReviewed(list) {
    var pane = panes.reviewed;
    pane.textContent = '';
    if (!list.length) { pane.appendChild(el('p', 'empty', 'Nothing reviewed yet.')); return; }
    var ul = el('ul', 'admin-list');
    list.forEach(function (s) {
      var li = el('li');
      var top = el('div', 'admin-list-top');
      top.appendChild(el('strong', null, names(s.athlete_names)));
      top.appendChild(el('span', 'badge ' + (s.status === 'approved' ? 'badge-public' : 'badge-outline'), s.status));
      li.appendChild(top);
      li.appendChild(el('span', 'muted small', [TYPE[s.signing_type] || '', day(s.event_date || s.order_deadline), s.reviewed_at ? 'reviewed ' + day(s.reviewed_at) : ''].filter(Boolean).join(' · ')));
      if (s.review_note) li.appendChild(el('span', 'small', 'Note: ' + s.review_note));
      ul.appendChild(li);
    });
    pane.appendChild(ul);
  }

  function renderFans(fans, tally) {
    var pane = panes.fans;
    pane.textContent = '';
    root.querySelector('[data-count="fans"]').textContent = fans.length ? '(' + fans.length + ')' : '';
    if (tally.length) {
      pane.appendChild(el('h2', 'admin-h2', 'Most followed'));
      var chips = el('ul', 'admin-chips');
      tally.forEach(function (t) {
        var li = el('li');
        li.appendChild(el('span', null, t.favorite));
        li.appendChild(el('span', 'admin-chip-n', t.fans));
        chips.appendChild(li);
      });
      pane.appendChild(chips);
    }
    pane.appendChild(el('h2', 'admin-h2', 'People signed up for alerts'));
    if (!fans.length) { pane.appendChild(el('p', 'empty', 'No sign-ups yet.')); return; }
    var wrap = el('div', 'admin-table-wrap');
    var table = el('table', 'admin-table');
    var thead = el('thead'); var hr = el('tr');
    ['Name', 'Email', 'Favorites', 'Signed up'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr); table.appendChild(thead);
    var tb = el('tbody');
    fans.forEach(function (f) {
      var tr = el('tr');
      tr.appendChild(el('td', null, f.name));
      tr.appendChild(el('td', null, f.email));
      tr.appendChild(el('td', null, (f.favorites || []).join(', ')));
      tr.appendChild(el('td', null, day(f.created_at)));
      tb.appendChild(tr);
    });
    table.appendChild(tb); wrap.appendChild(table); pane.appendChild(wrap);
  }

  // ---- password change
  panes.settings.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = panes.settings;
    var st = f.querySelector('.f-status');
    var p1 = f.elements.password.value;
    var p2 = f.elements.password2.value;
    if (p1.length < 10) { status(st, 'Use at least 10 characters.', 'is-error'); return; }
    if (p1 !== p2) { status(st, "The two passwords don't match.", 'is-error'); return; }
    var b = f.querySelector('button[type="submit"]');
    b.disabled = true;
    token().then(function (t) {
      return fetch(API + '/auth/v1/user', {
        method: 'PUT',
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: p1 }),
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.msg || j.message || j.error_description || "Couldn't change the password.");
        f.reset();
        status(st, 'Password changed. Use the new one next time you log in.', 'is-success');
      });
    }).catch(function (err) {
      if (err.expired) loggedOut(err.message);
      else status(st, err.message, 'is-error');
    }).then(function () { b.disabled = false; });
  });

  root.querySelector('[data-refresh]').addEventListener('click', function () { refresh(); });
  root.querySelector('[data-logout]').addEventListener('click', function () {
    var t = session && session.access_token;
    if (t) fetch(API + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } }).catch(function () {});
    loggedOut("You're logged out.", 'is-success');
  });

  session = load();
  if (session) refresh();
  else showView('login');
})();
