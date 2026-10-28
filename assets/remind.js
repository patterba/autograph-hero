// "Email me a reminder" on signing pages. Logged-in members (login kept in localStorage
// 'ah-session' by account.js) get it in one tap; anyone else enters an email. Posts to the
// Supabase function signing-reminders as text/plain (no CORS preflight).
(function () {
  var box = document.querySelector('[data-remind]');
  if (!box) return;
  var started = Date.now();
  var open = box.querySelector('[data-remind-open]');
  var form = box.querySelector('[data-remind-form]');
  var status = box.querySelector('.f-status');
  var submit = form.querySelector('button[type="submit"]');
  var signing = box.getAttribute('data-signing');
  var SET = 'ah-reminders';
  var widget = null;

  function show(message, kind) {
    status.hidden = false;
    status.className = 'f-status ' + (kind || '');
    status.textContent = message;
  }
  function remembered() {
    try { return JSON.parse(localStorage.getItem(SET) || '[]'); } catch (e) { return []; }
  }
  function remember() {
    try {
      var list = remembered().filter(function (id) { return id !== signing; });
      list.push(signing);
      localStorage.setItem(SET, JSON.stringify(list.slice(-200)));
    } catch (e) { /* storage blocked */ }
  }
  function markSet() {
    open.hidden = false;
    open.disabled = true;
    open.classList.add('is-set');
    open.lastChild.textContent = 'Reminder set';
    form.hidden = true;
  }
  if (remembered().indexOf(signing) !== -1) markSet();

  // A member's login, refreshed if it has expired. Resolves to an access token or ''.
  function memberToken() {
    var s;
    try { s = JSON.parse(localStorage.getItem('ah-session') || 'null'); } catch (e) { s = null; }
    if (!s || !s.access_token) return Promise.resolve('');
    if (s.expires_at && s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    if (!s.refresh_token) return Promise.resolve('');
    return fetch(box.getAttribute('data-supabase') + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: box.getAttribute('data-key'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.access_token) return '';
      try {
        localStorage.setItem('ah-session', JSON.stringify({
          access_token: j.access_token,
          refresh_token: j.refresh_token,
          expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
        }));
      } catch (e) { /* storage blocked */ }
      return j.access_token;
    }).catch(function () { return ''; });
  }

  // Cloudflare Turnstile, only when the site has a key, loaded the first time the form opens.
  function captcha() {
    var key = box.getAttribute('data-sitekey');
    var slot = form.querySelector('.remind-captcha');
    if (!key || widget !== null || !slot) return;
    widget = false;
    window.ahRemindCaptcha = function () { widget = window.turnstile.render(slot, { sitekey: key, theme: 'light', size: 'flexible' }); };
    var sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ahRemindCaptcha&render=explicit';
    sc.async = true;
    document.head.appendChild(sc);
  }
  function captchaToken() {
    var t = form.querySelector('input[name="cf-turnstile-response"]');
    return t ? t.value : '';
  }

  function send(data) {
    data.form = 'remind';
    data.signing_id = Number(signing);
    data.path = box.getAttribute('data-path') || '';
    data.elapsed_ms = Date.now() - started;
    data.website = form.elements.website ? form.elements.website.value : '';
    return fetch(box.getAttribute('data-endpoint'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(data),
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (r) {
        if (r && r.ok) { remember(); markSet(); show(r.message || 'Reminder set!', 'is-success'); return true; }
        show((r && r.message) || 'Something went wrong. Please try again in a minute.', 'is-error');
        return false;
      })
      .catch(function () { show("We couldn't reach the server. Check your connection and try again.", 'is-error'); return false; });
  }

  open.addEventListener('click', function () {
    open.disabled = true;
    memberToken().then(function (token) {
      if (token) {
        show('Setting your reminder…', '');
        return send({ access_token: token }).then(function (ok) { if (!ok) open.disabled = false; });
      }
      open.disabled = false;
      open.hidden = true;
      form.hidden = false;
      captcha();
      form.elements.email.focus();
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = String(form.elements.email.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      form.elements.email.setAttribute('aria-invalid', 'true');
      form.elements.email.focus();
      show('Please enter a valid email address.', 'is-error');
      return;
    }
    form.elements.email.removeAttribute('aria-invalid');
    if (box.getAttribute('data-sitekey') && !captchaToken()) { show('Please complete the quick check first.', 'is-error'); return; }
    submit.disabled = true;
    show('Setting your reminder…', '');
    send({ email: email, captcha_token: captchaToken() || null }).then(function () {
      submit.disabled = false;
      if (widget && window.turnstile) { try { window.turnstile.reset(widget); } catch (err) { /* not ready */ } }
    });
  });
})();
