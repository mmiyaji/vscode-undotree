import { UndoTreeManager } from '../undoTreeManager';

jest.mock('vscode');

const managers: UndoTreeManager[] = [];
afterEach(() => {
    managers.forEach((m) => m.dispose());
    managers.length = 0;
});
function createManager() {
    const m = new UndoTreeManager();
    managers.push(m);
    return m;
}

function makeUri(path = 'file:///test.md') {
    return { toString: () => path } as any;
}
function makeDocument(content: string, uriStr = 'file:///test.md') {
    return { getText: () => content, uri: makeUri(uriStr), isUntitled: false } as any;
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

function elapsed(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

// -----------------------------------------------
// 1. 大量保存（deltaノードの連続追加）
// -----------------------------------------------
describe('大量保存パフォーマンス', () => {
    it('1文字ずつ1000回保存しても100ms以内で完了する', () => {
        const manager = createManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        const ms = elapsed(() => {
            for (let i = 0; i < 1000; i++) {
                const content = base + 'b'.repeat(i + 1);
                const doc = makeDocument(content);
                manager.onDidChangeTextDocument(
                    makeChangeEvent(doc, [{ offset: 1000 + i, removeLength: 0, text: 'b' }])
                );
                manager.onDidSaveTextDocument(doc);
            }
        });

        console.log(`1000回保存: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(100);
    });

    it('1001ノードが正しく作られている', () => {
        const manager = createManager();
        const base = 'a'.repeat(100);
        manager.onDidSaveTextDocument(makeDocument(base));
        for (let i = 0; i < 100; i++) {
            const content = base + 'b'.repeat(i + 1);
            const doc = makeDocument(content);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: 100 + i, removeLength: 0, text: 'b' }])
            );
            manager.onDidSaveTextDocument(doc);
        }
        const tree = manager.getTree(makeUri());
        expect(tree.nodes.size).toBe(102); // root + node1(base) + 100ノード
    });
});

// -----------------------------------------------
// 2. 深いdeltaチェーンの復元
// -----------------------------------------------
describe('深いdeltaチェーンの復元パフォーマンス', () => {
    it('100段のdeltaチェーンを200ms以内に復元できる', () => {
        const manager = createManager();
        // 1000文字のベースで1文字ずつ追加（変更率 < 30% → delta）
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        let current = base;
        for (let i = 0; i < 100; i++) {
            current = current + 'b';
            const doc = makeDocument(current);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: 1000 + i, removeLength: 0, text: 'b' }])
            );
            manager.onDidSaveTextDocument(doc);
        }

        const tree = manager.getTree(makeUri());
        const targetId = tree.currentId;

        const ms = elapsed(() => {
            manager.reconstructContent(tree, targetId);
        });

        console.log(`100段deltaチェーン復元: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(200);
    });

    it('復元内容が正しい', () => {
        const manager = createManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        let current = base;
        for (let i = 0; i < 50; i++) {
            current = current + 'b';
            const doc = makeDocument(current);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: 1000 + i, removeLength: 0, text: 'b' }])
            );
            manager.onDidSaveTextDocument(doc);
        }

        const tree = manager.getTree(makeUri());
        const restored = manager.reconstructContent(tree, tree.currentId);
        expect(restored).toBe(current);
    });
});

// -----------------------------------------------
// 3. 大きなファイルのハッシュ計算
// -----------------------------------------------
describe('大きなファイルのパフォーマンス', () => {
    it('1MBファイルの保存が500ms以内に完了する', () => {
        const manager = createManager();
        const large = 'a'.repeat(1024 * 1024); // 1MB
        const doc = makeDocument(large);

        const ms = elapsed(() => {
            manager.onDidSaveTextDocument(doc);
        });

        console.log(`1MBファイル保存: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(500);
    });

    it('1MBファイルの2回目保存（変化なし）は50ms以内', () => {
        const manager = createManager();
        const large = 'a'.repeat(1024 * 1024);
        const doc = makeDocument(large);
        manager.onDidSaveTextDocument(doc); // 1回目

        const ms = elapsed(() => {
            manager.onDidSaveTextDocument(doc); // 2回目: 変化なし
        });

        console.log(`1MBファイル重複保存スキップ: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(50);
    });
});

// -----------------------------------------------
// 4. 多数の分岐
// -----------------------------------------------
describe('多数の分岐パフォーマンス', () => {
    it('50分岐を50ms以内に作成できる', () => {
        const manager = createManager();
        const base = 'a'.repeat(200);
        manager.onDidSaveTextDocument(makeDocument(base));

        const tree = manager.getTree(makeUri());
        const branchRootId = tree.currentId;

        const ms = elapsed(() => {
            for (let i = 0; i < 50; i++) {
                tree.currentId = branchRootId;
                const content = base + String(i).padStart(5, '0');
                const doc = makeDocument(content);
                manager.onDidChangeTextDocument(
                    makeChangeEvent(doc, [{ offset: 200, removeLength: 0, text: String(i).padStart(5, '0') }])
                );
                manager.onDidSaveTextDocument(doc);
            }
        });

        console.log(`50分岐作成: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(50);
    });

    it('分岐元ノードはfullに昇格している', () => {
        const manager = createManager();
        const base = 'a'.repeat(200);
        manager.onDidSaveTextDocument(makeDocument(base));
        const tree = manager.getTree(makeUri());
        const branchRootId = tree.currentId;

        for (let i = 0; i < 3; i++) {
            tree.currentId = branchRootId;
            const content = base + String(i);
            const doc = makeDocument(content);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: 200, removeLength: 0, text: String(i) }])
            );
            manager.onDidSaveTextDocument(doc);
        }

        const branchNode = tree.nodes.get(branchRootId)!;
        expect(branchNode.storage.kind).toBe('full');
        expect(branchNode.children.length).toBe(3);
    });
});

// -----------------------------------------------
// 5. DAG収束パフォーマンス
// -----------------------------------------------
describe('DAG収束パフォーマンス', () => {
    it('100回のDAG収束検索が10ms以内', () => {
        const manager = createManager();
        // 100個のユニークなノードを作成
        for (let i = 0; i < 100; i++) {
            const content = 'content_' + i.toString().padStart(4, '0');
            manager.onDidSaveTextDocument(makeDocument(content, `file:///file${i}.md`));
        }

        // 既存のhashへの収束をテスト
        const manager2 = createManager();
        manager2.onDidSaveTextDocument(makeDocument('base content here'));

        const ms = elapsed(() => {
            for (let i = 0; i < 100; i++) {
                manager2.onDidSaveTextDocument(makeDocument(`unique content ${i}`));
                manager2.onDidSaveTextDocument(makeDocument('base content here')); // 収束
            }
        });

        console.log(`100回DAG収束: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(10);
    });
});
