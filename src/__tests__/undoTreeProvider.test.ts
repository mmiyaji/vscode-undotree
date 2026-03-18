import { UndoTreeManager } from '../undoTreeManager';
import { UndoTreeProvider } from '../undoTreeProvider';

jest.mock('vscode');
jest.useFakeTimers();

function makeUri(path = 'file:///existing.md') {
    return { toString: () => path } as any;
}

function makeDocument(content: string, uriStr = 'file:///existing.md') {
    return {
        getText: () => content,
        uri: makeUri(uriStr),
        isUntitled: false,
    } as any;
}

describe('UndoTreeProvider initialization', () => {
    it('seeds the root node with the active editor content during render', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const document = makeDocument('existing file content');

        vscode.window.activeTextEditor = { document };

        const view = {
            webview: {
                options: {},
                html: '',
                onDidReceiveMessage: jest.fn(),
            },
        } as any;

        provider.resolveWebviewView(view);

        const tree = manager.getTree(document.uri);
        expect(manager.reconstructContent(tree, tree.rootId)).toBe('existing file content');
    });

    it('marks only direct branch children with a connector', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'YYYY-MM-DD HH:mm:ss', 'semantic');

        expect(html).toContain('const isDirectBranchChild = !isRoot && parentChildCount > 1;');
        expect(html).toContain("function renderSegment(kind) {");
        expect(html).toContain("case 'pipe':");
        expect(html).toContain("case 'tee':");
        expect(html).toContain("case 'elbow':");
        expect(html).toContain("const graphHtml = prefixParts.map(renderSegment).join('') +");
        expect(html).toContain("renderSegment(isLast ? 'elbow' : 'tee')");
        expect(html).toContain("const childPrefix = isDirectBranchChild");
        expect(html).toContain("[...prefixParts, isLast ? 'blank' : 'pipe']");
        expect(html).toContain('renderNode(cid, childPrefix, i === node.children.length - 1, node.children.length);');
    });

    it('does not build a synthetic main path', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'YYYY-MM-DD HH:mm:ss', 'semantic');

        expect(html).not.toContain('function findMainPath()');
        expect(html).not.toContain('const mainPath');
    });

    it('renders children directly in stored order', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'YYYY-MM-DD HH:mm:ss', 'semantic');

        expect(html).toContain('node.children.forEach((cid, i) => {');
        expect(html).not.toContain('mainChild');
        expect(html).not.toContain('branchChildren');
    });

    it('does not indent a linear chain', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'YYYY-MM-DD HH:mm:ss', 'semantic');

        expect(html).not.toContain('const isLinear');
        expect(html).toContain('renderNode(0, [], false, 0);');
    });

    it('renders the settings gear as a menu trigger', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'YYYY-MM-DD HH:mm:ss', 'semantic');

        expect(html).toContain(`onclick="send('showMenu')"`);
        expect(html).toContain('title="Open Undo Tree menu"');
        expect(html).toContain('&#9881;</button>');
    });

    it('supports dateTime timestamp formatting', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'dateTime', 'YYYY-MM-DD HH:mm:ss', 'semantic');

        expect((provider as any).formatTimestamp(
            new Date('2026-03-18T09:41:22').getTime(),
            'dateTime',
            'yyyy-MM-dd HH:mm:ss'
        )).toBe('2026-03-18 09:41:22');
        expect(html).toContain('const timeFormatCustom = "YYYY-MM-DD HH:mm:ss";');
    });

    it('supports custom timestamp formatting', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'custom', 'DD/MM/YYYY HH:mm', 'semantic');

        expect((provider as any).formatTimestamp(
            new Date('2026-03-18T09:41:22').getTime(),
            'custom',
            'dd/MM/yyyy HH:mm'
        )).toBe('18/03/2026 09:41');
        expect(html).toContain('const timeFormatCustom = "DD/MM/YYYY HH:mm";');
    });

    it('falls back to the default dateTime pattern for invalid custom formats', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        expect((provider as any).formatTimestamp(
            new Date('2026-03-18T09:41:22').getTime(),
            'custom',
            'invalid ['
        )).toBe('2026-03-18 09:41:22');
    });

    it('supports semantic node markers', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'semantic');

        expect(html).toContain('const nodeMarkerStyle = "semantic";');
        expect(html).toContain('const latestLeafId = nodes');
        expect(html).toContain("function renderMarker(kind) {");
        expect(html).toContain("case 'root':");
        expect(html).toContain("case 'branch':");
        expect(html).toContain("case 'latest':");
        expect(html).toContain("case 'current':");
        expect(html).toContain("nodeMarkerStyle === 'semantic'");
    });

    it('supports hiding node markers', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none');

        expect(html).toContain('const nodeMarkerStyle = "none";');
        expect(html).toContain("case 'none':");
        expect(html).toContain("nodeMarkerStyle === 'none'");
        expect(html).toContain("const markerHtml = markerKind === 'none'");
    });

    it('creates a restore node when the loaded file content differs', () => {
        const manager = new UndoTreeManager();
        manager.onDidSaveTextDocument(makeDocument('old text'));
        const state = manager.exportState();

        const restored = new UndoTreeManager();
        restored.importState(state);
        const tree = restored.syncDocumentState(makeUri(), 'new text');

        expect(tree.currentId).toBe(2);
        expect(tree.nodes.get(2)?.label).toBe('restore');
        expect(restored.reconstructContent(tree, tree.currentId)).toBe('new text');
    });
});
