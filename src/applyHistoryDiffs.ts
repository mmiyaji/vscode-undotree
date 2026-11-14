export type HistoryDiff = { offset: number; removeLength: number; inserted: string };

/** Apply VS Code's UTF-16 offsets without copying the whole document per edit. */
export function applyHistoryDiffs(content: string, events: Iterable<HistoryDiff[]>): string {
    // Small documents are faster with native string slicing.
    if (content.length < 256 * 1024) {
        for (const event of events) {
            for (const diff of [...event].sort((a, b) => b.offset - a.offset)) {
                content = content.slice(0, diff.offset) + diff.inserted + content.slice(diff.offset + diff.removeLength);
            }
        }
        return content;
    }

    let pieces = [content];
    let length = content.length;
    for (const event of events) {
        // Offsets in one change event all refer to the same pre-edit document.
        for (const diff of [...event].sort((a, b) => b.offset - a.offset)) {
            const sliceIndex = (offset: number) => offset < 0 ? Math.max(0, length + offset) : Math.min(length, offset);
            const start = sliceIndex(diff.offset);
            const end = sliceIndex(diff.offset + diff.removeLength);
            let first = 0;
            let firstOffset = 0;
            while (first < pieces.length - 1 && firstOffset + pieces[first].length < start) {
                firstOffset += pieces[first++].length;
            }
            let last = first;
            let lastOffset = firstOffset;
            while (last < pieces.length - 1 && lastOffset + pieces[last].length < end) {
                lastOffset += pieces[last++].length;
            }
            const replacement = [pieces[first].slice(0, start - firstOffset), diff.inserted,
                pieces[last].slice(end - lastOffset)].filter((piece) => piece.length > 0);
            pieces.splice(first, last - first + 1, ...replacement);
            if (pieces.length === 0) { pieces.push(''); }
            length += diff.inserted.length - (end - start);
            // Bound traversal cost for extremely fragmented histories.
            if (pieces.length > 2048) { pieces = [pieces.join('')]; }
        }
    }
    return pieces.join('');
}
