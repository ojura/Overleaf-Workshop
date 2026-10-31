/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */
import { fetch } from 'undici';
import type { GitTokenInfo } from './base';

/**
 * Git bridges whose address is known without asking the server. Every project's editor page
 * publishes its server's bridge in the meta tag ol-gitBridgePublicBaseUrl, which project-info reads.
 */
const KNOWN_GIT_BRIDGES: Readonly<Record<string, string>> = {
    'www.overleaf.com': 'https://git.overleaf.com',
};

/**
 * A project id that no project can have. A MongoDB ObjectId begins with the second it was
 * made, and this one's is 0, in 1970. The token check asks the bridge for this project, so it
 * names no real project, and the bridge has no project to make a commit in.
 */
export const NO_PROJECT_ID = '000000000000000000000000';

/** The git bridge of the server at `serverUrl`, when it is one of the known ones. */
export function knownGitBridgeUrl(serverUrl: string): string | undefined {
    return KNOWN_GIT_BRIDGES[new URL(serverUrl).host];
}

/** The address to clone `projectId` from. It never holds a token: git asks the credential helper. */
export function gitProjectUrl(bridgeUrl: string, projectId: string): string {
    return `${bridgeUrl.replace(/\/+$/, '')}/${projectId}`;
}

export type GitTokenCheck = 'accepted' | 'rejected';

/**
 * Whether the git bridge at `bridgeUrl` accepts `token`, asked without touching a project.
 *
 * The check sends git's first request, the list of refs, for NO_PROJECT_ID. The bridge
 * checks the login before it looks for the project: it answers 401 when the token is wrong,
 * expired or revoked, and 200 with the git error "no git access" when the token is valid
 * (measured on git.overleaf.com on 2026-10-31). Any other answer throws, so a changed bridge
 * shows up as an error rather than as a wrong result. A check counts as a use of the token:
 * Account Settings then shows it as the token's last use.
 */
export async function checkGitToken(bridgeUrl: string, token: string): Promise<GitTokenCheck> {
    const res = await fetch(`${gitProjectUrl(bridgeUrl, NO_PROJECT_ID)}/info/refs?service=git-upload-pack`, {
        headers: {
            'Authorization': `Basic ${Buffer.from(`git:${token}`).toString('base64')}`,
            'User-Agent': 'git/2.43.0 (overleaf-workshop token check)',
        },
        redirect: 'manual',
    });
    const body = await res.text();
    if (res.status === 401) {
        return 'rejected';
    }
    if (res.status === 200 && body.includes('ERR ')) {
        return 'accepted';
    }
    throw new Error(`the git bridge at ${bridgeUrl} answered the token check with HTTP ${res.status}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
}

/** What is known about the stored git token: its entry in Account Settings' list, and the bridge's answer. */
export interface GitTokenStatus {
    stored: boolean;
    check?: GitTokenCheck;
    checkError?: string;
    /** the entry of Account Settings' list that the stored token belongs to */
    listed?: GitTokenInfo;
    listError?: string;
}

const day = (iso?: string) => iso ? iso.slice(0, 10) : 'never';

/**
 * The stored token's entry in Account Settings' list, and whether the bridge accepts it.
 * The list comes first: the check counts as a use of the token, and would show up as its
 * last one.
 */
export async function gitTokenStatus(listTokens: () => Promise<GitTokenInfo[]>, token: string, bridgeUrl?: string): Promise<GitTokenStatus> {
    const status: GitTokenStatus = { stored: true };
    try {
        const matches = (await listTokens()).filter(entry => entry.accessTokenPartial && token.startsWith(entry.accessTokenPartial));
        if (matches.length === 1) {
            status.listed = matches[0];
        } else {
            status.listError = matches.length ? `${matches.length} tokens in Account Settings begin like the stored one`
                                              : 'Account Settings does not list a token that begins like the stored one';
        }
    } catch (error: any) {
        status.listError = error?.message ?? String(error);
    }
    if (bridgeUrl) {
        try {
            status.check = await checkGitToken(bridgeUrl, token);
        } catch (error: any) {
            status.checkError = error?.message ?? String(error);
        }
    } else {
        status.checkError = 'the git bridge of this server is not known';
    }
    return status;
}

/** One line about the stored token, as project-info and git-token print it. */
export function formatGitTokenStatus(token: GitTokenStatus): string {
    if (!token.stored) {
        return 'git token: none stored; store one with the extension (Overleaf Workshop: Git Token...)';
    }
    const check = token.check === 'accepted' ? 'the bridge accepts it'
        : token.check === 'rejected' ? 'the bridge REJECTS it (wrong, expired or revoked)'
        : `not checked: ${token.checkError}`;
    const listed = token.listed
        ? `Account Settings lists it as ${token.listed.accessTokenPartial}..., created ${day(token.listed.createdAt)}, expires ${day(token.listed.accessTokenExpiresAt)}, last used before this check ${day(token.listed.lastUsedAt)}`
        : `not matched in Account Settings: ${token.listError}`;
    return `git token: stored; ${check}; ${listed}`;
}
