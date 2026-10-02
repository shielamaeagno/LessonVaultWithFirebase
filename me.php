<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

try {
    $pdo = db();
    $user = current_auth_user($pdo);

    json_response([
        'ok'   => true,
        'user' => $user,
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'user'    => null,
        'message' => 'Auth check failed.',
        'error'   => $e->getMessage(),
    ], 500);
}
