import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether a compile's saved outputs show an error. latexmk runs with -f on Overleaf, so a LaTeX
 * error still gives a PDF and the compile's status "success"; the logs tell. A compile fails
 * this check when:
 *
 * - output.log is missing, or does not say that output.pdf was written;
 * - output.log has an error line (one that starts with "! "); the first is quoted with the
 *   lines after it, up to the input line ("l.<number>") and the line after that;
 * - latexmk printed "Collected error summary" in output.stdout (a rule such as pdflatex or
 *   makeindex returned an error);
 * - output.stderr has a line that starts with "Automatic index:" (the book's latexmkrc
 *   reports so when its index programs fail);
 * - output.log says "The index was not built" or "The index was not sorted".
 *
 * Warnings of the autoindex package are counted as a note.
 */
export interface BuildCheck {
    ok: boolean;
    /** why the check fails, each with the lines that show it */
    problems: string[];
    notes: string[];
    /** the pages of output.pdf, when output.log says */
    pages?: number;
    /** LaTeX, package and class warnings by kind, with line numbers and other numbers as N, most frequent first */
    warnings: Array<{ kind: string, count: number }>;
}

function read(file: string): string | undefined {
    try { return fs.readFileSync(file, 'latin1'); } catch { return undefined; }
}

export function checkBuild(dir: string): BuildCheck {
    const problems: string[] = [];
    const notes: string[] = [];
    const log = read(path.join(dir, 'output.log'));
    if (log === undefined) {
        return { ok: false, problems: [`${path.join(dir, 'output.log')} is missing`], notes, warnings: [] };
    }
    const lines = log.split('\n');
    const written = /^Output written on output\.pdf \((\d+) pages?/m.exec(log);
    if (!/^Output written on output\.pdf/m.test(log)) {
        problems.push('output.log does not say that output.pdf was written');
    }
    const errorAt = lines.findIndex(line => line.startsWith('! '));
    if (errorAt >= 0) {
        const count = lines.filter(line => line.startsWith('! ')).length;
        const quoted: string[] = [];
        for (let i = errorAt; i < lines.length && quoted.length < 10; i++) {
            quoted.push(`  ${lines[i]}`);
            if (/^l\.\d+/.test(lines[i])) {
                if (i + 1 < lines.length) { quoted.push(`  ${lines[i + 1]}`); }
                break;
            }
        }
        problems.push(`${count} LaTeX errors in output.log; the first:\n${quoted.join('\n')}`);
    }
    const stdout = read(path.join(dir, 'output.stdout'));
    const summaryAt = stdout?.indexOf('Collected error summary') ?? -1;
    if (stdout !== undefined && summaryAt >= 0) {
        const after = stdout.slice(summaryAt).split('\n').slice(0, 5).map(line => `  ${line}`).join('\n');
        problems.push(`latexmk reports errors in output.stdout:\n${after}`);
    }
    const stderr = read(path.join(dir, 'output.stderr'));
    const indexLines = (stderr ?? '').split('\n').filter(line => line.startsWith('Automatic index:'));
    if (indexLines.length) {
        problems.push(`the automatic index reports a failure in output.stderr:\n${indexLines.slice(0, 3).map(line => `  ${line}`).join('\n')}`);
    }
    const notBuilt = /The index was not (built|sorted).*/.exec(log);
    if (notBuilt) {
        problems.push(`output.log says: ${notBuilt[0]}`);
    }
    const autoindex = lines.filter(line => line.includes('Package autoindex Warning')).length;
    if (autoindex) {
        const at = lines.findIndex(line => line.includes('Package autoindex Warning'));
        notes.push(`${autoindex} autoindex warnings in output.log; the first:\n${lines.slice(at, at + 3).map(line => `  ${line}`).join('\n')}`);
    }
    const kinds = new Map<string, number>();
    for (const line of lines) {
        if (!/^(LaTeX|Package [A-Za-z-]+|Class [A-Za-z-]+) Warning/.test(line)) { continue; }
        const kind = line.replace(/ on input line \d+\.?$/, '').replace(/\d+/g, 'N');
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const warnings = [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
    return { ok: problems.length === 0, problems, notes, pages: written ? Number(written[1]) : undefined, warnings };
}
