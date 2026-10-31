import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { BaseAPI, GitTokenInfo, Identity, ProjectTagsResponseSchema } from '../api/base';
import { checkGitToken, formatGitTokenStatus, gitTokenStatus, knownGitBridgeUrl } from '../api/gitBridge';
import { GitTokenPersist, GlobalStateManager } from '../utils/globalStateManager';
import { VirtualFileSystem, parseUri } from './remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { OverleafClient } from '../sandbox/client';
import { formatProjectInfo, gatherProjectInfo } from '../sandbox/projectInfo';

class DataItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);
    }
}

class ServerItem extends DataItem {
    tags?: {name:string, tid:string}[];
    constructor(
        readonly api: any,
        public readonly name: string,
        public readonly username: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(name, collapsibleState);
        this.iconPath = new vscode.ThemeIcon('vm');
        this.contextValue = collapsibleState===vscode.TreeItemCollapsibleState.None ? 'server_no_login' : 'server_login';
        this.description = username;
        this.tooltip = api.url;
    }
}

class TagItem extends DataItem {
    constructor(
        readonly api: any,
        public readonly serverName: string,
        public readonly tid: string,
        public readonly name: string,
        readonly projects: ProjectItem[],
    ) {
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'tag';
    }
}

class ProjectItem extends DataItem {
    tag?: {name:string, tid:string};
    constructor(
        readonly api: any,
        readonly uri: string,
        readonly parent: ServerItem,
        readonly pid: string,
        readonly label: string,
        readonly status: 'normal' | 'archived' | 'trashed',
    ) {
        const _label = status==='normal' ? label : `[${status}] ${label}`;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = _label;
        this.setStatus(status);
    }

    static clone(project: ProjectItem) {
        return new ProjectItem(project.api, project.uri, project.parent, project.pid, project.label, project.status);
    }

    setStatus(status:'normal' | 'archived' | 'trashed') {
        switch (status) {
            case 'normal':
                this.contextValue = 'project';
                this.iconPath = new vscode.ThemeIcon('notebook');
                break;
            case 'archived':
                this.contextValue = 'archived_project';
                this.iconPath = new vscode.ThemeIcon('archive');
                break;
            case 'trashed':
                this.contextValue = 'trashed_project';
                this.iconPath = new vscode.ThemeIcon('trash');
        }
    }
}

export class ProjectManagerProvider implements vscode.TreeDataProvider<DataItem> {
    constructor(
        private context:vscode.ExtensionContext) {
        this.context = context;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<DataItem | undefined | void> = new vscode.EventEmitter<DataItem | undefined | void>();

    readonly onDidChangeTreeData: vscode.Event<DataItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DataItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DataItem): Thenable<DataItem[]> {
        if (element) {
            if (element instanceof ServerItem) {
                return GlobalStateManager.fetchServerProjects(this.context, element.api, element.name)
                .catch(() => {
                    // Direct logout if cookie expired; the account's git token stays valid
                    GlobalStateManager.logoutServer(this.context, element.api, element.name, true)
                    .then(success => {
                        if (success) {
                            this.refresh();
                        }
                    });
                    return Promise.reject();
                })
                .then(projects => {
                    return GlobalStateManager.authenticate(this.context, element.name)
                    .then(identity => element.api.getAllTags(identity))
                    .then(res => 
                        res.type==='success' ? res.tags as ProjectTagsResponseSchema[] : []
                    )
                    .then(tags => {
                        return {projects, tags};
                    });
                })
                .then(({projects, tags}) => {
                    const allTags:{name:string, tid:string}[] = [];
                    // get project items
                    const normalProjects = [], trashedProjects = [], archivedProjects = [];
                    for (const project of projects) {
                        const uri = `${ROOT_NAME}://${element.name}/${encodeURIComponent(project.name)}?user=${project.userId}&project=${project.id}`;
                        const status = project.archived ? 'archived' : project.trashed ? 'trashed' : 'normal';
                        const item = new ProjectItem(element.api, uri, element, project.id, project.name, status);
                        switch (status) {
                            case 'normal': normalProjects.push(item); break;
                            case 'archived': archivedProjects.push(item); break;
                            case 'trashed': trashedProjects.push(item); break;
                        }
                    }
                    const allProjectItems = [...normalProjects, ...archivedProjects, ...trashedProjects];
                    // create tag items
                    const tagProjectItems:TagItem[] = tags.map(tag => {
                        const _tag = {name:tag.name, tid:tag._id};
                        allTags.push( _tag );
                        const _projects:ProjectItem[] = tag.project_ids.map(pid => {
                            const item = allProjectItems.find(project => project.pid===pid);
                            if (item) {
                                const _item = ProjectItem.clone(item);
                                item.tag = _tag; // for filter purpose
                                _item.contextValue = 'project_in_tag';
                                _item.tag = _tag;
                                return _item;
                            }
                        }).filter(item => item) as ProjectItem[];
                        return new TagItem(element.api, element.name, tag._id, tag.name, _projects);
                    });
                    // get remaining projects
                    const remainingProjects = allProjectItems.filter(project => !project.tag);
                    // return all items
                    element.tags = allTags;
                    return [...tagProjectItems, ...remainingProjects];
                });
            } else if (element instanceof TagItem) {
                return Promise.resolve(element.projects);
            } else {
                return Promise.resolve([]);
            }
        } else {
            const persists = GlobalStateManager.getServers(this.context);
            const serverItems = Object.values(persists).map(persist => new ServerItem(
                persist.api,
                persist.server.name,
                persist.server.login?.username || '',
                persist.server.login? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            ));
            return Promise.resolve(serverItems);
        }
    }

    addServer() {
        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Overleaf server address, e.g. "https://www.overleaf.com"')})
        .then((url) => {
            if (url) {
                try {
                    // check if url is valid
                    const _url = new URL(url);
                    if (!(_url.protocol==='http:' || _url.protocol==='https:')) {
                        throw new Error( vscode.l10n.t('Invalid protocol.') );
                    }
                    if (GlobalStateManager.addServer(this.context, _url.host, _url.href)) {
                        this.refresh();
                    }
                } catch (e) {
                    vscode.window.showErrorMessage( vscode.l10n.t('Invalid server address.') );
                }
            }
        });
    }

    removeServer(name:string) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove server "{name}" ?', {name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                if (GlobalStateManager.removeServer(this.context, name)) {
                    this.refresh();
                }
            }
        });
    }

    loginServer(server: ServerItem) {
        const loginMethods:Record<string, ()=>void> = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Password': () => {
                vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Email')})
                .then(email => email ? Promise.resolve(email) : Promise.reject())
                .then(email =>
                    vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Password'), 'password': true})
                    .then(password => {
                        return password ? Promise.resolve([email,password]) : Promise.reject();
                    })
                )
                .then(([email,password]) =>
                    GlobalStateManager.loginServer(this.context, server.api, server.name, {email, password})
                )
                .then(success => {
                    if (success) {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage( vscode.l10n.t('Login failed.') );
                    }
                });
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Cookies': () => {
                vscode.window.showInputBox({
                    'placeHolder': vscode.l10n.t('Cookies, e.g., "sharelatex.sid=..." or "overleaf_session2=..."'),
                    'prompt': vscode.l10n.t('README: [How to Login with Cookies](https://github.com/overleaf-workshop/overleaf-workshop#how-to-login-with-cookies)'),
                })
                .then(cookies => cookies ? Promise.resolve(cookies) : Promise.reject())
                .then(cookies =>
                    GlobalStateManager.loginServer(this.context, server.api, server.name, {cookies})
                )
                .then(success => {
                    if (success) {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage( vscode.l10n.t('Login failed.') );
                    }
                });
            },
        };

        //NOTE: temporarily disable password-based login for `www.overleaf.com`
        if (server.name==='www.overleaf.com') {
            delete loginMethods['Login with Password'];
        }

        vscode.window.showQuickPick(Object.keys(loginMethods), {
            canPickMany:false, placeHolder:vscode.l10n.t('Select the login method below.')})
        .then(selection => {
            if (selection===undefined) { return Promise.reject(); }
            return Promise.resolve( (loginMethods as any)[selection] );
        })
        .then(method => method());
    }

    logoutServer(server: ServerItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Logout server "{name}" ?', {name:server.name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.logoutServer(this.context, server.api, server.name)
                .then(success => {
                    if (success) {
                        this.refresh();
                    }
                });
            }
        });
    }

    refreshServer(server: ServerItem) {
        this.refresh();
    }

    /** The logged-in server to act on: the tree's item, the only logged-in server, or one the user picks. */
    private async loggedInServer(server?: {name: string}): Promise<{name: string, url: string, api: BaseAPI, username: string} | undefined> {
        const loggedIn = GlobalStateManager.getServers(this.context).filter(({server}) => server.login!==undefined)
            .map(({server, api}) => ({name: server.name, url: server.url, api, username: server.login!.username}));
        if (server) {
            return loggedIn.find(s => s.name===server.name);
        }
        if (loggedIn.length<=1) {
            return loggedIn[0];
        }
        const picked = await vscode.window.showQuickPick(loggedIn.map(s => ({label: s.name, description: s.username})),
                                                         {placeHolder: vscode.l10n.t('Select a server')});
        return loggedIn.find(s => s.name===picked?.label);
    }

    /** Overleaf's id and dates for `token`, from Account Settings' list, matched by its first characters. */
    private async describeGitToken(api: BaseAPI, identity: Identity, token: string): Promise<GitTokenPersist> {
        const res = await api.listGitTokens(identity);
        const matches = (res.gitTokens ?? []).filter((entry: GitTokenInfo) => entry.accessTokenPartial && token.startsWith(entry.accessTokenPartial));
        const entry = matches.length===1 ? matches[0] : undefined;
        return {token, id: entry?._id, createdAt: entry?.createdAt, expiresAt: entry?.accessTokenExpiresAt};
    }

    /**
     * Keep, create, check or remove the git token of a logged-in account. The token is stored
     * with the login, in the extension's global state (GlobalStateManager.setGitToken), where
     * the command-line tool reads it too.
     */
    async manageGitToken(item?: ServerItem) {
        const server = await this.loggedInServer(item);
        if (server===undefined) {
            vscode.window.showErrorMessage(vscode.l10n.t('Log in to a server first.'));
            return;
        }
        const identity = await GlobalStateManager.authenticate(this.context, server.name);
        const bridgeUrl = knownGitBridgeUrl(server.url);
        const stored = GlobalStateManager.getGitToken(this.context, server.name);
        const actions = [
            {label: vscode.l10n.t('Enter a git token...'), action: 'enter',
             detail: vscode.l10n.t('A token from Account Settings > Git Integration on Overleaf')},
            {label: vscode.l10n.t('Create a new git token on Overleaf'), action: 'create',
             detail: vscode.l10n.t('As Account Settings does; an account can have at most 10 tokens')},
            ...(stored ? [
                {label: vscode.l10n.t('Check the stored git token'), action: 'check', detail: ''},
                {label: vscode.l10n.t('Remove the stored git token'), action: 'remove',
                 detail: vscode.l10n.t('The token stays valid on Overleaf')},
            ] : []),
            ...(stored?.id ? [{label: vscode.l10n.t('Remove the stored git token and revoke it on Overleaf'), action: 'revoke', detail: ''}] : []),
        ];
        const picked = await vscode.window.showQuickPick(actions, {placeHolder: stored
            ? vscode.l10n.t('A git token is stored for {user} on {server}', {user: server.username, server: server.name})
            : vscode.l10n.t('No git token is stored for {user} on {server}', {user: server.username, server: server.name})});
        try {
            switch (picked?.action) {
                case 'enter': {
                    const token = (await vscode.window.showInputBox({
                        password: true, ignoreFocusOut: true,
                        prompt: vscode.l10n.t('Git authentication token for {user} on {server}', {user: server.username, server: server.name}),
                        validateInput: value => /^\S+$/.test(value.trim()) ? undefined : vscode.l10n.t('A token has no spaces'),
                    }))?.trim();
                    if (!token) { return; }
                    if (bridgeUrl && await checkGitToken(bridgeUrl, token)==='rejected') {
                        vscode.window.showErrorMessage(vscode.l10n.t('The git bridge rejects this token; it is wrong, expired or revoked. Nothing was stored.'));
                        return;
                    }
                    await GlobalStateManager.setGitToken(this.context, server.name, await this.describeGitToken(server.api, identity, token));
                    vscode.window.showInformationMessage(vscode.l10n.t('Stored the git token for {user} on {server}.', {user: server.username, server: server.name}));
                    break;
                }
                case 'create': {
                    const res = await server.api.createGitToken(identity);
                    if (res.type!=='success' || !res.gitToken) {
                        vscode.window.showErrorMessage(vscode.l10n.t('Creating a git token failed: {message}', {message: res.message ?? ''}));
                        return;
                    }
                    const created = await this.describeGitToken(server.api, identity, res.gitToken);
                    await GlobalStateManager.setGitToken(this.context, server.name, created);
                    vscode.window.showInformationMessage(vscode.l10n.t('Created and stored a git token for {user} on {server}, valid until {date}.',
                        {user: server.username, server: server.name, date: created.expiresAt?.slice(0, 10) ?? '?'}));
                    break;
                }
                case 'check': {
                    const client = new OverleafClient(server.url, identity);
                    const status = await gitTokenStatus(() => client.gitTokens(), stored!.token, bridgeUrl);
                    if (status.check==='accepted') {
                        vscode.window.showInformationMessage(formatGitTokenStatus(status));
                    } else {
                        vscode.window.showErrorMessage(formatGitTokenStatus(status));
                    }
                    break;
                }
                case 'remove':
                    await GlobalStateManager.removeGitToken(this.context, server.name);
                    vscode.window.showInformationMessage(vscode.l10n.t('Removed the stored git token for {user} on {server}.', {user: server.username, server: server.name}));
                    break;
                case 'revoke': {
                    const res = await server.api.revokeGitToken(identity, stored!.id!);
                    if (res.type!=='success') {
                        vscode.window.showErrorMessage(vscode.l10n.t('Revoking the git token failed: {message}', {message: res.message ?? ''}));
                        return;
                    }
                    await GlobalStateManager.removeGitToken(this.context, server.name);
                    vscode.window.showInformationMessage(vscode.l10n.t('Revoked the git token on Overleaf and removed it here.'));
                    break;
                }
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Git token: {message}', {message: error?.message ?? String(error)}));
        }
    }

    /** The project of the open workspace: an Overleaf folder, or a local replica's .overleaf/settings.json. */
    private async workspaceProject(): Promise<{serverName: string, projectId: string} | undefined> {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (folder?.scheme===ROOT_NAME) {
            const {serverName, projectId} = parseUri(folder);
            return {serverName, projectId};
        }
        const settings = await LocalReplicaSCMProvider.readSettings();
        if (settings?.uri) {
            const {serverName, projectId} = parseUri(vscode.Uri.parse(settings.uri));
            return {serverName, projectId};
        }
        return undefined;
    }

    /**
     * Show what project-info reports about a project: from the Projects view's item, or the open
     * workspace's project. Everything is read when the command runs.
     */
    async showProjectInfo(item?: ProjectItem) {
        const target = item ? {serverName: item.parent.name, projectId: item.pid} : await this.workspaceProject();
        if (target===undefined) {
            vscode.window.showErrorMessage(vscode.l10n.t('Open an Overleaf project or a local replica, or run this on a project in the Projects view.'));
            return;
        }
        const server = await this.loggedInServer({name: target.serverName});
        if (server===undefined) {
            vscode.window.showErrorMessage(vscode.l10n.t('Log in to {server} first.', {server: target.serverName}));
            return;
        }
        const identity = await GlobalStateManager.authenticate(this.context, server.name);
        const client = new OverleafClient(server.url, identity);
        const token = GlobalStateManager.getGitToken(this.context, server.name)?.token;
        try {
            const info = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the project...')},
                () => gatherProjectInfo(client, target.projectId, {token, bridgeUrl: knownGitBridgeUrl(server.url)}));
            this.infoChannel ??= vscode.window.createOutputChannel(vscode.l10n.t('Overleaf Workshop: Project Info'));
            this.infoChannel.clear();
            this.infoChannel.append(formatProjectInfo(info));
            this.infoChannel.show(true);
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Project info: {message}', {message: error?.message ?? String(error)}));
        }
    }

    private infoChannel?: vscode.OutputChannel;

    newProject(server: ServerItem) {
        // 'Blank Project', 'Example Project', 'Upload Project'
        vscode.window.showQuickPick([vscode.l10n.t('Blank Project'), vscode.l10n.t('Example Project'), vscode.l10n.t('Upload Project')])
        .then((answer) => {
            switch (answer) {
                case vscode.l10n.t('Blank Project'):
                case vscode.l10n.t('Example Project'):
                    const template = answer===vscode.l10n.t('Example Project') ? 'example' : 'none';
                    vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Project name')})
                    .then(name => {
                        if (name) {
                            GlobalStateManager.authenticate(this.context, server.name)
                            .then(identity => server.api.newProject(identity, name, template))
                            .then(res => {
                                if (res.type==='success') {
                                    this.refresh();
                                } else {
                                    vscode.window.showErrorMessage(res.message);
                                }
                            });
                        }
                    });
                    break;
                case vscode.l10n.t('Upload Project'):
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            'Archive File': ['zip'],
                        },
                        title: vscode.l10n.t('Upload Zipped Project'),
                    }).then((uri) => {
                        if (!uri) { return; }
                        vscode.workspace.fs.readFile(uri[0])
                        .then(fileContent => {
                            const filename = uri[0].path.split('/').pop();
                            if (filename) {
                                GlobalStateManager.authenticate(this.context, server.name)
                                .then(identity => server.api.uploadProject(identity, filename, fileContent))
                                .then(res => {
                                    if (res.type==='success') {
                                        this.refresh();
                                    } else {
                                        vscode.window.showErrorMessage(res.message);
                                    }
                                });
                            }
                        });
                    });
                    break;
            }
        });
    }

    copyProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': `${project.label} (Copy)`,
            'title': vscode.l10n.t('Copy Project'),
        }).then(name => {
            if (name) {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.cloneProject(identity, project.pid, name))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    renameProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': project.label,
        })
        .then(newName => {
            if (newName && newName!==project.label) {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.renameProject(identity, project.pid, newName))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    deleteProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Permanently delete project "{label}" ?', {label:project.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.deleteProject(identity, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    archiveProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Archive project "{label}" ?', {label:project.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.archiveProject(identity, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    unarchiveProject(project: ProjectItem) {
        GlobalStateManager.authenticate(this.context, project.parent.name)
        .then(identity => project.api.unarchiveProject(identity, project.pid))
        .then(res => {
            if (res.type==='success') {
                this.refresh();
            } else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }

    trashProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Move project "{label}" to trash ?', {label:project.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.trashProject(identity, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    untrashProject(project: ProjectItem) {
        GlobalStateManager.authenticate(this.context, project.parent.name)
        .then(identity => project.api.untrashProject(identity, project.pid))
        .then(res => {
            if (res.type==='success') {
                this.refresh();
            } else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }

    createTag(server: ServerItem) {
        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Tag name')})
        .then(name => {
            if (name) {
                GlobalStateManager.authenticate(this.context, server.name)
                .then(identity => server.api.createTag(identity, name))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    renameTag(tag: TagItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New tag name'),
            'value': tag.label,
        })
        .then(newName => {
            if (newName && newName!==tag.label) {
                GlobalStateManager.authenticate(this.context, tag.serverName)
                .then(identity => tag.api.renameTag(identity, tag.tid, newName))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    deleteTag(tag: TagItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Delete tag "{label}" ?', {label:tag.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, tag.serverName)
                .then(identity => tag.api.deleteTag(identity, tag.tid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    addProjectToTag(project: ProjectItem) {
        const tagNames = project.parent.tags?.map(tag => tag.name) || [];
        vscode.window.showQuickPick(tagNames, {
            canPickMany:false, placeHolder:vscode.l10n.t('Select the tag below.')})
        .then(selection => {
            if (selection===undefined) { return Promise.reject(); }
            return Promise.resolve(selection);
        })
        .then(tagName => {
            const tagId = project.parent.tags?.find(tag => tag.name===tagName)?.tid;
            GlobalStateManager.authenticate(this.context, project.parent.name)
            .then(identity => project.api.addProjectToTag(identity, tagId, project.pid))
            .then(res => {
                if (res.type==='success') {
                    this.refresh();
                } else {
                    vscode.window.showErrorMessage(res.message);
                }
            });
        });
    }

    removeProjectFromTag(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove project "{label}" from tag "{name}" ?', {label:project.label,name:project.tag?.name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.removeProjectFromTag(identity, project.tag?.tid, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    openProjectInCurrentWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)
        .then(() => {
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    openProjectInNewWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)
        .then(() => {
            vscode.commands.executeCommand('vscode.openFolder', uri, true);
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    async openProjectLocalReplica(project: ProjectItem) {
        // should close other open vfs firstly
        const vfsFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme===ROOT_NAME);
        if (vfsFolder) {
            vscode.window.showWarningMessage( vscode.l10n.t('Please close the open remote overleaf folder firstly.') );
            return;
        }

        const uri = vscode.Uri.parse(project.uri);
        const {serverName,projectId} = parseUri(uri);
        // fetch existing local replica scm
        let scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
        let replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label===LocalReplicaSCMProvider.label);
        // if not exist, create new one
        if (replicas.length===0) {
            const vfs = (await (await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri))) as VirtualFileSystem;
            await vfs.init();
            const answer = await vscode.window.showWarningMessage( vscode.l10n.t('No local replica found, create one for project "{label}" ?', {label:project.label}), "Yes", "No");
            if (answer === "Yes") {
                await (await vscode.commands.executeCommand(`${ROOT_NAME}.projectSCM.newSCM`, LocalReplicaSCMProvider));
                // fetch local replica scm again
                scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
                replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label===LocalReplicaSCMProvider.label);
            } else {
                vfs.dispose();
                return;
            }
            vfs.dispose();
        }

        // open local replica
        const replicasPath = replicas.map(scmPersist => vscode.Uri.parse(scmPersist.baseUri).fsPath);
        if (replicasPath.length===0) { return; }
        const quickPickItems = replicasPath.map(path => {
            let label = path;
            let buttons = [{
                id: "removal",
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: vscode.l10n.t('Remove local replica'),
            }];
            return {label, buttons};
        });

        // select local replica via quick pick
        new Promise(resolve => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.placeholder = vscode.l10n.t('Select the local replica below.');
            quickPick.items = quickPickItems;
            quickPick.onDidTriggerItemButton(({button,item}) => {
                if ((button as any).id === "removal") {
                    vscode.window.showWarningMessage( vscode.l10n.t('Remove local replica "{label}" ?', {label:item.label}), 'Yes', 'No')
                    .then(answer => {
                        if (answer === 'Yes') {
                            // remove local replica from scm persists
                            const scmKey = Object.keys(scmPersists).find(key => vscode.Uri.parse(scmPersists[key].baseUri).fsPath===item.label)!;
                            GlobalStateManager.updateServerProjectSCMPersist(this.context, serverName, projectId, scmKey);
                            // remove entry from quick pick
                            quickPick.items = quickPick.items.filter(item => item.label!==item.label);
                        }
                    });
                }
            });
            quickPick.onDidAccept(() => {
                const path = quickPick.selectedItems[0]?.label;
                if (path) {
                    quickPick.dispose();
                    resolve(path);
                }
            });
            quickPick.show();
        })
        .then(path => {
            const uri = vscode.Uri.file(path as string);
            // always open in current window
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    get triggers() {
        return [
            // register tree data provider
            vscode.window.registerTreeDataProvider(`${ROOT_NAME}.projectManager`, this),
            // register server-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.addServer`, () => {
                this.addServer();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.removeServer`, (item) => {
                this.removeServer(item.name);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.loginServer`, (item) => {
                this.loginServer(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.logoutServer`, (item) => {
                this.logoutServer(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.gitToken`, (item) => {
                this.manageGitToken(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.projectInfo`, (item) => {
                this.showProjectInfo(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.refreshServer`, (item) => {
                this.refreshServer(item);
            }),
            // register project-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.newProject`, (item) => {
                this.newProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.copyProject`, (item) => {
                this.copyProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.renameProject`, (item) => {
                this.renameProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.deleteProject`, (item) => {
                this.deleteProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.archiveProject`, (item) => {
                this.archiveProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.unarchiveProject`, (item) => {
                this.unarchiveProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.trashProject`, (item) => {
                this.trashProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.untrashProject`, (item) => {
                this.untrashProject(item);
            }),
            // register tag-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.createTag`, (item) => {
                this.createTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.renameTag`, (item) => {
                this.renameTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.deleteTag`, (item) => {
                this.deleteTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.addProjectToTag`, (item) => {
                this.addProjectToTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.removeProjectFromTag`, (item) => {
                this.removeProjectFromTag(item);
            }),
            // register open project commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectInCurrentWindow`, (item) => {
                this.openProjectInCurrentWindow(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectInNewWindow`, (item) => {
                this.openProjectInNewWindow(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectLocalReplica`, (item) => {
                this.openProjectLocalReplica(item);
            }),
        ];
    }
}
