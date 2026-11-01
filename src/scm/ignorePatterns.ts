/**
 * The local replica's own folder in its folder, as a path of the sync ('/dir/name'), like the
 * other paths in this module: the replica's settings, the local versions it replaced, its
 * temporary files and the pointer to its window's control socket.
 */
export const REPLICA_FOLDER = '/.overleaf';

/**
 * The local replica's own folders in its folder: the replica's state (REPLICA_FOLDER) and its
 * git repository (.git). The sync leaves them out in both directions whatever the ignore
 * patterns say, and the user's patterns cannot bring them in.
 */
export const REPLICA_OWN_FOLDERS: readonly string[] = [REPLICA_FOLDER, '/.git'];

/** The replica's settings; that the file exists also marks the folder as a replica's. */
export const REPLICA_SETTINGS_FILE = `${REPLICA_FOLDER}/settings.json`;

/** Where the sync keeps the local versions that it replaced (GitReplicaStore.keepCopy). */
export const REPLICA_CONFLICTS_FOLDER = `${REPLICA_FOLDER}/conflicts`;

/**
 * Where the replica writes a file before it renames it over its target (localFolderFs.writeFile):
 * inside its own folder, so on the folder's file system, and left out of the sync.
 */
export const REPLICA_TEMPORARY_FOLDER = `${REPLICA_FOLDER}/tmp`;

/** Whether `path` (like '/dir/name') is one of the replica's own folders or inside one. */
export function isReplicaOwnPath(path: string): boolean {
    return REPLICA_OWN_FOLDERS.some(folder => path === folder || path.startsWith(`${folder}/`));
}

/**
 * Local files that a local replica does not sync by default: dot files and folders, and
 * the products of a local LaTeX build. The sandbox tool skips the same files.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
    '**/.*',
    '**/.*/**',
    '**/*.aux',
    '**/__latexindent*',
    '**/*.bbl',
    '**/*.bcf',
    '**/*.blg',
    '**/*.fdb_latexmk',
    '**/*.fls',
    '**/*.git',
    '**/*.lof',
    '**/*.log',
    '**/*.lot',
    '**/*.out',
    '**/*.run.xml',
    '**/*.synctex(busy)',
    '**/*.synctex.gz',
    '**/*.toc',
    '**/*.xdv',
    '**/main.pdf',
    '**/output.pdf',
];
