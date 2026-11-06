/* eslint-disable @typescript-eslint/naming-convention -- mirrors Overleaf message fields */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** Exercise the Vue message model itself; the VS Code bridge is not used by these cases. */
function messageTree() {
    const source = fs.readFileSync(path.resolve('views/chat-view/src/utils.ts'), 'utf8');
    const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports: Record<string, any> = {};
    new Function('require','exports',output)((name:string) => {
        assert.strictEqual(name,'./vscode');
        return {vscode:{postMessage(){}}};
    },exports);
    const messages = {value:[] as any[]}, unread = {value:[] as string[]};
    const tree = new exports.MessageTree(messages,unread);
    tree.userId = 'self';
    return {tree,messages,unread};
}
const message = (id:string,content:string) => ({id,content,timestamp:1,user_id:'other',user:{id:'other',first_name:'Other',email:''},clientId:'remote'});

describe('chat snapshot rendering', () => {
    it('replaces edited messages and removed roots without dropping their surviving replies', () => {
        const {tree,messages} = messageTree();
        const root = message('m1','old');
        const reply = message('m2','> reply-to-m1 [@Other](other)\n\nreply');
        tree.update([root,reply]);
        assert.strictEqual(messages.value.length,1);
        tree.update([{...root,content:'edited'},reply]);
        assert.strictEqual(messages.value[0].content,'edited');
        assert.strictEqual(messages.value[0].replies.length,1);
        tree.update([reply]);
        assert.strictEqual(messages.value.length,1);
        assert.strictEqual(messages.value[0].id,'m2');
        assert.strictEqual(messages.value[0].content.trim(),'reply');
        assert.strictEqual(root.content,'old');
        assert.ok(reply.content.startsWith('> reply-to-'), 'rendering does not mutate the authoritative snapshot');
    });

    it('does not duplicate repeated socket IDs or retain unread IDs after snapshot deletion', () => {
        const {tree,messages,unread} = messageTree();
        const item = message('m1','new');
        tree.pushMessage({...item},true);
        tree.pushMessage({...item},true);
        assert.strictEqual(messages.value.length,1);
        assert.deepStrictEqual(unread.value,['m1']);
        tree.update([]);
        assert.deepStrictEqual(messages.value,[]);
        assert.deepStrictEqual(unread.value,[]);
    });
});
