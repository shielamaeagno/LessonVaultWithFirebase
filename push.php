<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'message' => 'POST required.'], 405);
}

try {
    $pdo = db();
    $authUser = require_auth_user($pdo);
    $data = read_json_body();

    foreach (($data['users'] ?? []) as $userRow) {
        if (!is_array($userRow) || empty($userRow['id'])) {
            continue;
        }
        save_user_profile($pdo, $authUser, $userRow);
    }

    foreach (($data['lessons'] ?? []) as $lesson) {
        if (is_array($lesson) && !empty($lesson['id'])) {
            upsert_lesson($pdo, $authUser, $lesson);
        }
    }

    foreach (($data['comments'] ?? []) as $comment) {
        if (is_array($comment) && !empty($comment['id'])) {
            upsert_comment($pdo, $authUser, $comment);
        }
    }

    $updatedLessons = [];
    if (isset($data['userReactions']) && is_array($data['userReactions'])) {
        $updatedLessons = save_user_reactions($pdo, $authUser['id'], $data['userReactions'], $authUser);
    }

    $row = load_user_by_id($pdo, $authUser['id']);

    json_response([
        'ok'             => true,
        'message'        => 'Data saved.',
        'user'           => $row ? hydrate_user($pdo, $row) : $authUser,
        'updatedLessons' => $updatedLessons,
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Save failed.',
        'error'   => $e->getMessage(),
    ], 500);
}
