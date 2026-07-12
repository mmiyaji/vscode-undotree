import { UndoTreeDocumentContentProvider, __test__ } from '../extension';

const vscode = require('vscode');

describe('UndoTreeDocumentContentProvider memory behavior', () => {
    afterEach(() => {
        __test__.setCompactPreviewTargetUri(undefined);
        vscode.window.activeTextEditor = undefined;
        vscode.window.visibleTextEditors = [];
        vscode.workspace.textDocuments = [];
    });

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

    it('keeps compact execution bound to its preview document when the active editor changes', () => {
        const targetDocument = {
            uri: { scheme: 'file', toString: () => 'file:///preview.md' },
            isUntitled: false,
        };
        const activeDocument = {
            uri: { scheme: 'file', toString: () => 'file:///active.md' },
            isUntitled: false,
        };
        vscode.window.activeTextEditor = { document: activeDocument, viewColumn: 2 };
        vscode.workspace.textDocuments = [targetDocument, activeDocument];
        __test__.setCompactPreviewTargetUri('file:///preview.md');

        expect(__test__.getCompactPreviewContextEditor(vscode.window.activeTextEditor)?.document)
            .toBe(targetDocument);

        vscode.workspace.textDocuments = [activeDocument];
        expect(__test__.getCompactPreviewContextEditor(vscode.window.activeTextEditor)).toBeUndefined();
    });

    it('runs persisted-state operations FIFO and continues after a failed operation', async () => {
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = __test__.enqueuePersistOperation(async () => {
            events.push('first:start');
            await firstGate;
            events.push('first:end');
        });
        const second = __test__.enqueuePersistOperation(async () => {
            events.push('second');
        });
        await Promise.resolve();
        expect(events).toEqual(['first:start']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second']);

        await expect(__test__.enqueuePersistOperation(async () => {
            throw new Error('expected failure');
        })).rejects.toThrow('expected failure');
        await expect(__test__.enqueuePersistOperation(async () => 'recovered')).resolves.toBe('recovered');
    });

    it('does not unload a tree that became dirty while its close flush was running', () => {
        const uri = { toString: () => 'file:///dirty-close.md' } as any;
        const dirtyManager = {
            getDirtyUris: () => new Set([uri.toString()]),
        } as any;
        const cleanManager = {
            getDirtyUris: () => new Set<string>(),
        } as any;

        expect(__test__.canUnloadTreeAfterFlush(dirtyManager, dirtyManager, uri, 2, 2)).toBe(false);
        expect(__test__.canUnloadTreeAfterFlush(cleanManager, cleanManager, uri, 2, 2)).toBe(true);
        expect(__test__.canUnloadTreeAfterFlush(cleanManager, cleanManager, uri, 2, 3)).toBe(false);
    });

    it('invalidates queued document tasks across a reset epoch', async () => {
        const uri = { toString: () => 'file:///reset-race.md' } as any;
        const events: string[] = [];
        let releaseRunning!: () => void;
        let signalStarted!: () => void;
        const runningGate = new Promise<void>((resolve) => {
            releaseRunning = resolve;
        });
        const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
        });

        const running = __test__.enqueueDocumentTask(uri, async () => {
            events.push('running:start');
            signalStarted();
            await runningGate;
            events.push('running:end');
        });
        await started;
        const queuedBeforeReset = __test__.enqueueDocumentTask(uri, async () => {
            events.push('stale-before-reset');
        });
        __test__.beginResetTaskEpoch();
        const queuedDuringReset = __test__.enqueueDocumentTask(uri, async () => {
            events.push('during-reset');
        });
        releaseRunning();
        await Promise.all([running, queuedBeforeReset, queuedDuringReset]);
        await __test__.drainDocumentTasks();
        __test__.endResetTaskEpoch();

        await __test__.enqueueDocumentTask(uri, async () => {
            events.push('post-reset');
        });
        expect(events).toEqual(['running:start', 'running:end', 'post-reset']);
    });
});
