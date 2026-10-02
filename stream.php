<?php
declare(strict_types=1);

/*
 * FIX 1 — stream.php must NOT call bootstrap.php (which calls json_response
 *           and exits if DB fails AFTER headers are already sent as SSE).
 *           Load only what we need directly.
 * FIX 2 — InfinityFree kills long-running PHP scripts (max_execution_time ~30 s).
 *           We shorten the loop window to 25 s and let JS reconnect.
 * FIX 3 — sleep(1) inside a loop that also does DB queries is too slow on
 *           shared hosting. We keep 2-second polls to reduce DB pressure.
 * FIX 4 — ob_end_clean() + set_time_limit(0) before headers are sent.
 * FIX 5 — CORS headers added so cross-device / cross-origin SSE works.
 * FIX 6 — X-Accel-Buffering: no already present; added Pragma: no-cache too.
 */

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../schema.php';
require_once __DIR__ . '/../helpers.php';

/* ── Must flush output buffers BEFORE sending SSE headers ── */
while (ob_get_level() > 0) {
    ob_end_clean();
}

/* ── CORS: allow the same origin AND mobile browsers on different tabs ── */
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
}
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: X-LV-Token, Authorization, Accept');

/* Preflight */
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* ── SSE headers ── */
header('Content-Type: text/event-stream; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Connection: keep-alive');
header('X-Accel-Buffering: no');   /* nginx / InfinityFree proxy */
header('X-Content-Type-Options: nosniff');

/* ── Limits safe for InfinityFree shared hosting ── */
@set_time_limit(35);
ignore_user_abort(true);

try {
    ensure_schema(db());
    $pdo = db();
    $user = current_auth_user($pdo);

    if (!$user) {
        http_response_code(401);
        sse_send('stream_error', ['message' => 'Authentication required.']);
        exit;
    }

    $userId    = (string) $user['id'];
    $since     = parse_since_param(trim((string) ($_GET['since'] ?? '')));
    $lastSeen  = $since;
    $lastCount = unread_notification_count($pdo, $userId);

    /*
     * FIX 2 — InfinityFree kills at ~30 s.  Use 25 s window so we close
     *          cleanly and JS reconnects with the updated ?since= param.
     */
    $deadline = time() + 25;
    $seenIds  = [];

    sse_send('ready', ['unreadCount' => $lastCount, 'ts' => time()]);

    while (time() < $deadline && !connection_aborted()) {
        $newItems = load_notifications_since($pdo, $userId, $lastSeen);

        foreach ($newItems as $notif) {
            $id = (string) ($notif['id'] ?? '');
            if ($id !== '' && isset($seenIds[$id])) {
                continue;
            }
            if ($id !== '') {
                $seenIds[$id] = true;
            }
            sse_send('notification', $notif);
            $notifDt = iso8601_to_datetime($notif['createdAt'] ?? '');
            // Advance cursor past this row so reconnects don't miss later same-second items
            if ($notifDt > $lastSeen) {
                $lastSeen = $notifDt;
            }
        }

        $count = unread_notification_count($pdo, $userId);
        if ($count !== $lastCount) {
            sse_send('unread_count', ['unreadCount' => $count]);
            $lastCount = $count;
        }

        sse_send('ping', ['t' => time()]);

        /*
         * 1-second poll inside the SSE window for faster cross-device delivery.
         * Outer JS reconnects every ~25s due to InfinityFree limits.
         */
        sleep(1);
    }

    /* Clean close — JS reads this and reconnects */
    sse_send('reconnect', ['after' => 500]);

} catch (Throwable $e) {
    sse_send('stream_error', ['message' => 'Stream error: ' . $e->getMessage()]);
}
