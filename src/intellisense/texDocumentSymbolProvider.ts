import * as vscode from 'vscode';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { IntellisenseProvider } from '.';
import { TeXElement, TeXElementType, genTexElements } from './texDocumentParseUtility';
import { ROOT_NAME } from '../consts';

type TexFileStruct = {
    texElements: TeXElement[],
    childrenPaths: string[],
    bibFilePaths: string[],
};

function normalizeProjectPath(path: string): string {
    const segments = path.split('/');
    const stack: string[] = [];
    for (const segment of segments) {
        if (segment==='' || segment==='.') {
            continue;
        }
        if (segment==='..') {
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return stack.join('/');
}

function resolvePathFromFile(sourcePath: string, targetPath: string, ext?: string): string {
    const cleaned = targetPath.trim().replace(/^['\"]|['\"]$/g, '');
    if (cleaned==='') {
        return '';
    }

    const withExt = ext && !cleaned.endsWith(ext) ? `${cleaned}${ext}` : cleaned;
    if (withExt.startsWith('/')) {
        return normalizeProjectPath(withExt);
    }

    const parentPath = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    return normalizeProjectPath(`${parentPath}/${withExt}`);
}

function elementsTypeCast(section: TeXElement): vscode.SymbolKind {
    switch (section.type) {
        case TeXElementType.Section:
        case TeXElementType.SectionAst:
            return vscode.SymbolKind.Struct;
        case TeXElementType.Environment:
            return vscode.SymbolKind.Package;
        case TeXElementType.Command:
            return vscode.SymbolKind.Number;
        case TeXElementType.SubFile:
            return vscode.SymbolKind.File;
        case TeXElementType.BibItem:
            return vscode.SymbolKind.Class;
        case TeXElementType.BibField:
            return vscode.SymbolKind.Constant;
        default:
            return vscode.SymbolKind.String;
    }
}

function elementsToSymbols(sections: TeXElement[]): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = [];
    sections.forEach(section => {
        const range = new vscode.Range(section.lineFr, 0, section.lineTo, 65535);
        const symbol = new vscode.DocumentSymbol(
            section.label || 'empty',
            '',
            elementsTypeCast(section),
            range, range);
        symbols.push(symbol);
        if (section.children.length > 0) {
            symbol.children = elementsToSymbols(section.children);
        }
    });
    return symbols;
}

function elementsToFoldingRanges(sections: TeXElement[]): vscode.FoldingRange[] {
    const foldingRanges: vscode.FoldingRange[] = [];
    sections.forEach(section => {
        foldingRanges.push(new vscode.FoldingRange(section.lineFr, section.lineTo - 1)); // without the last line, e.g \end{document}
        if (section.children.length > 0) {
            foldingRanges.push(...elementsToFoldingRanges(section.children));
        }
    });
    return foldingRanges;
}

// Reference: https://github.com/James-Yu/LaTeX-Workshop/commit/d1a078d9b63a34c9cda9ff5d1042c8999030e6e1
function getEnvironmentFoldingRange(document: vscode.TextDocument){
    const ranges: vscode.FoldingRange[] = [];
    const opStack: { keyword: string, index: number }[] = [];
    const text: string =  document.getText();
    const envRegex: RegExp = /(\\(begin){(.*?)})|(\\(end){(.*?)})/g; //to match one 'begin' OR 'end'

    let match = envRegex.exec(text); // init regex search
    while (match) {
        //for 'begin': match[2] contains 'begin', match[3] contains keyword
        //fro 'end':   match[5] contains 'end',   match[6] contains keyword
        const item = {
            keyword: match[2] ? match[3] : match[6],
            index: match.index
        };
        const lastItem = opStack[opStack.length - 1];

        if (match[5] && lastItem && lastItem.keyword === item.keyword) { // match 'end' with its 'begin'
            opStack.pop();
            ranges.push(new vscode.FoldingRange(
                document.positionAt(lastItem.index).line,
                document.positionAt(item.index).line - 1
            ));
        } else {
            opStack.push(item);
        }

        match = envRegex.exec(text); //iterate regex search
    }
    //TODO: if opStack still not empty
    return ranges;
}

/*
    * Convert the file into the struct by:
    * 1. Construct child, named as Uri.path, from TeXElementType.SubFile
    * 2. Construct bibFile from TeXElementType.BibFile
    * 
    * @param fileContent: file content 
*/
async function parseTexFileStruct(fileContent:string): Promise<TexFileStruct>{ 
    const childrenPaths = [];
    const bibFilePaths = [];
    const texSymbols = await genTexElements(fileContent);

    // BFS: Traverse the texElements and build fileSymbol
    const queue: TeXElement[] = [...texSymbols];
    while (queue.length > 0) {
        const symbol = queue.shift();
        switch (symbol?.type) {
            case TeXElementType.BibFile:
                bibFilePaths.push(symbol.label);
                break;
            case TeXElementType.SubFile:
                const subFilePath = symbol.label?.endsWith('.tex') ? symbol.label : `${symbol.label}.tex`;
                childrenPaths.push(subFilePath);
                break;
            default:
                break;
        }
        // append children to queue
        symbol?.children.forEach( child => {
            queue.push(child);
        });
    }

    return {
        texElements: texSymbols,
        childrenPaths: childrenPaths,
        bibFilePaths: bibFilePaths,
    };
}

class ProjectStructRecord {
    private fileRecordMap: Map<string, TexFileStruct> = new Map<string, TexFileStruct>();

    constructor (private readonly vfs: VirtualFileSystem) {}

    get rootPath(): string {
        return normalizeProjectPath(this.vfs.getRootDocName());
    }

    async init(documents: readonly vscode.TextDocument[] = [], token?: vscode.CancellationToken): Promise<boolean> {
        const open = new Map(documents.map(document => [normalizeProjectPath(parseUri(document.uri).pathParts.join('/')), document]));
        const queue = [this.rootPath];
        const visited = new Set<string>();
        while (queue.length) {
            if (token?.isCancellationRequested) { return false; }
            const filePath = queue.shift()!;
            if (visited.has(filePath)) { continue; }
            visited.add(filePath);
            try {
                const document = open.get(filePath);
                const fileStruct = document
                    ? await this.refreshRecord(document)
                    : this.fileRecordMap.get(filePath) ?? await this.refreshRecord(filePath);
                if (token?.isCancellationRequested) { return false; }
                queue.push(...fileStruct.childrenPaths);
            } catch (error) {
                if (filePath === this.rootPath) { throw error; }
            }
        }
        return !token?.isCancellationRequested;
    }

    getTexFileStruct(document: vscode.TextDocument): TexFileStruct | undefined {
        const filePath = normalizeProjectPath(parseUri(document.uri).pathParts.join('/'));
        return this.fileRecordMap.get(filePath);
    }

    async refreshRecord(source: vscode.TextDocument | string): Promise<TexFileStruct> {
        let filePath:string, content: string;
        // get file path and content
        if (typeof source === 'string') {
            filePath = normalizeProjectPath(source);
            const uri = this.vfs.pathToUri(filePath);
            content = new TextDecoder().decode( await this.vfs.openFile(uri) );
        } else {
            filePath = normalizeProjectPath(parseUri(source.uri).pathParts.join('/'));
            content = source.getText();
        }

        // Normalize references against the source document path so nested main files resolve correctly.
        const rawFileStruct = await parseTexFileStruct(content);
        const fileStruct: TexFileStruct = {
            texElements: rawFileStruct.texElements,
            childrenPaths: rawFileStruct.childrenPaths
                .map((childPath) => resolvePathFromFile(filePath, childPath, '.tex'))
                .filter((childPath) => childPath!==''),
            bibFilePaths: rawFileStruct.bibFilePaths
                .flatMap((name) => name.split(','))
                .map((name) => resolvePathFromFile(filePath, name, '.bib'))
                .filter((bibPath) => bibPath!==''),
        };

        // update file record
        this.fileRecordMap.set(filePath, fileStruct);
        return fileStruct;
    }

    getAllBibFilePaths(): string[] {
        const rootStruct = this.fileRecordMap.get( this.rootPath );
        if (rootStruct === undefined) { return []; }

        const queue = [rootStruct];
        const visited = new Set<TexFileStruct>();
        const bibFilePaths = new Set<string>();
        // iteratively traverse file node tree
        while (queue.length > 0) {
            const item = queue.shift()!;
            if (visited.has(item)) { continue; }
            visited.add(item);
            item.bibFilePaths.forEach((path) => {
                bibFilePaths.add(path);
            });
            // append children to queue
            item.childrenPaths.forEach( child => {
                const childItem = this.fileRecordMap.get(child);
                childItem && queue.push(childItem);
            });
        }
        return [...bibFilePaths];
    }
}

export class TexDocumentSymbolProvider extends IntellisenseProvider implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider {
    protected readonly contextPrefix = [];

    private projectRecordMap = new Map<string, ProjectStructRecord>();

    private projectKey(uri: vscode.Uri): string {
        const { serverName, identifier } = parseUri(uri);
        return JSON.stringify([serverName, identifier]);
    }

    private async projectRecordFor(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<ProjectStructRecord | undefined> {
        if (document.uri.scheme !== ROOT_NAME || token?.isCancellationRequested) { return; }
        const key = this.projectKey(document.uri);
        let record = this.projectRecordMap.get(key);
        if (!record) {
            const vfs = await this.vfsm.prefetch(document.uri);
            if (token?.isCancellationRequested) { return; }
            record = new ProjectStructRecord(vfs);
        }
        const documents = (vscode.workspace.textDocuments ?? []).filter(other =>
            other.uri.scheme === ROOT_NAME && this.projectKey(other.uri) === key && other.uri.toString() !== document.uri.toString());
        documents.push(document);
        if (!await record.init(documents, token)) { return; }
        this.projectRecordMap.set(key, record);
        return record;
    }

    async provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken): Promise<vscode.FoldingRange[]> {
        const environmentRange = getEnvironmentFoldingRange(document);

        // Try get fileStruct
        const projectRecord = this.projectRecordMap.get(this.projectKey(document.uri));
        const fileStruct = projectRecord?.getTexFileStruct(document);

        return environmentRange.concat( fileStruct ? elementsToFoldingRanges(fileStruct.texElements) : [] );
    }

    async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
        const projectRecord = await this.projectRecordFor(document);
        if (!projectRecord) { return []; }

        // return symbols
        const fileStruct = projectRecord.getTexFileStruct(document) ?? await projectRecord.refreshRecord(document);
        return elementsToSymbols( fileStruct.texElements );
    }

    async bibPathsFor(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<string[]> {
        const record = await this.projectRecordFor(document, token);
        return record?.getAllBibFilePaths() ?? [];
    }

    get triggers(): vscode.Disposable[] {
        const latexSelector = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave'].map((id) => {
            return {...this.selector, language: id };
        });
        return [
            // register symbol provider
            vscode.languages.registerDocumentSymbolProvider(latexSelector, this),
            // register folding range provider
            vscode.languages.registerFoldingRangeProvider(latexSelector, this),
            // register file change listener
            vscode.workspace.onDidChangeTextDocument(async (e) => {
                if (e.document.uri.scheme !== ROOT_NAME) { return; }
                const projectRecord = this.projectRecordMap.get(this.projectKey(e.document.uri));
                projectRecord?.refreshRecord(e.document);
            }),
        ];
    }
}
