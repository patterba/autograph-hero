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
    var flyerData = null; // the uploaded flyer, shrunk to a JPEG data URL (listing form only)
    var flyerInput = form.querySelector('input[name="flyer"]');
    var flyerBox = form.querySelector('.f-flyer-preview');
    function clearFlyer() {
      flyerData = null;
      if (flyerInput) flyerInput.value = '';
      if (flyerBox) { flyerBox.hidden = true; flyerBox.querySelector('img').removeAttribute('src'); }
    }
    // Shrinks the picture in the browser (max 1600 px, JPEG) so uploads stay small.
    function readFlyer(file) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
        img.src = url;
      });
    }
    if (flyerInput) {
      flyerInput.addEventListener('change', function () {
        var file = flyerInput.files && flyerInput.files[0];
        if (!file) { clearFlyer(); return; }
        if (file.size > 25 * 1024 * 1024) { clearFlyer(); show('That picture is too big. Please use one under 25 MB.', 'is-error'); return; }
        readFlyer(file).then(function (data) {
          flyerData = data;
          if (flyerBox) { flyerBox.querySelector('img').src = data; flyerBox.hidden = false; }
          if (status) status.hidden = true;
        }).catch(function () {
          clearFlyer();
          show("We couldn't open that picture. Please try a JPG or PNG screenshot.", 'is-error');
        });
      });
      var clearBtn = form.querySelector('[data-flyer-clear]');
      if (clearBtn) clearBtn.addEventListener('click', clearFlyer);
    }
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

    // Coming from the home page fan pass: fill in the email it handed over (assets/app.js),
    // then jump to the first name so the fan just keeps typing.
    if (kind === 'signup' && form.elements.email) {
      var handed = '';
      try {
        handed = sessionStorage.getItem('ah-signup-email') || '';
        sessionStorage.removeItem('ah-signup-email');
      } catch (e) {}
      if (handed && !form.elements.email.value) {
        form.elements.email.value = handed.slice(0, 254);
        var firstEmpty = Array.prototype.filter.call(form.querySelectorAll('input[required]'), function (el) {
          return el.type !== 'checkbox' && !el.value;
        })[0];
        if (firstEmpty) firstEmpty.focus();
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

    // Every ticked box with this name, in page order.
    function values(name) {
      return Array.prototype.filter.call(form.querySelectorAll('input[name="' + name + '"]'), function (b) { return b.checked; })
        .map(function (b) { return b.value; });
    }

    function validate() {
      Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
      var email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (kind === 'listing' && flyerInput) {
        // The flyer form: we read the details from the picture; only the flyer and email are needed.
        if (!flyerData) return invalid(flyerInput, 'Please choose a picture of the flyer.');
        if (!email.test(value('submitter_email'))) return invalid(form.elements.submitter_email, 'Please enter a valid email address so we can follow up.');
        if (captcha && !captchaToken()) return invalid(null, 'Please complete the quick check above the button.');
      } else if (kind === 'listing') {
        if (!value('athlete_names')) return invalid(form.elements.athlete_names, 'Please enter who is signing.');
        if (!values('signing_type').length) return invalid(form.querySelector('input[name="signing_type"]'), 'Please tick how the signing works (In person, Private signing and/or Mail-in).');
        if (!value('event_date') && !value('order_deadline')) return invalid(form.elements.event_date, 'Please enter the signing date or the order deadline.');
        // In-person signings need a place so they show up under their state.
        if (values('signing_type').indexOf('public') >= 0 && !value('city')) return invalid(form.elements.city, 'Please enter the city for an in-person signing.');
        if (values('signing_type').indexOf('public') >= 0 && !value('state')) return invalid(form.elements.state, 'Please choose the state for an in-person signing.');
        if (!/^https?:\/\/\S+\.\S+/.test(value('source_url'))) return invalid(form.elements.source_url, 'Please add a link to the official announcement or order page, starting with https://');
        if (!email.test(value('submitter_email'))) return invalid(form.elements.submitter_email, 'Please enter a valid email address so we can follow up.');
        if (captcha && !captchaToken()) return invalid(null, 'Please complete the quick check above the button.');
      } else if (kind === 'contact') {
        if (!email.test(value('email'))) return invalid(form.elements.email, 'Please enter a valid email address so we can write back.');
        if (value('message').length < 10) return invalid(form.elements.message, 'Please write a short message (at least 10 characters).');
        if (captcha && !captchaToken()) return invalid(null, 'Please complete the quick check above the button.');
      } else {
        if (favInput && favInput.value.trim()) addFavorite(favInput.value);
        if (!value('first_name')) return invalid(form.elements.first_name, 'Please enter your first name.');
        if (!value('last_name')) return invalid(form.elements.last_name, 'Please enter your last name.');
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

    // Thank-you screen after a listing is sent: shows what they sent, hides the forms,
    // and "Submit another signing" brings the forms back. Built with textContent (no HTML).
    var TYPE_NAMES = { public: 'In person', private: 'Private signing', 'mail-in': 'Mail-in' };
    function fmtDate(v) {
      if (!v) return '';
      var d = new Date(v + 'T12:00:00');
      return isNaN(d) ? v : d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
    }
    function thanks(d, message) {
      var box = document.createElement('section');
      box.className = 'f-thanks';
      box.setAttribute('tabindex', '-1');
      var h = document.createElement('h2'); h.textContent = 'Thank you!'; box.appendChild(h);
      var p = document.createElement('p'); p.textContent = message || "We got it."; box.appendChild(p);
      var p2 = document.createElement('p'); p2.className = 'muted';
      p2.textContent = "We check every listing against its source before it goes live. We'll also email you a copy of what you sent" + (d.submitter_email ? ' at ' + d.submitter_email : '') + ' in about 15 minutes.';
      box.appendChild(p2);
      var h3 = document.createElement('h3'); h3.textContent = 'What you sent'; box.appendChild(h3);
      if (d.flyer) {
        var img = document.createElement('img'); img.src = d.flyer; img.alt = 'Your flyer'; img.className = 'f-thanks-flyer';
        box.appendChild(img);
      }
      var dl = document.createElement('dl'); dl.className = 'f-thanks-list';
      function add(label, value) {
        if (!value) return;
        var dt = document.createElement('dt'); dt.textContent = label;
        var dd = document.createElement('dd'); dd.textContent = value;
        dl.appendChild(dt); dl.appendChild(dd);
      }
      add('Who', (d.athlete_names || []).join(', '));
      add('Type', (d.signing_types || []).map(function (t) { return TYPE_NAMES[t] || t; }).join(' · '));
      add('Sport', d.sport);
      add('Date', fmtDate(d.event_date));
      add('Time', d.event_time_text);
      add('Order by', fmtDate(d.order_deadline));
      add('Where', [d.venue, d.city, d.state].filter(Boolean).join(', '));
      add('Prices', d.price_text);
      add('Link', d.source_url);
      add('Notes', d.notes);
      add('Your name', d.submitter_name);
      add('Your email', d.submitter_email);
      if (d.flyer) add('Details', "We'll read them from your flyer.");
      box.appendChild(dl);
      var again = document.createElement('button');
      again.type = 'button'; again.className = 'btn btn-accent'; again.textContent = 'Submit another signing';
      box.appendChild(again);
      var hide = document.querySelectorAll('form[data-form="listing"], .f-or, .f-or-title');
      Array.prototype.forEach.call(hide, function (el) { el.hidden = true; });
      var first = document.querySelector('form[data-form="listing"]');
      first.parentNode.insertBefore(box, first);
      if (status) status.hidden = true;
      again.addEventListener('click', function () {
        Array.prototype.forEach.call(hide, function (el) { el.hidden = false; });
        box.parentNode.removeChild(box);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      box.focus();
      box.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
        data.signing_types = values('signing_type');
        data.signing_type = data.signing_types[0] || null;
        if (flyerData) data.flyer = flyerData;
        data.athlete_names = value('athlete_names').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      } else if (kind === 'contact') {
        ['name', 'email', 'topic', 'message'].forEach(function (k) { data[k] = value(k) || null; });
        data.captcha_token = captchaToken() || null;
      } else {
        data.first_name = value('first_name');
        data.last_name = value('last_name');
        data.name = (data.first_name + ' ' + data.last_name).trim();
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
              signed_in_at: Math.floor(Date.now() / 1000), // logins last 72 hours (account.js)
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
      var sent = payload();
      fetch(form.getAttribute('data-endpoint'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(sent),
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
          if (r && r.ok && kind === 'listing') {
            thanks(sent, r.message);
            form.reset();
            clearFlyer();
            started = Date.now();
            return;
          }
          if (r && r.ok) {
            form.reset();
            clearFlyer();
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
