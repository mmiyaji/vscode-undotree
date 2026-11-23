import { mergeSerializedTrees, SerializedUndoTree, UndoTreeManager } from '../undoTreeManager';

jest.mock('vscode');

function makeUri(value = 'file:///integrity.md') {
    return { toString: () => value } as any;
}

function makeDocument(content: string, uri = 'file:///integrity.md') {
    return {
        getText: () => content,
        uri: makeUri(uri),
        isUntitled: false,
        positionAt: (offset: number) => offset,
    } as any;
}

function makeChangeEvent(content: string, uri: string, offset: number, inserted: string) {
    return {
        document: makeDocument(content, uri),
        contentChanges: [{ rangeOffset: offset, rangeLength: 0, text: inserted }],
    } as any;
}

function serializedTree(nodes: SerializedUndoTree['nodes'], currentId: number): SerializedUndoTree {
    return { nodes, currentId, rootId: 0, hashMap: nodes.map((node) => [node.hash, node.id]) };
}

const managers: UndoTreeManager[] = [];

function createManager(): UndoTreeManager {
    const manager = new UndoTreeManager();
    managers.push(manager);
    return manager;
}

afterEach(() => {
    for (const manager of managers.splice(0)) {
        manager.dispose();
    }
});

describe('history integrity regressions', () => {
    it.each(['completed', 'editing'] as const)('keeps the live cursor when a captured save records after a %s jump', async (phase) => {
        const manager = createManager();
        const initial = 'a'.repeat(100);
        let content = initial;
        const document = { ...makeDocument(content), getText: () => content };
        manager.onDidSaveTextDocument(document);
        content += 'B';
        manager.onDidSaveTextDocument(document);
        const tree = manager.getTree(document.uri);
        const savedParent = tree.currentId;
        content += 'C';
        manager.onDidChangeTextDocument(makeChangeEvent(content, 'file:///integrity.md', 101, 'C'));
        const save = manager.captureSave(document)!;
        let releaseEdit!: () => void;
        let editStarted!: () => void;
        const started = new Promise<void>(resolve => { editStarted = resolve; });
        const editGate = new Promise<void>(resolve => { releaseEdit = resolve; });
        const editor = {
            document,
            edit: async (callback: (builder: any) => void) => {
                callback({ replace: (_range: unknown, text: string) => { content = text; } });
                editStarted();
                if (phase === 'editing') { await editGate; }
                return true;
            },
        } as any;
        const jump = manager.jumpToNode(tree.rootId, editor);
        await started;
        if (phase === 'completed') { await jump; }
        save.record();
        expect(tree.currentId).toBe(tree.rootId);
        const savedNode = [...tree.nodes.values()].find(node => manager.reconstructContent(tree, node.id) === initial + 'BC');
        expect(savedNode?.parents).toEqual([savedParent]);
        releaseEdit();
        await jump;

        // A save caused by the restore itself must not move back to the captured save.
        manager.onDidSaveTextDocument(document);
        expect(tree.currentId).toBe(tree.rootId);
        content += 'D';
        manager.onDidChangeTextDocument(makeChangeEvent(content, 'file:///integrity.md', 100, 'D'));
        manager.onDidSaveTextDocument(document);
        expect(tree.nodes.get(tree.currentId)?.storage.kind).toBe('delta');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(content);
        const restored = createManager();
        restored.importState(manager.exportState());
        expect(restored.reconstructContent(restored.getTree(document.uri), tree.currentId)).toBe(initial + 'D');
    });

    it('reuses remapped branches on repeated merges, including out-of-order delta descendants and metadata', () => {
        const root = { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full' as const, content: '' } };
        const base = serializedTree([root,
            { id: 1, parents: [0], children: [], timestamp: 2, label: 'A', hash: 'A', storage: { kind: 'full', content: 'A' } },
        ], 1);
        const incoming = serializedTree([
            { id: 2, parents: [1], children: [], timestamp: 4, label: 'B!', hash: 'B!', storage: { kind: 'delta', diffs: [[{ offset: 1, removeLength: 0, inserted: '!' }]] }, note: 'reviewed', noteUpdatedAt: 4, pinned: true, pinnedUpdatedAt: 4 },
            { id: 1, parents: [0], children: [2], timestamp: 3, label: 'B', hash: 'B', storage: { kind: 'full', content: 'B' } },
            root,
        ], 2);
        let merged = mergeSerializedTrees(base, incoming);
        const size = merged.tree.nodes.length;
        const currentId = merged.tree.currentId;
        const nextId = merged.nextId;
        incoming.nodes[0] = { ...incoming.nodes[0], note: undefined, noteUpdatedAt: 5, pinned: false, pinnedUpdatedAt: 5 };
        for (let iteration = 0; iteration < 5; iteration++) {
            merged = mergeSerializedTrees(merged.tree, incoming, merged.nextId);
            expect(merged.tree.nodes).toHaveLength(size);
            expect(merged.tree.currentId).toBe(currentId);
            expect(merged.nextId).toBe(nextId);
        }
        expect(merged.tree.nodes.find(node => node.id === currentId)).toMatchObject({ noteUpdatedAt: 5, pinned: false, pinnedUpdatedAt: 5 });
        expect(merged.tree.nodes.find(node => node.id === currentId)?.note).toBeUndefined();
        const restored = createManager();
        restored.importTree('file:///merged.md', merged.tree, merged.nextId);
        const tree = restored.getTree(makeUri('file:///merged.md'));
        expect(restored.reconstructContent(tree, tree.currentId)).toBe('B!');
        expect([...tree.nodes.values()].filter(node => node.hash === 'B')).toHaveLength(1);
    });

    it('keeps a loaded jump target when a save was captured before its tree was loaded', async () => {
        const manager = createManager();
        const initial = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(initial));
        manager.onDidSaveTextDocument(makeDocument(initial + 'B'));
        const state = manager.exportState();
        manager.unloadTree(makeUri());
        let content = initial + 'BC';
        const document = { ...makeDocument(content), getText: () => content };
        const pending = manager.captureSave(document)!;
        manager.importTree(document.uri.toString(), state.trees[document.uri.toString()]);
        const tree = manager.getTree(document.uri);
        await manager.jumpToNode(tree.rootId, {
            document,
            edit: async (callback: (builder: any) => void) => {
                callback({ replace: (_range: unknown, text: string) => { content = text; } });
                return true;
            },
        } as any);
        pending.record();
        expect(tree.currentId).toBe(tree.rootId);
        content += 'D';
        manager.onDidChangeTextDocument(makeChangeEvent(content, 'file:///integrity.md', 100, 'D'));
        manager.onDidSaveTextDocument(document);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(content);
    });

    it.each(['before', 'after'])('handles a save captured during a jump and recorded %s the editor applies it', async (timing) => {
        const manager = createManager();
        const initial = 'a'.repeat(100);
        let content = initial;
        const document = { ...makeDocument(content), getText: () => content };
        manager.onDidSaveTextDocument(document);
        content += 'B';
        manager.onDidSaveTextDocument(document);
        const tree = manager.getTree(document.uri);
        let start!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => { start = resolve; });
        const finished = new Promise<void>(resolve => { finish = resolve; });
        const jump = manager.jumpToNode(tree.rootId, {
            document,
            edit: async (callback: (builder: any) => void) => {
                let replacement = '';
                callback({ replace: (_range: unknown, text: string) => { replacement = text; } });
                start();
                await finished;
                content = replacement;
                return true;
            },
        } as any);
        await started;
        const save = manager.captureSave(document)!;
        if (timing === 'before') { save.record(); }
        finish();
        await jump;
        if (timing === 'after') { save.record(); }
        expect(tree.currentId).toBe(tree.rootId);
        content += 'D';
        manager.onDidChangeTextDocument(makeChangeEvent(content, 'file:///integrity.md', 100, 'D'));
        manager.onDidSaveTextDocument(document);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(content);
    });

    it('resynchronizes a file that crossed the size limit and later became small enough again', () => {
        const manager = createManager();
        const before = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(before));
        manager.invalidateTrackingBaseline(makeUri()); // Oversized change was ignored.
        const after = 'b'.repeat(100);
        manager.onDidChangeTextDocument({ document: makeDocument(after), contentChanges: [
            { rangeOffset: 100, rangeLength: 1_000_000, text: '' },
        ] } as any);
        manager.onDidSaveTextDocument(makeDocument(after));
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('full');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(after);
    });
    it('resumes with a full snapshot if an oversized edit was skipped during lazy loading', () => {
        const manager = createManager();
        const uri = makeUri();
        const opening = 'a'.repeat(1000);
        // Appending 100 characters exceeded the limit. Removing 99 brings the
        // document back into scope, but that removal has no recorded insertion.
        manager.invalidateTrackingBaseline(uri);
        const saved = makeDocument(opening + 'X');
        manager.onDidChangeTextDocument({ document: saved, contentChanges: [
            { rangeOffset: 1001, rangeLength: 99, text: '' },
        ] } as any);
        const tree = manager.syncLoadedDocumentState(uri, opening, true);
        manager.onDidSaveTextDocument(saved);
        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('full');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(saved.getText());
        manager.onDidChangeTextDocument(makeChangeEvent(opening + 'XY', uri.toString(), 1001, 'Y'));
        manager.onDidSaveTextDocument(makeDocument(opening + 'XY'));
        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('delta');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(opening + 'XY');
    });

    it('records a full snapshot after tracking settings invalidate the baseline', () => {
        const manager = createManager();
        const uri = 'file:///integrity.md';
        const before = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(before));
        // B was inserted while tracking was disabled.
        manager.invalidateTrackingBaselines();
        manager.onDidChangeTextDocument(makeChangeEvent(before + 'BC', uri, 101, 'C'));
        manager.onDidSaveTextDocument(makeDocument(before + 'BC'));
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('full');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(before + 'BC');
    });

    it('retains queued save contents and leaves subsequent unsaved diffs intact', () => {
        const manager = createManager();
        const uri = 'file:///integrity.md';
        const before = 'a'.repeat(100);
        let content = before;
        const document = { ...makeDocument(content), getText: () => content };
        manager.onDidSaveTextDocument(document);
        const capture = (text: string) => {
            manager.onDidChangeTextDocument(makeChangeEvent(content + text, uri, content.length, text));
            content += text;
            return manager.captureSave(document)!;
        };
        const first = capture('B');
        const second = capture('C');
        manager.onDidChangeTextDocument(makeChangeEvent(content + 'D', uri, content.length, 'D'));
        content += 'D';
        expect(manager.hasPendingDiffs(makeUri())).toBe(true);
        first.record();
        second.record();
        manager.onDidSaveTextDocument(document);
        const tree = manager.getTree(makeUri());
        expect([...tree.nodes.keys()].map(id => manager.reconstructContent(tree, id)))
            .toEqual([before, before + 'B', before + 'BC', before + 'BCD']);
        expect(manager.hasPendingDiffs(makeUri())).toBe(false);
    });

    it('uses a full snapshot when lazy loading changed the captured baseline', () => {
        const manager = createManager();
        const before = 'a'.repeat(100);
        const save = manager.captureSave(makeDocument(before + 'B'))!;
        manager.syncDocumentState(makeUri(), before + 'B');
        save.record();
        manager.onDidChangeTextDocument(makeChangeEvent(before + 'BC', 'file:///integrity.md', 101, 'C'));
        manager.onDidSaveTextDocument(makeDocument(before + 'BC'));
        const tree = manager.getTree(makeUri());
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(before + 'BC');
    });

    it('replaces only the changed span when navigating a large document', async () => {
        const manager = createManager();
        const prefix = 'あ😀\r\n'.repeat(40_000);
        const suffix = 'end\r\n'.repeat(40_000);
        const before = prefix + 'old' + suffix;
        let content = prefix + 'new' + suffix;
        manager.onDidSaveTextDocument(makeDocument(before));
        manager.onDidSaveTextDocument(makeDocument(content));
        const replace = jest.fn((range: { start: number; end: number }, text: string) => {
            content = content.slice(0, range.start) + text + content.slice(range.end);
        });
        const editor = {
            document: { ...makeDocument(content), getText: () => content },
            edit: async (callback: (builder: any) => void) => { callback({ replace }); return true; },
        } as any;
        await manager.undo(editor);
        expect(content).toBe(before);
        expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ start: prefix.length, end: prefix.length + 3 }), 'old');
        await manager.redo(editor);
        expect(content).toBe(prefix + 'new' + suffix);
        expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ start: prefix.length, end: prefix.length + 3 }), 'new');
    });

    it('compresses large snapshots asynchronously without clearing a newer dirty generation', async () => {
        const manager = createManager();
        manager.setContentCacheMax(0);
        const uri = makeUri('file:///background.md');
        const content = 'あ😀\n'.repeat(300_000);
        manager.onDidSaveTextDocument(makeDocument('root', uri.toString()));
        manager.onDidSaveTextDocument(makeDocument(content, uri.toString()));
        const tree = manager.getTree(uri);
        const coldId = tree.currentId;
        manager.onDidSaveTextDocument(makeDocument(content + 'end', uri.toString()));
        const generation = manager.getDirtyGenerations().get(uri.toString())!;
        expect(tree.nodes.get(coldId)!.storage.kind).toBe('full');
        await (manager as any).checkpointCompressionTask;
        expect(tree.nodes.get(coldId)!.storage.kind).toBe('checkpoint');
        expect(manager.clearDirtyIfGeneration(uri.toString(), generation)).toBe(false);
        expect(await manager.reconstructContentAsync(tree, coldId)).toBe(content);
        expect(await manager.getCheckpointContentAsync(tree.nodes.get(coldId)!.hash)).toBe(content);
        expect((manager as any).contentCacheBytes).toBe(0);
    });

    it('does not resurrect compressed contents after resetting during background work', async () => {
        const manager = createManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('root'));
        manager.onDidSaveTextDocument(makeDocument('x'.repeat(1_100_000)));
        manager.onDidSaveTextDocument(makeDocument('y'.repeat(1_100_000)));
        const task = (manager as any).checkpointCompressionTask;
        expect(task).toBeDefined();
        manager.resetAll();
        await task;
        expect(manager.hasTree(uri)).toBe(false);
        expect((manager as any).compressedCheckpoints.size).toBe(0);
        expect(manager.getDirtyUris().size).toBe(0);
    });

    it('keeps cold full snapshots recoverable with a zero decoded cache, including UTF-16 code units', async () => {
        const manager = createManager();
        manager.setContentCacheMax(0);
        const uri = makeUri('file:///compressed.md');
        const contents = ['root', 'one', 'two', 'three'].map(prefix => prefix + 'あ😀\n'.repeat(70_000) + '\ud800');
        for (const content of contents) { manager.onDidSaveTextDocument(makeDocument(content, uri.toString())); }
        const tree = manager.getTree(uri);
        const ids = [...tree.nodes.keys()];
        expect([...tree.nodes.values()].map(node => node.storage.kind)).toEqual(['full', 'checkpoint', 'checkpoint', 'full']);
        for (let i = 0; i < ids.length; i++) {
            expect(manager.reconstructContent(tree, ids[i])).toBe(contents[i]);
            expect(await manager.reconstructContentAsync(tree, ids[i])).toBe(contents[i]);
        }
        expect((manager as any).contentCacheBytes).toBe(0);
        const exported = manager.exportState();
        const restored = createManager();
        restored.contentResolver = hash => manager.getCheckpointContent(hash);
        restored.importState(exported);
        for (let i = 0; i < ids.length; i++) {
            expect(restored.reconstructContent(restored.getTree(uri), ids[i])).toBe(contents[i]);
        }
        // A dirty flag is not proof of a durable blob: clearing it must not lose bytes.
        manager.clearDirty([uri.toString()]);
        expect(manager.reconstructContent(tree, ids[1])).toBe(contents[1]);
        manager.unloadTree(uri);
        expect((manager as any).compressedCheckpoints.size).toBe(0);
    });

    it('releases compressed backing only after all referencing pending trees are persisted', () => {
        const manager = createManager();
        manager.setContentCacheMax(0);
        const content = 'shared'.repeat(50_000);
        const uris = ['file:///compressed-a.md', 'file:///compressed-b.md'];
        for (const uri of uris) {
            manager.onDidSaveTextDocument(makeDocument('root', uri));
            manager.onDidSaveTextDocument(makeDocument(content, uri));
            manager.onDidSaveTextDocument(makeDocument(content + 'end', uri));
        }
        const hash = [...(manager as any).compressedCheckpoints.keys()][0] as string;
        const blobs = new Map([[hash, manager.getCheckpointContent(hash)]]);
        manager.contentResolver = value => {
            const result = blobs.get(value);
            if (result === undefined) { throw new Error('missing blob'); }
            return result;
        };
        manager.markCheckpointPersistedForUri(uris[0], [hash]);
        expect((manager as any).compressedCheckpoints.has(hash)).toBe(true);
        manager.markCheckpointPersistedForUri(uris[1], [hash]);
        expect((manager as any).compressedCheckpoints.has(hash)).toBe(false);
        expect(manager.getCheckpointContent(hash)).toBe(content);
    });

    it('computes hard compact ancestry once for a detailed preview', () => {
        const manager = createManager();
        const uri = makeUri();
        for (let i = 0; i < 100; i++) { manager.onDidSaveTextDocument(makeDocument(String(i))); }
        const latest = jest.spyOn(manager as any, 'getLatestNodeId');
        const noted = jest.spyOn(manager as any, 'collectNotedAncestors');
        const preview = manager.previewHardCompactDetailed(manager.getTree(uri), 30);
        expect(preview.all).toHaveLength(100);
        expect(preview.removable).toHaveLength(0);
        expect(latest).toHaveBeenCalledTimes(1);
        expect(noted).toHaveBeenCalledTimes(1);
    });

    it('remaps every incoming relationship before merging colliding ids', () => {
        const base = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            { id: 1, parents: [0], children: [], timestamp: 2, label: 'base', hash: 'base-a', storage: { kind: 'full', content: 'A' } },
        ], 1);
        const incoming = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            { id: 1, parents: [0], children: [2], timestamp: 3, label: 'branch', hash: 'incoming-b', storage: { kind: 'full', content: 'B' } },
            {
                id: 2,
                parents: [1],
                children: [],
                timestamp: 4,
                label: 'leaf',
                hash: 'incoming-bc',
                storage: { kind: 'delta', diffs: [[{ offset: 1, removeLength: 0, inserted: 'C' }]] },
            },
        ], 2);

        const merged = mergeSerializedTrees(base, incoming, 3);
        const incomingParent = merged.tree.nodes.find((node) => node.hash === 'incoming-b')!;
        const incomingLeaf = merged.tree.nodes.find((node) => node.hash === 'incoming-bc')!;

        expect(incomingParent.id).not.toBe(1);
        expect(incomingLeaf.parents).toEqual([incomingParent.id]);

        const manager = createManager();
        manager.importTree('file:///merge.md', merged.tree, merged.nextId);
        const tree = manager.getTree(makeUri('file:///merge.md'));
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('BC');
    });

    it('splits same-id/hash delta nodes when their remapped parent paths differ', () => {
        const base = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            { id: 1, parents: [0], children: [2], timestamp: 2, label: 'base parent', hash: 'foo', storage: { kind: 'full', content: 'foo' } },
            {
                id: 2,
                parents: [1],
                children: [],
                timestamp: 3,
                label: 'base leaf',
                hash: 'barfoo!',
                note: 'base branch note',
                noteUpdatedAt: 100,
                pinned: true,
                pinnedUpdatedAt: 100,
                storage: {
                    kind: 'delta',
                    diffs: [
                        [{ offset: 0, removeLength: 0, inserted: 'bar' }],
                        [{ offset: 6, removeLength: 0, inserted: '!' }],
                    ],
                },
            },
        ], 2);
        const incoming = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            { id: 1, parents: [0], children: [2], timestamp: 4, label: 'incoming parent', hash: 'barfoo', storage: { kind: 'full', content: 'barfoo' } },
            {
                id: 2,
                parents: [1],
                children: [],
                timestamp: 5,
                label: 'incoming leaf',
                hash: 'barfoo!',
                note: 'incoming branch note',
                noteUpdatedAt: 200,
                pinnedUpdatedAt: 200,
                storage: { kind: 'delta', diffs: [[{ offset: 6, removeLength: 0, inserted: '!' }]] },
            },
        ], 2);

        const merged = mergeSerializedTrees(base, incoming, 3);
        const incomingParent = merged.tree.nodes.find((node) => node.hash === 'barfoo')!;
        const duplicateLeaves = merged.tree.nodes.filter((node) => node.hash === 'barfoo!');

        expect(duplicateLeaves).toHaveLength(2);
        expect(duplicateLeaves.find((node) => node.id === 2)?.parents).toEqual([1]);
        expect(duplicateLeaves.find((node) => node.id !== 2)?.parents).toEqual([incomingParent.id]);
        expect(duplicateLeaves.find((node) => node.id === 2)).toMatchObject({
            note: 'base branch note',
            noteUpdatedAt: 100,
            pinned: true,
            pinnedUpdatedAt: 100,
        });
        expect(duplicateLeaves.find((node) => node.id !== 2)).toMatchObject({
            note: 'incoming branch note',
            noteUpdatedAt: 200,
            pinnedUpdatedAt: 200,
        });
        expect(duplicateLeaves.find((node) => node.id !== 2)?.pinned).toBeUndefined();
        expect(merged.tree.currentId).not.toBe(2);
        let repeated = merged;
        for (let iteration = 0; iteration < 3; iteration++) {
            repeated = mergeSerializedTrees(repeated.tree, incoming, repeated.nextId);
            expect(repeated.tree).toEqual(merged.tree);
            expect(repeated.nextId).toBe(merged.nextId);
        }

        const manager = createManager();
        manager.importTree('file:///same-hash-parent-collision.md', merged.tree, merged.nextId);
        const tree = manager.getTree(makeUri('file:///same-hash-parent-collision.md'));
        expect(manager.reconstructContent(tree, 2)).toBe('barfoo!');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('barfoo!');
    });

    it('applies newer note and pin tombstones as authoritative clears', () => {
        const base = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 2,
                label: 'same',
                hash: 'same',
                storage: { kind: 'full', content: 'same' },
                note: 'remove me',
                noteUpdatedAt: 100,
                pinned: true,
                pinnedUpdatedAt: 100,
            },
        ], 1);
        const incoming = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 3,
                label: 'same',
                hash: 'same',
                storage: { kind: 'full', content: 'same' },
                noteUpdatedAt: 200,
                pinnedUpdatedAt: 200,
            },
        ], 1);

        const mergedNode = mergeSerializedTrees(base, incoming).tree.nodes.find((node) => node.id === 1)!;
        expect(mergedNode.note).toBeUndefined();
        expect(mergedNode.noteUpdatedAt).toBe(200);
        expect(mergedNode.pinned).toBeUndefined();
        expect(mergedNode.pinnedUpdatedAt).toBe(200);
    });

    it('does not let stale metadata erase a newer note or resurrect an old pin', () => {
        const base = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 3,
                label: 'same',
                hash: 'same',
                storage: { kind: 'full', content: 'same' },
                note: 'new note',
                noteUpdatedAt: 300,
                pinnedUpdatedAt: 300,
            },
        ], 1);
        const staleIncoming = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 2,
                label: 'same',
                hash: 'same',
                storage: { kind: 'full', content: 'same' },
                pinned: true,
                pinnedUpdatedAt: 200,
            },
        ], 1);

        const mergedNode = mergeSerializedTrees(base, staleIncoming).tree.nodes.find((node) => node.id === 1)!;
        expect(mergedNode.note).toBe('new note');
        expect(mergedNode.noteUpdatedAt).toBe(300);
        expect(mergedNode.pinned).toBeUndefined();
        expect(mergedNode.pinnedUpdatedAt).toBe(300);
    });

    it('preserves legacy metadata when neither snapshot has tombstone revisions', () => {
        const base = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 2,
                label: 'same',
                hash: 'same',
                storage: { kind: 'full', content: 'same' },
                note: 'legacy note',
                pinned: true,
            },
        ], 1);
        const incoming = serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: '' } },
            { id: 1, parents: [0], children: [], timestamp: 3, label: 'same', hash: 'same', storage: { kind: 'full', content: 'same' } },
        ], 1);

        const mergedNode = mergeSerializedTrees(base, incoming).tree.nodes.find((node) => node.id === 1)!;
        expect(mergedNode.note).toBe('legacy note');
        expect(mergedNode.pinned).toBe(true);
    });

    it('rolls back the logical cursor when TextEditor.edit returns false', async () => {
        const manager = createManager();
        const uri = 'file:///edit-false.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('next', uri));
        const tree = manager.getTree(makeUri(uri));
        const previousCurrentId = tree.currentId;
        manager.clearDirty([uri]);
        const editor = {
            document: makeDocument('next', uri),
            edit: async (callback: (builder: { replace: jest.Mock }) => void) => {
                callback({ replace: jest.fn() });
                return false;
            },
        } as any;

        await manager.jumpToNode(0, editor, tree);

        expect(tree.currentId).toBe(previousCurrentId);
        expect(manager.getDirtyUris()).not.toContain(uri);
    });

    it('uses a workspace edit when undoing a document without a visible editor', async () => {
        const vscode = require('vscode');
        const manager = createManager();
        const uri = 'file:///hidden-source.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('latest', uri));
        const document = makeDocument('latest', uri);
        vscode.workspace.applyEdit.mockResolvedValueOnce(true);

        await manager.undo(document);

        expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
        const workspaceEdit = vscode.workspace.applyEdit.mock.calls[0][0];
        expect(workspaceEdit.edits).toHaveLength(1);
        expect(workspaceEdit.edits[0].content).toBe('base');
        expect(manager.getTree(makeUri(uri)).currentId).toBe(0);
    });

    it('queues a newer jump behind a pending failed jump for the same URI', async () => {
        const manager = createManager();
        const uri = 'file:///jump-race.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('middle', uri));
        manager.onDidSaveTextDocument(makeDocument('latest', uri));
        const tree = manager.getTree(makeUri(uri));
        let resolveFirstEdit!: (applied: boolean) => void;
        let signalFirstEditStarted!: () => void;
        const firstEditStarted = new Promise<void>((resolve) => {
            signalFirstEditStarted = resolve;
        });
        const firstEditResult = new Promise<boolean>((resolve) => {
            resolveFirstEdit = resolve;
        });
        const firstEditor = {
            document: makeDocument('latest', uri),
            edit: async (callback: (builder: { replace: jest.Mock }) => void) => {
                callback({ replace: jest.fn() });
                signalFirstEditStarted();
                return firstEditResult;
            },
        } as any;
        const secondEdit = jest.fn(async (callback: (builder: { replace: jest.Mock }) => void) => {
            callback({ replace: jest.fn() });
            return true;
        });
        const secondEditor = {
            document: makeDocument('latest', uri),
            edit: secondEdit,
        } as any;

        const firstJump = manager.jumpToNode(0, firstEditor, tree);
        await firstEditStarted;
        expect(tree.currentId).toBe(0);

        const secondJump = manager.jumpToNode(1, secondEditor, tree);
        await Promise.resolve();
        expect(secondEdit).not.toHaveBeenCalled();

        resolveFirstEdit(false);
        await firstJump;
        await secondJump;
        expect(tree.currentId).toBe(1);
        expect((manager as any).restoringByUri.size).toBe(0);
    });

    it('serializes same-URI edit promises even when the second resolves first', async () => {
        const manager = createManager();
        const uri = 'file:///jump-success-race.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('middle', uri));
        manager.onDidSaveTextDocument(makeDocument('latest', uri));
        const tree = manager.getTree(makeUri(uri));
        let content = 'latest';
        const document = {
            getText: () => content,
            uri: makeUri(uri),
            isUntitled: false,
            positionAt: (offset: number) => offset,
        } as any;
        let resolveFirstEdit!: (applied: boolean) => void;
        let signalFirstEditStarted!: () => void;
        const firstEditStarted = new Promise<void>((resolve) => {
            signalFirstEditStarted = resolve;
        });
        const firstEditResult = new Promise<boolean>((resolve) => {
            resolveFirstEdit = resolve;
        });
        let resolveSecondEdit!: (applied: boolean) => void;
        const secondEditResult = new Promise<boolean>((resolve) => {
            resolveSecondEdit = resolve;
        });
        const replaceContent = (callback: (builder: { replace: (_range: unknown, text: string) => void }) => void) => {
            callback({ replace: (_range, text) => { content = text; } });
        };
        const firstEditor = {
            document,
            edit: async (callback: (builder: { replace: (_range: unknown, text: string) => void }) => void) => {
                replaceContent(callback);
                signalFirstEditStarted();
                return firstEditResult;
            },
        } as any;
        const secondEdit = jest.fn(async (callback: (builder: { replace: (_range: unknown, text: string) => void }) => void) => {
            replaceContent(callback);
            return secondEditResult;
        });
        const secondEditor = {
            document,
            edit: secondEdit,
        } as any;

        const firstJump = manager.jumpToNode(0, firstEditor, tree);
        await firstEditStarted;
        const secondJump = manager.jumpToNode(1, secondEditor, tree);
        await Promise.resolve();
        expect(secondEdit).not.toHaveBeenCalled();

        // Resolve the queued edit's promise first. Its edit callback still must
        // not run until the first jump releases the per-URI queue.
        resolveSecondEdit(true);
        resolveFirstEdit(true);
        await firstJump;
        await secondJump;
        const secondHash = tree.nodes.get(1)!.hash;
        expect(content).toBe('middle');
        expect(tree.currentId).toBe(1);
        expect((manager as any).jumpSuppressedHashes.get(uri)).toBe(secondHash);
        expect((manager as any).restoringByUri.size).toBe(0);
    });

    it('queues a newer jump while checkpoint reconstruction is pending', async () => {
        const manager = createManager();
        const uri = 'file:///jump-stale-reconstruct.md';
        const checkpointHash = 'd'.repeat(40);
        manager.importTree(uri, serializedTree([
            { id: 0, parents: [], children: [1, 2], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: 'root' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 2,
                label: 'checkpoint',
                hash: checkpointHash,
                storage: { kind: 'checkpoint', contentHash: checkpointHash },
            },
            { id: 2, parents: [0], children: [], timestamp: 3, label: 'current', hash: 'current', storage: { kind: 'full', content: 'current' } },
        ], 2));
        let resolveCheckpoint!: (content: string) => void;
        let signalCheckpointStarted!: () => void;
        const checkpointStarted = new Promise<void>((resolve) => {
            signalCheckpointStarted = resolve;
        });
        const checkpointContent = new Promise<string>((resolve) => {
            resolveCheckpoint = resolve;
        });
        manager.asyncContentResolver = async () => {
            signalCheckpointStarted();
            return checkpointContent;
        };
        const staleEditor = {
            document: makeDocument('current', uri),
            edit: jest.fn(async () => true),
        } as any;
        const winningEdit = jest.fn(async (callback: (builder: { replace: jest.Mock }) => void) => {
            callback({ replace: jest.fn() });
            return true;
        });
        const winningEditor = {
            document: makeDocument('current', uri),
            edit: winningEdit,
        } as any;

        const staleJump = manager.jumpToNode(1, staleEditor);
        await checkpointStarted;
        const winningJump = manager.jumpToNode(0, winningEditor);
        await Promise.resolve();
        expect(winningEdit).not.toHaveBeenCalled();
        resolveCheckpoint('checkpoint content');
        await staleJump;
        await winningJump;

        const tree = manager.getTree(makeUri(uri));
        expect(staleEditor.edit).toHaveBeenCalledTimes(1);
        expect(tree.currentId).toBe(0);
        expect((manager as any).jumpSuppressedHashes.get(uri)).toBe(tree.nodes.get(0)!.hash);
    });

    it.each([
        { target: 'retained', historyIndex: 2 },
        { target: 'removed', historyIndex: 1 },
    ])('handles a $target jump target when compaction runs during checkpoint loading', async ({ target, historyIndex }) => {
        const manager = createManager();
        const uri = 'file:///compact-during-jump.md';
        const base = 'a'.repeat(1000);
        const tree = manager.getTree(makeUri(uri), base);
        const ids: number[] = [];
        let content = base;
        for (const inserted of ['B', 'C', 'D']) {
            const nextContent = content + inserted;
            manager.onDidChangeTextDocument(makeChangeEvent(nextContent, uri, content.length, inserted));
            manager.onDidSaveTextDocument(makeDocument(nextContent, uri));
            ids.push(tree.currentId);
            content = nextContent;
        }
        const root = tree.nodes.get(tree.rootId)!;
        root.storage = { kind: 'checkpoint', contentHash: root.hash };
        tree.currentId = root.id;

        let signalCheckpointStarted!: () => void;
        let resolveCheckpoint!: (value: string) => void;
        const checkpointStarted = new Promise<void>((resolve) => { signalCheckpointStarted = resolve; });
        const checkpointContent = new Promise<string>((resolve) => { resolveCheckpoint = resolve; });
        manager.asyncContentResolver = async () => {
            signalCheckpointStarted();
            return checkpointContent;
        };
        const replace = jest.fn();
        const edit = jest.fn(async (callback: (builder: { replace: jest.Mock }) => void) => {
            callback({ replace });
            return true;
        });
        const editor = { document: makeDocument(base, uri), edit } as any;

        const jump = manager.jumpToNode(ids[historyIndex], editor, tree);
        await checkpointStarted;
        expect(manager.compact(tree)).toBe(1);
        expect(tree.nodes.has(ids[1])).toBe(false);
        resolveCheckpoint(base);
        await jump;

        if (target === 'retained') {
            expect(replace).toHaveBeenCalledWith(expect.anything(), base + 'BCD');
            expect(tree.currentId).toBe(ids[historyIndex]);
        } else {
            expect(edit).not.toHaveBeenCalled();
            expect(tree.currentId).toBe(root.id);
        }
    });

    it('suppresses restore changes only for the URI being jumped', async () => {
        const manager = createManager();
        const jumpUri = 'file:///jump-uri-a.md';
        const editUri = 'file:///jump-uri-b.md';
        manager.onDidSaveTextDocument(makeDocument('jump base', jumpUri));
        manager.onDidSaveTextDocument(makeDocument('jump latest', jumpUri));
        const editBase = 'b'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(editBase, editUri));
        let resolveJump!: (applied: boolean) => void;
        let signalJumpStarted!: () => void;
        const jumpStarted = new Promise<void>((resolve) => {
            signalJumpStarted = resolve;
        });
        const jumpResult = new Promise<boolean>((resolve) => {
            resolveJump = resolve;
        });
        const editor = {
            document: makeDocument('jump latest', jumpUri),
            edit: async (callback: (builder: { replace: jest.Mock }) => void) => {
                callback({ replace: jest.fn() });
                signalJumpStarted();
                return jumpResult;
            },
        } as any;

        const jump = manager.jumpToNode(0, editor);
        await jumpStarted;
        const changed = `${editBase}x`;
        manager.onDidChangeTextDocument(makeChangeEvent(changed, editUri, editBase.length, 'x'));
        expect(manager.hasPendingDiffs(makeUri(editUri))).toBe(true);
        manager.onDidSaveTextDocument(makeDocument(changed, editUri));
        const editTree = manager.getTree(makeUri(editUri));
        expect(editTree.nodes.get(editTree.currentId)?.storage.kind).toBe('delta');

        resolveJump(false);
        await jump;
        expect((manager as any).restoringByUri.size).toBe(0);
    });

    it('aborts a jump before editing when reset occurs during checkpoint reconstruction', async () => {
        const manager = createManager();
        const uri = 'file:///jump-reset-reconstruct.md';
        const checkpointHash = 'c'.repeat(40);
        manager.importTree(uri, serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: 'root' } },
            {
                id: 1,
                parents: [0],
                children: [],
                timestamp: 2,
                label: 'checkpoint',
                hash: checkpointHash,
                storage: { kind: 'checkpoint', contentHash: checkpointHash },
            },
        ], 0));
        let resolveCheckpoint!: (content: string) => void;
        let signalCheckpointStarted!: () => void;
        const checkpointStarted = new Promise<void>((resolve) => {
            signalCheckpointStarted = resolve;
        });
        const checkpointContent = new Promise<string>((resolve) => {
            resolveCheckpoint = resolve;
        });
        manager.asyncContentResolver = async () => {
            signalCheckpointStarted();
            return checkpointContent;
        };
        const editor = {
            document: makeDocument('root', uri),
            edit: jest.fn(async () => true),
        } as any;

        const jump = manager.jumpToNode(1, editor);
        await checkpointStarted;
        manager.resetAll();
        const freshTree = manager.getTree(makeUri(uri), 'fresh');
        resolveCheckpoint('obsolete checkpoint');
        await jump;

        expect(editor.edit).not.toHaveBeenCalled();
        expect(manager.getTree(makeUri(uri))).toBe(freshTree);
        expect(manager.reconstructContent(freshTree, freshTree.currentId)).toBe('fresh');
        expect((manager as any).jumpSuppressedHashes.has(uri)).toBe(false);
    });

    it('reconciles the fresh tree when reset occurs after a jump edit starts', async () => {
        const manager = createManager();
        const uri = 'file:///jump-reset-edit.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('latest', uri));
        const oldTree = manager.getTree(makeUri(uri));
        let content = 'latest';
        const document = {
            getText: () => content,
            uri: makeUri(uri),
            isUntitled: false,
            positionAt: (offset: number) => offset,
        } as any;
        let resolveEdit!: (applied: boolean) => void;
        let signalEditStarted!: () => void;
        const editStarted = new Promise<void>((resolve) => {
            signalEditStarted = resolve;
        });
        const editResult = new Promise<boolean>((resolve) => {
            resolveEdit = resolve;
        });
        const editor = {
            document,
            edit: async (callback: (builder: { replace: (_range: unknown, text: string) => void }) => void) => {
                callback({ replace: (_range, text) => { content = text; } });
                signalEditStarted();
                return editResult;
            },
        } as any;

        const jump = manager.jumpToNode(0, editor, oldTree);
        await editStarted;
        expect(content).toBe('base');
        manager.resetAll();
        const freshTree = manager.getTree(makeUri(uri), 'fresh baseline');
        resolveEdit(true);
        await jump;

        expect(manager.getTree(makeUri(uri))).toBe(freshTree);
        expect(manager.reconstructContent(freshTree, freshTree.currentId)).toBe('base');
        expect(manager.getDirtyUris()).toContain(uri);
        expect((manager as any).jumpSuppressedHashes.has(uri)).toBe(false);
    });

    it('reconciles a replacement tree when importTree runs after a jump edit starts', async () => {
        const manager = createManager();
        const uri = 'file:///jump-import-edit.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('latest', uri));
        const oldTree = manager.getTree(makeUri(uri));
        manager.clearDirty([uri]);
        let content = 'latest';
        const document = {
            getText: () => content,
            uri: makeUri(uri),
            isUntitled: false,
            positionAt: (offset: number) => offset,
        } as any;
        let resolveEdit!: (applied: boolean) => void;
        let signalEditStarted!: () => void;
        const editStarted = new Promise<void>((resolve) => {
            signalEditStarted = resolve;
        });
        const editResult = new Promise<boolean>((resolve) => {
            resolveEdit = resolve;
        });
        const editor = {
            document,
            edit: async (callback: (builder: { replace: (_range: unknown, text: string) => void }) => void) => {
                callback({ replace: (_range, text) => { content = text; } });
                signalEditStarted();
                return editResult;
            },
        } as any;

        const jump = manager.jumpToNode(0, editor, oldTree);
        await editStarted;
        const replacement = serializedTree([
            {
                id: 0,
                parents: [],
                children: [],
                timestamp: 10,
                label: 'imported',
                hash: 'imported',
                storage: { kind: 'full', content: 'imported baseline' },
            },
        ], 0);
        manager.importTree(uri, replacement, 1);
        const importedTree = manager.getTree(makeUri(uri));
        resolveEdit(true);
        await jump;

        expect(manager.getTree(makeUri(uri))).toBe(importedTree);
        expect(manager.reconstructContent(importedTree, importedTree.currentId)).toBe('base');
        expect(manager.getDirtyUris()).toContain(uri);
        expect((manager as any).jumpSuppressedHashes.has(uri)).toBe(false);
    });

    it('clears stale diffs when tracking is paused or resumed', () => {
        const manager = createManager();
        const uri = 'file:///pause.md';
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidChangeTextDocument(makeChangeEvent('basex', uri, 4, 'x'));

        manager.paused = true;
        manager.onDidChangeTextDocument(makeChangeEvent('basexy', uri, 5, 'y'));
        manager.paused = false;
        manager.onDidSaveTextDocument(makeDocument('basexy', uri));

        const tree = manager.getTree(makeUri(uri));
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('basexy');
        expect(tree.nodes.get(tree.currentId)?.storage.kind).toBe('full');
    });

    it('uses a full snapshot for the first checkpoint after editing while paused', () => {
        const manager = createManager();
        const uri = 'file:///pause-resume-edits.md';
        const base = 'abcdefghij';
        manager.getTree(makeUri(uri), base);
        manager.paused = true;
        manager.onDidChangeTextDocument(makeChangeEvent(`X${base}`, uri, 0, 'X'));
        manager.paused = false;
        manager.onDidChangeTextDocument(makeChangeEvent(`X${base}Y`, uri, 11, 'Y'));
        manager.onDidSaveTextDocument(makeDocument(`X${base}Y`, uri));

        const tree = manager.getTree(makeUri(uri));
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(`X${base}Y`);
        expect(tree.nodes.get(tree.currentId)?.storage.kind).toBe('full');

        manager.onDidChangeTextDocument(makeChangeEvent(`X${base}YZ`, uri, 12, 'Z'));
        manager.onDidSaveTextDocument(makeDocument(`X${base}YZ`, uri));
        expect(tree.nodes.get(tree.currentId)?.storage.kind).toBe('delta');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(`X${base}YZ`);
    });

    it('preserves the full-snapshot requirement across a rename while paused', () => {
        const manager = createManager();
        const oldUri = makeUri('file:///before.md');
        const newUri = makeUri('file:///after.md');
        manager.getTree(oldUri, 'abcdefghij');
        manager.paused = true;
        manager.paused = false;
        manager.renameTree(oldUri, newUri);
        manager.onDidChangeTextDocument(makeChangeEvent('XabcdefghijY', newUri.toString(), 11, 'Y'));
        manager.onDidSaveTextDocument(makeDocument('XabcdefghijY', newUri.toString()));
        const tree = manager.getTree(newUri);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('XabcdefghijY');
    });

    it('keeps generated checkpoints non-evictable until their dirty generation is persisted', () => {
        const manager = createManager();
        manager.setMemoryCheckpointThreshold(1);
        manager.setContentCacheMax(1);

        const createCheckpoint = (uri: string, branchContent: string) => {
            manager.onDidSaveTextDocument(makeDocument(`root-${uri}`, uri));
            manager.onDidSaveTextDocument(makeDocument(branchContent, uri));
            const tree = manager.getTree(makeUri(uri));
            const branchPointId = tree.currentId;
            manager.onDidSaveTextDocument(makeDocument(`${branchContent}-main`, uri));
            tree.currentId = branchPointId;
            manager.onDidSaveTextDocument(makeDocument(`${branchContent}-side`, uri));
            const branchPoint = tree.nodes.get(branchPointId)!;
            expect(branchPoint.storage.kind).toBe('checkpoint');
            return { content: branchContent, hash: branchPoint.hash };
        };

        const first = createCheckpoint('file:///checkpoint-a.md', 'checkpoint-A-content');
        const second = createCheckpoint('file:///checkpoint-b.md', 'checkpoint-A-content');

        expect(second.hash).toBe(first.hash);
        expect(manager.getCheckpointContent(first.hash)).toBe(first.content);
        expect((manager as any).contentCacheBytes).toBeGreaterThan(1);
        manager.markCheckpointPersistedForUri('file:///checkpoint-a.md', [first.hash]);
        expect((manager as any).pendingCheckpointGenerations.has('file:///checkpoint-a.md')).toBe(false);
        expect((manager as any).pendingCheckpointGenerations.get('file:///checkpoint-b.md')?.has(second.hash)).toBe(true);

        const generations = manager.getDirtyGenerations();
        for (const [uri, generation] of generations) {
            expect(manager.clearDirtyIfGeneration(uri, generation)).toBe(true);
        }
        expect((manager as any).contentCacheBytes).toBeLessThanOrEqual(1);
    });

    it('does not clear a newer dirty generation after an older snapshot finishes', () => {
        const manager = createManager();
        const uri = makeUri('file:///generation.md');
        manager.onDidSaveTextDocument(makeDocument('base', uri.toString()));
        manager.clearDirty([uri.toString()]);
        manager.setNote(uri, 0, 'note');
        const noteAddedAt = manager.exportState().trees[uri.toString()].nodes[0].noteUpdatedAt!;
        const oldGeneration = manager.getDirtyGenerations().get(uri.toString())!;
        manager.setPinned(uri, 0, true);
        const pinnedAt = manager.exportState().trees[uri.toString()].nodes[0].pinnedUpdatedAt!;
        const currentGeneration = manager.getDirtyGenerations().get(uri.toString())!;

        expect(currentGeneration).toBeGreaterThan(oldGeneration);
        expect(manager.clearDirtyIfGeneration(uri.toString(), oldGeneration)).toBe(false);
        expect(manager.getDirtyUris()).toContain(uri.toString());
        expect(manager.clearDirtyIfGeneration(uri.toString(), currentGeneration)).toBe(true);

        manager.setNote(uri, 0, '');
        manager.setPinned(uri, 0, false);
        expect(manager.getDirtyUris()).toContain(uri.toString());
        const exported = manager.exportState().trees[uri.toString()].nodes[0];
        expect(exported.note).toBeUndefined();
        expect(exported.noteUpdatedAt).toBeGreaterThan(noteAddedAt);
        expect(exported.pinned).toBeUndefined();
        expect(exported.pinnedUpdatedAt).toBeGreaterThan(pinnedAt);

        const firstNoteTombstone = exported.noteUpdatedAt!;
        const firstPinTombstone = exported.pinnedUpdatedAt!;
        manager.setNote(uri, 0, '');
        manager.setPinned(uri, 0, false);
        const repeatedClear = manager.exportState().trees[uri.toString()].nodes[0];
        expect(repeatedClear.noteUpdatedAt).toBeGreaterThan(firstNoteTombstone);
        expect(repeatedClear.pinnedUpdatedAt).toBeGreaterThan(firstPinTombstone);
    });

    it('keeps a recent descendant and its old ancestors in every hard compact mode', () => {
        const manager = createManager();
        const uri = 'file:///retention.md';
        const day = 86_400_000;
        const now = Date.now();
        manager.onDidSaveTextDocument(makeDocument('base', uri));
        manager.onDidSaveTextDocument(makeDocument('main', uri));
        const tree = manager.getTree(makeUri(uri));
        const mainId = tree.currentId;
        tree.currentId = 0;
        manager.onDidSaveTextDocument(makeDocument('old-parent', uri));
        const oldParentId = tree.currentId;
        tree.nodes.get(oldParentId)!.timestamp = now - 60 * day;
        manager.onDidSaveTextDocument(makeDocument('recent-child', uri));
        const recentChildId = tree.currentId;
        tree.nodes.get(recentChildId)!.timestamp = now - 10 * day;
        tree.currentId = mainId;
        manager.onDidSaveTextDocument(makeDocument('latest', uri));

        const preview = manager.previewHardCompactDetailed(tree, 30);
        expect(preview.removable.map((item) => item.id)).not.toContain(oldParentId);
        expect(preview.removable.map((item) => item.id)).not.toContain(recentChildId);
        expect(manager.hardCompact(tree, 30)).toBe(0);

        const overrideResult = manager.hardCompactWithOverrides(
            tree,
            30,
            new Map([[oldParentId, 'remove']])
        );
        expect(overrideResult).toEqual({ removed: 0, skipped: 1 });
        expect(tree.nodes.has(oldParentId)).toBe(true);
        expect(tree.nodes.has(recentChildId)).toBe(true);
    });

    it('keeps buffered edits when a lazy reopen selects an existing ancestor', () => {
        const uri = 'file:///buffered-reopen.md';
        const base = 'a'.repeat(1000);
        const original = createManager();
        original.getTree(makeUri(uri), base);
        original.onDidSaveTextDocument(makeDocument(base + 'old', uri));
        const exported = original.exportState();

        const manager = createManager();
        manager.onDidChangeTextDocument(makeChangeEvent(base + 'X', uri, base.length, 'X'));
        manager.importTree(uri, exported.trees[uri], exported.nextId);
        const tree = manager.syncLoadedDocumentState(makeUri(uri), base, true);
        manager.onDidChangeTextDocument(makeChangeEvent(base + 'XY', uri, base.length + 1, 'Y'));
        manager.onDidSaveTextDocument(makeDocument(base + 'XY', uri));

        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('delta');
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(base + 'XY');
    });

    it('does not replay buffered edits already included when loading a live document', () => {
        const uri = 'file:///buffered-live-load.md';
        const base = 'a'.repeat(1000);
        const manager = createManager();
        manager.onDidChangeTextDocument(makeChangeEvent(base + 'X', uri, base.length, 'X'));
        const tree = manager.syncLoadedDocumentState(makeUri(uri), base + 'X');
        manager.onDidChangeTextDocument(makeChangeEvent(base + 'XY', uri, base.length + 1, 'Y'));
        manager.onDidSaveTextDocument(makeDocument(base + 'XY', uri));

        expect(manager.reconstructContent(tree, tree.currentId)).toBe(base + 'XY');
    });

    it('merges and imports large histories without an argument per node', () => {
        const count = 140_000;
        const nodes = Array.from({ length: count }, (_, id) => ({
            id, parents: id ? [id - 1] : [], children: id + 1 < count ? [id + 1] : [],
            timestamp: id, label: 'save', hash: String(id), storage: { kind: 'full' as const, content: String(id) },
        }));
        const tree = serializedTree(nodes, count - 1);
        expect(mergeSerializedTrees(undefined, tree).nextId).toBe(count);
        const merged = mergeSerializedTrees(tree, tree);
        expect(merged.nextId).toBe(count);
        expect(merged.tree.nodes).toHaveLength(count);
        const manager = createManager();
        const uri = makeUri();
        manager.importTree(uri.toString(), merged.tree);
        manager.onDidSaveTextDocument(makeDocument('after importTree'));
        expect(manager.getTree(uri).currentId).toBe(count);
        manager.importState({ nextId: 1, trees: { [uri.toString()]: tree } });
        manager.onDidSaveTextDocument(makeDocument('after importState'));
        expect(manager.getTree(uri).currentId).toBe(count);
    });

    it('raises nextId above every imported node even when the supplied hint is stale', () => {
        const manager = createManager();
        const uri = 'file:///next-id.md';
        manager.importTree(uri, serializedTree([
            { id: 0, parents: [], children: [50], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: 'root' } },
            { id: 50, parents: [0], children: [], timestamp: 2, label: 'imported', hash: 'imported', storage: { kind: 'full', content: 'imported' } },
        ], 50), 1);

        manager.onDidSaveTextDocument(makeDocument('new', uri));
        const tree = manager.getTree(makeUri(uri));
        expect(tree.currentId).toBe(51);
        expect(tree.nodes.has(51)).toBe(true);
    });

    it('stops ancestor traversal at a checkpoint full snapshot', async () => {
        const manager = createManager();
        const parentHash = 'a'.repeat(40);
        const childHash = 'b'.repeat(40);
        const uri = 'file:///checkpoint-boundary.md';
        manager.importTree(uri, serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: 'root' } },
            { id: 1, parents: [0], children: [2], timestamp: 2, label: 'parent checkpoint', hash: parentHash, storage: { kind: 'checkpoint', contentHash: parentHash } },
            { id: 2, parents: [1], children: [], timestamp: 3, label: 'child checkpoint', hash: childHash, storage: { kind: 'checkpoint', contentHash: childHash } },
        ], 2));
        const resolver = jest.fn((hash: string) => {
            if (hash === childHash) { return 'child snapshot'; }
            throw new Error('ancestor checkpoint must not be loaded');
        });
        manager.contentResolver = resolver;
        const tree = manager.getTree(makeUri(uri));

        expect(manager.reconstructContent(tree, 2)).toBe('child snapshot');
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(resolver).toHaveBeenCalledWith(childHash);

        const asyncManager = createManager();
        asyncManager.importTree(`${uri}.async`, serializedTree([
            { id: 0, parents: [], children: [1], timestamp: 1, label: 'root', hash: 'root', storage: { kind: 'full', content: 'root' } },
            { id: 1, parents: [0], children: [2], timestamp: 2, label: 'parent checkpoint', hash: parentHash, storage: { kind: 'checkpoint', contentHash: parentHash } },
            { id: 2, parents: [1], children: [], timestamp: 3, label: 'child checkpoint', hash: childHash, storage: { kind: 'checkpoint', contentHash: childHash } },
        ], 2));
        const asyncResolver = jest.fn(async (hash: string) => {
            if (hash === childHash) { return 'async child snapshot'; }
            throw new Error('ancestor checkpoint must not be loaded');
        });
        asyncManager.asyncContentResolver = asyncResolver;
        expect(await asyncManager.reconstructContentAsync(asyncManager.getTree(makeUri(`${uri}.async`)), 2)).toBe('async child snapshot');
        expect(asyncResolver).toHaveBeenCalledTimes(1);
        expect(asyncResolver).toHaveBeenCalledWith(childHash);
    });

    it('validates and hard-compacts a 10k-node branch without recursive stack overflow', () => {
        const manager = createManager();
        const uri = 'file:///long-history.md';
        const oldBranchLength = 10_000;
        const currentId = oldBranchLength + 1;
        const now = Date.now();
        const nodes: SerializedUndoTree['nodes'] = [{
            id: 0,
            parents: [],
            children: [1, currentId],
            timestamp: now,
            label: 'root',
            hash: 'root',
            storage: { kind: 'full', content: '' },
        }];
        for (let id = 1; id <= oldBranchLength; id++) {
            nodes.push({
                id,
                parents: [id === 1 ? 0 : id - 1],
                children: id === oldBranchLength ? [] : [id + 1],
                timestamp: now - 60 * 86_400_000,
                label: 'old',
                hash: `old-${id}`,
                storage: { kind: 'full', content: '' },
            });
        }
        nodes.push({
            id: currentId,
            parents: [0],
            children: [],
            timestamp: now,
            label: 'current',
            hash: 'current',
            storage: { kind: 'full', content: 'current' },
        });

        expect(() => manager.importTree(uri, serializedTree(nodes, currentId), currentId + 1)).not.toThrow();
        const tree = manager.getTree(makeUri(uri));
        expect(manager.hardCompact(tree, 30)).toBe(oldBranchLength);
        expect(tree.nodes.size).toBe(2);
        expect(manager.getDirtyUris()).toContain(uri);
    });

    it('unrefs autosave timers so they do not keep the extension host test process alive', () => {
        const manager = createManager();
        const timer = (manager as any).autosaveTimer as { hasRef?: () => boolean };
        expect(timer.hasRef?.()).toBe(false);

        manager.setAutosaveInterval(1234);
        expect(((manager as any).autosaveTimer as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    });
});
