<?php
/** Resolve a public file share through Nextcloud's supported APIs, without a download.
 * Run with the Nextcloud web user's identity and apc.enable_cli=1. Only local,
 * unencrypted files are eligible. Native DAV is the public-access authority and
 * is checked independently by the supervisor before publication.
 */
declare(strict_types=1);

function result(array $value): never {
    echo json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}

try {
    if ($argc !== 3 || !is_dir($argv[1]) || !preg_match('/^[A-Za-z0-9_-]{1,128}$/D', $argv[2])) {
        throw new RuntimeException('Invalid resolver arguments');
    }
    $root = realpath($argv[1]);
    define('OC_CONSOLE', 1);
    chdir($root);
    require $root . '/lib/base.php';
    // Match public.php's supported application-loading sequence so group-folder
    // and other local mount providers participate in getNode() during CLI use.
    $apps = \OCP\Server::get(\OCP\App\IAppManager::class);
    $apps->loadApps(['authentication']);
    $apps->loadApps(['extended_authentication']);
    $apps->loadApps(['filesystem', 'logging']);
    $share = \OCP\Server::get(\OCP\Share\IManager::class)->getShareByToken($argv[2]);
    $node = $share->getNode();
    if (!$node instanceof \OCP\Files\File || !$node->isReadable()) {
        result(['status' => 'unavailable']);
    }
    $storage = $node->getStorage();
    if (!$storage->isLocal() || $node->isEncrypted()) {
        result(['status' => 'unsupported']);
    }
    $path = $storage->getLocalFile($node->getInternalPath());
    $path = is_string($path) ? realpath($path) : false;
    if ($path === false || !is_file($path)) {
        result(['status' => 'unavailable']);
    }
    result(['status' => 'ready', 'fileId' => $node->getId(), 'path' => $path,
        'size' => $node->getSize(), 'etag' => $node->getEtag()]);
} catch (\OCP\Share\Exceptions\ShareNotFound | \OCP\Files\NotFoundException $error) {
    result(['status' => 'withdrawn']);
} catch (Throwable $error) {
    // Exceptions may contain private storage/configuration details; keep them off stdout.
    fwrite(STDERR, "Nextcloud share source resolution failed\n");
    exit(2);
}
