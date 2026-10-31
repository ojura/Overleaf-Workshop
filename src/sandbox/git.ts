/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { gitProjectUrl } from '../api/gitBridge';

/** git's credential protocol: one key=value per line, ended by an empty line or the input's end. */
export function parseCredentialInput(text: string): Record<string, string> {
    const request: Record<string, string> = {};
    for (const line of text.split('\n')) {
        if (line === '') { break; }
        const eq = line.indexOf('=');
        if (eq > 0) { request[line.slice(0, eq)] = line.slice(eq + 1); }
    }
    return request;
}

/**
 * The credential helper's answer to git's `action` ('get', 'store' or 'erase'): user name git
 * and the token, for the bridge's host only. git also tells every helper about a password that
 * worked (store) or failed (erase); the token is kept by the extension, so those get no answer.
 */
export function credentialAnswer(action: string, request: Record<string, string>, bridgeUrl: string, token: string | undefined): string {
    const bridge = new URL(bridgeUrl);
    if (action !== 'get' || !token || request.protocol !== bridge.protocol.replace(/:$/, '') || request.host !== bridge.host) {
        return '';
    }
    return `username=git\npassword=${token}\n`;
}

/** The node binary for a helper that git starts later: a snap's revision folder replaced by its "current" link. */
export function stableNodePath(execPath: string): string {
    return execPath.replace(/^(\/snap\/[^/]+\/)\d+\//, '$1current/');
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The value of credential.<bridge>.helper that makes git ask this tool for the token of
 * `serverName`. It holds paths and names only; git starts it with the shell.
 */
export function credentialHelperCommand(nodePath: string, cliPath: string, serverName: string, bridgeUrl: string): string {
    return `!${shellQuote(nodePath)} ${shellQuote(cliPath)} git-credential --server ${shellQuote(serverName)} --bridge ${shellQuote(bridgeUrl)}`;
}

export type RunGit = (args: string[]) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'error'>;

/** git with its progress on this process's stderr; it never asks on the terminal. */
export const runGit: RunGit = args => spawnSync('git', args, {
    stdio: ['ignore', process.stderr, process.stderr],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});

function check(result: ReturnType<RunGit>, what: string) {
    if (result.error) { throw new Error(`${what}: ${result.error.message}`); }
    if (result.status !== 0) { throw new Error(`${what} failed with exit status ${result.status}`); }
}

/**
 * The credential settings of a clone: an empty value first, which drops the helpers of the
 * user's and the system's git configuration for the bridge, so that none of them is handed
 * the token to store; then this tool.
 */
export function credentialConfig(bridgeUrl: string, helper: string): Array<[string, string]> {
    const key = `credential.${bridgeUrl.replace(/\/+$/, '')}.helper`;
    return [[key, ''], [key, helper]];
}

/**
 * Clone `projectId` from the bridge into `into`, with the token from this tool's credential
 * helper, and keep the helper in the clone's own configuration, so that a later git fetch or
 * pull in it works the same way. Neither the address nor the configuration holds the token.
 */
export function cloneProject(options: { bridgeUrl: string, projectId: string, into: string, helper: string }, git: RunGit = runGit) {
    const settings = credentialConfig(options.bridgeUrl, options.helper);
    check(git([...settings.flatMap(([key, value]) => ['-c', `${key}=${value}`]), 'clone', '--', gitProjectUrl(options.bridgeUrl, options.projectId), options.into]),
          'git clone');
    check(git(['-C', options.into, 'config', '--local', '--replace-all', settings[0][0], settings[0][1]]), 'git config');
    check(git(['-C', options.into, 'config', '--local', '--add', settings[1][0], settings[1][1]]), 'git config');
}

/** git fetch in a clone that cloneProject made. */
export function fetchProject(options: { into: string }, git: RunGit = runGit) {
    check(git(['-C', options.into, 'fetch']), 'git fetch');
}
