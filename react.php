<?php
declare(strict_types=1);

/**
 * Immediate reaction write path.
 * Updates user_lesson_reactions, recomputes lessons.helpful / reactions_json,
 * and returns the authoritative totals for the client.
 */
require_once __DIR__ . '/../bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'message' => 'POST required.'], 405);
}

try {
    $pdo = db();
    $authUser = require_auth_user($pdo);
    $body = read_json_body();

    $lessonId = trim((string) ($body['lessonId'] ?? $body['postId'] ?? ''));
    $reactionKey = array_key_exists('reactionKey', $body)
        ? $body['reactionKey']
        : ($body['reactionType'] ?? null);
    if (is_string($reactionKey)) {
        $reactionKey = trim($reactionKey);
    } else {
        $reactionKey = null;
    }
    if ($reactionKey === '') {
        $reactionKey = null;
    }

    // Toggle-off: client sends the same key they already have with remove=true
    $remove = !empty($body['remove']) || !empty($body['clear']);
    if ($remove) {
        $reactionKey = null;
    }

    if ($lessonId === '') {
        json_response(['ok' => false, 'message' => 'lessonId required.'], 400);
    }

    $lesson = load_lesson_row($pdo, $lessonId);
    if (!$lesson) {
        json_response(['ok' => false, 'message' => 'Lesson not found.'], 404);
    }

    if ($reactionKey !== null) {
        $allowed = reaction_keys();
        if (!in_array($reactionKey, $allowed, true)) {
            json_response(['ok' => false, 'message' => 'Invalid reaction type.'], 400);
        }
    }

    $result = set_user_lesson_reaction(
        $pdo,
        (string) $authUser['id'],
        $lessonId,
        $reactionKey,
        $authUser
    );

    if (!$result['lesson']) {
        json_response([
            'ok'      => false,
            'message' => 'Could not update reaction totals.',
        ], 500);
    }

    json_response([
        'ok'           => true,
        'active'       => $result['active'],
        'key'          => $result['key'],
        'previous'     => $result['previous'],
        'lesson'       => $result['lesson'],
        'updatedLessons' => [$result['lesson']],
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Reaction save failed.',
        'error'   => $e->getMessage(),
    ], 500);
}
