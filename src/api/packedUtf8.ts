/**
 * joinDoc sends each line of a document as its UTF-8 bytes packed into a string of
 * Latin-1 characters, one character per byte. This returns the line's text.
 *
 * Only joinDoc packs text: real-time's WebsocketController.joinDoc packs the lines, and with
 * `encodeRanges` the text of the comments and tracked changes, with
 * unescape(encodeURIComponent(text)); Overleaf's editor unpacks them with
 * decodeURIComponent(escape(text)) (decode-utf8.ts). The ops of an update are text as their
 * author sent it, in both directions: real-time queues an update as it arrives
 * (DocumentUpdaterManager.queueChange), document-updater applies it to the document's text
 * and publishes the applied op (ShareJsUpdateManager), and real-time hands it to the other
 * connections as otUpdateApplied (DocumentUpdaterController), which the editor applies
 * without unpacking it.
 */
export function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}
