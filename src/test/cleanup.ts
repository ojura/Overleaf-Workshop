import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Resources owned by a test, released in reverse order even when another release fails. */
export class Cleanup {
    private steps: (() => void | Promise<void>)[] = [];

    add(step: () => void | Promise<void>) { this.steps.push(step); }

    /** Release the last resource now, before its replacement starts. */
    async undoLast() { await this.steps.pop()?.(); }

    async undo() {
        const steps = this.steps.reverse();
        this.steps = [];
        const errors: unknown[] = [];
        for (const step of steps) {
            try { await step(); } catch (error) { errors.push(error); }
        }
        if (errors.length) { throw errors[0]; }
    }

    tempDir(prefix: string, base = os.tmpdir()): string {
        const dir = fs.mkdtempSync(path.join(base, prefix));
        this.add(() => fs.rmSync(dir, { recursive: true, force: true }));
        return dir;
    }

    setEnv(key: string, value: string) {
        const saved = process.env[key];
        process.env[key] = value;
        this.add(() => { if (saved === undefined) { delete process.env[key]; } else { process.env[key] = saved; } });
    }
}
