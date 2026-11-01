import * as path from 'path';
import Module = require('module');

/**
 * Loading the extension's modules in tests, against a stand-in for 'vscode', the module that only
 * VS Code's extension host provides.
 *
 *     const { PdfDocument } = loadWithVscode(vscodeStandIn, () => require('../core/pdfViewEditorProvider'));
 */

/** The compiled extension's folder, whatever its name: this file is in its test folder. */
const root = path.resolve(__dirname, '..') + path.sep;
const tests = path.join(root, 'test') + path.sep;
const isExtensionModule = (key: string) => key.startsWith(root) && !key.startsWith(tests);

/**
 * A stand-in named `name` that has `members` and throws for any other member, so that a test
 * cannot pass because the code under test got a stub where it expected a value.
 */
export function strict<T extends object>(name: string, members: T): T {
    return new Proxy(members, {
        get(target, key) {
            // 'then': a stand-in returned from an async function is not taken for a promise
            if (typeof key === 'symbol' || key === 'then' || key in target) {
                return (target as any)[key];
            }
            throw new Error(`the stand-in for ${name} has no ${String(key)}; add it to the test's stand-in`);
        },
    });
}

/**
 * Run `load` with require('vscode') answering `standIn`, and each request named in `replace`
 * (exactly as the code under test writes it, e.g. '../scm/scmCollectionProvider') answering its
 * value, against fresh copies of the extension's modules. The extension's modules that are in
 * require.cache are taken out for the load and put back afterwards, and the modules that the load
 * added are removed: require.cache then holds what it held before, whatever other test files
 * loaded, in whichever order they run. The modules loaded here keep the stand-ins they were loaded
 * with.
 */
export function loadWithVscode<T>(standIn: unknown, load: () => T, replace: Record<string, unknown> = {}): T {
    const cache = require.cache;
    const taken = Object.entries(cache).filter(([key]) => isExtensionModule(key));
    taken.forEach(([key]) => { delete cache[key]; });
    const before = new Set(Object.keys(cache));
    const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const originalLoad = loader._load;
    loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') { return standIn; }
        if (Object.prototype.hasOwnProperty.call(replace, request)) { return replace[request]; }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return load();
    } finally {
        loader._load = originalLoad;
        for (const key of Object.keys(cache)) {
            if (!before.has(key)) { delete cache[key]; }
        }
        for (const [key, value] of taken) { cache[key] = value; }
    }
}
