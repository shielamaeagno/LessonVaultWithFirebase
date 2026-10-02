/* Lesson Vault — session storage (works on InfinityFree) */
window.LVSession = window.LVSession || {};

(function () {
  const SESSION_KEY = 'lv_session';

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1].trim()) : '';
  }

  function cookiePath() {
    /*
     * FIX — Always return '/' so cookies set by session.js are readable
     *        by ALL pages and the PHP backend at any path.
     *        The old logic returned e.g. '/subfolder/' which caused the
     *        cookie to be invisible when PHP read it from a different path.
     */
    return '/';
  }

  function writeCookie(name, value, days) {
    const maxAge = days * 86400;
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; path=' + cookiePath() + '; max-age=' + maxAge + '; SameSite=Lax';
  }

  function clearCookie(name) {
    document.cookie = name + '=; path=' + cookiePath() + '; max-age=0; SameSite=Lax';
  }

  function parseJson(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  LVSession.read = function () {
    let pack = parseJson(localStorage.getItem(SESSION_KEY));
    if (!pack) pack = parseJson(sessionStorage.getItem(SESSION_KEY));

    if (pack && pack.user) {
      return { user: pack.user, token: pack.token || readCookie('lv_token') || null };
    }

    let user = parseJson(localStorage.getItem('lv_currentUser'));
    if (!user) user = parseJson(sessionStorage.getItem('lv_currentUser'));

    if (!user) {
      user = parseJson(readCookie('lv_user'));
    }

    let token = parseJson(localStorage.getItem('lv_authToken'));
    if (!token) token = parseJson(sessionStorage.getItem('lv_authToken'));
    if (!token) token = readCookie('lv_token') || null;

    if (user) return { user, token };

    return null;
  };

  LVSession.user = function () {
    const s = this.read();
    return s && s.user ? s.user : null;
  };

  LVSession.token = function () {
    const s = this.read();
    return s && s.token ? s.token : null;
  };

  LVSession.write = function (user, token) {
    if (!user) return;
    const pack = { user, token: token || null };
    const json = JSON.stringify(pack);
    const userJson = JSON.stringify(user);

    try {
      localStorage.setItem(SESSION_KEY, json);
      sessionStorage.setItem(SESSION_KEY, json);
      localStorage.setItem('lv_currentUser', userJson);
      sessionStorage.setItem('lv_currentUser', userJson);
      writeCookie('lv_user', userJson, 30);
      if (token) {
        const tokenJson = JSON.stringify(token);
        localStorage.setItem('lv_authToken', tokenJson);
        sessionStorage.setItem('lv_authToken', tokenJson);
        writeCookie('lv_token', token, 30);
      }
    } catch (e) {
      console.error('LVSession.write failed:', e);
    }
  };

  LVSession.clear = function () {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('lv_currentUser');
    sessionStorage.removeItem('lv_currentUser');
    localStorage.removeItem('lv_authToken');
    sessionStorage.removeItem('lv_authToken');
    clearCookie('lv_user');
    clearCookie('lv_token');
  };

  LVSession.isLoggedIn = function () {
    return !!this.user();
  };

  LVSession.paintNav = function () {
    if (typeof NavAuth !== 'undefined') {
      NavAuth.render();
      return !!this.user();
    }

    const authArea = document.getElementById('nav-auth');
    if (!authArea) return false;

    const user = this.user();
    if (user && user.username) {
      authArea.innerHTML =
        '<button type="button" class="nav-profile-btn" onclick="location.href=\'dashboard.html\'">' +
        'Hi, ' + escHtml(user.username) + '</button>';
    } else {
      authArea.innerHTML = '<a href="login.html" class="nav-login-btn">Log in</a>';
    }
    return !!user;
  };

  LVSession.scheduleNavPaint = function () {
    const paint = () => this.paintNav();
    paint();
    [50, 200, 500, 1500].forEach(function (ms) {
      setTimeout(paint, ms);
    });
  };
})();
