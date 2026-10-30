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
