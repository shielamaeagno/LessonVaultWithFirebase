<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/schema.php';
require_once __DIR__ . '/helpers.php';

set_exception_handler(static function (Throwable $e): void {
    $hint = function_exists('db_error_hint') ? db_error_hint($e->getMessage()) : '';
    json_response([
        'ok'      => false,
        'message' => 'Server error.',
        'error'   => $e->getMessage(),
        'hint'    => $hint,
    ], 500);
});

try {
    ensure_schema(db());
} catch (Throwable $e) {
    json_response([
        'ok'      => false,
        'message' => 'Database connection failed.',
        'error'   => $e->getMessage(),
        'hint'    => db_error_hint($e->getMessage()),
    ], 500);
}
