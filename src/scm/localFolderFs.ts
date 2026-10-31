import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * The local replica's access to its folder on disk, with Node's own file functions in the
 * extension host.
 *
 * The replica does not use vscode.workspace.fs for its folder: each of its calls first asks the
 * window's main thread to activate the scheme's provider (`$ensureActivation`), even for a local
 * `file:` path that the extension host could read itself. While the window does not run, for
 * example while it is frozen in the background, that question is not answered, and every read,
 * write and upload of the replica would wait with it. Measured in a test window: with its page
 * frozen, a file written into the replica was not uploaded within 60 s, and `replica-sync` timed out.
 *
 * Paths are absolute file system paths. Types and times follow vscode.FileStat, so the saved sync
 * state compares the same way whichever API wrote it: `type` uses vscode.FileType's values, and
 * `mtime` and `ctime` are whole milliseconds, as the IDE's own disk provider reports them.
 */
export const fileType = { unknown: 0, file: 1, directory: 2, symbolicLink: 64 } as const;

export interface LocalStat { type: number, size: number, mtime: number, ctime: number }

type PathLike = string | { fsPath: string };
const fsPath = (p: PathLike) => typeof p === 'string' ? p : p.fsPath;

/**
 * Whether a failed call says that the path does not exist: ENOENT, or ENOTDIR when a folder on
 * the way is a file. Any other error (EACCES, EIO, ...) leaves open what is at the path.
 */
export function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Which folder or file is at a path: its device and inode, as strings, which keep every digit. */
export async function identity(p: PathLike): Promise<{ dev: string, ino: string }> {
    const stat = await fsp.stat(fsPath(p), { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** Whether anything is at a path, a link included; rejects when that cannot be told. */
export async function exists(p: PathLike): Promise<boolean> {
    try {
        await fsp.lstat(fsPath(p));
        return true;
    } catch (error) {
        if (isMissing(error)) { return false; }
        throw error;
    }
}

function typeOf(stat: { isFile(): boolean, isDirectory(): boolean }) {
    return stat.isDirectory() ? fileType.directory : stat.isFile() ? fileType.file : fileType.unknown;
}

/** The stat of a path, following a symbolic link; the type carries SymbolicLink for a link, as the IDE's does. */
export async function stat(p: PathLike): Promise<LocalStat> {
    const file = fsPath(p);
    const target = await fsp.stat(file);
    let type: number = typeOf(target);
    if ((await fsp.lstat(file)).isSymbolicLink()) { type |= fileType.symbolicLink; }
    return { type, size: target.size, mtime: target.mtime.getTime(), ctime: target.ctime.getTime() };
}

/** A folder's entries with their types; a link has SymbolicLink and its target's type (none when broken). */
export async function readDirectory(p: PathLike): Promise<[string, number][]> {
    const folder = fsPath(p);
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    return Promise.all(entries.map(async (entry): Promise<[string, number]> => {
        if (!entry.isSymbolicLink()) { return [entry.name, typeOf(entry)]; }
        try {
            return [entry.name, fileType.symbolicLink | typeOf(await fsp.stat(path.join(folder, entry.name)))];
        } catch {
            return [entry.name, fileType.symbolicLink];
        }
    }));
}

export async function readFile(p: PathLike): Promise<Uint8Array> {
    const buffer = await fsp.readFile(fsPath(p));
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The temporary files of the writes under way, by absolute path. */
const writing = new Set<string>();

/** Whether `p` is the temporary file of a write under way, which a listing leaves out. */
export function isWriting(p: PathLike): boolean {
    return writing.has(fsPath(p));
}

/**
 * Write a file, creating its parent folders. The content goes into a temporary file in the
 * target's folder, which then replaces the target in one rename: a reader, or a crash, sees the
 * old content or the new one, never a part of it. The target keeps its mode. A symbolic link to
 * a file stays as it is, and the file it points to is the one replaced.
 */
export async function writeFile(p: PathLike, content: Uint8Array): Promise<void> {
    const file = fsPath(p);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let target = file;
    let mode: number | undefined;
    try {
        if ((await fsp.lstat(file)).isSymbolicLink()) { target = await fsp.realpath(file); }
        mode = (await fsp.stat(target)).mode & 0o7777;
    } catch (error) {
        if (!isMissing(error)) { throw error; }
    }
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    writing.add(temporary);
    try {
        const handle = await fsp.open(temporary, 'wx');
        try {
            await handle.writeFile(content);
            // the mode of `open` is reduced by the umask; chmod sets the target's exactly
            if (mode !== undefined) { await handle.chmod(mode); }
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fsp.rename(temporary, target);
    } catch (error) {
        await fsp.rm(temporary, { force: true });
        throw error;
    } finally {
        writing.delete(temporary);
    }
}

export async function createDirectory(p: PathLike): Promise<void> {
    await fsp.mkdir(fsPath(p), { recursive: true });
}

/** Delete a file, or a folder with `recursive`; a missing path is an error, as with the IDE's delete. */
export async function remove(p: PathLike, options?: { recursive?: boolean }): Promise<void> {
    const file = fsPath(p);
    const target = await fsp.lstat(file);
    if (target.isDirectory()) {
        await (options?.recursive ? fsp.rm(file, { recursive: true }) : fsp.rmdir(file));
    } else {
        await fsp.unlink(file);
    }
}

/** Rename, replacing what is at the target, as `{overwrite: true}` does. */
export async function rename(from: PathLike, to: PathLike): Promise<void> {
    await fsp.rename(fsPath(from), fsPath(to));
}

/**
 * Move a file to the system trash without the window: on Linux through `gio trash`, the GLib
 * implementation of the freedesktop.org trash that the IDE itself uses there. Answers false when
 * that is not possible here, e.g. on another system or without gio; the caller then decides.
 */
export function trash(p: PathLike): Promise<boolean> {
    if (process.platform !== 'linux') { return Promise.resolve(false); }
    return new Promise(resolve => {
        execFile('gio', ['trash', '--', fsPath(p)], { timeout: 30000 }, error => resolve(error === null));
    });
}
