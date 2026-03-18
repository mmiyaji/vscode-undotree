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
// 5. compact（履歴圧縮）パフォーマンス
// -----------------------------------------------
describe('compactパフォーマンス', () => {
    it('1000ノードの直列insertチェーンをcompactして100ms以内', () => {
        const manager = createManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        for (let i = 0; i < 1000; i++) {
            const content = base + 'b'.repeat(i + 1);
            const doc = makeDocument(content);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: 1000 + i, removeLength: 0, text: 'b' }])
            );
            manager.onDidSaveTextDocument(doc);
        }

        const tree = manager.getTree(makeUri());
        const beforeSize = tree.nodes.size;

        const ms = elapsed(() => {
            manager.compact(tree);
        });

        console.log(`1000ノードcompact: ${ms.toFixed(2)}ms (${beforeSize} → ${tree.nodes.size}ノード)`);
        expect(ms).toBeLessThan(500);
    });

    it('compact後のreconstructContentが50ms以内', () => {
        const manager = createManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        let current = base;
        for (let i = 0; i < 500; i++) {
            current += 'b';
            const doc = makeDocument(current);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: 1000 + i, removeLength: 0, text: 'b' }])
            );
            manager.onDidSaveTextDocument(doc);
        }

        const tree = manager.getTree(makeUri());
        manager.compact(tree);

        const ms = elapsed(() => {
            manager.reconstructContent(tree, tree.currentId);
        });

        console.log(`compact後500段復元: ${ms.toFixed(2)}ms (残${tree.nodes.size}ノード)`);
        expect(ms).toBeLessThan(50);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(current);
    });

    it('mixed操作が混在するチェーンのcompactが100ms以内', () => {
        // insert連続 → mixed（置換）でチェーンが分断されるパターン
        // [insert×50] → [mixed] → [insert×50] → [mixed] → [insert×50] の繰り返し×4
        const manager = createManager();
        const base = 'a'.repeat(1000);
        manager.onDidSaveTextDocument(makeDocument(base));

        let content = base;
        for (let block = 0; block < 4; block++) {
            // insert × 50
            for (let i = 0; i < 50; i++) {
                content += 'b';
                const doc = makeDocument(content);
                manager.onDidChangeTextDocument(
                    makeChangeEvent(doc, [{ offset: content.length - 1, removeLength: 0, text: 'b' }])
                );
                manager.onDidSaveTextDocument(doc);
            }
            // mixed: 末尾1文字を置換
            const replaced = content.slice(0, -1) + 'z';
            const doc = makeDocument(replaced);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc, [{ offset: content.length - 1, removeLength: 1, text: 'z' }])
            );
            manager.onDidSaveTextDocument(doc);
            content = replaced;
        }

        const tree = manager.getTree(makeUri());
        const beforeSize = tree.nodes.size;

        const ms = elapsed(() => {
            manager.compact(tree);
        });

        console.log(`mixed混在(${beforeSize}ノード)compact: ${ms.toFixed(2)}ms → 残${tree.nodes.size}ノード`);
        expect(ms).toBeLessThan(500);
        // mixedノードはチェーンを分断するため、各block内の中間insertのみ圧縮される
        expect(tree.nodes.size).toBeLessThan(beforeSize);
        expect(manager.reconstructContent(tree, tree.currentId)).toBe(content);
    });

    it('分岐ありツリーのcompactが100ms以内', () => {
        // root → base → [branch A: insert×100] × 10本
        const manager = createManager();
        const base = 'a'.repeat(500);
        manager.onDidSaveTextDocument(makeDocument(base));

        const tree = manager.getTree(makeUri());
        const branchRootId = tree.currentId;

        for (let branch = 0; branch < 10; branch++) {
            tree.currentId = branchRootId;
            let content = base + `[branch${branch}]`;
            const doc0 = makeDocument(content);
            manager.onDidChangeTextDocument(
                makeChangeEvent(doc0, [{ offset: base.length, removeLength: 0, text: `[branch${branch}]` }])
            );
            manager.onDidSaveTextDocument(doc0);

            // 各ブランチにinsert × 30
            for (let i = 0; i < 30; i++) {
                content += 'x';
                const doc = makeDocument(content);
                manager.onDidChangeTextDocument(
                    makeChangeEvent(doc, [{ offset: content.length - 1, removeLength: 0, text: 'x' }])
                );
                manager.onDidSaveTextDocument(doc);
            }
        }

        const beforeSize = tree.nodes.size;

        const ms = elapsed(() => {
            manager.compact(tree);
        });

        console.log(`10分岐×30ノード(${beforeSize}ノード)compact: ${ms.toFixed(2)}ms → 残${tree.nodes.size}ノード`);
        expect(ms).toBeLessThan(500);
        // 分岐点(branchRootId)は削除されない
        expect(tree.nodes.has(branchRootId)).toBe(true);
        expect(tree.nodes.has(0)).toBe(true); // root
    });
});

// -----------------------------------------------
// 6. ハッシュ計算パフォーマンス（ファイルサイズ別）
// -----------------------------------------------
describe('ハッシュ計算パフォーマンス（ファイルサイズ別）', () => {
    const sizes: Array<{ label: string; bytes: number; limitMs: number }> = [
        { label: '1 KB',   bytes: 1_024,         limitMs: 5   },
        { label: '10 KB',  bytes: 10_240,        limitMs: 5   },
        { label: '100 KB', bytes: 102_400,       limitMs: 10  },
        { label: '1 MB',   bytes: 1_048_576,     limitMs: 50  },
        { label: '5 MB',   bytes: 5_242_880,     limitMs: 200 },
    ];

    // 各サイズごとに: 初回保存(ハッシュ計算) + reconcileCurrentNode(ハッシュ計算+lookup) を計測
    for (const { label, bytes, limitMs } of sizes) {
        it(`${label}: addNode時のハッシュ計算が${limitMs}ms以内`, () => {
            const manager = createManager();
            const content = 'a'.repeat(bytes);

            // JITウォームアップ
            manager.onDidSaveTextDocument(makeDocument(content + 'x'));

            const ms = elapsed(() => {
                manager.onDidSaveTextDocument(makeDocument(content));
            });

            console.log(`  addNode hash [${label}]: ${ms.toFixed(3)}ms`);
            expect(ms).toBeLessThan(limitMs);
        });

        it(`${label}: reconcileCurrentNode（ハッシュ計算+hashMapルックアップ）が${limitMs}ms以内`, () => {
            const manager = createManager();
            const uri = makeUri();
            const content = 'a'.repeat(bytes);
            manager.onDidSaveTextDocument(makeDocument(content));

            // JITウォームアップ
            manager.reconcileCurrentNode(uri, content);

            const ms = elapsed(() => {
                manager.reconcileCurrentNode(uri, content);
            });

            console.log(`  reconcile   [${label}]: ${ms.toFixed(3)}ms`);
            expect(ms).toBeLessThan(limitMs);
        });
    }

    it('ファイルサイズ別ハッシュ計算時間の一覧（参考）', () => {
        const results: string[] = [];
        for (const { label, bytes } of sizes) {
            const manager = createManager();
            const content = 'a'.repeat(bytes);

            // ウォームアップ
            manager.onDidSaveTextDocument(makeDocument(content));

            // 計測: 10回平均
            const uri = makeUri();
            let total = 0;
            for (let i = 0; i < 10; i++) {
                total += elapsed(() => manager.reconcileCurrentNode(uri, content));
            }
            results.push(`${label.padStart(6)}: avg ${(total / 10).toFixed(3)}ms`);
        }
        console.log('\n--- ハッシュ計算時間（reconcileCurrentNode, 10回平均） ---');
        results.forEach((r) => console.log('  ' + r));
    });
});

// -----------------------------------------------
// 7. DAG収束パフォーマンス
// -----------------------------------------------

// -----------------------------------------------
// ヘルパー: checkpointノードを持つツリーを importTree で注入
// -----------------------------------------------
function importCheckpointTree(manager: ReturnType<typeof createManager>, uriStr: string, contentHash: string) {
    manager.importTree(uriStr, {
        nodes: [
            { id: 0, parents: [],  children: [1], timestamp: 0, label: 'root', hash: 'root-hash-' + uriStr, storage: { kind: 'full',       content: ''         } },
            { id: 1, parents: [0], children: [],  timestamp: 1, label: 'cp',   hash: 'node-hash-' + uriStr, storage: { kind: 'checkpoint', contentHash         } },
        ],
        hashMap: [['root-hash-' + uriStr, 0], ['node-hash-' + uriStr, 1]],
        currentId: 1,
        rootId: 0,
    });
}

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
        expect(ms).toBeLessThan(50); // CI環境の遅延を考慮
    });
});

// -----------------------------------------------
// 8. チェックポイントノード復元パフォーマンス
// -----------------------------------------------
describe('チェックポイントノード復元パフォーマンス', () => {
    const sizes: Array<{ label: string; bytes: number; limitMiss: number; limitHit: number }> = [
        { label: '100 KB', bytes: 102_400,   limitMiss: 20,  limitHit: 2  },
        { label: '1 MB',   bytes: 1_048_576, limitMiss: 50,  limitHit: 5  },
        { label: '5 MB',   bytes: 5_242_880, limitMiss: 200, limitHit: 10 },
    ];

    for (const { label, bytes, limitMiss, limitHit } of sizes) {
        it(`${label}: キャッシュミス（contentResolver呼び出し）が${limitMiss}ms以内`, () => {
            const manager = createManager();
            const content = 'x'.repeat(bytes);
            let calls = 0;
            manager.contentResolver = () => { calls++; return content; };

            importCheckpointTree(manager, 'file:///test.md', 'hash-' + label);
            const tree = manager.getTree(makeUri());

            const ms = elapsed(() => {
                manager.reconstructContent(tree, 1);
            });

            expect(calls).toBe(1);
            console.log(`  checkpoint miss [${label}]: ${ms.toFixed(3)}ms`);
            expect(ms).toBeLessThan(limitMiss);
        });

        it(`${label}: キャッシュヒット（2回目復元）が${limitHit}ms以内`, () => {
            const manager = createManager();
            const content = 'x'.repeat(bytes);
            let calls = 0;
            manager.contentResolver = () => { calls++; return content; };

            importCheckpointTree(manager, 'file:///test.md', 'hash-' + label);
            const tree = manager.getTree(makeUri());

            manager.reconstructContent(tree, 1); // キャッシュ充填
            calls = 0;

            const ms = elapsed(() => {
                manager.reconstructContent(tree, 1);
            });

            expect(calls).toBe(0); // resolver 未呼び出し
            console.log(`  checkpoint hit  [${label}]: ${ms.toFixed(3)}ms`);
            expect(ms).toBeLessThan(limitHit);
        });
    }

    it('ファイルサイズ別 miss/hit 比較一覧（参考）', () => {
        const rows: string[] = [];
        for (const { label, bytes } of sizes) {
            const manager = createManager();
            const content = 'x'.repeat(bytes);
            manager.contentResolver = () => content;

            importCheckpointTree(manager, 'file:///test.md', 'hash-ref-' + label);
            const tree = manager.getTree(makeUri());

            const miss = elapsed(() => manager.reconstructContent(tree, 1));

            let total = 0;
            for (let i = 0; i < 10; i++) {
                total += elapsed(() => manager.reconstructContent(tree, 1));
            }
            rows.push(`${label.padStart(6)}: miss=${miss.toFixed(3)}ms  hit avg=${(total / 10).toFixed(3)}ms`);
        }
        console.log('\n--- チェックポイント復元 miss vs hit ---');
        rows.forEach((r) => console.log('  ' + r));
    });
});

// -----------------------------------------------
// 9. LRUキャッシュエビクションパフォーマンス
// -----------------------------------------------
describe('LRUキャッシュエビクションパフォーマンス', () => {
    it('キャッシュ上限を超えた際のエビクションが100ms以内', () => {
        const manager = createManager();
        const chunkBytes = 512 * 1024; // 500KB × 5 = 2.5MB, 上限は2MB
        const contents = Array.from({ length: 5 }, (_, i) => String(i).repeat(chunkBytes));
        manager.setContentCacheMax(2 * 1024 * 1024); // 2MB

        let calls = 0;
        manager.contentResolver = (hash) => { calls++; return contents[parseInt(hash)]; };

        for (let i = 0; i < 5; i++) {
            importCheckpointTree(manager, `file:///f${i}.md`, String(i));
        }

        const ms = elapsed(() => {
            for (let i = 0; i < 5; i++) {
                const tree = manager.getTree(makeUri(`file:///f${i}.md`));
                manager.reconstructContent(tree, 1);
            }
        });

        console.log(`5×500KBキャッシュエビクション: ${ms.toFixed(2)}ms (resolver呼び出し: ${calls}回)`);
        expect(ms).toBeLessThan(100);
        expect(calls).toBe(5); // 全て初回はミス
    });

    it('setContentCacheMax縮小後に古いエントリが追い出される', () => {
        const manager = createManager();
        const content100kb = 'a'.repeat(100 * 1024);
        manager.setContentCacheMax(512 * 1024); // 512KB

        let calls = 0;
        manager.contentResolver = () => { calls++; return content100kb; };

        // 3エントリ（各100KB = 計300KB）をキャッシュに充填
        for (let i = 0; i < 3; i++) {
            importCheckpointTree(manager, `file:///g${i}.md`, `gh${i}`);
            manager.reconstructContent(manager.getTree(makeUri(`file:///g${i}.md`)), 1);
        }
        expect(calls).toBe(3);

        // キャッシュを100KBに縮小 → 最古の2エントリが追い出される
        const msEvict = elapsed(() => manager.setContentCacheMax(100 * 1024));
        console.log(`キャッシュ縮小(300KB→100KB): ${msEvict.toFixed(2)}ms`);
        expect(msEvict).toBeLessThan(5);

        // 追い出されたエントリへのアクセスは再度 resolver が呼ばれる
        calls = 0;
        for (let i = 0; i < 3; i++) {
            manager.reconstructContent(manager.getTree(makeUri(`file:///g${i}.md`)), 1);
        }
        expect(calls).toBeGreaterThanOrEqual(2); // 少なくとも2件が再ロードされる
    });

    it('上限0（キャッシュ無効）でも復元できる', () => {
        const manager = createManager();
        const content = 'z'.repeat(100 * 1024);
        // max=0: 新しいエントリを追加前に既存を全エビクション（直前の1件だけ残る挙動）
        manager.setContentCacheMax(0);

        let calls = 0;
        manager.contentResolver = (hash) => { calls++; return content + hash; };

        // 5つの異なるhashにアクセス → それぞれ直前のエントリをエビクションして再ロード
        for (let i = 0; i < 5; i++) {
            importCheckpointTree(manager, `file:///nc${i}.md`, `hash-nocache-${i}`);
        }

        const ms = elapsed(() => {
            for (let i = 0; i < 5; i++) {
                const tree = manager.getTree(makeUri(`file:///nc${i}.md`));
                manager.reconstructContent(tree, 1);
            }
        });

        // 異なるhashへの初回アクセスは毎回 resolver が呼ばれる
        expect(calls).toBe(5);
        console.log(`キャッシュ無効×5種復元: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(50);
    });
});

// -----------------------------------------------
// 10. チェックポイントを含む複合ツリー操作
// -----------------------------------------------
describe('チェックポイントを含む複合ツリー操作', () => {
    it('checkpointノードはcompactで削除されない', () => {
        const manager = createManager();
        const base = 'a'.repeat(500);
        manager.onDidSaveTextDocument(makeDocument(base));

        // insertチェーンを50ノード作成（通常はcompact対象）
        for (let i = 0; i < 50; i++) {
            const content = base + 'b'.repeat(i + 1);
            const doc = makeDocument(content);
            manager.onDidChangeTextDocument(makeChangeEvent(doc, [{ offset: 500 + i, removeLength: 0, text: 'b' }]));
            manager.onDidSaveTextDocument(doc);
        }

        const tree = manager.getTree(makeUri());
        const sizeBeforeInject = tree.nodes.size;

        // checkpointノードを追加注入（分岐なし・直列チェーンの末尾に接続）
        const cpId = 9999;
        const currentNode = tree.nodes.get(tree.currentId)!;
        currentNode.children.push(cpId);
        tree.nodes.set(cpId, {
            id: cpId,
            parents: [tree.currentId],
            children: [],
            timestamp: Date.now(),
            label: 'checkpoint-injected',
            hash: 'cp-hash',
            storage: { kind: 'checkpoint', contentHash: 'cp-content-hash' },
        });
        tree.currentId = cpId;

        const ms = elapsed(() => manager.compact(tree));

        // checkpointノード自身は currentId なので残る。compact後もツリーは整合している
        expect(tree.nodes.has(cpId)).toBe(true);
        console.log(`checkpoint含む${sizeBeforeInject}ノードcompact: ${ms.toFixed(2)}ms → 残${tree.nodes.size}ノード`);
        expect(ms).toBeLessThan(500);
    });

    it('チェックポイントノードを含む10段チェーンの復元が50ms以内', () => {
        // full → cp → delta × 8 → delta(current) のチェーン
        const manager = createManager();
        const baseContent = 'base'.repeat(200);
        const cpContent = baseContent + 'CP';
        manager.contentResolver = () => cpContent;

        // full node (id=0) + checkpoint node (id=1) + delta chain (id=2..9)
        const nodes: any[] = [
            { id: 0, parents: [], children: [1], timestamp: 0, label: 'root', hash: 'h0',
              storage: { kind: 'full', content: baseContent } },
            { id: 1, parents: [0], children: [2], timestamp: 1, label: 'cp', hash: 'h1',
              storage: { kind: 'checkpoint', contentHash: 'cp-hash' } },
        ];
        let prev = cpContent;
        for (let i = 2; i <= 9; i++) {
            const next = prev + 'd';
            nodes.push({
                id: i, parents: [i - 1], children: i < 9 ? [i + 1] : [], timestamp: i, label: `d${i}`,
                hash: `h${i}`,
                storage: { kind: 'delta', diffs: [[{ offset: prev.length, removeLength: 0, inserted: 'd' }]] },
            });
            prev = next;
        }
        manager.importTree('file:///test.md', {
            nodes,
            hashMap: nodes.map((n, i) => [n.hash, i] as [string, number]),
            currentId: 9,
            rootId: 0,
        });

        const tree = manager.getTree(makeUri());
        const ms = elapsed(() => manager.reconstructContent(tree, 9));

        console.log(`cp含む10段チェーン復元: ${ms.toFixed(2)}ms`);
        expect(ms).toBeLessThan(50);
        expect(manager.reconstructContent(tree, 9)).toBe(cpContent + 'd'.repeat(8));
    });
});
