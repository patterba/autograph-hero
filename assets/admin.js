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
  var currentTab = 'pending';
  function selectTab(name) {
    currentTab = name;
    Array.prototype.forEach.call(tabs, function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name)); });
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
    if (name === 'analytics' && !analyticsLoaded) loadAnalytics();
    if (name === 'captcha') loadCaptcha();
    if (name === 'flyers') loadFlyerKey();
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
      if (currentTab === 'analytics') loadAnalytics(); else analyticsLoaded = false;
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

  function typeText(s) {
    var t = (s.signing_types && s.signing_types.length) ? s.signing_types : [s.signing_type];
    return t.map(function (x) { return TYPE[x] || x || ''; }).filter(Boolean).join(' · ');
  }

  // A one-hour link to a flyer in the private "flyers" bucket (admins only).
  function flyerUrl(path) {
    return token().then(function (t) {
      return fetch(API + '/storage/v1/object/sign/flyers/' + path, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { var u = j && (j.signedURL || j.signedUrl); return u ? API + '/storage/v1' + u : null; })
      .catch(function () { return null; });
  }

  // "Edit details": fix a pending submission (names, types, dates, place…) before approving.
  var EDIT_FIELDS = [
    ['athlete_names', 'Who is signing (commas between names)', 'text'],
    ['sport', 'Sport', 'text'], ['event_date', 'Signing date', 'date'], ['event_time_text', 'Time', 'text'],
    ['order_deadline', 'Order deadline', 'date'], ['venue', 'Venue', 'text'], ['city', 'City', 'text'],
    ['state', 'State', 'text'], ['price_text', 'Prices', 'text'], ['source_url', 'Source link', 'url'],
  ];
  function editor(s) {
    var wrapBox = el('div', 'admin-edit');
    var toggle = el('button', 'btn btn-ghost btn-sm', 'Edit details');
    toggle.type = 'button';
    var form = el('div', 'admin-edit-form'); form.hidden = true;
    var inputs = {};
    EDIT_FIELDS.forEach(function (f) {
      var id = 'ed-' + s.id + '-' + f[0];
      var box = el('div', 'f-field');
      var lab = el('label', 'f-label', f[1]); lab.htmlFor = id;
      var inp = el('input'); inp.id = id; inp.type = f[2];
      var v = s[f[0]];
      inp.value = Array.isArray(v) ? v.join(', ') : (v || '');
      inputs[f[0]] = inp;
      box.appendChild(lab); box.appendChild(inp); form.appendChild(box);
    });
    var typesBox = el('div', 'f-field');
    typesBox.appendChild(el('span', 'f-label', 'How it works'));
    var have = (s.signing_types && s.signing_types.length) ? s.signing_types : [s.signing_type];
    var checks = ['public', 'private', 'mail-in'].map(function (t) {
      var l = el('label', 'admin-check'); var c = el('input'); c.type = 'checkbox'; c.value = t; c.checked = have.indexOf(t) >= 0;
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + TYPE[t] + ' ')); typesBox.appendChild(l); return c;
    });
    form.appendChild(typesBox);
    var save = el('button', 'btn btn-accent btn-sm', 'Save details'); save.type = 'button';
    form.appendChild(save);
    toggle.addEventListener('click', function () { form.hidden = !form.hidden; });
    save.addEventListener('click', function () {
      var p = {};
      Object.keys(inputs).forEach(function (k) { p[k] = inputs[k].value.trim(); });
      p.athlete_names = p.athlete_names.split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      p.signing_types = checks.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      save.disabled = true;
      rpc('admin_update_submission', { p_id: s.id, p: p }).then(function () { refresh('Details saved.'); })
        .catch(function (e) { if (e.expired) loggedOut(e.message); else { status(panelStatus, e.message, 'is-error'); save.disabled = false; } });
    });
    wrapBox.appendChild(toggle); wrapBox.appendChild(form);
    return wrapBox;
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
      head.appendChild(el('span', 'badge badge-outline', typeText(s)));
      if (s.from_flyer) head.appendChild(el('span', 'badge badge-rumor', 'Flyer'));
      card.appendChild(head);
      if (s.from_flyer) {
        var read = { ok: 'Claude read the flyer and filled in the blanks below. Check them against the picture, and fix anything with "Edit details".',
          failed: "Claude couldn't read this flyer. Type the details in with \"Edit details\".",
          off: 'Flyer reading is off (no Anthropic key on the Flyer reading tab). Type the details in with "Edit details".' }[s.flyer_read]
          || 'Claude is still reading this flyer. Refresh in a minute.';
        card.appendChild(el('p', 'notice', read));
        if (s.flyer_path) {
          var fig = el('a', 'admin-flyer');
          fig.target = '_blank'; fig.rel = 'noopener noreferrer';
          var im = el('img'); im.alt = 'Uploaded flyer'; fig.appendChild(im);
          card.appendChild(fig);
          flyerUrl(s.flyer_path).then(function (u) { if (u) { im.src = u; fig.href = u; } else fig.textContent = "The flyer picture couldn't be loaded."; });
        }
      }
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
      card.appendChild(editor(s));

      var noteId = 'note-' + s.id;
      var lab = el('label', 'f-label', 'Note (optional, only you see it)');
      lab.htmlFor = noteId;
      var note = el('textarea');
      note.id = noteId; note.rows = 2; note.maxLength = 1000;
      var nf = el('div', 'f-field'); nf.appendChild(lab); nf.appendChild(note);
      card.appendChild(nf);

      var rumorBox = el('label', 'admin-rumor');
      var rumor = el('input'); rumor.type = 'checkbox';
      rumorBox.appendChild(rumor);
      rumorBox.appendChild(document.createTextNode(' Post it as a Rumor (shows a "Rumor" badge and "not yet confirmed" note on the site)'));
      card.appendChild(rumorBox);

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
        yes.textContent = isApprove ? (rumor.checked ? 'Yes, post it as a Rumor' : 'Yes, put it on the calendar') : 'Yes, reject it';
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
        rpc('admin_decide', { p_id: s.id, p_approve: choice, p_note: note.value.trim() || null, p_rumor: choice && rumor.checked }).then(function () {
          refresh(choice ? (rumor.checked ? 'Approved as a Rumor. ' : 'Approved. ') + 'It goes live with the next hourly site update.' : 'Rejected.');
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
      li.appendChild(el('span', 'muted small', [typeText(s), day(s.event_date || s.order_deadline), s.reviewed_at ? 'reviewed ' + day(s.reviewed_at) : ''].filter(Boolean).join(' · ')));
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

  // ---- analytics: our own numbers (admin_stats) plus visitors from Cloudflare (admin-analytics function)
  var ANALYTICS = root.getAttribute('data-analytics');
  var analyticsLoaded = false;
  // The range every visitor number on the tab uses: { days: 7 | 30 }, one Pacific day { date: 'YYYY-MM-DD' },
  // or a start and end day { from, to } (Pacific, inclusive, up to 31 days in the last 90).
  var range = { days: 30 };
  var ZONE = 'America/Los_Angeles';
  function laToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function addDays(d, n) { var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function daysBack(d) { return Math.round((Date.parse(laToday() + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / 86400000); }
  function rangeText() {
    if (range.from) return shortDay(range.from) + ' – ' + shortDay(range.to);
    if (!range.date) return 'the last ' + range.days + ' days';
    if (range.date === laToday()) return 'today';
    return shortDay(range.date);
  }
  // 1:05:00-style durations: "45s", "3m 20s", "1h 5m".
  function dur(sec) {
    sec = Math.round(Number(sec) || 0);
    if (sec < 60) return sec + 's';
    if (sec < 3600) { var m = Math.floor(sec / 60), r = sec % 60; return r ? m + 'm ' + r + 's' : m + 'm'; }
    var h = Math.floor(sec / 3600), mm = Math.round((sec % 3600) / 60);
    return mm ? h + 'h ' + mm + 'm' : h + 'h';
  }
  function hourLabel(h) { return h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM'; }
  var TYPE_PLURAL = { public: 'In person', private: 'Private', 'mail-in': 'Mail-in', unknown: 'Not sure' };
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function stat(grid, value, label) {
    var d = el('div', 'stat');
    d.appendChild(el('span', 'stat-n', value));
    d.appendChild(el('span', 'stat-l', label));
    grid.appendChild(d);
  }
  // Round step for the left axis: 1, 2 or 5 times a power of ten, whole numbers only, about 5 gridlines.
  function niceStep(max) {
    var rough = max / 5;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return Math.max(1, Math.round(step));
  }
  // Axis labels: plain numbers, or k / M for the whole axis once its top reaches 10,000.
  function axisNum(n, top) {
    if (!n) return '0';
    if (top >= 1e7) return +(n / 1e6).toFixed(1) + 'M';
    if (top >= 1e4) return +(n / 1e3).toFixed(1) + 'k';
    return num(n);
  }
  // Simple bar chart: one bar per day/week, height by value, a numbered left axis with gridlines,
  // the exact number on hover and for screen readers.
  // opts.time: values are seconds (axis in round minutes/seconds, labels like "3m 20s").
  var TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  function bars(list, labelOf, valueOf, title, opts) {
    var time = opts && opts.time;
    var fmt = time ? dur : num;
    var high = list.reduce(function (m, x) { return Math.max(m, valueOf(x)); }, 0);
    var step = time ? (TIME_STEPS.filter(function (t) { return Math.max(high, 1) / t <= 6; })[0] || 7200) : niceStep(Math.max(high, 1));
    var max = Math.ceil(Math.max(high, 1) / step) * step;
    var wrap = el('figure', 'bars');
    wrap.setAttribute('aria-label', title);
    var plot = el('div', 'bars-plot');
    var yaxis = el('div', 'bars-y');
    yaxis.setAttribute('aria-hidden', 'true');
    var grid = el('div', 'bars-grid');
    grid.setAttribute('aria-hidden', 'true');
    var widest = 1;
    for (var t = 0; t <= max; t += step) {
      var pos = (t / max) * 100 + '%';
      var txt = time ? dur(t) : axisNum(t, max);
      var lab = el('span', 'bars-tick', txt);
      lab.style.bottom = pos;
      yaxis.appendChild(lab);
      var line = el('span', 'bars-line' + (t === 0 ? ' is-base' : ''));
      line.style.bottom = pos;
      grid.appendChild(line);
      widest = Math.max(widest, txt.length);
    }
    yaxis.style.width = (widest + 0.5) + 'ch';
    plot.appendChild(yaxis);
    var area = el('div', 'bars-area');
    area.appendChild(grid);
    var row = el('div', 'bars-row');
    list.forEach(function (x) {
      var v = valueOf(x);
      var b = el('div', 'bar');
      // opts.top: the part of the bar drawn in blue on top (returning visitors).
      var top = opts && opts.top ? Math.min(v, opts.top(x) || 0) : 0;
      var tip = labelOf(x) + ': ' + fmt(v) + (opts && opts.top ? ' (' + fmt(v - top) + ' new, ' + fmt(top) + ' returning)' : '');
      b.title = tip;
      var fill = el('span', 'bar-fill');
      fill.style.height = Math.max(v ? 4 : 0, Math.round((v / max) * 100)) + '%';
      if (top) { var seg = el('span', 'bar-top'); seg.style.height = Math.round((top / v) * 100) + '%'; fill.appendChild(seg); }
      b.appendChild(fill);
      b.appendChild(el('span', 'sr-only', tip));
      row.appendChild(b);
    });
    area.appendChild(row);
    plot.appendChild(area);
    wrap.appendChild(plot);
    var axis = el('figcaption', 'bars-axis');
    axis.style.paddingLeft = 'calc(' + (widest + 0.5) + 'ch + 8px)';
    if (list.length) {
      axis.appendChild(el('span', null, labelOf(list[0])));
      axis.appendChild(el('span', null, 'Highest: ' + fmt(high)));
      axis.appendChild(el('span', null, labelOf(list[list.length - 1])));
    }
    wrap.appendChild(axis);
    return wrap;
  }
  function topTable(title, list, cols) {
    var box = el('div', 'stat-box');
    box.appendChild(el('h3', null, title));
    if (!list || !list.length) { box.appendChild(el('p', 'muted small', 'Nothing yet.')); return box; }
    var t = el('table', 'admin-table');
    var tb = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', null, cols[0](r)));
      tr.appendChild(el('td', 'num', cols[1](r)));
      tb.appendChild(tr);
    });
    t.appendChild(tb); box.appendChild(t);
    return box;
  }
  function shortDay(d) {
    var x = new Date(String(d) + 'T12:00:00');
    return isNaN(x) ? String(d) : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  var visitorBox, sessionBox, rangeBox;
  function loadAnalytics() {
    analyticsLoaded = true;
    var pane = panes.analytics;
    pane.textContent = '';
    rangeBox = el('div', 'stat-rangebar');
    visitorBox = el('section', 'stat-section');
    sessionBox = el('section', 'stat-section');
    var site = el('section', 'stat-section');
    pane.appendChild(rangeBox);
    pane.appendChild(visitorBox);
    pane.appendChild(sessionBox);
    pane.appendChild(site);
    site.appendChild(el('p', 'muted', 'Loading…'));
    rpc('admin_stats').then(function (st) { renderSiteStats(site, st); }).catch(function (e) {
      if (e.expired) loggedOut(e.message); else { site.textContent = ''; site.appendChild(el('p', 'f-status is-error', e.message)); }
    });
    loadRange();
  }

  // Today / Last 7 days / Last 30 days / any one day in the last 90 (Pacific days).
  function renderRangeBar() {
    rangeBox.textContent = '';
    var pick = el('div', 'stat-range');
    pick.setAttribute('role', 'group');
    pick.setAttribute('aria-label', 'Date range');
    var today = laToday();
    [['Today', { date: today }], ['Last 7 days', { days: 7 }], ['Last 30 days', { days: 30 }]].forEach(function (o) {
      var b = el('button', 'btn btn-ghost btn-sm', o[0]);
      b.type = 'button';
      var on = o[1].date ? range.date === today : !range.date && range.days === o[1].days;
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', function () { range = o[1]; loadRange(); });
      pick.appendChild(b);
    });
    // Start and end day (same day twice = that one day, shown by hour).
    var cur = range.from ? [range.from, range.to] : range.date && range.date !== today ? [range.date, range.date] : ['', ''];
    var inputs = ['From', 'To'].map(function (name, i) {
      var lab = el('label', 'stat-day' + (cur[i] ? ' is-on' : ''));
      lab.appendChild(el('span', null, name));
      var input = el('input');
      input.type = 'date';
      input.max = today;
      input.min = addDays(today, -90);
      input.value = cur[i];
      input.setAttribute('aria-label', name === 'From' ? 'Start day' : 'End day');
      lab.appendChild(input);
      pick.appendChild(lab);
      return input;
    });
    var note = el('span', 'stat-note');
    note.hidden = true;
    pick.appendChild(note);
    function apply() {
      var f = inputs[0].value, t = inputs[1].value;
      if (f && !t) { t = f; inputs[1].value = f; }
      if (!f && t) { f = t; inputs[0].value = t; }
      if (!f || f > today || t > today || daysBack(f) > 90) return;
      if (f > t) { var x = f; f = t; t = x; }
      // Cloudflare answers about a month per question.
      var first = addDays(t, -30);
      if (f < first) { f = first; note.textContent = 'Ranges go up to 31 days, so this starts ' + shortDay(f) + '.'; note.hidden = false; }
      range = f === t ? { date: f } : { from: f, to: t };
      loadRange();
    }
    inputs.forEach(function (input) { input.addEventListener('change', apply); });
    rangeBox.appendChild(pick);
  }

  function loadRange() {
    renderRangeBar();
    visitorBox.textContent = '';
    visitorBox.appendChild(el('p', 'muted', 'Loading visitor numbers…'));
    sessionBox.textContent = '';
    sessionBox.appendChild(el('p', 'muted', 'Loading sessions…'));
    loadVisitors(visitorBox);
    loadSessions(sessionBox);
  }

  function loadVisitors(box) {
    var ask = range.from ? { from: range.from, to: range.to } : range.date ? { date: range.date } : { days: range.days };
    token().then(function (t) {
      return fetch(ANALYTICS, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(ask) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 || r.status === 403) { var e = new Error('Your login has expired. Please log in again.'); e.expired = true; throw e; }
        if (!r.ok) throw new Error(j.error || 'Could not load visitor numbers.');
        renderVisitors(box, j);
      });
    }).catch(function (e) {
      if (e.expired) { loggedOut(e.message); return; }
      box.textContent = '';
      box.appendChild(el('h2', 'admin-h2', 'Visitors'));
      box.appendChild(el('p', 'f-status is-error', e.message));
    });
  }

  function renderVisitors(box, d) {
    box.textContent = '';
    var oneDay = !!range.date;
    var head = el('div', 'stat-head');
    head.appendChild(el('h2', 'admin-h2', 'Visitors · ' + (oneDay ? (range.date === laToday() ? 'Today' : shortDay(range.date)) : range.from ? rangeText() : 'Last ' + range.days + ' days')));
    box.appendChild(head);

    if (!d.connected) { box.appendChild(connectForm(false)); return; }
    if (d.error) {
      box.appendChild(el('p', 'f-status is-error', d.error));
      box.appendChild(connectForm(true));
      return;
    }
    if (d.empty) {
      box.appendChild(el('p', 'notice', 'Connected to Cloudflare, but no visits to autographhero.com were recorded ' + (oneDay ? 'on ' : 'in ') + rangeText() + '. Numbers show up a few minutes after people visit.'));
      box.appendChild(connectForm(true));
      return;
    }
    var grid = el('div', 'stats');
    stat(grid, num(d.totals.views), 'Page views');
    stat(grid, num(d.totals.visits), 'Visits');
    // Unique visitors: our own cookie-free count (site-visit function), filled in when it arrives.
    var ub = el('div', 'stat');
    var un = el('span', 'stat-n', '…');
    ub.appendChild(un);
    ub.appendChild(el('span', 'stat-l', 'Unique visitors'));
    var unote = el('span', 'stat-note');
    unote.hidden = true;
    ub.appendChild(unote);
    grid.appendChild(ub);
    var uchart = el('div', 'stat-chart');
    uchart.hidden = true;
    var uhour = el('div', 'stat-chart');
    uhour.hidden = true;
    var uargs = range.from ? { p_from: range.from, p_to: range.to } : oneDay ? { p_from: range.date, p_to: range.date } : { p_days: range.days };
    var ulatest = el('div', 'stat-latest');
    ulatest.hidden = true;
    var ustates = el('div', 'stat-chart');
    ustates.hidden = true;
    function legend() {
      var lg = el('p', 'bars-legend');
      lg.appendChild(el('span', 'key-new', 'New'));
      lg.appendChild(el('span', 'key-ret', 'Returning'));
      return lg;
    }
    function topFn(x) { return x.returning || 0; }
    rpc('admin_unique_visitors', uargs).then(function (r) {
      var list = r.byDay || [];
      // Callout: the most recent day in the range.
      var last = list[list.length - 1];
      if (last) {
        var lu = last.uniques || 0, lr = last.returning || 0;
        ulatest.appendChild(el('h3', 'stat-sub', (last.date === laToday() ? 'Today so far' : shortDay(last.date))));
        var lg = el('div', 'stats');
        stat(lg, num(lu), 'Unique visitors');
        stat(lg, num(lu - lr), 'New' + (lu ? ' · ' + Math.round(((lu - lr) / lu) * 100) + '%' : ''));
        stat(lg, num(lr), 'Returning' + (lu ? ' · ' + Math.round((lr / lu) * 100) + '%' : ''));
        if (oneDay && r.byHour && r.byHour.length) {
          var pk = r.byHour.reduce(function (m, x) { return (x.uniques || 0) > (m.uniques || 0) ? x : m; }, r.byHour[0]);
          if (pk.uniques) stat(lg, hourLabel(pk.hour), 'Busiest hour · ' + num(pk.uniques));
        }
        ulatest.appendChild(lg);
        ulatest.hidden = false;
      }
      var states = r.topStates || [];
      if (states.length) {
        ustates.appendChild(topTable('Top 5 states · unique visitors', states, [function (x) { return x.state; }, function (x) { return num(x.visitors); }]));
        ustates.appendChild(el('p', 'muted small', 'US visitors only, from the IP address (looked up on our server, only the state is kept). ' + num(r.located || 0) + ' visitors in this range had a US location.'));
        ustates.hidden = false;
      }
      if (oneDay && r.byHour && r.byHour.length) {
        uhour.appendChild(el('h3', 'stat-sub', 'Unique visitors by hour (Pacific)'));
        uhour.appendChild(legend());
        uhour.appendChild(bars(trimHours(r.byHour, range.date), function (x) { return hourLabel(x.hour); }, function (x) { return x.uniques || 0; }, 'Unique visitors by hour', { top: topFn }));
        uhour.appendChild(el('p', 'muted small', 'People on the site during each hour. Someone who stays across two hours counts in both, so the hours add up to more than the day\'s total.'));
        uhour.hidden = false;
      }
      var total = list.reduce(function (n, x) { return n + (x.uniques || 0); }, 0);
      un.textContent = num(total);
      var first = list[0];
      if (r.since && first && r.since > first.date) { unote.textContent = 'Counting since ' + shortDay(r.since) + '.'; unote.hidden = false; }
      // Chart from the first day we counted (or the whole range once there's enough history).
      var days = list.filter(function (x) { return !r.since || x.date >= r.since; });
      if (days.length > 1) {
        uchart.appendChild(el('h3', 'stat-sub', 'Unique visitors by day'));
        uchart.appendChild(legend());
        uchart.appendChild(bars(days, function (x) { return shortDay(x.date); }, function (x) { return x.uniques || 0; }, 'Unique visitors by day', { top: topFn }));
        uchart.appendChild(el('p', 'muted small', 'Returning = this browser had visited on an earlier day. Counted from Nov 11, 2026, so earlier days show everyone as new.'));
        uchart.hidden = false;
      }
    }).catch(function () { un.textContent = '—'; });
    if (oneDay) {
      stat(grid, d.totals.visits ? (d.totals.views / d.totals.visits).toFixed(1) : '0', 'Pages per visit');
    } else {
      var perDay = d.byDay && d.byDay.length ? Math.round(d.totals.views / d.byDay.length) : 0;
      stat(grid, num(perDay), 'Page views a day');
    }
    box.appendChild(grid);
    box.appendChild(ulatest);
    box.appendChild(uchart);
    box.appendChild(ustates);
    if (oneDay && d.byHour && d.byHour.length) {
      var hours = trimHours(d.byHour, range.date);
      box.appendChild(el('h3', 'stat-sub', 'Page views by hour (Pacific)'));
      box.appendChild(bars(hours, function (x) { return hourLabel(x.hour); }, function (x) { return x.views; }, 'Page views by hour'));
      box.appendChild(uhour);
    } else if (!oneDay && d.byDay && d.byDay.length) {
      box.appendChild(el('h3', 'stat-sub', 'Page views by day'));
      box.appendChild(bars(d.byDay, function (x) { return shortDay(x.date); }, function (x) { return x.views; }, 'Page views by day'));
    }
    var when = oneDay ? (range.date === laToday() ? 'today' : shortDay(range.date)) : rangeText();
    box.appendChild(el('h3', 'stat-sub', 'Pages, sources, countries and devices · ' + when.charAt(0).toUpperCase() + when.slice(1)));
    box.appendChild(el('p', 'muted small', 'These lists count only ' + (oneDay ? (range.date === laToday() ? 'today so far' : 'that day') : rangeText()) + ', the range picked above.'));
    var cols = el('div', 'stat-cols');
    cols.appendChild(topTable('Top pages', d.pages, [function (r) { return r.label || '/'; }, function (r) { return num(r.views); }]));
    cols.appendChild(topTable('Where visitors came from', d.referrers, [function (r) { return r.label; }, function (r) { return num(r.visits); }]));
    cols.appendChild(topTable('Countries', d.countries, [function (r) { return r.label || 'Unknown'; }, function (r) { return num(r.views); }]));
    cols.appendChild(topTable('Devices', d.devices, [function (r) { return r.label ? r.label.charAt(0).toUpperCase() + r.label.slice(1) : 'Unknown'; }, function (r) { return num(r.views); }]));
    box.appendChild(cols);
    box.appendChild(el('p', 'muted small', 'From Cloudflare. A visit is someone arriving from another site or typing the address; page views count every page they open. Unique visitors are counted by the site itself, once per person per day (someone who comes back on another day counts again), without cookies; search engines and other robots are left out. Cloudflare samples busy sites, so numbers are close estimates.'));

    box.appendChild(connectForm(true));
  }

  // Today: stop the hourly charts at the current hour.
  function trimHours(list, date) {
    if (date !== laToday()) return list;
    var h = Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    return list.filter(function (x) { return x.hour <= h; });
  }

  // ---- sessions and time on site: our own cookie-free count (site-visit function → admin_sessions)
  function loadSessions(box) {
    var args = range.from ? { p_from: range.from, p_to: range.to } : range.date ? { p_date: range.date } : { p_days: range.days };
    rpc('admin_sessions', args).then(function (r) { renderSessions(box, r); }).catch(function (e) {
      if (e.expired) { loggedOut(e.message); return; }
      box.textContent = '';
      box.appendChild(el('h2', 'admin-h2', 'Sessions and time'));
      box.appendChild(el('p', 'f-status is-error', e.message));
    });
  }

  function renderSessions(box, r) {
    box.textContent = '';
    var oneDay = !!range.date;
    box.appendChild(el('h2', 'admin-h2', 'Sessions and time'));
    var t = r.totals || {};
    if (!r.since || r.to < r.since) {
      box.appendChild(el('p', 'notice', r.since
        ? 'Sessions are counted from ' + shortDay(r.since) + ' on, so there are none for ' + rangeText() + '.'
        : 'Sessions and time start counting with the next visits to the site (after the next site update goes live).'));
      return;
    }
    var visitors = t.visitors || 0, sessions = t.sessions || 0;
    var grid = el('div', 'stats');
    stat(grid, num(sessions), 'Sessions');
    stat(grid, visitors ? (sessions / visitors).toFixed(1) : '0', 'Sessions per visitor');
    stat(grid, dur(visitors ? t.seconds / visitors : 0), 'Time per visitor');
    stat(grid, dur(sessions ? t.seconds / sessions : 0), 'Average session');
    stat(grid, sessions ? (t.pages / sessions).toFixed(1) : '0', 'Pages per session');
    stat(grid, sessions ? Math.round((t.single / sessions) * 100) + '%' : '0%', 'Left after one page');
    box.appendChild(grid);
    if (r.from < r.since) box.appendChild(el('p', 'muted small', 'Counting since ' + shortDay(r.since) + '.'));

    if (oneDay && r.byHour) {
      var hours = trimHours(r.byHour, range.date);
      box.appendChild(el('h3', 'stat-sub', 'Sessions by hour (Pacific)'));
      box.appendChild(bars(hours, function (x) { return hourLabel(x.hour); }, function (x) { return x.sessions; }, 'Sessions by hour'));
      box.appendChild(el('h3', 'stat-sub', 'Average session by hour started'));
      box.appendChild(bars(hours, function (x) { return hourLabel(x.hour); }, function (x) { return x.sessions ? x.seconds / x.sessions : 0; }, 'Average session by hour started', { time: true }));
    } else {
      var days = (r.byDay || []).filter(function (x) { return x.date >= r.since; });
      if (days.length > 1) {
        box.appendChild(el('h3', 'stat-sub', 'Sessions by day'));
        box.appendChild(bars(days, function (x) { return shortDay(x.date); }, function (x) { return x.sessions; }, 'Sessions by day'));
        box.appendChild(el('h3', 'stat-sub', 'Time per visitor by day'));
        box.appendChild(bars(days, function (x) { return shortDay(x.date); }, function (x) { return x.visitors ? x.seconds / x.visitors : 0; }, 'Time per visitor by day', { time: true }));
      }
      if (days.length) box.appendChild(dayTable(days.slice().reverse()));
    }
    box.appendChild(el('p', 'muted small', 'Counted by the site itself, without cookies. A session is one visitor\'s page views with no gap longer than 30 minutes; time counts only while a page is on screen (not in a background tab). A visitor is counted once per day, so "per visitor" numbers are per person per day. Robots are left out.'));
  }

  // Day-by-day table; each date opens that day by hour.
  function dayTable(days) {
    var wrap = el('div', 'stat-box');
    wrap.appendChild(el('h3', null, 'Day by day'));
    var tbl = el('table', 'admin-table');
    var th = el('thead'), hr = el('tr');
    ['Day', 'Visitors', 'Sessions', 'Per visitor', 'Time per visitor', 'Average session'].forEach(function (h, i) { hr.appendChild(el('th', i ? 'num' : null, h)); });
    th.appendChild(hr); tbl.appendChild(th);
    var tb = el('tbody');
    days.forEach(function (x) {
      var tr = el('tr');
      var td = el('td');
      var b = el('button', 'link-btn', shortDay(x.date));
      b.type = 'button';
      b.title = 'See ' + shortDay(x.date) + ' by hour';
      b.addEventListener('click', function () { range = { date: x.date }; loadRange(); rangeBox.scrollIntoView({ block: 'start' }); });
      td.appendChild(b); tr.appendChild(td);
      tr.appendChild(el('td', 'num', num(x.visitors)));
      tr.appendChild(el('td', 'num', num(x.sessions)));
      tr.appendChild(el('td', 'num', x.visitors ? (x.sessions / x.visitors).toFixed(1) : '–'));
      tr.appendChild(el('td', 'num', x.visitors ? dur(x.seconds / x.visitors) : '–'));
      tr.appendChild(el('td', 'num', x.sessions ? dur(x.seconds / x.sessions) : '–'));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    var scroll = el('div', 'admin-table-wrap');
    scroll.appendChild(tbl);
    wrap.appendChild(scroll);
    return wrap;
  }

  // Connect (or change) the Cloudflare API token. It's saved in the database's secret store,
  // never shown again, and only the admin-analytics function reads it.
  function connectForm(connected) {
    var wrap = connected ? el('details', 'stat-connect') : el('div', 'stat-connect');
    if (connected) wrap.appendChild(el('summary', null, 'Change Cloudflare connection'));
    else {
      wrap.appendChild(el('p', null, 'See how many people visit the site, which pages they look at and where they come from. This uses the Cloudflare Web Analytics already on the site. Connect it once:'));
      var ol = el('ol', 'stat-steps');
      [
        'Log in at dash.cloudflare.com, click your profile icon (top right), then "My Profile" → "API Tokens".',
        'Click "Create Token", scroll down and click "Get started" next to "Create Custom Token".',
        'Name it "Autograph Hero analytics". Under Permissions pick: Account → Account Analytics → Read. Under Account Resources pick your account.',
        'Click "Continue to summary", then "Create Token". Copy the token and paste it below.',
      ].forEach(function (t) { ol.appendChild(el('li', null, t)); });
      wrap.appendChild(ol);
    }
    var f = el('form', 'f-form');
    f.noValidate = true;
    var fs = el('fieldset');
    function input(id, label, name, hint) {
      var d = el('div', 'f-field');
      var l = el('label', null, label); l.htmlFor = id;
      var i = el('input'); i.id = id; i.name = name; i.type = name === 'token' ? 'password' : 'text'; i.autocomplete = 'off'; i.spellcheck = false;
      d.appendChild(l); d.appendChild(i);
      if (hint) d.appendChild(el('p', 'f-hint', hint));
      fs.appendChild(d);
    }
    input('cf-token', 'Cloudflare API token', 'token');
    input('cf-account', 'Account ID (optional)', 'account', 'Only needed if we can’t find it. It’s on the right side of your Cloudflare account home page.');
    var actions = el('div', 'f-actions');
    var save = el('button', 'btn btn-accent', connected ? 'Save new token' : 'Connect Cloudflare'); save.type = 'submit';
    actions.appendChild(save);
    if (connected) {
      var off = el('button', 'btn btn-ghost', 'Disconnect'); off.type = 'button';
      off.addEventListener('click', function () {
        off.disabled = true;
        rpc('admin_clear_cloudflare').then(function () { loadAnalytics(); }).catch(function (e) { status(st, e.message, 'is-error'); off.disabled = false; });
      });
      actions.appendChild(off);
    }
    fs.appendChild(actions);
    var st = el('p', 'f-status'); st.hidden = true; st.setAttribute('role', 'status');
    fs.appendChild(st);
    f.appendChild(fs);
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var tok = f.elements.token.value.trim();
      if (tok.length < 20) { status(st, 'Paste the whole token from Cloudflare.', 'is-error'); return; }
      save.disabled = true;
      status(st, 'Saving…', '');
      rpc('admin_set_cloudflare', { p_token: tok, p_account: f.elements.account.value.trim() || null }).then(function () {
        f.reset();
        loadAnalytics();
      }).catch(function (err) {
        if (err.expired) loggedOut(err.message); else status(st, err.message, 'is-error');
        save.disabled = false;
      });
    });
    wrap.appendChild(f);
    return wrap;
  }

  function renderSiteStats(box, st) {
    box.textContent = '';
    var m = st.members || {}, l = st.listings || {}, sub = st.submissions || {};
    box.appendChild(el('h2', 'admin-h2', 'Members'));
    var g1 = el('div', 'stats');
    stat(g1, num(m.active), 'Getting alerts');
    stat(g1, num(m.new7), 'New this week');
    stat(g1, num(m.new30), 'New in 30 days');
    stat(g1, num(m.off), 'Stopped alerts');
    box.appendChild(g1);
    if (st.weekly && st.weekly.length) {
      box.appendChild(el('h3', 'stat-sub', 'Sign-ups by week'));
      box.appendChild(bars(st.weekly, function (x) { return 'Week of ' + shortDay(x.week); }, function (x) { return x.n; }, 'Sign-ups by week'));
    }
    if (m.last_digest) box.appendChild(el('p', 'muted small', 'Last weekly alert email: ' + day(m.last_digest) + '.'));

    box.appendChild(el('h2', 'admin-h2', 'Signings'));
    var g2 = el('div', 'stats');
    stat(g2, num(l.upcoming), 'Upcoming on the site');
    stat(g2, num(l.new7), 'Added this week');
    stat(g2, num(sub.pending), 'Submissions waiting');
    stat(g2, num(sub.approved), 'Submissions approved');
    box.appendChild(g2);
    var cols = el('div', 'stat-cols');
    cols.appendChild(topTable('Upcoming by sport', l.by_sport, [function (r) { return r.label; }, function (r) { return num(r.n); }]));
    cols.appendChild(topTable('Upcoming by type', l.by_type, [function (r) { return TYPE_PLURAL[r.label] || r.label; }, function (r) { return num(r.n); }]));
    box.appendChild(cols);
  }

  // ---- captcha: the Turnstile secret is saved to the database's secret store (admin_set_turnstile)
  var captchaForm = panes.captcha;
  var captchaState = captchaForm.querySelector('[data-captcha-state]');
  function showCaptcha(on) {
    captchaState.className = 'notice ' + (on ? 'notice-ok' : '');
    captchaState.textContent = on
      ? 'On: forms check that visitors are people. Paste a new key below only if you change it in Cloudflare.'
      : 'Off: the check box shows on the forms, but nothing is checked yet.';
  }
  function loadCaptcha() {
    rpc('admin_turnstile_on').then(showCaptcha).catch(function (e) {
      if (e.expired) loggedOut(e.message); else captchaState.textContent = e.message;
    });
  }
  function saveCaptcha(secret) {
    var st = captchaForm.querySelector('.f-status');
    var buttons = captchaForm.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    status(st, 'Saving…', '');
    rpc('admin_set_turnstile', { p_secret: secret }).then(function (r) {
      captchaForm.reset();
      showCaptcha(r && r.on);
      status(st, r && r.on ? 'Saved. The check is on (it can take a minute to kick in).' : 'Turned off.', 'is-success');
    }).catch(function (e) {
      if (e.expired) loggedOut(e.message); else status(st, e.message, 'is-error');
    }).then(function () { Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); });
  }
  captchaForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = captchaForm.elements.secret.value.trim();
    if (!/^0x[A-Za-z0-9_-]{18,}$/.test(v)) { status(captchaForm.querySelector('.f-status'), 'Paste the whole Secret Key from Cloudflare. It starts with 0x.', 'is-error'); return; }
    saveCaptcha(v);
  });
  captchaForm.querySelector('[data-captcha-off]').addEventListener('click', function () { saveCaptcha(''); });

  // ---- flyer reading: the Anthropic key is saved to the database's secret store (admin_set_anthropic)
  var flyerForm = panes.flyers;
  var flyerState = flyerForm.querySelector('[data-flyer-state]');
  function showFlyerKey(on) {
    flyerState.className = 'notice ' + (on ? 'notice-ok' : '');
    flyerState.textContent = on
      ? 'On: Claude reads uploaded flyers. Paste a new key below only if you change it.'
      : 'Off: flyers still arrive, but you type the details in yourself.';
  }
  function loadFlyerKey() {
    rpc('admin_anthropic_on').then(showFlyerKey).catch(function (e) {
      if (e.expired) loggedOut(e.message); else flyerState.textContent = e.message;
    });
  }
  function saveFlyerKey(v) {
    var st = flyerForm.querySelector('.f-status');
    var buttons = flyerForm.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    status(st, 'Saving…', '');
    rpc('admin_set_anthropic', { p_key: v }).then(function (r) {
      flyerForm.reset();
      showFlyerKey(r && r.on);
      status(st, r && r.on ? 'Saved. New flyers will be read automatically.' : 'Turned off.', 'is-success');
    }).catch(function (e) {
      if (e.expired) loggedOut(e.message); else status(st, e.message, 'is-error');
    }).then(function () { Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); });
  }
  flyerForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = flyerForm.elements.secret.value.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v)) { status(flyerForm.querySelector('.f-status'), 'Paste the whole API key. It starts with sk-ant-.', 'is-error'); return; }
    saveFlyerKey(v);
  });
  flyerForm.querySelector('[data-flyer-off]').addEventListener('click', function () { saveFlyerKey(''); });

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
