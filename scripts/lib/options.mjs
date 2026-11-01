// The command-line options of the scripts: `--name value` or `--name=value` for an option that takes
// a value, `--name` alone for a flag. Each script names its options, so that a misspelled option, an
// option given twice, and an option without its value are refused instead of being ignored.
import fs from 'node:fs';

/** A wrong command line, which a script reports with its usage and exit status 64. */
export class UsageError extends Error {}

/**
 * The options in `argv` by `spec`, which gives each option's kind: 'value', 'number' (a value that
 * is a finite number) or 'flag'. Returns an object with the value of each option given: a string,
 * a number, or true for a flag. Throws a UsageError for an argument that is not an option of
 * `spec`, an option given twice, a flag given a value, and an option that takes a value given
 * without one, as when the next argument is another option.
 */
export function parseOptions(spec, argv) {
    const values = {};
    for (let i = 0; i < argv.length; i++) {
        const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(argv[i]);
        if (!match) { throw new UsageError(`${argv[i]} is not an option (--name)`); }
        const [, name, inline] = match;
        if (!Object.hasOwn(spec, name)) { throw new UsageError(`unknown option --${name}`); }
        if (Object.hasOwn(values, name)) { throw new UsageError(`--${name} is given twice`); }
        if (spec[name] === 'flag') {
            if (inline !== undefined) { throw new UsageError(`--${name} does not take a value`); }
            values[name] = true;
            continue;
        }
        const value = inline ?? argv[++i];
        if (value === undefined || (inline === undefined && value.startsWith('--'))) { throw new UsageError(`--${name} needs a value`); }
        if (spec[name] === 'number') {
            const number = Number(value);
            if (value.trim() === '' || !Number.isFinite(number)) { throw new UsageError(`--${name} needs a number, not ${value}`); }
            values[name] = number;
        } else {
            values[name] = value;
        }
    }
    return values;
}

/** The comment at the top of the script `file`, without the comment marks: the script's usage. */
export function usageOf(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.slice(0, lines.findIndex(line => !line.startsWith('//'))).map(line => line.replace(/^\/\/ ?/, '')).join('\n');
}

/**
 * The options of this process's script by `spec` (parseOptions): get(name, fallback) gives the value
 * of an option, or `fallback` when it is not given, and has(name) whether a flag is given; both
 * refuse a name that `spec` does not have. A wrong command line ends the script with the error, its
 * usage and exit status 64.
 */
export function scriptOptions(spec) {
    let values;
    try {
        values = parseOptions(spec, process.argv.slice(2));
    } catch (error) {
        if (!(error instanceof UsageError)) { throw error; }
        console.error(`${error.message}\n\n${usageOf(process.argv[1])}`);
        process.exit(64);
    }
    const known = (name) => {
        if (!Object.hasOwn(spec, name)) { throw new Error(`the script reads the option --${name}, which it does not name`); }
    };
    return {
        get: (name, fallback) => { known(name); return values[name] ?? fallback; },
        has: (name) => { known(name); return values[name] === true; },
    };
}
