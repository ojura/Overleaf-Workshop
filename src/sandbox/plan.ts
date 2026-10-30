import { isUtf8 } from 'buffer';
import { mapLimit } from './mapLimit';

/**
 * Which writes make the sandbox hold the version to compile.
 *
 * The copy is made to hold the shared project with the local directory's files laid
 * over it:
 *
 *   in the local directory          the local file, uploaded when the copy's differs
 *   only in the shared project      the shared project's current version, copied over
 *                                   when the copy's differs (with `mirror`, only for
 *                                   paths that `keep` matches; the others are deleted)
 *   only in the copy                deleted: an earlier run uploaded it
 *
 * So a directory that holds only the files a change touches compiles against everything
 * else as it is in the shared project now, and one run does not inherit files from
 * another. Binary files are compared by the git blob SHA-1 that Overleaf reports for each
 * file in the project tree, documents by their text.
 */

export type Kind = 'doc' | 'file';

export interface RemoteFile {
    kind: Kind;
    id: string;
    /** git blob SHA-1 of a binary file's content, as the project tree reports it */
    hash?: string;
}

export interface RemoteTree {
    /** files by path, like '/slike/a.jpg' */
    files: Map<string, RemoteFile>;
    /** folder ids by path, like '/slike'; '/' is the root folder */
    folders: Map<string, string>;
}

export interface LocalFile {
    /** git blob SHA-1 of the file's bytes */
    hash: string;
    /** the text Overleaf would store if the file were a document, or undefined if it could not be one */
    text?: string;
    size: number;
}

export interface PlanOptions {
    /** the local directory is the whole project: paths it lacks are deleted unless `keep` matches them */
    mirror: boolean;
    keep: (path: string) => boolean;
}

/** Reads the documents' texts, which the project tree does not carry. */
export interface DocTexts {
    copy(path: string, file: RemoteFile): Promise<string>;
    shared(path: string, file: RemoteFile): Promise<string>;
}

export interface PlannedUpload {
    path: string;
    /** where the content comes from */
    from: 'local' | 'shared';
    /** 'missing': the copy does not have the path; 'differs': its content differs */
    reason: 'missing' | 'differs';
}

export interface Plan {
    uploads: PlannedUpload[];
    deletions: Array<{ path: string } & RemoteFile>;
    /** folders to create in the copy, each after its parent */
    folders: string[];
    /** paths whose content in the copy already is the one wanted, by where it comes from */
    unchanged: { local: string[], shared: string[] };
    /** paths that fail; nothing is written when there is one */
    problems: Array<{ path: string, message: string }>;
}

/** Overleaf's limit for a document, in characters (settings.max_doc_length). */
export const MAX_DOC_LENGTH = 2 * 1024 * 1024;

/**
 * The text Overleaf stores for `bytes` uploaded as a document, or undefined when it would
 * store them as a binary file whatever the file's name. This follows FileTypeManager and
 * FileSystemImportManager of overleaf/web: UTF-8 if the bytes are valid UTF-8, UTF-16LE
 * after a byte order mark, Latin-1 otherwise; no NUL characters, no characters outside
 * the Basic Multilingual Plane, fewer than MAX_DOC_LENGTH characters; any line ending
 * becomes "\n".
 */
export function overleafText(bytes: Uint8Array): string | undefined {
    if (bytes.byteLength > 3 * MAX_DOC_LENGTH) { return undefined; }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = isUtf8(buffer) ? buffer.toString('utf8')
        : (buffer[0] === 0xff && buffer[1] === 0xfe) ? buffer.toString('utf16le')
        : buffer.toString('latin1');
    if (text.length >= MAX_DOC_LENGTH || text.includes('\x00') || /[\uD800-\uDFFF]/.test(text)) {
        return undefined;
    }
    return text.split(/\r\n|\n|\r/).join('\n');
}

function parentOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}

/** The folders on the way to `path`, outermost first, without the root. */
function foldersOf(path: string): string[] {
    const folders: string[] = [];
    for (let folder = parentOf(path); folder !== '/'; folder = parentOf(folder)) {
        folders.unshift(folder);
    }
    return folders;
}

export async function planSync(
    local: Map<string, LocalFile>,
    copy: RemoteTree,
    shared: RemoteTree,
    options: PlanOptions,
    texts: DocTexts,
): Promise<Plan> {
    const plan: Plan = { uploads: [], deletions: [], folders: [], unchanged: { local: [], shared: [] }, problems: [] };
    const paths = [...new Set([...local.keys(), ...copy.files.keys(), ...shared.files.keys()])].sort();

    const sameAsLocal = async (path: string, wanted: LocalFile, there: RemoteFile) => {
        if (there.kind === 'file') {
            return there.hash !== undefined && there.hash === wanted.hash;
        }
        return wanted.text !== undefined && wanted.text === await texts.copy(path, there);
    };
    const sameAsShared = async (path: string, wanted: RemoteFile, there: RemoteFile) => {
        if (wanted.kind !== there.kind) { return false; }
        if (wanted.kind === 'file') {
            return wanted.hash !== undefined && wanted.hash === there.hash;
        }
        const [a, b] = await Promise.all([texts.shared(path, wanted), texts.copy(path, there)]);
        return a === b;
    };

    type Decision =
        | { type: 'upload', upload: PlannedUpload }
        | { type: 'unchanged', from: 'local' | 'shared' }
        | { type: 'delete', file: RemoteFile }
        | { type: 'problem', message: string }
        | { type: 'none' };
    const decide = async (path: string): Promise<Decision> => {
        const wantedLocal = local.get(path);
        const wantedShared = wantedLocal === undefined && (!options.mirror || options.keep(path))
            ? shared.files.get(path) : undefined;
        const there = copy.files.get(path);
        if (wantedLocal === undefined && wantedShared === undefined) {
            return there ? { type: 'delete', file: there } : { type: 'none' };
        }
        const from = wantedLocal ? 'local' : 'shared';
        if (copy.folders.has(path)) {
            return { type: 'problem', message: 'the copy has a folder at the path of this file' };
        }
        if (there === undefined) {
            return { type: 'upload', upload: { path, from, reason: 'missing' } };
        }
        const same = wantedLocal ? await sameAsLocal(path, wantedLocal, there) : await sameAsShared(path, wantedShared!, there);
        return same ? { type: 'unchanged', from } : { type: 'upload', upload: { path, from, reason: 'differs' } };
    };

    const decisions = await mapLimit(paths, 8, async (path) => {
        try {
            return await decide(path);
        } catch (error: any) {
            return { type: 'problem', message: `could not compare it: ${error?.message ?? error}` } as Decision;
        }
    });

    paths.forEach((path, index) => {
        const decision = decisions[index];
        switch (decision.type) {
            case 'upload': plan.uploads.push(decision.upload); break;
            case 'unchanged': plan.unchanged[decision.from].push(path); break;
            case 'delete': plan.deletions.push({ path, ...decision.file }); break;
            case 'problem': plan.problems.push({ path, message: decision.message }); break;
        }
    });

    const folders = new Set<string>();
    for (const upload of plan.uploads) {
        for (const folder of foldersOf(upload.path)) {
            if (copy.files.has(folder)) {
                plan.problems.push({ path: upload.path, message: `the copy has a file at ${folder}, where this file needs a folder` });
            } else if (!copy.folders.has(folder)) {
                folders.add(folder);
            }
        }
    }
    plan.folders = [...folders].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    return plan;
}
