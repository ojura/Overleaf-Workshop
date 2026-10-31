/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names */
import type { CommentThreadSchema, GitTokenInfo } from '../api/base';
import { editorPageMeta, newerImages, OfferedImage, offeredImages } from '../api/editorPage';
import { formatGitTokenStatus, gitProjectUrl, GitTokenStatus, gitTokenStatus } from '../api/gitBridge';
import type { JoinedProject } from './client';
import type { DocRanges, ProjectRanges } from './ranges';

/**
 * What project-info needs from a connection to Overleaf; OverleafClient has it. readProject is
 * the reader that push-check uses too (OverleafClient.readRanges).
 */
export interface InfoSource {
    readProject(projectId: string): Promise<{ joined: JoinedProject, ranges: ProjectRanges }>;
    commentThreads(projectId: string): Promise<{[threadId: string]: CommentThreadSchema}>;
    gitTokens(): Promise<GitTokenInfo[]>;
    editorPage(projectId: string): Promise<string>;
}

export interface PersonInfo {
    id: string;
    name: string;
    email?: string;
}

export interface MemberInfo extends PersonInfo {
    /** 'readAndWrite', 'review' or 'readOnly' */
    privileges?: string;
    /** 'invite', or 'token' for a member through link sharing */
    source?: string;
}

/** How many comments and tracked changes one document has. */
export interface DocumentCounts {
    path: string;
    docId: string;
    comments: number;
    insertions: number;
    deletions: number;
    /** tracked changes by the user id that made them */
    changesByUser: Record<string, number>;
}

export interface ProjectInfo {
    id: string;
    name: string;
    /** the joining user's access level: 'owner', 'readAndWrite', ... */
    accessLevel?: string;
    owner?: PersonInfo;
    members: MemberInfo[];
    invites: number;
    editAccessRequests: number;
    /** 'private' or 'tokenBased' */
    linkSharing?: string;
    /** how Overleaf compiles the project, read when project-info runs */
    tex: {
        /** 'pdflatex', 'latex', 'xelatex' or 'lualatex' */
        compiler?: string;
        /** the project's TeX Live image, e.g. texlive-full:2025.1 */
        imageName?: string;
        /** the main document's path, from rootDoc_id */
        mainDocument?: string;
        /** the images Overleaf offers, from the editor page's ol-imageNames */
        offered: OfferedImage[];
        /** offered images newer than the project's, newest first (newerImages) */
        newer: OfferedImage[];
        /** why the offered images are missing, when the editor page could not be read */
        offeredError?: string;
    };
    features: Record<string, unknown>;
    /** on for everyone, or for these users; `users` is empty when it is off for everyone */
    trackChanges: { everyone: true } | { everyone: false, users: PersonInfo[] };
    documents: DocumentCounts[];
    threads?: { total: number, resolved: number };
    threadsError?: string;
    git: {
        /** the owner's plan includes the git integration (feature gitBridge) */
        available: boolean;
        bridgeUrl?: string;
        projectUrl?: string;
        token: GitTokenStatus;
    };
}

const personOf = (user: any): PersonInfo => ({
    id: String(user?._id ?? ''),
    name: [user?.first_name, user?.last_name].filter(Boolean).join(' ') || String(user?.email ?? user?._id ?? ''),
    email: user?.email || undefined,
});

/** The counts project-info reports for one document read by readProject. */
function countsOf(doc: DocRanges): DocumentCounts {
    const changesByUser: Record<string, number> = {};
    for (const change of doc.changes) {
        const user = change.userId ?? 'unknown';
        changesByUser[user] = (changesByUser[user] ?? 0) + 1;
    }
    return {
        path: doc.path,
        docId: doc.docId,
        comments: doc.comments.length,
        insertions: doc.changes.filter(change => change.kind === 'insertion').length,
        deletions: doc.changes.filter(change => change.kind === 'deletion').length,
        changesByUser,
    };
}

/** Overleaf's track-changes state: true (everyone), false or absent (nobody), or {userId: true}. */
function trackChangesOf(state: unknown, people: PersonInfo[]): ProjectInfo['trackChanges'] {
    if (state === true) {
        return { everyone: true };
    }
    const ids = state && typeof state === 'object' ? Object.entries(state).filter(([, on]) => on).map(([id]) => id) : [];
    const users = ids.map(id => people.find(person => person.id === id)
                               ?? { id, name: id === '__guests__' ? 'guests (anyone with the link who is not logged in)' : `user ${id}, not a member of the project now` });
    return { everyone: false, users };
}

/**
 * Everything project-info reports about `projectId`, read live each time: one join for the
 * project and its documents (readProject, as push-check reads them), the editor page for the TeX Live images Overleaf offers and the
 * git bridge's address, the comment threads, and, when `git.token` is given, the token's entry
 * in Account Settings' list and a check at the bridge. The token check names no project
 * (checkGitToken), so it does not make a commit on Overleaf.
 */
export async function gatherProjectInfo(source: InfoSource, projectId: string, git: { token?: string, bridgeUrl?: string }): Promise<ProjectInfo> {
    const { joined, ranges } = await source.readProject(projectId);
    const documents = ranges.docs.map(countsOf);
    const project: any = joined.project;
    const owner = project.owner ? personOf(project.owner) : undefined;
    const members: MemberInfo[] = (project.members ?? []).map((member: any) => ({ ...personOf(member), privileges: member.privileges, source: member.source }));
    const features: Record<string, unknown> = project.features ?? {};
    let meta: Record<string, string> = {};
    let offeredError: string | undefined;
    try {
        meta = editorPageMeta(await source.editorPage(projectId));
    } catch (error: any) {
        offeredError = error?.message ?? String(error);
    }
    const offered = offeredImages(meta);
    if (!offeredError && offered.length === 0) {
        offeredError = 'the editor page has no ol-imageNames';
    }
    const bridgeUrl = git.bridgeUrl ?? (meta['ol-gitBridgePublicBaseUrl'] || undefined);
    const info: ProjectInfo = {
        id: String(project._id),
        name: String(project.name),
        accessLevel: joined.permissionsLevel,
        owner,
        members,
        invites: (project.invites ?? []).length,
        editAccessRequests: (project.editAccessRequests ?? []).length,
        linkSharing: project.publicAccesLevel,
        tex: {
            compiler: project.compiler,
            imageName: project.imageName,
            mainDocument: ranges.docs.find(doc => doc.docId === project.rootDoc_id)?.path,
            offered,
            newer: newerImages(project.imageName, offered),
            offeredError,
        },
        features,
        trackChanges: trackChangesOf(project.trackChangesState, [...(owner ? [owner] : []), ...members]),
        documents,
        git: {
            available: features.gitBridge === true,
            bridgeUrl,
            projectUrl: bridgeUrl ? gitProjectUrl(bridgeUrl, String(project._id)) : undefined,
            token: { stored: Boolean(git.token) },
        },
    };
    try {
        const threads = Object.values(await source.commentThreads(projectId));
        info.threads = { total: threads.length, resolved: threads.filter(thread => thread?.resolved).length };
    } catch (error: any) {
        info.threadsError = error?.message ?? String(error);
    }
    if (git.token) {
        info.git.token = await gitTokenStatus(() => source.gitTokens(), git.token, bridgeUrl);
    }
    return info;
}

const PRIVILEGES: Record<string, string> = { readAndWrite: 'can edit', review: 'can review', readOnly: 'can view' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const who = (person: PersonInfo) => person.email ? `${person.name} <${person.email}>` : person.name;

/** project-info's text: one fact per line, the documents and people indented below their totals. */
export function formatProjectInfo(info: ProjectInfo): string {
    const lines: string[] = [];
    const tex = info.tex;
    const describe = (image: OfferedImage) => `${image.imageName} (${image.imageDesc ?? '?'}${image.allowed === false ? ', not allowed for this account' : ''}${image.hasCheckpointing ? ', checkpointing' : ''})`;
    lines.push(`project: ${info.name} (${info.id})`);
    lines.push(`compiler: ${tex.compiler ?? '?'}; main document: ${tex.mainDocument ?? '?'}; TeX Live image: ${tex.imageName ?? '?'}`);
    if (tex.offeredError) {
        lines.push(`TeX Live images offered: unknown (${tex.offeredError})`);
    } else {
        lines.push(tex.newer.length
            ? `TeX Live: Overleaf offers a NEWER image than the project's ${tex.imageName}: ${tex.newer.map(describe).join(', ')}`
            : `TeX Live: the project's ${tex.imageName} is the newest image Overleaf offers for it`);
        lines.push(`TeX Live images offered: ${tex.offered.map(describe).join(', ')}`);
    }
    lines.push(`your access: ${info.accessLevel ?? '?'}`);
    if (info.owner) { lines.push(`owner: ${who(info.owner)}`); }
    const byPrivilege = Object.entries(info.members.reduce<Record<string, number>>((counts, member) => {
        const key = PRIVILEGES[member.privileges ?? ''] ?? member.privileges ?? '?';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
    }, {})).map(([privilege, n]) => `${n} ${privilege}`);
    const viaLink = info.members.filter(member => member.source === 'token').length;
    lines.push(`collaborators: ${info.members.length}${byPrivilege.length ? ` (${byPrivilege.join(', ')}${viaLink ? `; ${viaLink} joined through link sharing` : ''})` : ''}; ${plural(info.invites, 'pending invite')}; ${plural(info.editAccessRequests, 'edit access request')}; link sharing ${info.linkSharing === 'tokenBased' ? 'on' : info.linkSharing === 'private' ? 'off' : info.linkSharing ?? '?'}`);
    for (const member of info.members) {
        lines.push(`  ${who(member)}: ${PRIVILEGES[member.privileges ?? ''] ?? member.privileges ?? '?'}${member.source === 'token' ? ', through link sharing' : ''}`);
    }
    lines.push(info.trackChanges.everyone ? 'track changes: on for everyone'
        : info.trackChanges.users.length ? `track changes: on for ${info.trackChanges.users.map(user => user.name).join(', ')}; off for everyone else`
        : 'track changes: off for everyone');
    const comments = info.documents.reduce((n, doc) => n + doc.comments, 0);
    const insertions = info.documents.reduce((n, doc) => n + doc.insertions, 0);
    const deletions = info.documents.reduce((n, doc) => n + doc.deletions, 0);
    const threads = info.threads ? ` in ${plural(info.threads.total, 'thread')} (${info.threads.resolved} resolved)` : ` (threads: ${info.threadsError})`;
    lines.push(`comments and tracked changes in ${plural(info.documents.length, 'document')}: ${plural(comments, 'comment')}${threads}, ${plural(insertions + deletions, 'tracked change')} (${plural(insertions, 'insertion')}, ${plural(deletions, 'deletion')})`);
    const people = [...(info.owner ? [info.owner] : []), ...info.members];
    for (const doc of info.documents.filter(d => d.comments || d.insertions || d.deletions)) {
        const authors = Object.entries(doc.changesByUser).map(([id, n]) => `${people.find(p => p.id === id)?.name ?? id} ${n}`).join(', ');
        lines.push(`  ${doc.path}: ${plural(doc.comments, 'comment')}, ${plural(doc.insertions + doc.deletions, 'tracked change')}${authors ? ` (by ${authors})` : ''}`);
    }
    lines.push(`features: ${Object.entries(info.features).map(([key, value]) => `${key} ${value === true ? 'yes' : value === false ? 'no' : value}`).join(', ')}`);
    if (!info.git.available) {
        lines.push(`git: not available for this project (the owner's plan has no git integration)`);
    } else {
        lines.push(`git: available${info.git.projectUrl ? `, ${info.git.projectUrl}` : ''}`);
    }
    lines.push(formatGitTokenStatus(info.git.token));
    return lines.join('\n') + '\n';
}
