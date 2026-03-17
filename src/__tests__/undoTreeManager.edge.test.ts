import { UndoTreeManager } from '../undoTreeManager';

jest.mock('vscode');
jest.useFakeTimers();

function makeUri(path = 'file:///test.md') {
    return { toString: () => path } as any;
}
function makeDocument(content: string, uriStr = 'file:///test.md') {
    return { getText: () => content, uri: makeUri(uriStr), isUntitled: false } as any;
}
function makeUntitledDocument(content: string) {
    return { getText: () => content, uri: makeUri('untitled:Untitled-1'), isUntitled: true } as any;
}
function makeChangeEvent(doc: any, changes: Array<{ offset: number; removeLength: number; text: string }>) {
    return {
        document: doc,
        contentChanges: changes.map((c) => ({
            rangeOffset: c.offset,
            rangeLength: c.removeLength,
            text: c.text,
        })),
    } as any;
}

// -----------------------------------------------
// 空・特殊コンテンツ
// -----------------------------------------------
describe('空・特殊コンテンツ', () => {
    it('空ファイルを保存してもクラッシュしない', () => {
        const manager = new UndoTreeManager();
        expect(() => manager.onDidSaveTextDocument(makeDocument(''))).not.toThrow();
    });

    it('空→非空→空の保存でDAG収束する', () => {
        const manager = new UndoTreeManager();
        manager.onDidSaveTextDocument(makeDocument('Hello'));
        manager.onDidSaveTextDocument(makeDocument(''));  // rootと同じ空内容ではない新しいノード
        // rootのhashは''（初期値）なので空文字列はhashMap登録前
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBeGreaterThanOrEqual(2);
    });

    it('日本語コンテンツを正しく保存・復元できる', () => {
        const manager = new UndoTreeManager();
        const base = 'あいうえお'.repeat(50); // 250文字
        const doc1 = makeDocument(base);
        manager.onDidSaveTextDocument(doc1);

        const changed = base + 'かきくけこ';
        const doc2 = makeDocument(changed);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc2, [{ offset: base.length, removeLength: 0, text: 'かきくけこ' }])
        );
        manager.onDidSaveTextDocument(doc2);

        const tree = manager.getTree(makeUri());
        const restored = manager.reconstructContent(tree, tree.currentId);
        expect(restored).toBe(changed);
    });

    it('改行のみのコンテンツを扱える', () => {
        const manager = new UndoTreeManager();
        manager.onDidSaveTextDocument(makeDocument('\n\n\n'));
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(2);
    });

    it('NULLバイトを含むコンテンツを扱える', () => {
        const manager = new UndoTreeManager();
        const content = 'before\x00after';
        expect(() => manager.onDidSaveTextDocument(makeDocument(content))).not.toThrow();
    });
});

// -----------------------------------------------
// 差分バッファの異常系
// -----------------------------------------------
describe('差分バッファの異常系', () => {
    it('changeEventが空配列のときバッファが更新されない', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);

        // 空のchanges
        manager.onDidChangeTextDocument({ document: doc, contentChanges: [] } as any);

        const changed = makeDocument('Hello World');
        manager.onDidSaveTextDocument(changed);

        // バッファなし → full保存になる
        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(2)!;
        expect(node.storage.kind).toBe('full');
    });

    it('複数のchangeEventが1つの保存前に積まれる', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        const doc = makeDocument(base + 'bc');
        // 2つのchangeEventを積む
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc, [{ offset: 1000, removeLength: 0, text: 'b' }])
        );
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc, [{ offset: 1001, removeLength: 0, text: 'c' }])
        );
        manager.onDidSaveTextDocument(doc);

        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(2)!;
        // 2文字追加: 2/1002 ≈ 0.2% < 30% → delta
        expect(node.storage.kind).toBe('delta');
        if (node.storage.kind === 'delta') {
            expect(node.storage.diffs.length).toBe(2);
        }
    });

    it('別ファイルのchangeEventが混入しない', () => {
        const manager = new UndoTreeManager();
        const docA = makeDocument('File A content here long enough', 'file:///a.md');
        const docB = makeDocument('File B', 'file:///b.md');

        manager.onDidSaveTextDocument(docA);
        // Bへの変更をAのchangeEventとして送らない
        manager.onDidChangeTextDocument(
            makeChangeEvent(docB, [{ offset: 6, removeLength: 0, text: ' changed' }])
        );
        manager.onDidSaveTextDocument(makeDocument('File A content here long enough!', 'file:///a.md'));

        const treeA = manager.getTree(makeUri('file:///a.md'));
        const node = treeA.nodes.get(2)!;
        // AのバッファにBのdiffは入っていないのでfull
        expect(node.storage.kind).toBe('full');
    });
});

// -----------------------------------------------
// undo/redo の境界値
// -----------------------------------------------
describe('undo/redo の境界値', () => {
    it('rootノードでundoしてもクラッシュしない', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        vscode.window.activeTextEditor = { document: makeDocument('') };
        expect(() => manager.undo()).not.toThrow();
    });

    it('末端ノードでredoしてもクラッシュしない', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        manager.onDidSaveTextDocument(makeDocument('Hello'));
        vscode.window.activeTextEditor = { document: makeDocument('Hello') };
        expect(() => manager.redo()).not.toThrow();
    });

    it('アクティブエディタなしでundo/redoしてもクラッシュしない', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        vscode.window.activeTextEditor = undefined;
        expect(() => manager.undo()).not.toThrow();
        expect(() => manager.redo()).not.toThrow();
    });

    it('過去ノードへ移動中に保存されても選択ノードから分岐する', async () => {
        const manager = new UndoTreeManager();
        const base = makeDocument('base');
        const next = makeDocument('next');
        manager.onDidSaveTextDocument(base);
        manager.onDidSaveTextDocument(next);

        const tree = manager.getTree(makeUri());
        const editorDocument = {
            uri: makeUri(),
            getText: () => 'branch',
            positionAt: (offset: number) => ({ offset }),
        } as any;
        const editor = {
            document: editorDocument,
            edit: async (callback: (eb: { replace: jest.Mock }) => void) => {
                callback({ replace: jest.fn() });
                manager.onDidChangeTextDocument(
                    makeChangeEvent(editorDocument, [{ offset: 4, removeLength: 0, text: '-branch' }])
                );
                manager.onDidSaveTextDocument(editorDocument);
                return true;
            },
        } as any;

        await manager.jumpToNode(1, editor, tree);

        expect(tree.currentId).toBe(3);
        expect(tree.nodes.get(1)?.children).toContain(3);
        expect(tree.nodes.get(2)?.children).not.toContain(3);
    });
});

// -----------------------------------------------
// reconstructContentの境界値
// -----------------------------------------------
describe('reconstructContentの境界値', () => {
    it('存在しないノードIDを指定してもクラッシュしない', () => {
        const manager = new UndoTreeManager();
        const tree = manager.getTree(makeUri());
        expect(() => manager.reconstructContent(tree, 9999)).not.toThrow();
    });

    it('rootノードの内容を復元できる', () => {
        const manager = new UndoTreeManager();
        const tree = manager.getTree(makeUri());
        const content = manager.reconstructContent(tree, 0);
        expect(content).toBe('');
    });

    it('deltaノードのdiffが空でも復元できる', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        // changeEventを送らずにsave（→full保存）してからdeltaを手動で作る
        const tree = manager.getTree(makeUri());
        const node1 = tree.nodes.get(1)!;
        // 強制的にdeltaに変換（空diffs）
        (node1 as any).storage = { kind: 'delta', diffs: [] };

        // 空diffsからの復元はrootの内容がそのまま返る（rootは最初のsaveで更新されたbase）
        const content = manager.reconstructContent(tree, 1);
        expect(content).toBe(base); // rootの内容（base）にdiff[]を適用 = base
    });
});

// -----------------------------------------------
// 未保存ファイルのオートセーブスキップ
// -----------------------------------------------
describe('未保存ファイル（isUntitled）', () => {
    it('isUntitled=trueのファイルはオートセーブされない', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();
        const doc = makeUntitledDocument('Untitled content');
        vscode.window.activeTextEditor = { document: doc };

        jest.advanceTimersByTime(30_000);

        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(1); // rootのみ
    });
});

// -----------------------------------------------
// dispose後の操作
// -----------------------------------------------
describe('dispose後の操作', () => {
    it('dispose後にonDidSaveTextDocumentを呼んでもクラッシュしない', () => {
        const manager = new UndoTreeManager();
        manager.dispose();
        expect(() => manager.onDidSaveTextDocument(makeDocument('Hello'))).not.toThrow();
    });

    it('dispose後にgetTreeを呼んでも新しいツリーが返る', () => {
        const manager = new UndoTreeManager();
        manager.onDidSaveTextDocument(makeDocument('Before dispose'));
        manager.dispose();
        // dispose後はtreesがクリアされるため初期状態のツリーが返る
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(1);
    });
});

// -----------------------------------------------
// 複数ファイルの独立性
// -----------------------------------------------
describe('複数ファイルの独立性', () => {
    it('異なるURIのツリーは互いに影響しない', () => {
        const manager = new UndoTreeManager();
        const docA = makeDocument('File A', 'file:///a.md');
        const docB = makeDocument('File B', 'file:///b.md');

        manager.onDidSaveTextDocument(docA);
        manager.onDidSaveTextDocument(docA);
        manager.onDidSaveTextDocument(makeDocument('File A v2', 'file:///a.md'));

        manager.onDidSaveTextDocument(docB);

        const treeA = manager.getTree(makeUri('file:///a.md'));
        const treeB = manager.getTree(makeUri('file:///b.md'));

        expect(treeA.nodes.size).toBe(3); // root + A + A v2
        expect(treeB.nodes.size).toBe(2); // root + B
        expect(treeA.currentId).not.toBe(treeB.currentId);
    });

    it('一方のファイルを閉じても他方に影響しない', () => {
        const manager = new UndoTreeManager();
        const docA = makeDocument('File A', 'file:///a.md');
        const docB = makeDocument('File B', 'file:///b.md');

        manager.onDidSaveTextDocument(docA);
        manager.onDidSaveTextDocument(docB);
        manager.onDidCloseTextDocument(docA);

        const treeB = manager.getTree(makeUri('file:///b.md'));
        expect(treeB.nodes.size).toBe(2);
    });
});
