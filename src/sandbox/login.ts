import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Identity } from '../api/base';

/** The login that the Overleaf Workshop extension keeps for one server. */
export interface StoredLogin {
    /** e.g. https://www.overleaf.com/ */
    url: string;
    userId: string;
    identity: Identity;
    /**
     * The account's git authentication token, when the extension keeps one: in the server's
     * `gitTokens`, by user id (GlobalStateManager.setGitToken).
     */
    gitToken?: string;
    /** where it was read from */
    source: string;
}

/** Where VS Code and its variants keep the extensions' global state, on this platform. */
export function stateDatabaseCandidates(): string[] {
    const apps = ['Antigravity IDE', 'Antigravity', 'Code', 'Code - OSS', 'VSCodium', 'Cursor', 'Code - Insiders'];
    const home = os.homedir();
    const roots = process.platform === 'darwin' ? [path.join(home, 'Library', 'Application Support')]
        : process.platform === 'win32' ? [process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')]
        : [process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')];
    return roots.flatMap(root => apps.map(app => path.join(root, app, 'User', 'globalStorage', 'state.vscdb')));
}

/** The extension's state from one state database, opened read-only. */
function readExtensionState(file: string): any | undefined {
    // node:sqlite exists from Node 22.5 and warns that it is experimental when it loads
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: any, ...rest: any[]) => {
        if (String(warning?.message ?? warning).includes('SQLite')) { return; }
        return (emitWarning as any).call(process, warning, ...rest);
    }) as any;
    let sqlite: any;
    try {
        sqlite = require('node:sqlite');
    } catch {
        throw new Error(`reading ${file} needs Node 22.5 or later (node:sqlite); this is Node ${process.versions.node}. Set OVERLEAF_LOGIN instead.`);
    } finally {
        process.emitWarning = emitWarning;
    }
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('iamhyc.overleaf-workshop');
        return row ? JSON.parse(String(row.value)) : undefined;
    } finally {
        db.close();
    }
}

/**
 * The login for `serverName` (e.g. www.overleaf.com). From the environment variable
 * OVERLEAF_LOGIN when it is set, a JSON object {url, cookies, csrfToken, userId, gitToken?};
 * otherwise from the state database `stateDb`, or the first of the usual ones that has a login.
 */
export function readStoredLogin(serverName: string, stateDb?: string): StoredLogin {
    const fromEnv = process.env.OVERLEAF_LOGIN;
    if (fromEnv) {
        const value = JSON.parse(fromEnv);
        const csrfToken = value.csrfToken ?? value.csrf;
        if (!value.url || !value.cookies || !csrfToken || !value.userId) {
            throw new Error('OVERLEAF_LOGIN needs url, cookies, csrfToken and userId');
        }
        return { url: value.url, userId: value.userId, identity: { cookies: value.cookies, csrfToken },
                 gitToken: value.gitToken || undefined, source: 'OVERLEAF_LOGIN' };
    }
    const candidates = stateDb ? [stateDb] : stateDatabaseCandidates().filter(file => fs.existsSync(file));
    const tried: string[] = [];
    for (const file of candidates) {
        const state = readExtensionState(file);
        const server = state?.['overleaf-servers']?.[serverName];
        const login = server?.login;
        if (login?.identity?.cookies && login?.identity?.csrfToken && login?.userId) {
            const gitToken: string | undefined = server.gitTokens?.[login.userId]?.token || undefined;
            return { url: server.url, userId: login.userId, identity: login.identity, gitToken, source: file };
        }
        tried.push(file);
    }
    throw new Error(`no Overleaf Workshop login for ${serverName} in ${tried.length ? tried.join(', ') : 'any state database'}; log in with the extension first, or set OVERLEAF_LOGIN`);
}
