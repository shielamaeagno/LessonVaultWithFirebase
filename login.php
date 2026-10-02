<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'message' => 'POST required.'], 405);
}

$data = read_json_body();
$email = strtolower(trim((string) ($data['email'] ?? '')));
$password = (string) ($data['password'] ?? '');

if ($email === '' || $password === '') {
    json_response(['ok' => false, 'message' => 'Email and password are required.'], 400);
}

try {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1');
    $stmt->execute([$email]);
    $row = $stmt->fetch();

    if (!$row || !verify_password($password, (string) $row['password'])) {
        json_response(['ok' => false, 'message' => 'Invalid email or password.'], 401);
    }

    if (!empty($row['banned'])) {
        json_response(['ok' => false, 'banned' => true, 'message' => 'Account suspended.'], 403);
    }

    auth_success($pdo, $row, $password);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Login failed.',
        'error'   => $e->getMessage(),
    ], 500);
}
