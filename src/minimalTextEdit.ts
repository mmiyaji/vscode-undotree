import type { HistoryDiff } from './applyHistoryDiffs';

/** One replacement spanning only the changed text, at valid editor boundaries. */
export function minimalTextEdit(before: string, after: string): HistoryDiff {
    const chunk = 8192;
    const limit = Math.min(before.length, after.length);
    let start = 0;
    while (start + chunk <= limit && before.slice(start, start + chunk) === after.slice(start, start + chunk)) {
        start += chunk;
    }
    while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) { start++; }
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore - chunk >= start && endAfter - chunk >= start
        && before.slice(endBefore - chunk, endBefore) === after.slice(endAfter - chunk, endAfter)) {
        endBefore -= chunk;
        endAfter -= chunk;
    }
    while (endBefore > start && endAfter > start
        && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
        endBefore--;
        endAfter--;
    }
    const splitsPair = (text: string, offset: number) => {
        const left = text.charCodeAt(offset - 1);
        const right = text.charCodeAt(offset);
        return (left === 13 && right === 10)
            || (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
    };
    if (splitsPair(before, start) || splitsPair(after, start)) { start--; }
    if (splitsPair(before, endBefore) || splitsPair(after, endAfter)) {
        endBefore++;
        endAfter++;
    }
    return { offset: start, removeLength: endBefore - start, inserted: after.slice(start, endAfter) };
}
