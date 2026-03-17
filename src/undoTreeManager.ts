'use strict';

import * as vscode from 'vscode';
import * as crypto from 'crypto';

type Diff = {
    offset: number;
    removeLength: number;
    inserted: string;
};

type UndoNodeStorage =
    | { kind: 'full'; content: string }
    | { kind: 'delta'; diffs: Diff[][] };  // Diff[][]：外側がchangeイベント単位、内側が1イベント内の変更

export type UndoNode = {
    id: number;
    parents: number[];
    children: number[];
    timestamp: number;
    label: string;
    hash: string;
    storage: UndoNodeStorage;
};

export type UndoTree = {
    nodes: Map<number, UndoNode>;
    hashMap: Map<string, number>;
    currentId: number;
    rootId: number;
};

const AUTOSAVE_INTERVAL_MS = 30_000;
const FULL_STORAGE_THRESHOLD = 0.3; // 変更量が全文の30%超で全量保存

export class UndoTreeManager implements vscode.Disposable {
    private trees = new Map<string, UndoTree>();
    private diffBuffer = new Map<string, Diff[][]>(); // URI → 保存前の差分バッファ（イベント単位）
    private nextId = 1;
    private autosaveTimer: ReturnType<typeof setInterval> | undefined;
    private restoring = false; // 復元中はchangeEventをバッファしない
    paused = false;
    onRefresh: (() => void) | undefined;

    constructor() {
        this.autosaveTimer = setInterval(() => this.autosave(), AUTOSAVE_INTERVAL_MS);
    }

    getTree(uri: vscode.Uri, initialContent?: string): UndoTree {
        const key = uri.toString();
        if (!this.trees.has(key)) {
            const content = initialContent ?? '';
            const root: UndoNode = {
                id: 0,
                parents: [],
                children: [],
                timestamp: Date.now(),
                label: 'initial',
                hash: '',
                storage: { kind: 'full', content },
            };
            this.trees.set(key, {
                nodes: new Map([[0, root]]),
                hashMap: new Map(),
                currentId: 0,
                rootId: 0,
            });
        }
        return this.trees.get(key)!;
    }

    onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
        if (e.contentChanges.length === 0 || this.restoring || this.paused) {
            return;
        }
        const key = e.document.uri.toString();
        const buffer = this.diffBuffer.get(key) ?? [];
        // 1つのchangeイベントをグループとして保存（イベント内の変更は同一ベース状態への変更）
        const eventDiffs: Diff[] = e.contentChanges.map(c => ({
            offset: c.rangeOffset,
            removeLength: c.rangeLength,
            inserted: c.text,
        }));
        buffer.push(eventDiffs);
        this.diffBuffer.set(key, buffer);
    }

    onDidSaveTextDocument(document: vscode.TextDocument) {
        if (this.paused) {
            return;
        }
        this.addNode(document, 'save');
    }

    onDidCloseTextDocument(document: vscode.TextDocument) {
        const key = document.uri.toString();
        this.trees.delete(key);
        this.diffBuffer.delete(key);
    }

    onDidChangeActiveEditor(_editor: vscode.TextEditor | undefined) {}

    private autosave() {
        if (this.paused) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.isUntitled) {
            return;
        }
        this.addNode(editor.document, 'auto');
    }

    private addNode(document: vscode.TextDocument, label: string) {
        const content = document.getText();
        const hash = this.hashContent(content);
        const tree = this.getTree(document.uri);
        const key = document.uri.toString();
        const currentNode = tree.nodes.get(tree.currentId)!;

        // 内容に変化がなければバッファをクリアして終了
        if (currentNode.hash === hash) {
            this.diffBuffer.delete(key);
            return;
        }

        // 同じハッシュのノードが既存ならリンク（DAG収束）
        const existingId = tree.hashMap.get(hash);
        if (existingId !== undefined) {
            // existingId が currentId の先祖の場合はリンクすると循環するのでスキップ
            if (!this.isAncestor(tree, existingId, tree.currentId)) {
                const existingNode = tree.nodes.get(existingId)!;
                if (!currentNode.children.includes(existingId)) {
                    currentNode.children.push(existingId);
                    // 分岐点になったので全量に昇格
                    this.upgradeToFull(tree, tree.currentId, content);
                }
                if (!existingNode.parents.includes(tree.currentId)) {
                    existingNode.parents.push(tree.currentId);
                }
            }
            tree.currentId = existingId;
            this.diffBuffer.delete(key);
            this.onRefresh?.();
            return;
        }

        // ストレージ種別を決定
        const diffs = this.diffBuffer.get(key) ?? [];
        // 現在ノードが空ルートの場合は必ずfullで保存する
        // （途中から開いたファイルはルートのcontent=''に対してdeltaを保存すると復元が壊れる）
        const isCurrentEmptyRoot =
            currentNode.parents.length === 0 &&
            currentNode.storage.kind === 'full' &&
            currentNode.storage.content === '';
        const storage: UndoNodeStorage = (isCurrentEmptyRoot || this.shouldStoreFull(diffs, content.length))
            ? { kind: 'full', content }
            : { kind: 'delta', diffs };

        const newId = this.nextId++;
        const node: UndoNode = {
            id: newId,
            parents: [tree.currentId],
            children: [],
            timestamp: Date.now(),
            label,
            hash,
            storage,
        };
        currentNode.children.push(newId);

        // 現在ノードが分岐点になった（2つ目以降の子）→ 全量に昇格
        if (currentNode.children.length >= 2) {
            const currentContent = this.reconstructContent(tree, tree.currentId);
            this.upgradeToFull(tree, tree.currentId, currentContent);
        }

        tree.nodes.set(newId, node);
        tree.hashMap.set(hash, newId);
        tree.currentId = newId;
        this.diffBuffer.delete(key);
        this.onRefresh?.();
    }

    private isAncestor(tree: UndoTree, candidateId: number, nodeId: number): boolean {
        // candidateId が nodeId の先祖かどうかをBFSで確認（children方向に探索）
        const visited = new Set<number>();
        const queue = [candidateId];
        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current === nodeId) {
                return true;
            }
            if (visited.has(current)) {
                continue;
            }
            visited.add(current);
            const node = tree.nodes.get(current);
            if (node) {
                for (const childId of node.children) {
                    if (!visited.has(childId)) {
                        queue.push(childId);
                    }
                }
            }
        }
        return false;
    }

    private shouldStoreFull(diffs: Diff[][], contentLength: number): boolean {
        if (diffs.length === 0 || contentLength === 0) {
            return true;
        }
        const changedChars = diffs.flat().reduce((sum, d) => sum + d.removeLength + d.inserted.length, 0);
        return changedChars / contentLength > FULL_STORAGE_THRESHOLD;
    }

    private upgradeToFull(tree: UndoTree, nodeId: number, content: string) {
        const node = tree.nodes.get(nodeId);
        if (!node || node.storage.kind === 'full') {
            return;
        }
        node.storage = { kind: 'full', content };
    }

    reconstructContent(tree: UndoTree, targetId: number): string {
        // targetIdから上に遡り、最近傍の全量ノードを起点にdeltaを適用
        const path: number[] = [];
        const visited = new Set<number>();
        let id: number | undefined = targetId;

        while (id !== undefined) {
            if (visited.has(id)) {
                break;
            }
            visited.add(id);
            path.unshift(id);
            const node = tree.nodes.get(id);
            if (!node || node.storage.kind === 'full') {
                break;
            }
            id = node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }

        let content = '';
        for (const nodeId of path) {
            const node = tree.nodes.get(nodeId);
            if (!node) {
                break;
            }
            if (node.storage.kind === 'full') {
                content = node.storage.content;
            } else {
                content = this.applyDiffs(content, node.storage.diffs);
            }
        }
        return content;
    }

    private applyDiffs(content: string, diffs: Diff[][]): string {
        // イベント単位で順方向に適用する（各イベントは前のイベント適用後の状態への変更）
        // イベント内の複数変更は同一ベースへの変更なのでoffset降順で適用
        let result = content;
        for (const eventDiffs of diffs) {
            const sorted = [...eventDiffs].sort((a, b) => b.offset - a.offset);
            for (const diff of sorted) {
                result =
                    result.slice(0, diff.offset) +
                    diff.inserted +
                    result.slice(diff.offset + diff.removeLength);
            }
        }
        return result;
    }

    private hashContent(content: string): string {
        return crypto.createHash('sha1').update(content).digest('hex').slice(0, 8);
    }

    async undo() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const tree = this.getTree(editor.document.uri);
        const current = tree.nodes.get(tree.currentId);
        if (!current || current.parents.length === 0) {
            return;
        }
        const targetId = current.parents[current.parents.length - 1];
        await this.jumpToNode(targetId, editor, tree);
    }

    async redo() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const tree = this.getTree(editor.document.uri);
        const current = tree.nodes.get(tree.currentId);
        if (!current || current.children.length === 0) {
            return;
        }
        const targetId = current.children[current.children.length - 1];
        await this.jumpToNode(targetId, editor, tree);
    }

    async jumpToNode(
        nodeId: number,
        editor: vscode.TextEditor,
        tree?: UndoTree
    ) {
        const t = tree ?? this.getTree(editor.document.uri);
        const node = t.nodes.get(nodeId);
        if (!node) {
            return;
        }
        const content = this.reconstructContent(t, nodeId);

        this.restoring = true;
        try {
            await editor.edit((eb) => {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length)
                );
                eb.replace(fullRange, content);
            });
        } finally {
            this.restoring = false;
        }

        // 復元後のdiffBufferをクリア（復元による変更を差分として扱わない）
        this.diffBuffer.delete(editor.document.uri.toString());
        t.currentId = nodeId;
        this.onRefresh?.();
    }

    compact(tree: UndoTree): number {
        let removed = 0;
        let changed = true;
        while (changed) {
            changed = false;
            for (const [, node] of tree.nodes) {
                if (this.isCompressible(tree, node)) {
                    this.removeNode(tree, node);
                    removed++;
                    changed = true;
                    break;
                }
            }
        }
        return removed;
    }

    private classifyNode(node: UndoNode): 'insert' | 'delete' | 'mixed' {
        if (node.storage.kind === 'full') {
            return 'mixed';
        }
        const allDiffs = node.storage.diffs.flat();
        const hasInsert = allDiffs.some(d => d.inserted.length > 0);
        const hasDelete = allDiffs.some(d => d.removeLength > 0);
        if (hasInsert && hasDelete) {
            return 'mixed';
        }
        if (hasInsert) {
            return 'insert';
        }
        return 'delete';
    }

    private isCompressible(tree: UndoTree, node: UndoNode): boolean {
        if (node.id === tree.currentId) { return false; }
        if (node.parents.length !== 1) { return false; }   // root or multi-parent
        if (node.children.length !== 1) { return false; }  // branch, leaf, or orphan
        const kind = this.classifyNode(node);
        if (kind === 'mixed') { return false; }
        const parent = tree.nodes.get(node.parents[0]);
        const child = tree.nodes.get(node.children[0]);
        if (!parent || !child) { return false; }
        return this.classifyNode(parent) === kind && this.classifyNode(child) === kind;
    }

    private removeNode(tree: UndoTree, node: UndoNode): void {
        const parentId = node.parents[0];
        const childId = node.children[0];
        const parent = tree.nodes.get(parentId)!;
        const child = tree.nodes.get(childId)!;

        // 同種deltaならdiffをマージしてdelta型を維持する（連続圧縮のため）
        // それ以外はchildを全量化してdeltaチェーンの依存を断ち切る
        if (node.storage.kind === 'delta' && child.storage.kind === 'delta') {
            child.storage = { kind: 'delta', diffs: [...node.storage.diffs, ...child.storage.diffs] };
        } else if (child.storage.kind === 'delta') {
            const content = this.reconstructContent(tree, childId);
            child.storage = { kind: 'full', content };
        }

        parent.children = parent.children.map(id => id === node.id ? childId : id);
        child.parents = child.parents.map(id => id === node.id ? parentId : id);

        tree.nodes.delete(node.id);
        if (tree.hashMap.get(node.hash) === node.id) {
            tree.hashMap.delete(node.hash);
        }
    }

    dispose() {
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
        }
        this.trees.clear();
        this.diffBuffer.clear();
    }
}
