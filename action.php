<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

try {
    $pdo = db();
    $user = require_auth_user($pdo);
    $body = read_json_body();
    $userId = (string) $user['id'];
    $action = trim((string) ($body['action'] ?? ''));

    switch ($action) {
        case 'mark_read':
            $id = trim((string) ($body['id'] ?? ''));
            if ($id === '') {
                json_response(['ok' => false, 'message' => 'Notification id required.'], 400);
            }
            if (!assert_notification_owner($pdo, $id, $userId)) {
                json_response(['ok' => false, 'message' => 'Notification not found.'], 404);
            }
            $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_user_id = ?')
                ->execute([$id, $userId]);
            break;

        case 'mark_all_read':
            $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE recipient_user_id = ? AND is_read = 0')
                ->execute([$userId]);
            break;

        case 'delete':
            $id = trim((string) ($body['id'] ?? ''));
            if ($id === '') {
                json_response(['ok' => false, 'message' => 'Notification id required.'], 400);
            }
            if (!assert_notification_owner($pdo, $id, $userId)) {
                json_response(['ok' => false, 'message' => 'Notification not found.'], 404);
            }
            $pdo->prepare('DELETE FROM notifications WHERE id = ? AND recipient_user_id = ?')
                ->execute([$id, $userId]);
            break;

        case 'clear_all':
            $pdo->prepare('DELETE FROM notifications WHERE recipient_user_id = ?')
                ->execute([$userId]);
            break;

        default:
            json_response(['ok' => false, 'message' => 'Unknown action.'], 400);
    }

    json_response([
        'ok'          => true,
        'unreadCount' => unread_notification_count($pdo, $userId),
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Notification action failed.',
        'error'   => $e->getMessage(),
    ], 500);
}
