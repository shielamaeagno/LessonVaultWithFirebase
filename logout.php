<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

clear_auth_cookie();

json_response(['ok' => true]);
