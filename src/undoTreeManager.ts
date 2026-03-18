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
    | { kind: 'delta'; diffs: Diff[][] }
    | { kind: 'checkpoint'; contentHash: string };

export type UndoNode = {
    id: number;
    parents: number[];
    children: number[];
    timestamp: number;
    label: string;
    hash: string;
    storage: UndoNodeStorage;
    note?: string;
    lineCount?: number;
    byteCount?: number;
};

export type UndoTree = {
    nodes: Map<number, UndoNode>;
    hashMap: Map<string, number>;
    currentId: number;
    rootId: number;
};

export type SerializedUndoNode = {
    id: number;
    parents: number[];
    children: number[];
    timestamp: number;
    label: string;
    hash: string;
    storage: UndoNodeStorage;
    note?: string;
    lineCount?: number;
    byteCount?: number;
};

export type SerializedUndoTree = {
    nodes: SerializedUndoNode[];
    hashMap: Array<[string, number]>;
    currentId: number;
    rootId: number;
};

export type SerializedUndoTreeState = {
    nextId: number;
    trees: Record<string, SerializedUndoTree>;
};

const DEFAULT_AUTOSAVE_INTERVAL_MS = 30_000;
const FULL_STORAGE_THRESHOLD = 0.3;

export class UndoTreeManager implements vscode.Disposable {
    private trees = new Map<string, UndoTree>();
    private diffBuffer = new Map<string, Diff[][]>();
    private nextId = 1;
    private autosaveTimer: ReturnType<typeof setInterval> | undefined;
    private autosaveIntervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS;
    private restoring = false;
    private contentCache = new Map<string, string>();
    private contentCacheBytes = 0;
    private contentCacheMaxBytes = 2048 * 1024;
    private emptyHash: string | undefined;
    contentResolver: ((hash: string) => string) | undefined;
    paused = false;
    onRefresh: (() => void) | undefined;

    constructor() {
        this.autosaveTimer = setInterval(() => this.autosave(), this.autosaveIntervalMs);
    }

    setContentCacheMax(maxBytes: number) {
        this.contentCacheMaxBytes = maxBytes;
        this.evictCache(0);
    }

    private getEmptyHash(): string {
        return this.emptyHash ??= this.hashContent('');
    }

    private getOrLoadContent(contentHash: string): string {
        const cached = this.contentCache.get(contentHash);
        if (cached !== undefined) {
            // LRU: move to end
            this.contentCache.delete(contentHash);
            this.contentCache.set(contentHash, cached);
            return cached;
        }
        const content = this.contentResolver?.(contentHash) ?? '';
        this.setCachedContent(contentHash, content);
        return content;
    }

    private setCachedContent(hash: string, content: string) {
        const bytes = Buffer.byteLength(content, 'utf8');
        this.evictCache(bytes);
        this.contentCache.set(hash, content);
        this.contentCacheBytes += bytes;
    }

    private evictCache(incoming: number) {
        while (this.contentCacheBytes + incoming > this.contentCacheMaxBytes && this.contentCache.size > 0) {
            const oldest = this.contentCache.keys().next().value!;
            this.contentCacheBytes -= Buffer.byteLength(this.contentCache.get(oldest)!, 'utf8');
            this.contentCache.delete(oldest);
        }
    }

    setAutosaveInterval(ms: number) {
        if (ms === this.autosaveIntervalMs) {
            return;
        }
        this.autosaveIntervalMs = ms;
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
            this.autosaveTimer = undefined;
        }
        // 0 = 無効
        if (ms > 0) {
            this.autosaveTimer = setInterval(() => this.autosave(), this.autosaveIntervalMs);
        }
    }

    getTree(uri: vscode.Uri, initialContent?: string): UndoTree {
        const key = uri.toString();
        if (!this.trees.has(key)) {
            const content = initialContent ?? '';
            const contentHash = this.hashContent(content);
            const root: UndoNode = {
                id: 0,
                parents: [],
                children: [],
                timestamp: Date.now(),
                label: 'initial',
                hash: contentHash,
                storage: { kind: 'full', content },
                ...this.computeSizeMetrics(content),
            };
            const hashMap = new Map<string, number>();
            hashMap.set(contentHash, 0);
            this.trees.set(key, {
                nodes: new Map([[0, root]]),
                hashMap,
                currentId: 0,
                rootId: 0,
            });
        } else if (initialContent !== undefined && initialContent !== '') {
            const tree = this.trees.get(key)!;
            const root = tree.nodes.get(tree.rootId);
            if (root && root.storage.kind === 'full' && root.storage.content === '' && root.children.length === 0) {
                tree.hashMap.delete(root.hash);
                root.storage.content = initialContent;
                root.hash = this.hashContent(initialContent);
                tree.hashMap.set(root.hash, 0);
                Object.assign(root, this.computeSizeMetrics(initialContent));
            }
        }
        return this.trees.get(key)!;
    }

    hasTree(uri: vscode.Uri): boolean {
        return this.trees.has(uri.toString());
    }

    onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
        if (e.contentChanges.length === 0 || this.restoring || this.paused) {
            return;
        }
        const key = e.document.uri.toString();
        const buffer = this.diffBuffer.get(key) ?? [];
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

        if (currentNode.hash === hash) {
            this.diffBuffer.delete(key);
            return;
        }

        // DAG収束: 既存ノードと同一ハッシュなら新ノードを作らずそこへ移動
        const existingId = tree.hashMap.get(hash);
        if (existingId !== undefined && tree.nodes.has(existingId)) {
            tree.currentId = existingId;
            this.diffBuffer.delete(key);
            this.onRefresh?.();
            return;
        }

        const diffs = this.diffBuffer.get(key) ?? [];
        const isCurrentEmptyRoot =
            currentNode.parents.length === 0 &&
            currentNode.storage.kind === 'full' &&
            currentNode.storage.content === '';

        if (isCurrentEmptyRoot) {
            tree.hashMap.delete(currentNode.hash);
            currentNode.storage = { kind: 'full', content };
            currentNode.hash = hash;
            tree.hashMap.set(hash, 0);
            Object.assign(currentNode, this.computeSizeMetrics(content));
        }

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
            ...this.computeSizeMetrics(content),
        };
        currentNode.children.push(newId);

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
            if (!node) {
                continue;
            }
            for (const childId of node.children) {
                if (!visited.has(childId)) {
                    queue.push(childId);
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
        if (!node || node.storage.kind === 'full' || node.storage.kind === 'checkpoint') {
            return;
        }
        node.storage = { kind: 'full', content };
    }

    reconstructContent(tree: UndoTree, targetId: number): string {
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
            } else if (node.storage.kind === 'checkpoint') {
                content = this.getOrLoadContent(node.storage.contentHash);
            } else {
                content = this.applyDiffs(content, node.storage.diffs);
            }
        }
        return content;
    }

    private applyDiffs(content: string, diffs: Diff[][]): string {
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

    private computeSizeMetrics(content: string): { lineCount: number; byteCount: number } {
        return {
            lineCount: content === '' ? 0 : content.split('\n').length,
            byteCount: Buffer.byteLength(content, 'utf8'),
        };
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
        const previousCurrentId = t.currentId;

        // Move the logical cursor before mutating the editor so any immediate
        // save/autosave is recorded as a branch from the selected node.
        t.currentId = nodeId;

        this.restoring = true;
        try {
            await editor.edit((eb) => {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length)
                );
                eb.replace(fullRange, content);
            });
        } catch (error) {
            t.currentId = previousCurrentId;
            throw error;
        } finally {
            this.restoring = false;
        }

        this.diffBuffer.delete(editor.document.uri.toString());
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

    exportState(): SerializedUndoTreeState {
        const trees: Record<string, SerializedUndoTree> = {};
        for (const [key, tree] of this.trees) {
            trees[key] = {
                nodes: Array.from(tree.nodes.values()).map((node) => ({
                    id: node.id,
                    parents: [...node.parents],
                    children: [...node.children],
                    timestamp: node.timestamp,
                    label: node.label,
                    hash: node.hash,
                    storage: node.storage.kind === 'full'
                        ? { kind: 'full', content: node.storage.content }
                        : node.storage.kind === 'checkpoint'
                        ? { kind: 'checkpoint', contentHash: node.storage.contentHash }
                        : {
                            kind: 'delta',
                            diffs: node.storage.diffs.map((eventDiffs: Diff[]) =>
                                eventDiffs.map((diff: Diff) => ({ ...diff }))
                            ),
                        },
                    ...(node.note !== undefined ? { note: node.note } : {}),
                    ...(node.lineCount !== undefined ? { lineCount: node.lineCount } : {}),
                    ...(node.byteCount !== undefined ? { byteCount: node.byteCount } : {}),
                })),
                hashMap: Array.from(tree.hashMap.entries()),
                currentId: tree.currentId,
                rootId: tree.rootId,
            };
        }
        return {
            nextId: this.nextId,
            trees,
        };
    }

    importState(state: SerializedUndoTreeState) {
        this.trees.clear();
        this.diffBuffer.clear();

        for (const [key, tree] of Object.entries(state.trees)) {
            this.trees.set(key, {
                nodes: new Map(tree.nodes.map((node) => [node.id, {
                    id: node.id,
                    parents: [...node.parents],
                    children: [...node.children],
                    timestamp: node.timestamp,
                    label: node.label,
                    hash: node.hash,
                    storage: node.storage.kind === 'full'
                        ? { kind: 'full', content: node.storage.content }
                        : node.storage.kind === 'checkpoint'
                        ? { kind: 'checkpoint', contentHash: node.storage.contentHash }
                        : {
                            kind: 'delta',
                            diffs: node.storage.diffs.map((eventDiffs: Diff[]) =>
                                eventDiffs.map((diff: Diff) => ({ ...diff }))
                            ),
                        },
                    ...(node.note !== undefined ? { note: node.note } : {}),
                    ...(node.lineCount !== undefined ? { lineCount: node.lineCount } : {}),
                    ...(node.byteCount !== undefined ? { byteCount: node.byteCount } : {}),
                }])),
                hashMap: new Map(tree.hashMap),
                currentId: tree.currentId,
                rootId: tree.rootId,
            });
        }

        this.nextId = Math.max(
            state.nextId,
            ...Array.from(this.trees.values()).flatMap((tree) => Array.from(tree.nodes.keys()).map((id) => id + 1)),
            1
        );
        this.onRefresh?.();
    }

    importTree(uri: string, tree: SerializedUndoTree, nextId?: number) {
        this.trees.set(uri, {
            nodes: new Map(tree.nodes.map((node) => [node.id, {
                id: node.id,
                parents: [...node.parents],
                children: [...node.children],
                timestamp: node.timestamp,
                label: node.label,
                hash: node.hash,
                storage: node.storage.kind === 'full'
                    ? { kind: 'full', content: node.storage.content }
                    : node.storage.kind === 'checkpoint'
                    ? { kind: 'checkpoint', contentHash: node.storage.contentHash }
                    : {
                        kind: 'delta',
                        diffs: node.storage.diffs.map((eventDiffs: Diff[]) =>
                            eventDiffs.map((diff: Diff) => ({ ...diff }))
                        ),
                    },
                ...(node.note !== undefined ? { note: node.note } : {}),
                ...(node.lineCount !== undefined ? { lineCount: node.lineCount } : {}),
                ...(node.byteCount !== undefined ? { byteCount: node.byteCount } : {}),
            }])),
            hashMap: new Map(tree.hashMap),
            currentId: tree.currentId,
            rootId: tree.rootId,
        });

        if (typeof nextId === 'number') {
            this.nextId = Math.max(this.nextId, nextId);
        } else {
            this.nextId = Math.max(
                this.nextId,
                ...Array.from(this.trees.values()).flatMap((value) => Array.from(value.nodes.keys()).map((id) => id + 1))
            );
        }
        this.onRefresh?.();
    }

    isNodeEmpty(tree: UndoTree, nodeId: number): boolean {
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return false;
        }
        return node.hash === this.getEmptyHash();
    }

    setNote(uri: vscode.Uri, nodeId: number, note: string): void {
        const tree = this.trees.get(uri.toString());
        if (!tree) {
            return;
        }
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        const trimmed = note.trim();
        node.note = trimmed || undefined;
        this.onRefresh?.();
    }

    reconcileCurrentNode(uri: vscode.Uri, content: string): void {
        const tree = this.trees.get(uri.toString());
        if (!tree) {
            return;
        }
        const hash = this.hashContent(content);
        const matchedId = tree.hashMap.get(hash);
        if (matchedId !== undefined && tree.nodes.has(matchedId)) {
            tree.currentId = matchedId;
        } else {
            tree.currentId = tree.rootId;
        }
    }

    syncDocumentState(uri: vscode.Uri, content: string, label = 'restore'): UndoTree {
        const tree = this.getTree(uri, content);
        const currentContent = this.reconstructContent(tree, tree.currentId);
        if (currentContent === content) {
            return tree;
        }

        const key = uri.toString();
        const currentNode = tree.nodes.get(tree.currentId)!;
        const newId = this.nextId++;
        const node: UndoNode = {
            id: newId,
            parents: [tree.currentId],
            children: [],
            timestamp: Date.now(),
            label,
            hash: this.hashContent(content),
            storage: { kind: 'full', content },
            ...this.computeSizeMetrics(content),
        };

        currentNode.children.push(newId);
        if (currentNode.children.length >= 2) {
            this.upgradeToFull(tree, tree.currentId, currentContent);
        }

        tree.nodes.set(newId, node);
        tree.hashMap.set(node.hash, newId);
        tree.currentId = newId;
        this.diffBuffer.delete(key);
        this.onRefresh?.();
        return tree;
    }

    private classifyNode(node: UndoNode): 'insert' | 'delete' | 'mixed' {
        if (node.storage.kind === 'full' || node.storage.kind === 'checkpoint') {
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
        if (node.note) { return false; }
        if (node.parents.length !== 1) { return false; }
        if (node.children.length !== 1) { return false; }
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

    hardCompact(tree: UndoTree, maxAgeDays: number): number {
        const thresholdMs = maxAgeDays * 86_400_000;
        const now = Date.now();

        // Step 1: current の祖先を保護対象に
        const currentAncestors = new Set<number>();
        let id: number | undefined = tree.currentId;
        while (id !== undefined) {
            currentAncestors.add(id);
            const node = tree.nodes.get(id);
            id = node && node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }

        // Step 2: noted ノードの祖先を保護対象に（noted が孤立しないよう）
        const hasNotedAncestor = new Set<number>();
        for (const [nodeId, node] of tree.nodes) {
            if (!node.note) { continue; }
            let aid: number | undefined = nodeId;
            while (aid !== undefined) {
                if (hasNotedAncestor.has(aid)) { break; }
                hasNotedAncestor.add(aid);
                const anode = tree.nodes.get(aid);
                aid = anode && anode.parents.length > 0 ? anode.parents[anode.parents.length - 1] : undefined;
            }
        }

        // Step 3: 削除対象サブツリーを収集（DFS）
        const toDelete = new Set<number>();

        const markSubtree = (nodeId: number) => {
            const node = tree.nodes.get(nodeId);
            if (!node) { return; }
            toDelete.add(nodeId);
            for (const childId of node.children) {
                markSubtree(childId);
            }
        };

        const dfs = (nodeId: number) => {
            const node = tree.nodes.get(nodeId);
            if (!node) { return; }

            if (currentAncestors.has(nodeId)) {
                // current の祖先: 削除しないが子を辿る
                for (const childId of node.children) {
                    dfs(childId);
                }
                return;
            }

            const isExpired = (now - node.timestamp) > thresholdMs;
            const isProtected = node.note || hasNotedAncestor.has(nodeId);

            if (isExpired && !isProtected) {
                markSubtree(nodeId);
            } else {
                for (const childId of node.children) {
                    dfs(childId);
                }
            }
        };

        dfs(tree.rootId);

        // Step 4: 削除実行
        for (const nodeId of toDelete) {
            const node = tree.nodes.get(nodeId);
            if (!node) { continue; }
            for (const parentId of node.parents) {
                const parent = tree.nodes.get(parentId);
                if (parent) {
                    parent.children = parent.children.filter(id => id !== nodeId);
                }
            }
            tree.nodes.delete(nodeId);
            if (tree.hashMap.get(node.hash) === nodeId) {
                tree.hashMap.delete(node.hash);
            }
        }

        if (toDelete.size > 0) {
            this.onRefresh?.();
        }
        return toDelete.size;
    }

    dispose() {
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
        }
        this.trees.clear();
        this.diffBuffer.clear();
        this.contentCache.clear();
        this.contentCacheBytes = 0;
    }
}
