/** Preserve offsets while excluding TeX line comments; an escaped percent remains text. */
export function withoutTexComments(text: string): string {
    return text.replace(/[^\r\n]+/g, line => {
        for (let index = 0; index < line.length; index++) {
            if (line[index] !== '%') { continue; }
            let slashes = 0;
            for (let before = index - 1; before >= 0 && line[before] === '\\'; before--) { slashes++; }
            if (slashes % 2 === 0) { return line.slice(0, index) + ' '.repeat(line.length - index); }
        }
        return line;
    });
}
