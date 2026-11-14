import { applyHistoryDiffs, HistoryDiff } from '../applyHistoryDiffs';

function reference(content: string, events: HistoryDiff[][]): string {
    for (const event of events) {
        for (const diff of [...event].sort((a, b) => b.offset - a.offset)) {
            content = content.slice(0, diff.offset) + diff.inserted + content.slice(diff.offset + diff.removeLength);
        }
    }
    return content;
}

describe('batched history reconstruction', () => {
    it.each([20, 300_000])('preserves UTF-16 offsets and multi-cursor event ordering (%i characters)', size => {
        const base = 'あ😀\n'.repeat(Math.ceil(size / 4));
        const events: HistoryDiff[][] = [
            [{ offset: 0, removeLength: 0, inserted: 'start' }, { offset: size - 4, removeLength: 2, inserted: 'end' }],
            [{ offset: 6, removeLength: 2, inserted: '\ud800' }],
            [{ offset: 5, removeLength: 17, inserted: '' }],
            [{ offset: 0, removeLength: 0, inserted: 'same' }, { offset: 0, removeLength: 0, inserted: 'offset' }],
        ];
        expect(applyHistoryDiffs(base, events)).toBe(reference(base, events));
    });

    it('matches sequential edits across thousands of fragmented pieces and their boundaries', () => {
        const base = '0123456789あ😀\n'.repeat(24_000);
        let expected = base;
        let seed = 42;
        const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
        const events: HistoryDiff[][] = [];
        for (let i = 0; i < 3200; i++) {
            const offset = random() % (expected.length + 1);
            const event = [{ offset, removeLength: Math.min(random() % 30, expected.length - offset), inserted: `あ😀${i}\n` }];
            events.push(event);
            expected = reference(expected, [event]);
        }
        expect(applyHistoryDiffs(base, events)).toBe(expected);
    });

    it('handles replacing the whole document, an empty document, and appending at EOF', () => {
        const base = 'x'.repeat(300_000);
        const events = [[{ offset: 0, removeLength: base.length, inserted: '' }],
            [{ offset: 0, removeLength: 0, inserted: 'new' }],
            [{ offset: 3, removeLength: 0, inserted: ' end' }]];
        expect(applyHistoryDiffs(base, events)).toBe('new end');
    });
});
