import { UndoTreeManager } from '../undoTreeManager';
import { UndoTreeProvider } from '../undoTreeProvider';

jest.mock('vscode');
jest.useFakeTimers();

describe('UndoTreeProvider diff mode', () => {
    function makeEditor(path: string) {
        return {
            document: {
                uri: {
                    scheme: path.split(':', 1)[0],
                    toString: () => path,
                },
            },
        } as any;
    }

    it('auto-previews diff when focus changes in diff mode', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        const html = (provider as any).buildHtml(
            [],
            0,
            false,
            'diff',
            'time',
            'yyyy-MM-dd HH:mm:ss',
            'none',
            'current',
            false
        );

        expect(html).toContain('function previewDiffForFocused() {');
        expect(html).toContain("if (mode !== 'diff' || focusedIndex < 0 || !sourceUri) { return; }");
        expect(html).toContain("send('diffWithNode', { nodeId, sourceUri });");
        expect(html).toContain("send('diffBetweenNodes', { leftNodeId: diffBaseNodeId, rightNodeId: nodeId, sourceUri });");
        expect(html).toContain('previewDiffForFocused();');
        expect(html).toContain("el.classList.toggle('diff-base', mode === 'diff' && diffCompareMode === 'pair' && nodeId === diffBaseNodeId);");
        expect(html).toContain("el.classList.toggle(");
        expect(html).toContain("'<span class=\"diff-target-badge\">' + escHtml(i18n.badgeDiff) + '</span>'");
        expect(html).toContain('Diff mode - select a node to compare');
        expect(html).toContain('setFocused(nodeIds.indexOf(currentId));');
        expect(html).toContain("if (e.key === 'Escape' && mode === 'diff') {");
        expect(html).toContain("e.preventDefault(); send('toggleMode');");
        expect(html).toContain('Pair Diff');
        expect(html).not.toContain('id="btn-diff-set-base"');
        expect(html).not.toContain("diffBaseNodeId = nodeIds[focusedIndex] ?? null;");
        expect(html).toContain('Undo Tree shortcuts');
        expect(html).toContain('id="help-close"');
        expect(html).toContain('Close help');
        expect(html).toContain('id="context-menu"');
        expect(html).toContain("div.addEventListener('contextmenu', (event) => {");
        expect(html).toContain("row.addEventListener('contextmenu', (event) => {");
        expect(html).toContain("data-action=\"set-base\"");
        expect(html).toContain('Compare with Current');
        expect(html).toContain('Set Pair Diff Base');
        expect(html).toContain("if (e.key === '?') {");
        expect(html).toContain("} else if (e.key === 'Escape' && contextMenuNodeId !== null) {");
        expect(html).toContain("} else if (e.key === 'b') {");
        expect(html).toContain("} else if (e.key === 'c') {");
        expect(html).toContain('diff-base-badge');
        expect(html).toContain("send('undo', { sourceUri })");
        expect(html).toContain("send('redo', { sourceUri })");
    });

    it('cancels diff mode when switching to another file', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        provider.setActiveEditor(makeEditor('file:///one.md'));
        (provider as any).mode = 'diff';

        provider.setActiveEditor(makeEditor('file:///two.md'));

        expect((provider as any).mode).toBe('navigate');
    });

    it('routes sidebar undo and redo to the remembered source editor while an Undo Tree diff is active', async () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);
        const sourceEditor = makeEditor('file:///one.md');
        sourceEditor.document.fileName = '/workspace/one.md';
        sourceEditor.document.isUntitled = false;
        sourceEditor.document.getText = () => 'one';
        const diffEditor = makeEditor('undotree:node/1');
        let receiveMessage: ((message: any) => Promise<void>) | undefined;
        const view = {
            visible: true,
            onDidChangeVisibility: jest.fn(),
            webview: {
                options: {},
                html: '',
                postMessage: jest.fn(),
                onDidReceiveMessage: jest.fn((callback) => { receiveMessage = callback; }),
            },
        } as any;
        const undo = jest.spyOn(manager, 'undo').mockResolvedValue(undefined);
        const redo = jest.spyOn(manager, 'redo').mockResolvedValue(undefined);

        provider.setActiveEditor(sourceEditor);
        vscode.workspace.textDocuments = [sourceEditor.document, diffEditor.document];
        vscode.window.activeTextEditor = diffEditor;
        vscode.window.visibleTextEditors = [diffEditor];
        provider.resolveWebviewView(view);

        await receiveMessage?.({ command: 'undo', sourceUri: 'file:///one.md' });
        await receiveMessage?.({ command: 'redo', sourceUri: 'file:///one.md' });

        expect(undo).toHaveBeenCalledWith(sourceEditor.document);
        expect(redo).toHaveBeenCalledWith(sourceEditor.document);
    });
});
