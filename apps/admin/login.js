/* Admin login: username + password + TOTP code. On success the server sets an HttpOnly cookie and
   "/" serves the dashboard. Nothing is stored in the browser. */
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('loginForm');
  $('lo').addEventListener('input', () => { $('lo').value = $('lo').value.replace(/\D/g, '').slice(0, 6); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('lu').value.trim(), password = $('lp').value, otp = $('lo').value.trim();
    const err = (m) => { $('lerr').textContent = m; $('lerr').classList.toggle('hide', !m); };
    if (!username || !password) return err('Enter your username and password.');
    if (!/^\d{6}$/.test(otp)) return err('Enter the 6-digit code from your authenticator app.');
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
      err(r.status === 429 ? 'Too many attempts. Please wait 15 minutes.' : (body.error?.message || 'Login failed.'));
      $('lo').value = '';
      $('lo').focus();
    } catch {
      err('No connection to the server. Check the internet and try again.');
    } finally {
      $('lbtn').disabled = false;
    }
  });
  $('lu').focus();
})();
