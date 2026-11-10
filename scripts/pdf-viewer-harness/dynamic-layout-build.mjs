// Build actual standalone, chat SFCs and diagnostics into an already-owned harness static root.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundleOptions } from '../build-pdf-viewer.mjs';
import { buildSpomenar } from '../build-spomenar.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const output = process.argv[2];
if (!path.isAbsolute(output ?? '')) throw new Error('An absolute owned output directory is required');
const chat = path.join(repo, 'views/chat-view');
const requireChat = createRequire(path.join(chat, 'package.json'));
const compiler = requireChat('@vue/compiler-sfc');
const sfc = { name: 'actual-vue-components', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
        const source = await fs.readFile(filename, 'utf8');
        const descriptor = compiler.parse(source, { filename }).descriptor;
        const id = 'fixture-' + path.basename(filename, '.vue');
        const script = compiler.compileScript(descriptor, { id, inlineTemplate: true,
            templateOptions: { compilerOptions: { isCustomElement: tag => tag.startsWith('vscode-') || tag === 'inline' } } });
        let css = '';
        for (const style of descriptor.styles) {
            const content = style.src ? await fs.readFile(requireChat.resolve(style.src), 'utf8') : style.content;
            css += compiler.compileStyle({ source: content, filename, id, scoped: !!style.scoped }).code;
        }
        const component = script.content.replace('export default', 'const __component =');
        const scope = descriptor.styles.some(style => style.scoped) ? '__component.__scopeId=' + JSON.stringify('data-v-' + id) + ';' : '';
        return { contents: component + '\n' + scope + 'export default __component;\nconst style=document.createElement("style");style.textContent=' + JSON.stringify(css) + ';document.head.append(style);', loader: 'ts', resolveDir: path.dirname(filename) };
    });
} };
await fs.copyFile(path.join(here, 'dynamic-layout.html'), path.join(output, 'dynamic-layout.html'));
await fs.copyFile(requireChat.resolve('@vscode/codicons/dist/codicon.ttf'), path.join(output, 'codicon.ttf'));
await build({ ...bundleOptions, plugins: [...bundleOptions.plugins, sfc], nodePaths: [path.join(chat, 'node_modules')],
    alias: { vue: requireChat.resolve('vue/dist/vue.runtime.esm-bundler.js') },
    define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    entryPoints: [path.join(here, 'dynamic-layout-fixture.ts')], outfile: path.join(output, 'dynamic-layout.js') });
await buildSpomenar(path.join(output, 'site'));
console.log('Built actual production dynamic-layout fixtures in ' + output);
