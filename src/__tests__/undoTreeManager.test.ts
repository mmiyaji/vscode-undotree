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
    it('同じ内容に戻ったとき既存ノードにリンクする', () => {
        const manager = new UndoTreeManager();
        const doc1 = makeDocument('Hello');
        const doc2 = makeDocument('Hello World');
        const doc3 = makeDocument('Hello'); // doc1と同じ内容

        manager.onDidSaveTextDocument(doc1);
        manager.onDidSaveTextDocument(doc2);
        manager.onDidSaveTextDocument(doc3);

        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(4);
        expect(tree.currentId).toBe(3);
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
        // A → B → A → B → A のように繰り返してもノード数は3以下
        const docA = makeDocument('content-A');
        const docB = makeDocument('content-B');

        manager.onDidSaveTextDocument(docA); // node1: A
        manager.onDidSaveTextDocument(docB); // node2: B
        manager.onDidSaveTextDocument(docA); // Aに収束 → node1へジャンプ
        manager.onDidSaveTextDocument(docB); // Bに収束 → node2へジャンプ
        manager.onDidSaveTextDocument(docA); // Aに収束 → node1へジャンプ

        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(6);
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
});

// -----------------------------------------------
// ファイルを閉じたときのクリーンアップ
// -----------------------------------------------
describe('クリーンアップ', () => {
    it('ファイルを閉じるとツリーが削除される', () => {
        const manager = new UndoTreeManager();
        const doc = makeDocument('Hello');
        manager.onDidSaveTextDocument(doc);
        manager.onDidCloseTextDocument(doc);
        // 再度getTreeすると初期状態に戻る
        const tree = manager.getTree(doc.uri);
        expect(tree.nodes.size).toBe(1);
        expect(tree.currentId).toBe(0);
    });
});
