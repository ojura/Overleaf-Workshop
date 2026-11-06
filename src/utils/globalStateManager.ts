import * as vscode from 'vscode';
import { Identity, BaseAPI, ProjectPersist } from '../api/base';
import { SocketIOAPI } from '../api/socketio';
import { ExtendedBaseAPI } from '../api/extendedBase';

const keyServerPersists: string = 'overleaf-servers';
const keyPdfViewPersists: string = 'overleaf-pdf-viewers';

/** A git authentication token for the server's git bridge, kept for one account. */
export interface GitTokenPersist {
    /** what git sends as the password, with the user name "git" */
    token: string;
    /** Overleaf's id for the token, when it is known; revoking the token needs it */
    id?: string;
    createdAt?: string;
    expiresAt?: string;
}

export interface ServerPersist {
    name: string;
    url: string;
    login?: {
        userId: string;
        username: string;
        identity: Identity;
        projects?: ProjectPersist[]
    };
    /**
     * Git authentication tokens, by the user id of the login they belong to. They sit next to
     * `login` rather than in it: an expired session cookie removes `login`, and a token stays
     * valid for a year, so the next login of the same account finds it again.
     */
    gitTokens?: {[userId: string]: GitTokenPersist};
}
type ServerPersistMap = {[name: string]: ServerPersist};

export interface ProjectSCMPersist {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}
type ProjectSCMPersistMap = {[name: string]: ProjectSCMPersist};

type PdfViewPersist = {
    frequency: number,
    state: any,
};
type PdfViewPersistMap = {[uri: string]: PdfViewPersist};

export class GlobalStateManager {
    private static readonly projectRequests = new WeakMap<vscode.ExtensionContext, Map<string, symbol>>();

    static getServers(context:vscode.ExtensionContext): {server:ServerPersist, api:BaseAPI}[] {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const servers = Object.values(persists).map(persist => {
            return {
                server: persist,
                api: new BaseAPI(persist.url),
            };
        });

        if (servers.length===0) {
            const url = new URL('https://www.overleaf.com');
            this.addServer(context, url.host, url.href);
            return this.getServers(context);
        } else {
            return servers;
        }
    }

    static addServer(context:vscode.ExtensionContext, name:string, url:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]===undefined ) {
            persists[name] = { name, url };
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static removeServer(context:vscode.ExtensionContext, name:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]!==undefined ) {
            delete persists[name];
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async loginServer(context:vscode.ExtensionContext, api:BaseAPI, name:string, auth:{[key:string]:string}): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login===undefined) {
            const res = auth.cookies ? await api.cookiesLogin(auth.cookies) : await api.passportLogin(auth.email, auth.password);
            if (res.type==='success' && res.identity!==undefined && res.userInfo!==undefined) {
                server.login = {
                    userId: res.userInfo.userId,
                    username: auth.email || res.userInfo.userEmail,
                    identity: res.identity
                };
                context.globalState.update(keyServerPersists, persists);
                return true;
            } else {
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
                return false;
            }
        } else {
            return false;
        }
    }

    /**
     * Log out of the server. A logout the user asks for also removes the account's git
     * token; `keepGitToken` keeps it, for the logout after the session cookie expired.
     */
    static async logoutServer(context:vscode.ExtensionContext, api:BaseAPI, name:string, keepGitToken = false): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            await api.logout(server.login.identity);
            if (!keepGitToken && server.gitTokens) {
                delete server.gitTokens[server.login.userId];
            }
            delete server.login;
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    /** The git token of the account that is logged in to the server. */
    static getGitToken(context:vscode.ExtensionContext, name:string): GitTokenPersist | undefined {
        const server = context.globalState.get<ServerPersistMap>(keyServerPersists, {})[name];
        return server?.login ? server.gitTokens?.[server.login.userId] : undefined;
    }

    /** Keep `gitToken` for the account that is logged in to the server; false when nobody is. */
    static async setGitToken(context:vscode.ExtensionContext, name:string, gitToken:GitTokenPersist): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        if (server?.login===undefined) {
            return false;
        }
        server.gitTokens = {...server.gitTokens, [server.login.userId]: gitToken};
        await context.globalState.update(keyServerPersists, persists);
        return true;
    }

    /** Forget the git token of the account that is logged in; returns what was stored. */
    static async removeGitToken(context:vscode.ExtensionContext, name:string): Promise<GitTokenPersist | undefined> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        const stored   = server?.login ? server.gitTokens?.[server.login.userId] : undefined;
        if (stored!==undefined) {
            delete server.gitTokens![server.login!.userId];
            await context.globalState.update(keyServerPersists, persists);
        }
        return stored;
    }

    static async fetchServerProjects(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<ProjectPersist[]> {
        const initial = context.globalState.get<ServerPersistMap>(keyServerPersists, {})[name];
        const login = initial?.login;
        if (!login) { return []; }
        let owners = this.projectRequests.get(context);
        if (!owners) { owners = new Map(); this.projectRequests.set(context, owners); }
        const request = Symbol();
        owners.set(name, request);
        const current = () => {
            const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
            const server = persists[name];
            // A response belongs to the account/session that requested it, including
            // when a new login uses the same user ID after the former session ended.
            if (!server?.login || server.url !== initial.url || server.login.userId !== login.userId ||
                server.login.identity.cookies !== login.identity.cookies ||
                server.login.identity.csrfToken !== login.identity.csrfToken) { return undefined; }
            return {persists, server, login: server.login};
        };
        let res = await api.getProjectsJson(login.identity);
        if (!current() || owners.get(name) !== request) { return current()?.login.projects ?? []; }
        if (res.type !== 'success') {
            res = await api.userProjectsJson(login.identity);
        }
        const latest = current();
        if (!latest || owners.get(name) !== request) { return latest?.login.projects ?? []; }
        if (res.type === 'success' && res.projects !== undefined) {
            const projects = res.projects.map(project => ({
                ...project,
                userId: login.userId,
                // Settings may have changed while the list was loading.
                scm: latest.login.projects?.find(previous => previous.id === project.id)?.scm,
            }));
            latest.login.projects = projects;
            await context.globalState.update(keyServerPersists, latest.persists);
            return projects;
        }
        if (res.message && /^302/.test(res.message)) {
            vscode.window.showErrorMessage(vscode.l10n.t('Cookie Expired. Please Re-Login'));
            return Promise.reject();
        }
        if (res.message !== undefined) { vscode.window.showErrorMessage(res.message); }
        return [];
    }
    static authenticate(context:vscode.ExtensionContext, name:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        return server.login!==undefined ?
                Promise.resolve(server.login.identity):
                Promise.reject();
    }

    static initSocketIOAPI(context:vscode.ExtensionContext, name:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            const api = new ExtendedBaseAPI(server.url);
            const socket = new SocketIOAPI(server.url, api, server.login.identity, projectId);
            return {api, socket};
        }
    }

    static getServerProjectSCMPersists(context:vscode.ExtensionContext, serverName:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        const scmPersists = project?.scm ? project.scm as ProjectSCMPersistMap : {};
        return scmPersists;
    }

    static updateServerProjectSCMPersist(context:vscode.ExtensionContext, serverName:string, projectId:string, scmKey:string, scmPersist?:ProjectSCMPersist) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        if (project) {
            const scmPersists = (project.scm ?? {}) as ProjectSCMPersistMap;
            if (scmPersist===undefined) {
                delete scmPersists[scmKey];
            } else {
                scmPersists[scmKey] = scmPersist;
            }
            project.scm = scmPersists;
            return context.globalState.update(keyServerPersists, persists);
        }
    }

    static getPdfViewPersist(context:vscode.ExtensionContext, uri:string): any {
        return context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {})[uri]?.state;
    }

    static updatePdfViewPersist(context:vscode.ExtensionContext, uri:string, state:any) {
        const persists = context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {});

        // update record
        if (persists[uri]!==undefined) {
            persists[uri].frequency++;
            persists[uri].state = state;
        } else {
            persists[uri] = {frequency: 1, state};
        }

        // when length>=100, remove first least used record
        if (Object.keys(persists).length>=100) {
            let minFrequency = Number.MAX_SAFE_INTEGER;
            let minUri = '';
            Object.entries(persists).forEach(([uri, persist]) => {
                if (persist.frequency<minFrequency) {
                    minFrequency = persist.frequency;
                    minUri = uri;
                }
            });
            delete persists[minUri];
        }

        context.globalState.update(keyPdfViewPersists, persists);
    }

}
