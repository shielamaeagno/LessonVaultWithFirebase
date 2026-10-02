<?php
/**
 * Open once in browser to verify DB + tables + demo users.
 * Delete after you see "ok": true
 */
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

try {
    $pdo = db();
    $users = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);

    echo json_encode([
        'ok'       => true,
        'message'  => 'Database ready.',
        'users'    => $users,
        'tables'   => $tables,
        'login'    => 'test@lessonvault.com / password123',
    ], JSON_PRETTY_PRINT);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'ok'    => false,
        'error' => $e->getMessage(),
    ], JSON_PRETTY_PRINT);
}
