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
