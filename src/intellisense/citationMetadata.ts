import * as vscode from 'vscode';
import type { VirtualFileSystem } from '../core/remoteFileSystemProvider';

export interface CitationMetadata {
    key: string;
    title?: string;
    author?: string;
    year?: string;
    journal?: string;
    booktitle?: string;
}

function skipSpace(source: string, start: number): number {
    let index = start;
    while (index < source.length) {
        if (/\s/.test(source[index])) { index++; }
        else if (source[index] === '%') {
            const end = source.indexOf('\n', index);
            index = end < 0 ? source.length : end + 1;
        } else { break; }
    }
    return index;
}

function valuePart(source: string, start: number): { value: string; next: number; complete: boolean } {
    const opening = source[start];
    if (opening !== '{' && opening !== '"') {
        let next = start;
        while (next < source.length && !/[\s,#})]/.test(source[next])) { next++; }
        return { value: source.slice(start, next), next, complete: true };
    }
    let depth = opening === '{' ? 1 : 0;
    let index = start + 1;
    for (; index < source.length; index++) {
        const char = source[index];
        if (char === '\\') { index++; continue; }
        if (char === '{') { depth++; }
        else if (char === '}') {
            depth--;
            if (opening === '{' && depth === 0) { break; }
        } else if (char === '"' && opening === '"' && depth === 0) { break; }
    }
    return { value: source.slice(start + 1, index), next: Math.min(index + 1, source.length), complete: index < source.length };
}

function skipEntry(source: string, start: number, opening: string): number {
    let depth = opening === '{' ? 1 : 0;
    let quoted = false;
    for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (char === '\\') { index++; continue; }
        if (char === '"') { quoted = !quoted; }
        if (char === '{') { depth++; }
        else if (char === '}') {
            depth--;
            if (opening === '{' && depth === 0) { return index + 1; }
        } else if (char === ')' && opening === '(' && depth === 0 && !quoted) { return index + 1; }
    }
    return source.length;
}

function plainBibText(value: string): string {
    return value.replace(/\\([{}%&#_$])|[{}]/g, (_match, escaped: string | undefined) => escaped ?? '')
        .replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Keep a citation key available while its fields are still being edited. */
export function parseBibContent(source: string): CitationMetadata[] {
    const entries: CitationMetadata[] = [];
    const header = /@([A-Za-z][\w-]*)\s*([({])/g;
    let match: RegExpExecArray | null;
    while ((match = header.exec(source))) {
        if (/^(string|comment|preamble)$/i.test(match[1])) {
            header.lastIndex = skipEntry(source, header.lastIndex, match[2]);
            continue;
        }
        let index = skipSpace(source, header.lastIndex);
        const start = index;
        while (index < source.length && !/[\s,{}()]/.test(source[index])) { index++; }
        const key = source.slice(start, index);
        if (!key) { continue; }
        const entry: CitationMetadata = { key };
        entries.push(entry);
        index = skipSpace(source, index);
        if (source[index] !== ',') { header.lastIndex = index; continue; }
        index++;
        while (index < source.length) {
            index = skipSpace(source, index);
            if (source[index] === ',') { index++; continue; }
            if (source[index] === '}' || source[index] === ')') { index++; break; }
            if (source[index] === '@') { break; }
            const field = /^([A-Za-z][\w-]*)\s*=\s*/.exec(source.slice(index));
            if (!field) { index++; continue; }
            index += field[0].length;
            const valueStart = index;
            let value = '';
            let complete = true;
            while (index < source.length) {
                index = skipSpace(source, index);
                const part = valuePart(source, index);
                if (!part.complete) { complete = false; break; }
                value += part.value;
                index = skipSpace(source, part.next);
                if (source[index] !== '#') { break; }
                index++;
            }
            if (!complete) {
                // Resume header scanning so a later key survives an unfinished earlier field.
                index = valueStart;
                break;
            }
            const name = field[1].toLowerCase();
            if (name === 'title' || name === 'author' || name === 'year' || name === 'journal' || name === 'booktitle') {
                entry[name] = plainBibText(value);
            }
        }
        header.lastIndex = index;
    }
    return entries;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\\x60*_{}\[\]()#+\-.!|<>]/g, '\\$&');
}

export function citationDetail(entry: CitationMetadata): string {
    return [entry.author, entry.year].filter(Boolean).join(' - ');
}

export function citationMarkdown(entry: CitationMetadata): vscode.MarkdownString {
    const paragraphs = ['**' + escapeMarkdown(entry.title || entry.key) + '**'];
    if (entry.author) { paragraphs.push(escapeMarkdown(entry.author)); }
    const publication = [entry.journal || entry.booktitle, entry.year].filter(Boolean) as string[];
    if (publication.length) { paragraphs.push(publication.map(escapeMarkdown).join(' - ')); }
    paragraphs.push('Citation key: ' + escapeMarkdown(entry.key));
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    return markdown.appendMarkdown(paragraphs.join('\n\n'));
}

export async function readCitationEntries(vfs: VirtualFileSystem, paths: readonly string[], token?: vscode.CancellationToken): Promise<CitationMetadata[]> {
    const entries: CitationMetadata[] = [];
    for (const path of paths) {
        if (token?.isCancellationRequested) { return []; }
        const uri = vfs.pathToUri(path);
        try {
            const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
            const source = open ? open.getText() : new TextDecoder().decode(await vfs.openFile(uri));
            if (token?.isCancellationRequested) { return []; }
            entries.push(...parseBibContent(source));
        } catch { /* A bibliography may be renamed or incomplete while the document is edited. */ }
    }
    return entries;
}
