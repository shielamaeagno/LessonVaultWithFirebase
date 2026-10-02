/* =========================================================
 LESSON VAULT — Shared Layout (navbar + footer + auth modal)
 Injected by each page before DOMContentLoaded
 ========================================================= */

const SHARED_NAVBAR = `
<nav class="navbar">
 <div class="nav-inner">
    <a href="index.html" class="nav-logo">
      <span>Lesson<span class="gold">Vault</span></span>
    </a>
    <div class="nav-main-links" id="nav-main-links">
      <a href="index.html">Home</a>
      <a href="explore.html">Explore</a>
      <a href="people.html">People</a>
      <a href="categories.html">Categories</a>
      <a href="vault.html">Vault</a>
      <a href="about.html">About</a>
      <a href="contact.html">Contact</a>
    </div>
    <div class="nav-actions" id="nav-actions">
      <a href="share.html" class="nav-share">Share</a>
      <span id="nav-notifications" class="nav-notifications-wrap"></span>
      <span id="nav-auth" class="nav-auth-wrap"></span>
      <button type="button" class="nav-hamburger" id="nav-hamburger" aria-label="Open menu" aria-expanded="false"><span></span></button>
    </div>
 </div>
</nav>`;

const SHARED_AUTH_MODAL = `
<div class="modal-overlay" id="auth-modal">
 <div class="modal">
 <div class="modal-header">
 <h2>Lesson Vault</h2>
 <button class="modal-close" onclick="closeModal('auth-modal')" aria-label="Close"></button>
 </div>
 <div class="modal-tabs">
 <div class="modal-tab active" data-tab="tab-login">Login</div>
 <div class="modal-tab" data-tab="tab-register">Register</div>
 </div>
 <div class="modal-panel active" id="tab-login">
 <form id="login-form">
 <div class="form-group">
 <label class="form-label">Email</label>
 <input name="email" type="email" class="form-control" placeholder="you@email.com" required>
 </div>
 <div class="form-group">
 <label class="form-label">Password</label>
 <div class="password-field">
 <input name="password" type="password" class="form-control" placeholder="••••••••" required autocomplete="current-password">
 <button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false" onclick="togglePasswordVisibility(this)">Show</button>
 </div>
 </div>
 <div class="form-group" style="font-size:0.82rem;color:var(--muted)">Demo: test@lessonvault.com / password123<br>Admin: admin@lessonvault.com / admin123
 </div>
 <button type="submit" class="btn btn-primary btn-full">Login</button>
 </form>
 </div>
 <div class="modal-panel" id="tab-register">
 <form id="register-form">
 <div class="form-group">
 <label class="form-label">Username<span class="req">*</span></label>
 <input name="username" type="text" class="form-control" placeholder="YourName" required>
 </div>
 <div class="form-row">
 <div class="form-group">
 <label class="form-label">Email<span class="req">*</span></label>
 <input name="email" type="email" class="form-control" placeholder="you@email.com" required>
 </div>
 <div class="form-group">
 <label class="form-label">Password<span class="req">*</span></label>
 <div class="password-field">
 <input name="password" type="password" class="form-control" placeholder="Min 6 chars" required autocomplete="new-password">
 <button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false" onclick="togglePasswordVisibility(this)">Show</button>
 </div>
 </div>
 </div>
 <div class="form-group">
 <label class="form-label">Confirm Password<span class="req">*</span></label>
 <div class="password-field">
 <input name="confirm" type="password" class="form-control" placeholder="Repeat password" required autocomplete="new-password">
 <button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false" onclick="togglePasswordVisibility(this)">Show</button>
 </div>
 </div>
 <button type="submit" class="btn btn-gold btn-full">Create Account</button>
 </form>
 </div>
 </div>
</div>`;

const SHARED_FOOTER = `
<footer>
 <div class="footer-inner">
 <div class="footer-top">
 <div class="footer-brand">
 <div class="nav-logo" style="margin-bottom:8px">
 <span style="color:var(--white);font-size:1.1rem;font-weight:800">Lesson<span style="color:var(--gold)">Vault</span></span>
 </div>
 <p>A community where real experiences become valuable lessons. Share, learn, and grow together.</p>
 </div>
 <div class="footer-col">
 <h4>Navigate</h4>
 <a href="index.html">Home</a>
 <a href="explore.html">Explore Lessons</a>
 <a href="people.html">Connect with People</a>
 <a href="vault.html">The Vault</a>
 <a href="categories.html">Categories</a>
 </div>
 <div class="footer-col">
 <h4>Participate</h4>
 <a href="share.html">Share a Lesson</a>
 <a href="dashboard.html">My Dashboard</a>
 <a href="explore.html?sort=helpful">Most Helpful</a>
 <a href="explore.html?sort=new">Latest Lessons</a>
 </div>
 <div class="footer-col">
 <h4>Company</h4>
 <a href="about.html">About Us</a>
 <a href="contact.html">Contact</a>
 <a href="about.html#mission">Mission & Vision</a>
 </div>
 </div>
 <div class="footer-bottom">
      <p>© 2026 LessonVault. All rights reserved.</p>
 <span class="footer-tagline">"Learn from Experiences, Grow Through Lessons."</span>
 </div>
 </div>
</footer>`;

// Inject layout as soon as this script runs (placeholders exist at end of <body>)
function injectLayout() {
 const navTarget = document.getElementById('navbar-placeholder');
 if (navTarget) navTarget.outerHTML = SHARED_NAVBAR;

 const modalTarget = document.getElementById('auth-modal-placeholder');
 if (modalTarget) modalTarget.outerHTML = SHARED_AUTH_MODAL;

 const footerTarget = document.getElementById('footer-placeholder');
 if (footerTarget) footerTarget.outerHTML = SHARED_FOOTER;
}

injectLayout();
if (window.LVSession) LVSession.scheduleNavPaint();

document.addEventListener('DOMContentLoaded', () => {
 injectLayout();
 if (window.LVSession) LVSession.scheduleNavPaint();
 if (typeof refreshAuthUI === 'function') refreshAuthUI();
});
