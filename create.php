<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

try {
    $pdo = db();
    $actor = require_auth_user($pdo);
    $body = read_json_body();

    $type = trim((string) ($body['type'] ?? ''));
    $postId = trim((string) ($body['postId'] ?? ''));
    $commentId = trim((string) ($body['commentId'] ?? '')) ?: null;
    $reactionType = trim((string) ($body['reactionType'] ?? '')) ?: null;
    $targetUserId = trim((string) ($body['targetUserId'] ?? '')) ?: null;

    $allowed = ['reaction', 'reaction_change', 'comment', 'reply', 'connection'];
    if (!in_array($type, $allowed, true)) {
        json_response(['ok' => false, 'message' => 'Invalid notification payload.'], 400);
    }

    $notification = null;

    if ($type === 'connection') {
        if (!$targetUserId) {
            json_response(['ok' => false, 'message' => 'Target user required.'], 400);
        }
        $notification = create_connection_notification($pdo, $actor, $targetUserId);
        json_response([
            'ok'           => true,
            'notification' => $notification,
            'skipped'      => $notification === null,
        ]);
    }

    if ($postId === '') {
        json_response(['ok' => false, 'message' => 'Invalid notification payload.'], 400);
    }

    $lesson = load_lesson_row($pdo, $postId);
    if (!$lesson) {
        json_response(['ok' => false, 'message' => 'Post not found.'], 404);
    }

    if ((string) $lesson['user_id'] === (string) $actor['id']) {
        json_response(['ok' => true, 'skipped' => true, 'notification' => null]);
    }

    if (in_array($type, ['reaction', 'reaction_change'], true)) {
        if (!$reactionType) {
            json_response(['ok' => false, 'message' => 'Reaction type required.'], 400);
        }
        $notification = upsert_reaction_notification($pdo, $actor, $lesson, $type, $reactionType);
    } else {
        $notification = create_comment_notification($pdo, $actor, $lesson, $commentId, $type);
    }

    json_response([
        'ok'           => true,
        'notification' => $notification,
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Could not create notification.',
        'error'   => $e->getMessage(),
    ], 500);
}
