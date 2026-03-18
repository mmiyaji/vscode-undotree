import { UndoTreeManager } from '../undoTreeManager';
import { UndoTreeProvider } from '../undoTreeProvider';

jest.mock('vscode');

describe('UndoTreeProvider diff mode', () => {
    function makeEditor(path: string) {
        return {
            document: {
                uri: { toString: () => path },
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
        expect(html).toContain("if (mode !== 'diff' || focusedIndex < 0) { return; }");
        expect(html).toContain("send('diffWithNode', { nodeId });");
        expect(html).toContain('previewDiffForFocused();');
        expect(html).toContain("el.classList.toggle('diff-target', mode === 'diff' && isFocused && nodeId !== currentId);");
        expect(html).toContain('<span class="diff-target-badge">Diff</span>');
        expect(html).toContain('Diff mode - select a node to compare');
        expect(html).toContain('setFocused(nodeIds.indexOf(currentId));');
        expect(html).toContain("if (e.key === 'Escape' && mode === 'diff') {");
        expect(html).toContain("e.preventDefault(); send('toggleMode');");
    });

    it('cancels diff mode when switching to another file', () => {
        const manager = new UndoTreeManager();
        const provider = new UndoTreeProvider({} as any, manager);

        provider.setActiveEditor(makeEditor('file:///one.md'));
        (provider as any).mode = 'diff';

        provider.setActiveEditor(makeEditor('file:///two.md'));

        expect((provider as any).mode).toBe('navigate');
    });
});
