import { allowLargeDocumentForSession, evaluateDocumentTracking, forgetClosedDocumentTracking, forgetDocumentTracking, readTrackingSettings } from '../documentTracking';
import { DEFAULT_ENABLED_EXTENSIONS, DEFAULT_ENABLED_FILE_NAMES, DEFAULT_EXCLUDE_PATTERNS, TrackingSettings } from '../tracking';

jest.mock('vscode');

const settings: TrackingSettings = { enabledExtensions: DEFAULT_ENABLED_EXTENSIONS,
    enabledFileNames: DEFAULT_ENABLED_FILE_NAMES, excludePatterns: DEFAULT_EXCLUDE_PATTERNS };

function makeDocument(initial: string, name = 'notes.unknown') {
    let text = initial;
    const doc = {
        uri: { scheme: 'file', fsPath: name, toString: () => `file:///${name}` },
        fileName: name, version: 1,
        positionAt: (offset: number) => Math.min(text.length, offset),
        offsetAt: (position: number) => position,
        getText: jest.fn((range?: { start: number; end: number }) => range ? text.slice(range.start, range.end) : text),
    };
    return { doc: doc as any, update: (value: string) => { text = value; doc.version++; } };
}

describe('bounded document tracking', () => {
    it('rejects an oversized document without requesting its contents', () => {
        const { doc } = makeDocument('a'.repeat(1_000_001));
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).reason).toBe('size');
        expect(doc.getText).not.toHaveBeenCalled();
    });

    it('reads at most 4096 code units and caches classification until the version changes', () => {
        const { doc, update } = makeDocument('a'.repeat(900_000));
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).tracked).toBe(true);
        expect(doc.getText.mock.calls).toEqual([[expect.objectContaining({ start: 0, end: 2048 })],
            [expect.objectContaining({ start: 897_952, end: 900_000 })]]);
        for (let i = 0; i < 20; i++) { evaluateDocumentTracking(doc, doc.fileName, settings); }
        expect(doc.getText).toHaveBeenCalledTimes(2);
        update('a'.repeat(899_999) + '\0');
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).reason).toBe('binary');
        expect(doc.getText).toHaveBeenCalledTimes(4);
    });

    it('reevaluates changed settings and size transitions without stale cached decisions', () => {
        const { doc, update } = makeDocument('a'.repeat(10));
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).tracked).toBe(true);
        expect(evaluateDocumentTracking(doc, doc.fileName, { ...settings, maxTrackedFileChars: 5 }).reason).toBe('size');
        expect(evaluateDocumentTracking(doc, doc.fileName, { ...settings, excludePatterns: ['*.unknown'] }).reason).toBe('excludePattern');
        update('a'.repeat(1_000_001));
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).reason).toBe('size');
        update('short');
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).tracked).toBe(true);
    });

    it('allows a size override for one document until it closes, without bypassing exclusions or binary checks', () => {
        const { doc } = makeDocument('a'.repeat(1_000_001));
        allowLargeDocumentForSession(doc);
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).tracked).toBe(true);
        expect(evaluateDocumentTracking(doc, doc.fileName, { ...settings, excludePatterns: ['*.unknown'] }).reason).toBe('excludePattern');
        const other = makeDocument('a'.repeat(1_000_001)).doc;
        expect(evaluateDocumentTracking(other, other.fileName, settings).reason).toBe('size');
        forgetDocumentTracking(doc);
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).reason).toBe('size');
        const binary = makeDocument('\0'.repeat(1_000_001)).doc;
        allowLargeDocumentForSession(binary);
        expect(evaluateDocumentTracking(binary, binary.fileName, settings).reason).toBe('binary');
    });

    it('rejects excluded paths and known binaries before requesting document contents', () => {
        for (const name of ['photo.png', '.env', 'dist/app.unknown']) {
            const { doc } = makeDocument('anything', name);
            expect(evaluateDocumentTracking(doc, name, settings).tracked).toBe(false);
            expect(doc.getText).not.toHaveBeenCalled();
        }
    });

    it('revokes a retained document override when its last tab closes, but keeps it while another tab is open', () => {
        const { doc } = makeDocument('a'.repeat(1_000_001));
        const key = doc.uri.toString();
        allowLargeDocumentForSession(doc);
        expect(forgetClosedDocumentTracking([doc], new Set([key]), new Set([key]))).toEqual([]);
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).tracked).toBe(true);
        expect(forgetClosedDocumentTracking([doc], new Set([key]), new Set())).toEqual([doc]);
        expect(evaluateDocumentTracking(doc, doc.fileName, settings).reason).toBe('size');
    });

    it('recognizes explicit empty legacy settings and validates new settings', () => {
        const config = { get: (key: string) => key === 'enabledExtensions' ? [] : undefined,
            inspect: (key: string) => key === 'enabledExtensions' ? { workspaceFolderValue: [] } : undefined } as any;
        const resolved = readTrackingSettings(config);
        expect(resolved.extensionsExplicit).toBe(true);
        expect(resolved.maxTrackedFileChars).toBe(1_000_000);
        const { doc } = makeDocument('text');
        expect(evaluateDocumentTracking(doc, doc.fileName, resolved).reason).toBe('extension');
    });
});
