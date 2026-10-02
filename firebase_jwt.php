<?php
declare(strict_types=1);

/**
 * Lesson Vault — Firebase custom token helper (NEW, standalone).
 * Pure functions only: no database, no session, no side effects.
 * Signs a Firebase "custom token" (RS256 JWT) with a Google service account key
 * so a user already logged in via PHP/MySQL can be recognised by Firebase.
 */

function fb_b64url(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function fb_normalize_private_key(string $key): string
{
    // Allow the key to be pasted with literal "\n" sequences.
    return str_replace('\\n', "\n", trim($key));
}

/**
 * @param array<string,mixed> $claims extra developer claims (kept small)
 * @throws RuntimeException when the key is invalid or signing fails
 */
function fb_create_custom_token(
    string $serviceAccountEmail,
    string $privateKeyPem,
    string $uid,
    array $claims = [],
    int $ttlSeconds = 3600,
    ?int $now = null
): string {
    if ($uid === '' || strlen($uid) > 128) {
        throw new RuntimeException('Invalid uid for Firebase token.');
    }
    if (!function_exists('openssl_sign')) {
        throw new RuntimeException('PHP OpenSSL extension is not available on this host.');
    }

    $now = $now ?? time();
    $ttlSeconds = max(60, min(3600, $ttlSeconds));

    $header  = ['alg' => 'RS256', 'typ' => 'JWT'];
    $payload = [
        'iss'    => $serviceAccountEmail,
        'sub'    => $serviceAccountEmail,
        'aud'    => 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
        'iat'    => $now,
        'exp'    => $now + $ttlSeconds,
        'uid'    => $uid,
        'claims' => (object) $claims,
    ];

    $signingInput = fb_b64url(json_encode($header)) . '.' . fb_b64url(json_encode($payload));

    $pkey = @openssl_pkey_get_private(fb_normalize_private_key($privateKeyPem));
    if ($pkey === false) {
        throw new RuntimeException('Firebase private key could not be read. Check api/firebase_config.php.');
    }

    $signature = '';
    if (!openssl_sign($signingInput, $signature, $pkey, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('Could not sign Firebase token.');
    }

    return $signingInput . '.' . fb_b64url($signature);
}
