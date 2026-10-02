<?php
declare(strict_types=1);

/**
 * Creates all tables and demo users if missing.
 * Safe to call on every login — uses IF NOT EXISTS.
 */
function ensure_schema(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS users (
            id         VARCHAR(32)  NOT NULL PRIMARY KEY,
            username   VARCHAR(100) NOT NULL,
            email      VARCHAR(255) NOT NULL,
            password   VARCHAR(255) NOT NULL,
            role       VARCHAR(20)  NOT NULL DEFAULT 'user',
            bio        TEXT         NULL,
            joined     DATE         NOT NULL,
            banned     TINYINT(1)   NOT NULL DEFAULT 0,
            UNIQUE KEY uq_users_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS user_interests (
            user_id  VARCHAR(32) NOT NULL,
            interest VARCHAR(50) NOT NULL,
            PRIMARY KEY (user_id, interest)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS user_connections (
            user_id           VARCHAR(32) NOT NULL,
            connected_user_id VARCHAR(32) NOT NULL,
            PRIMARY KEY (user_id, connected_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS lessons (
            id                VARCHAR(32)  NOT NULL PRIMARY KEY,
            user_id           VARCHAR(32)  NOT NULL,
            title             VARCHAR(255) NOT NULL,
            category          VARCHAR(50)  NOT NULL DEFAULT 'personal',
            experience        TEXT NOT NULL,
            lesson_learned    TEXT NOT NULL,
            date_posted       DATE NOT NULL,
            helpful           INT NOT NULL DEFAULT 0,
            anonymous         TINYINT(1) NOT NULL DEFAULT 0,
            author            VARCHAR(100) NOT NULL DEFAULT '',
            video_url         VARCHAR(500) NOT NULL DEFAULT '',
            reactions_json    TEXT NULL,
            advice_video_json TEXT NULL,
            status            VARCHAR(20) NOT NULL DEFAULT 'active',
            moderation_reason TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS lesson_bible_verses (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            lesson_id   VARCHAR(32) NOT NULL,
            reference   VARCHAR(100) NOT NULL,
            text        TEXT NOT NULL,
            translation VARCHAR(20) NOT NULL DEFAULT 'ESV',
            sort_order  INT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS comments (
            id                VARCHAR(32) NOT NULL PRIMARY KEY,
            lesson_id         VARCHAR(32) NOT NULL,
            user_id           VARCHAR(32) NOT NULL,
            text              TEXT NOT NULL,
            date_posted       DATE NOT NULL,
            anonymous         TINYINT(1) NOT NULL DEFAULT 0,
            author            VARCHAR(100) NOT NULL DEFAULT '',
            status            VARCHAR(20) NOT NULL DEFAULT 'active',
            moderation_reason TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS user_lesson_reactions (
            user_id      VARCHAR(32) NOT NULL,
            lesson_id    VARCHAR(32) NOT NULL,
            reaction_key VARCHAR(30) NOT NULL,
            PRIMARY KEY (user_id, lesson_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS notifications (
            id                VARCHAR(32)  NOT NULL PRIMARY KEY,
            recipient_user_id VARCHAR(32)  NOT NULL,
            actor_user_id     VARCHAR(32)  NOT NULL,
            post_id           VARCHAR(32)  NULL,
            comment_id        VARCHAR(32)  NULL,
            type              VARCHAR(20)  NOT NULL,
            reaction_type     VARCHAR(30)  NULL,
            message           VARCHAR(500) NOT NULL,
            post_title        VARCHAR(255) NULL,
            is_read           TINYINT(1)   NOT NULL DEFAULT 0,
            created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_notif_recipient (recipient_user_id, is_read, created_at),
            KEY idx_notif_actor_post (recipient_user_id, actor_user_id, post_id, type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    try {
        $pdo->exec('ALTER TABLE users MODIFY password VARCHAR(255) NOT NULL');
    } catch (Throwable $e) {
        // Already correct.
    }

    try {
        $pdo->exec('ALTER TABLE notifications MODIFY post_id VARCHAR(32) NULL');
    } catch (Throwable $e) {
        // Already nullable or table just created.
    }

    $count = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    if ($count === 0) {
        $insert = $pdo->prepare(
            'INSERT INTO users (id, username, email, password, role, bio, joined, banned)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
        );
        $demos = [
            ['u0', 'Admin', 'admin@lessonvault.com', 'admin123', 'admin', 'Administrator', '2024-01-01'],
            ['u1', 'testuser', 'test@lessonvault.com', 'password123', 'user', 'Demo user', '2025-01-01'],
        ];
        foreach ($demos as [$id, $username, $email, $plain, $role, $bio, $joined]) {
            $insert->execute([$id, $username, $email, password_hash($plain, PASSWORD_DEFAULT), $role, $bio, $joined]);
        }
    }

    // Repair lesson aggregates from reaction rows (source of truth).
    if (function_exists('recompute_lesson_reaction_totals')) {
        try {
            $ids = $pdo->query('SELECT DISTINCT lesson_id FROM user_lesson_reactions')->fetchAll(PDO::FETCH_COLUMN);
            foreach ($ids ?: [] as $lessonId) {
                recompute_lesson_reaction_totals($pdo, (string) $lessonId);
            }
        } catch (Throwable $e) {
            // Table may not exist yet.
        }
    }

    $done = true;
}
