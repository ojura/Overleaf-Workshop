/**
 * joinDoc sends each line of a document as its UTF-8 bytes packed into a string of
 * Latin-1 characters, one character per byte. This returns the line's text.
 */
export function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}
