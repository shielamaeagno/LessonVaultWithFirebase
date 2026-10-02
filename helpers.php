<?php
declare(strict_types=1);

function json_response(array $data, int $status = 200): void
{
    if (ob_get_length()) {
        ob_clean();
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    header('Pragma: no-cache');
    $flags = JSON_UNESCAPED_UNICODE;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
        $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    $json = json_encode($data, $flags);
    if ($json === false) {
        $json = '{"ok":false,"message":"JSON encode failed.","error":' . json_encode(json_last_error_msg()) . '}';
    }
    echo $json;
    exit;
}

function read_json_body(): array
{
    static $cached = null;

    if ($cached !== null) {
        return $cached;
    }

    $raw = file_get_contents('php://input');
    if (!$raw) {
        $cached = [];
        return $cached;
    }

    $data = json_decode($raw, true);
    $cached = is_array($data) ? $data : [];
    return $cached;
}

function app_timezone(): DateTimeZone
{
    return new DateTimeZone('UTC');
}

function utc_now(): string
{
    return (new DateTime('now', app_timezone()))->format('Y-m-d H:i:s');
}

function datetime_to_iso8601(?string $datetime): ?string
{
    if ($datetime === null || trim($datetime) === '') {
        return null;
    }

    $dt = DateTime::createFromFormat('Y-m-d H:i:s', $datetime, app_timezone());
    if (!$dt) {
        $dt = DateTime::createFromFormat('Y-m-d H:i:s.u', $datetime, app_timezone());
    }
    if (!$dt) {
        try {
            $dt = new DateTime($datetime, app_timezone());
        } catch (Throwable $e) {
            return null;
        }
    }

    return $dt->setTimezone(app_timezone())->format('Y-m-d\TH:i:s') . '.000Z';
}

function iso8601_to_datetime(?string $iso): string
{
    if ($iso === null || trim($iso) === '') {
        return utc_now();
    }

    try {
        $dt = new DateTime(trim($iso));
        $dt->setTimezone(app_timezone());

        return $dt->format('Y-m-d H:i:s');
    } catch (Throwable $e) {
        return utc_now();
    }
}

function auth_cookie_path(): string
{
    /*
     * FIX — Always use '/' so the auth cookie is readable by ALL pages
     *        (index.html, dashboard.html, etc.) regardless of subdirectory.
     *        Using the script path was causing the cookie to be scoped to
     *        /api/ only, making it invisible to the front-end JS on other pages.
     */
    return '/';
}

function auth_secret(): string
{
    return hash('sha256', DB_PASS . DB_NAME . DB_USER . 'lessonvault');
}

function public_user(array $row): array
{
    return [
        'id'          => $row['id'],
        'username'    => $row['username'],
        'email'       => $row['email'],
        'role'        => $row['role'],
        'bio'         => $row['bio'] ?? '',
        'joined'      => $row['joined'],
        'banned'      => (bool) ($row['banned'] ?? false),
        'interests'   => [],
        'connections' => [],
    ];
}

function load_user_by_id(PDO $pdo, string $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function load_user_interests(PDO $pdo, string $userId): array
{
    try {
        $stmt = $pdo->prepare('SELECT interest FROM user_interests WHERE user_id = ? ORDER BY interest');
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
    } catch (Throwable $e) {
        return [];
    }
}

function load_user_connections(PDO $pdo, string $userId): array
{
    try {
        $stmt = $pdo->prepare('SELECT connected_user_id FROM user_connections WHERE user_id = ?');
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
    } catch (Throwable $e) {
        return [];
    }
}

function hydrate_user(PDO $pdo, array $row): array
{
    $user = public_user($row);
    $user['interests'] = load_user_interests($pdo, $row['id']);
    $user['connections'] = load_user_connections($pdo, $row['id']);
    return $user;
}

function verify_password(string $plain, string $stored): bool
{
    $stored = trim($stored);
    if ($stored === '') {
        return false;
    }

    $info = password_get_info($stored);
    if (!empty($info['algo'])) {
        return password_verify($plain, $stored);
    }

    return hash_equals($stored, $plain);
}

function auth_token_from_request(): ?string
{
    if (!empty($_GET['token'])) {
        return trim((string) $_GET['token']);
    }

    if (!empty($_COOKIE['lv_token'])) {
        return trim((string) $_COOKIE['lv_token']);
    }

    if (!empty($_SERVER['HTTP_X_LV_TOKEN'])) {
        return trim((string) $_SERVER['HTTP_X_LV_TOKEN']);
    }

    if (!empty($_SERVER['HTTP_AUTHORIZATION'])
        && preg_match('/Bearer\s+(\S+)/i', (string) $_SERVER['HTTP_AUTHORIZATION'], $matches)) {
        return trim($matches[1]);
    }

    $body = read_json_body();
    if (!empty($body['token'])) {
        return trim((string) $body['token']);
    }

    return null;
}

function create_auth_token(string $userId): string
{
    $exp = (string) (time() + 60 * 60 * 24 * 30);
    $sig = hash_hmac('sha256', $userId . '|' . $exp, auth_secret());
    return rtrim(strtr(base64_encode($userId . '|' . $exp . '|' . $sig), '+/', '-_'), '=');
}

function parse_auth_token(string $token): ?array
{
    $token = trim($token);
    if ($token === '') {
        return null;
    }

    $decoded = base64_decode(strtr($token, '-_', '+/'), true);
    if ($decoded === false) {
        return null;
    }

    $parts = explode('|', $decoded, 3);
    if (count($parts) !== 3) {
        return null;
    }

    [$userId, $exp, $sig] = $parts;
    if ($userId === '' || !ctype_digit($exp) || (int) $exp < time()) {
        return null;
    }

    $expected = hash_hmac('sha256', $userId . '|' . $exp, auth_secret());
    if (!hash_equals($expected, $sig)) {
        return null;
    }

    return ['user_id' => $userId, 'exp' => (int) $exp];
}

function set_auth_cookie(string $token): void
{
    /*
     * FIX — Detect HTTPS correctly including InfinityFree proxy headers.
     *        When NOT on HTTPS (free subdomain without SSL): Secure=false,
     *        SameSite=Lax. This lets the cookie work on HTTP InfinityFree sites.
     *        When on HTTPS: Secure=true, SameSite=None so EventSource (SSE)
     *        from a mobile browser on a different tab still sends the cookie.
     *        Path is always '/' (see auth_cookie_path fix above).
     */
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https')
        || (!empty($_SERVER['HTTP_X_FORWARDED_SSL'])   && $_SERVER['HTTP_X_FORWARDED_SSL']   === 'on');

    setcookie('lv_token', $token, [
        'expires'  => time() + 60 * 60 * 24 * 30,
        'path'     => '/',
        'secure'   => $secure,
        'httponly' => false,
        'samesite' => $secure ? 'None' : 'Lax',
    ]);
}

function clear_auth_cookie(): void
{
    $path = '/'; /* FIX — always root path to match set_auth_cookie */
    setcookie('lv_token', '', [
        'expires'  => time() - 3600,
        'path'     => $path,
        'httponly' => false,
        'samesite' => 'Lax',
    ]);
    setcookie('lv_user', '', [
        'expires'  => time() - 3600,
        'path'     => $path,
        'httponly' => false,
        'samesite' => 'Lax',
    ]);
}

function set_user_cookie(array $user): void
{
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');

    setcookie('lv_user', rawurlencode(json_encode($user, JSON_UNESCAPED_UNICODE)), [
        'expires'  => time() + 60 * 60 * 24 * 30,
        'path'     => auth_cookie_path(),
        'secure'   => $secure,
        'httponly' => false,
        'samesite' => 'Lax',
    ]);
}

function current_auth_user(PDO $pdo): ?array
{
    $token = auth_token_from_request();
    if (!$token) {
        return null;
    }

    $parsed = parse_auth_token($token);
    if (!$parsed) {
        return null;
    }

    $row = load_user_by_id($pdo, $parsed['user_id']);
    if (!$row || !empty($row['banned'])) {
        return null;
    }

    return hydrate_user($pdo, $row);
}

function require_auth_user(PDO $pdo): array
{
    $user = current_auth_user($pdo);
    if (!$user) {
        json_response(['ok' => false, 'message' => 'Authentication required.'], 401);
    }

    return $user;
}

function auth_success(PDO $pdo, array $row, string $password = ''): void
{
    $stored = trim((string) ($row['password'] ?? ''));

    if ($password !== '' && empty(password_get_info($stored)['algo'])) {
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $pdo->prepare('UPDATE users SET password = ? WHERE id = ?')->execute([$hash, $row['id']]);
    }

    $token = create_auth_token((string) $row['id']);
    $user = hydrate_user($pdo, $row);
    set_auth_cookie($token);
    set_user_cookie($user);

    json_response([
        'ok'    => true,
        'token' => $token,
        'user'  => $user,
    ]);
}

function make_user_id(): string
{
    return 'u' . (string) (int) (microtime(true) * 1000);
}

function save_user_profile(PDO $pdo, array $authUser, array $userData): void
{
    if ($authUser['role'] !== 'admin' && $authUser['id'] !== ($userData['id'] ?? '')) {
        return;
    }

    $pdo->prepare(
        'UPDATE users SET username = ?, bio = ?, role = ?, banned = ? WHERE id = ?'
    )->execute([
        $userData['username'] ?? $authUser['username'],
        $userData['bio'] ?? '',
        $authUser['role'] === 'admin' ? ($userData['role'] ?? 'user') : $authUser['role'],
        !empty($userData['banned']) ? 1 : 0,
        $userData['id'],
    ]);

    try {
        $pdo->prepare('DELETE FROM user_interests WHERE user_id = ?')->execute([$userData['id']]);
        $insertInterest = $pdo->prepare('INSERT INTO user_interests (user_id, interest) VALUES (?, ?)');
        foreach (($userData['interests'] ?? []) as $interest) {
            $insertInterest->execute([$userData['id'], $interest]);
        }
    } catch (Throwable $e) {
        // Table may not exist yet.
    }

    try {
        $pdo->prepare('DELETE FROM user_connections WHERE user_id = ?')->execute([$userData['id']]);
        $insertConn = $pdo->prepare('INSERT IGNORE INTO user_connections (user_id, connected_user_id) VALUES (?, ?)');
        $reciprocal = $pdo->prepare('INSERT IGNORE INTO user_connections (user_id, connected_user_id) VALUES (?, ?)');
        foreach (($userData['connections'] ?? []) as $connectedId) {
            $insertConn->execute([$userData['id'], $connectedId]);
            $reciprocal->execute([$connectedId, $userData['id']]);
        }
    } catch (Throwable $e) {
        // Table may not exist yet.
    }
}

function reaction_keys(): array
{
    return [
        'helpful', 'inspired', 'grateful', 'moved', 'hopeful', 'relatable',
        'motivated', 'empathy', 'encouraged', 'amen', 'peaceful', 'joyful',
        'reflective', 'blessed',
    ];
}

function empty_reactions_map(): array
{
    $map = [];
    foreach (reaction_keys() as $key) {
        $map[$key] = 0;
    }

    return $map;
}

/**
 * Recompute lesson.helpful + reactions_json from user_lesson_reactions (source of truth).
 * Client payloads must not overwrite these aggregates.
 */
function recompute_lesson_reaction_totals(PDO $pdo, string $lessonId): ?array
{
    $lessonId = trim($lessonId);
    if ($lessonId === '') {
        return null;
    }

    $exists = $pdo->prepare('SELECT id FROM lessons WHERE id = ? LIMIT 1');
    $exists->execute([$lessonId]);
    if (!$exists->fetchColumn()) {
        return null;
    }

    $reactions = empty_reactions_map();
    $stmt = $pdo->prepare(
        'SELECT reaction_key, COUNT(*) AS cnt
         FROM user_lesson_reactions
         WHERE lesson_id = ?
         GROUP BY reaction_key'
    );
    $stmt->execute([$lessonId]);
    foreach ($stmt->fetchAll() ?: [] as $row) {
        $key = (string) ($row['reaction_key'] ?? '');
        if ($key === '') {
            continue;
        }
        $reactions[$key] = (int) ($row['cnt'] ?? 0);
    }

    $helpful = 0;
    foreach ($reactions as $count) {
        $helpful += (int) $count;
    }

    $pdo->prepare(
        'UPDATE lessons SET helpful = ?, reactions_json = ? WHERE id = ?'
    )->execute([$helpful, json_encode($reactions), $lessonId]);

    return [
        'id'        => $lessonId,
        'helpful'   => $helpful,
        'reactions' => $reactions,
    ];
}

/**
 * Build reaction totals for many lessons from user_lesson_reactions (sync safety net).
 * @return array<string, array{helpful:int, reactions:array}>
 */
function load_reaction_totals_by_lesson(PDO $pdo): array
{
    $out = [];
    try {
        $rows = $pdo->query(
            'SELECT lesson_id, reaction_key, COUNT(*) AS cnt
             FROM user_lesson_reactions
             GROUP BY lesson_id, reaction_key'
        )->fetchAll() ?: [];
    } catch (Throwable $e) {
        return [];
    }

    foreach ($rows as $row) {
        $lessonId = (string) ($row['lesson_id'] ?? '');
        $key = (string) ($row['reaction_key'] ?? '');
        if ($lessonId === '' || $key === '') {
            continue;
        }
        if (!isset($out[$lessonId])) {
            $out[$lessonId] = [
                'helpful'   => 0,
                'reactions' => empty_reactions_map(),
            ];
        }
        $cnt = (int) ($row['cnt'] ?? 0);
        $out[$lessonId]['reactions'][$key] = $cnt;
        $out[$lessonId]['helpful'] += $cnt;
    }

    return $out;
}

/**
 * Set or clear one user's reaction on one lesson, then recompute aggregates.
 * Pass $reactionKey = null (or '') to remove.
 *
 * @return array{lesson:?array, previous:?string, key:?string, active:bool}
 */
function set_user_lesson_reaction(
    PDO $pdo,
    string $userId,
    string $lessonId,
    ?string $reactionKey,
    ?array $authUser = null
): array {
    $lessonId = trim($lessonId);
    $reactionKey = $reactionKey !== null ? trim($reactionKey) : '';
    if ($reactionKey === '') {
        $reactionKey = null;
    }

    $prevStmt = $pdo->prepare(
        'SELECT reaction_key FROM user_lesson_reactions WHERE user_id = ? AND lesson_id = ? LIMIT 1'
    );
    $prevStmt->execute([$userId, $lessonId]);
    $previous = $prevStmt->fetchColumn();
    $previous = $previous !== false ? (string) $previous : null;

    if ($reactionKey === null) {
        $pdo->prepare(
            'DELETE FROM user_lesson_reactions WHERE user_id = ? AND lesson_id = ?'
        )->execute([$userId, $lessonId]);
    } else {
        $pdo->prepare(
            'INSERT INTO user_lesson_reactions (user_id, lesson_id, reaction_key)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE reaction_key = VALUES(reaction_key)'
        )->execute([$userId, $lessonId, $reactionKey]);
    }

    $lessonTotals = recompute_lesson_reaction_totals($pdo, $lessonId);

    // Notify post owner when a reaction is added or changed (not on remove).
    if (
        $authUser
        && $reactionKey !== null
        && $previous !== $reactionKey
    ) {
        $lessonRow = load_lesson_row($pdo, $lessonId);
        if ($lessonRow) {
            $type = ($previous !== null && $previous !== '') ? 'reaction_change' : 'reaction';
            upsert_reaction_notification($pdo, $authUser, $lessonRow, $type, $reactionKey);
        }
    }

    return [
        'lesson'   => $lessonTotals,
        'previous' => $previous,
        'key'      => $reactionKey,
        'active'   => $reactionKey !== null,
    ];
}

function upsert_lesson(PDO $pdo, array $authUser, array $lesson): void
{
    if ($authUser['role'] !== 'admin' && ($lesson['userId'] ?? '') !== $authUser['id']) {
        return;
    }

    // helpful / reactions_json are owned by user_lesson_reactions recompute — never overwrite on update.
    $pdo->prepare(
        'INSERT INTO lessons
            (id, user_id, title, category, experience, lesson_learned, date_posted,
             helpful, anonymous, author, video_url, reactions_json, advice_video_json, status, moderation_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            title = VALUES(title), category = VALUES(category), experience = VALUES(experience),
            lesson_learned = VALUES(lesson_learned),
            anonymous = VALUES(anonymous), author = VALUES(author), video_url = VALUES(video_url),
            advice_video_json = VALUES(advice_video_json),
            status = VALUES(status), moderation_reason = VALUES(moderation_reason)'
    )->execute([
        $lesson['id'], $lesson['userId'], $lesson['title'] ?? '', $lesson['category'] ?? 'personal',
        $lesson['experience'] ?? '', $lesson['lessonLearned'] ?? '', $lesson['datePosted'] ?? date('Y-m-d'),
        (int) ($lesson['helpful'] ?? 0), !empty($lesson['anonymous']) ? 1 : 0, $lesson['author'] ?? '',
        $lesson['videoUrl'] ?? '', json_encode($lesson['reactions'] ?? empty_reactions_map()),
        !empty($lesson['adviceVideo']) ? json_encode($lesson['adviceVideo']) : null,
        $lesson['status'] ?? 'active', $lesson['moderationReason'] ?? null,
    ]);
}

function upsert_comment(PDO $pdo, array $authUser, array $comment): void
{
    if ($authUser['role'] !== 'admin' && ($comment['userId'] ?? '') !== $authUser['id']) {
        return;
    }

    $commentId = (string) ($comment['id'] ?? '');
    $lessonId = (string) ($comment['lessonId'] ?? '');
    $existsStmt = $pdo->prepare('SELECT id FROM comments WHERE id = ? LIMIT 1');
    $existsStmt->execute([$commentId]);
    $isNew = !$existsStmt->fetchColumn();

    $pdo->prepare(
        'INSERT INTO comments
            (id, lesson_id, user_id, text, date_posted, anonymous, author, status, moderation_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            text = VALUES(text), anonymous = VALUES(anonymous), author = VALUES(author),
            status = VALUES(status), moderation_reason = VALUES(moderation_reason)'
    )->execute([
        $commentId, $lessonId, $comment['userId'], $comment['text'] ?? '',
        $comment['datePosted'] ?? date('Y-m-d'), !empty($comment['anonymous']) ? 1 : 0,
        $comment['author'] ?? '', $comment['status'] ?? 'active', $comment['moderationReason'] ?? null,
    ]);

    if ($isNew && $lessonId !== '' && $commentId !== '') {
        $lesson = load_lesson_row($pdo, $lessonId);
        if ($lesson) {
            $recipientId = (string) ($lesson['user_id'] ?? '');
            if ($recipientId !== '' && $recipientId !== (string) $authUser['id']) {
                $dup = $pdo->prepare(
                    'SELECT id FROM notifications
                     WHERE recipient_user_id = ? AND comment_id = ? AND type = ?
                     LIMIT 1'
                );
                $dup->execute([$recipientId, $commentId, 'comment']);
                if (!$dup->fetchColumn()) {
                    create_comment_notification($pdo, $authUser, $lesson, $commentId, 'comment');
                }
            }
        }
    }
}

/**
 * Replace one user's reactions and recompute lesson aggregates for every affected lesson.
 * @return array<int, array{id:string,helpful:int,reactions:array}>
 */
function save_user_reactions(PDO $pdo, string $userId, array $userReactions, ?array $authUser = null): array
{
    $updatedLessons = [];

    try {
        $prevStmt = $pdo->prepare('SELECT lesson_id, reaction_key FROM user_lesson_reactions WHERE user_id = ?');
        $prevStmt->execute([$userId]);
        $previous = [];
        foreach ($prevStmt->fetchAll() ?: [] as $row) {
            $previous[(string) $row['lesson_id']] = (string) $row['reaction_key'];
        }

        $normalized = [];
        foreach ($userReactions as $lessonId => $reactionKey) {
            $lessonId = (string) $lessonId;
            $reactionKey = is_string($reactionKey) ? trim($reactionKey) : '';
            if ($lessonId !== '' && $reactionKey !== '') {
                $normalized[$lessonId] = $reactionKey;
            }
        }

        $pdo->prepare('DELETE FROM user_lesson_reactions WHERE user_id = ?')->execute([$userId]);
        $insert = $pdo->prepare(
            'INSERT INTO user_lesson_reactions (user_id, lesson_id, reaction_key) VALUES (?, ?, ?)'
        );
        foreach ($normalized as $lessonId => $reactionKey) {
            $insert->execute([$userId, $lessonId, $reactionKey]);
        }

        $affectedIds = array_unique(array_merge(array_keys($previous), array_keys($normalized)));
        foreach ($affectedIds as $lessonId) {
            $recomputed = recompute_lesson_reaction_totals($pdo, (string) $lessonId);
            if ($recomputed) {
                $updatedLessons[] = $recomputed;
            }
        }

        if (!$authUser || (string) ($authUser['id'] ?? '') !== $userId) {
            return $updatedLessons;
        }

        foreach ($normalized as $lessonId => $reactionKey) {
            $prevKey = $previous[$lessonId] ?? null;
            if ($prevKey === $reactionKey) {
                continue;
            }

            $lesson = load_lesson_row($pdo, $lessonId);
            if (!$lesson) {
                continue;
            }

            $type = ($prevKey !== null && $prevKey !== '') ? 'reaction_change' : 'reaction';
            upsert_reaction_notification($pdo, $authUser, $lesson, $type, $reactionKey);
        }
    } catch (Throwable $e) {
        error_log('save_user_reactions failed: ' . $e->getMessage());
        throw $e;
    }

    return $updatedLessons;
}

function reaction_emoji(string $key): string
{
    $map = [
        'helpful'    => '👍',
        'inspired'   => '💡',
        'grateful'   => '🙏',
        'moved'      => '❤️',
        'hopeful'    => '🌱',
        'relatable'  => '🤝',
        'motivated'  => '💪',
        'empathy'    => '🫂',
        'encouraged' => '🌟',
        'amen'       => '✨',
        'peaceful'   => '☮️',
        'joyful'     => '😊',
        'reflective' => '🤔',
        'blessed'    => '🕊️',
    ];

    return $map[$key] ?? '👍';
}

function build_notification_message(string $type, string $actorName, ?string $reactionKey = null): string
{
    switch ($type) {
        case 'reaction':
            return sprintf('%s reacted to your post.', $actorName);
        case 'reaction_change':
            return sprintf('%s changed their reaction on your post.', $actorName);
        case 'comment':
            return sprintf('%s commented on your post.', $actorName);
        case 'reply':
            return sprintf('%s replied to your comment.', $actorName);
        case 'connection':
            return sprintf('%s connected with you.', $actorName);
        default:
            return sprintf('%s interacted with your post.', $actorName);
    }
}

function notification_to_public(array $row, ?string $actorUsername = null): array
{
    $createdAt = datetime_to_iso8601((string) ($row['created_at'] ?? ''));
    if ($createdAt === null) {
        $createdAt = datetime_to_iso8601(utc_now());
    }

    return [
        'id'              => (string) ($row['id'] ?? ''),
        'recipientUserId' => (string) ($row['recipient_user_id'] ?? ''),
        'actorUserId'     => (string) ($row['actor_user_id'] ?? ''),
        'actorUsername'   => (string) ($actorUsername ?? ($row['actor_username'] ?? 'Someone')),
        'postId'          => isset($row['post_id']) && $row['post_id'] !== null && $row['post_id'] !== ''
            ? (string) $row['post_id']
            : null,
        'commentId'       => isset($row['comment_id']) && $row['comment_id'] !== null && $row['comment_id'] !== ''
            ? (string) $row['comment_id']
            : null,
        'type'            => (string) ($row['type'] ?? 'comment'),
        'reactionType'    => isset($row['reaction_type']) && $row['reaction_type'] !== null && $row['reaction_type'] !== ''
            ? (string) $row['reaction_type']
            : null,
        'message'         => (string) ($row['message'] ?? 'New notification'),
        'postTitle'       => isset($row['post_title']) && $row['post_title'] !== null
            ? (string) $row['post_title']
            : null,
        'isRead'          => !empty($row['is_read']),
        'createdAt'       => $createdAt,
    ];
}

function load_notifications_for_user(PDO $pdo, string $userId, int $limit = 50): array
{
    $stmt = $pdo->prepare(
        'SELECT n.*, u.username AS actor_username
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_user_id
         WHERE n.recipient_user_id = ?
         ORDER BY n.created_at DESC
         LIMIT ' . max(1, min(100, $limit))
    );
    $stmt->execute([$userId]);
    $rows = $stmt->fetchAll() ?: [];

    return array_map(static function (array $row): array {
        if (empty($row['actor_username'])) {
            $row['actor_username'] = 'Someone';
        }

        return notification_to_public($row);
    }, $rows);
}

function parse_since_param(?string $since): string
{
    if (!$since || trim($since) === '') {
        return (new DateTime('now', app_timezone()))->modify('-5 seconds')->format('Y-m-d H:i:s');
    }

    try {
        $dt = new DateTime(trim($since));
        $dt->setTimezone(app_timezone());
        $dt->modify('-1 second');

        return $dt->format('Y-m-d H:i:s');
    } catch (Throwable $e) {
        return (new DateTime('now', app_timezone()))->modify('-5 seconds')->format('Y-m-d H:i:s');
    }
}

function load_notifications_since(PDO $pdo, string $userId, string $since, int $limit = 20): array
{
    $stmt = $pdo->prepare(
        'SELECT n.*, u.username AS actor_username
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_user_id
         WHERE n.recipient_user_id = ?
           AND n.created_at >= ?
         ORDER BY n.created_at ASC
         LIMIT ' . max(1, min(50, $limit))
    );
    $stmt->execute([$userId, $since]);
    $rows = $stmt->fetchAll() ?: [];

    return array_map(static function (array $row): array {
        if (empty($row['actor_username'])) {
            $row['actor_username'] = 'Someone';
        }

        return notification_to_public($row);
    }, $rows);
}

function sse_send(string $event, array $data): void
{
    echo 'event: ' . $event . "\n";
    echo 'data: ' . json_encode($data, JSON_UNESCAPED_UNICODE) . "\n\n";

    while (ob_get_level() > 0) {
        ob_end_flush();
    }
    flush();
}

function unread_notification_count(PDO $pdo, string $userId): int
{
    $stmt = $pdo->prepare(
        'SELECT COUNT(*) FROM notifications WHERE recipient_user_id = ? AND is_read = 0'
    );
    $stmt->execute([$userId]);

    return (int) $stmt->fetchColumn();
}

function upsert_reaction_notification(
    PDO $pdo,
    array $actor,
    array $lesson,
    string $type,
    ?string $reactionKey
): ?array {
    $recipientId = (string) $lesson['user_id'];
    $actorId = (string) $actor['id'];

    if ($recipientId === $actorId) {
        return null;
    }

    $message = build_notification_message($type, (string) $actor['username'], $reactionKey);
    $postId = (string) $lesson['id'];
    $postTitle = (string) ($lesson['title'] ?? '');

    $find = $pdo->prepare(
        "SELECT id FROM notifications
         WHERE recipient_user_id = ? AND actor_user_id = ? AND post_id = ?
           AND type IN ('reaction', 'reaction_change')
         ORDER BY created_at DESC
         LIMIT 1"
    );
    $find->execute([$recipientId, $actorId, $postId]);
    $existingId = $find->fetchColumn();

    if ($existingId) {
        $stmt = $pdo->prepare('SELECT * FROM notifications WHERE id = ? LIMIT 1');
        $stmt->execute([$existingId]);
        $row = $stmt->fetch();

        // Idempotent: create.php + push.php both upsert; do not bump created_at / unread on duplicates.
        if ($row && (string) ($row['reaction_type'] ?? '') === (string) $reactionKey) {
            return notification_to_public($row, (string) $actor['username']);
        }

        $pdo->prepare(
            'UPDATE notifications
             SET type = ?, reaction_type = ?, message = ?, post_title = ?, is_read = 0, created_at = ?
             WHERE id = ? AND recipient_user_id = ?'
        )->execute([$type, $reactionKey, $message, $postTitle, utc_now(), $existingId, $recipientId]);

        $stmt->execute([$existingId]);
        $row = $stmt->fetch();

        return $row ? notification_to_public($row, (string) $actor['username']) : null;
    }

    $id = 'n' . (string) (int) (microtime(true) * 1000) . bin2hex(random_bytes(3));
    $pdo->prepare(
        'INSERT INTO notifications
         (id, recipient_user_id, actor_user_id, post_id, comment_id, type, reaction_type, message, post_title, is_read)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)'
    )->execute([$id, $recipientId, $actorId, $postId, $type, $reactionKey, $message, $postTitle]);

    return notification_to_public([
        'id'                => $id,
        'recipient_user_id' => $recipientId,
        'actor_user_id'     => $actorId,
        'post_id'           => $postId,
        'comment_id'        => null,
        'type'              => $type,
        'reaction_type'     => $reactionKey,
        'message'           => $message,
        'post_title'        => $postTitle,
        'is_read'           => 0,
        'created_at'        => utc_now(),
    ], (string) $actor['username']);
}

function create_comment_notification(
    PDO $pdo,
    array $actor,
    array $lesson,
    ?string $commentId,
    string $type = 'comment'
): ?array {
    $recipientId = (string) $lesson['user_id'];
    $actorId = (string) $actor['id'];

    if ($recipientId === $actorId) {
        return null;
    }

    $message = build_notification_message($type, (string) $actor['username']);
    $postId = (string) $lesson['id'];
    $postTitle = (string) ($lesson['title'] ?? '');
    $id = 'n' . (string) (int) (microtime(true) * 1000) . bin2hex(random_bytes(3));

    $pdo->prepare(
        'INSERT INTO notifications
         (id, recipient_user_id, actor_user_id, post_id, comment_id, type, reaction_type, message, post_title, is_read)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)'
    )->execute([$id, $recipientId, $actorId, $postId, $commentId, $type, $message, $postTitle]);

    return notification_to_public([
        'id'                => $id,
        'recipient_user_id' => $recipientId,
        'actor_user_id'     => $actorId,
        'post_id'           => $postId,
        'comment_id'        => $commentId,
        'type'              => $type,
        'reaction_type'     => null,
        'message'           => $message,
        'post_title'        => $postTitle,
        'is_read'           => 0,
        'created_at'        => utc_now(),
    ], (string) $actor['username']);
}

function create_connection_notification(PDO $pdo, array $actor, string $recipientId): ?array
{
    $actorId = (string) ($actor['id'] ?? '');
    $recipientId = trim($recipientId);

    if ($actorId === '' || $recipientId === '' || $recipientId === $actorId) {
        return null;
    }

    $recipient = load_user_by_id($pdo, $recipientId);
    if (!$recipient) {
        return null;
    }

    // Avoid spamming: one unread connection notif per actor→recipient pair
    $dup = $pdo->prepare(
        "SELECT id FROM notifications
         WHERE recipient_user_id = ? AND actor_user_id = ? AND type = 'connection' AND is_read = 0
         LIMIT 1"
    );
    $dup->execute([$recipientId, $actorId]);
    if ($dup->fetchColumn()) {
        $stmt = $pdo->prepare('SELECT * FROM notifications WHERE recipient_user_id = ? AND actor_user_id = ? AND type = ? AND is_read = 0 LIMIT 1');
        $stmt->execute([$recipientId, $actorId, 'connection']);
        $row = $stmt->fetch();
        return $row ? notification_to_public($row, (string) $actor['username']) : null;
    }

    $message = build_notification_message('connection', (string) $actor['username']);
    $id = 'n' . (string) (int) (microtime(true) * 1000) . bin2hex(random_bytes(3));

    $pdo->prepare(
        'INSERT INTO notifications
         (id, recipient_user_id, actor_user_id, post_id, comment_id, type, reaction_type, message, post_title, is_read)
         VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, 0)'
    )->execute([$id, $recipientId, $actorId, 'connection', $message]);

    return notification_to_public([
        'id'                => $id,
        'recipient_user_id' => $recipientId,
        'actor_user_id'     => $actorId,
        'post_id'           => null,
        'comment_id'        => null,
        'type'              => 'connection',
        'reaction_type'     => null,
        'message'           => $message,
        'post_title'        => null,
        'is_read'           => 0,
        'created_at'        => utc_now(),
    ], (string) $actor['username']);
}

function load_lesson_row(PDO $pdo, string $lessonId): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM lessons WHERE id = ? LIMIT 1');
    $stmt->execute([$lessonId]);
    $row = $stmt->fetch();

    return $row ?: null;
}

function assert_notification_owner(PDO $pdo, string $notificationId, string $userId): ?array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM notifications WHERE id = ? AND recipient_user_id = ? LIMIT 1'
    );
    $stmt->execute([$notificationId, $userId]);
    $row = $stmt->fetch();

    return $row ?: null;
}
