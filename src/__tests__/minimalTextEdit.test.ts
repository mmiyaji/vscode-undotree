import { minimalTextEdit } from '../minimalTextEdit';

describe('minimal editor replacement', () => {
    it.each([
        ['', ''], ['', 'new'], ['old', ''], ['same', 'same'],
        ['prefix old suffix', 'prefix new suffix'],
        ['a\r\nb', 'a\nb'], ['a\nb', 'a\r\nb'],
        ['a😀b', 'a😁b'], ['a😀b', 'a\ud83db'], ['a\ud83db', 'a😀b'],
        ['a😀b', 'a🨀b'],
    ])('reconstructs %j -> %j without splitting CRLF or surrogate pairs', (before, after) => {
        const edit = minimalTextEdit(before, after);
        expect(before.slice(0, edit.offset) + edit.inserted + before.slice(edit.offset + edit.removeLength)).toBe(after);
        const boundary = (text: string, offset: number) => {
            const pair = text.slice(Math.max(0, offset - 1), offset + 1);
            expect(pair).not.toBe('\r\n');
            expect(pair).not.toMatch(/^[\ud800-\udbff][\udc00-\udfff]$/);
        };
        boundary(before, edit.offset);
        boundary(before, edit.offset + edit.removeLength);
        boundary(after, edit.offset);
        boundary(after, edit.offset + edit.inserted.length);
    });

    it('sends only the middle edit in a multi-megabyte document', () => {
        const prefix = 'start\r\n'.repeat(300_000);
        const suffix = 'end😀\r\n'.repeat(300_000);
        expect(minimalTextEdit(prefix + 'old' + suffix, prefix + 'new' + suffix)).toEqual({
            offset: prefix.length, removeLength: 3, inserted: 'new',
        });
    });
});
