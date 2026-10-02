<?php
declare(strict_types=1);

/**
 * POST api/firebase/token.php
 * Exchanges a valid Lesson Vault login (existing PHP/MySQL auth) for a Firebase
 * custom token, so Firestore security rules can identify the same user.
 *
 * Read-only with respect to the MySQL database — it only reuses the existing
 * require_auth_user() check. It does not change any existing endpoint.
 */
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/firebase_jwt.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'message' => 'POST required.'], 405);
}

$configFile = __DIR__ . '/../firebase_config.php';
if (!is_file($configFile)) {
    json_response([
        'ok'      => false,
        'code'    => 'not_configured',
        'message' => 'Firebase is not configured on the server yet (api/firebase_config.php missing).',
    ], 503);
}
require_once $configFile;

if (!defined('FIREBASE_SA_EMAIL') || !defined('FIREBASE_SA_PRIVATE_KEY')
    || strpos((string) FIREBASE_SA_PRIVATE_KEY, 'PASTE_KEY_HERE') !== false) {
    json_response([
        'ok'      => false,
        'code'    => 'not_configured',
        'message' => 'Firebase service-account values are not filled in.',
    ], 503);
}

try {
    $pdo  = db();
    $user = require_auth_user($pdo); // 401 if not logged in or banned

    $token = fb_create_custom_token(
        (string) FIREBASE_SA_EMAIL,
        (string) FIREBASE_SA_PRIVATE_KEY,
        (string) $user['id'],
        ['role' => (string) $user['role'], 'name' => (string) $user['username']]
    );

    json_response([
        'ok'       => true,
        'token'    => $token,
        'uid'      => (string) $user['id'],
        'username' => (string) $user['username'],
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'code'    => 'token_failed',
        'message' => 'Could not create Firebase token.',
        'error'   => $e->getMessage(),
    ], 500);
}
