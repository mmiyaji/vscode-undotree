import { UndoTreeManager } from '../undoTreeManager';
import { UndoTreeProvider } from '../undoTreeProvider';

jest.mock('vscode');
jest.useFakeTimers();

function makeUri(path = 'file:///pin.md') {
    return { toString: () => path } as any;
}

function uriToFileName(uriStr: string): string {
    return decodeURIComponent(new URL(uriStr).pathname);
}

function makeDocument(content: string, uriStr = 'file:///pin.md') {
    return {
        getText: () => content,
        uri: makeUri(uriStr),
        fileName: uriToFileName(uriStr),
        isUntitled: false,
    } as any;
}

describe('UndoTree pinning', () => {
    beforeEach(() => {
        const vscode = require('vscode');
        vscode.workspace.getConfiguration = jest.fn((section?: string) => {
            if (section === 'undotree') {
                return {
                    get: jest.fn((key: string) => {
                        switch (key) {
                            case 'enabledExtensions':
                                return ['.txt', '.md'];
                            case 'excludePatterns':
                                return [];
                            default:
                                return undefined;
                        }
                    }),
                };
            }
            return { get: jest.fn() };
        });
    });

    it('keeps a pinned node out of compact removal', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri('file:///compact-pin.md');

        manager.onDidSaveTextDocument(makeDocument('aaa', 'file:///compact-pin.md'));
        manager.onDidSaveTextDocument(makeDocument('aaab', 'file:///compact-pin.md'));
        manager.onDidSaveTextDocument(makeDocument('aaabb', 'file:///compact-pin.md'));

        const tree = manager.getTree(uri);
        const pinnedNodeId = 2;
        manager.setPinned(uri, pinnedNodeId, true);

        const removed = manager.compact(tree);

        expect(removed).toBe(0);
        expect(tree.nodes.has(pinnedNodeId)).toBe(true);
        expect(tree.nodes.get(pinnedNodeId)?.pinned).toBe(true);
    });

    it('protects pinned ancestors during hard compact', () => {
        const manager = new UndoTreeManager();
        const now = Date.now();
        const uri = makeUri('file:///hard-pin.md');

        manager.onDidSaveTextDocument(makeDocument('base', 'file:///hard-pin.md'));
        const tree = manager.getTree(uri);
        const baseId = tree.currentId;

        manager.onDidSaveTextDocument(makeDocument('main', 'file:///hard-pin.md'));
        const mainId = tree.currentId;

        tree.currentId = baseId;
        manager.onDidSaveTextDocument(makeDocument('branch_parent', 'file:///hard-pin.md'));
        const parentId = tree.currentId;
        tree.nodes.get(parentId)!.timestamp = now - 60 * 86_400_000;

        manager.onDidSaveTextDocument(makeDocument('pinned_leaf', 'file:///hard-pin.md'));
        const pinnedId = tree.currentId;
        tree.nodes.get(pinnedId)!.timestamp = now - 50 * 86_400_000;
        manager.setPinned(uri, pinnedId, true);

        tree.currentId = mainId;
        const removed = manager.hardCompact(tree, 30);

        expect(removed).toBe(0);
        expect(tree.nodes.has(parentId)).toBe(true);
        expect(tree.nodes.has(pinnedId)).toBe(true);
    });

    it('renders pin controls and pinned shortcuts in the sidebar html', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml(
            [],
            0,
            false,
            'navigate',
            'time',
            'yyyy-MM-dd HH:mm:ss',
            'none',
            'current',
            false
        );

        expect(html).toContain('const pinnedNodes = nodes.filter((node) => node.id !== 0 && node.pinned);');
        expect(html).toContain('.pin-btn {');
        expect(html).toContain("class=\"pinned-title\"");
        expect(html).toContain('&#128204;');
    });
});
