// Sends the "Submit a signing", "Sign Up" and "Contact" forms to the site-forms Supabase function.
// The JSON goes as text/plain so the browser doesn't need a CORS preflight.
(function () {
  var forms = document.querySelectorAll('form[data-form]');
  Array.prototype.forEach.call(forms, setup);

  function setup(form) {
    var kind = form.getAttribute('data-form');
    var started = Date.now();
    var status = form.querySelector('.f-status');
    var button = form.querySelector('button[type="submit"]');
    var favorites = [];
    var favInput = form.querySelector('#s-fav');
    var captcha = form.querySelector('.cf-turnstile');
    var favList = form.querySelector('[data-fav-list]');

    // /contact/?topic=advertise (the "Advertise With Us" link) picks that topic.
    if (kind === 'contact' && form.elements.topic) {
      var want = new URLSearchParams(location.search).get('topic');
      if (want) {
        Array.prototype.some.call(form.elements.topic.options, function (o) {
          if (o.value.toLowerCase().indexOf(want.toLowerCase()) === 0) { form.elements.topic.value = o.value; return true; }
          return false;
        });
      }
    }

    if (favInput) {
      var params = new URLSearchParams(location.search);
      params.getAll('fav').forEach(addFavorite);
      form.querySelector('[data-fav-add]').addEventListener('click', function () {
        addFavorite(favInput.value);
        favInput.focus();
      });
      favInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addFavorite(favInput.value);
        }
      });
    }

    function addFavorite(value) {
      var v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!v) return;
      var exists = favorites.some(function (f) { return f.toLowerCase() === v.toLowerCase(); });
      if (!exists && favorites.length < 25) favorites.push(v);
      if (favInput) favInput.value = '';
      renderFavorites();
    }

    function renderFavorites() {
      if (!favList) return;
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
          if (favInput) favInput.focus();
        });
        li.appendChild(span);
        li.appendChild(remove);
        favList.appendChild(li);
      });
    }

    function show(message, kindOfMessage) {
      status.hidden = false;
      status.className = 'f-status ' + (kindOfMessage || '');
      status.textContent = message;
    }

    function invalid(el, message) {
      if (el) {
        el.setAttribute('aria-invalid', 'true');
        el.focus();
      }
      show(message, 'is-error');
      return false;
    }

    function value(name) {
      var el = form.elements[name];
      if (!el) return '';
      if (el.length !== undefined && el.tagName !== 'SELECT') {
        for (var i = 0; i < el.length; i++) if (el[i].checked) return el[i].value;
        return '';
      }
      if (el.type === 'checkbox') return el.checked;
      return String(el.value || '').trim();
    }

    function validate() {
      Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
      var email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (kind === 'listing') {
        if (!value('athlete_names')) return invalid(form.elements.athlete_names, 'Please enter who is signing.');
        if (!value('signing_type')) return invalid(form.querySelector('input[name="signing_type"]'), 'Please choose how the signing works.');
        if (!value('event_date') && !value('order_deadline')) return invalid(form.elements.event_date, 'Please enter the signing date or the order deadline.');
        if (!/^https?:\/\/\S+\.\S+/.test(value('source_url'))) return invalid(form.elements.source_url, 'Please add a link to the official announcement or order page, starting with https://');
        if (!email.test(value('submitter_email'))) return invalid(form.elements.submitter_email, 'Please enter a valid email address so we can follow up.');
        if (captcha && !captchaToken()) return invalid(null, 'Please complete the quick check above the button.');
      } else if (kind === 'contact') {
        if (!email.test(value('email'))) return invalid(form.elements.email, 'Please enter a valid email address so we can write back.');
        if (value('message').length < 10) return invalid(form.elements.message, 'Please write a short message (at least 10 characters).');
        if (captcha && !captchaToken()) return invalid(null, 'Please complete the quick check above the button.');
      } else {
        if (favInput && favInput.value.trim()) addFavorite(favInput.value);
        if (!value('name')) return invalid(form.elements.name, 'Please enter your name.');
        if (!email.test(value('email'))) return invalid(form.elements.email, 'Please enter a valid email address.');
        var pw = form.elements.password ? form.elements.password.value : '';
        if (form.elements.password && pw.length < 8) return invalid(form.elements.password, 'Please choose a password of at least 8 characters.');
        if (form.elements.password2 && form.elements.password2.value !== pw) return invalid(form.elements.password2, "The two passwords don't match.");
        if (!favorites.length) return invalid(favInput, 'Please add at least one favorite team, player or person.');
        if (!value('consent')) return invalid(form.elements.consent, 'Please tick the box to agree to receive alert emails.');
        if (captcha && !captchaToken()) return invalid(null, 'Please complete the quick check above the button.');
      }
      return true;
    }

    // Turnstile puts its one-time token in a hidden input inside the form.
    function captchaToken() {
      var t = form.querySelector('input[name="cf-turnstile-response"]');
      return t ? t.value : '';
    }
    function resetCaptcha() {
      if (captcha && window.turnstile) {
        try { window.turnstile.reset(captcha); } catch (e) { /* widget not ready */ }
      }
    }

    function payload() {
      var data = { form: kind, elapsed_ms: Date.now() - started, website: value('website') };
      if (kind === 'listing') {
        ['signing_type', 'sport', 'event_date', 'event_time_text', 'order_deadline', 'venue', 'city', 'state', 'source_url', 'price_text', 'notes', 'submitter_name', 'submitter_email']
          .forEach(function (k) { data[k] = value(k) || null; });
        data.captcha_token = captchaToken() || null;
        data.athlete_names = value('athlete_names').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      } else if (kind === 'contact') {
        ['name', 'email', 'topic', 'message'].forEach(function (k) { data[k] = value(k) || null; });
        data.captcha_token = captchaToken() || null;
      } else {
        data.name = value('name');
        data.email = value('email');
        data.consent = value('consent') === true;
        data.favorites = favorites.slice();
        if (form.elements.password) data.password = form.elements.password.value;
        data.captcha_token = captchaToken() || null;
      }
      return data;
    }

    // Signs in with Supabase Auth and keeps the login where the account page looks for it.
    function logIn(f, mail, password) {
      return fetch(f.getAttribute('data-supabase') + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: f.getAttribute('data-key'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: mail, password: password }),
      }).then(function (res) {
        if (!res.ok) return false;
        return res.json().then(function (j) {
          try {
            localStorage.setItem('ah-session', JSON.stringify({
              access_token: j.access_token,
              refresh_token: j.refresh_token,
              expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
            }));
          } catch (e) { return false; }
          return true;
        });
      }).catch(function () { return false; });
    }

    form.addEventListener('input', function (e) {
      if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validate()) return;
      button.disabled = true;
      show('Sending…', '');
      fetch(form.getAttribute('data-endpoint'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload()),
      })
        .then(function (res) {
          return res.json().catch(function () { return { ok: false }; });
        })
        .then(function (r) {
          if (r && r.ok && kind === 'signup' && r.login && form.getAttribute('data-supabase')) {
            // Log straight in with the password they just chose, then open their account page.
            show((r.message || "You're signed up!") + ' Logging you in…', 'is-success');
            return logIn(form, value('email'), form.elements.password.value).then(function (ok) {
              if (ok) { location.href = form.getAttribute('data-account') + '?welcome=1'; return; }
              form.reset(); favorites = []; renderFavorites(); started = Date.now();
              show((r.message || "You're signed up!") + ' Log in with your email and password on the Log In page.', 'is-success');
            });
          }
          if (r && r.ok) {
            form.reset();
            favorites = [];
            renderFavorites();
            started = Date.now();
            show(r.message || 'Thanks! We got it.', 'is-success');
          } else {
            show((r && r.message) || 'Something went wrong. Please try again in a minute.', 'is-error');
          }
        })
        .catch(function () {
          show("We couldn't reach the server. Check your connection and try again.", 'is-error');
        })
        .then(function () {
          resetCaptcha();
          button.disabled = false;
          status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
    });
  }
})();
