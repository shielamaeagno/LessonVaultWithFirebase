<?php
/**
 * Lesson Vault — PDO database connection helper
 */

require_once __DIR__ . '/config.php';

function db_dsn(): string
{
    $port = defined('DB_PORT') ? (int) DB_PORT : 3306;

    if ($port === 3306) {
        return sprintf(
            'mysql:host=%s;dbname=%s;charset=%s',
            DB_HOST,
            DB_NAME,
            DB_CHARSET
        );
    }

    return sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        DB_HOST,
        $port,
        DB_NAME,
        DB_CHARSET
    );
}

function db_error_hint(string $message): string
{
    if (stripos($message, 'No such file or directory') !== false) {
        return 'Wrong DB host. On Railway use MYSQLHOST from your MySQL service (private domain). On InfinityFree use sql###.infinityfree.com — never localhost.';
    }
    if (stripos($message, 'Access denied') !== false) {
        return 'Wrong database username or password. On Railway, link MySQL variables to your web service.';
    }
    if (stripos($message, 'Unknown database') !== false) {
        return 'Database does not exist. On Railway, add a MySQL plugin. Then run api/setup.php once.';
    }
    if (stripos($message, 'Connection refused') !== false || stripos($message, 'timed out') !== false) {
        return 'Cannot reach MySQL. On Railway, reference the MySQL service variables on your web service and redeploy.';
    }
    if (stripos($message, "doesn't exist") !== false) {
        return 'Tables are missing. Open api/install.php once in your browser.';
    }

    return 'Check api/config.php matches InfinityFree MySQL Databases panel.';
}

function db(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $pdo = new PDO(db_dsn(), DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        PDO::ATTR_TIMEOUT            => 10,
    ]);

    date_default_timezone_set('UTC');
    $pdo->exec("SET time_zone = '+00:00'");

    return $pdo;
}
