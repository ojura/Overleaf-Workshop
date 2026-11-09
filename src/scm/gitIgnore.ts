import * as fs from 'fs';
import * as path from 'path';
import ignore = require('ignore');
import { isReplicaOwnPath } from './ignorePatterns';

/** Put a nested file's patterns at its directory, leaving pattern interpretation to ignore. */
function scopedPatterns(text: string, directory: string): string[] {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (!directory) { return lines; }
    const prefix = directory.replace(/[\\*?[\]]/g, '\\$&');
    return lines.flatMap(line => {
        if (!line || line.startsWith('#')) { return []; }
        const negative = line.startsWith('!');
        let pattern = negative ? line.slice(1) : line;
        // Only spaces and line endings are discarded by Git, not a literal tab in a name.
        // An escaped trailing space still leaves its backslash here, so a preceding slash
        // remains an inner separator when deciding the scope below.
        const body = pattern.replace(/[\r\n]+$/, '').replace(/ +$/, '');
        if (!body || body === '/') { return []; }
        // An escaped initial marker becomes an ordinary character after the directory prefix.
        pattern = pattern.replace(/^\\([!#])/, '$1');
        const anchored = /\/(?!$)/.test(body);
        return [`${negative ? '!' : ''}/${prefix}/${anchored ? pattern.replace(/^\//, '') : `**/${pattern}`}`];
    });
}

interface Rules {
    matcher: ignore.Ignore;
    files: Map<string, string | undefined>;
    key: string;
}

/**
 * The local .gitignore files, compiled together so nested negations and ignored parents follow
 * Git's rules. Files already tracked by Git are matched too. Other Git exclude sources belong
 * to Git alone; replica patterns and the replica's own folders are handled by their own rules.
 *
 * File events check only their ancestor rule files. Folder scans rebuild once, and concurrent
 * events share reads and compilation. Matching itself does no I/O and starts no subprocess.
 */
export class GitIgnoreMatcher {
    private rules?: Rules;
    private revision = 0;
    private loadedRevision = -1;
    private loading?: Promise<void>;
    private readonly reads = new Map<string, Promise<string | undefined>>();

    constructor(private readonly folder: string, private readonly ignoreCase = false,
                private readonly skipDirectory: (syncPath: string) => boolean = () => false) {}

    invalidate(): void { this.revision++; }

    /** The contents of the rule files, unchanged when a scan finds the same rules. */
    get key(): string | undefined { return this.rules?.key; }

    matches(syncPath: string, directory = false): boolean {
        const relative = syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
        return !!relative && !!this.rules?.matcher.ignores(relative + (directory ? '/' : ''));
    }

    /** Read the current rules after an invalidation, once for concurrent callers. */
    async refresh(): Promise<void> {
        while (this.loadedRevision !== this.revision) {
            if (!this.loading) {
                const revision = this.revision;
                this.loading = this.readAll().then(rules => {
                    if (revision === this.revision) {
                        this.rules = rules;
                        this.loadedRevision = revision;
                    }
                }).finally(() => { this.loading = undefined; });
            }
            await this.loading;
        }
    }

    /** Check rules that affect this event even if its .gitignore event has not arrived yet. */
    async refreshPath(syncPath: string): Promise<void> {
        await this.refresh();
        const parts = syncPath.replace(/^\/+/, '').split('/');
        parts.pop();
        for (let length = 0; length <= parts.length; length++) {
            const directory = parts.slice(0, length).join('/');
            if (directory && this.matches('/' + directory, true)) { break; }
            let text: string | undefined;
            try { text = await this.readRules(directory); }
            catch (error) { this.invalidate(); throw error; }
            if (text !== this.rules?.files.get(directory)) {
                this.invalidate();
                await this.refresh();
            }
        }
    }

    private readRules(directory: string): Promise<string | undefined> {
        let reading = this.reads.get(directory);
        if (!reading) {
            reading = (async () => {
                const file = path.join(this.folder, directory, '.gitignore');
                try {
                    // Git does not follow symlinks when reading .gitignore files.
                    if (!(await fs.promises.lstat(file)).isFile()) { return undefined; }
                    return await fs.promises.readFile(file, 'utf8');
                } catch (error) {
                    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return undefined; }
                    throw error;
                }
            })().finally(() => { this.reads.delete(directory); });
            this.reads.set(directory, reading);
        }
        return reading;
    }

    private async readAll(): Promise<Rules> {
        const rules: Rules = {matcher: ignore({ignorecase: this.ignoreCase}), files: new Map(), key: ''};
        const walk = async (directory: string): Promise<void> => {
            const text = await this.readRules(directory);
            rules.files.set(directory, text);
            if (text !== undefined) { rules.matcher.add(scopedPatterns(text, directory)); }
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(path.join(this.folder, directory), {withFileTypes: true}); }
            catch (error) {
                if (directory && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return; }
                throw error;
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) { continue; }
                const relative = directory ? `${directory}/${entry.name}` : entry.name;
                if (!isReplicaOwnPath('/' + relative) && !this.skipDirectory('/' + relative)
                    && !rules.matcher.ignores(relative + '/')) { await walk(relative); }
            }
        };
        await walk('');
        rules.key = JSON.stringify([...rules.files].filter(([, text]) => text !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        return rules;
    }
}
