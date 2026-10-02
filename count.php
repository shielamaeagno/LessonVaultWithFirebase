<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

try {
    $pdo = db();
    $user = require_auth_user($pdo);

    json_response([
        'ok'          => true,
        'unreadCount' => unread_notification_count($pdo, (string) $user['id']),
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Could not load notification count.',
        'error'   => $e->getMessage(),
    ], 500);
}
