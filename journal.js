/* =========================================================
   LESSON VAULT — Reflection Journal (Firebase Firestore)
   New, self-contained. Reads (never writes) existing globals:
   Auth, apiFetch, parseApiResponse, whenAuthReady, whenDataReady,
   Lessons, escHtml, showToast, openModal, closeModal.
   ========================================================= */
(function () {
  'use strict';

  const FB_VER = '10.12.2';
  const FB_BASE = 'https://www.gstatic.com/firebasejs/' + FB_VER + '/';
  const COLLECTION = 'journalEntries';

  const MOODS = {
    motivated: 'Motivated', hopeful: 'Hopeful', grateful: 'Grateful',
    reflective: 'Reflective', struggling: 'Struggling', confident: 'Confident'
  };
  const STATUSES = { 'to-apply': 'To apply', 'in-progress': 'In progress', 'applied': 'Applied' };

  const root = document.getElementById('jr-root');
  const S = { fb: null, db: null, uid: null, name: '', all: [], view: [], editingId: null, deleteId: null, saving: false,
              f: { q: '', mood: '', status: '', tag: '', sort: 'newest' } };

  // ── Nav link (this page only; shared layout file is untouched) ──
  (function addNavLink() {
    const nav = document.getElementById('nav-main-links');
    if (!nav || nav.querySelector('a[href="journal.html"]')) return;
    const a = document.createElement('a');
    a.href = 'journal.html'; a.textContent = 'Journal';
    const vault = nav.querySelector('a[href="vault.html"]');
    vault ? vault.insertAdjacentElement('afterend', a) : nav.appendChild(a);
    a.classList.add('active');
  })();

  // ── Small helpers ──
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const toast = (m, t) => { if (typeof showToast === 'function') showToast(esc(m), t || 'info'); };
  const $ = (id) => document.getElementById(id);

  function notice(title, bodyHtml, isErr) {
    root.innerHTML = '<div class="jr-notice' + (isErr ? ' err' : '') + '"><h2>' + esc(title) + '</h2>' + bodyHtml + '</div>';
  }

  function friendlyError(err) {
    const code = (err && err.code) || '';
    if (code.includes('permission-denied')) return 'Permission denied. Check that firestore.rules were published and you are signed in.';
    if (code.includes('unavailable') || code.includes('network')) return 'Cannot reach Firebase. Check your internet connection and try again.';
    if (code.includes('failed-precondition')) return 'Firestore needs an index for this query. Open the browser console for the link to create it.';
    if (code.includes('unauthenticated')) return 'Your Firebase session is not active. Reload the page.';
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  function isConfigured() {
    const c = window.LV_FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.projectId && !/^YOUR_/.test(c.apiKey) && !/^YOUR_/.test(c.projectId));
  }

  // ── Boot ──
  function start() {
    whenAuthReady(async () => {
      const user = Auth.current();
      if (!user) return; // existing requireAuth() already redirects non-logged-in users to login.html
      S.uid = String(user.id); S.name = user.username || '';
      if (!isConfigured()) {
        return notice('Firebase setup needed',
          '<p>The journal is installed but Firebase is not connected yet.</p><ol>' +
          '<li>Create a Firebase project and a Firestore database.</li>' +
          '<li>Paste the web config into <code>js/firebase-config.js</code>.</li>' +
          '<li>Copy <code>api/firebase_config.sample.php</code> to <code>api/firebase_config.php</code> and add the service-account key.</li>' +
          '<li>Publish <code>firestore.rules</code>.</li></ol><p style="margin-top:14px">Full steps are in <b>FIREBASE_SETUP.md</b>. The rest of Lesson Vault works normally.</p>');
      }
      if (typeof USE_API !== 'undefined' && !USE_API) {
        return notice('Needs the hosted server',
          '<p>The journal signs in through the PHP backend, so it only works on your hosted site (not on localhost without PHP).</p>', true);
      }
      await connect();
    });
  }

  async function connect() {
    root.innerHTML = '<div class="jr-grid"><div class="jr-skel"></div><div class="jr-skel"></div><div class="jr-skel"></div></div>';
    try {
      // 1) Ask our PHP backend for a Firebase token (proves who the user is)
      const res = await apiFetch('firebase/token.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await parseApiResponse(res);
      if (!data.ok) {
        if (data.code === 'not_configured') {
          return notice('Server not configured', '<p>' + esc(data.message) + '</p><p style="margin-top:10px">See <b>FIREBASE_SETUP.md</b>, step 4.</p>', true);
        }
        throw new Error(data.message || 'Could not start Firebase session.');
      }

      // 2) Load Firebase SDK only on this page
      const [appM, authM, fsM] = await Promise.all([
        import(FB_BASE + 'firebase-app.js'),
        import(FB_BASE + 'firebase-auth.js'),
        import(FB_BASE + 'firebase-firestore.js')
      ]);
      const app = appM.initializeApp(window.LV_FIREBASE_CONFIG, 'lv-journal');
      const auth = authM.initializeAuth(app, { persistence: authM.inMemoryPersistence }); // no stale sessions
      await authM.signInWithCustomToken(auth, data.token);

      S.fb = fsM; S.db = fsM.getFirestore(app);
      S.uid = data.uid;
      renderShell();
      bindShell();
      await refresh();
    } catch (err) {
      console.error('[journal]', err);
      notice('Could not load your journal', '<p>' + esc(friendlyError(err)) + '</p><p style="margin-top:14px"><button class="btn btn-primary" id="jr-retry">Try again</button></p>', true);
      const b = $('jr-retry'); if (b) b.onclick = connect;
    }
  }

  // ── Data layer (Firestore) ──
  const col = () => S.fb.collection(S.db, COLLECTION);

  /** QUERY: server-side where() filters, always scoped to the signed-in user. */
  async function runQuery() {
    const { query, where, getDocs } = S.fb;
    const parts = [where('uid', '==', S.uid)];
    if (S.f.mood) parts.push(where('mood', '==', S.f.mood));
    if (S.f.status) parts.push(where('status', '==', S.f.status));
    const snap = await getDocs(query(col(), ...parts));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function refresh() {
    const list = $('jr-list');
    if (list) list.innerHTML = '<div class="jr-skel"></div><div class="jr-skel"></div><div class="jr-skel"></div>';
    try {
      // full set (for stats + tag list) and filtered set
      const { query, where, getDocs } = S.fb;
      const snap = await getDocs(query(col(), where('uid', '==', S.uid)));
      S.all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      S.base = (S.f.mood || S.f.status) ? await runQuery() : S.all;
      renderStats(); renderTagOptions(); applyView();
    } catch (err) {
      console.error('[journal]', err);
      if (list) list.innerHTML = '<div class="jr-notice err" style="grid-column:1/-1"><p>' + esc(friendlyError(err)) + '</p></div>';
    }
  }

  const ts = (e, k) => (e[k] && e[k].toMillis ? e[k].toMillis() : 0);

  /** FILTER (tag + keyword) and SORT run in the browser on the fetched set. */
  function applyView() {
    const q = S.f.q.trim().toLowerCase();
    let v = (S.base || []).filter(e =>
      (!S.f.tag || (e.tags || []).includes(S.f.tag)) &&
      (!q || [e.title, e.reflection, e.actionStep, e.lessonTitle, (e.tags || []).join(' ')].join(' ').toLowerCase().includes(q)));
    const by = {
      newest: (a, b) => ts(b, 'createdAt') - ts(a, 'createdAt'),
      oldest: (a, b) => ts(a, 'createdAt') - ts(b, 'createdAt'),
      updated: (a, b) => ts(b, 'updatedAt') - ts(a, 'updatedAt'),
      az: (a, b) => (a.title || '').localeCompare(b.title || ''),
      za: (a, b) => (b.title || '').localeCompare(a.title || '')
    }[S.f.sort] || (() => 0);
    v = v.slice().sort(by);
    S.view = v;
    renderList();
  }

  // ── Rendering ──
  function opts(map, first) {
    return (first ? '<option value="">' + first + '</option>' : '') +
      Object.entries(map).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('');
  }

  function renderShell() {
    root.innerHTML =
      '<div class="jr-stats" id="jr-stats"></div>' +
      '<div class="jr-toolbar">' +
        '<div class="search-field"><span class="search-icon" data-icon="search" data-icon-size="18"></span>' +
        '<input type="text" id="jr-q" placeholder="Search title, reflection, tags…"></div>' +
        '<select class="filter-select" id="jr-f-mood">' + opts(MOODS, 'All moods') + '</select>' +
        '<select class="filter-select" id="jr-f-status">' + opts(STATUSES, 'All statuses') + '</select>' +
        '<select class="filter-select" id="jr-f-tag"><option value="">All tags</option></select>' +
        '<select class="filter-select" id="jr-f-sort">' +
          '<option value="newest">Newest first</option><option value="oldest">Oldest first</option>' +
          '<option value="updated">Recently updated</option><option value="az">Title A–Z</option><option value="za">Title Z–A</option></select>' +
        '<button class="btn btn-outline btn-sm" id="jr-clear">Clear</button>' +
        '<button class="btn btn-gold" id="jr-new">+ New Entry</button>' +
      '</div>' +
      '<div class="jr-meta"><span id="jr-count"></span><span>Signed in as <b>' + esc(S.name) + '</b></span></div>' +
      '<div class="jr-grid" id="jr-list"></div>';
    if (typeof initDecorativeIcons === 'function') initDecorativeIcons();
    $('jr-mood').innerHTML = opts(MOODS);
    $('jr-status').innerHTML = opts(STATUSES);
  }

  function renderStats() {
    const n = (s) => S.all.filter(e => e.status === s).length;
    $('jr-stats').innerHTML =
      '<div class="jr-stat"><b>' + S.all.length + '</b><span>Total entries</span></div>' +
      '<div class="jr-stat gold"><b>' + n('to-apply') + '</b><span>To apply</span></div>' +
      '<div class="jr-stat"><b>' + n('in-progress') + '</b><span>In progress</span></div>' +
      '<div class="jr-stat green"><b>' + n('applied') + '</b><span>Applied</span></div>';
  }

  function renderTagOptions() {
    const tags = [...new Set(S.all.flatMap(e => e.tags || []))].sort();
    const sel = $('jr-f-tag'); const cur = S.f.tag;
    sel.innerHTML = '<option value="">All tags</option>' + tags.map(t => '<option value="' + esc(t) + '">#' + esc(t) + '</option>').join('');
    sel.value = tags.includes(cur) ? cur : ''; S.f.tag = sel.value;
  }

  function fmt(e, k) {
    const ms = ts(e, k); if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderList() {
    const list = $('jr-list');
    $('jr-count').textContent = S.view.length + ' of ' + S.all.length + ' entr' + (S.all.length === 1 ? 'y' : 'ies');
    if (!S.view.length) {
      list.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><p>' +
        (S.all.length ? 'No entries match your filters.' : 'Your journal is empty. Write your first reflection.') + '</p>' +
        (S.all.length ? '' : '<button class="btn btn-gold" id="jr-empty-new">+ New Entry</button>') + '</div>';
      const b = $('jr-empty-new'); if (b) b.onclick = () => openForm();
      return;
    }
    list.innerHTML = S.view.map(e =>
      '<article class="jr-card" data-id="' + esc(e.id) + '">' +
        '<div class="jr-row"><span class="jr-pill mood">' + esc(MOODS[e.mood] || e.mood) + '</span>' +
        '<span class="jr-pill st-' + esc(e.status) + '">' + esc(STATUSES[e.status] || e.status) + '</span></div>' +
        '<h3>' + esc(e.title) + '</h3>' +
        (e.lessonId ? '<div class="jr-linked">Lesson: <a href="lesson.html?id=' + encodeURIComponent(e.lessonId) + '">' + esc(e.lessonTitle || e.lessonId) + '</a></div>' : '') +
        '<p>' + esc(e.reflection) + '</p>' +
        (e.actionStep ? '<div class="jr-action"><b>Action:</b> ' + esc(e.actionStep) + '</div>' : '') +
        ((e.tags || []).length ? '<div class="jr-row">' + e.tags.map(t => '<button class="jr-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>').join('') + '</div>' : '') +
        '<div class="jr-date">Created ' + esc(fmt(e, 'createdAt')) + (ts(e, 'updatedAt') > ts(e, 'createdAt') + 1000 ? ' · Updated ' + esc(fmt(e, 'updatedAt')) : '') + '</div>' +
        '<div class="jr-actions"><button class="btn btn-outline btn-sm" data-edit="' + esc(e.id) + '">Edit</button>' +
        '<button class="btn btn-danger btn-sm" data-del="' + esc(e.id) + '">Delete</button></div>' +
      '</article>').join('');
  }

  // ── Events ──
  function bindShell() {
    let t;
    $('jr-q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.f.q = e.target.value; applyView(); }, 200); });
    $('jr-f-tag').onchange = e => { S.f.tag = e.target.value; applyView(); };
    $('jr-f-sort').onchange = e => { S.f.sort = e.target.value; applyView(); };
    $('jr-f-mood').onchange = async e => { S.f.mood = e.target.value; await requery(); };
    $('jr-f-status').onchange = async e => { S.f.status = e.target.value; await requery(); };
    $('jr-clear').onclick = async () => {
      S.f = { q: '', mood: '', status: '', tag: '', sort: 'newest' };
      $('jr-q').value = ''; $('jr-f-mood').value = ''; $('jr-f-status').value = ''; $('jr-f-tag').value = ''; $('jr-f-sort').value = 'newest';
      await requery();
    };
    $('jr-new').onclick = () => openForm();
    $('jr-list').addEventListener('click', e => {
      const tag = e.target.closest('[data-tag]'); if (tag) { S.f.tag = tag.dataset.tag; $('jr-f-tag').value = S.f.tag; return applyView(); }
      const ed = e.target.closest('[data-edit]'); if (ed) return openForm(ed.dataset.edit);
      const del = e.target.closest('[data-del]'); if (del) { S.deleteId = del.dataset.del; openModal('jr-delete-modal'); }
    });
  }

  async function requery() {
    try { S.base = (S.f.mood || S.f.status) ? await runQuery() : S.all; applyView(); }
    catch (err) { console.error(err); toast(friendlyError(err), 'error'); }
  }

  // ── Create / Update ──
  function lessonOptions() {
    let lessons = [];
    try { lessons = Lessons.all().slice().sort((a, b) => String(a.title).localeCompare(String(b.title))); } catch (e) { /* lessons optional */ }
    return '<option value="">— None —</option>' + lessons.map(l => '<option value="' + esc(l.id) + '">' + esc(l.title) + '</option>').join('');
  }

  function clearErrors() { document.querySelectorAll('#jr-form [data-err]').forEach(n => n.textContent = ''); }
  function setErr(k, m) { const n = document.querySelector('#jr-form [data-err="' + k + '"]'); if (n) n.textContent = m; }

  function openForm(id) {
    clearErrors();
    const e = id ? S.all.find(x => x.id === id) : null;
    S.editingId = e ? e.id : null;
    $('jr-form-title').textContent = e ? 'Edit Entry' : 'New Entry';
    $('jr-lesson').innerHTML = lessonOptions();
    const pre = !e ? new URLSearchParams(location.search).get('lesson') : '';
    $('jr-title').value = e ? e.title : '';
    $('jr-reflection').value = e ? e.reflection : '';
    $('jr-action').value = e ? (e.actionStep || '') : '';
    $('jr-mood').value = e ? e.mood : 'reflective';
    $('jr-status').value = e ? e.status : 'to-apply';
    $('jr-tags').value = e ? (e.tags || []).join(', ') : '';
    $('jr-lesson').value = e ? (e.lessonId || '') : (pre || '');
    $('jr-ref-count').textContent = $('jr-reflection').value.length;
    openModal('jr-form-modal');
  }

  function parseTags(raw) {
    return [...new Set(raw.split(',').map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
  }

  function validate() {
    clearErrors();
    const title = $('jr-title').value.trim(), reflection = $('jr-reflection').value.trim();
    const actionStep = $('jr-action').value.trim(), tags = parseTags($('jr-tags').value);
    let ok = true;
    if (title.length < 3 || title.length > 100) { setErr('title', 'Title must be 3–100 characters.'); ok = false; }
    if (reflection.length < 10) { setErr('reflection', 'Reflection must be at least 10 characters.'); ok = false; }
    if (reflection.length > 2000) { setErr('reflection', 'Reflection is too long (max 2000).'); ok = false; }
    if (actionStep.length > 300) { setErr('actionStep', 'Action step is too long (max 300).'); ok = false; }
    if (tags.length > 5) { setErr('tags', 'Use at most 5 tags.'); ok = false; }
    if (tags.some(t => !/^[a-z0-9-]{1,20}$/.test(t))) { setErr('tags', 'Tags: letters, numbers, hyphen only (max 20 chars each).'); ok = false; }
    if (!MOODS[$('jr-mood').value] || !STATUSES[$('jr-status').value]) { setErr('form', 'Choose a valid mood and status.'); ok = false; }
    return ok ? { title, reflection, actionStep, tags } : null;
  }

  async function save(ev) {
    ev.preventDefault();
    if (S.saving) return;
    const v = validate(); if (!v) return;
    const lessonId = $('jr-lesson').value;
    const lesson = lessonId ? (Lessons.byId ? Lessons.byId(lessonId) : null) : null;
    const { addDoc, updateDoc, doc, serverTimestamp } = S.fb;
    const data = {
      uid: S.uid, authorName: S.name, title: v.title, reflection: v.reflection, actionStep: v.actionStep,
      mood: $('jr-mood').value, status: $('jr-status').value, tags: v.tags,
      lessonId: lessonId || '', lessonTitle: lesson ? String(lesson.title).slice(0, 255) : '',
      updatedAt: serverTimestamp()
    };
    const btn = $('jr-save-btn'); S.saving = true; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (S.editingId) {
        const old = S.all.find(x => x.id === S.editingId);
        await updateDoc(doc(S.db, COLLECTION, S.editingId), { ...data, createdAt: old.createdAt });
        toast('Entry updated.', 'success');
      } else {
        await addDoc(col(), { ...data, createdAt: serverTimestamp() });
        toast('Entry saved.', 'success');
      }
      closeModal('jr-form-modal');
      await refresh();
    } catch (err) {
      console.error('[journal] save', err);
      setErr('form', friendlyError(err));
    } finally { S.saving = false; btn.disabled = false; btn.textContent = 'Save Entry'; }
  }

  // ── Delete ──
  async function remove() {
    if (!S.deleteId) return;
    const btn = $('jr-confirm-delete'); btn.disabled = true;
    try {
      await S.fb.deleteDoc(S.fb.doc(S.db, COLLECTION, S.deleteId));
      toast('Entry deleted.', 'success');
      closeModal('jr-delete-modal'); S.deleteId = null;
      await refresh();
    } catch (err) { console.error('[journal] delete', err); toast(friendlyError(err), 'error'); }
    finally { btn.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('jr-form').addEventListener('submit', save);
    $('jr-confirm-delete').addEventListener('click', remove);
    $('jr-reflection').addEventListener('input', e => { $('jr-ref-count').textContent = e.target.value.length; });
    start();
  });
})();
