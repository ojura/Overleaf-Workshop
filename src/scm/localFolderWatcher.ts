import * as fs from 'fs';
import * as path from 'path';

/**
 * Watches a local folder with Node's own file watching, inside the extension host.
 *
 * The IDE's file system watcher passes its events to an extension through the window. In
 * Antigravity the window stopped passing them on for hours (2026-10-31: neither this extension
 * nor LaTeX Workshop got an event for files that other programs wrote, while the IDE's watcher
 * process still watched the folder, until the window was reloaded). Node's watcher reports to
 * the extension host directly.
 *
 * On Linux it watches every folder on its own (inotify watches folders, and a folder's watch
 * reports the files in it). Node's recursive watching there (Node 22) watches each file, and
 * a file that is replaced, as an editor's atomic save or a git checkout replaces it, is
 * reported once and then never again. Elsewhere Node's recursive watching is the system's own.
 *
 * A file that is being written produces several events. Each path is reported once its events
 * have stopped for `quietMs`, so a reader does not see the file half written.
 */
export class LocalFolderWatcher {
    private watcher?: fs.FSWatcher;
    /** on Linux: the watch of each folder, by path ('' for the root, else '/dir/sub') */
    private readonly folders = new Map<string, fs.FSWatcher>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private disposed = false;

    /**
     * @param root the folder to watch
     * @param onChange a file or folder at this path ('/dir/name') was created, changed or removed
     * @param onUnknown an event that does not name its file, or the watcher stopped: look at the whole folder
     * @param skip paths to leave out, e.g. the sync's own state
     */
    constructor(
        private readonly root: string,
        private readonly onChange: (path: string) => void,
        private readonly onUnknown: (reason: string) => void,
        private readonly skip: (path: string) => boolean = () => false,
        private readonly quietMs = LocalFolderWatcher.quietMs,
        private readonly perFolder = process.platform === 'linux',
    ) {}

    /** How long the events of a path must stop before it is reported. */
    static quietMs = 300;

    /** Start watching; false, with the reason, when the folder cannot be watched this way. */
    start(): { ok: true } | { ok: false, reason: string } {
        if (this.perFolder) {
            try {
                this.watchFolder('');
            } catch (error: any) {
                this.close();
                return { ok: false, reason: String(error?.message ?? error) };
            }
            return { ok: true };
        }
        try {
            this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_event, name) => this.event(name));
        } catch (error: any) {
            return { ok: false, reason: String(error?.message ?? error) };
        }
        this.watcher.on('error', (error: any) => {
            // e.g. the folder was removed, or the system ran out of watches
            this.close();
            if (!this.disposed) { this.onUnknown(`the watcher stopped: ${error?.message ?? error}`); }
        });
        return { ok: true };
    }

    /** Watch the folder at `dir` ('' for the root) and the folders below it; throws when the root cannot be watched. */
    private watchFolder(dir: string) {
        if (this.disposed || this.folders.has(dir)) { return; }
        const abs = path.join(this.root, dir);
        const watcher = fs.watch(abs, { persistent: false }, (event, name) => {
            if (name === null || name === undefined || name.length === 0) {
                this.onUnknown('an event without a file name');
                return;
            }
            const p = `${dir}/${name}`;
            if (this.skip(p)) { return; }
            // an entry created, removed or moved: it may be a folder to watch, or one to stop watching
            if (event === 'rename') { this.folderEntry(p); }
            this.report(p);
        });
        watcher.on('error', (error: any) => {
            this.unwatch(dir);
            if (dir === '' && !this.disposed) { this.onUnknown(`the watcher stopped: ${error?.message ?? error}`); }
        });
        this.folders.set(dir, watcher);
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { /* gone meanwhile; its parent reports that */ }
        for (const entry of entries) {
            const p = `${dir}/${entry.name}`;
            if (entry.isDirectory() && !this.skip(p)) {
                try { this.watchFolder(p); } catch { /* gone meanwhile, or the system ran out of watches: the scans find its changes */ }
            }
        }
    }

    /** An entry at `p` appeared, changed or went away: watch it when it is a new folder, and report the files it holds. */
    private folderEntry(p: string) {
        let isFolder = false;
        try { isFolder = fs.lstatSync(path.join(this.root, p)).isDirectory(); } catch { /* gone */ }
        if (!isFolder) {
            if (this.folders.has(p)) { this.unwatch(p); }
            return;
        }
        // a folder moved in, or replaced: watch it anew, and report what it holds
        this.unwatch(p);
        try { this.watchFolder(p); } catch { return; }
        const walk = (dir: string) => {
            let entries: fs.Dirent[] = [];
            try { entries = fs.readdirSync(path.join(this.root, dir), { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const q = `${dir}/${entry.name}`;
                if (this.skip(q)) { continue; }
                if (entry.isDirectory()) { walk(q); } else { this.report(q); }
            }
        };
        walk(p);
    }

    /** Stop watching the folder at `dir` and the folders below it. */
    private unwatch(dir: string) {
        for (const [p, watcher] of [...this.folders]) {
            if (p === dir || p.startsWith(`${dir}/`)) {
                watcher.close();
                this.folders.delete(p);
            }
        }
    }

    private event(name: string | Buffer | null) {
        if (this.disposed) { return; }
        if (name === null || name === undefined || name.length === 0) {
            this.onUnknown('an event without a file name');
            return;
        }
        const relative = (typeof name === 'string' ? name : name.toString('utf8')).split(path.sep).join('/');
        const p = `/${relative}`;
        if (this.skip(p)) { return; }
        this.report(p);
    }

    /** Report `p` once its events have stopped for `quietMs`. */
    private report(p: string) {
        if (this.disposed) { return; }
        clearTimeout(this.timers.get(p));
        this.timers.set(p, setTimeout(() => {
            this.timers.delete(p);
            if (!this.disposed) { this.onChange(p); }
        }, this.quietMs));
    }

    private close() {
        this.watcher?.close();
        this.watcher = undefined;
        this.folders.forEach(watcher => watcher.close());
        this.folders.clear();
    }

    dispose() {
        this.disposed = true;
        this.close();
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
    }
}
