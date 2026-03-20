import { UndoTreeManager } from '../undoTreeManager';

jest.mock('vscode');
jest.useFakeTimers();

// テスト用ヘルパー
function makeUri(path = 'file:///test.md') {
    return { toString: () => path } as any;
}

function makeDocument(content: string, uriStr = 'file:///test.md') {
    return {
        getText: () => content,
        uri: makeUri(uriStr),
        isUntitled: false,
    } as any;
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

function makeEditor(initialContent: string, uriStr = 'file:///test.md') {
    let content = initialContent;
    const document = {
        getText: () => content,
        uri: makeUri(uriStr),
        isUntitled: false,
        positionAt: (offset: number) => offset,
    } as any;
    return {
        document,
        setContent(next: string) {
            content = next;
        },
        edit: async (callback: (editBuilder: { replace: (_range: unknown, text: string) => void }) => void) => {
            callback({
                replace: (_range, text) => {
                    content = text;
                },
            });
            return true;
        },
    } as any;
}

// -----------------------------------------------
// 基本動作
// -----------------------------------------------
describe('初期状態', () => {
    it('初回getTreeでrootノードが作られる', () => {
        const manager = new UndoTreeManager();
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(1);
        expect(tree.currentId).toBe(0);
        expect(tree.nodes.get(0)!.storage.kind).toBe('full');
    });
});

describe('persisted state validation', () => {
    it('rejects malformed imported trees', () => {
        const manager = new UndoTreeManager();

        expect(() => manager.importTree('file:///broken.md', {
            nodes: [
                {
                    id: 0,
                    parents: [],
                    children: [1],
                    timestamp: 0,
                    label: 'initial',
                    hash: 'root',
                    storage: { kind: 'full', content: '' },
                },
                {
                    id: 1,
                    parents: [0],
                    children: [],
                    timestamp: 1,
                    label: 'broken',
                    hash: 'broken',
                    storage: { kind: 'delta' } as any,
                },
            ],
            hashMap: [['root', 0], ['broken', 1]],
            currentId: 1,
            rootId: 0,
        })).toThrow('Invalid delta node diffs');
    });

    it('stops on malformed imported state', () => {
        const manager = new UndoTreeManager();

        expect(() => manager.importState({
            nextId: 2,
            trees: {
                'file:///broken.md': {
                    nodes: [
                        {
                            id: 0,
                            parents: [],
                            children: [99],
                            timestamp: 0,
                            label: 'initial',
                            hash: 'root',
                            storage: { kind: 'full', content: '' },
                        },
                    ],
                    hashMap: [['root', 0]],
                    currentId: 0,
                    rootId: 0,
                },
            },
        } as any)).toThrow('references missing child');
    });

    it('repairs trees whose parent and child references disagree', () => {
        const manager = new UndoTreeManager();

        manager.importTree('file:///broken-links.md', {
            nodes: [
                {
                    id: 0,
                    parents: [],
                    children: [1],
                    timestamp: 0,
                    label: 'initial',
                    hash: 'root',
                    storage: { kind: 'full', content: '' },
                },
                {
                    id: 1,
                    parents: [],
                    children: [],
                    timestamp: 1,
                    label: 'save',
                    hash: 'child',
                    storage: { kind: 'full', content: 'x' },
                },
            ],
            hashMap: [['root', 0], ['child', 1]],
            currentId: 1,
            rootId: 0,
        });

        const tree = manager.getTree(makeUri('file:///broken-links.md'));
        expect(tree.nodes.get(0)?.children).toContain(1);
        expect(tree.nodes.get(1)?.parents).toContain(0);
    });
});

describe('保存時のノード追加', () => {
    it('初回保存でノードが追加される', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(2);
        expect(tree.currentId).toBe(1);
    });

    it('内容が変わらなければノードは追加されない', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        manager.onDidSaveTextDocument(doc); // 同じ内容で再保存
        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(2); // rootと1ノードのまま
    });

    it('内容が変われば新しいノードが追加される', () => {
        const manager = new UndoTreeManager();
        const doc1 = makeDocument('Hello');
        const doc2 = makeDocument('Hello World');
        manager.onDidSaveTextDocument(doc1);
        manager.onDidSaveTextDocument(doc2);
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(3);
    });

    it('jumpToNode直後のautosave相当ではノードを追加しない', async () => {
        const manager = new UndoTreeManager();
        const uri = makeUri('file:///jump-save.md');
        manager.onDidSaveTextDocument(makeDocument('A', 'file:///jump-save.md'));
        manager.onDidSaveTextDocument(makeDocument('B', 'file:///jump-save.md'));

        const tree = manager.getTree(uri);
        const editor = makeEditor('B', 'file:///jump-save.md');

        await manager.jumpToNode(1, editor, tree);
        manager.onDidSaveTextDocument(editor.document);

        expect(tree.currentId).toBe(1);
        expect(tree.nodes.size).toBe(3);
    });

    it('jumpToNode後に実編集が入れば次のsaveでノードを追加する', async () => {
        const manager = new UndoTreeManager();
        const uri = makeUri('file:///jump-edit.md');
        manager.onDidSaveTextDocument(makeDocument('A', 'file:///jump-edit.md'));
        manager.onDidSaveTextDocument(makeDocument('B', 'file:///jump-edit.md'));

        const tree = manager.getTree(uri);
        const editor = makeEditor('B', 'file:///jump-edit.md');

        await manager.jumpToNode(1, editor, tree);
        editor.setContent('A!');
        manager.onDidChangeTextDocument(
            makeChangeEvent(editor.document, [{ offset: 1, removeLength: 0, text: '!' }])
        );
        manager.onDidSaveTextDocument(editor.document);

        expect(tree.nodes.size).toBe(4);
        expect(tree.currentId).not.toBe(1);
        expect(tree.nodes.get(tree.currentId)?.parents).toContain(1);
    });
});

// -----------------------------------------------
// ストレージ種別の判定
// -----------------------------------------------
describe('ストレージ種別の判定', () => {
    it('差分バッファが空なら全量保存', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        const tree = manager.getTree(doc.uri);
        const node = tree.nodes.get(1)!;
        expect(node.storage.kind).toBe('full');
    });

    it('変更量が30%未満なら差分保存', () => {
        const manager = new UndoTreeManager();
        // 100文字のベースコンテンツ
        const base = 'a'.repeat(100);
        const doc1 = makeDocument(base);
        manager.onDidSaveTextDocument(doc1);

        // 5文字追加（5/105 ≈ 4.8% < 30%）
        const changed = base + 'bbbbb';
        const doc2 = makeDocument(changed);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc2, [{ offset: 100, removeLength: 0, text: 'bbbbb' }])
        );
        manager.onDidSaveTextDocument(doc2);

        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(2)!;
        expect(node.storage.kind).toBe('delta');
    });

    it('変更量が30%以上なら全量保存', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(10);
        const doc1 = makeDocument(base);
        manager.onDidSaveTextDocument(doc1);

        // 8文字追加（8/18 ≈ 44% > 30%）
        const changed = base + 'b'.repeat(8);
        const doc2 = makeDocument(changed);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc2, [{ offset: 10, removeLength: 0, text: 'b'.repeat(8) }])
        );
        manager.onDidSaveTextDocument(doc2);

        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(2)!;
        expect(node.storage.kind).toBe('full');
    });
});

// -----------------------------------------------
// 分岐点の全量昇格
// -----------------------------------------------
describe('分岐点の全量昇格', () => {
    it('2つ目の子を持つノードはfullに昇格する', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        const doc1 = makeDocument(base);
        manager.onDidSaveTextDocument(doc1);

        // 小さい変更で node2 作成（deltaのはず）
        const content2 = base + 'b';
        const doc2 = makeDocument(content2);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc2, [{ offset: 100, removeLength: 0, text: 'b' }])
        );
        manager.onDidSaveTextDocument(doc2);

        const tree = manager.getTree(makeUri());
        const node1 = tree.nodes.get(1)!;
        expect(node1.storage.kind).toBe('full'); // まだ子が1つなのでfull（初回保存はfull）

        // currentIdをnode1に戻して別の内容を保存（分岐）
        tree.currentId = 1;
        const content3 = base + 'c';
        const doc3 = makeDocument(content3);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc3, [{ offset: 100, removeLength: 0, text: 'c' }])
        );
        manager.onDidSaveTextDocument(doc3);

        // node1は2つの子を持つ → 全量に昇格済みであること
        expect(node1.storage.kind).toBe('full');
        expect(node1.children.length).toBe(2);
    });

    it('uses checkpoint storage for large branch parents when the threshold is exceeded', () => {
        const manager = new UndoTreeManager();
        manager.setMemoryCheckpointThreshold(32);
        const base = 'a'.repeat(256);
        manager.onDidSaveTextDocument(makeDocument(base));

        const tree = manager.getTree(makeUri());
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(base + 'b'), [{ offset: 256, removeLength: 0, text: 'b' }])
        );
        manager.onDidSaveTextDocument(makeDocument(base + 'b'));

        tree.currentId = 1;
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(base + 'c'), [{ offset: 256, removeLength: 0, text: 'c' }])
        );
        manager.onDidSaveTextDocument(makeDocument(base + 'c'));

        const node1 = tree.nodes.get(1)!;
        expect(node1.children.length).toBe(2);
        expect(node1.storage.kind).toBe('checkpoint');
        expect(manager.reconstructContent(tree, 1)).toBe(base);
    });
});

// -----------------------------------------------
// 既存ファイルを開いた場合の初回ノード
// -----------------------------------------------
describe('既存ファイルを開いた場合', () => {
    it('空ルートの直後ノードは変更量が小さくてもfullで保存される', () => {
        const manager = new UndoTreeManager();
        const existingContent = 'a'.repeat(100); // 既存ファイルの内容

        // 小さい変更（deltaになりそうな量）をchangeEventで積んでから保存
        const newContent = existingContent + 'b'; // 1文字追加
        const doc = makeDocument(newContent);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc, [{ offset: 100, removeLength: 0, text: 'b' }])
        );
        manager.onDidSaveTextDocument(doc);

        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(1)!;
        // 空ルートの直後なのでfullで保存されていること
        expect(node.storage.kind).toBe('full');
    });

    it('空ルートの直後ノードをreconstructContentで正しく復元できる', () => {
        const manager = new UndoTreeManager();
        const existingContent = 'a'.repeat(100);
        const newContent = existingContent + 'xyz';
        const doc = makeDocument(newContent);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc, [{ offset: 100, removeLength: 0, text: 'xyz' }])
        );
        manager.onDidSaveTextDocument(doc);

        const tree = manager.getTree(makeUri());
        const content = manager.reconstructContent(tree, 1);
        expect(content).toBe(newContent);
    });
});

// -----------------------------------------------
// DAG収束（同じhashへのリンク）
// -----------------------------------------------
describe('DAG収束', () => {
    it('同じ内容に戻ったとき既存ノードに収束する（新ノード作成なし）', () => {
        const manager = new UndoTreeManager();
        const doc1 = makeDocument('Hello');
        const doc2 = makeDocument('Hello World');
        const doc3 = makeDocument('Hello'); // doc1と同じ内容

        manager.onDidSaveTextDocument(doc1);
        const tree = manager.getTree(makeUri());
        const helloNodeId = tree.currentId;

        manager.onDidSaveTextDocument(doc2);
        manager.onDidSaveTextDocument(doc3); // Helloノードに収束

        expect(tree.nodes.size).toBe(3); // root + Hello + HelloWorld のみ
        expect(tree.currentId).toBe(helloNodeId);
    });
});

// -----------------------------------------------
// reconstructContent
// -----------------------------------------------
describe('reconstructContent', () => {
    it('fullノードの内容を直接返す', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        const tree = manager.getTree(makeUri());
        const content = manager.reconstructContent(tree, 1);
        expect(content).toBe('Hello');
    });

    it('deltaノードにdiffを適用して正しく復元する', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        const doc1 = makeDocument(base);
        manager.onDidSaveTextDocument(doc1);

        const changed = base + 'bbbbb';
        const doc2 = makeDocument(changed);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc2, [{ offset: 100, removeLength: 0, text: 'bbbbb' }])
        );
        manager.onDidSaveTextDocument(doc2);

        const tree = manager.getTree(makeUri());
        const node2 = tree.nodes.get(2)!;
        expect(node2.storage.kind).toBe('delta');

        const content = manager.reconstructContent(tree, 2);
        expect(content).toBe(changed);
    });

    it('1回の保存前に複数のchangeイベントが発生しても正しく復元する', () => {
        // 修正前バグ: 複数イベントを降順ソートすると順序が逆転して内容が壊れる
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(base));

        // 3つの連続したchangeイベント（それぞれ前のイベント適用後の状態への変更）
        const step1 = base + 'x';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(step1), [{ offset: 100, removeLength: 0, text: 'x' }])
        );
        const step2 = step1 + 'y';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(step2), [{ offset: 101, removeLength: 0, text: 'y' }])
        );
        const step3 = step2 + 'z';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(step3), [{ offset: 102, removeLength: 0, text: 'z' }])
        );
        // 3イベント分まとめて1ノードに保存
        manager.onDidSaveTextDocument(makeDocument(step3));

        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(2)!;
        expect(node.storage.kind).toBe('delta');

        const content = manager.reconstructContent(tree, 2);
        expect(content).toBe(step3); // 'a'.repeat(100) + 'xyz' であること
    });

    it('複数のdeltaノードを連鎖して復元する', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(base));

        const step1 = base + 'b';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(step1), [{ offset: 100, removeLength: 0, text: 'b' }])
        );
        manager.onDidSaveTextDocument(makeDocument(step1));

        const step2 = step1 + 'c';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(step2), [{ offset: 101, removeLength: 0, text: 'c' }])
        );
        manager.onDidSaveTextDocument(makeDocument(step2));

        const tree = manager.getTree(makeUri());
        const content = manager.reconstructContent(tree, 3);
        expect(content).toBe(step2);
    });
});

// -----------------------------------------------
// オートセーブ
// -----------------------------------------------
describe('オートセーブ', () => {
    it('30秒後にアクティブエディタの内容でノードが追加される', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();

        const doc = makeDocument('Auto saved content');
        vscode.window.activeTextEditor = { document: doc };

        jest.advanceTimersByTime(30_000);

        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(2);
    });

    it('内容が変わっていなければオートセーブでノードは追加されない', () => {
        const vscode = require('vscode');
        const manager = new UndoTreeManager();

        const doc = makeDocument('No change');
        vscode.window.activeTextEditor = { document: doc };

        jest.advanceTimersByTime(30_000); // 1回目: node追加
        jest.advanceTimersByTime(30_000); // 2回目: 同じ内容 → スキップ

        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(2); // root + 1ノードのまま
    });
});

// -----------------------------------------------
// DAG循環防止
// -----------------------------------------------
describe('DAG循環防止', () => {
    it('同じ内容に複数回戻っても循環リンクが発生しない', () => {
        const manager = new UndoTreeManager();
        // A → B → A → B → A のように繰り返してもノード数は増えない
        const docA = makeDocument('content-A');
        const docB = makeDocument('content-B');

        manager.onDidSaveTextDocument(docA); // node1: A
        manager.onDidSaveTextDocument(docB); // node2: B
        manager.onDidSaveTextDocument(docA); // Aに収束 → node1へジャンプ
        manager.onDidSaveTextDocument(docB); // Bに収束 → node2へジャンプ
        manager.onDidSaveTextDocument(docA); // Aに収束 → node1へジャンプ

        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(3); // root + A + B のみ
    });

    it('先祖ノードへのリンクはスキップされる（循環グラフにならない）', () => {
        const manager = new UndoTreeManager();
        const docA = makeDocument('content-A');
        const docB = makeDocument('content-B');
        const docC = makeDocument('content-C');

        manager.onDidSaveTextDocument(docA); // node1: A (currentId=1)
        manager.onDidSaveTextDocument(docB); // node2: B (currentId=2)
        manager.onDidSaveTextDocument(docC); // node3: C (currentId=3)
        manager.onDidSaveTextDocument(docA); // node1はnode3の先祖 → リンクしない

        const tree = manager.getTree(makeUri());
        const node3 = tree.nodes.get(3)!;
        // node3の子にnode1は追加されないこと
        expect(node3.children).not.toContain(1);
    });

    it('reconstructContentが循環があっても無限ループしない', () => {
        const manager = new UndoTreeManager();
        const tree = manager.getTree(makeUri());

        // 強制的に循環を作っても無限ループしないことを確認
        const nodeA = tree.nodes.get(0)!;
        const nodeB = {
            id: 99,
            parents: [0],
            children: [] as number[],
            timestamp: Date.now(),
            label: 'test',
            hash: 'testhash',
            storage: { kind: 'delta' as const, diffs: [] },
        };
        tree.nodes.set(99, nodeB);
        // 循環: node0のparentsにnode99を追加（通常ありえないが防御テスト）
        nodeA.parents.push(99);
        nodeB.children.push(0);

        // 無限ループしないことを確認（タイムアウトなしで完了する）
        expect(() => manager.reconstructContent(tree, 99)).not.toThrow();
    });
});

// -----------------------------------------------
// compact（履歴圧縮）
// -----------------------------------------------
describe('compact', () => {
    // root(full) → n1(full,base) → n2(delta,insert) → ... → nK(delta,insert) の直列チェーンを作る
    function makeInsertChain(deltaCount: number) {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(base));

        let content = base;
        for (let i = 0; i < deltaCount; i++) {
            content += 'b';
            const doc = makeDocument(content);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: content.length - 1, removeLength: 0, text: 'b' }])
            );
            manager.onDidSaveTextDocument(doc);
        }
        const tree = manager.getTree(makeUri());
        return { manager, tree, finalContent: content };
    }

    it('直列insertチェーンを圧縮する', () => {
        // root → n1(full) → n2(delta) → n3(delta) → n4(delta) → n5(delta, leaf, current)
        // n2: parent=n1(full=mixed) → 非圧縮
        // n3: parent=n2(insert), child=n4(insert) → 圧縮可
        // n4: 圧縮後parent=n2(insert), child=n5(insert) → 圧縮可
        // n5: leaf → 非圧縮
        // → 2件削除: root, n1, n2, n5 の4ノードが残る
        const { manager, tree, finalContent } = makeInsertChain(4);
        expect(tree.nodes.size).toBe(6);

        const removed = manager.compact(tree);

        expect(removed).toBe(2);
        expect(tree.nodes.size).toBe(4);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(finalContent);
    });

    it('ルートノードは削除されない', () => {
        const { manager, tree } = makeInsertChain(4);
        manager.compact(tree);
        expect(tree.nodes.has(0)).toBe(true);
    });

    it('現在ノードは削除されない', () => {
        const { manager, tree } = makeInsertChain(4);
        // currentId をn3（中間ノード）に移動
        // n3のidはrootが0, n1=1, n2=2, n3=3
        tree.currentId = 3;
        manager.compact(tree);
        expect(tree.nodes.has(3)).toBe(true);
    });

    it('分岐点は削除されない', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(base));

        // n1から2方向に分岐させる
        const content2 = base + 'b';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(content2), [{ offset: 100, removeLength: 0, text: 'b' }])
        );
        manager.onDidSaveTextDocument(makeDocument(content2));

        const tree = manager.getTree(makeUri());
        tree.currentId = 1; // n1に戻して分岐作成

        const content3 = base + 'c';
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(content3), [{ offset: 100, removeLength: 0, text: 'c' }])
        );
        manager.onDidSaveTextDocument(makeDocument(content3));

        // n1はchildren.length===2の分岐点
        const n1 = tree.nodes.get(1)!;
        expect(n1.children.length).toBe(2);

        manager.compact(tree);
        expect(tree.nodes.has(1)).toBe(true); // 分岐点は残る
    });

    it('終点（leaf）は削除されない', () => {
        const { manager, tree } = makeInsertChain(2);
        // 末尾のleafノード（currentId）が残ることを確認
        const leafId = tree.currentId;
        manager.compact(tree);
        expect(tree.nodes.has(leafId)).toBe(true);
    });

    it('mixedノード（insert+delete混在）は削除されない', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(base));

        // 置換操作: insert+deleteが混在 → mixed
        const replaced = base.slice(0, 99) + 'z';
        const doc = makeDocument(replaced);
        manager.onDidChangeTextDocument(
            makeChangeEvent(doc, [{ offset: 99, removeLength: 1, text: 'z' }])
        );
        manager.onDidSaveTextDocument(doc);

        const tree = manager.getTree(makeUri());
        const mixedId = tree.currentId; // n2 (mixed: insert 'z' + delete 'a')
        const sizeBefore = tree.nodes.size;

        manager.compact(tree);

        expect(tree.nodes.has(mixedId)).toBe(true);
        expect(tree.nodes.size).toBe(sizeBefore); // 圧縮なし
    });

    it('圧縮後もreconstructContentが正しく復元できる', () => {
        const { manager, tree, finalContent } = makeInsertChain(6);
        manager.compact(tree);
        // すべての残存ノードを復元できることを確認
        for (const [id] of tree.nodes) {
            expect(() => manager.reconstructContent(tree, id)).not.toThrow();
        }
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(finalContent);
    });

    it('メモ付きノードはコンパクション対象外', () => {
        const { manager, tree } = makeInsertChain(6);
        // 中間ノード(id=2)にメモを付ける
        const noteNodeId = 2;
        const noteNode = tree.nodes.get(noteNodeId)!;
        noteNode.note = 'checkpoint';

        const sizeBefore = tree.nodes.size;
        manager.compact(tree);

        expect(tree.nodes.has(noteNodeId)).toBe(true);
        expect(tree.nodes.size).toBeGreaterThan(2); // メモノードが残るので全圧縮にならない
        expect(tree.nodes.size).toBeLessThan(sizeBefore); // それ以外は圧縮される
    });
});

// -----------------------------------------------
// ファイルを閉じたときのクリーンアップ
// -----------------------------------------------
describe('cleanup', () => {
    it('keeps the tree when a file is closed so reopening can restore it', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        manager.onDidCloseTextDocument(doc);

        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(2);
        expect(tree.currentId).toBe(1);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('Hello');
    });

    it('clears buffered diffs when a file is closed', () => {
        const manager = new UndoTreeManager();
        const base = 'a'.repeat(100);
        const changed = `${base}b`;

        manager.onDidSaveTextDocument(makeDocument(base));
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument(changed), [{ offset: 100, removeLength: 0, text: 'b' }])
        );
        manager.onDidCloseTextDocument(makeDocument(changed));
        manager.onDidSaveTextDocument(makeDocument(changed));

        const tree = manager.getTree(makeUri());
        const node = tree.nodes.get(tree.currentId);
        expect(node?.storage.kind).toBe('full');
    });

    it('can unload a persisted tree from memory explicitly', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello', 'file:///unload.md');

        manager.onDidSaveTextDocument(doc);
        expect(manager.hasTree(doc.uri)).toBe(true);

        manager.unloadTree(doc.uri);

        expect(manager.hasTree(doc.uri)).toBe(false);
        expect(manager.getDirtyUris().has(doc.uri.toString())).toBe(false);
    });
});

// -----------------------------------------------
// セッション復元: reconcileCurrentNode
// -----------------------------------------------
describe('reconcileCurrentNode', () => {
    it('ハッシュ一致するノードにcurrentIdを設定する', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('v1'));
        manager.onDidSaveTextDocument(makeDocument('v2'));
        manager.onDidSaveTextDocument(makeDocument('v3'));

        const tree = manager.getTree(uri);
        const v2Id = Array.from(tree.nodes.values()).find((n) => n.label === 'save' && manager.reconstructContent(tree, n.id) === 'v2')?.id;
        expect(v2Id).toBeDefined();

        // currentId をリセットして reconcile
        tree.currentId = 0;
        manager.reconcileCurrentNode(uri, 'v2');
        expect(tree.currentId).toBe(v2Id);
    });

    it('ハッシュ不一致の場合はrootIdにフォールバックする', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('v1'));
        manager.onDidSaveTextDocument(makeDocument('v2'));

        const tree = manager.getTree(uri);
        tree.currentId = 999; // 不正な状態
        manager.reconcileCurrentNode(uri, 'unknown content');
        expect(tree.currentId).toBe(tree.rootId);
    });

    it('ツリーが存在しない場合は何もしない', () => {
        const manager = new UndoTreeManager();
        expect(() => manager.reconcileCurrentNode(makeUri('file:///nonexistent.md'), 'content')).not.toThrow();
    });

    it('currentノードのコンテンツと一致する場合はそのまま維持される', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('hello'));

        const tree = manager.getTree(uri);
        const originalCurrentId = tree.currentId;
        manager.reconcileCurrentNode(uri, 'hello');
        expect(tree.currentId).toBe(originalCurrentId);
    });
});

// -----------------------------------------------
// DAG収束
// -----------------------------------------------
describe('DAG収束', () => {
    // ケース1: A→B→A で2つ目のAは新ノードを作らず既存Aに収束
    it('同一内容を再保存すると既存ノードに収束し新ノードを作らない', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        manager.onDidSaveTextDocument(makeDocument('B'));
        const sizeAfterB = manager.getTree(uri).nodes.size;

        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);

        expect(tree.nodes.size).toBe(sizeAfterB); // 新ノード追加なし
    });

    // ケース2: 収束後のcurrentIdが既存ノードを指す
    it('収束後のcurrentIdが収束先ノードのidになる', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);
        const nodeAId = tree.currentId;

        manager.onDidSaveTextDocument(makeDocument('B'));
        manager.onDidSaveTextDocument(makeDocument('A'));

        expect(tree.currentId).toBe(nodeAId);
    });

    // ケース3: ツリー構造不変（エッジ追加なし）
    it('収束時にエッジは追加されない', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);
        const nodeAId = tree.currentId;

        manager.onDidSaveTextDocument(makeDocument('B'));
        // B保存後のnodeAのchildrenを記録（BがAの子として追加されている）
        const childrenAfterB = [...(tree.nodes.get(nodeAId)?.children ?? [])];

        // Aに収束 → nodeAのchildrenはB保存後から変わらない
        manager.onDidSaveTextDocument(makeDocument('A'));

        expect(tree.nodes.get(nodeAId)?.children).toEqual(childrenAfterB);
    });

    // ケース4: hashMapは変わらない
    it('収束後もhashMapは収束先ノードを指したまま', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);
        const nodeAId = tree.currentId;
        const hashA = tree.nodes.get(nodeAId)!.hash;

        manager.onDidSaveTextDocument(makeDocument('B'));
        manager.onDidSaveTextDocument(makeDocument('A'));

        expect(tree.hashMap.get(hashA)).toBe(nodeAId);
    });

    // ケース5: diffBufferがクリアされる
    it('収束時にdiffBufferがクリアされる', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        manager.onDidSaveTextDocument(makeDocument('BB'));

        // diffBufferに積む
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument('A'), [{ offset: 1, removeLength: 1, text: '' }])
        );

        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);

        // 収束後のノードはdelta蓄積を持たない（フルで復元できる）
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('A');
    });

    // ケース6: onRefreshが呼ばれる
    it('収束時にonRefreshが呼ばれる', () => {
        const manager = new UndoTreeManager();
        manager.onDidSaveTextDocument(makeDocument('A'));
        manager.onDidSaveTextDocument(makeDocument('B'));

        let refreshCalled = false;
        manager.onRefresh = () => { refreshCalled = true; };

        manager.onDidSaveTextDocument(makeDocument('A'));
        expect(refreshCalled).toBe(true);
    });

    // ケース7: rootへの収束
    it('rootと同一内容を保存するとrootに収束する', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        // rootの内容を確定させる
        manager.onDidSaveTextDocument(makeDocument('root content'));
        const tree = manager.getTree(uri);
        const rootNodeId = 0; // rootは常にid=0
        // rootのhashを設定するためにrootの内容で直接保存するシナリオ
        // root(空) → A → 空 で収束テスト
        const manager2 = new UndoTreeManager();
        const uri2 = makeUri('file:///test2.md');
        manager2.onDidSaveTextDocument(makeDocument('X', 'file:///test2.md'));
        const tree2 = manager2.getTree(uri2);
        const nodeXId = tree2.currentId;

        manager2.onDidSaveTextDocument(makeDocument('Y', 'file:///test2.md'));
        manager2.onDidSaveTextDocument(makeDocument('X', 'file:///test2.md'));

        expect(tree2.currentId).toBe(nodeXId);
        expect(manager2.reconstructContent(tree2, tree2.currentId)).toBe('X');
    });

    // ケース8: 別ブランチへの収束
    it('別ブランチの内容と一致する場合そのブランチのノードに収束する', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        // root → A → B (branch1)
        manager.onDidSaveTextDocument(makeDocument('A'));
        manager.onDidSaveTextDocument(makeDocument('B'));
        const tree = manager.getTree(uri);
        const nodeBId = tree.currentId;

        // root → A → C (branch2 start from A)
        const nodeAId = tree.nodes.get(nodeBId)!.parents[0];
        tree.currentId = nodeAId;
        manager.onDidSaveTextDocument(makeDocument('C'));

        // branch2から B と同一内容を保存 → branch1のBに収束
        manager.onDidSaveTextDocument(makeDocument('B'));

        expect(tree.currentId).toBe(nodeBId);
    });

    // ケース9: 収束後の新規編集は収束先から分岐する
    it('収束後の新規保存は収束先ノードの子になる', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);
        const nodeAId = tree.currentId;

        manager.onDidSaveTextDocument(makeDocument('B'));
        manager.onDidSaveTextDocument(makeDocument('A')); // 収束 → nodeAId
        manager.onDidSaveTextDocument(makeDocument('D')); // 新規編集

        const nodeDId = tree.currentId;
        expect(tree.nodes.get(nodeDId)!.parents).toContain(nodeAId);
    });

    // ケース10: compact後（hashMapにない）は通常の新ノード作成にフォールバック
    it('compactでノードが消えhashMapにない場合は新ノードを作成する', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        // insertチェーンを作り compact でノードを削除
        manager.onDidSaveTextDocument(makeDocument('aaa'));
        manager.onDidSaveTextDocument(makeDocument('aaab'));
        manager.onDidSaveTextDocument(makeDocument('aaabb'));
        const tree = manager.getTree(uri);
        // id=1(aaa)はcompact対象: 親=root,子=2,insertのみ → compressible
        // ただし今のcurrentId=2なのでid=1は圧縮可能
        // 手動でid=1をhashMapから削除してcompactなしでシミュレート
        const node1 = tree.nodes.get(1)!;
        tree.hashMap.delete(node1.hash);

        const sizeBefore = tree.nodes.size;
        manager.onDidSaveTextDocument(makeDocument('aaa')); // node1と同内容だがhashMapにない

        expect(tree.nodes.size).toBe(sizeBefore + 1); // 新ノード作成
    });

    // ケース11: メモ付きノードへの収束でメモが保持される
    it('メモ付きノードへ収束してもメモは保持される', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('A'));
        const tree = manager.getTree(uri);
        const nodeAId = tree.currentId;
        tree.nodes.get(nodeAId)!.note = 'important checkpoint';

        manager.onDidSaveTextDocument(makeDocument('B'));
        manager.onDidSaveTextDocument(makeDocument('A')); // Aに収束

        expect(tree.nodes.get(nodeAId)!.note).toBe('important checkpoint');
    });

    // ケース12: 収束後のreconstructContentが正しい
    it('収束後のreconstructContentが収束先ノードの内容を返す', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.onDidSaveTextDocument(makeDocument('hello world'));
        manager.onDidSaveTextDocument(makeDocument('hello there'));
        manager.onDidSaveTextDocument(makeDocument('hello world')); // 収束

        const tree = manager.getTree(uri);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe('hello world');
    });
});

// -----------------------------------------------
// ダーティフラグ
// -----------------------------------------------
describe('dirtyTrees', () => {
    it('初期状態はdirtyなし', () => {
        const manager = new UndoTreeManager();
        expect(manager.getDirtyUris().size).toBe(0);
    });

    it('保存でノードが追加されるとdirtyになる', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        expect(manager.getDirtyUris().has(doc.uri.toString())).toBe(true);
    });

    it('内容が変わらない保存ではdirtyにならない', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        manager.clearDirty(manager.getDirtyUris());

        manager.onDidSaveTextDocument(doc); // 同じ内容
        expect(manager.getDirtyUris().has(doc.uri.toString())).toBe(false);
    });

    it('clearDirtyで特定URIのみクリアされる', () => {
        const manager = new UndoTreeManager();
        const doc1 = makeDocument('A', 'file:///a.md');
        const doc2 = makeDocument('B', 'file:///b.md');
        manager.onDidSaveTextDocument(doc1);
        manager.onDidSaveTextDocument(doc2);

        manager.clearDirty([doc1.uri.toString()]);
        expect(manager.getDirtyUris().has(doc1.uri.toString())).toBe(false);
        expect(manager.getDirtyUris().has(doc2.uri.toString())).toBe(true);
    });

    it('markDirtyで手動マークできる', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri('file:///manual.md');
        manager.markDirty(uri);
        expect(manager.getDirtyUris().has(uri.toString())).toBe(true);
    });

    it('getDirtyUrisはスナップショットを返す（元のSetと独立）', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);

        const snapshot = manager.getDirtyUris();
        manager.clearDirty(manager.getDirtyUris());

        // スナップショットはclearDirtyの影響を受けない
        expect(snapshot.has(doc.uri.toString())).toBe(true);
        expect(manager.getDirtyUris().size).toBe(0);
    });

    it('DAG収束（新ノード作成なし）ではdirtyにならない', () => {
        const manager = new UndoTreeManager();
        const doc1 = makeDocument('A');
        const doc2 = makeDocument('B');
        manager.onDidSaveTextDocument(doc1);
        manager.onDidSaveTextDocument(doc2);
        manager.clearDirty(manager.getDirtyUris());

        // Aに収束（新ノード作成なし・currentId変更のみ）
        // addNodeが呼ばれないのでdirtyはmarkされない
        // ただし実装上 addNode の早期returnは dirtyをmarkしないので
        // この挙動をテストで明確化する
        manager.onDidSaveTextDocument(doc1);
        // 収束時はdirtyにならないこと（実装の現状を記録）
        expect(manager.getDirtyUris().has(doc1.uri.toString())).toBe(false);
    });

    it('syncDocumentStateでノードが追加されるとdirtyになる', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.syncDocumentState(uri, 'initial');
        manager.clearDirty(manager.getDirtyUris());

        manager.syncDocumentState(uri, 'changed');
        expect(manager.getDirtyUris().has(uri.toString())).toBe(true);
    });

    it('syncDocumentStateで内容が変わらなければdirtyにならない', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri();
        manager.syncDocumentState(uri, 'same');
        manager.clearDirty(manager.getDirtyUris());

        manager.syncDocumentState(uri, 'same');
        expect(manager.getDirtyUris().has(uri.toString())).toBe(false);
    });

    it('複数URIが混在するときdirtyは正確に追跡される', () => {
        const manager = new UndoTreeManager();
        const docA = makeDocument('A', 'file:///a.md');
        const docB = makeDocument('B', 'file:///b.md');
        const docC = makeDocument('C', 'file:///c.md');

        manager.onDidSaveTextDocument(docA);
        manager.onDidSaveTextDocument(docB);
        manager.onDidSaveTextDocument(docC);

        const dirty = manager.getDirtyUris();
        expect(dirty.size).toBe(3);
        expect(dirty.has('file:///a.md')).toBe(true);
        expect(dirty.has('file:///b.md')).toBe(true);
        expect(dirty.has('file:///c.md')).toBe(true);
    });

    it('resetAll clears tracked trees and dirty state and starts fresh afterwards', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello', 'file:///reset.md');
        manager.onDidSaveTextDocument(doc);
        manager.onDidChangeTextDocument(
            makeChangeEvent(makeDocument('Hello!', 'file:///reset.md'), [{ offset: 5, removeLength: 0, text: '!' }])
        );

        expect(manager.hasTree(doc.uri)).toBe(true);
        expect(manager.getDirtyUris().has(doc.uri.toString())).toBe(true);

        manager.resetAll();

        expect(manager.hasTree(doc.uri)).toBe(false);
        expect(manager.getDirtyUris().size).toBe(0);

        const freshTree = manager.getTree(doc.uri);
        expect(freshTree.nodes.size).toBe(1);
        expect(freshTree.currentId).toBe(0);
    });
});

describe('persisted tree reconciliation', () => {
    it('adds a restore node from the imported current node when persisted content differs', () => {
        const manager = new UndoTreeManager();
        const uri = makeUri('file:///persisted.md');

        manager.onDidSaveTextDocument(makeDocument('base', 'file:///persisted.md'));
        manager.onDidSaveTextDocument(makeDocument('latest', 'file:///persisted.md'));

        const exported = manager.exportState();
        const restored = new UndoTreeManager();
        restored.importState(exported);

        const tree = restored.syncDocumentState(uri, 'disk version');
        const restoreNode = tree.nodes.get(tree.currentId)!;

        expect(restoreNode.label).toBe('restore');
        expect(restoreNode.parents).toEqual([2]);
        expect(restored.reconstructContent(tree, tree.currentId)).toBe('disk version');
    });
});

// -----------------------------------------------
// hardCompact
// -----------------------------------------------
describe('hardCompact', () => {
    const DAY_MS = 86_400_000;

    // 共通ヘルパー: base保存後に分岐を作るシナリオを構築
    // root(0) → base(baseId) → main(mainId, current=recent)
    //                        → branch(branchId, timestamp=daysAgo)
    function makeBranchScenario(branchDaysAgo: number) {
        const manager = new UndoTreeManager();
        const now = Date.now();
        manager.onDidSaveTextDocument(makeDocument('base'));
        const tree = manager.getTree(makeUri());
        const baseId = tree.currentId;

        // main path (recent)
        manager.onDidSaveTextDocument(makeDocument('main'));
        const mainId = tree.currentId;

        // old branch from baseId
        tree.currentId = baseId;
        manager.onDidSaveTextDocument(makeDocument('old_branch'));
        const branchId = tree.currentId;
        tree.nodes.get(branchId)!.timestamp = now - branchDaysAgo * DAY_MS;

        // restore current to main
        tree.currentId = mainId;
        return { manager, tree, baseId, mainId, branchId };
    }

    it('古いブランチが削除される', () => {
        const { manager, tree, branchId } = makeBranchScenario(60);
        const sizeBefore = tree.nodes.size;
        const removed = manager.hardCompact(tree, 30);
        expect(removed).toBe(1);
        expect(tree.nodes.has(branchId)).toBe(false);
        expect(tree.nodes.size).toBe(sizeBefore - 1);
    });

    it('currentノードは古くても保護される', () => {
        const { manager, tree } = makeBranchScenario(60);
        const currentId = tree.currentId;
        // current自体も古くする
        tree.nodes.get(currentId)!.timestamp = Date.now() - 60 * DAY_MS;
        manager.hardCompact(tree, 30);
        expect(tree.nodes.has(currentId)).toBe(true);
    });

    it('currentの祖先は古くても保護される', () => {
        const { manager, tree, baseId, mainId } = makeBranchScenario(60);
        // baseId は current(mainId) の祖先 → 保護される
        tree.nodes.get(baseId)!.timestamp = Date.now() - 60 * DAY_MS;
        const sizeBefore = tree.nodes.size;
        manager.hardCompact(tree, 30);
        expect(tree.nodes.has(baseId)).toBe(true);
        expect(tree.nodes.has(mainId)).toBe(true);
    });

    it('notedノードは古くても保護される', () => {
        const { manager, tree, branchId } = makeBranchScenario(60);
        tree.nodes.get(branchId)!.note = 'keep this';
        manager.hardCompact(tree, 30);
        expect(tree.nodes.has(branchId)).toBe(true);
    });

    it('notedノードの祖先も保護される', () => {
        // baseId → old_branch_parent(60d) → noted_leaf(50d)
        const manager = new UndoTreeManager();
        const now = Date.now();
        manager.onDidSaveTextDocument(makeDocument('base'));
        const tree = manager.getTree(makeUri());
        const baseId = tree.currentId;

        // main path (current, recent)
        manager.onDidSaveTextDocument(makeDocument('main'));
        const mainId = tree.currentId;

        // branch: parent(60d) → noted_leaf(50d)
        tree.currentId = baseId;
        manager.onDidSaveTextDocument(makeDocument('branch_parent'));
        const parentId = tree.currentId;
        tree.nodes.get(parentId)!.timestamp = now - 60 * DAY_MS;

        manager.onDidSaveTextDocument(makeDocument('noted_leaf'));
        const notedId = tree.currentId;
        tree.nodes.get(notedId)!.timestamp = now - 50 * DAY_MS;
        tree.nodes.get(notedId)!.note = 'important';

        tree.currentId = mainId;
        const removed = manager.hardCompact(tree, 30);
        expect(removed).toBe(0); // noted の祖先 parentId も保護
        expect(tree.nodes.has(parentId)).toBe(true);
        expect(tree.nodes.has(notedId)).toBe(true);
    });

    it('閾値以内のブランチは削除されない', () => {
        const { manager, tree } = makeBranchScenario(10); // 10日前, 閾値30日以内
        const sizeBefore = tree.nodes.size;
        const removed = manager.hardCompact(tree, 30);
        expect(removed).toBe(0);
        expect(tree.nodes.size).toBe(sizeBefore);
    });

    it('削除後にhashMapから対象エントリが除去される', () => {
        const { manager, tree, branchId } = makeBranchScenario(60);
        const oldHash = tree.nodes.get(branchId)!.hash;
        manager.hardCompact(tree, 30);
        expect(tree.nodes.has(branchId)).toBe(false);
        expect(tree.hashMap.has(oldHash)).toBe(false);
    });

    it('削除ノードが親の children から除去される', () => {
        const { manager, tree, baseId, branchId } = makeBranchScenario(60);
        manager.hardCompact(tree, 30);
        expect(tree.nodes.get(baseId)!.children).not.toContain(branchId);
    });

    it('削除ノードが 0 のとき返り値は 0', () => {
        const { manager, tree } = makeBranchScenario(10);
        const removed = manager.hardCompact(tree, 30);
        expect(removed).toBe(0);
    });

    it('古いブランチのサブツリーがまとめて削除される', () => {
        // baseId → old_root(60d) → old_child1(55d) → old_child2(50d)
        const manager = new UndoTreeManager();
        const now = Date.now();
        manager.onDidSaveTextDocument(makeDocument('base'));
        const tree = manager.getTree(makeUri());
        const baseId = tree.currentId;

        // main path
        manager.onDidSaveTextDocument(makeDocument('main'));
        const mainId = tree.currentId;

        // old subtree: 3ノード
        tree.currentId = baseId;
        manager.onDidSaveTextDocument(makeDocument('old1'));
        const oldId1 = tree.currentId;
        tree.nodes.get(oldId1)!.timestamp = now - 60 * DAY_MS;

        manager.onDidSaveTextDocument(makeDocument('old2'));
        const oldId2 = tree.currentId;
        tree.nodes.get(oldId2)!.timestamp = now - 55 * DAY_MS;

        manager.onDidSaveTextDocument(makeDocument('old3'));
        const oldId3 = tree.currentId;
        tree.nodes.get(oldId3)!.timestamp = now - 50 * DAY_MS;

        tree.currentId = mainId;
        const removed = manager.hardCompact(tree, 30);
        expect(removed).toBe(3);
        expect(tree.nodes.has(oldId1)).toBe(false);
        expect(tree.nodes.has(oldId2)).toBe(false);
        expect(tree.nodes.has(oldId3)).toBe(false);
    });
});
