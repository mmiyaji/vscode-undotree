import { UndoTreeManager } from '../undoTreeManager';
import { UndoTreeProvider } from '../undoTreeProvider';

jest.mock('vscode');
jest.useFakeTimers();

function makeUri(path = 'file:///existing.md') {
    return { toString: () => path } as any;
}

function makeDocument(content: string, uriStr = 'file:///existing.md') {
    const fileName = uriStr.replace('file:///', 'C:/');
    return {
        getText: () => content,
        uri: makeUri(uriStr),
        fileName,
        isUntitled: false,
    } as any;
}

describe('UndoTreeProvider initialization', () => {
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

    function makeView() {
        return {
            webview: {
                options: {},
                html: '',
                onDidReceiveMessage: jest.fn(),
                postMessage: jest.fn(),
            },
        } as any;
    }

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

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).toContain('const isDirectBranchChild = !isRoot && parentChildCount > 1;');
        expect(html).toContain("function renderSegment(kind) {");
        expect(html).toContain("case 'pipe':");
        expect(html).toContain("case 'tee':");
        expect(html).toContain("case 'elbow':");
        expect(html).toContain("const graphHtml = prefixParts.map(renderSegment).join('') +");
        expect(html).toContain("isDirectBranchChild ? (isLast ? 'elbow' : 'tee')");
        expect(html).toContain("const childPrefix = (isDirectBranchChild || isBranchParent)");
        expect(html).toContain("[...prefixParts, isLast ? 'blank' : 'pipe']");
        expect(html).toContain('renderNode(cid, childPrefix, i === node.children.length - 1, node.children.length);');
    });

    it('does not build a synthetic main path', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).not.toContain('function findMainPath()');
        expect(html).not.toContain('const mainPath');
    });

    it('renders children directly in stored order', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).toContain('node.children.forEach((cid, i) => {');
        expect(html).not.toContain('mainChild');
        expect(html).not.toContain('branchChildren');
    });

    it('does not indent a linear chain', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).not.toContain('const isLinear');
        expect(html).toContain('renderNode(0, [], false, 0);');
    });

    it('renders the settings gear as a menu trigger', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).toContain(`onclick="send('showMenu')"`);
        expect(html).toContain('title="Open Undo Tree menu"');
        expect(html).toContain('&#9881;</button>');
    });

    it('supports dateTime timestamp formatting', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'dateTime', 'YYYY-MM-DD HH:mm:ss', 'none', 'current', false);

        expect((provider as any).formatTimestamp(
            new Date('2026-03-18T09:41:22').getTime(),
            'dateTime',
            'yyyy-MM-dd HH:mm:ss'
        )).toBe('2026-03-18 09:41:22');
        expect(html).toContain('let timeFormatCustom = "YYYY-MM-DD HH:mm:ss";');
    });

    it('supports custom timestamp formatting', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'custom', 'DD/MM/YYYY HH:mm', 'none', 'current', false);

        expect((provider as any).formatTimestamp(
            new Date('2026-03-18T09:41:22').getTime(),
            'custom',
            'dd/MM/yyyy HH:mm'
        )).toBe('18/03/2026 09:41');
        expect(html).toContain('let timeFormatCustom = "DD/MM/YYYY HH:mm";');
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

    it('embeds nodeSizeMetric in the HTML', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'lines', 'current', false);

        expect(html).toContain('let nodeSizeMetric = "lines";');
        expect(html).toContain('let nodeSizeMetricBase = "current";');
        expect(html).toContain("function formatSizeDiff(node, refNode) {");
        expect(html).toContain("if (nodeSizeMetric === 'none') { return ''; }");
        expect(html).toContain("const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';");
    });

    it('formats size units with a space before the unit', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'bytes', 'current', false);

        expect(html).toContain("return n.toLocaleString() + ' L';");
        expect(html).toContain("return (b / (1024 * 1024)).toFixed(1) + ' MB';");
        expect(html).toContain("return (b / 1024).toFixed(1) + ' KB';");
        expect(html).toContain("return b + ' B';");
        expect(html).toContain("const str = delta !== 0 ? fmtBytes(Math.abs(delta)) : '0 B';");
    });

    it('hides size diff when nodeSizeMetric is none', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).toContain('let nodeSizeMetric = "none";');
        expect(html).toContain("if (nodeSizeMetric === 'none') { return ''; }");
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

    it('shows the not-tracked screen for files outside enabledExtensions', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const view = makeView();
        const document = {
            ...makeDocument('const x = 1;', 'file:///example.js'),
            fileName: 'C:\\Users\\mail\\Documents\\git\\vscode-undotree\\example.js',
        };

        vscode.window.activeTextEditor = { document };

        provider.resolveWebviewView(view);

        expect(view.webview.html).toContain('is not tracked');
        expect(view.webview.html).toContain('Open Settings');
        expect(view.webview.html).toContain('enableTrackingWithExt');
        expect(view.webview.html).toContain('".js"');
    });

    it('shows a text-editor-only message when there is no active text editor', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const view = makeView();

        vscode.window.activeTextEditor = undefined;

        provider.resolveWebviewView(view);

        expect(view.webview.html).toContain('Undo Tree is only available for text editors.');
    });

    it('shows loading only for the file currently being loaded', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const loadingDocument = makeDocument('loading file', 'file:///loading.md');
        const otherDocument = makeDocument('other file', 'file:///other.md');
        const view = makeView();

        provider.resolveWebviewView(view);
        provider.beginLoading(loadingDocument.uri);

        vscode.window.activeTextEditor = { document: otherDocument };
        provider.refresh();

        expect(view.webview.html).not.toContain('</head><body>Loading...</body></html>');
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'renderState',
            state: expect.objectContaining({
                view: 'tree',
                nodes: expect.arrayContaining([
                    expect.objectContaining({ label: 'initial' }),
                ]),
            }),
        }));
    });

    it('keeps the latest loading request when an older one finishes', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const firstDocument = makeDocument('first file', 'file:///first.md');
        const secondDocument = makeDocument('second file', 'file:///second.md');
        const view = makeView();

        provider.resolveWebviewView(view);
        const firstToken = provider.beginLoading(firstDocument.uri);
        const secondToken = provider.beginLoading(secondDocument.uri);

        expect(provider.endLoading(firstDocument.uri, firstToken)).toBe(false);

        vscode.window.activeTextEditor = { document: secondDocument };
        provider.refresh();

        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'renderState',
            state: expect.objectContaining({ view: 'loading' }),
        }));
        expect(provider.endLoading(secondDocument.uri, secondToken)).toBe(true);
    });

    it('keeps the initial shell HTML and pushes later renders via postMessage', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const view = makeView();
        const document = makeDocument('initial content');

        vscode.window.activeTextEditor = { document };

        provider.resolveWebviewView(view);
        const firstHtml = view.webview.html;

        provider.refresh();

        expect(view.webview.html).toBe(firstHtml);
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'renderState',
        }));
    });

    it('renders the note edit button with a stable HTML entity icon', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml([], 0, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'none', 'current', false);

        expect(html).toContain('class="note-edit"');
        expect(html).toContain('&#9998;</span>');
        expect(html).not.toContain('笨・/span>');
    });
});
