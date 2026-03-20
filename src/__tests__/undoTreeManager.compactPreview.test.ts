import { UndoTreeManager } from '../undoTreeManager';

function makeUri(path = 'file:///preview.txt') {
    return { toString: () => path } as any;
}

function uriToFileName(uriStr: string): string {
    return decodeURIComponent(new URL(uriStr).pathname);
}

function makeDocument(content: string, uriStr = 'file:///preview.txt') {
    return {
        getText: () => content,
        uri: makeUri(uriStr),
        fileName: uriToFileName(uriStr),
        isUntitled: false,
    } as any;
}

describe('UndoTreeManager compact preview', () => {
    it('returns the same removable count as compact without mutating the source tree', () => {
        const manager = new UndoTreeManager();
        const document = makeDocument('');

        manager.getTree(document.uri, '');
        manager.onDidSaveTextDocument(makeDocument('a'));
        manager.onDidSaveTextDocument(makeDocument('ab'));
        manager.onDidSaveTextDocument(makeDocument('abc'));

        const tree = manager.getTree(document.uri);
        const originalNodeCount = tree.nodes.size;
        const previewRemoved = manager.previewCompact(tree);

        expect(tree.nodes.size).toBe(originalNodeCount);

        const actualRemoved = manager.compact(tree);

        expect(actualRemoved).toBe(previewRemoved);
        expect(tree.nodes.size).toBe(originalNodeCount - actualRemoved);
        manager.dispose();
    });

    it('returns removable and protected nodes for detailed compact preview', () => {
        const manager = new UndoTreeManager();
        const document = makeDocument('');

        manager.getTree(document.uri, '');
        manager.onDidSaveTextDocument(makeDocument('a'));
        manager.onDidSaveTextDocument(makeDocument('ab'));
        manager.onDidSaveTextDocument(makeDocument('abc'));

        const tree = manager.getTree(document.uri);
        const detail = manager.previewCompactDetailed(tree);

        expect(detail.removable.length + detail.protected.length).toBe(tree.nodes.size);
        expect(detail.protected.some((item) => item.reason.length > 0)).toBe(true);
        expect(detail.protected.some((item) => item.reason === 'root node')).toBe(true);
        expect(detail.all.some((item) => item.manualRemoveAllowed)).toBe(true);
        expect(detail.all.every((item) => typeof item.lineCount === 'number')).toBe(true);
        expect(detail.all.every((item) => typeof item.byteCount === 'number')).toBe(true);
        const currentItem = detail.all.find((item) => item.id === tree.currentId);
        expect(currentItem).toBeDefined();
        expect(currentItem?.manualRemoveAllowed).toBe(false);
        expect(currentItem?.manualRemoveReason).toBe('current node cannot be removed');
        manager.dispose();
    });

    it('marks the latest timestamp node as protected in hard compact preview', () => {
        const manager = new UndoTreeManager();
        const document = makeDocument('');

        manager.getTree(document.uri, '');
        manager.onDidSaveTextDocument(makeDocument('base'));
        const tree = manager.getTree(document.uri);
        const baseId = tree.currentId;

        manager.onDidSaveTextDocument(makeDocument('main'));
        const mainId = tree.currentId;

        tree.currentId = baseId;
        manager.onDidSaveTextDocument(makeDocument('branch'));
        const branchId = tree.currentId;

        const now = Date.now();
        tree.nodes.get(mainId)!.timestamp = now - 60 * 86_400_000;
        tree.nodes.get(branchId)!.timestamp = now;
        tree.currentId = mainId;

        const detail = manager.previewHardCompactDetailed(tree, 30);
        const branchItem = detail.protected.find((item) => item.id === branchId);

        expect(branchItem).toBeDefined();
        expect(branchItem?.reason).toBe('latest node');
        manager.dispose();
    });
});
