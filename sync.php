<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

try {
    $pdo = db();
    $authUser = current_auth_user($pdo);

    $lessons = $pdo->query(
        "SELECT id, user_id AS userId, title, category, experience,
                lesson_learned AS lessonLearned, date_posted AS datePosted,
                helpful, anonymous, author, video_url AS videoUrl,
                reactions_json AS reactionsJson, advice_video_json AS adviceVideoJson,
                status, moderation_reason AS moderationReason
         FROM lessons
         WHERE status != 'removed'
         ORDER BY date_posted DESC"
    )->fetchAll();

    // Source of truth when reaction rows exist.
    $totalsByLesson = load_reaction_totals_by_lesson($pdo);

    $verseStmt = $pdo->prepare(
        'SELECT reference, text, translation
         FROM lesson_bible_verses
         WHERE lesson_id = ?
         ORDER BY sort_order, id'
    );

    foreach ($lessons as &$lesson) {
        $lesson['anonymous'] = (bool) $lesson['anonymous'];
        $lessonId = (string) $lesson['id'];
        $decoded = json_decode($lesson['reactionsJson'] ?: '{}', true);
        if (!is_array($decoded)) {
            $decoded = [];
        }
        unset($lesson['reactionsJson']);

        if (isset($totalsByLesson[$lessonId])) {
            $lesson['reactions'] = $totalsByLesson[$lessonId]['reactions'];
            $lesson['helpful'] = (int) $totalsByLesson[$lessonId]['helpful'];
        } else {
            // No rows in user_lesson_reactions for this lesson — keep stored columns
            // (covers demo seed counts and posts that have never received a reaction).
            $lesson['reactions'] = array_merge(empty_reactions_map(), $decoded);
            $mapTotal = 0;
            foreach ($lesson['reactions'] as $n) {
                $mapTotal += (int) $n;
            }
            $stored = (int) ($lesson['helpful'] ?? 0);
            $lesson['helpful'] = max($mapTotal, $stored);
            if ($mapTotal < $lesson['helpful']) {
                $lesson['reactions'] = empty_reactions_map();
                $lesson['reactions']['helpful'] = $lesson['helpful'];
            }
        }

        $lesson['adviceVideo'] = $lesson['adviceVideoJson']
            ? json_decode($lesson['adviceVideoJson'], true)
            : null;
        unset($lesson['adviceVideoJson']);

        $verseStmt->execute([$lesson['id']]);
        $lesson['bibleVerses'] = $verseStmt->fetchAll() ?: [];
    }
    unset($lesson);

    $comments = $pdo->query(
        "SELECT id, lesson_id AS lessonId, user_id AS userId, text,
                date_posted AS datePosted, anonymous, author,
                status, moderation_reason AS moderationReason
         FROM comments
         WHERE status != 'removed'
         ORDER BY date_posted ASC"
    )->fetchAll();

    foreach ($comments as &$comment) {
        $comment['anonymous'] = (bool) $comment['anonymous'];
    }
    unset($comment);

    $users = $pdo->query(
        "SELECT id, username, email, role, bio, joined, banned
         FROM users
         ORDER BY joined ASC"
    )->fetchAll();

    foreach ($users as &$user) {
        $user['banned'] = (bool) $user['banned'];
        $user['bio'] = $user['bio'] ?? '';
        $user['interests'] = load_user_interests($pdo, $user['id']);
        $user['connections'] = load_user_connections($pdo, $user['id']);
        $user['password'] = '';
    }
    unset($user);

    $userReactions = [];
    if ($authUser) {
        $rxStmt = $pdo->prepare(
            'SELECT lesson_id, reaction_key FROM user_lesson_reactions WHERE user_id = ?'
        );
        $rxStmt->execute([$authUser['id']]);
        foreach ($rxStmt->fetchAll() ?: [] as $row) {
            $userReactions[(string) $row['lesson_id']] = (string) $row['reaction_key'];
        }
    }

    json_response([
        'ok'            => true,
        'lessons'       => $lessons,
        'comments'      => $comments,
        'users'         => $users,
        'userReactions' => $userReactions,
    ]);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Failed to load site data.',
        'error'   => $e->getMessage(),
        'hint'    => db_error_hint($e->getMessage()),
    ], 500);
}
