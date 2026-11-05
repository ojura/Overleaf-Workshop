import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = () => { throw new Error('offline fixture: comparison reached a child launch'); };
syncBuiltinESMExports();
