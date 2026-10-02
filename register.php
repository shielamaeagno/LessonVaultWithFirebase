<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'message' => 'POST required.'], 405);
}

$data = read_json_body();
$username = trim((string) ($data['username'] ?? ''));
$email = strtolower(trim((string) ($data['email'] ?? '')));
$password = (string) ($data['password'] ?? '');

if ($username === '' || $email === '' || $password === '') {
    json_response(['ok' => false, 'message' => 'All fields are required.'], 400);
}

if (strlen($password) < 6) {
    json_response(['ok' => false, 'message' => 'Password must be at least 6 characters.'], 400);
}

try {
    $pdo = db();

    $check = $pdo->prepare('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1');
    $check->execute([$email]);
    if ($check->fetch()) {
        json_response(['ok' => false, 'message' => 'Email already registered.'], 409);
    }

    $id = make_user_id();
    $joined = date('Y-m-d');
    $hash = password_hash($password, PASSWORD_DEFAULT);

    $insert = $pdo->prepare(
        'INSERT INTO users (id, username, email, password, role, bio, joined, banned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
    );
    $insert->execute([$id, $username, $email, $hash, 'user', '', $joined]);

    $row = load_user_by_id($pdo, $id);
    if (!$row) {
        json_response(['ok' => false, 'message' => 'Registration failed.'], 500);
    }

    auth_success($pdo, $row, $password);
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Registration failed.',
        'error'   => $e->getMessage(),
    ], 500);
}
