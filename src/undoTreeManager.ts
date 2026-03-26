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
    pinned?: boolean;
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
    pinned?: boolean;
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

function uniqueIds(values: number[]): number[] {
    return Array.from(new Set(values));
}

function rebuildSerializedHashMap(tree: SerializedUndoTree): Array<[string, number]> {
    const byHash = new Map<string, { id: number; timestamp: number }>();
    for (const node of tree.nodes) {
        const current = byHash.get(node.hash);
        if (!current || node.timestamp >= current.timestamp) {
            byHash.set(node.hash, { id: node.id, timestamp: node.timestamp });
        }
    }
    return Array.from(byHash.entries()).map(([hash, entry]) => [hash, entry.id]);
}

export function mergeSerializedTrees(
    base: SerializedUndoTree | undefined,
    incoming: SerializedUndoTree,
    nextIdHint = 1
): { tree: SerializedUndoTree; nextId: number } {
    if (!base) {
        return {
            tree: {
                nodes: incoming.nodes.map((node) => ({
                    ...node,
                    parents: [...node.parents],
                    children: [...node.children],
                })),
                hashMap: [...incoming.hashMap],
                currentId: incoming.currentId,
                rootId: incoming.rootId,
            },
            nextId: Math.max(nextIdHint, ...incoming.nodes.map((node) => node.id + 1), 1),
        };
    }

    const mergedNodes = new Map<number, SerializedUndoNode>(
        base.nodes.map((node) => [
            node.id,
            {
                ...node,
                parents: [...node.parents],
                children: [...node.children],
            },
        ])
    );
    const idRemap = new Map<number, number>();
    let nextId = Math.max(
        nextIdHint,
        ...Array.from(mergedNodes.keys()).map((id) => id + 1),
        ...incoming.nodes.map((node) => node.id + 1),
        1
    );

    for (const node of incoming.nodes) {
        const existing = mergedNodes.get(node.id);
        if (!existing) {
            mergedNodes.set(node.id, {
                ...node,
                parents: [...node.parents],
                children: [...node.children],
            });
            idRemap.set(node.id, node.id);
            continue;
        }

        if (existing.hash === node.hash) {
            idRemap.set(node.id, node.id);
            existing.timestamp = Math.max(existing.timestamp, node.timestamp);
            existing.label = node.label;
            existing.storage = node.storage;
            existing.lineCount = node.lineCount ?? existing.lineCount;
            existing.byteCount = node.byteCount ?? existing.byteCount;
            existing.note = node.note ?? existing.note;
            existing.pinned = node.pinned ?? existing.pinned;
            existing.parents = uniqueIds([...existing.parents, ...node.parents]);
            existing.children = uniqueIds([...existing.children, ...node.children]);
            continue;
        }

        const remappedId = nextId++;
        idRemap.set(node.id, remappedId);
        mergedNodes.set(remappedId, {
            ...node,
            id: remappedId,
            parents: [...node.parents],
            children: [...node.children],
        });
    }

    for (const node of incoming.nodes) {
        const mergedId = idRemap.get(node.id)!;
        const mergedNode = mergedNodes.get(mergedId)!;
        const remappedParents = uniqueIds(
            node.parents
                .map((parentId) => idRemap.get(parentId) ?? parentId)
                .filter((parentId) => mergedNodes.has(parentId))
        );
        const remappedChildren = uniqueIds(
            node.children
                .map((childId) => idRemap.get(childId) ?? childId)
                .filter((childId) => mergedNodes.has(childId))
        );
        mergedNode.parents = uniqueIds([...mergedNode.parents, ...remappedParents]);
        mergedNode.children = uniqueIds([...mergedNode.children, ...remappedChildren]);
    }

    const rootId = mergedNodes.has(base.rootId) ? base.rootId : (idRemap.get(incoming.rootId) ?? incoming.rootId);
    for (const node of mergedNodes.values()) {
        if (node.id === rootId) {
            node.parents = [];
            continue;
        }
        if (node.parents.length === 0) {
            node.parents = [rootId];
        }
    }

    for (const node of mergedNodes.values()) {
        node.children = [];
    }
    for (const node of mergedNodes.values()) {
        for (const parentId of node.parents) {
            const parent = mergedNodes.get(parentId);
            if (parent && !parent.children.includes(node.id)) {
                parent.children.push(node.id);
            }
        }
    }

    const currentId = idRemap.get(incoming.currentId) ?? incoming.currentId;
    const mergedTree: SerializedUndoTree = {
        nodes: Array.from(mergedNodes.values()).sort((a, b) => a.id - b.id),
        hashMap: [],
        currentId: mergedNodes.has(currentId) ? currentId : rootId,
        rootId,
    };
    mergedTree.hashMap = rebuildSerializedHashMap(mergedTree);

    return { tree: mergedTree, nextId };
}

export type CompactPreviewItem = {
    id: number;
    label: string;
    timestamp: number;
    note?: string;
    pinned?: boolean;
    reason: string;
    storageKind: UndoNodeStorage['kind'];
    status?: 'remove' | 'keep';
    parents: number[];
    children: number[];
    lineCount?: number;
    byteCount?: number;
    manualRemoveAllowed: boolean;
    manualRemoveReason?: string;
};

export type CompactPreviewResult = {
    removable: CompactPreviewItem[];
    protected: CompactPreviewItem[];
    all: CompactPreviewItem[];
};

export type CompactApplyResult = {
    removed: number;
    skipped: number;
};

const DEFAULT_AUTOSAVE_INTERVAL_MS = 30_000;
const FULL_STORAGE_THRESHOLD = 0.3;

export class UndoTreeManager implements vscode.Disposable {
    private trees = new Map<string, UndoTree>();
    private diffBuffer = new Map<string, Diff[][]>();
    private dirtyTrees = new Set<string>();
    private lastAccessAt = new Map<string, number>();
    private jumpSuppressedHashes = new Map<string, string>();
    private nextId = 1;
    private autosaveTimer: ReturnType<typeof setInterval> | undefined;
    private autosaveIntervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS;
    private restoring = false;
    private contentCache = new Map<string, string>();
    private contentCacheBytes = 0;
    private contentCacheMaxBytes = 20480 * 1024;
    private memoryCheckpointThresholdBytes = 32 * 1024;
    private emptyHash: string | undefined;
    contentResolver: ((hash: string) => string) | undefined;
    asyncContentResolver: ((hash: string) => Promise<string>) | undefined;
    paused = false;
    onRefresh: (() => void) | undefined;
    debugLog: ((msg: string) => void) | undefined;
    onCheckpointLoadStart: (() => void) | undefined;
    isTracked: ((uri: vscode.Uri) => boolean) | undefined;

    constructor() {
        this.autosaveTimer = setInterval(() => this.autosave(), this.autosaveIntervalMs);
    }

    setContentCacheMax(maxBytes: number) {
        this.contentCacheMaxBytes = maxBytes;
        this.evictCache(0);
    }

    setMemoryCheckpointThreshold(maxBytes: number) {
        this.memoryCheckpointThresholdBytes = maxBytes;
    }

    private getEmptyHash(): string {
        return this.emptyHash ??= this.hashContent('');
    }

    private getOrLoadContent(contentHash: string): string {
        const cached = this.contentCache.get(contentHash);
        if (cached !== undefined) {
            this.contentCache.delete(contentHash);
            this.contentCache.set(contentHash, cached);
            return cached;
        }
        if (!this.contentResolver) {
            throw new Error(`Missing checkpoint content resolver for hash ${contentHash}`);
        }
        const content = this.contentResolver(contentHash);
        this.setCachedContent(contentHash, content);
        return content;
    }

    private async getOrLoadContentAsync(contentHash: string): Promise<string> {
        const cached = this.contentCache.get(contentHash);
        if (cached !== undefined) {
            this.debugLog?.(`[checkpoint] cache HIT hash=${contentHash}`);
            this.contentCache.delete(contentHash);
            this.contentCache.set(contentHash, cached);
            return cached;
        }
        this.debugLog?.(`[checkpoint] cache MISS hash=${contentHash} cacheBytes=${Math.round(this.contentCacheBytes/1024)}KB maxBytes=${Math.round(this.contentCacheMaxBytes/1024)}KB`);
        this.onCheckpointLoadStart?.();
        let content: string;
        if (this.asyncContentResolver) {
            content = await this.asyncContentResolver(contentHash);
        } else {
            if (!this.contentResolver) {
                throw new Error(`Missing checkpoint content resolver for hash ${contentHash}`);
            }
            content = this.contentResolver(contentHash);
        }
        this.setCachedContent(contentHash, content);
        return content;
    }

    async reconstructContentAsync(tree: UndoTree, targetId: number): Promise<string> {
        const path: number[] = [];
        const visited = new Set<number>();
        let id: number | undefined = targetId;

        while (id !== undefined) {
            if (visited.has(id)) { break; }
            visited.add(id);
            path.unshift(id);
            const node = tree.nodes.get(id);
            if (!node || node.storage.kind === 'full') { break; }
            id = node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }

        let content = '';
        for (const nodeId of path) {
            const node = tree.nodes.get(nodeId);
            if (!node) { break; }
            if (node.storage.kind === 'full') {
                content = node.storage.content;
            } else if (node.storage.kind === 'checkpoint') {
                content = await this.getOrLoadContentAsync(node.storage.contentHash);
            } else {
                content = this.applyDiffs(content, node.storage.diffs);
            }
        }
        return content;
    }

    private setCachedContent(hash: string, content: string) {
        const existing = this.contentCache.get(hash);
        if (existing !== undefined) {
            this.contentCache.delete(hash);
            this.contentCacheBytes = Math.max(0, this.contentCacheBytes - Buffer.byteLength(existing, 'utf8'));
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        this.evictCache(bytes);
        this.contentCache.set(hash, content);
        this.contentCacheBytes += bytes;
    }

    getCheckpointContent(hash: string): string {
        return this.getOrLoadContent(hash);
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
        this.lastAccessAt.set(key, Date.now());
        return this.trees.get(key)!;
    }

    hasTree(uri: vscode.Uri): boolean {
        return this.trees.has(uri.toString());
    }

    markDirty(uri: vscode.Uri): void {
        this.dirtyTrees.add(uri.toString());
    }

    getDirtyUris(): Set<string> {
        return new Set(this.dirtyTrees);
    }

    clearDirty(uris: Iterable<string>): void {
        for (const u of uris) {
            this.dirtyTrees.delete(u);
        }
    }

    getResidentUris(): string[] {
        return Array.from(this.trees.keys());
    }

    getLastAccessAt(uri: vscode.Uri): number | undefined {
        return this.lastAccessAt.get(uri.toString());
    }

    hasPendingDiffs(uri: vscode.Uri): boolean {
        const diffs = this.diffBuffer.get(uri.toString());
        return !!diffs && diffs.length > 0;
    }

    resetAll(): void {
        this.trees.clear();
        this.diffBuffer.clear();
        this.dirtyTrees.clear();
        this.lastAccessAt.clear();
        this.jumpSuppressedHashes.clear();
        this.contentCache.clear();
        this.contentCacheBytes = 0;
        this.nextId = 1;
        this.onRefresh?.();
    }

    unloadTree(uri: vscode.Uri): void {
        const key = uri.toString();
        this.trees.delete(key);
        this.diffBuffer.delete(key);
        this.dirtyTrees.delete(key);
        this.lastAccessAt.delete(key);
        this.jumpSuppressedHashes.delete(key);
        this.onRefresh?.();
    }

    renameTree(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        const oldKey = oldUri.toString();
        const newKey = newUri.toString();
        if (oldKey === newKey) {
            return;
        }

        const tree = this.trees.get(oldKey);
        if (tree) {
            this.trees.set(newKey, tree);
            this.trees.delete(oldKey);
        }

        const diffBuffer = this.diffBuffer.get(oldKey);
        if (diffBuffer) {
            this.diffBuffer.set(newKey, diffBuffer);
            this.diffBuffer.delete(oldKey);
        }

        if (this.dirtyTrees.has(oldKey)) {
            this.dirtyTrees.delete(oldKey);
            this.dirtyTrees.add(newKey);
        }

        const lastAccessAt = this.lastAccessAt.get(oldKey);
        if (lastAccessAt !== undefined) {
            this.lastAccessAt.set(newKey, lastAccessAt);
            this.lastAccessAt.delete(oldKey);
        }

        const suppressedHash = this.jumpSuppressedHashes.get(oldKey);
        if (suppressedHash !== undefined) {
            this.jumpSuppressedHashes.set(newKey, suppressedHash);
            this.jumpSuppressedHashes.delete(oldKey);
        }

        this.onRefresh?.();
    }

    onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
        if (e.contentChanges.length === 0 || this.restoring || this.paused) {
            return;
        }
        const key = e.document.uri.toString();
        this.jumpSuppressedHashes.delete(key);
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
        this.jumpSuppressedHashes.delete(key);
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
        if (this.isTracked && !this.isTracked(editor.document.uri)) {
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
        const suppressedHash = this.jumpSuppressedHashes.get(key);

        if (suppressedHash === hash && (this.diffBuffer.get(key)?.length ?? 0) === 0) {
            return;
        }
        if (suppressedHash && suppressedHash !== hash) {
            this.jumpSuppressedHashes.delete(key);
        }

        if (currentNode.hash === hash) {
            this.diffBuffer.delete(key);
            this.jumpSuppressedHashes.delete(key);
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
        tree.nodes.set(newId, node);
        tree.hashMap.set(hash, newId);
        tree.currentId = newId;

        if (currentNode.children.length >= 2) {
            const currentContent = this.reconstructContent(tree, currentNode.id);
            this.upgradeStorage(tree, currentNode.id, currentContent);
        }

        this.diffBuffer.delete(key);
        this.dirtyTrees.add(key);
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

    private shouldUseCheckpointForMemory(content: string, nodeId: number, tree: UndoTree): boolean {
        if (this.memoryCheckpointThresholdBytes <= 0) {
            return false;
        }
        if (nodeId === tree.rootId || nodeId === tree.currentId) {
            return false;
        }
        return Buffer.byteLength(content, 'utf8') >= this.memoryCheckpointThresholdBytes;
    }

    private upgradeStorage(tree: UndoTree, nodeId: number, content: string) {
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        if (this.shouldUseCheckpointForMemory(content, nodeId, tree)) {
            this.setCachedContent(node.hash, content);
            node.storage = { kind: 'checkpoint', contentHash: node.hash };
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
        this.debugLog?.(`[jumpToNode] nodeId=${nodeId} storage=${node.storage.kind}`);
        const content = await this.reconstructContentAsync(t, nodeId);
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

        const uriStr = editor.document.uri.toString();
        this.diffBuffer.delete(uriStr);
        this.jumpSuppressedHashes.set(uriStr, node.hash);
        this.dirtyTrees.add(uriStr);
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

    compactWithOverrides(tree: UndoTree, overrides: Map<number, 'remove' | 'keep'>): CompactApplyResult {
        let removed = 0;
        let changed = true;
        while (changed) {
            changed = false;
            for (const [, node] of tree.nodes) {
                if (overrides.get(node.id) === 'keep') {
                    continue;
                }
                if (overrides.get(node.id) === 'remove' && this.canManuallyRemove(tree, node)) {
                    this.removeNode(tree, node);
                    removed++;
                    changed = true;
                    break;
                }
                if (overrides.get(node.id) !== 'remove' && this.isCompressible(tree, node)) {
                    this.removeNode(tree, node);
                    removed++;
                    changed = true;
                    break;
                }
            }
        }
        const skipped = Array.from(overrides.entries()).filter(([id, action]) =>
            action === 'remove' && tree.nodes.has(id) && !this.canManuallyRemove(tree, tree.nodes.get(id)!)
        ).length;
        return { removed, skipped };
    }

    previewCompact(tree: UndoTree): number {
        return this.compact(this.cloneTree(tree));
    }

    previewCompactDetailed(tree: UndoTree): CompactPreviewResult {
        const removable: CompactPreviewItem[] = [];
        const protectedItems: CompactPreviewItem[] = [];

        for (const [, node] of tree.nodes) {
            if (node.id === tree.rootId) {
                protectedItems.push(this.toCompactPreviewItem(tree, node, 'root node'));
                continue;
            }
            const reason = this.getCompactBlockReason(tree, node);
            if (reason === undefined) {
                removable.push(this.toCompactPreviewItem(tree, node, 'compressible chain'));
            } else {
                protectedItems.push(this.toCompactPreviewItem(tree, node, reason));
            }
        }

        removable.sort((a, b) => a.timestamp - b.timestamp);
        protectedItems.sort((a, b) => a.timestamp - b.timestamp);
        return {
            removable,
            protected: protectedItems,
            all: [...removable.map((item) => ({ ...item, status: 'remove' as const })), ...protectedItems.map((item) => ({ ...item, status: 'keep' as const }))].sort((a, b) => a.timestamp - b.timestamp),
        };
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
                    ...(node.pinned !== undefined ? { pinned: node.pinned } : {}),
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

    private isValidDiff(value: unknown): value is Diff {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const diff = value as Partial<Diff>;
        return typeof diff.offset === 'number'
            && Number.isFinite(diff.offset)
            && diff.offset >= 0
            && typeof diff.removeLength === 'number'
            && Number.isFinite(diff.removeLength)
            && diff.removeLength >= 0
            && typeof diff.inserted === 'string';
    }

    private cloneValidatedStorage(storage: unknown): UndoNodeStorage {
        if (!storage || typeof storage !== 'object') {
            throw new Error('Invalid node storage');
        }
        const candidate = storage as Partial<UndoNodeStorage>;
        if (candidate.kind === 'full') {
            if (typeof candidate.content !== 'string') {
                throw new Error('Invalid full node content');
            }
            return { kind: 'full', content: candidate.content };
        }
        if (candidate.kind === 'checkpoint') {
            if (typeof candidate.contentHash !== 'string' || candidate.contentHash.length === 0) {
                throw new Error('Invalid checkpoint content hash');
            }
            return { kind: 'checkpoint', contentHash: candidate.contentHash };
        }
        if (candidate.kind === 'delta') {
            if (!Array.isArray(candidate.diffs) || !candidate.diffs.every((eventDiffs) =>
                Array.isArray(eventDiffs) && eventDiffs.every((diff) => this.isValidDiff(diff))
            )) {
                throw new Error('Invalid delta node diffs');
            }
            return {
                kind: 'delta',
                diffs: candidate.diffs.map((eventDiffs) =>
                    eventDiffs.map((diff) => ({ ...diff }))
                ),
            };
        }
        throw new Error('Unknown node storage kind');
    }

    private deserializeNode(node: unknown): UndoNode {
        if (!node || typeof node !== 'object') {
            throw new Error('Invalid undo node');
        }
        const candidate = node as Partial<SerializedUndoNode>;
        if (
            typeof candidate.id !== 'number'
            || !Number.isInteger(candidate.id)
            || typeof candidate.timestamp !== 'number'
            || !Number.isFinite(candidate.timestamp)
            || typeof candidate.label !== 'string'
            || typeof candidate.hash !== 'string'
            || !Array.isArray(candidate.parents)
            || !candidate.parents.every((id) => typeof id === 'number' && Number.isInteger(id))
            || !Array.isArray(candidate.children)
            || !candidate.children.every((id) => typeof id === 'number' && Number.isInteger(id))
        ) {
            throw new Error('Invalid undo node shape');
        }

        const result: UndoNode = {
            id: candidate.id,
            parents: [...candidate.parents],
            children: [...candidate.children],
            timestamp: candidate.timestamp,
            label: candidate.label,
            hash: candidate.hash,
            storage: this.cloneValidatedStorage(candidate.storage),
        };
        if (candidate.note !== undefined) {
            if (typeof candidate.note !== 'string') {
                throw new Error('Invalid node note');
            }
            result.note = candidate.note;
        }
        if (candidate.pinned !== undefined) {
            if (typeof candidate.pinned !== 'boolean') {
                throw new Error('Invalid pinned flag');
            }
            result.pinned = candidate.pinned;
        }
        if (candidate.lineCount !== undefined) {
            if (typeof candidate.lineCount !== 'number' || !Number.isFinite(candidate.lineCount) || candidate.lineCount < 0) {
                throw new Error('Invalid line count');
            }
            result.lineCount = candidate.lineCount;
        }
        if (candidate.byteCount !== undefined) {
            if (typeof candidate.byteCount !== 'number' || !Number.isFinite(candidate.byteCount) || candidate.byteCount < 0) {
                throw new Error('Invalid byte count');
            }
            result.byteCount = candidate.byteCount;
        }
        return result;
    }

    private wouldCreateParentCycle(
        childId: number,
        parentId: number,
        chosenParents: Map<number, number>
    ): boolean {
        let current: number | undefined = parentId;
        const visited = new Set<number>();
        while (current !== undefined) {
            if (current === childId) {
                return true;
            }
            if (visited.has(current)) {
                return true;
            }
            visited.add(current);
            current = chosenParents.get(current);
        }
        return false;
    }

    private needsTopologyRepair(
        nodes: Map<number, UndoNode>,
        rootId: number
    ): boolean {
        const seenChildEdges = new Set<string>();

        for (const node of nodes.values()) {
            if (node.id === rootId) {
                if (node.parents.length !== 0) {
                    return true;
                }
            } else if (node.parents.length !== 1) {
                return true;
            }

            const localChildren = new Set<number>();
            for (const childId of node.children) {
                if (!nodes.has(childId) || childId === node.id || localChildren.has(childId)) {
                    return true;
                }
                localChildren.add(childId);
                seenChildEdges.add(`${node.id}->${childId}`);
            }
        }

        const visited = new Set<number>();
        const active = new Set<number>();
        const hasCycle = (nodeId: number): boolean => {
            if (active.has(nodeId)) {
                return true;
            }
            if (visited.has(nodeId)) {
                return false;
            }
            visited.add(nodeId);
            active.add(nodeId);
            const node = nodes.get(nodeId);
            if (node) {
                for (const childId of node.children) {
                    if (hasCycle(childId)) {
                        return true;
                    }
                }
            }
            active.delete(nodeId);
            return false;
        };

        if (hasCycle(rootId)) {
            return true;
        }

        for (const node of nodes.values()) {
            if (!visited.has(node.id)) {
                return true;
            }
            if (node.id !== rootId) {
                const parentId = node.parents[0];
                if (parentId === undefined || !nodes.has(parentId) || parentId === node.id) {
                    return true;
                }
                if (!seenChildEdges.has(`${parentId}->${node.id}`)) {
                    return true;
                }
            }
        }

        return false;
    }

    private repairTreeTopology(
        nodes: Map<number, UndoNode>,
        rootId: number
    ): void {
        const inboundParents = new Map<number, Set<number>>();
        for (const node of nodes.values()) {
            for (const parentId of node.parents) {
                if (nodes.has(parentId) && parentId !== node.id) {
                    if (!inboundParents.has(node.id)) {
                        inboundParents.set(node.id, new Set<number>());
                    }
                    inboundParents.get(node.id)!.add(parentId);
                }
            }
            for (const childId of node.children) {
                if (nodes.has(childId) && childId !== node.id) {
                    if (!inboundParents.has(childId)) {
                        inboundParents.set(childId, new Set<number>());
                    }
                    inboundParents.get(childId)!.add(node.id);
                }
            }
        }

        const chosenParents = new Map<number, number>();
        const orderedNodes = Array.from(nodes.values()).sort((a, b) =>
            a.timestamp === b.timestamp ? a.id - b.id : a.timestamp - b.timestamp
        );

        for (const node of orderedNodes) {
            if (node.id === rootId) {
                continue;
            }

            const explicitParents = node.parents.filter((parentId) => nodes.has(parentId) && parentId !== node.id);
            const inferredParents = Array.from(inboundParents.get(node.id) ?? []).filter((parentId) =>
                parentId !== node.id && !explicitParents.includes(parentId)
            );
            const candidates = [...explicitParents, ...inferredParents];

            let selectedParent: number | undefined;
            for (const candidateParentId of candidates) {
                if (!this.wouldCreateParentCycle(node.id, candidateParentId, chosenParents)) {
                    selectedParent = candidateParentId;
                    break;
                }
            }

            if (selectedParent === undefined && rootId !== node.id) {
                selectedParent = rootId;
            }

            if (selectedParent !== undefined) {
                chosenParents.set(node.id, selectedParent);
            }
        }

        for (const node of nodes.values()) {
            node.children = [];
        }

        for (const node of nodes.values()) {
            if (node.id === rootId) {
                node.parents = [];
                continue;
            }
            const parentId = chosenParents.get(node.id);
            node.parents = parentId !== undefined ? [parentId] : [];
        }

        for (const node of nodes.values()) {
            const parentId = node.parents[0];
            if (parentId !== undefined) {
                const parent = nodes.get(parentId);
                if (parent && !parent.children.includes(node.id)) {
                    parent.children.push(node.id);
                }
            }
        }
    }

    private deserializeTree(tree: unknown): UndoTree {
        if (!tree || typeof tree !== 'object') {
            throw new Error('Invalid undo tree');
        }
        const candidate = tree as Partial<SerializedUndoTree>;
        if (
            !Array.isArray(candidate.nodes)
            || !Array.isArray(candidate.hashMap)
            || typeof candidate.currentId !== 'number'
            || !Number.isInteger(candidate.currentId)
            || typeof candidate.rootId !== 'number'
            || !Number.isInteger(candidate.rootId)
        ) {
            throw new Error('Invalid undo tree shape');
        }

        const nodes = new Map<number, UndoNode>();
        for (const rawNode of candidate.nodes) {
            const node = this.deserializeNode(rawNode);
            if (nodes.has(node.id)) {
                throw new Error(`Duplicate node id ${node.id}`);
            }
            nodes.set(node.id, node);
        }

        if (!nodes.has(candidate.currentId) || !nodes.has(candidate.rootId)) {
            throw new Error('Undo tree references missing root or current node');
        }

        if (this.needsTopologyRepair(nodes, candidate.rootId)) {
            this.repairTreeTopology(nodes, candidate.rootId);
        }

        for (const node of nodes.values()) {
            for (const parentId of node.parents) {
                if (!nodes.has(parentId)) {
                    throw new Error(`Node ${node.id} references missing parent ${parentId}`);
                }
                const parent = nodes.get(parentId)!;
                if (!parent.children.includes(node.id)) {
                    parent.children.push(node.id);
                }
            }
            for (const childId of node.children) {
                if (!nodes.has(childId)) {
                    throw new Error(`Node ${node.id} references missing child ${childId}`);
                }
                const child = nodes.get(childId)!;
                if (!child.parents.includes(node.id)) {
                    child.parents.push(node.id);
                }
            }
        }

        const hashMap = new Map<string, number>();
        for (const entry of candidate.hashMap) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'number' || !nodes.has(entry[1])) {
                throw new Error('Invalid hash map entry');
            }
            hashMap.set(entry[0], entry[1]);
        }

        return {
            nodes,
            hashMap,
            currentId: candidate.currentId,
            rootId: candidate.rootId,
        };
    }

    importState(state: SerializedUndoTreeState) {
        if (!state || typeof state !== 'object' || typeof state.nextId !== 'number' || !Number.isFinite(state.nextId) || !state.trees || typeof state.trees !== 'object') {
            throw new Error('Invalid serialized undo tree state');
        }
        this.trees.clear();
        this.diffBuffer.clear();
        this.lastAccessAt.clear();

        for (const [key, tree] of Object.entries(state.trees)) {
            this.trees.set(key, this.deserializeTree(tree));
            this.lastAccessAt.set(key, Date.now());
        }

        this.nextId = Math.max(
            state.nextId,
            ...Array.from(this.trees.values()).flatMap((tree) => Array.from(tree.nodes.keys()).map((id) => id + 1)),
            1
        );
        this.onRefresh?.();
    }

    importTree(uri: string, tree: SerializedUndoTree, nextId?: number) {
        this.trees.set(uri, this.deserializeTree(tree));
        this.lastAccessAt.set(uri, Date.now());

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

    setPinned(uri: vscode.Uri, nodeId: number, pinned: boolean): void {
        const tree = this.trees.get(uri.toString());
        if (!tree) {
            return;
        }
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        node.pinned = pinned || undefined;
        this.onRefresh?.();
    }

    togglePinned(uri: vscode.Uri, nodeId: number): void {
        const tree = this.trees.get(uri.toString());
        if (!tree) {
            return;
        }
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        node.pinned = !node.pinned || undefined;
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

        const reusableLatestLeafId = this.findReusableLatestLeafForContent(tree, content);
        if (reusableLatestLeafId !== undefined) {
            tree.currentId = reusableLatestLeafId;
            this.diffBuffer.delete(uri.toString());
            this.onRefresh?.();
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
        tree.nodes.set(newId, node);
        tree.hashMap.set(node.hash, newId);
        tree.currentId = newId;
        if (currentNode.children.length >= 2) {
            this.upgradeStorage(tree, currentNode.id, currentContent);
        }
        this.diffBuffer.delete(key);
        this.dirtyTrees.add(key);
        this.onRefresh?.();
        return tree;
    }

    private findReusableLatestLeafForContent(tree: UndoTree, content: string): number | undefined {
        const hash = this.hashContent(content);
        const candidateId = tree.hashMap.get(hash);
        if (candidateId === undefined) {
            return undefined;
        }
        const candidate = tree.nodes.get(candidateId);
        if (!candidate) {
            return undefined;
        }
        if (candidate.children.length !== 0) {
            return undefined;
        }
        const latestNodeId = this.getLatestNodeId(tree);
        if (candidateId !== latestNodeId) {
            return undefined;
        }
        if (this.reconstructContent(tree, candidateId) !== content) {
            return undefined;
        }
        return candidateId;
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
        if (node.pinned) { return false; }
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
        const latestNodeId = this.getLatestNodeId(tree);

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
        const hasPinnedAncestor = this.collectPinnedAncestors(tree);

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
            const isProtected = nodeId === latestNodeId
                || node.note
                || node.pinned
                || hasNotedAncestor.has(nodeId)
                || hasPinnedAncestor.has(nodeId);

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

    hardCompactWithOverrides(tree: UndoTree, maxAgeDays: number, overrides: Map<number, 'remove' | 'keep'>): CompactApplyResult {
        const toDelete = this.collectHardCompactNodeIds(tree, maxAgeDays, overrides);
        const skipped = Array.from(overrides.entries()).filter(([id, action]) =>
            action === 'remove' && tree.nodes.has(id) && !toDelete.has(id)
        ).length;

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
        return { removed: toDelete.size, skipped };
    }

    previewHardCompact(tree: UndoTree, maxAgeDays: number): number {
        return this.hardCompact(this.cloneTree(tree), maxAgeDays);
    }

    previewHardCompactDetailed(tree: UndoTree, maxAgeDays: number): CompactPreviewResult {
        const removableIds = this.collectHardCompactNodeIds(tree, maxAgeDays);
        const removable: CompactPreviewItem[] = [];
        const protectedItems: CompactPreviewItem[] = [];

        for (const [, node] of tree.nodes) {
            if (node.id === tree.rootId) {
                protectedItems.push(this.toCompactPreviewItem(tree, node, 'root node'));
                continue;
            }
            if (removableIds.has(node.id)) {
                removable.push(this.toCompactPreviewItem(tree, node, `older than ${maxAgeDays} day(s)`));
            } else {
                protectedItems.push(this.toCompactPreviewItem(tree, node, this.getHardCompactProtectReason(tree, node, maxAgeDays)));
            }
        }

        removable.sort((a, b) => a.timestamp - b.timestamp);
        protectedItems.sort((a, b) => a.timestamp - b.timestamp);
        return {
            removable,
            protected: protectedItems,
            all: [...removable.map((item) => ({ ...item, status: 'remove' as const })), ...protectedItems.map((item) => ({ ...item, status: 'keep' as const }))].sort((a, b) => a.timestamp - b.timestamp),
        };
    }

    private toCompactPreviewItem(tree: UndoTree, node: UndoNode, reason: string): CompactPreviewItem {
        const manualRemoveReason = this.getManualRemoveBlockReason(tree, node);
        return {
            id: node.id,
            label: node.label,
            timestamp: node.timestamp,
            note: node.note,
            pinned: node.pinned,
            reason,
            storageKind: node.storage.kind,
            parents: [...node.parents],
            children: [...node.children],
            ...(node.lineCount !== undefined ? { lineCount: node.lineCount } : {}),
            ...(node.byteCount !== undefined ? { byteCount: node.byteCount } : {}),
            manualRemoveAllowed: manualRemoveReason === undefined,
            ...(manualRemoveReason ? { manualRemoveReason } : {}),
        };
    }

    private getCompactBlockReason(tree: UndoTree, node: UndoNode): string | undefined {
        if (node.id === tree.currentId) { return 'current node'; }
        if (node.note) { return 'has note'; }
        if (node.pinned) { return 'pinned node'; }
        if (node.parents.length !== 1) { return 'branch or root connection'; }
        if (node.children.length !== 1) { return 'branch point or leaf'; }
        const kind = this.classifyNode(node);
        if (kind === 'mixed') { return 'mixed edit'; }
        const parent = tree.nodes.get(node.parents[0]);
        const child = tree.nodes.get(node.children[0]);
        if (!parent || !child) { return 'missing neighbor'; }
        if (this.classifyNode(parent) !== kind || this.classifyNode(child) !== kind) {
            return 'different edit kind around node';
        }
        return undefined;
    }

    private collectCurrentAncestors(tree: UndoTree): Set<number> {
        const currentAncestors = new Set<number>();
        const visited = new Set<number>();
        let id: number | undefined = tree.currentId;
        while (id !== undefined) {
            if (visited.has(id)) { break; }
            visited.add(id);
            currentAncestors.add(id);
            const node = tree.nodes.get(id);
            id = node && node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }
        return currentAncestors;
    }

    private collectNotedAncestors(tree: UndoTree): Set<number> {
        const hasNotedAncestor = new Set<number>();
        for (const [nodeId, node] of tree.nodes) {
            if (!node.note) { continue; }
            const visited = new Set<number>();
            let aid: number | undefined = nodeId;
            while (aid !== undefined) {
                if (visited.has(aid)) { break; }
                visited.add(aid);
                if (hasNotedAncestor.has(aid)) { break; }
                hasNotedAncestor.add(aid);
                const anode = tree.nodes.get(aid);
                aid = anode && anode.parents.length > 0 ? anode.parents[anode.parents.length - 1] : undefined;
            }
        }
        return hasNotedAncestor;
    }

    private collectPinnedAncestors(tree: UndoTree): Set<number> {
        const hasPinnedAncestor = new Set<number>();
        for (const [nodeId, node] of tree.nodes) {
            if (!node.pinned) { continue; }
            const visited = new Set<number>();
            let aid: number | undefined = nodeId;
            while (aid !== undefined) {
                if (visited.has(aid)) { break; }
                visited.add(aid);
                if (hasPinnedAncestor.has(aid)) { break; }
                hasPinnedAncestor.add(aid);
                const anode = tree.nodes.get(aid);
                aid = anode && anode.parents.length > 0 ? anode.parents[anode.parents.length - 1] : undefined;
            }
        }
        return hasPinnedAncestor;
    }

    private getLatestNodeId(tree: UndoTree): number {
        let latestNodeId = tree.rootId;
        let latestTimestamp = Number.NEGATIVE_INFINITY;

        for (const [nodeId, node] of tree.nodes) {
            if (
                node.timestamp > latestTimestamp
                || (node.timestamp === latestTimestamp && nodeId > latestNodeId)
            ) {
                latestTimestamp = node.timestamp;
                latestNodeId = nodeId;
            }
        }

        return latestNodeId;
    }

    private canManuallyRemove(tree: UndoTree, node: UndoNode): boolean {
        return this.getManualRemoveBlockReason(tree, node) === undefined;
    }

    private getManualRemoveBlockReason(tree: UndoTree, node: UndoNode): string | undefined {
        if (node.id === tree.rootId) {
            return 'root node cannot be removed';
        }
        if (node.id === tree.currentId) {
            return 'current node cannot be removed';
        }
        if (node.pinned) {
            return 'pinned node cannot be removed';
        }
        if (node.parents.length !== 1) {
            return 'requires exactly one parent';
        }
        if (node.children.length !== 1) {
            return 'requires exactly one child';
        }
        return undefined;
    }

    private collectHardCompactNodeIds(tree: UndoTree, maxAgeDays: number, overrides?: Map<number, 'remove' | 'keep'>): Set<number> {
        const thresholdMs = maxAgeDays * 86_400_000;
        const now = Date.now();
        const latestNodeId = this.getLatestNodeId(tree);
        const currentAncestors = this.collectCurrentAncestors(tree);
        const hasNotedAncestor = this.collectNotedAncestors(tree);
        const hasPinnedAncestor = this.collectPinnedAncestors(tree);
        const keptAncestors = new Set<number>();
        if (overrides) {
            for (const [nodeId, action] of overrides) {
                if (action !== 'keep' || !tree.nodes.has(nodeId)) { continue; }
                let aid: number | undefined = nodeId;
                while (aid !== undefined) {
                    if (keptAncestors.has(aid)) { break; }
                    keptAncestors.add(aid);
                    const anode = tree.nodes.get(aid);
                    aid = anode && anode.parents.length > 0 ? anode.parents[anode.parents.length - 1] : undefined;
                }
            }
        }
        const toDelete = new Set<number>();

        const markSubtree = (nodeId: number, visited = new Set<number>()) => {
            if (visited.has(nodeId)) { return; }
            visited.add(nodeId);
            const node = tree.nodes.get(nodeId);
            if (!node) { return; }
            toDelete.add(nodeId);
            for (const childId of node.children) {
                markSubtree(childId, visited);
            }
        };

        const dfs = (nodeId: number, visited = new Set<number>()) => {
            if (visited.has(nodeId)) { return; }
            visited.add(nodeId);
            const node = tree.nodes.get(nodeId);
            if (!node) { return; }

            if (currentAncestors.has(nodeId)) {
                for (const childId of node.children) {
                    dfs(childId, visited);
                }
                return;
            }

            if (overrides?.get(nodeId) === 'remove' && nodeId !== tree.rootId) {
                markSubtree(nodeId);
                return;
            }

            const isExpired = (now - node.timestamp) > thresholdMs;
            const isProtected = nodeId === latestNodeId
                || node.note
                || node.pinned
                || hasNotedAncestor.has(nodeId)
                || hasPinnedAncestor.has(nodeId)
                || keptAncestors.has(nodeId);

            if (isExpired && !isProtected) {
                markSubtree(nodeId);
            } else {
                for (const childId of node.children) {
                    dfs(childId, visited);
                }
            }
        };

        dfs(tree.rootId);
        return toDelete;
    }

    private getHardCompactProtectReason(tree: UndoTree, node: UndoNode, maxAgeDays: number): string {
        const thresholdMs = maxAgeDays * 86_400_000;
        const ageMs = Date.now() - node.timestamp;
        const latestNodeId = this.getLatestNodeId(tree);
        const currentAncestors = this.collectCurrentAncestors(tree);
        const hasNotedAncestor = this.collectNotedAncestors(tree);
        const hasPinnedAncestor = this.collectPinnedAncestors(tree);
        if (node.id === tree.currentId) {
            return 'current node';
        }
        if (node.id === latestNodeId) {
            return 'latest node';
        }
        if (currentAncestors.has(node.id)) {
            return 'current path';
        }
        if (node.pinned) {
            return 'pinned node';
        }
        if (hasPinnedAncestor.has(node.id)) {
            return 'ancestor of pinned node';
        }
        if (node.note) {
            return 'has note';
        }
        if (hasNotedAncestor.has(node.id)) {
            return 'ancestor of noted node';
        }
        if (ageMs <= thresholdMs) {
            return 'still within retention window';
        }
        return 'kept by traversal';
    }

    private cloneTree(tree: UndoTree): UndoTree {
        return {
            nodes: new Map(
                Array.from(tree.nodes.entries()).map(([id, node]) => [
                    id,
                    {
                        ...node,
                        parents: [...node.parents],
                        children: [...node.children],
                        storage:
                            node.storage.kind === 'full'
                                ? { kind: 'full', content: node.storage.content }
                                : node.storage.kind === 'checkpoint'
                                    ? { kind: 'checkpoint', contentHash: node.storage.contentHash }
                                    : {
                                        kind: 'delta',
                                        diffs: node.storage.diffs.map((eventDiffs: Diff[]) =>
                                            eventDiffs.map((diff: Diff) => ({ ...diff }))
                                        ),
                                    },
                        ...(node.pinned !== undefined ? { pinned: node.pinned } : {}),
                    },
                ])
            ),
            rootId: tree.rootId,
            currentId: tree.currentId,
            hashMap: new Map(tree.hashMap),
        };
    }

    dispose() {
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
        }
        this.trees.clear();
        this.diffBuffer.clear();
        this.lastAccessAt.clear();
        this.jumpSuppressedHashes.clear();
        this.contentCache.clear();
        this.contentCacheBytes = 0;
    }
}
