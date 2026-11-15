import * as vscode from 'vscode';
import { UndoTreeManager } from '../undoTreeManager';

jest.mock('vscode');
jest.useFakeTimers();

describe('native Undo/Redo with save checkpoints', () => {
    let manager: UndoTreeManager;
    const uri = { toString: () => 'file:///native.md' } as vscode.Uri;
    const doc = (text: string) => ({ uri, getText: () => text }) as vscode.TextDocument;
    const change = (before: string, after: string, reason?: vscode.TextDocumentChangeReason) => {
        manager.onDidChangeTextDocument({
            document: doc(after), reason,
            contentChanges: [{ range: new vscode.Range(0, 0, 0, before.length), rangeOffset: 0, rangeLength: before.length, text: after }],
        } as vscode.TextDocumentChangeEvent);
    };
    const contents = () => {
        const tree = manager.getTree(uri);
        return [...tree.nodes.keys()].map(id => manager.reconstructContent(tree, id));
    };
    const current = () => {
        const tree = manager.getTree(uri);
        return manager.reconstructContent(tree, tree.currentId);
    };

    beforeEach(() => {
        manager = new UndoTreeManager();
        manager.getTree(uri, 'A');
    });
    afterEach(() => manager.dispose());

    it('discards stale edits after a checkpoint read failure before saving', () => {
        manager.resetAll();
        const base = 'a'.repeat(1000);
        const tree = manager.getTree(uri, base);
        const root = tree.nodes.get(tree.rootId)!;
        root.storage = { kind: 'checkpoint', contentHash: root.hash };
        manager.contentResolver = () => { throw new Error('missing checkpoint'); };
        const edit = (text: string, offset: number, remove: number, insert: string, reason?: vscode.TextDocumentChangeReason) =>
            manager.onDidChangeTextDocument({ document: doc(text), reason, contentChanges: [{ rangeOffset: offset, rangeLength: remove, text: insert, range: new vscode.Range(0, 0, 0, 0) }] } as vscode.TextDocumentChangeEvent);
        edit(base + 'X', 1000, 0, 'X');
        edit(base, 1000, 1, '', vscode.TextDocumentChangeReason.Undo);
        manager.contentResolver = () => base;
        edit(base + 'Y', 1000, 0, 'Y');
        manager.onDidSaveTextDocument(doc(base + 'Y'));
        expect(current()).toBe(base + 'Y');
        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('full');
    });

    it('stores small abandoned edits as deltas even for large documents', () => {
        manager.resetAll();
        const base = 'a'.repeat(500000);
        const tree = manager.getTree(uri, base);
        for (let i = 0; i < 8; i++) {
            const inserted = String(i);
            manager.onDidChangeTextDocument({ document: doc(base + inserted), reason: undefined, contentChanges: [{ rangeOffset: base.length, rangeLength: 0, text: inserted, range: new vscode.Range(0, 0, 0, 0) }] } as vscode.TextDocumentChangeEvent);
            manager.onDidChangeTextDocument({ document: doc(base), reason: vscode.TextDocumentChangeReason.Undo, contentChanges: [{ rangeOffset: base.length, rangeLength: 1, text: '', range: new vscode.Range(0, 0, 0, 0) }] } as vscode.TextDocumentChangeEvent);
        }
        const edits = [...tree.nodes.values()].filter(node => node.label === 'edit');
        expect(edits).toHaveLength(8);
        expect(edits.every(node => node.storage.kind === 'delta')).toBe(true);
        edits.forEach((node, index) => expect(manager.reconstructContent(tree, node.id)).toBe(base + index));
    });

    it('keeps ordinary typing buffered until save', () => {
        change('A', 'AB');
        expect(contents()).toEqual(['A']);
        manager.onDidSaveTextDocument(doc('AB'));
        expect(current()).toBe('AB');
        expect(manager.getTree(uri).nodes.get(manager.getTree(uri).currentId)!.label).toBe('save');
    });

    it('preserves an unsaved future and branches from the native undo destination', () => {
        change('A', 'AB');
        change('AB', 'A', vscode.TextDocumentChangeReason.Undo);
        const tree = manager.getTree(uri);
        const abandoned = tree.hashMap.get([...tree.nodes.values()].find(n => n.label === 'edit')!.hash)!;
        expect(current()).toBe('A');
        change('A', 'AC');
        manager.onDidSaveTextDocument(doc('AC'));
        expect(tree.nodes.get(tree.rootId)!.children).toEqual([abandoned, tree.currentId]);
        expect(contents()).toEqual(['A', 'AB', 'AC']);
    });

    it('follows saved ancestors and redo without duplicating checkpoints', () => {
        change('A', 'AB');
        manager.onDidSaveTextDocument(doc('AB'));
        change('AB', 'A', vscode.TextDocumentChangeReason.Undo);
        manager.onDidSaveTextDocument(doc('A'));
        change('A', 'AB', vscode.TextDocumentChangeReason.Redo);
        expect(current()).toBe('AB');
        expect(contents()).toEqual(['A', 'AB']);
        expect(manager.hasPendingDiffs(uri)).toBe(false);
        expect(manager.getDirtyUris().has(uri.toString())).toBe(true);
    });

    it('records unmatched native undo groups and reuses them on redo', () => {
        change('A', 'ABC');
        change('ABC', 'AB', vscode.TextDocumentChangeReason.Undo);
        change('AB', 'A', vscode.TextDocumentChangeReason.Undo);
        change('A', 'AB', vscode.TextDocumentChangeReason.Redo);
        change('AB', 'ABC', vscode.TextDocumentChangeReason.Redo);
        expect(current()).toBe('ABC');
        expect(contents()).toEqual(['A', 'ABC', 'AB']);
    });

    it('flushes captured saves before native navigation and preserves post-capture edits', () => {
        change('A', 'AB');
        const save = manager.captureSave(doc('AB'))!;
        change('AB', 'ABC');
        change('ABC', 'A', vscode.TextDocumentChangeReason.Undo);
        expect(current()).toBe('A');
        save.record(); // The queued extension task must be harmless now.
        expect(current()).toBe('A');
        expect(contents()).toEqual(['A', 'AB', 'ABC']);
        const tree = manager.getTree(uri);
        expect([...tree.nodes.values()].find(n => n.label === 'edit')!.parents)
            .toEqual([[...tree.nodes.values()].find(n => n.label === 'save')!.id]);
    });

    it('round-trips the selected node and abandoned branch through persistence', () => {
        change('A', 'AB');
        change('AB', 'A', vscode.TextDocumentChangeReason.Undo);
        change('A', 'AC');
        manager.onDidSaveTextDocument(doc('AC'));
        const restored = new UndoTreeManager();
        try {
            restored.importState(JSON.parse(JSON.stringify(manager.exportState())));
            const tree = restored.getTree(uri);
            expect(restored.reconstructContent(tree, tree.currentId)).toBe('AC');
            expect([...tree.nodes.keys()].map(id => restored.reconstructContent(tree, id)))
                .toEqual(['A', 'AB', 'AC']);
        } finally { restored.dispose(); }
    });

    it('keeps delta offsets relative to the selected checkpoint after native undo', () => {
        const base = 'a'.repeat(1000);
        manager.resetAll();
        const tree = manager.getTree(uri, base);
        const edit = (text: string, offset: number, remove: number, insert: string, reason?: vscode.TextDocumentChangeReason) => {
            manager.onDidChangeTextDocument({ document: doc(text), reason, contentChanges: [{
                range: new vscode.Range(0, offset, 0, offset + remove),
                rangeOffset: offset, rangeLength: remove, text: insert,
            }] });
        };
        edit(base + 'B', 1000, 0, 'B');
        manager.onDidSaveTextDocument(doc(base + 'B'));
        const savedId = tree.currentId;
        expect(tree.nodes.get(savedId)!.storage.kind).toBe('delta');
        edit(base + 'BC', 1001, 0, 'C');
        edit(base + 'B', 1001, 1, '', vscode.TextDocumentChangeReason.Undo);
        expect(tree.currentId).toBe(savedId);
        edit(base + 'BD', 1001, 0, 'D');
        manager.onDidSaveTextDocument(doc(base + 'BD'));
        expect(tree.nodes.get(tree.currentId)!.storage.kind).toBe('delta');
        expect(tree.nodes.get(tree.currentId)!.parents).toEqual([savedId]);
        expect(current()).toBe(base + 'BD');
        expect(contents()).toEqual([base, base + 'B', base + 'BC', base + 'BD']);
        manager.importState(JSON.parse(JSON.stringify(manager.exportState())));
        expect(current()).toBe(base + 'BD');
    });

    it('preserves an empty root when capturing the pre-undo state', () => {
        manager.resetAll();
        manager.getTree(uri, '');
        change('', 'B');
        change('B', '', vscode.TextDocumentChangeReason.Undo);
        expect(contents()).toEqual(['', 'B']);
        expect(current()).toBe('');
    });

    it('reopens at a saved ancestor without duplicate restores or losing its unsaved future', () => {
        change('A', 'AB');
        manager.onDidSaveTextDocument(doc('AB'));
        const savedId = manager.getTree(uri).currentId;
        manager.syncDocumentState(uri, 'ABC', 'auto');
        const futureId = manager.getTree(uri).currentId;
        for (let reopen = 0; reopen < 3; reopen++) {
            // A stale window or a prior session can persist the unsaved cursor.
            manager.getTree(uri).currentId = futureId;
            manager.importState(JSON.parse(JSON.stringify(manager.exportState())));
            const tree = manager.syncDocumentState(uri, 'AB');
            expect(tree.currentId).toBe(savedId);
            expect(tree.nodes.size).toBe(3);
            expect(tree.nodes.get(savedId)!.children).toContain(futureId);
            expect(manager.reconstructContent(tree, futureId)).toBe('ABC');
        }
    });

    it('reuses a saved state on another branch but records genuinely new disk content', () => {
        change('A', 'AB');
        manager.onDidSaveTextDocument(doc('AB'));
        const savedId = manager.getTree(uri).currentId;
        change('AB', 'A', vscode.TextDocumentChangeReason.Undo);
        change('A', 'AC');
        manager.onDidSaveTextDocument(doc('AC'));
        const tree = manager.syncDocumentState(uri, 'AB');
        expect(tree.currentId).toBe(savedId);
        expect(tree.nodes.size).toBe(3);
        manager.syncDocumentState(uri, 'external');
        expect(current()).toBe('external');
        expect(tree.nodes.get(tree.currentId)!.label).toBe('restore');
        expect(tree.nodes.get(tree.currentId)!.parents).toEqual([savedId]);
    });

    it('does not interpret changes while paused', () => {
        manager.paused = true;
        change('A', 'B', vscode.TextDocumentChangeReason.Undo);
        expect(contents()).toEqual(['A']);
    });

    it('preserves multiple captures in order before navigating', () => {
        change('A', 'AB');
        const first = manager.captureSave(doc('AB'))!;
        change('AB', 'ABC');
        const second = manager.captureSave(doc('ABC'))!;
        change('ABC', 'AB', vscode.TextDocumentChangeReason.Undo);
        first.record();
        second.record();
        expect(current()).toBe('AB');
        expect(contents()).toEqual(['A', 'AB', 'ABC']);
        expect(manager.hasPendingDiffs(uri)).toBe(false);
    });

    it('uses a full baseline after tracking was interrupted', () => {
        manager.invalidateTrackingBaseline(uri);
        change('untracked', 'untrackedB');
        change('untrackedB', 'untracked', vscode.TextDocumentChangeReason.Undo);
        change('untracked', 'untrackedC');
        manager.onDidSaveTextDocument(doc('untrackedC'));
        expect(current()).toBe('untrackedC');
        expect(contents()).toEqual(['A', 'untracked', 'untrackedC']);
    });

    it('reconstructs pre-undo text with multiple UTF-16 edits in one event', () => {
        manager.resetAll();
        manager.getTree(uri, 'a😀b\r\nc');
        manager.onDidChangeTextDocument({
            document: doc('x😀b\r\ny'),
            reason: undefined,
            contentChanges: [
                { range: new vscode.Range(0, 0, 0, 1), rangeOffset: 0, rangeLength: 1, text: 'x' },
                { range: new vscode.Range(1, 0, 1, 1), rangeOffset: 6, rangeLength: 1, text: 'y' },
            ],
        });
        change('x😀b\r\ny', 'a😀b\r\nc', vscode.TextDocumentChangeReason.Undo);
        expect(contents()).toEqual(['a😀b\r\nc', 'x😀b\r\ny']);
        expect(current()).toBe('a😀b\r\nc');
    });
});
