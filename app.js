/* =========================================================
   LESSON VAULT — Main JavaScript
   ========================================================= */

function siteUrl(path) {
  return window.LV ? LV.siteUrl(path) : path;
}

function apiUrl(path) {
  return window.LV ? LV.apiUrl(path) : '/api/' + String(path || '').replace(/^\//, '');
}

// ── Data Store (localStorage) ──────────────────────────────
let _loadingRemote = false;
let _loadRemotePromise = null;
let _authReady = false;
let _domReady = false;

const DB = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('lv_' + key)) || null; }
    catch { return null; }
  },
  _set(key, val) { localStorage.setItem('lv_' + key, JSON.stringify(val)); },
  set(key, val) {
    this._set(key, val);
    if (USE_API && !_loadingRemote && Auth.isLoggedIn() &&
        ['lessons', 'comments', 'users', 'userReactions', 'userReactionsByUser'].includes(key)) {
      RemoteSync.schedulePush();
    }
  },
  remove(key) { localStorage.removeItem('lv_' + key); }
};

// Pages anyone can view without logging in
const PUBLIC_PAGES = new Set([
  'login.html', 'index.html', 'explore.html', 'categories.html',
  'vault.html', 'about.html', 'contact.html', 'lesson.html',
]);

async function apiFetch(path, options = {}) {
  const cleanPath = String(path || '').replace(/^\//, '');
  const isAuthRoute = /^auth\/(login|register|logout)\.php$/.test(cleanPath);
  const token = isAuthRoute ? null : Auth.token();
  let url = apiUrl(path);
  if (token) {
    url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }

  const headers = Auth.authHeaders({ Accept: 'application/json', ...(options.headers || {}) });
  let body = options.body;

  if (body && typeof body === 'string' && headers['Content-Type'] === 'application/json') {
    try {
      const parsed = JSON.parse(body);
      if (token) parsed.token = token;
      body = JSON.stringify(parsed);
    } catch { /* use body as-is */ }
  } else if (body && typeof body === 'object' && !(body instanceof FormData)) {
    if (token) body.token = token;
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  return fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers,
    body,
    cache: /^notifications\//.test(cleanPath) ? 'no-store' : options.cache,
  });
}

async function parseApiResponse(res) {
  const text = await res.text();
  if (!text) {
    return { ok: false, message: 'Empty server response.', status: res.status };
  }
  try {
    const data = JSON.parse(text);
    if (typeof data === 'object' && data !== null) {
      data.status = res.status;
      return data;
    }
  } catch {
    // Server returned HTML or plain text instead of JSON.
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (/authentication required/i.test(text)) {
    return {
      ok: false,
      status: res.status,
      message: 'API access blocked. Open api/install.php in your browser, then log in again.',
      error: snippet,
    };
  }
  return {
    ok: false,
    status: res.status,
    message: 'Server did not return JSON. Open api/install.php in your browser first.',
    error: snippet,
  };
}

const RemoteSync = {
  _timer: null,
  _pullInterval: null,
  schedulePush() {
    if (!USE_API || !Auth.isLoggedIn()) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.push(), 1000);
  },
  applyUpdatedLessons(updatedLessons) {
    if (!Array.isArray(updatedLessons) || !updatedLessons.length) return false;
    const all = DB.get('lessons') || [];
    let changed = false;
    updatedLessons.forEach(u => {
      if (!u || !u.id) return;
      const idx = all.findIndex(l => String(l.id) === String(u.id));
      if (idx === -1) return;
      const reactions = { ...Reactions.empty(), ...(u.reactions || {}) };
      const helpful = Math.max(
        reactionHelpfulNumber(u.helpful),
        Reactions.total(reactions)
      );
      all[idx] = { ...all[idx], reactions, helpful };
      changed = true;
    });
    if (changed) {
      DB._set('lessons', all);
      const lessonIds = updatedLessons.map(u => u.id).filter(Boolean);
      lessonIds.forEach(id => updateReactionCountDom(id));
      document.dispatchEvent(new CustomEvent('lv:reactions-updated', {
        detail: { lessonIds },
      }));
    }
    return changed;
  },
  async push() {
    if (!USE_API || !Auth.isLoggedIn()) return;
    try {
      const res = await apiFetch('data/push.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lessons: DB.get('lessons') || [],
          comments: DB.get('comments') || [],
          users: DB.get('users') || [],
          userReactions: ReactionStore.mine(),
        }),
      });
      const data = await parseApiResponse(res);
      if (data.ok && data.user) Auth.saveUser(data.user, Auth.token());
      if (data.ok) this.applyUpdatedLessons(data.updatedLessons);
      else if (res.status === 401 || data.message === 'Authentication required.') {
        console.warn('Remote sync skipped: not authenticated on server.');
      }
    } catch (err) {
      console.error('Remote sync failed:', err);
    }
  },
  startPullLoop() {
    if (!USE_API) return;
    this.stopPullLoop();
    this._pullInterval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!Auth.isLoggedIn()) return;
      loadRemoteData().catch(() => {});
    }, 12000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Auth.isLoggedIn()) {
        loadRemoteData().catch(() => {});
      }
    });
  },
  stopPullLoop() {
    if (this._pullInterval) clearInterval(this._pullInterval);
    this._pullInterval = null;
  }
};

function refreshAuthUI() {
  if (typeof Auth !== 'undefined') Auth.restoreFromCache();
  // If sync wrote flat userReactions before auth was ready, promote into by-user now.
  if (typeof ReactionStore !== 'undefined') ReactionStore.ensureMigrated();
  initNavbar();
  if (window.LVSession) {
    LVSession.scheduleNavPaint();
  } else if (typeof Notifications !== 'undefined') {
    Notifications.renderBell();
  }
  if (typeof initDecorativeIcons === 'function') initDecorativeIcons();
  updateLoggedInBanners();
  document.dispatchEvent(new CustomEvent('lv:auth-ready'));
}

function updateLoggedInBanners() {
  const user = (window.LVSession && LVSession.user()) ||
    (typeof Auth !== 'undefined' ? Auth.current() : null);
  const el = document.getElementById('hero-welcome');
  if (!el) return;
  if (user) {
    el.classList.remove('hidden');
    el.innerHTML = `Welcome back, <strong>${escHtml(user.username)}</strong>! You are logged in.`;
  } else {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

function whenAuthReady(fn) {
  const run = () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  };
  if (_authReady) run();
  else document.addEventListener('lv:auth-ready', run, { once: true });
}

// ── Bible Verse Library (by category) ─────────────────────
const BIBLE_VERSES = {
  academic: [
    { reference: 'Proverbs 1:5', text: 'Let the wise hear and increase in learning, and the one who understands obtain guidance.', translation: 'ESV' },
    { reference: 'James 1:5', text: 'If any of you lacks wisdom, let him ask God, who gives generously to all without reproach.', translation: 'ESV' },
    { reference: 'Proverbs 9:10', text: 'The fear of the Lord is the beginning of wisdom, and the knowledge of the Holy One is insight.', translation: 'ESV' },
    { reference: 'Ecclesiastes 7:12', text: 'For the protection of wisdom is like the protection of money, and the advantage of knowledge is that wisdom preserves the life of him who has it.', translation: 'ESV' },
    { reference: '2 Timothy 2:15', text: 'Do your best to present yourself to God as one approved, a worker who has no need to be ashamed, rightly handling the word of truth.', translation: 'ESV' },
    { reference: 'Proverbs 18:15', text: 'An intelligent heart acquires knowledge, and the ear of the wise seeks knowledge.', translation: 'ESV' },
    { reference: 'Colossians 3:16', text: 'Let the word of Christ dwell in you richly, teaching and admonishing one another in all wisdom.', translation: 'ESV' },
    { reference: 'Psalm 119:105', text: 'Your word is a lamp to my feet and a light to my path.', translation: 'ESV' },
  ],
  career: [
    { reference: 'Colossians 3:23', text: 'Whatever you do, work heartily, as for the Lord and not for men.', translation: 'ESV' },
    { reference: 'Proverbs 16:3', text: 'Commit your work to the Lord, and your plans will be established.', translation: 'ESV' },
    { reference: 'Ecclesiastes 9:10', text: 'Whatever your hand finds to do, do it with your might.', translation: 'ESV' },
    { reference: 'Proverbs 22:29', text: 'Do you see a man skillful in his work? He will stand before kings; he will not stand before obscure men.', translation: 'ESV' },
    { reference: 'Galatians 6:9', text: 'And let us not grow weary of doing good, for in due season we will reap, if we do not give up.', translation: 'ESV' },
    { reference: 'Proverbs 12:11', text: 'Whoever works his land will have plenty of bread, but he who follows worthless pursuits lacks sense.', translation: 'ESV' },
    { reference: '1 Corinthians 10:31', text: 'So, whether you eat or drink, or whatever you do, do all to the glory of God.', translation: 'ESV' },
    { reference: 'Psalm 90:17', text: 'Let the favor of the Lord our God be upon us, and establish the work of our hands upon us.', translation: 'ESV' },
  ],
  business: [
    { reference: 'Proverbs 16:9', text: 'The heart of man plans his way, but the Lord establishes his steps.', translation: 'ESV' },
    { reference: 'Luke 16:10', text: 'One who is faithful in a very little is also faithful in much.', translation: 'ESV' },
    { reference: 'Proverbs 11:14', text: 'Where there is no guidance, a people falls, but in an abundance of counselors there is safety.', translation: 'ESV' },
    { reference: 'Proverbs 21:5', text: 'The plans of the diligent lead surely to abundance, but everyone who is hasty comes only to poverty.', translation: 'ESV' },
    { reference: 'Proverbs 3:5-6', text: 'Trust in the Lord with all your heart, and do not lean on your own understanding. In all your ways acknowledge him, and he will make straight your paths.', translation: 'ESV' },
    { reference: 'Matthew 6:33', text: 'But seek first the kingdom of God and his righteousness, and all these things will be added to you.', translation: 'ESV' },
    { reference: 'Proverbs 10:4', text: 'A slack hand causes poverty, but the hand of the diligent makes rich.', translation: 'ESV' },
    { reference: 'Ecclesiastes 11:6', text: 'In the morning sow your seed, and at evening withhold not your hand, for you do not know which will prosper.', translation: 'ESV' },
  ],
  financial: [
    { reference: 'Proverbs 22:7', text: 'The borrower is the slave of the lender.', translation: 'ESV' },
    { reference: 'Matthew 6:21', text: 'For where your treasure is, there your heart will be also.', translation: 'ESV' },
    { reference: 'Proverbs 13:11', text: 'Wealth gained hastily will dwindle, but whoever gathers little by little will increase it.', translation: 'ESV' },
    { reference: '1 Timothy 6:10', text: 'For the love of money is a root of all kinds of evils.', translation: 'ESV' },
    { reference: 'Proverbs 21:20', text: 'Precious treasure and oil are in a wise man\'s dwelling, but a foolish man devours it.', translation: 'ESV' },
    { reference: 'Luke 12:15', text: 'Take care, and be on your guard against all covetousness, for one\'s life does not consist in the abundance of his possessions.', translation: 'ESV' },
    { reference: 'Malachi 3:10', text: 'Bring the full tithe into the storehouse, that there may be food in my house. And thereby put me to the test, says the Lord of hosts.', translation: 'ESV' },
    { reference: 'Proverbs 3:9-10', text: 'Honor the Lord with your wealth and with the firstfruits of all your produce; then your barns will be filled with plenty.', translation: 'ESV' },
  ],
  relationship: [
    { reference: 'Proverbs 17:17', text: 'A friend loves at all times, and a brother is born for adversity.', translation: 'ESV' },
    { reference: '1 Corinthians 13:4', text: 'Love is patient and kind; love does not envy or boast.', translation: 'ESV' },
    { reference: '1 Peter 4:8', text: 'Above all, keep loving one another earnestly, since love covers a multitude of sins.', translation: 'ESV' },
    { reference: 'Proverbs 27:17', text: 'Iron sharpens iron, and one man sharpens another.', translation: 'ESV' },
    { reference: 'Ephesians 4:32', text: 'Be kind to one another, tenderhearted, forgiving one another, as God in Christ forgave you.', translation: 'ESV' },
    { reference: 'Colossians 3:13', text: 'Bear with each other and forgive one another if any of you has a grievance against someone. Forgive as the Lord forgave you.', translation: 'ESV' },
    { reference: 'Romans 12:18', text: 'If possible, so far as it depends on you, live peaceably with all.', translation: 'ESV' },
    { reference: 'Proverbs 18:24', text: 'A man of many companions may come to ruin, but there is a friend who sticks closer than a brother.', translation: 'ESV' },
  ],
  technology: [
    { reference: 'Ecclesiastes 3:1', text: 'For everything there is a season, and a time for every matter under heaven.', translation: 'ESV' },
    { reference: 'Psalm 90:12', text: 'Teach us to number our days, that we may get a heart of wisdom.', translation: 'ESV' },
    { reference: '1 Corinthians 6:12', text: 'All things are lawful for me, but not all things are helpful. All things are lawful for me, but I will not be dominated by anything.', translation: 'ESV' },
    { reference: 'Philippians 4:8', text: 'Finally, brothers, whatever is true, whatever is honorable, whatever is just, whatever is pure, whatever is lovely, whatever is commendable, if there is any excellence, if there is anything worthy of praise, think about these things.', translation: 'ESV' },
    { reference: 'Proverbs 4:23', text: 'Keep your heart with all vigilance, for from it flow the springs of life.', translation: 'ESV' },
    { reference: 'Ephesians 5:15-16', text: 'Look carefully then how you walk, not as unwise but as wise, making the best use of the time, because the days are evil.', translation: 'ESV' },
    { reference: 'Psalm 101:3', text: 'I will not set before my eyes anything that is worthless.', translation: 'ESV' },
    { reference: 'Matthew 6:22', text: 'The eye is the lamp of the body. So, if your eye is healthy, your whole body will be full of light.', translation: 'ESV' },
  ],
  personal: [
    { reference: 'Philippians 4:13', text: 'I can do all things through him who strengthens me.', translation: 'ESV' },
    { reference: 'Jeremiah 29:11', text: 'For I know the plans I have for you, declares the Lord, plans for welfare and not for evil, to give you a future and a hope.', translation: 'ESV' },
    { reference: 'Psalm 46:10', text: 'Be still, and know that I am God.', translation: 'ESV' },
    { reference: '2 Corinthians 5:17', text: 'Therefore, if anyone is in Christ, he is a new creation. The old has passed away; behold, the new has come.', translation: 'ESV' },
    { reference: 'Isaiah 40:31', text: 'But they who wait for the Lord shall renew their strength; they shall mount up with wings like eagles.', translation: 'ESV' },
    { reference: 'Romans 12:2', text: 'Do not be conformed to this world, but be transformed by the renewal of your mind.', translation: 'ESV' },
    { reference: 'Psalm 139:14', text: 'I praise you, for I am fearfully and wonderfully made. Wonderful are your works.', translation: 'ESV' },
    { reference: 'Joshua 1:9', text: 'Be strong and courageous. Do not be frightened, and do not be dismayed, for the Lord your God is with you wherever you go.', translation: 'ESV' },
  ],
  faith: [
    { reference: 'Isaiah 41:10', text: 'Fear not, for I am with you; be not dismayed, for I am your God.', translation: 'ESV' },
    { reference: 'Romans 8:28', text: 'And we know that for those who love God all things work together for good.', translation: 'ESV' },
    { reference: 'Hebrews 11:1', text: 'Now faith is the assurance of things hoped for, the conviction of things not seen.', translation: 'ESV' },
    { reference: 'Psalm 23:1', text: 'The Lord is my shepherd; I shall not want.', translation: 'ESV' },
    { reference: 'John 3:16', text: 'For God so loved the world, that he gave his only Son, that whoever believes in him should not perish but have eternal life.', translation: 'ESV' },
    { reference: 'Matthew 11:28', text: 'Come to me, all who labor and are heavy laden, and I will give you rest.', translation: 'ESV' },
    { reference: 'Psalm 27:1', text: 'The Lord is my light and my salvation; whom shall I fear?', translation: 'ESV' },
    { reference: '2 Corinthians 12:9', text: 'My grace is sufficient for you, for my power is made perfect in weakness.', translation: 'ESV' },
    { reference: 'Proverbs 3:5', text: 'Trust in the Lord with all your heart, and do not lean on your own understanding.', translation: 'ESV' },
    { reference: 'Lamentations 3:22-23', text: 'The steadfast love of the Lord never ceases; his mercies never come to an end; they are new every morning.', translation: 'ESV' },
  ],
};

function versesForCategory(cat, count = 2) {
  const pool = [...(BIBLE_VERSES[cat] || []), ...(BIBLE_VERSES.faith || [])];
  return pool.slice(0, count);
}

// ── Emotion Reactions ──────────────────────────────────────
const REACTIONS = [
  { key: 'helpful',    emoji: '👍', label: 'Helpful',    color: '#0A7E8C' },
  { key: 'inspired',   emoji: '💡', label: 'Inspired',   color: '#2B6CB0' },
  { key: 'grateful',   emoji: '🙏', label: 'Grateful',   color: '#B7791F' },
  { key: 'moved',      emoji: '❤️', label: 'Moved',      color: '#97266D' },
  { key: 'hopeful',    emoji: '🌱', label: 'Hopeful',    color: '#276749' },
  { key: 'relatable',  emoji: '🤝', label: 'Relatable',  color: '#434190' },
  { key: 'motivated',  emoji: '💪', label: 'Motivated',  color: '#9B2335' },
  { key: 'empathy',    emoji: '🫂', label: 'I feel this', color: '#553C9A' },
  { key: 'encouraged', emoji: '🌟', label: 'Encouraged', color: '#D69E2E' },
  { key: 'amen',       emoji: '✨', label: 'Amen',       color: '#744210' },
  { key: 'peaceful',   emoji: '☮️', label: 'Peaceful',   color: '#319795' },
  { key: 'joyful',     emoji: '😊', label: 'Joyful',     color: '#DD6B20' },
  { key: 'reflective', emoji: '🤔', label: 'Reflective', color: '#4A5568' },
  { key: 'blessed',    emoji: '🕊️', label: 'Blessed',    color: '#667EEA' },
];

const Reactions = {
  all() { return REACTIONS; },
  meta(key) { return REACTIONS.find(r => r.key === key) || null; },
  total(reactions) {
    return Object.values(reactions || {}).reduce((s, n) => s + (n || 0), 0);
  },
  empty() {
    const o = {};
    REACTIONS.forEach(r => { o[r.key] = 0; });
    return o;
  },
  seedFromHelpful(count) {
    const r = this.empty();
    r.helpful = count || 0;
    return r;
  }
};

function reactionHelpfulNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function syncLessonReactions(lesson) {
  const helpful = reactionHelpfulNumber(lesson.helpful);
  const mapTotal = Reactions.total(lesson.reactions);
  // `{}` is truthy — treat empty maps as missing so helpful seed counts still show.
  if (!lesson.reactions || Object.keys(lesson.reactions).length === 0 || mapTotal < helpful) {
    lesson.reactions = Reactions.seedFromHelpful(Math.max(helpful, mapTotal));
  }
  lesson.helpful = Reactions.total(lesson.reactions);
  return lesson;
}

/**
 * DATA STRUCTURE (canonical reaction store):
 *   DB key `userReactionsByUser` = {
 *     [userId]: { [postId]: reactionType }   // e.g. { "u1": { "l3": "helpful" } }
 *   }
 * Flat `userReactions` = { [postId]: reactionType } for the logged-in user only (API push/sync mirror).
 *
 * All three UI counts (post header, Reactions Received, Reactions I Gave) use the helpers below
 * so they stay in sync from this same store (+ lesson.helpful as the API aggregate).
 */
const ReactionStore = {
  KEY: 'userReactionsByUser',

  allByUser() {
    return DB.get(this.KEY) || {};
  },

  ensureMigrated() {
    const byUser = { ...(this.allByUser() || {}) };
    const flat = DB.get('userReactions') || {};
    const uid = Auth.current()?.id != null ? String(Auth.current().id) : null;

    // Always fill the CURRENT user's slot from flat userReactions when that slot is empty.
    // Previous bug: returned early if ANY other user existed, so the logged-in user's
    // synced reactions never landed in userReactionsByUser → "Gave" stayed 0.
    if (uid && flat && typeof flat === 'object' && Object.keys(flat).length) {
      const mine = byUser[uid] || {};
      if (!Object.keys(mine).length) {
        byUser[uid] = { ...flat };
        DB._set(this.KEY, byUser);
      }
    }
    return byUser;
  },

  forUser(userId) {
    if (userId == null || userId === '') return {};
    const byUser = this.ensureMigrated();
    const uid = String(userId);
    return { ...(byUser[uid] || byUser[userId] || {}) };
  },

  mine() {
    return this.forUser(Auth.current()?.id);
  },

  setForUser(userId, map, opts = {}) {
    if (userId == null || userId === '') return;
    const uid = String(userId);
    const byUser = { ...this.allByUser(), [uid]: { ...(map || {}) } };
    if (opts.silent) DB._set(this.KEY, byUser);
    else DB.set(this.KEY, byUser);

    if (String(Auth.current()?.id) === uid) {
      if (opts.silent) DB._set('userReactions', { ...(map || {}) });
      else DB.set('userReactions', { ...(map || {}) });
    }
  },

  setMine(map, opts = {}) {
    const uid = Auth.current()?.id;
    if (uid == null || uid === '') return;
    this.setForUser(uid, map, opts);
  },

  /** Aggregate emotion counts for one lesson across every local user map */
  countsForLesson(lessonId) {
    const counts = Reactions.empty();
    const postId = String(lessonId);
    const byUser = this.ensureMigrated();
    Object.keys(byUser).forEach(uid => {
      const map = byUser[uid] || {};
      const key = map[postId] || map[lessonId];
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  },

  applyToLesson(lessonId) {
    const postId = String(lessonId);
    const reactions = this.countsForLesson(postId);
    let helpful = Reactions.total(reactions);
    const all = DB.get('lessons') || [];
    const idx = all.findIndex(l => String(l.id) === postId);
    if (idx === -1) return null;
    if (typeof USE_API !== 'undefined' && USE_API) {
      helpful = Math.max(helpful, reactionHelpfulNumber(all[idx].helpful));
    }
    if (helpful > Reactions.total(reactions)) {
      all[idx] = { ...all[idx], reactions: Reactions.seedFromHelpful(helpful), helpful };
    } else {
      all[idx] = { ...all[idx], reactions, helpful };
    }
    DB.set('lessons', all);
    return { reactions: all[idx].reactions, helpful };
  },

  givenBy(userId) { return getReactionsGivenByUser(userId); },
  receivedBy(userId) { return getReactionsReceivedByUser(userId); }
};

/**
 * Count how many users reacted to this post.
 * Primary source: userReactionsByUser (loop every userId → postId).
 * API fallback: lesson.helpful / lesson.reactions (server aggregate of all users).
 */
function getTotalReactionsForPost(postId) {
  if (postId == null || postId === '') return 0;
  const id = String(postId);
  const byUser = ReactionStore.ensureMigrated();
  let ledgerCount = 0;
  Object.keys(byUser).forEach(uid => {
    const map = byUser[uid] || {};
    if (map[id] || map[postId]) ledgerCount += 1;
  });

  // API: lesson.helpful is the server aggregate of ALL users (ledger may only have the current user).
  const lesson = (typeof Lessons !== 'undefined' && Lessons.byId)
    ? Lessons.byId(id, { includeFlagged: true, includeRemoved: true })
      || Lessons.byId(postId, { includeFlagged: true, includeRemoved: true })
    : null;
  let lessonCount = 0;
  if (lesson) {
    const mapTotal = Reactions.total(lesson.reactions);
    const helpful = reactionHelpfulNumber(lesson.helpful);
    lessonCount = Math.max(mapTotal, helpful);
  }

  return Math.max(ledgerCount, lessonCount);
}

/**
 * Total reactions on every post owned by userId.
 * Same data source as the post header: getTotalReactionsForPost.
 */
function getReactionsReceivedByUser(userId) {
  if (userId == null || userId === '') return 0;
  const uid = String(userId);
  const myLessons = (DB.get('lessons') || []).filter(l =>
    String(l.userId) === uid && l.status !== 'removed'
  );
  return myLessons.reduce(
    (sum, lesson) => sum + getTotalReactionsForPost(lesson.id),
    0
  );
}

/**
 * Reactions the user gave — same pattern as Comments.byUser(userId).length:
 * read userReactionsByUser[userId] and count entries.
 */
function getReactionsGivenByUser(userId) {
  if (userId == null || userId === '') return 0;
  const map = ReactionStore.forUser(userId);
  return Object.keys(map).filter(postId => !!map[postId]).length;
}

/** Update the post-header reaction count in the DOM (same pattern as #comment-count). */
function updateReactionCountDom(postId) {
  const total = getTotalReactionsForPost(postId);
  const countEl = document.getElementById('reaction-count');
  if (countEl) countEl.textContent = total;
  const labelEl = document.getElementById('reaction-count-label');
  if (labelEl) labelEl.textContent = ` reaction${total !== 1 ? 's' : ''}`;
}

function togglePasswordVisibility(btn) {
  const wrap = btn.closest('.password-field');
  const input = wrap && wrap.querySelector('input');
  if (!input) return;
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  btn.textContent = showing ? 'Hide' : 'Show';
  btn.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  btn.setAttribute('aria-pressed', showing ? 'true' : 'false');
}




// ── Content Moderation ─────────────────────────────────────
const DEFAULT_MOD_SETTINGS = {
  autoDelete: true,
  autoFlag: true,
  minExperienceLength: 40,
  minLessonLength: 20,
  blocklist: [
    'spam', 'scam', 'phishing', 'hack free', 'torrent download', 'porn', 'xxx',
    'casino', 'lottery winner', 'nigerian prince', 'crypto giveaway', 'click here now',
    'buy followers', 'viagra', 'kill yourself', 'hate speech', 'nazi', 'terrorist attack plan',
    'credit card dump', 'stolen account', 'password cracker', 'malware', 'ransomware'
  ],
  spamPatterns: [
    'buy now', 'limited offer', 'act now', 'free money', 'make $', 'work from home earn',
    'dm me for', 'whatsapp me at', 'telegram scam', 'double your money', 'guaranteed profit',
    'no experience needed earn', 'click this link', 'subscribe to my channel', 'promo code'
  ],
  relevanceKeywords: [
    'learn', 'lesson', 'experience', 'taught', 'realized', 'realise', 'mistake', 'growth',
    'advice', 'story', 'happened', 'wish', 'would tell', 'takeaway', 'reflect', 'journey',
    'struggle', 'overcome', 'faith', 'god', 'pray', 'wisdom', 'life', 'work', 'school',
    'friend', 'family', 'money', 'career', 'business', 'relationship', 'failed', 'success',
    'changed', 'important', 'remember', 'never', 'always', 'hard', 'difficult', 'tried'
  ],
  categoryKeywords: {
    academic: ['study', 'school', 'college', 'university', 'exam', 'grade', 'thesis', 'scholarship', 'class', 'homework', 'student', 'professor'],
    career: ['job', 'work', 'interview', 'boss', 'employee', 'promotion', 'salary', 'office', 'resume', 'hire', 'fired', 'quit'],
    business: ['startup', 'company', 'partner', 'customer', 'revenue', 'profit', 'inventory', 'entrepreneur', 'founder'],
    financial: ['debt', 'credit', 'save', 'budget', 'invest', 'loan', 'interest', 'bank', 'spend', 'income'],
    relationship: ['friend', 'partner', 'family', 'love', 'trust', 'boundary', 'marriage', 'breakup', 'communication'],
    technology: ['computer', 'laptop', 'software', 'backup', 'data', 'internet', 'phone', 'app', 'code', 'digital'],
    personal: ['anxiety', 'depression', 'confidence', 'self', 'mental', 'habit', 'goal', 'motivation', 'peace'],
    faith: ['god', 'jesus', 'bible', 'scripture', 'pray', 'church', 'faith', 'spiritual', 'lord', 'christ']
  }
};

const Moderation = {
  settings() { return DB.get('moderationSettings') || DEFAULT_MOD_SETTINGS; },
  saveSettings(s) { DB.set('moderationSettings', { ...this.settings(), ...s }); },
  log(entry) {
    const logs = DB.get('moderationLog') || [];
    logs.unshift({ id: 'ml' + Date.now(), date: new Date().toISOString(), ...entry });
    if (logs.length > 200) logs.length = 200;
    DB.set('moderationLog', logs);
  },
  logs() { return DB.get('moderationLog') || []; },

  scanText(text) {
    const t = (text || '').toLowerCase();
    const settings = this.settings();
    const reasons = [];
    for (const word of settings.blocklist) {
      if (t.includes(word.toLowerCase())) reasons.push(`Blocked term: "${word}"`);
    }
    for (const pattern of settings.spamPatterns) {
      if (t.includes(pattern.toLowerCase())) reasons.push(`Spam pattern: "${pattern}"`);
    }
    if (/(.)\1{6,}/.test(text)) reasons.push('Excessive repeated characters');
    if (text && text.length > 20 && text === text.toUpperCase() && /[A-Z]/.test(text)) reasons.push('Excessive caps (shouting/spam)');
    return reasons;
  },

  relevanceScore(data) {
    const settings = this.settings();
    const combined = [data.title, data.experience, data.lessonLearned, data.text, data.category].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    for (const kw of settings.relevanceKeywords) {
      if (combined.includes(kw)) score++;
    }
    const catKws = settings.categoryKeywords[data.category] || [];
    for (const kw of catKws) {
      if (combined.includes(kw)) score += 2;
    }
    return score;
  },

  scanLesson(data) {
    const settings = this.settings();
    const reasons = [];
    const textReasons = this.scanText([data.title, data.experience, data.lessonLearned].join(' '));
    reasons.push(...textReasons);

    if ((data.experience || '').trim().length < settings.minExperienceLength)
      reasons.push('Experience too short to be a meaningful lesson');
    if ((data.lessonLearned || '').trim().length < settings.minLessonLength)
      reasons.push('Lesson learned section too short');

    const relevance = this.relevanceScore(data);
    if (relevance < 2) reasons.push('Content does not appear related to life lessons or selected category');

    const hasMalicious = textReasons.some(r => r.startsWith('Blocked term'));
    const hasSpam = textReasons.some(r => r.startsWith('Spam pattern'));
    const isUnrelated = relevance < 2;

    if (hasMalicious || hasSpam) return { action: 'reject', reasons, relevance };
    if (isUnrelated && settings.autoDelete) return { action: 'reject', reasons, relevance };
    if (isUnrelated && settings.autoFlag) return { action: 'flag', reasons, relevance };
    if (reasons.length && settings.autoFlag) return { action: 'flag', reasons, relevance };
    return { action: 'allow', reasons: [], relevance };
  },

  scanComment(text) {
    const settings = this.settings();
    const reasons = this.scanText(text);
    const relevance = this.relevanceScore({ text, title: text, experience: text, lessonLearned: text });
    const hasMalicious = reasons.some(r => r.startsWith('Blocked term'));
    const hasSpam = reasons.some(r => r.startsWith('Spam pattern'));
    if (text.trim().length < 5) reasons.push('Comment too short');
    if (hasMalicious || hasSpam) return { action: 'reject', reasons };
    if (reasons.length && settings.autoDelete) return { action: 'reject', reasons };
    if (reasons.length && settings.autoFlag) return { action: 'flag', reasons };
    return { action: 'allow', reasons: [] };
  },

  runFullScan() {
    const settings = this.settings();
    let removed = 0, flagged = 0;
    const lessons = Lessons.all({ includeFlagged: true, includeRemoved: true });
    lessons.forEach(l => {
      if (l.status === 'removed') return;
      const scan = this.scanLesson(l);
      if (scan.action === 'reject' && settings.autoDelete) {
        Admin.removeLesson(l.id, 'auto-scan', scan.reasons.join('; '));
        removed++;
      } else if (scan.action === 'flag' && l.status !== 'flagged') {
        Lessons.update(l.id, { status: 'flagged', moderationReason: scan.reasons.join('; ') });
        this.log({ type: 'lesson', action: 'auto-flagged', targetId: l.id, title: l.title, reasons: scan.reasons });
        flagged++;
      }
    });
    const comments = Comments.all({ includeFlagged: true, includeRemoved: true });
    comments.forEach(c => {
      if (c.status === 'removed') return;
      const scan = this.scanComment(c.text);
      if (scan.action === 'reject' && settings.autoDelete) {
        Admin.removeComment(c.id, 'auto-scan', scan.reasons.join('; '));
        removed++;
      } else if (scan.action === 'flag' && c.status !== 'flagged') {
        Comments.update(c.id, { status: 'flagged', moderationReason: scan.reasons.join('; ') });
        this.log({ type: 'comment', action: 'auto-flagged', targetId: c.id, reasons: scan.reasons });
        flagged++;
      }
    });
    return { removed, flagged };
  }
};

// ── Seed Data ──────────────────────────────────────────────
function seedData() {
  if (DB.get('seeded')) return;
  const lessons = [
    { id: 'l1', userId: 'u0', title: 'How procrastination cost me a scholarship', category: 'academic', experience: 'I had a full scholarship application ready but kept delaying the submission thinking I had more time. When I finally sat down to submit, the portal was closed. That opportunity was gone forever.', lessonLearned: 'Never assume deadlines are flexible. Set your own internal deadlines 3 days before the actual one. The cost of delay is almost always higher than the cost of an imperfect early attempt.', datePosted: '2025-01-10', helpful: 42, anonymous: false, author: 'Maria S.', videoUrl: '', bibleVerses: versesForCategory('academic'), adviceVideo: null },
    { id: 'l2', userId: 'u0', title: 'The interview I bombed taught me more than any I passed', category: 'career', experience: 'I walked into a senior developer interview completely underprepared. I thought my portfolio would speak for itself. The interviewers asked about system design and I completely froze. I left humiliated.', lessonLearned: 'Confidence without preparation is just arrogance. Research the company deeply, practice out loud, and always prepare for questions outside your comfort zone. Failure in an interview is free feedback.', datePosted: '2025-01-18', helpful: 67, anonymous: false, author: 'James T.', videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ', bibleVerses: versesForCategory('career'), adviceVideo: null },
    { id: 'l3', userId: 'u0', title: 'Starting a business without a financial plan', category: 'business', experience: 'I launched my online store with passion but zero financial planning. Six months in, I ran out of capital during peak season when I needed inventory most. I had to shut down.', lessonLearned: 'Passion fuels you but a budget keeps you alive. Always have 6 months of operating expenses in reserve and model your cash flow before you spend a single peso on the business.', datePosted: '2025-02-02', helpful: 89, anonymous: true, author: 'Anonymous', videoUrl: '', bibleVerses: versesForCategory('business'), adviceVideo: null },
    { id: 'l4', userId: 'u0', title: 'I ignored my credit card debt until it doubled', category: 'financial', experience: 'I had a small credit card balance that I kept making minimum payments on. Two years later the interest had doubled what I owed and it was affecting my credit score.', lessonLearned: 'Minimum payments are a trap. Pay more than the minimum every month even if it hurts short term. Understanding compound interest early is the single most valuable financial lesson.', datePosted: '2025-02-15', helpful: 113, anonymous: true, author: 'Anonymous', videoUrl: '', bibleVerses: versesForCategory('financial'), adviceVideo: null },
    { id: 'l5', userId: 'u0', title: 'What a failed friendship taught me about boundaries', category: 'relationship', experience: 'I had a close friend who I allowed to borrow money repeatedly. When I finally needed help, they were nowhere to be found. The friendship ended painfully.', lessonLearned: 'Boundaries are not walls — they are the foundation of healthy relationships. Saying no is not selfish; it is honest. Real friendships survive boundaries; transactional ones do not.', datePosted: '2025-03-01', helpful: 76, anonymous: false, author: 'Anika R.', videoUrl: '', bibleVerses: versesForCategory('relationship'), adviceVideo: null },
    { id: 'l6', userId: 'u0', title: 'I lost months of work because I never backed up', category: 'technology', experience: 'My laptop crashed while I was finishing my thesis. No backups, no cloud sync. Three months of research and writing were gone. I had to start over.', lessonLearned: 'The 3-2-1 backup rule saves lives: 3 copies, 2 different media, 1 offsite. Set up automatic cloud backup today. Your future self will thank you.', datePosted: '2025-03-10', helpful: 94, anonymous: false, author: 'Ben L.', videoUrl: '', bibleVerses: versesForCategory('technology'), adviceVideo: null },
    { id: 'l7', userId: 'u0', title: 'Comparing myself to others almost broke me', category: 'personal', experience: 'I spent years measuring my progress against classmates and social media posts. I became anxious, depressed, and paralyzed by the feeling that I was always behind.', lessonLearned: 'You are not running someone else\'s race. Comparison is the thief of joy and of momentum. Track your own progress against your past self — that is the only metric that matters.', datePosted: '2025-03-22', helpful: 148, anonymous: true, author: 'Anonymous', videoUrl: '', bibleVerses: versesForCategory('personal'), adviceVideo: null },
    { id: 'l8', userId: 'u0', title: 'Burning out by saying yes to everything', category: 'career', experience: 'As a new employee I said yes to every project, every overtime, every favor. Within a year I was burned out, underperforming, and resenting a job I once loved.', lessonLearned: 'Your time and energy are finite resources. Saying yes to everything means saying no to quality. Learn to prioritize and protect your capacity — your best work requires rest.', datePosted: '2025-04-05', helpful: 101, anonymous: false, author: 'Carlo M.', videoUrl: '', bibleVerses: versesForCategory('career'), adviceVideo: null },
    { id: 'l9', userId: 'u0', title: 'How I lost a business partner through poor communication', category: 'business', experience: 'My co-founder and I had different visions for our startup but never openly discussed them. Months of silent resentment exploded into a fallout that dissolved the company.', lessonLearned: 'Have the hard conversations early. A 30-minute uncomfortable discussion at the start is worth more than months of avoidance that ends in collapse. Document everything between partners.', datePosted: '2025-04-14', helpful: 58, anonymous: false, author: 'Diana V.', videoUrl: '', bibleVerses: versesForCategory('business'), adviceVideo: null },
  ];
  const users = [
    { id: 'u0', username: 'Admin', email: 'admin@lessonvault.com', password: 'admin123', role: 'admin', joined: '2024-01-01', bio: 'Lesson Vault Administrator', interests: [], connections: [] },
    { id: 'u1', username: 'testuser', email: 'test@lessonvault.com', password: 'password123', role: 'user', joined: '2025-01-01', bio: 'Learning from life one lesson at a time.', interests: ['personal', 'career'], connections: [] },
    { id: 'u2', username: 'Maria S.', email: 'maria@lessonvault.com', password: 'demo1234', role: 'user', joined: '2024-11-15', bio: 'Graduate student sharing academic lessons.', interests: ['academic', 'personal'], connections: [] },
    { id: 'u3', username: 'James T.', email: 'james@lessonvault.com', password: 'demo1234', role: 'user', joined: '2024-12-01', bio: 'Software engineer navigating career growth.', interests: ['career', 'technology'], connections: [] },
    { id: 'u4', username: 'Anika R.', email: 'anika@lessonvault.com', password: 'demo1234', role: 'user', joined: '2025-01-05', bio: 'Believer in healthy boundaries and honest friendships.', interests: ['relationship', 'faith'], connections: [] },
    { id: 'u5', username: 'Carlo M.', email: 'carlo@lessonvault.com', password: 'demo1234', role: 'user', joined: '2025-02-10', bio: 'Recovering people-pleaser. Rest is productive.', interests: ['career', 'personal'], connections: [] },
    { id: 'u6', username: 'FaithGuide', email: 'faith@lessonvault.com', password: 'demo1234', role: 'user', joined: '2025-01-20', bio: 'Sharing wisdom rooted in scripture for everyday life.', interests: ['faith', 'relationship', 'personal'], connections: [] },
  ];
  const comments = [
    { id: 'c1', lessonId: 'l1', userId: 'u3', text: 'This hit close to home. Setting internal deadlines saved me last semester.', datePosted: '2025-01-12', anonymous: false, author: 'James T.' },
    { id: 'c2', lessonId: 'l1', userId: 'u2', text: 'Thank you for sharing. Proverbs 1:5 came to mind reading this.', datePosted: '2025-01-13', anonymous: false, author: 'Maria S.' },
    { id: 'c3', lessonId: 'l5', userId: 'u6', text: 'Boundaries are an act of love — for yourself and others. Beautiful lesson.', datePosted: '2025-03-03', anonymous: false, author: 'FaithGuide' },
    { id: 'c4', lessonId: 'l7', userId: 'u4', text: 'Comparison stole years from me too. Tracking my own growth changed everything.', datePosted: '2025-03-25', anonymous: false, author: 'Anika R.' },
  ];
  DB.set('lessons', lessons);
  DB.set('users', users);
  DB.set('comments', comments);
  DB.set('moderationSettings', DEFAULT_MOD_SETTINGS);
  DB.set('moderationLog', []);
  DB.set('seeded', true);
}

function migrateData() {
  const lessons = DB.get('lessons') || [];
  let lessonsChanged = false;
  lessons.forEach(l => {
    if (!l.bibleVerses) { l.bibleVerses = versesForCategory(l.category || 'personal'); lessonsChanged = true; }
    if (l.videoUrl === undefined) { l.videoUrl = ''; lessonsChanged = true; }
    if (l.adviceVideo === undefined) { l.adviceVideo = null; lessonsChanged = true; }
    if (!l.status) { l.status = 'active'; lessonsChanged = true; }
    if (!l.reactions) {
      l.reactions = Reactions.seedFromHelpful(l.helpful || 0);
      lessonsChanged = true;
    }
    syncLessonReactions(l);
  });
  if (lessonsChanged) DB.set('lessons', lessons);

  const users = DB.get('users') || [];
  let usersChanged = false;
  users.forEach(u => {
    if (!u.bio) { u.bio = ''; usersChanged = true; }
    if (!u.interests) { u.interests = []; usersChanged = true; }
    if (!u.connections) { u.connections = []; usersChanged = true; }
    if (!u.role) { u.role = 'user'; usersChanged = true; }
  });
  if (usersChanged) DB.set('users', users);

  if (!users.find(u => u.role === 'admin')) {
    users.unshift({ id: 'u0', username: 'Admin', email: 'admin@lessonvault.com', password: 'admin123', role: 'admin', joined: '2024-01-01', bio: 'Lesson Vault Administrator', interests: [], connections: [] });
    DB.set('users', users);
  }

  if (!DB.get('comments')) DB.set('comments', []);
  if (!DB.get('moderationSettings')) DB.set('moderationSettings', DEFAULT_MOD_SETTINGS);
  if (!DB.get('moderationLog')) DB.set('moderationLog', []);

  const comments = DB.get('comments') || [];
  let commentsChanged = false;
  comments.forEach(c => {
    if (!c.status) { c.status = 'active'; commentsChanged = true; }
  });
  if (commentsChanged) DB.set('comments', comments);

  if (!DB.get('communitySeeded') && DB.get('seeded')) {
    const existing = DB.get('users') || [];
    const communityUsers = [
      { id: 'u2', username: 'Maria S.', email: 'maria@lessonvault.com', password: 'demo1234', role: 'user', joined: '2024-11-15', bio: 'Graduate student sharing academic lessons.', interests: ['academic', 'personal'], connections: [] },
      { id: 'u3', username: 'James T.', email: 'james@lessonvault.com', password: 'demo1234', role: 'user', joined: '2024-12-01', bio: 'Software engineer navigating career growth.', interests: ['career', 'technology'], connections: [] },
      { id: 'u4', username: 'Anika R.', email: 'anika@lessonvault.com', password: 'demo1234', role: 'user', joined: '2025-01-05', bio: 'Believer in healthy boundaries and honest friendships.', interests: ['relationship', 'faith'], connections: [] },
      { id: 'u5', username: 'Carlo M.', email: 'carlo@lessonvault.com', password: 'demo1234', role: 'user', joined: '2025-02-10', bio: 'Recovering people-pleaser. Rest is productive.', interests: ['career', 'personal'], connections: [] },
      { id: 'u6', username: 'FaithGuide', email: 'faith@lessonvault.com', password: 'demo1234', role: 'user', joined: '2025-01-20', bio: 'Sharing wisdom rooted in scripture for everyday life.', interests: ['faith', 'relationship', 'personal'], connections: [] },
    ];
    communityUsers.forEach(cu => {
      if (!existing.find(u => u.id === cu.id)) existing.push(cu);
    });
    DB.set('users', existing);
    const comments = DB.get('comments') || [];
    const seedComments = [
      { id: 'c1', lessonId: 'l1', userId: 'u3', text: 'This hit close to home. Setting internal deadlines saved me last semester.', datePosted: '2025-01-12', anonymous: false, author: 'James T.' },
      { id: 'c2', lessonId: 'l1', userId: 'u2', text: 'Thank you for sharing. Proverbs 1:5 came to mind reading this.', datePosted: '2025-01-13', anonymous: false, author: 'Maria S.' },
      { id: 'c3', lessonId: 'l5', userId: 'u6', text: 'Boundaries are an act of love — for yourself and others. Beautiful lesson.', datePosted: '2025-03-03', anonymous: false, author: 'FaithGuide' },
      { id: 'c4', lessonId: 'l7', userId: 'u4', text: 'Comparison stole years from me too. Tracking my own growth changed everything.', datePosted: '2025-03-25', anonymous: false, author: 'Anika R.' },
    ];
    seedComments.forEach(sc => {
      if (!comments.find(c => c.id === sc.id)) comments.push(sc);
    });
    DB.set('comments', comments);
    DB.set('communitySeeded', true);
  }

  if (!DB.get('userReactionsMigrated')) {
    const helpfulList = DB.get('helpfulList') || [];
    const userReactions = DB.get('userReactions') || {};
    helpfulList.forEach(id => { if (!userReactions[id]) userReactions[id] = 'helpful'; });
    DB.set('userReactions', userReactions);
    DB.set('userReactionsMigrated', true);
  }
  if (!DB.get('userReactions')) DB.set('userReactions', {});

  // Promote flat userReactions into per-user maps (prevents accounts overwriting each other).
  if (!DB.get('userReactionsByUserMigrated')) {
    const flat = DB.get('userReactions') || {};
    const uid = (DB.get('currentUser') || Auth.current() || {}).id;
    const existing = DB.get('userReactionsByUser') || {};
    if (uid && Object.keys(flat).length && !existing[uid]) {
      existing[uid] = { ...flat };
      DB.set('userReactionsByUser', existing);
    } else if (!DB.get('userReactionsByUser')) {
      DB.set('userReactionsByUser', {});
    }
    DB.set('userReactionsByUserMigrated', true);
  }
}

// ── Auth ───────────────────────────────────────────────────
const USE_API = location.protocol.startsWith('http') &&
  !['localhost', '127.0.0.1'].includes(location.hostname);

let _sessionReady = !USE_API;
const AUTH_TOKEN_KEY = 'authToken';

function readStoredValue(key) {
  const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const Auth = {
  _user: null,

  token() {
    let t = null;
    if (window.LVSession) t = LVSession.token();
    if (!t) t = readStoredValue('lv_authToken');
    if (!t) t = this.readCookieToken();
    if (typeof t === 'string') return t;
    if (t != null) return String(t);
    return null;
  },

  setToken(value) {
    if (value) {
      const json = JSON.stringify(value);
      localStorage.setItem('lv_authToken', json);
      sessionStorage.setItem('lv_authToken', json);
    } else {
      localStorage.removeItem('lv_authToken');
      sessionStorage.removeItem('lv_authToken');
    }
  },

  readCookieToken() {
    const match = document.cookie.match(/(?:^|;\s*)lv_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  },

  readUserCookie() {
    const match = document.cookie.match(/(?:^|;\s*)lv_user=([^;]+)/);
    if (!match) return null;
    try {
      return JSON.parse(decodeURIComponent(match[1].trim()));
    } catch {
      return null;
    }
  },

  clearAuth() {
    this._user = null;
    if (window.LVSession) LVSession.clear();
    else {
      this.setToken(null);
      localStorage.removeItem('lv_currentUser');
      localStorage.removeItem('lv_authToken');
      sessionStorage.removeItem('lv_currentUser');
      sessionStorage.removeItem('lv_authToken');
      DB.remove('currentUser');
    }
  },

  restoreFromCache() {
    if (window.LVSession) {
      const s = LVSession.read();
      if (s && s.user) {
        this._user = s.user;
        return true;
      }
    }

    let user = readStoredValue('lv_currentUser');
    let token = readStoredValue('lv_authToken');

    if (!user) user = this.readUserCookie();
    if (!token) token = this.readCookieToken();

    if (token) this.setToken(token);

    if (user && typeof user === 'object') {
      this._user = user;
      return true;
    }

    if (this._user) return true;

    this._user = null;
    return false;
  },

  isLoggedIn() {
    return !!this.current();
  },

  authHeaders(extra = {}) {
    const headers = { ...extra };
    const token = this.token();
    if (token) {
      headers['X-LV-Token'] = token;
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  },

  meUrl() {
    const token = this.token();
    if (!token) return apiUrl('auth/me.php');
    return apiUrl('auth/me.php') + '?token=' + encodeURIComponent(token);
  },

  saveUser(user, token) {
    if (!user) return;
    this._user = user;
    const tok = token || this.token() || null;
    if (window.LVSession) {
      LVSession.write(user, tok);
    } else {
      try {
        const json = JSON.stringify(user);
        localStorage.setItem('lv_currentUser', json);
        sessionStorage.setItem('lv_currentUser', json);
        localStorage.setItem('lv_session', JSON.stringify({ user, token: tok }));
        sessionStorage.setItem('lv_session', JSON.stringify({ user, token: tok }));
        if (tok) this.setToken(tok);
        DB._set('currentUser', user);
      } catch (e) {
        console.error('Could not save login:', e);
      }
    }
  },

  mergeUserAfterSync() {
    const cached = this._user || DB.get('currentUser');
    if (!cached) return;

    const users = DB.get('users') || [];
    const fresh = users.find(u => u.id === cached.id);
    if (fresh) {
      this.saveUser({ ...fresh, connections: fresh.connections || cached.connections || [] }, this.token());
      return;
    }

    users.push(cached);
    DB._set('users', users);
    this.saveUser(cached, this.token());
  },

  current() {
    if (this._user) return this._user;

    if (window.LVSession) {
      const u = LVSession.user();
      if (u) {
        this._user = u;
        return u;
      }
    }

    const stored = readStoredValue('lv_currentUser');
    if (stored && typeof stored === 'object') {
      this._user = stored;
      return stored;
    }

    const fromCookie = this.readUserCookie();
    if (fromCookie) {
      this._user = fromCookie;
      return fromCookie;
    }

    const fromDb = DB.get('currentUser');
    if (fromDb) {
      this._user = fromDb;
      return fromDb;
    }

    return null;
  },

  isAdmin() {
    const user = this.current();
    return !!(user && user.role === 'admin');
  },

  async syncSession() {
    if (!USE_API) return;

    this.restoreFromCache();
    const token = this.token();
    if (!token) return;

    try {
      const res = await apiFetch('auth/me.php');
      const data = await parseApiResponse(res);
      if (res.status === 401 || data.message === 'Authentication required.') {
        this.clearAuth();
        return;
      }
      if (data.ok && data.user) {
        this.saveUser(data.user, token);
      }
    } catch {
      // Keep cached login when server is unreachable.
    }
  },

  async ensureSession() {
    this.restoreFromCache();
    if (this.current()) return true;
    if (!USE_API || !this.token()) return false;
    await this.syncSession();
    return !!this.current();
  },

  _loginLocal(email, password) {
    const users = DB.get('users') || [];
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return false;
    if (user.banned) return 'banned';
    this.saveUser(user);
    return true;
  },

  async login(email, password) {
    if (!USE_API) return this._loginLocal(email, password);

    let res;
    try {
      res = await fetch(apiUrl('auth/login.php'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
      });
    } catch {
      return 'Cannot reach server. Upload the api/ folder to InfinityFree.';
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/authentication required/i.test(text)) {
        return 'API folder is blocked on the server. Remove password protection from api/ and open api/install.php first.';
      }
      return 'Server error. Open api/install.php in your browser first.';
    }

    if (data.ok && data.user) {
      this.saveUser(data.user, data.token || null);
      if (data.token) this.setToken(data.token);
      if (!this.current()) {
        return 'Browser blocked login storage. Try Chrome or Edge.';
      }
      return true;
    }
    if (data.banned) return 'banned';
    if (data.error) return (data.message || 'Login failed') + ': ' + data.error;
    return data.message || 'Invalid email or password.';
  },

  _registerLocal(username, email, password) {
    const users = DB.get('users') || [];
    if (users.find(u => u.email === email)) return { ok: false, msg: 'Email already registered.' };
    const newUser = { id: 'u' + Date.now(), username, email, password, role: 'user', joined: new Date().toISOString().split('T')[0], bio: '', interests: [], connections: [] };
    users.push(newUser);
    DB.set('users', users);
    DB.set('currentUser', newUser);
    return { ok: true };
  },

  async register(username, email, password) {
    if (!USE_API) return this._registerLocal(username, email, password);

    let res;
    try {
      res = await fetch(apiUrl('auth/register.php'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ username, email: email.toLowerCase().trim(), password }),
      });
    } catch {
      return { ok: false, msg: 'Cannot reach server.' };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, msg: 'Server error. Open api/install.php first.' };
    }

    if (data.ok && data.user) {
      this.saveUser(data.user, data.token || null);
      if (data.token) this.setToken(data.token);
      return { ok: true };
    }
    return { ok: false, msg: data.error ? data.message + ': ' + data.error : (data.message || 'Registration failed.') };
  },

  async logout() {
    if (USE_API) {
      try {
        await apiFetch('auth/logout.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: this.token() }),
        });
      } catch { /* ignore */ }
    }
    this.clearAuth();
  }
};

if (USE_API) Auth.restoreFromCache();

// ── Users ──────────────────────────────────────────────────
const Users = {
  all() { return DB.get('users') || []; },
  byId(id) { return this.all().find(u => u.id === id) || null; },
  update(id, data) {
    const users = this.all();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return false;
    users[idx] = { ...users[idx], ...data };
    DB.set('users', users);
    const current = Auth.current();
    if (current && current.id === id) DB.set('currentUser', users[idx]);
    return true;
  },
  delete(id) {
    return Admin.removeUser(id);
  }
};

// ── Connections ────────────────────────────────────────────
const Connections = {
  isConnected(userId) {
    const user = Auth.current();
    if (!user) return false;
    return (user.connections || []).includes(userId);
  },
  connect(targetId) {
    const user = Auth.current();
    if (!user || user.id === targetId) return false;
    const users = Users.all();
    const meIdx = users.findIndex(u => u.id === user.id);
    const themIdx = users.findIndex(u => u.id === targetId);
    if (meIdx === -1 || themIdx === -1) return false;
    if (!users[meIdx].connections) users[meIdx].connections = [];
    if (!users[themIdx].connections) users[themIdx].connections = [];
    const already = users[meIdx].connections.includes(targetId);
    if (!already) users[meIdx].connections.push(targetId);
    if (!users[themIdx].connections.includes(user.id)) users[themIdx].connections.push(user.id);
    DB.set('users', users);
    DB.set('currentUser', users[meIdx]);
    if (!already && typeof Notifications !== 'undefined') {
      Notifications.onConnect(targetId);
    }
    return true;
  },
  disconnect(targetId) {
    const user = Auth.current();
    if (!user) return false;
    const users = Users.all();
    const meIdx = users.findIndex(u => u.id === user.id);
    const themIdx = users.findIndex(u => u.id === targetId);
    if (meIdx === -1) return false;
    users[meIdx].connections = (users[meIdx].connections || []).filter(id => id !== targetId);
    if (themIdx !== -1) users[themIdx].connections = (users[themIdx].connections || []).filter(id => id !== user.id);
    DB.set('users', users);
    DB.set('currentUser', users[meIdx]);
    return true;
  },
  connectedUsers() {
    const user = Auth.current();
    if (!user) return [];
    return (user.connections || []).map(id => Users.byId(id)).filter(Boolean);
  },
  search(query, interest, status) {
    const user = Auth.current();
    let list = Users.all().filter(u => u.role !== 'admin' && !u.banned);
    if (user) list = list.filter(u => u.id !== user.id);
    if (interest && interest !== 'all') list = list.filter(u => (u.interests || []).includes(interest));
    if (status === 'connected' && user) list = list.filter(u => (user.connections || []).includes(u.id));
    else if (status === 'not-connected' && user) list = list.filter(u => !(user.connections || []).includes(u.id));
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(u =>
        u.username.toLowerCase().includes(q) ||
        (u.bio || '').toLowerCase().includes(q) ||
        (u.interests || []).some(i => (CAT_META[i]?.label || i).toLowerCase().includes(q))
      );
    }
    return list;
  }
};

// ── Comments ───────────────────────────────────────────────
const Comments = {
  all(opts = {}) {
    let list = DB.get('comments') || [];
    if (!opts.includeFlagged) list = list.filter(c => !c.status || c.status === 'active');
    if (!opts.includeRemoved) list = list.filter(c => c.status !== 'removed');
    return list;
  },
  byLesson(lessonId) {
    return this.all()
      .filter(c => c.lessonId === lessonId)
      .sort((a, b) => (parseTimestamp(a.datePosted)?.getTime() || 0) - (parseTimestamp(b.datePosted)?.getTime() || 0));
  },
  /** Reference pattern for “X I gave” dashboard stats */
  byUser(userId) {
    return this.all().filter(c => c.userId === userId);
  },
  update(id, data) {
    const all = DB.get('comments') || [];
    const idx = all.findIndex(c => c.id === id);
    if (idx === -1) return false;
    all[idx] = { ...all[idx], ...data };
    DB.set('comments', all);
    return true;
  },
  create(lessonId, text, anonymous) {
    const user = Auth.current();
    if (!user) return { error: 'login' };
    const scan = Moderation.scanComment(text);
    if (scan.action === 'reject') {
      Moderation.log({ type: 'comment', action: 'auto-deleted', text: text.slice(0, 80), reasons: scan.reasons, userId: user.id });
      return { rejected: true, reasons: scan.reasons };
    }
    const comment = {
      id: 'c' + Date.now(),
      lessonId,
      userId: user.id,
      text: text.trim(),
      datePosted: new Date().toISOString().split('T')[0],
      anonymous: !!anonymous,
      author: anonymous ? 'Anonymous' : user.username,
      status: scan.action === 'flag' ? 'flagged' : 'active',
      moderationReason: scan.reasons.join('; ') || ''
    };
    const all = DB.get('comments') || [];
    all.push(comment);
    DB.set('comments', all);
    if (scan.action === 'flag') {
      Moderation.log({ type: 'comment', action: 'flagged', targetId: comment.id, reasons: scan.reasons });
      Notifications.onComment(lessonId, comment);
      return { flagged: true, comment };
    }
    Notifications.onComment(lessonId, comment);
    return { comment };
  },
  delete(id) {
    const user = Auth.current();
    const all = DB.get('comments') || [];
    const comment = all.find(c => c.id === id);
    if (!comment || !user) return false;
    if (comment.userId !== user.id && !Auth.isAdmin()) return false;
    if (Auth.isAdmin()) return Admin.removeComment(id, 'admin');
    DB.set('comments', all.filter(c => c.id !== id));
    return true;
  }
};

// ── Notifications ──────────────────────────────────────────
const Notifications = {
  /*
   * Cross-device delivery relies on polling (SSE is flaky on InfinityFree).
   * Visible tabs poll every 3s; hidden tabs every 10s.
   */
  POLL_MS: 4000,
  POLL_MS_HIDDEN: 12000,
  _pollTimer: null,
  _eventSource: null,
  _reconnectTimer: null,
  _realtimeActive: false,
  _fetchSeq: 0,
  _fetching: false,
  _fetchPending: false,
  _lastServerUnread: null,
  _pollTicks: 0,
  _activeUserId: null,
  _visibilityBound: false,
  _panelOpen: false,
  _boundClose: null,
  _knownIds: new Set(),
  _toastReady: false,

  _debugEnabled() {
    return localStorage.getItem('lv_notif_debug') === '1'
      || /(?:^|[?&])notif_debug=1(?:&|$)/.test(location.search);
  },

  _ensureDebugPanel() {
    if (!this._debugEnabled()) return null;
    let panel = document.getElementById('lv-notif-debug');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'lv-notif-debug';
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = `
      <div class="lv-notif-debug-head">
        <strong>Notification Debug OK ✓</strong>
        <div class="lv-notif-debug-actions">
          <button type="button" data-dbg="copy">Copy</button>
          <button type="button" data-dbg="clear">Clear</button>
          <button type="button" data-dbg="close">Close</button>
        </div>
      </div>
      <pre class="lv-notif-debug-body" id="lv-notif-debug-body">Waiting for notification activity…\n</pre>`;
    document.body.appendChild(panel);

    panel.querySelector('[data-dbg="clear"]').addEventListener('click', () => {
      const body = document.getElementById('lv-notif-debug-body');
      if (body) body.textContent = '';
    });
    panel.querySelector('[data-dbg="close"]').addEventListener('click', () => {
      localStorage.removeItem('lv_notif_debug');
      panel.remove();
    });
    panel.querySelector('[data-dbg="copy"]').addEventListener('click', async () => {
      const body = document.getElementById('lv-notif-debug-body');
      const text = body ? body.textContent : '';
      try {
        await navigator.clipboard.writeText(text);
        if (typeof showToast === 'function') showToast('Debug log copied', 'success');
      } catch {
        /* ignore */
      }
    });

    // Persist debug mode so refresh keeps the panel
    localStorage.setItem('lv_notif_debug', '1');
    return panel;
  },

  _log(step, detail) {
    if (!this._debugEnabled()) return;

    let detailText = '';
    if (detail !== undefined) {
      try {
        detailText = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch {
        detailText = String(detail);
      }
    }

    console.log('[Notifications]', step, detail !== undefined ? detail : '');

    const panel = this._ensureDebugPanel();
    const body = panel && document.getElementById('lv-notif-debug-body');
    if (!body) return;

    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${step}${detailText ? ' ' + detailText : ''}\n`;
    body.textContent = (body.textContent + line).slice(-8000);
    body.scrollTop = body.scrollHeight;
  },

  _currentUserId() {
    const user = Auth.current();
    return user && user.id != null ? String(user.id) : null;
  },

  forUser() {
    const uid = this._currentUserId();
    if (!uid) return [];
    return (DB.get('notifications') || []).filter(n => String(n.recipientUserId) === uid);
  },

  all() {
    return this.forUser().sort((a, b) =>
      (parseTimestamp(b.createdAt)?.getTime() || 0) - (parseTimestamp(a.createdAt)?.getTime() || 0)
    );
  },

  unreadCount() {
    return this.forUser().filter(n => !n.isRead).length;
  },

  _save(list) {
    DB._set('notifications', list);
  },

  _upsertLocal(notif) {
    const all = DB.get('notifications') || [];
    if (notif.type === 'reaction' || notif.type === 'reaction_change') {
      const idx = all.findIndex(n =>
        n.recipientUserId === notif.recipientUserId &&
        n.actorUserId === notif.actorUserId &&
        n.postId === notif.postId &&
        (n.type === 'reaction' || n.type === 'reaction_change')
      );
      if (idx !== -1) {
        all[idx] = { ...all[idx], ...notif, isRead: false, createdAt: new Date().toISOString() };
        this._save(all);
        return all[idx];
      }
    }
    all.unshift(notif);
    this._save(all);
    return notif;
  },

  async _apiCreate(payload) {
    if (!USE_API || !Auth.isLoggedIn()) return null;
    try {
      const res = await apiFetch('notifications/create.php', {
        method: 'POST',
        body: payload,
      });
      const data = await parseApiResponse(res);
      if (!data.ok) {
        console.warn('Notification create rejected:', data.message || data.error || data);
        return null;
      }
      return data.notification || null;
    } catch (err) {
      console.warn('Notification create failed:', err);
      return null;
    }
  },

  async _apiAction(action, id) {
    if (!USE_API || !Auth.isLoggedIn()) return null;
    try {
      const body = { action };
      if (id) body.id = id;
      const res = await apiFetch('notifications/action.php', {
        method: 'POST',
        body,
      });
      return await parseApiResponse(res);
    } catch (err) {
      console.warn('Notification action failed:', err);
      return null;
    }
  },

  _buildReactionMessage(user, type, reactionKey) {
    const name = user.username;
    if (type === 'reaction_change') return `${name} changed their reaction on your post.`;
    return `${name} reacted to your post.`;
  },

  async onReaction(lessonId, result) {
    const user = Auth.current();
    const lesson = Lessons.byId(lessonId, { includeFlagged: true });
    if (!user || !lesson || !result || !result.active) return;
    if (lesson.userId === user.id) return;

    const type = result.previous && result.previous !== result.key ? 'reaction_change' : 'reaction';
    const message = this._buildReactionMessage(user, type, result.key);
    const local = {
      id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
      recipientUserId: lesson.userId,
      actorUserId: user.id,
      actorUsername: user.username,
      postId: lesson.id,
      commentId: null,
      type,
      reactionType: result.key,
      message,
      postTitle: lesson.title,
      isRead: false,
      createdAt: new Date().toISOString(),
    };

    if (USE_API) {
      const remote = await this._apiCreate({
        type,
        postId: lesson.id,
        reactionType: result.key,
      });
      if (remote) this._rememberIds([remote]);
    } else {
      this._upsertLocal(local);
    }
  },

  async onComment(lessonId, comment) {
    const user = Auth.current();
    const lesson = Lessons.byId(lessonId, { includeFlagged: true });
    if (!user || !lesson || !comment) return;
    if (lesson.userId === user.id) return;

    const message = `${user.username} commented on your post.`;
    const local = {
      id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
      recipientUserId: lesson.userId,
      actorUserId: user.id,
      actorUsername: user.username,
      postId: lesson.id,
      commentId: comment.id,
      type: 'comment',
      reactionType: null,
      message,
      postTitle: lesson.title,
      isRead: false,
      createdAt: new Date().toISOString(),
    };

    if (USE_API) {
      this._log('onComment:create', {
        lessonId,
        commentId: comment.id,
        recipientUserId: lesson.userId,
      });
      const remote = await this._apiCreate({
        type: 'comment',
        postId: lesson.id,
        commentId: comment.id,
      });
      // Actor device should not store recipient notifications locally
      if (remote) this._rememberIds([remote]);
    } else {
      this._upsertLocal(local);
    }
  },

  async onConnect(targetUserId) {
    const user = Auth.current();
    if (!user || !targetUserId || String(targetUserId) === String(user.id)) return;

    const message = `${user.username} connected with you.`;
    const local = {
      id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
      recipientUserId: String(targetUserId),
      actorUserId: user.id,
      actorUsername: user.username,
      postId: null,
      commentId: null,
      type: 'connection',
      reactionType: null,
      message,
      postTitle: null,
      isRead: false,
      createdAt: new Date().toISOString(),
    };

    if (USE_API) {
      const remote = await this._apiCreate({
        type: 'connection',
        targetUserId: String(targetUserId),
      });
      if (remote) this._rememberIds([remote]);
    } else {
      this._upsertLocal(local);
    }
  },

  _rememberIds(items) {
    (items || []).forEach(n => {
      if (n && n.id) this._knownIds.add(String(n.id));
    });
  },

  _notifyIncoming(items) {
    if (!this._toastReady || !items || !items.length) return;
    const uid = this._currentUserId();
    if (!uid) return;

    items.forEach(n => {
      if (!n || !n.id) return;
      const id = String(n.id);
      if (this._knownIds.has(id)) return;
      this._knownIds.add(id);
      if (String(n.recipientUserId) !== uid) return;
      if (n.isRead) return;
      if (typeof showToast === 'function') {
        showToast(n.message || 'New notification', 'info');
      }
    });

    if (items.some(n => n && (n.type === 'reaction' || n.type === 'reaction_change'))) {
      this._refreshLessonData();
    }
  },

  _refreshLessonData() {
    if (!USE_API || typeof loadRemoteData !== 'function') return;
    if (this._lessonRefreshTimer) clearTimeout(this._lessonRefreshTimer);
    this._lessonRefreshTimer = setTimeout(() => {
      loadRemoteData().catch(() => {}).then(() => {
        document.dispatchEvent(new CustomEvent('lv:reactions-updated', { detail: { source: 'notifications' } }));
      });
    }, 400);
  },

  _mergeRemote(items, opts = {}) {
    if (!items || !items.length) return;
    const uid = this._currentUserId();
    if (!uid) return;

    this._log('mergeRemote:incoming', items.map(n => ({
      id: n?.id,
      type: n?.type,
      createdAt: n?.createdAt,
    })));

    const incoming = [];
    const all = DB.get('notifications') || [];
    const others = all.filter(n => String(n.recipientUserId) !== uid);
    let mine = all.filter(n => String(n.recipientUserId) === uid);
    const byId = new Map(mine.map(n => [n.id, n]));

    items.forEach(raw => {
      if (!raw || !raw.id) return;
      const notif = {
        ...raw,
        recipientUserId: String(raw.recipientUserId || uid),
        actorUserId: raw.actorUserId != null ? String(raw.actorUserId) : raw.actorUserId,
        isRead: !!(raw.isRead || raw.is_read),
      };
      if (notif.type === 'reaction' || notif.type === 'reaction_change') {
        mine = Array.from(byId.values());
        const existingIdx = mine.findIndex(n =>
          String(n.recipientUserId) === String(notif.recipientUserId) &&
          String(n.actorUserId) === String(notif.actorUserId) &&
          String(n.postId) === String(notif.postId) &&
          (n.type === 'reaction' || n.type === 'reaction_change')
        );
        if (existingIdx !== -1) {
          byId.delete(mine[existingIdx].id);
        }
      }
      const isNew = !this._knownIds.has(String(notif.id)) && !byId.has(notif.id);
      byId.set(notif.id, notif);
      if (isNew) incoming.push(notif);
    });

    this._save([...others, ...Array.from(byId.values())]);
    this._log('mergeRemote:result', this.all().map(n => ({
      id: n.id,
      createdAt: n.createdAt,
      isRead: n.isRead,
    })));

    if (opts.toast !== false) this._notifyIncoming(incoming);
    this.updateBadge();
    if (this._panelOpen) this.renderPanel();
  },

  _applyServerList(items, serverUnreadCount) {
    const uid = this._currentUserId();
    if (!uid) return;

    const normalized = (items || []).map(n => ({
      ...n,
      recipientUserId: String(n.recipientUserId || uid),
      actorUserId: n.actorUserId != null ? String(n.actorUserId) : n.actorUserId,
      isRead: !!(n.isRead || n.is_read),
    }));

    const incoming = normalized.filter(n =>
      n && n.id && !this._knownIds.has(String(n.id)) && !n.isRead
    );

    const others = (DB.get('notifications') || []).filter(n => String(n.recipientUserId) !== uid);
    DB._set('notifications', [...others, ...normalized]);

    const sorted = this.all();
    this._log('applyServerList', {
      count: sorted.length,
      unread: typeof serverUnreadCount === 'number' ? serverUnreadCount : this.unreadCount(),
      items: sorted.map(n => ({ id: n.id, createdAt: n.createdAt, isRead: n.isRead })),
    });

    if (typeof serverUnreadCount === 'number') {
      this._lastServerUnread = serverUnreadCount;
    }

    // First successful load seeds known IDs without toast spam
    if (!this._toastReady) {
      this._rememberIds(normalized);
      this._toastReady = true;
    } else {
      this._notifyIncoming(incoming);
      this._rememberIds(normalized);
    }

    this.updateBadge();
    if (this._panelOpen) this.renderPanel();
  },

  _needsFetch(serverCount) {
    const localCount = this.unreadCount();
    const listLen = this.all().length;
    if (typeof serverCount !== 'number') return listLen === 0;
    return serverCount !== localCount
      || serverCount !== this._lastServerUnread
      || serverCount > localCount
      || (serverCount > 0 && listLen === 0);
  },

  _pollIntervalMs() {
    return document.visibilityState === 'visible' ? this.POLL_MS : this.POLL_MS_HIDDEN;
  },

  restartBackgroundSync() {
    if (!USE_API || !Auth.isLoggedIn() || !this._realtimeActive) return;
    this.stopBackgroundSync();
    this.startBackgroundSync();
  },

  async fetchAll() {
    if (!Auth.isLoggedIn()) return;
    if (!USE_API) {
      this.updateBadge();
      return;
    }
    if (this._fetching) {
      this._fetchPending = true;
      this._log('fetchAll:queued');
      return;
    }

    this._fetching = true;
    const seq = ++this._fetchSeq;
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 10000) : null;

    try {
      this._log('fetchAll:start', { seq });
      const res = await apiFetch('notifications/list.php', controller ? { signal: controller.signal } : {});
      const data = await parseApiResponse(res);

      // Always keep the newest in-flight request; older ones are discarded
      if (seq !== this._fetchSeq) {
        this._log('fetchAll:stale', { seq, current: this._fetchSeq });
        return;
      }

      if (!data.ok) {
        this._log('fetchAll:fail', {
          status: data.status || res.status,
          message: data.message || null,
          error: data.error || null,
          hint: data.hint || null,
        });
        if (typeof this._lastServerUnread === 'number') {
          this.updateBadge(this._lastServerUnread);
        } else if (typeof data.unreadCount === 'number') {
          this.updateBadge(data.unreadCount);
        }
        return;
      }

      const list = Array.isArray(data.notifications) ? data.notifications : [];
      this._log('fetchAll:raw', {
        count: list.length,
        unreadCount: data.unreadCount,
        sample: list.slice(0, 3).map(n => ({
          id: n.id,
          type: n.type,
          recipientUserId: n.recipientUserId,
          message: n.message,
          isRead: n.isRead,
        })),
      });

      this._applyServerList(list, data.unreadCount);
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'Request timed out (10s)' : (err?.message || String(err));
      this._log('fetchAll:error', msg);
      console.warn('Notification fetch failed:', err);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this._fetching = false;
      if (this._fetchPending) {
        this._fetchPending = false;
        setTimeout(() => this.fetchAll(), 400);
      }
    }
  },

  async pollCount() {
    if (!Auth.isLoggedIn()) return;
    if (!USE_API) {
      this.updateBadge();
      return;
    }
    try {
      this._log('pollCount:tick');
      const res = await apiFetch('notifications/count.php');
      const data = await parseApiResponse(res);
      if (!data.ok) {
        this._log('pollCount:fail', {
          status: data.status || res.status,
          message: data.message || null,
          error: data.error || null,
        });
        if (!this._fetching) await this.fetchAll();
        return;
      }

      const serverCount = data.unreadCount;
      this._pollTicks += 1;
      const previousUnread = this._lastServerUnread;
      const increased = typeof serverCount === 'number'
        && serverCount > (previousUnread ?? -1);
      if (typeof serverCount === 'number') {
        // Show badge immediately even before list loads
        this._lastServerUnread = serverCount;
        this.updateBadge(serverCount);
      }
      const needsFetch = increased
        || this._needsFetch(serverCount)
        || (this.all().length === 0 && (serverCount || 0) > 0);

      this._log('pollCount:result', {
        serverCount,
        localCount: this.unreadCount(),
        listLen: this.all().length,
        lastServerUnread: this._lastServerUnread,
        needsFetch,
        fetching: this._fetching,
      });

      if (needsFetch) {
        await this.fetchAll();
      }
    } catch (err) {
      this._log('pollCount:error', err?.message || err);
      try { if (!this._fetching) await this.fetchAll(); } catch { /* ignore */ }
    }
  },

  _streamUrl() {
    const token = Auth.token();
    if (!token) return null;
    const latest = this.all()[0];
    let url = apiUrl('notifications/stream.php');
    url += '?token=' + encodeURIComponent(token);
    if (latest?.createdAt) {
      url += '&since=' + encodeURIComponent(latest.createdAt);
    }
    return url;
  },

  connectStream() {
    if (!USE_API || !Auth.isLoggedIn()) return;
    const url = this._streamUrl();
    if (!url) return;

    this.disconnectStream();
    const es = new EventSource(url, { withCredentials: true });
    this._eventSource = es;

    es.addEventListener('ready', e => {
      try {
        const data = JSON.parse(e.data);
        this._log('sse:ready', data);
        if (typeof data.unreadCount === 'number' && this._needsFetch(data.unreadCount)) {
          this.fetchAll();
        } else {
          this.updateBadge();
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('notification', e => {
      try {
        const notif = JSON.parse(e.data);
        this._log('sse:notification', { id: notif.id, createdAt: notif.createdAt, type: notif.type });
        this._mergeRemote([notif], { toast: true });
      } catch { /* ignore */ }
    });

    es.addEventListener('unread_count', e => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.unreadCount !== 'number') return;
        this._log('sse:unread_count', { server: data.unreadCount, local: this.unreadCount(), listLen: this.all().length });
        const increased = data.unreadCount > (this._lastServerUnread ?? -1);
        if (increased || this._needsFetch(data.unreadCount)) {
          this.fetchAll();
        } else {
          this._lastServerUnread = data.unreadCount;
          this.updateBadge();
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('stream_error', e => {
      try {
        const data = JSON.parse(e.data);
        if (data.message) {
          this.disconnectStream();
          this.startBackgroundSync();
        }
      } catch { /* ignore */ }
    });

    /* FIX — Handle clean 'reconnect' event sent by patched stream.php
     *        when InfinityFree's 25s execution limit is approaching.
     *        We close and reopen the SSE connection after a short delay. */
    es.addEventListener('reconnect', e => {
      try {
        const data = JSON.parse(e.data);
        const delay = (data && typeof data.after === 'number') ? data.after : 800;
        this._log('sse:reconnect', { delay });
        this.disconnectStream();
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => {
          if (Auth.isLoggedIn()) this.connectStream();
        }, delay);
      } catch { /* ignore */ }
    });

    es.onopen = () => {
      this._log('sse:open');
    };

    es.onerror = () => {
      this._log('sse:error');
      this.disconnectStream();
      clearTimeout(this._reconnectTimer);
      /*
       * FIX — Increased from 1500ms to 3000ms. InfinityFree shared hosting
       *        closes SSE connections aggressively; backing off reduces the
       *        chance of being rate-limited or blocked.
       */
      this._reconnectTimer = setTimeout(() => {
        if (Auth.isLoggedIn()) this.connectStream();
      }, 3000);
      this.startBackgroundSync();
    };
  },

  disconnectStream() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
  },

  startBackgroundSync() {
    if (!USE_API || !Auth.isLoggedIn()) return;
    if (this._pollTimer) return;
    const intervalMs = this._pollIntervalMs();
    this._log('backgroundSync:start', { intervalMs });
    this.pollCount();
    this._pollTimer = setInterval(() => this.pollCount(), intervalMs);
  },

  stopBackgroundSync() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      this._log('backgroundSync:stop');
    }
  },

  bindVisibilitySync() {
    if (this._visibilityBound) return;
    this._visibilityBound = true;
    const sync = () => {
      if (!Auth.isLoggedIn() || !USE_API) return;
      this._log('visibilitySync');
      this.fetchAll();
    };
    document.addEventListener('visibilitychange', () => {
      this.restartBackgroundSync();
      if (document.visibilityState === 'visible') sync();
    });
    window.addEventListener('focus', sync);
    window.addEventListener('online', sync);
  },

  startFallbackPolling() {
    this.startBackgroundSync();
  },

  stopFallbackPolling() {
    this.stopBackgroundSync();
  },

  async startRealtime() {
    this._log('startRealtime');
    this.disconnectStream();
    if (!Auth.isLoggedIn()) return;
    this.bindVisibilitySync();
    await this.fetchAll();
    if (USE_API) {
      // Polling is the reliable cross-device path on shared hosting
      this.startBackgroundSync();
      // SSE is best-effort; failures fall back to polling via onerror
      try { this.connectStream(); } catch (err) {
        this._log('sse:connectFailed', err?.message || err);
      }
    } else {
      this.updateBadge();
    }
  },

  async ensureRealtime() {
    this._log('ensureRealtime', { active: this._realtimeActive, loggedIn: Auth.isLoggedIn() });
    if (!Auth.isLoggedIn()) return;
    if (this._realtimeActive) {
      this.updateBadge();
      if (USE_API) {
        if (!this._pollTimer) this.startBackgroundSync();
        // Re-fetch when UI re-renders so a second device catches up immediately
        this.pollCount();
      }
      return;
    }
    this._realtimeActive = true;
    await this.startRealtime();
  },

  stopRealtime() {
    this._log('stopRealtime');
    this.stopBackgroundSync();
    this.disconnectStream();
  },

  startPolling() {
    this.ensureRealtime();
  },

  stopPolling() {
    this._log('stopPolling');
    this.stopRealtime();
    this._realtimeActive = false;
    this._activeUserId = null;
    this._lastServerUnread = null;
    this._pollTicks = 0;
    this._knownIds = new Set();
    this._toastReady = false;
    this.closePanel();
  },

  updateBadge(count) {
    const badge = document.getElementById('notif-badge');
    const n = typeof count === 'number' ? count : this.unreadCount();
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  },

  renderBell() {
    this._log('renderBell');
    const wrap = document.getElementById('nav-notifications');
    if (!wrap) {
      this._log('renderBell: missing #nav-notifications');
      return;
    }
    const user = Auth.current();
    if (!user) {
      wrap.innerHTML = '';
      wrap.classList.add('hidden');
      this.stopPolling();
      return;
    }
    if (this._activeUserId && this._activeUserId !== user.id) {
      this._log('renderBell:userChanged', { from: this._activeUserId, to: user.id });
      this.stopPolling();
    }
    this._activeUserId = user.id;
    wrap.classList.remove('hidden');
    if (!wrap.querySelector('.notif-bell-btn')) {
      this._log('renderBell: creating bell UI');
      wrap.innerHTML = `
        <div class="notif-wrap">
          <button type="button" class="notif-bell-btn" id="notif-bell-btn" aria-label="Notifications">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5-6.71V4a2 2 0 1 0-4 0v.29A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>
            <span class="notif-badge hidden" id="notif-badge">0</span>
          </button>
          <div class="notif-panel hidden" id="notif-panel"></div>
        </div>`;
      wrap.querySelector('#notif-bell-btn').addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        this._log('bell click');
        this.togglePanel();
      });
    }
    this.updateBadge();
    this.ensureRealtime();
    if (this._debugEnabled()) {
      this._ensureDebugPanel();
      this._log('debug:ready', {
        userId: user.id,
        username: user.username,
        useApi: typeof USE_API !== 'undefined' ? USE_API : null,
        host: location.hostname,
        unread: this.unreadCount(),
        listLen: this.all().length,
      });
    }
  },

  _removeDocumentCloseHandler() {
    if (!this._boundClose) return;
    document.removeEventListener('click', this._boundClose);
    this._boundClose = null;
  },

  togglePanel() {
    this._log('togglePanel', { open: this._panelOpen });
    if (this._panelOpen) this.closePanel();
    else this.openPanel();
  },

  async openPanel() {
    this._log('openPanel:start');
    const panel = document.getElementById('notif-panel');
    if (!panel) {
      this._log('openPanel: missing #notif-panel');
      return;
    }
    if (typeof NavAuth !== 'undefined') NavAuth.closeDropdown();
    this._panelOpen = true;
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="notif-empty">Loading notifications…</div>';
    this._removeDocumentCloseHandler();
    requestAnimationFrame(() => {
      if (!this._panelOpen) return;
      this._boundClose = e => {
        const wrap = document.getElementById('nav-notifications');
        if (wrap && !wrap.contains(e.target)) {
          this._log('outside click -> closePanel');
          this.closePanel();
        }
      };
      document.addEventListener('click', this._boundClose);
      this._log('openPanel: outside-click listener attached');
    });
    await this.fetchAll();
    if (!this._panelOpen) return;
    this.renderPanel();
    this._log('openPanel:done', { items: this.all().length, hidden: panel.classList.contains('hidden') });
  },

  closePanel() {
    this._log('closePanel');
    const panel = document.getElementById('notif-panel');
    if (panel) panel.classList.add('hidden');
    this._panelOpen = false;
    this._removeDocumentCloseHandler();
  },

  renderPanel() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    let items;
    try {
      items = this.all();
    } catch (err) {
      console.warn('Notification render failed:', err);
      panel.innerHTML = '<div class="notif-empty">Could not load notifications.</div>';
      return;
    }
    const unread = this.unreadCount();
    const serverUnread = this._lastServerUnread;
    this._log('renderPanel', {
      items: items.length,
      unread,
      order: items.map(n => ({ id: n.id, createdAt: n.createdAt })),
    });
    try {
      let emptyMsg = 'No notifications yet.';
      if (!items.length && typeof serverUnread === 'number' && serverUnread > 0) {
        emptyMsg = `Server has ${serverUnread} unread, but the list failed to load. Upload the latest api/notifications/list.php and refresh.`;
      }
      panel.innerHTML = `
        <div class="notif-panel-head">
          <strong>Notifications</strong>
          <div class="notif-panel-actions">
            ${unread ? `<button type="button" class="notif-action-link" data-action="mark-all">Mark all read</button>` : ''}
            ${items.length ? `<button type="button" class="notif-action-link" data-action="clear-all">Clear all</button>` : ''}
          </div>
        </div>
        <div class="notif-list">
          ${items.length
            ? items.map(n => this._itemHTML(n)).join('')
            : `<div class="notif-empty">${emptyMsg}</div>`}
        </div>`;
    } catch (err) {
      console.warn('Notification panel HTML failed:', err);
      panel.innerHTML = '<div class="notif-empty">Could not display notifications.</div>';
      return;
    }

    panel.querySelectorAll('[data-notif-id]').forEach(el => {
      el.addEventListener('click', () => this.openNotification(el.dataset.notifId));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openNotification(el.dataset.notifId);
        }
      });
    });
    panel.querySelectorAll('.notif-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.deleteNotification(btn.dataset.id);
      });
    });
    const markAll = panel.querySelector('[data-action="mark-all"]');
    if (markAll) markAll.addEventListener('click', e => { e.stopPropagation(); this.markAllRead(); });
    const clearAll = panel.querySelector('[data-action="clear-all"]');
    if (clearAll) clearAll.addEventListener('click', e => { e.stopPropagation(); this.clearAll(); });
  },

  _notifTypeIcon(n) {
    if (n.type === 'comment' || n.type === 'reply') return icon('message-square', 18, 'notif-type-icon');
    if (n.type === 'connection') return icon('user-plus', 18, 'notif-type-icon');
    if (n.type === 'reaction' || n.type === 'reaction_change') {
      const meta = n.reactionType && Reactions.meta(n.reactionType);
      if (meta) return `<span class="notif-reaction-emoji" aria-hidden="true">${meta.emoji}</span>`;
      return icon('heart', 18, 'notif-type-icon');
    }
    return icon('bell', 18, 'notif-type-icon');
  },

  _itemHTML(n) {
    const initials = userInitials(n.actorUsername);
    const preview = n.postTitle ? escHtml(n.postTitle) : '';
    return `<div class="notif-item ${n.isRead ? 'read' : 'unread'}" data-notif-id="${escHtml(n.id)}" role="button" tabindex="0">
      <div class="notif-avatar">${this._notifTypeIcon(n)}</div>
      <div class="notif-body">
        <p class="notif-msg">${escHtml(n.message)}</p>
        ${preview ? `<p class="notif-preview">${preview}</p>` : ''}
        <span class="notif-time">${timeAgo(n.createdAt)}</span>
      </div>
      <button type="button" class="notif-delete-btn" data-id="${escHtml(n.id)}" title="Delete">${icon('x', 16)}</button>
    </div>`;
  },

  async markRead(id) {
    const all = DB.get('notifications') || [];
    const idx = all.findIndex(n => n.id === id);
    if (idx === -1) return;
    all[idx] = { ...all[idx], isRead: true };
    this._save(all);
    if (USE_API) await this._apiAction('mark_read', id);
    this.updateBadge();
    if (this._panelOpen) this.renderPanel();
  },

  async markAllRead() {
    const uid = this._currentUserId();
    if (!uid) return;
    const all = (DB.get('notifications') || []).map(n =>
      String(n.recipientUserId) === uid ? { ...n, isRead: true } : n
    );
    this._save(all);
    if (USE_API) await this._apiAction('mark_all_read');
    this.updateBadge();
    if (this._panelOpen) this.renderPanel();
  },

  async deleteNotification(id) {
    const uid = this._currentUserId();
    const all = (DB.get('notifications') || []).filter(n =>
      !(n.id === id && String(n.recipientUserId) === uid)
    );
    this._save(all);
    if (USE_API) await this._apiAction('delete', id);
    this.updateBadge();
    if (this._panelOpen) this.renderPanel();
  },

  async clearAll() {
    const uid = this._currentUserId();
    if (!uid) return;
    const all = (DB.get('notifications') || []).filter(n => String(n.recipientUserId) !== uid);
    this._save(all);
    if (USE_API) await this._apiAction('clear_all');
    this.updateBadge();
    if (this._panelOpen) this.renderPanel();
  },

  openNotification(id) {
    const n = this.all().find(x => x.id === id);
    if (!n) return;
    this.markRead(id);
    this.closePanel();

    if (n.type === 'connection') {
      window.location.assign(siteUrl('people.html'));
      return;
    }

    if (!n.postId) return;
    const params = new URLSearchParams({ id: String(n.postId) });
    if (n.commentId) params.set('comment', String(n.commentId));
    // Force navigation even when already on the same lesson page
    params.set('_t', String(Date.now()));
    window.location.assign(siteUrl(`lesson.html?${params.toString()}`));
  },
};

// ── Lessons CRUD ───────────────────────────────────────────
const Lessons = {
  all(opts = {}) {
    let list = DB.get('lessons') || [];
    if (!opts.includeFlagged) list = list.filter(l => !l.status || l.status === 'active');
    if (!opts.includeRemoved) list = list.filter(l => l.status !== 'removed');
    return list;
  },
  byId(id, opts = {}) {
    const want = String(id);
    const lesson = (DB.get('lessons') || []).find(l => String(l.id) === want) || null;
    if (!lesson) return null;
    if (lesson.status === 'removed' && !opts.includeRemoved) return null;
    if (lesson.status === 'flagged' && !opts.includeFlagged && !Auth.isAdmin()) {
      const user = Auth.current();
      if (!user || String(user.id) !== String(lesson.userId)) return null;
    }
    return lesson;
  },
  byUser(uid) {
    const want = String(uid);
    return this.all().filter(l => String(l.userId) === want);
  },
  save(lessons) { DB.set('lessons', lessons); },

  create(data) {
    const user = Auth.current();
    if (Auth.isAdmin() && data.skipModeration) {
      return this._saveLesson(user, data, 'active', '');
    }
    const scan = Moderation.scanLesson(data);
    if (scan.action === 'reject') {
      Moderation.log({ type: 'lesson', action: 'auto-deleted', title: data.title, reasons: scan.reasons, userId: user?.id });
      return { rejected: true, reasons: scan.reasons };
    }
    const status = scan.action === 'flag' ? 'flagged' : 'active';
    const reason = scan.reasons.join('; ');
    if (status === 'flagged') {
      Moderation.log({ type: 'lesson', action: 'flagged', title: data.title, reasons: scan.reasons, userId: user?.id });
    }
    return this._saveLesson(user, data, status, reason);
  },

  _saveLesson(user, data, status, moderationReason) {
    const all = DB.get('lessons') || [];
    const lesson = {
      id: 'l' + Date.now(),
      userId: user ? user.id : 'guest',
      title: data.title,
      category: data.category,
      experience: data.experience,
      lessonLearned: data.lessonLearned,
      datePosted: new Date().toISOString().split('T')[0],
      helpful: 0,
      anonymous: data.anonymous || false,
      author: data.anonymous ? 'Anonymous' : (user ? user.username : 'Anonymous'),
      videoUrl: data.videoUrl || '',
      bibleVerses: data.bibleVerses || versesForCategory(data.category),
      adviceVideo: data.adviceVideo || null,
      status,
      moderationReason,
      reactions: data.reactions || Reactions.empty()
    };
    syncLessonReactions(lesson);
    all.unshift(lesson);
    this.save(all);
    return { lesson, flagged: status === 'flagged' };
  },

  update(id, data) {
    const all = DB.get('lessons') || [];
    const want = String(id);
    const idx = all.findIndex(l => String(l.id) === want);
    if (idx === -1) return false;
    const merged = { ...all[idx], ...data };
    if (data.approve) {
      merged.status = 'active';
      merged.moderationReason = '';
    }
    const contentChanged = ['title', 'experience', 'lessonLearned', 'category'].some(k => k in data);
    if (contentChanged && !data.approve && (!Auth.isAdmin() || !data.skipModeration)) {
      const scan = Moderation.scanLesson(merged);
      if (scan.action === 'reject') {
        Moderation.log({ type: 'lesson', action: 'auto-deleted-on-edit', targetId: id, title: merged.title, reasons: scan.reasons });
        Admin.removeLesson(id, 'auto-moderation', scan.reasons.join('; '));
        return { rejected: true, reasons: scan.reasons };
      }
      if (scan.action === 'flag') {
        merged.status = 'flagged';
        merged.moderationReason = scan.reasons.join('; ');
      }
    }
    all[idx] = merged;
    this.save(all);
    return true;
  },

  delete(id) {
    const user = Auth.current();
    const lesson = (DB.get('lessons') || []).find(l => l.id === id);
    if (!lesson) return false;
    if (user && lesson.userId === user.id) {
      Admin.removeLesson(id, 'owner');
      return true;
    }
    if (Auth.isAdmin()) {
      Admin.removeLesson(id, 'admin');
      return true;
    }
    return false;
  },

  react(id, emotionKey) {
    if (!Auth.isLoggedIn()) return null;
    const postId = String(id);
    const lesson = this.byId(postId, { includeFlagged: true }) || this.byId(id, { includeFlagged: true });
    if (!lesson || !Reactions.meta(emotionKey)) return null;

    const userReactions = { ...ReactionStore.mine() };
    const previous = userReactions[postId] || userReactions[id] || null;
    const removing = previous === emotionKey;

    if (removing) {
      delete userReactions[postId];
      delete userReactions[id];
      ReactionStore.setMine(userReactions);
      if (USE_API) {
        const prevHelpful = Math.max(
          Reactions.total(lesson.reactions),
          reactionHelpfulNumber(lesson.helpful)
        );
        const reactions = { ...Reactions.empty(), ...(lesson.reactions || {}) };
        reactions[emotionKey] = Math.max(0, (reactions[emotionKey] || 1) - 1);
        const helpful = Math.max(
          prevHelpful - 1,
          Reactions.total(reactions),
          0
        );
        this.update(postId, { reactions, helpful });
        this._persistReaction(postId, null, true);
      } else {
        ReactionStore.applyToLesson(postId);
      }
      return { active: false, key: emotionKey, previous: emotionKey };
    }

    userReactions[postId] = emotionKey;
    ReactionStore.setMine(userReactions);

    if (USE_API) {
      const prevHelpful = Math.max(
        Reactions.total(lesson.reactions),
        reactionHelpfulNumber(lesson.helpful)
      );
      const reactions = { ...Reactions.empty(), ...(lesson.reactions || {}) };
      if (previous) reactions[previous] = Math.max(0, (reactions[previous] || 1) - 1);
      reactions[emotionKey] = (reactions[emotionKey] || 0) + 1;
      // New reaction bumps total by 1; switching emotion keeps the same total.
      const helpful = previous ? prevHelpful : prevHelpful + 1;
      if (Reactions.total(reactions) < helpful) {
        reactions[emotionKey] = (reactions[emotionKey] || 0) + (helpful - Reactions.total(reactions));
      }
      this.update(postId, { reactions, helpful });
      this._persistReaction(postId, emotionKey, false);
    } else {
      ReactionStore.applyToLesson(postId);
    }

    return { active: true, key: emotionKey, previous, label: Reactions.meta(emotionKey).label };
  },

  /** Immediate server write so lesson.helpful updates for every viewer. */
  async _persistReaction(lessonId, reactionKey, remove) {
    if (!USE_API || !Auth.isLoggedIn()) return;
    try {
      const res = await apiFetch('data/react.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lessonId,
          reactionKey: remove ? null : reactionKey,
          remove: !!remove,
        }),
      });
      const data = await parseApiResponse(res);
      if (!data.ok) {
        console.warn('Reaction persist failed:', data.message || data.error);
        return;
      }
      if (data.updatedLessons) RemoteSync.applyUpdatedLessons(data.updatedLessons);
      else if (data.lesson) RemoteSync.applyUpdatedLessons([data.lesson]);
      updateReactionCountDom(lessonId);
    } catch (err) {
      console.error('Reaction persist error:', err);
    }
  },

  getUserReaction(id) {
    const map = ReactionStore.mine();
    const postId = String(id);
    return map[postId] || map[id] || null;
  },

  markHelpful(id) { return this.react(id, 'helpful'); },
  isHelpful(id) { return this.getUserReaction(id) === 'helpful'; },

  search(query, category, filters = {}) {
    let list = this.all();
    if (category && category !== 'all') list = list.filter(l => l.category === category);
    if (filters.hasVideo) list = list.filter(l => l.videoUrl);
    if (filters.hasVerses) list = list.filter(l => (l.bibleVerses || []).length > 0);
    if (filters.hasAdviceVideo) list = list.filter(l => l.adviceVideo && l.adviceVideo.status === 'ready');
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(l =>
        l.title.toLowerCase().includes(q) ||
        l.lessonLearned.toLowerCase().includes(q) ||
        l.experience.toLowerCase().includes(q) ||
        l.category.toLowerCase().includes(q) ||
        (l.bibleVerses || []).some(v =>
          v.reference.toLowerCase().includes(q) || v.text.toLowerCase().includes(q)
        )
      );
    }
    return list;
  }
};

// ── Admin ──────────────────────────────────────────────────
const Admin = {
  stats() {
    const lessons = Lessons.all({ includeFlagged: true, includeRemoved: true });
    const comments = Comments.all({ includeFlagged: true, includeRemoved: true });
    return {
      totalLessons: lessons.filter(l => l.status !== 'removed').length,
      activeLessons: lessons.filter(l => !l.status || l.status === 'active').length,
      flaggedLessons: lessons.filter(l => l.status === 'flagged').length,
      totalComments: comments.filter(c => c.status !== 'removed').length,
      flaggedComments: comments.filter(c => c.status === 'flagged').length,
      totalUsers: Users.all().filter(u => u.role !== 'admin').length,
      bannedUsers: Users.all().filter(u => u.banned).length,
      logCount: Moderation.logs().length
    };
  },

  removeLesson(id, by, reason) {
    const all = DB.get('lessons') || [];
    const lesson = all.find(l => l.id === id);
    if (!lesson) return false;
    DB.set('lessons', all.filter(l => l.id !== id));
    DB.set('comments', (DB.get('comments') || []).filter(c => c.lessonId !== id));
    Moderation.log({ type: 'lesson', action: 'deleted', targetId: id, title: lesson.title, by, reason: reason || lesson.moderationReason || '' });
    return true;
  },

  removeComment(id, by, reason) {
    const all = DB.get('comments') || [];
    const comment = all.find(c => c.id === id);
    if (!comment) return false;
    DB.set('comments', all.filter(c => c.id !== id));
    Moderation.log({ type: 'comment', action: 'deleted', targetId: id, text: (comment.text || '').slice(0, 80), by, reason: reason || comment.moderationReason || '' });
    return true;
  },

  approveLesson(id) {
    const all = DB.get('lessons') || [];
    const idx = all.findIndex(l => l.id === id);
    if (idx === -1) return false;
    all[idx].status = 'active';
    all[idx].moderationReason = '';
    DB.set('lessons', all);
    Moderation.log({ type: 'lesson', action: 'approved', targetId: id, title: all[idx].title });
    return true;
  },

  approveComment(id) {
    Comments.update(id, { status: 'active', moderationReason: '' });
    Moderation.log({ type: 'comment', action: 'approved', targetId: id });
    return true;
  },

  banUser(id, banned) {
    if (!Auth.isAdmin()) return false;
    const user = Users.byId(id);
    if (!user || user.role === 'admin') return false;
    Users.update(id, { banned: !!banned });
    Moderation.log({ type: 'user', action: banned ? 'banned' : 'unbanned', targetId: id, username: user.username });
    return true;
  },

  setRole(id, role) {
    if (!Auth.isAdmin()) return false;
    const user = Users.byId(id);
    if (!user) return false;
    if (user.role === 'admin' && role !== 'admin') {
      if (Users.all().filter(u => u.role === 'admin').length <= 1) return false;
    }
    Users.update(id, { role });
    Moderation.log({ type: 'user', action: 'role-changed', targetId: id, username: user.username, role });
    return true;
  },

  removeUserContent(userId) {
    if (!Auth.isAdmin()) return false;
    const user = Users.byId(userId);
    if (!user || user.role === 'admin') return false;
    const lessons = (DB.get('lessons') || []).filter(l => l.userId === userId);
    lessons.forEach(l => this.removeLesson(l.id, 'admin-content-purge'));
    const comments = (DB.get('comments') || []).filter(c => c.userId !== userId);
    DB.set('comments', comments);
    Moderation.log({ type: 'user', action: 'content-removed', targetId: userId, username: user.username, reason: `${lessons.length} lessons and related comments removed` });
    return true;
  },

  removeUser(userId) {
    if (!Auth.isAdmin()) return false;
    const user = Users.byId(userId);
    if (!user || user.role === 'admin') return false;
    this.removeUserContent(userId);
    const users = Users.all()
      .filter(u => u.id !== userId)
      .map(u => ({ ...u, connections: (u.connections || []).filter(cid => cid !== userId) }));
    DB.set('users', users);
    const current = Auth.current();
    if (current && current.connections) {
      current.connections = current.connections.filter(cid => cid !== userId);
      DB.set('currentUser', current);
    }
    Moderation.log({ type: 'user', action: 'deleted', targetId: userId, username: user.username, by: 'admin' });
    return true;
  }
};

// ── Toast ──────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon-wrap">${toastIcon(type)}</span><span>${msg}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => { requestAnimationFrame(() => { toast.classList.add('show'); }); });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// ── Modal ──────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('open'); document.body.style.overflow = ''; }
}

// ── Navbar auth / profile dropdown ─────────────────────────
const NavAuth = {
  _dropdownOpen: false,
  _boundClose: null,

  render() {
    const authArea = document.getElementById('nav-auth');
    if (!authArea) return;

    const user = (window.LVSession && LVSession.user()) ||
      (typeof Auth !== 'undefined' ? Auth.current() : null);

    if (user && user.username) {
      const initials = userInitials(user.username);
      const isAdmin = user.role === 'admin' ||
        (typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin());
      authArea.innerHTML = `
        <div class="nav-profile-wrap">
          <button type="button" class="nav-profile-btn" id="nav-profile-btn" aria-haspopup="true" aria-expanded="false">
            <span class="nav-profile-avatar">${escHtml(initials)}</span>
            <span class="nav-profile-label">Hi, <strong>${escHtml(user.username)}</strong></span>
            <svg class="nav-profile-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
          </button>
          <div class="nav-profile-menu hidden" id="nav-profile-menu" role="menu">
            ${isAdmin ? '<a href="admin.html" class="nav-profile-item" role="menuitem">Admin Panel</a>' : ''}
            <a href="dashboard.html#profile" class="nav-profile-item" role="menuitem">Profile</a>
            <a href="dashboard.html" class="nav-profile-item" role="menuitem">Dashboard</a>
            <a href="dashboard.html#profile" class="nav-profile-item" role="menuitem">Settings</a>
            <div class="nav-profile-divider"></div>
            <button type="button" class="nav-profile-item nav-profile-logout" role="menuitem">Logout</button>
          </div>
        </div>`;

      authArea.querySelector('#nav-profile-btn').addEventListener('click', e => {
        e.stopPropagation();
        this.toggleDropdown();
      });
      authArea.querySelector('.nav-profile-logout').addEventListener('click', () => {
        this.closeDropdown();
        handleLogout();
      });
      authArea.querySelectorAll('.nav-profile-item[href]').forEach(link => {
        link.addEventListener('click', () => this.closeDropdown());
      });
    } else {
      authArea.innerHTML = `<a href="login.html" class="nav-login-btn">Log in</a>`;
    }

    if (typeof Notifications !== 'undefined') Notifications.renderBell();
  },

  toggleDropdown() {
    if (this._dropdownOpen) this.closeDropdown();
    else this.openDropdown();
  },

  openDropdown() {
    const menu = document.getElementById('nav-profile-menu');
    const btn = document.getElementById('nav-profile-btn');
    if (!menu) return;
    if (typeof Notifications !== 'undefined') Notifications.closePanel();
    this._dropdownOpen = true;
    menu.classList.remove('hidden');
    if (btn) {
      btn.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
    if (!this._boundClose) {
      this._boundClose = e => {
        const wrap = document.querySelector('.nav-profile-wrap');
        if (wrap && !wrap.contains(e.target)) this.closeDropdown();
      };
      document.addEventListener('click', this._boundClose);
    }
  },

  closeDropdown() {
    const menu = document.getElementById('nav-profile-menu');
    const btn = document.getElementById('nav-profile-btn');
    this._dropdownOpen = false;
    if (menu) menu.classList.add('hidden');
    if (btn) {
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  },
};

// ── Navbar ─────────────────────────────────────────────────
function initNavbar() {
  Auth.restoreFromCache();
  const navMain = document.getElementById('nav-main-links');
  if (!navMain) return;

  // Highlight active page link
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-main-links a, .nav-actions a.nav-share').forEach(a => {
    const href = a.getAttribute('href') || '';
    const linkPage = href.split('/').pop().split('?')[0].split('#')[0];
    a.classList.toggle('active', linkPage === path);
  });

  if (window.LVSession) {
    LVSession.paintNav();
  } else if (typeof NavAuth !== 'undefined') {
    NavAuth.render();
  }

  // Mobile menu toggle
  const hamburger = document.getElementById('nav-hamburger');
  if (hamburger && !hamburger.dataset.bound) {
    hamburger.dataset.bound = '1';
    hamburger.addEventListener('click', e => {
      e.stopPropagation();
      const open = navMain.classList.toggle('open');
      hamburger.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
      hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
  }
  if (navMain && !navMain.dataset.mobileBound) {
    navMain.dataset.mobileBound = '1';
    navMain.addEventListener('click', e => {
      if (!e.target.closest('a')) return;
      navMain.classList.remove('open');
      const btn = document.getElementById('nav-hamburger');
      if (btn) {
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-label', 'Open menu');
      }
    });
    if (!window._navMobileCloseBound) {
      window._navMobileCloseBound = true;
      document.addEventListener('click', e => {
        if (!navMain.classList.contains('open')) return;
        if (navMain.contains(e.target) || (hamburger && hamburger.contains(e.target))) return;
        navMain.classList.remove('open');
        if (hamburger) {
          hamburger.classList.remove('open');
          hamburger.setAttribute('aria-expanded', 'false');
          hamburger.setAttribute('aria-label', 'Open menu');
        }
      });
    }
  }

  initAdminUI();
}

function initAdminUI() {
  if (!Auth.isAdmin()) return;
  document.querySelectorAll('a[href="people.html"]').forEach(el => el.remove());
  document.querySelectorAll('.footer-col a[href="people.html"]').forEach(el => el.remove());
  if (location.pathname.split('/').pop() === 'people.html') {
    window.location.replace('admin.html');
  }
}

function handleLogout() {
  if (typeof Notifications !== 'undefined') Notifications.stopPolling();
  if (typeof NavAuth !== 'undefined') NavAuth.closeDropdown();
  Auth.logout().then(() => {
    if (window.LVSession) LVSession.clear();
    if (window.LVSession) LVSession.paintNav();
    if (typeof Notifications !== 'undefined') Notifications.renderBell();
    showToast('You have been logged out.', 'info');
    setTimeout(() => { window.location.href = siteUrl('login.html'); }, 800);
  });
}

function currentPageName() {
  const page = location.pathname.split('/').pop();
  return page && page.length ? page : 'index.html';
}

function authRedirectTarget() {
  const redirect = new URLSearchParams(location.search).get('redirect');
  if (redirect && !redirect.includes('://') && !redirect.startsWith('//')) {
    return siteUrl(redirect);
  }
  return siteUrl('index.html');
}

function isLoginPage() {
  return document.body.classList.contains('login-page-body') ||
    currentPageName() === 'login.html';
}

function completeAuthSuccess(message) {
  showToast(message, 'success');
  if (isLoginPage()) {
    const user = Auth.current();
    const token = Auth.token();
    if (user) Auth.saveUser(user, token);
    if (!Auth.current()) {
      showToast('Could not save login session. Check browser storage settings.', 'error');
      return;
    }
    Auth.ensureSession().finally(() => {
      window.location.assign(authRedirectTarget());
    });
    return;
  }
  closeModal('auth-modal');
  refreshAuthUI();
}

function requireAuth() {
  if (!_sessionReady) return;

  if (isLoginPage()) {
    if (Auth.isLoggedIn()) window.location.replace(authRedirectTarget());
    return;
  }

  const page = currentPageName();
  if (PUBLIC_PAGES.has(page)) return;

  if (!Auth.isLoggedIn()) {
    const dest = encodeURIComponent(page + location.search + location.hash);
    window.location.replace(siteUrl(`login.html?redirect=${dest}`));
  }
}

// ── Auth Modal ─────────────────────────────────────────────
function initAuthModal() {
  // Tab switching
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.modal-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(target)?.classList.add('active');
    });
  });

  // Close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Login
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = loginForm.querySelector('[name=email]').value.trim();
      const pass  = loginForm.querySelector('[name=password]').value;
      const result = await Auth.login(email, pass);
      if (result === true) {
        completeAuthSuccess('Welcome back!');
      } else if (result === 'banned') {
        showToast('This account has been suspended by an administrator.', 'error');
      } else {
        showToast(result || 'Invalid email or password.', 'error');
      }
    });
  }

  // Register
  const regForm = document.getElementById('register-form');
  if (regForm) {
    regForm.addEventListener('submit', async e => {
      e.preventDefault();
      const username = regForm.querySelector('[name=username]').value.trim();
      const email    = regForm.querySelector('[name=email]').value.trim();
      const pass     = regForm.querySelector('[name=password]').value;
      const confirm  = regForm.querySelector('[name=confirm]').value;
      if (pass !== confirm) { showToast('Passwords do not match.', 'error'); return; }
      if (pass.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
      const result = await Auth.register(username, email, pass);
      if (result.ok) {
        completeAuthSuccess('Account created! Welcome to Lesson Vault.');
      } else {
        showToast(result.msg, 'error');
      }
    });
  }
}

// ── Category helpers ────────────────────────────────────────
const CAT_META = {
  academic:     { label: 'Academic',     iconKey: 'graduation-cap', color: '#2B6CB0', cls: 'cat-academic',     border: 'card-border-academic' },
  career:       { label: 'Career',       iconKey: 'briefcase',      color: '#276749', cls: 'cat-career',       border: 'card-border-career' },
  business:     { label: 'Business',     iconKey: 'building-2',     color: '#B7791F', cls: 'cat-business',     border: 'card-border-business' },
  financial:    { label: 'Financial',    iconKey: 'dollar-sign',    color: '#9B2335', cls: 'cat-financial',    border: 'card-border-financial' },
  relationship: { label: 'Relationship', iconKey: 'heart',          color: '#97266D', cls: 'cat-relationship', border: 'card-border-relationship' },
  technology:   { label: 'Technology',   iconKey: 'laptop',         color: '#434190', cls: 'cat-technology',   border: 'card-border-technology' },
  personal:     { label: 'Personal Growth', iconKey: 'sprout',      color: '#553C9A', cls: 'cat-personal', border: 'card-border-personal' },
  faith:        { label: 'Faith & Spirituality', iconKey: 'cross',   color: '#744210', cls: 'cat-faith', border: 'card-border-faith' },
};
function catMeta(cat) { return CAT_META[cat] || { label: cat, iconKey: 'book-open', color: '#888', cls: '', border: '' }; }
function catBadgeInner(m, size) {
  return `${icon(m.iconKey || 'book-open', size || 14, 'lv-icon icon-inline')} ${escHtml(m.label)}`;
}

// ── Advice Video Generator ─────────────────────────────────
const AdviceVideo = {
  buildSlides(lesson) {
    const verses = lesson.bibleVerses?.length ? lesson.bibleVerses : versesForCategory(lesson.category);
    const slides = [
      { type: 'title', text: lesson.title, sub: 'Words of Wisdom & Guidance' },
      { type: 'verse', ...verses[0] },
      { type: 'advice', text: lesson.lessonLearned, sub: 'The Lesson' },
    ];
    if (verses[1]) slides.push({ type: 'verse', ...verses[1] });
    slides.push({ type: 'closing', text: 'May this lesson guide your path.', sub: 'Lesson Vault' });
    return slides;
  },
  generate(lessonId) {
    const lesson = Lessons.byId(lessonId);
    if (!lesson) return null;
    const slides = this.buildSlides(lesson);
    const adviceVideo = {
      status: 'ready',
      slides,
      generatedAt: new Date().toISOString().split('T')[0],
      duration: slides.length * 5
    };
    Lessons.update(lessonId, { adviceVideo });
    return adviceVideo;
  },
  play(lessonId, containerId) {
    const lesson = Lessons.byId(lessonId);
    if (!lesson) return;
    const slides = lesson.adviceVideo?.slides || this.buildSlides(lesson);
    const container = document.getElementById(containerId);
    if (!container) return;

    let idx = 0;
    let timer = null;
    let speaking = false;

    function renderSlide() {
      const s = slides[idx];
      let inner = '';
      if (s.type === 'title') {
        inner = `<div class="av-slide av-title"><div class="av-icon">${icon('film', 28)}</div><h2>${escHtml(s.text)}</h2><p>${escHtml(s.sub)}</p></div>`;
      } else if (s.type === 'verse') {
        inner = `<div class="av-slide av-verse"><div class="av-icon">${icon('book-open', 28)}</div><blockquote>"${escHtml(s.text)}"</blockquote><cite>— ${escHtml(s.reference)} (${escHtml(s.translation || 'ESV')})</cite></div>`;
      } else if (s.type === 'advice') {
        inner = `<div class="av-slide av-advice"><div class="av-icon">${icon('lightbulb', 28)}</div><h3>${escHtml(s.sub)}</h3><p>${escHtml(s.text)}</p></div>`;
      } else {
        inner = `<div class="av-slide av-closing"><div class="av-icon">${icon('heart', 28)}</div><h2>${escHtml(s.text)}</h2><p>${escHtml(s.sub)}</p></div>`;
      }
      container.querySelector('.av-screen').innerHTML = inner;
      container.querySelector('.av-progress').style.width = ((idx + 1) / slides.length * 100) + '%';
      container.querySelector('.av-counter').textContent = `${idx + 1} / ${slides.length}`;

      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const text = s.type === 'verse' ? s.text : (s.text || '');
        if (text) {
          const utter = new SpeechSynthesisUtterance(text);
          utter.rate = 0.9;
          speaking = true;
          utter.onend = () => { speaking = false; };
          window.speechSynthesis.speak(utter);
        }
      }
    }

    container.innerHTML = `
      <div class="advice-video-player">
        <div class="av-screen"></div>
        <div class="av-controls">
          <div class="av-progress-bar"><div class="av-progress"></div></div>
          <div class="av-controls-row">
            <span class="av-counter">1 / ${slides.length}</span>
            <div class="av-btns">
              <button class="btn btn-sm btn-outline" id="av-prev">${icon('skip-back', 14, 'icon-inline')} Prev</button>
              <button class="btn btn-sm btn-gold" id="av-play">${icon('play', 14, 'icon-inline')} Play</button>
              <button class="btn btn-sm btn-outline" id="av-next">Next ${icon('skip-forward', 14, 'icon-inline')}</button>
              <button class="btn btn-sm" id="av-close" style="background:var(--offwhite)">${icon('x', 14, 'icon-inline')} Close</button>
            </div>
          </div>
        </div>
      </div>`;

    let playing = false;
    renderSlide();

    function next() {
      if (idx < slides.length - 1) { idx++; renderSlide(); }
      else { playing = false; container.querySelector('#av-play').innerHTML = icon('play', 14, 'icon-inline') + ' Replay'; }
    }
    function prev() { if (idx > 0) { idx--; renderSlide(); } }

    container.querySelector('#av-next').addEventListener('click', () => { playing = false; clearInterval(timer); next(); });
    container.querySelector('#av-prev').addEventListener('click', () => { playing = false; clearInterval(timer); prev(); });
    container.querySelector('#av-play').addEventListener('click', () => {
      if (idx >= slides.length - 1 && !playing) { idx = 0; renderSlide(); }
      playing = !playing;
      container.querySelector('#av-play').innerHTML = playing
        ? icon('pause', 14, 'icon-inline') + ' Pause'
        : icon('play', 14, 'icon-inline') + ' Play';
      clearInterval(timer);
      if (playing) timer = setInterval(() => { if (idx < slides.length - 1) next(); else { playing = false; clearInterval(timer); container.querySelector('#av-play').innerHTML = icon('play', 14, 'icon-inline') + ' Replay'; } }, 5000);
    });
    container.querySelector('#av-close').addEventListener('click', () => {
      playing = false; clearInterval(timer);
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      container.innerHTML = '';
      container.classList.add('hidden');
    });
  }
};

function bibleVersesHTML(verses) {
  if (!verses || !verses.length) return '';
  return `<div class="bible-verses-block">
    <h3>${icon('book-open', 18, 'icon-inline')} Scripture for Reflection</h3>
    ${verses.map(v => `
      <div class="bible-verse-card">
        <blockquote>"${escHtml(v.text)}"</blockquote>
        <cite>— ${escHtml(v.reference)} <span class="verse-translation">(${escHtml(v.translation || 'ESV')})</span></cite>
      </div>`).join('')}
  </div>`;
}

function videoEmbedHTML(url) {
  if (!url) return '';
  let embed = url;
  if (url.includes('youtube.com/watch')) embed = url.replace('watch?v=', 'embed/').split('&')[0];
  else if (url.includes('youtu.be/')) embed = 'https://www.youtube.com/embed/' + url.split('youtu.be/')[1].split('?')[0];
  return `<div class="lesson-video-block">
    <h3>${icon('video', 18, 'icon-inline')} Video</h3>
    <div class="video-embed-wrap">
      <iframe src="${escHtml(embed)}" title="Lesson video" allowfullscreen loading="lazy"></iframe>
    </div>
  </div>`;
}

function commentHTML(comment, canDelete) {
  const avatarIcon = comment.anonymous ? icon('lock', 18) : icon('user', 18);
  return `<div class="comment-item" data-id="${comment.id}">
    <div class="comment-avatar">${avatarIcon}</div>
    <div class="comment-body">
      <div class="comment-header">
        <strong>${escHtml(comment.author)}</strong>
        <span class="comment-date">${fmtDate(comment.datePosted)}</span>
        ${comment.status === 'flagged' ? `<span class="mod-badge flagged">${icon('alert-triangle', 12, 'icon-inline')} Flagged</span>` : ''}
        ${canDelete ? `<button class="comment-delete icon-btn" onclick="deleteComment('${comment.id}')" title="Delete">${icon('trash-2', 16)}</button>` : ''}
      </div>
      <p>${escHtml(comment.text)}</p>
    </div>
  </div>`;
}

function contentBadge(iconName, label) {
  return `<span class="content-badge">${icon(iconName, 12, 'icon-inline')}${label ? ' ' + escHtml(label) : ''}</span>`;
}

function peopleCardHTML(person) {
  const connected = Connections.isConnected(person.id);
  const interests = (person.interests || []).map(i => {
    const m = catMeta(i);
    return `<span class="interest-tag ${m.cls}">${catBadgeInner(m, 12)}</span>`;
  }).join('');
  const lessonCount = Lessons.byUser(person.id).length;
  return `<div class="people-card" data-id="${person.id}">
    <div class="people-avatar">${icon('user', 20)}</div>
    <div class="people-info">
      <div class="people-name">${escHtml(person.username)}</div>
      <div class="people-bio">${escHtml(person.bio || 'No bio yet.')}</div>
      <div class="people-interests">${interests || '<span class="text-muted" style="font-size:0.82rem">No interests listed</span>'}</div>
      <div class="people-meta">${lessonCount} lesson${lessonCount !== 1 ? 's' : ''} shared · Joined ${person.joined}</div>
    </div>
    <div class="people-actions">
      <button class="btn btn-sm ${connected ? 'btn-outline' : 'btn-gold'}" onclick="toggleConnection('${person.id}', this)">
        ${connected ? icon('check', 14, 'icon-inline') + ' Connected' : icon('user-plus', 14, 'icon-inline') + ' Connect'}
      </button>
    </div>
  </div>`;
}

// ── Lesson Card HTML ────────────────────────────────────────
function reactionBarHTML(lesson, compact = false) {
  const userReaction = Lessons.getUserReaction(lesson.id);
  const reactions = { ...Reactions.empty(), ...(lesson.reactions || {}) };
  const total = getTotalReactionsForPost(lesson.id);
  const buttons = REACTIONS.map(r => {
    const count = reactions[r.key] || 0;
    if (compact && count === 0 && userReaction !== r.key) return '';
    const active = userReaction === r.key;
    return `<button type="button" class="reaction-btn ${active ? 'active' : ''}" data-key="${r.key}"
      style="--rx-color:${r.color}" title="${r.label}"
      onclick="toggleReaction('${lesson.id}','${r.key}',this)">
      <span class="rx-emoji">${r.emoji}</span>
      ${count > 0 ? `<span class="rx-count">${count}</span>` : ''}
    </button>`;
  }).join('');
  return `<div class="reaction-bar ${compact ? 'compact' : ''}" onclick="event.stopPropagation()">
    ${compact ? '' : `<div class="reaction-bar-label">How does this lesson make you feel?</div>`}
    <div class="reaction-btns">${buttons}</div>
    ${total > 0 ? `<span class="reaction-total">${total} reaction${total !== 1 ? 's' : ''}</span>` : ''}
  </div>`;
}

function lessonCardHTML(lesson) {
  const m = catMeta(lesson.category);
  const excerpt = lesson.lessonLearned.length > 120
    ? lesson.lessonLearned.slice(0, 120) + '…'
    : lesson.lessonLearned;
  const badges = [];
  if (lesson.videoUrl) badges.push(contentBadge('video', 'Video'));
  if ((lesson.bibleVerses || []).length) badges.push(contentBadge('book-open', 'Scripture'));
  if (lesson.adviceVideo?.status === 'ready') badges.push(contentBadge('film', 'Advice'));
  const commentCount = Comments.byLesson(lesson.id).length;
  if (commentCount) badges.push(contentBadge('message-square', String(commentCount)));
  const totalRx = getTotalReactionsForPost(lesson.id);
  if (totalRx) badges.push(contentBadge('heart', String(totalRx)));
  return `
    <div class="lesson-card ${m.border}" data-id="${lesson.id}">
      <div class="card-body">
        <span class="card-cat-badge ${m.cls}">${catBadgeInner(m)}</span>
        ${badges.length ? `<div class="card-badges">${badges.join('')}</div>` : ''}
        <div class="card-title">${escHtml(lesson.title)}</div>
        <div class="card-excerpt">${escHtml(excerpt)}</div>
      </div>
      <div class="card-footer card-footer-reactions">
        <span class="card-meta">${icon('calendar', 12, 'icon-inline')} ${lesson.datePosted} · ${lesson.anonymous ? icon('lock', 12, 'icon-inline') + ' Anonymous' : icon('user', 12, 'icon-inline') + ' ' + escHtml(lesson.author)}</span>
        ${reactionBarHTML(lesson, true)}
      </div>
    </div>`;
}

// ── Toggle Reaction ─────────────────────────────────────────
function refreshReactionBar(bar, lessonId) {
  if (!bar) return;
  const lesson = Lessons.byId(lessonId, { includeFlagged: true });
  const userReaction = Lessons.getUserReaction(lessonId);
  const total = getTotalReactionsForPost(lessonId);
  bar.querySelectorAll('.reaction-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.key === userReaction);
    const k = b.dataset.key;
    const c = (lesson?.reactions || {})[k] || 0;
    let countEl = b.querySelector('.rx-count');
    if (c > 0) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'rx-count';
        b.appendChild(countEl);
      }
      countEl.textContent = c;
    } else if (countEl) countEl.remove();
  });
  let totalEl = bar.querySelector('.reaction-total');
  if (total > 0) {
    if (!totalEl) {
      totalEl = document.createElement('span');
      totalEl.className = 'reaction-total';
      bar.appendChild(totalEl);
    }
    totalEl.textContent = `${total} reaction${total !== 1 ? 's' : ''}`;
  } else if (totalEl) totalEl.remove();
}

function toggleReaction(id, key, btn) {
  if (!Auth.isLoggedIn()) {
    openModal('auth-modal');
    showToast('Please log in to react to lessons.', 'info');
    return;
  }
  const result = Lessons.react(id, key);
  if (!result) return;
  const bar = btn?.closest?.('.reaction-bar') || document.querySelector(`.reaction-bar button[data-key="${key}"]`)?.closest('.reaction-bar');
  refreshReactionBar(bar, id);
  document.querySelectorAll('.reaction-bar').forEach(other => {
    if (other === bar) return;
    const otherBtn = other.querySelector(`.reaction-btn[onclick*="'${id}'"]`);
    if (otherBtn) refreshReactionBar(other, id);
  });
  // Same live-update pattern as #comment-count
  updateReactionCountDom(id);
  const meta = Reactions.meta(key);
  if (result.active) showToast(`${meta.emoji} Marked as ${meta.label}!`, 'success');
  else showToast('Reaction removed.', 'info');
  document.dispatchEvent(new CustomEvent('lv:reactions-updated', {
    detail: { lessonIds: [id], result },
  }));
  if (result.active && typeof Notifications !== 'undefined') {
    // Server react.php already writes the notification when USE_API is on.
    if (!USE_API) Notifications.onReaction(id, result);
  }
}

function toggleHelpful(id, btn) {
  toggleReaction(id, 'helpful', btn);
}

function toggleConnection(userId, btn) {
  const user = Auth.current();
  if (!user) { openModal('auth-modal'); showToast('Please log in to connect with others.', 'info'); return; }
  if (Connections.isConnected(userId)) {
    Connections.disconnect(userId);
    btn.innerHTML = icon('user-plus', 14, 'icon-inline') + ' Connect';
    btn.classList.remove('btn-outline');
    btn.classList.add('btn-gold');
    showToast('Connection removed.', 'info');
  } else {
    Connections.connect(userId);
    btn.innerHTML = icon('check', 14, 'icon-inline') + ' Connected';
    btn.classList.remove('btn-gold');
    btn.classList.add('btn-outline');
    showToast('You are now connected!', 'success');
  }
}

function deleteComment(id) {
  if (Comments.delete(id)) {
    showToast('Comment deleted.', 'info');
    const el = document.querySelector(`.comment-item[data-id="${id}"]`);
    if (el) el.remove();
    const countEl = document.getElementById('comment-count');
    if (countEl) {
      const lessonId = new URLSearchParams(location.search).get('id');
      countEl.textContent = Comments.byLesson(lessonId).length;
    }
  }
}

// ── Escape HTML ─────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Format date ─────────────────────────────────────────────
function parseTimestamp(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && /(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const parsed = parseTimestamp(d);
  if (!parsed) return '';
  return parsed.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function userInitials(name) {
  const parts = String(name || 'U').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name || 'U').slice(0, 2).toUpperCase();
}

function timeAgo(iso) {
  const d = parseTimestamp(iso);
  if (!d) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min !== 1 ? 's' : ''} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? 's' : ''} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'Yesterday';
  if (day < 7) return `${day} days ago`;
  return fmtDate(iso);
}

// ── Char counter ────────────────────────────────────────────
function initCharCounters() {
  document.querySelectorAll('[data-maxlength]').forEach(el => {
    const max = parseInt(el.dataset.maxlength);
    const counter = el.parentElement.querySelector('.char-counter');
    if (!counter) return;
    counter.textContent = `0 / ${max}`;
    el.addEventListener('input', () => {
      const len = el.value.length;
      counter.textContent = `${len} / ${max}`;
      counter.style.color = len > max * 0.9 ? 'var(--danger)' : 'var(--muted)';
    });
  });
}

// ── Init ────────────────────────────────────────────────────
async function loadRemoteData() {
  if (_loadRemotePromise) return _loadRemotePromise;

  _loadingRemote = true;
  _loadRemotePromise = (async () => {
    try {
      const res = await apiFetch('data/sync.php');
      const data = await parseApiResponse(res);
      if (!data.ok) {
        const hint = data.error ? ` (${data.error})` : (data.hint ? ` (${data.hint})` : '');
        throw new Error((data.message || 'Failed to load data') + hint);
      }

      const lessons = (data.lessons || []).map(l => syncLessonReactions({ ...l }));
      DB._set('lessons', lessons);
      DB._set('comments', data.comments || []);
      DB._set('users', data.users || []);

      const mine = data.userReactions || {};
      DB._set('userReactions', mine);
      const uid = Auth.current()?.id != null ? String(Auth.current().id) : null;
      if (uid) {
        const byUser = { ...(DB.get('userReactionsByUser') || {}) };
        byUser[uid] = { ...mine };
        DB._set('userReactionsByUser', byUser);
      }
      DB._set('seeded', true);
    } finally {
      _loadingRemote = false;
      _loadRemotePromise = null;
      document.dispatchEvent(new CustomEvent('lv:data-ready'));
    }
  })();

  return _loadRemotePromise;
}

/** Resolves when lessons/comments are available (after sync on hosted API). */
function whenDataReady(opts = {}) {
  if (!USE_API) return Promise.resolve();
  if (opts.forceRefresh && typeof loadRemoteData === 'function') {
    return loadRemoteData().catch(err => {
      console.warn('Forced data refresh failed:', err);
    });
  }
  if (DB.get('seeded') && !_loadingRemote) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    document.addEventListener('lv:data-ready', finish, { once: true });
    // Fallback if sync already finished between the checks above
    if (DB.get('seeded') && !_loadingRemote) {
      finish();
      return;
    }
    // Don't hang forever if sync fails
    setTimeout(finish, 8000);
  });
}

async function bootApp() {
  Auth.restoreFromCache();

  if (USE_API) {
    await Auth.ensureSession();
  } else {
    seedData();
    migrateData();
    Auth.restoreFromCache();
  }

  _sessionReady = true;
  _authReady = true;
  requireAuth();
  refreshAuthUI();

  if (USE_API) {
    Auth.syncSession().then(() => refreshAuthUI()).catch(console.error);
    loadRemoteData()
      .then(() => { Auth.mergeUserAfterSync(); refreshAuthUI(); })
      .catch(err => {
        console.error(err);
        if (isLoginPage()) showToast('Could not load data. Check api/install.php', 'error');
      });
    RemoteSync.startPullLoop();
  }
}

bootApp();

document.addEventListener('DOMContentLoaded', () => {
  _domReady = true;
  initAuthModal();
  initCharCounters();
  // Show debug box immediately when URL has ?notif_debug=1 (even before login)
  if (typeof Notifications !== 'undefined' && Notifications._debugEnabled()) {
    Notifications._ensureDebugPanel();
    Notifications._log('page:loaded', {
      href: location.href,
      host: location.hostname,
      useApi: typeof USE_API !== 'undefined' ? USE_API : null,
      loggedIn: typeof Auth !== 'undefined' ? Auth.isLoggedIn() : false,
      version: 'notif-debug-v3',
    });
  }
  Auth.ensureSession().then(() => refreshAuthUI()).catch(() => refreshAuthUI());
});
