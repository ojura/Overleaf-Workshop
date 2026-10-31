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
 * A file that is being written produces several events. Each path is reported once its events
 * have stopped for `quietMs`, so a reader does not see the file half written.
 */
export class LocalFolderWatcher {
    private watcher?: fs.FSWatcher;
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
    ) {}

    /** How long the events of a path must stop before it is reported. */
    static quietMs = 300;

    /** Start watching; false, with the reason, when the folder cannot be watched this way. */
    start(): { ok: true } | { ok: false, reason: string } {
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

    private event(name: string | Buffer | null) {
        if (this.disposed) { return; }
        if (name === null || name === undefined || name.length === 0) {
            this.onUnknown('an event without a file name');
            return;
        }
        const relative = (typeof name === 'string' ? name : name.toString('utf8')).split(path.sep).join('/');
        const p = `/${relative}`;
        if (this.skip(p)) { return; }
        clearTimeout(this.timers.get(p));
        this.timers.set(p, setTimeout(() => {
            this.timers.delete(p);
            if (!this.disposed) { this.onChange(p); }
        }, this.quietMs));
    }

    private close() {
        this.watcher?.close();
        this.watcher = undefined;
    }

    dispose() {
        this.disposed = true;
        this.close();
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
    }
}
