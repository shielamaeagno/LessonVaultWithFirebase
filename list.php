<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

try {
    $pdo = db();
    $user = require_auth_user($pdo);
    $userId = (string) $user['id'];

    try {
        $notifications = load_notifications_for_user($pdo, $userId);
    } catch (Throwable $loadError) {
        // Fallback: load without JOIN if the main query fails
        $stmt = $pdo->prepare(
            'SELECT * FROM notifications
             WHERE recipient_user_id = ?
             ORDER BY created_at DESC
             LIMIT 50'
        );
        $stmt->execute([$userId]);
        $rows = $stmt->fetchAll() ?: [];
        $notifications = [];
        foreach ($rows as $row) {
            try {
                if (empty($row['actor_username'])) {
                    $row['actor_username'] = 'Someone';
                }
                $notifications[] = notification_to_public($row);
            } catch (Throwable $mapError) {
                // Skip broken rows instead of failing the whole list
                continue;
            }
        }
    }

    json_response([
        'ok'            => true,
        'notifications' => $notifications,
        'unreadCount'   => unread_notification_count($pdo, $userId),
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Could not load notifications.',
        'error'   => $e->getMessage(),
        'hint'    => function_exists('db_error_hint') ? db_error_hint($e->getMessage()) : '',
    ], 500);
}
