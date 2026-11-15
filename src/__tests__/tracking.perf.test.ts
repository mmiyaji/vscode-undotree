import { evaluateDocumentTracking } from '../documentTracking';
import { DEFAULT_ENABLED_EXTENSIONS, DEFAULT_ENABLED_FILE_NAMES, DEFAULT_EXCLUDE_PATTERNS } from '../tracking';

jest.mock('vscode');

const settings = { enabledExtensions: DEFAULT_ENABLED_EXTENSIONS, enabledFileNames: DEFAULT_ENABLED_FILE_NAMES,
    excludePatterns: DEFAULT_EXCLUDE_PATTERNS };

function document(length: number) {
    const doc = {
        uri: { scheme: 'file', fsPath: '/workspace/notes.custom', toString: () => 'file:///workspace/notes.custom' },
        version: 1,
        positionAt: (offset: number) => Math.min(offset, length),
        offsetAt: (position: number) => position,
        getText: jest.fn((range?: { start: number; end: number }) => {
            if (!range) { throw new Error('Tracking must not request the full document'); }
            return 'a'.repeat(range.end - range.start);
        }),
    };
    return doc as any;
}

describe('tracking admission performance', () => {
    it('rejects 5000 checks of a 5Mi-code-unit document without reading text within 500ms', () => {
        const doc = document(5 * 1024 * 1024);
        const start = performance.now();
        for (let i = 0; i < 5000; i++) {
            if (evaluateDocumentTracking(doc, 'notes.custom', settings).reason !== 'size') { throw new Error('Oversized document admitted'); }
        }
        const ms = performance.now() - start;
        console.log(`Oversized tracking admission: 5000 checks, ${ms.toFixed(1)}ms, zero text reads`);
        expect(doc.getText).not.toHaveBeenCalled();
        expect(ms).toBeLessThan(500);
    });

    it('checks a near-limit document 5000 times using one bounded sample within 500ms', () => {
        const doc = document(999_999);
        const start = performance.now();
        for (let i = 0; i < 5000; i++) {
            if (!evaluateDocumentTracking(doc, 'notes.custom', settings).tracked) { throw new Error('Text rejected'); }
        }
        const ms = performance.now() - start;
        console.log(`Cached tracking admission: 5000 checks, ${ms.toFixed(1)}ms, 4096 sampled units`);
        expect(doc.getText).toHaveBeenCalledTimes(2);
        expect(doc.getText.mock.results.reduce((sum: number, result: { value: string }) => sum + result.value.length, 0)).toBe(4096);
        expect(ms).toBeLessThan(500);
    });

    it('bounds text reads across 1000 document versions rather than scanning a near-limit document', () => {
        const doc = document(999_999);
        const start = performance.now();
        for (let version = 1; version <= 1000; version++) {
            doc.version = version;
            if (!evaluateDocumentTracking(doc, 'notes.custom', settings).tracked) { throw new Error('Text rejected'); }
        }
        const ms = performance.now() - start;
        console.log(`Changing tracking admission: 1000 versions, ${ms.toFixed(1)}ms, 4096 sampled units/version`);
        expect(doc.getText).toHaveBeenCalledTimes(2000);
        expect(ms).toBeLessThan(500);
    });
});
