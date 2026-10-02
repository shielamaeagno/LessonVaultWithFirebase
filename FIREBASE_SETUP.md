# Firebase Setup — Reflection Journal

The journal is the ONLY part of Lesson Vault that uses Firebase. MySQL/phpMyAdmin is unchanged.

1. **Firebase Console** → Add project → Build → **Firestore Database** → Create (production mode).
2. **Project settings → General → Your apps → Web (</>)** → copy `firebaseConfig` into `js/firebase-config.js`.
3. **Firestore → Rules** → paste contents of `firestore.rules` → Publish.
4. **Project settings → Service accounts → Generate new private key.** Copy `api/firebase_config.sample.php` to `api/firebase_config.php`, then paste `client_email` and `private_key`.
5. Upload everything to your host (InfinityFree). Needs PHP OpenSSL (enabled by default).
6. Log in (`test@lessonvault.com / password123`) → open `journal.html`.

Notes
- Do not commit/share `api/firebase_config.php` (private key). Web config in step 2 is public by design.
- If the browser console shows a Firestore index link, click it once (only needed if you later combine filters with orderBy).
- Firebase Authentication does not need to be enabled for sign-in providers; custom tokens work by default.
