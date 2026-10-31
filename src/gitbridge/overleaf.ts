/**
 * The parts of the git-bridge tools that use the Overleaf Workshop extension's login: a
 * remote for the bridge that gets the git token the extension keeps (src/sandbox/git.ts's
 * credential helper), and the check of comments and tracked changes before a push
 * (src/sandbox/rangesCli.ts).
 */
import * as path from 'path';
import { gitProjectUrl, knownGitBridgeUrl } from '../api/gitBridge';
import { OverleafClient } from '../sandbox/client';
import { credentialConfig, credentialHelperCommand, stableNodePath } from '../sandbox/git';
import { readStoredLogin } from '../sandbox/login';
import { Finding } from '../sandbox/ranges';
import { describeFindings, pushCheck } from '../sandbox/rangesCli';
import { CheckAnswer, PrePushCheck } from './flow';
import { Repo } from './plumbing';

/** The private-copy tool's command line, which answers git as the credential helper (git-credential). */
const SANDBOX_CLI = path.join(__dirname, '..', 'sandbox', 'cli.js');

/**
 * Add `remote` for the project's address on the git bridge, with the credential settings
 * git-clone gives a clone: git then asks the private-copy tool for the token, which the
 * extension keeps next to its login. Neither the address nor the configuration holds it.
 */
export function addBridgeRemote(repo: Repo, options: { remote: string, projectId: string, serverName: string, bridgeUrl?: string }) {
    const login = readStoredLogin(options.serverName);
    const bridgeUrl = options.bridgeUrl ?? knownGitBridgeUrl(login.url);
    if (!bridgeUrl) { throw new Error(`the git bridge of ${options.serverName} is not known; give --bridge <url>`); }
    if (!login.gitToken) { throw new Error(`no git token is stored for ${options.serverName}; store one with the extension (Overleaf Workshop: Git Token...)`); }
    const url = gitProjectUrl(bridgeUrl, options.projectId);
    repo.run(['remote', 'add', options.remote, url]);
    const [reset, helper] = credentialConfig(bridgeUrl, credentialHelperCommand(stableNodePath(process.execPath), SANDBOX_CLI, options.serverName, bridgeUrl));
    repo.run(['config', '--local', '--replace-all', reset[0], reset[1]]);
    repo.run(['config', '--local', '--add', helper[0], helper[1]]);
    return { url, bridgeUrl };
}

/**
 * What the push may do, from the check's findings: "refuse" stops it, and "warn" stops it
 * too unless `acceptWarnings`.
 */
export function answerFromFindings(findings: Finding[], summary: string, acceptWarnings: boolean): CheckAnswer {
    const refused = findings.some(f => f.severity === 'refuse');
    const warned = findings.some(f => f.severity === 'warn');
    const message = describeFindings(findings, summary).trimEnd();
    if (refused) { return { ok: false, message }; }
    if (warned && !acceptWarnings) { return { ok: false, message: `${message}\n(--accept-warnings pushes anyway)` }; }
    return { ok: true, message };
}

/** The check of comments and tracked changes on Overleaf, before each push, as the extension's user. */
export function rangesCheck(options: { serverName: string, projectId: string, acceptWarnings: boolean }): PrePushCheck {
    return async (repo, from, to) => {
        const login = readStoredLogin(options.serverName);
        const client = new OverleafClient(login.url, login.identity);
        const { findings, summary } = await pushCheck(client, { repo: repo.dir, from, to, project: options.projectId, userId: login.userId });
        return answerFromFindings(findings, summary, options.acceptWarnings);
    };
}
