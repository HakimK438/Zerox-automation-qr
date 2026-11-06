/* Admin login: username + password + TOTP code. On success the server sets an HttpOnly cookie and
   "/" serves the dashboard. Nothing is stored in the browser. */
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('loginForm');
  const t = QPI18n.t;
  QPI18n.mount($('langBtn'));
  $('lo').addEventListener('input', () => { $('lo').value = $('lo').value.replace(/\D/g, '').slice(0, 6); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('lu').value.trim(), password = $('lp').value, otp = $('lo').value.trim();
    const err = (m) => { $('lerr').textContent = m; $('lerr').classList.toggle('hide', !m); };
    if (!username || !password) return err(t('Enter your username and password.'));
    if (!/^\d{6}$/.test(otp)) return err(t('Enter the 6-digit code from your authenticator app.'));
    err('');
    $('lbtn').disabled = true;
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, otp })
      });
      if (r.ok) { location.replace('/'); return; }
      const body = await r.json().catch(() => ({}));
      err(r.status === 429 ? t('Too many attempts. Please wait 15 minutes.') : QPI18n.server(body.error?.message || 'Login failed.'));
      $('lo').value = '';
      $('lo').focus();
    } catch {
      err(t('No connection to the server. Check the internet and try again.'));
    } finally {
      $('lbtn').disabled = false;
    }
  });
  $('lu').focus();

  /* Test mode on the developer's own computer: the server sends the test login (204 everywhere else). */
  async function fillTestLogin() {
    try {
      const r = await fetch('/api/admin/dev-login', { cache: 'no-store' });
      if (r.status !== 200) return false;
      const login = await r.json();
      $('lu').value = login.username; $('lp').value = login.password; $('lo').value = login.otp;
      $('devNote').classList.remove('hide');
      return true;
    } catch { return false; }
  }
  fillTestLogin().then((on) => { if (on) setInterval(fillTestLogin, 10000); }); // codes change every 30 seconds
})();
