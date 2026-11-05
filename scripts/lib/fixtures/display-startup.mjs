// Offline display process: no X server, socket or IDE is started.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { onCleanup } from '../cleanup.mjs';
import { bootId, processStat, writeInstance } from '../test-instance.mjs';

const home = process.argv[2];
const failRecord = process.argv[3] === 'fail-record';
let record = { boot: bootId() };
let displayChild;
const spawn = childProcess.spawn;
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.readFileSync = (file, ...args) => file === '/proc/net/unix' ? 'Num RefCount Protocol Flags Type St Inode Path\n' : read(file, ...args);
fs.existsSync = (file) => /^\/tmp\/\.X(?:11-unix\/X|)765432(?:-lock)?$/.test(String(file)) ? false : exists(file);
childProcess.spawn = (program, args, options) => {
    if (program !== 'Xvfb') { throw new Error(`unexpected offline program: ${program}`); }
    const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); process.send('ready');"], {
        ...options, stdio: [...options.stdio, 'ipc'],
    });
    displayChild = child;
    if (!failRecord) { child.once('message', () => process.send({ pid: child.pid, recorded: record.xvfb === child.pid })); }
    return child;
};
syncBuiltinESMExports();

const { endInstance, startDisplay } = await import('../../hidden-ide.mjs');
const cleanup = onCleanup(() => endInstance(home, record));
if (failRecord) { fs.mkdirSync(`${home}/instance.json.new`); }
try {
    await startDisplay(':765432', '1600x1000', home, (child, display) => {
        record = { ...record, xvfb: child.pid, xvfbStart: processStat(child.pid)?.start, display };
        writeInstance(home, record);
    });
    throw new Error('the fake display must remain pending until interruption');
} catch (error) {
    if (!failRecord) { throw error; }
    cleanup.run();
    process.send({ pid: displayChild.pid, code: error.code, pipeDestroyed: displayChild.stdio[3].destroyed }, () => process.disconnect());
}
