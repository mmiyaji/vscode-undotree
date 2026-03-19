import { UndoTreeDocumentContentProvider } from '../extension';

describe('UndoTreeDocumentContentProvider memory behavior', () => {
    it('evicts the oldest virtual diff contents when the cache exceeds the limit', () => {
        const provider = new UndoTreeDocumentContentProvider();
        const created: Array<{ uri: { toString(): string }; content: string }> = [];

        for (let i = 0; i < 26; i++) {
            const content = `content-${i}`;
            const uri = provider.prepare(content, '.txt', `diff-cache-${i}`);
            created.push({ uri, content });
        }

        expect(provider.provideTextDocumentContent(created[0].uri as any)).toBe('');
        expect(provider.provideTextDocumentContent(created[1].uri as any)).toBe('');
        expect(provider.provideTextDocumentContent(created[25].uri as any)).toBe('content-25');
    });

    it('releases all virtual diff contents that share the same file prefix', () => {
        const provider = new UndoTreeDocumentContentProvider();
        const fileAKey = 'diff-fileA';
        const fileBKey = 'diff-fileB';
        const fileATarget = provider.prepare('target-a', '.txt', `${fileAKey}-target`);
        const fileACurrent = provider.prepare('current-a', '.txt', `${fileAKey}-current`);
        const fileBTarget = provider.prepare('target-b', '.txt', `${fileBKey}-target`);

        provider.releaseByPrefix(fileAKey);

        expect(provider.provideTextDocumentContent(fileATarget as any)).toBe('');
        expect(provider.provideTextDocumentContent(fileACurrent as any)).toBe('');
        expect(provider.provideTextDocumentContent(fileBTarget as any)).toBe('target-b');
    });
});
