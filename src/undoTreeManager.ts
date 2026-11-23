'use strict';

import * as vscode from 'vscode';
import { hashContent, checkpointHash } from './checkpointContent';
import { deflateRaw, deflateRawSync, inflateRawSync, inflateRaw } from 'zlib';
import { promisify } from 'util';
import { isValidContentHash } from './contentHash';
import { applyHistoryDiffs } from './applyHistoryDiffs';
import { minimalTextEdit } from './minimalTextEdit';

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
    noteUpdatedAt?: number;
    pinned?: boolean;
    pinnedUpdatedAt?: number;
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
    noteUpdatedAt?: number;
    pinned?: boolean;
    pinnedUpdatedAt?: number;
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

function nextIdAfterNodes(nodes: Iterable<{ id: number }>, hint: number): number {
    let nextId = Math.max(1, hint);
    for (const node of nodes) {
        nextId = Math.max(nextId, node.id + 1);
    }
    return nextId;
}

function mergeMutableMetadata(existing: SerializedUndoNode, incoming: SerializedUndoNode): void {
    if (existing.noteUpdatedAt === undefined && incoming.noteUpdatedAt === undefined) {
        // Legacy snapshots have no tombstone, so preserve an existing note when
        // the incoming field is merely absent.
        existing.note = incoming.note ?? existing.note;
    } else if (
        incoming.noteUpdatedAt !== undefined
        && (existing.noteUpdatedAt === undefined || incoming.noteUpdatedAt > existing.noteUpdatedAt)
    ) {
        existing.note = incoming.note;
        existing.noteUpdatedAt = incoming.noteUpdatedAt;
    }

    if (existing.pinnedUpdatedAt === undefined && incoming.pinnedUpdatedAt === undefined) {
        // As with notes, a legacy missing value cannot prove an intentional
        // unpin, while an explicit false remains authoritative.
        existing.pinned = incoming.pinned ?? existing.pinned;
    } else if (
        incoming.pinnedUpdatedAt !== undefined
        && (existing.pinnedUpdatedAt === undefined || incoming.pinnedUpdatedAt > existing.pinnedUpdatedAt)
    ) {
        existing.pinned = incoming.pinned;
        existing.pinnedUpdatedAt = incoming.pinnedUpdatedAt;
    }
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
            nextId: nextIdAfterNodes(incoming.nodes, nextIdHint),
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
    const sameHashCollisions: SerializedUndoNode[] = [];
    const baseNextId = nextIdAfterNodes(base.nodes, nextIdHint);
    let nextId = nextIdAfterNodes(incoming.nodes, baseNextId);

    for (const node of incoming.nodes) {
        const existing = mergedNodes.get(node.id);
        if (!existing) {
            idRemap.set(node.id, node.id);
            continue;
        }

        if (existing.hash === node.hash) {
            idRemap.set(node.id, node.id);
            sameHashCollisions.push(node);
            continue;
        }

        const remappedId = nextId++;
        idRemap.set(node.id, remappedId);
    }

    // A delta is relative to its parent content. Even when id and hash match,
    // merging nodes whose parent paths differ would make one branch use the
    // other branch's delta. Split such nodes, then repeat because splitting a
    // parent can require every same-id/hash descendant to split as well.
    let splitDetected: boolean;
    do {
        splitDetected = false;
        for (const node of sameHashCollisions) {
            if (idRemap.get(node.id) !== node.id) { continue; }
            const existing = mergedNodes.get(node.id)!;
            const remappedParents = uniqueIds(
                node.parents.map((parentId) => idRemap.get(parentId) ?? parentId)
            );
            const existingParents = uniqueIds(existing.parents);
            const sameParentPath = existingParents.length === remappedParents.length
                && existingParents.every((parentId, index) => parentId === remappedParents[index]);
            if (!sameParentPath && node.storage.kind === 'delta') {
                idRemap.set(node.id, nextId++);
                splitDetected = true;
            }
        }
    } while (splitDetected);

    // A previous writer may already have installed a colliding branch under
    // different IDs. Resolve parents first, then reuse the matching base path;
    // matching hashes alone would corrupt deltas on different parent paths.
    const pathKey = (hash: string, parents: number[]) => JSON.stringify([hash, uniqueIds(parents)]);
    const basePaths = new Map<string, number>();
    for (const node of mergedNodes.values()) {
        const key = pathKey(node.hash, node.parents);
        if (!basePaths.has(key)) { basePaths.set(key, node.id); }
    }
    const incomingById = new Map(incoming.nodes.map(node => [node.id, node]));
    const remainingParents = new Map<number, number>();
    const dependents = new Map<number, number[]>();
    const ordered: SerializedUndoNode[] = [];
    for (const node of incoming.nodes) {
        const parents = uniqueIds(node.parents).filter(id => incomingById.has(id));
        remainingParents.set(node.id, parents.length);
        if (parents.length === 0) { ordered.push(node); }
        for (const parent of parents) {
            const children = dependents.get(parent) ?? [];
            children.push(node.id);
            dependents.set(parent, children);
        }
    }
    for (let index = 0; index < ordered.length; index++) {
        const node = ordered[index];
        if (idRemap.get(node.id) !== node.id || !mergedNodes.has(node.id)) {
            const parents = node.parents.map(id => idRemap.get(id) ?? id);
            const installedId = basePaths.get(pathKey(node.hash, parents));
            if (installedId !== undefined) { idRemap.set(node.id, installedId); }
        }
        for (const child of dependents.get(node.id) ?? []) {
            const count = remainingParents.get(child)! - 1;
            remainingParents.set(child, count);
            if (count === 0) { ordered.push(incomingById.get(child)!); }
        }
    }

    const preserveExistingParentIds = new Set<number>();
    for (const node of sameHashCollisions) {
        if (idRemap.get(node.id) !== node.id) { continue; }
        const existing = mergedNodes.get(node.id)!;
        const remappedParents = uniqueIds(
            node.parents.map((parentId) => idRemap.get(parentId) ?? parentId)
        );
        const existingParents = uniqueIds(existing.parents);
        const sameParentPath = existingParents.length === remappedParents.length
            && existingParents.every((parentId, index) => parentId === remappedParents[index]);
        if (!sameParentPath) {
            // Full/checkpoint payloads are parent-independent. Keep the
            // established base path instead of duplicating or letting a stale
            // snapshot silently reparent it.
            preserveExistingParentIds.add(node.id);
        }
    }

    // Install node payloads only after the remap is final. This keeps the base
    // payload intact for split nodes and lets the incoming copy retain the
    // storage representation that belongs to its remapped parent.
    for (const node of incoming.nodes) {
        const mergedId = idRemap.get(node.id)!;
        const existing = mergedNodes.get(mergedId);
        if (existing && existing.hash === node.hash) {
            existing.timestamp = Math.max(existing.timestamp, node.timestamp);
            existing.label = node.label;
            existing.storage = node.storage;
            existing.lineCount = node.lineCount ?? existing.lineCount;
            existing.byteCount = node.byteCount ?? existing.byteCount;
            mergeMutableMetadata(existing, node);
        } else {
            mergedNodes.set(mergedId, {
                ...node,
                id: mergedId,
                parents: [],
                children: [],
            });
        }
    }

    for (const node of incoming.nodes) {
        const mergedId = idRemap.get(node.id)!;
        const mergedNode = mergedNodes.get(mergedId)!;
        const remappedParents = uniqueIds(
            node.parents
                .map((parentId) => idRemap.get(parentId) ?? parentId)
                .filter((parentId) => mergedNodes.has(parentId))
        );
        if (!preserveExistingParentIds.has(node.id)) {
            mergedNode.parents = remappedParents;
        }
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

    // IDs tentatively allocated above may have been reused instead.
    return { tree: mergedTree, nextId: nextIdAfterNodes(mergedTree.nodes, nextIdHint) };
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
const inflateCheckpoint = promisify(inflateRaw);
const deflateCheckpoint = promisify(deflateRaw);
const MIN_COMPRESSED_SNAPSHOT_CHARS = 256 * 1024;

export class UndoTreeManager implements vscode.Disposable {
    private trees = new Map<string, UndoTree>();
    private diffBuffer = new Map<string, Diff[][]>();
    private forceFullSnapshotUris = new Set<string>();
    private pendingSaves = new Map<string, number>();
    private pendingSaveRecords = new Map<string, Set<() => void>>();
    private dirtyTrees = new Set<string>();
    private mutationGenerations = new Map<string, number>();
    private pendingCheckpointGenerations = new Map<string, Map<string, number>>();
    private lastAccessAt = new Map<string, number>();
    private jumpSuppressedHashes = new Map<string, string>();
    private jumpGenerations = new WeakMap<UndoTree, number>();
    private jumpQueues = new Map<string, Promise<void>>();
    private managerEpoch = 0;
    private nextId = 1;
    private autosaveTimer: ReturnType<typeof setInterval> | undefined;
    private autosaveIntervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS;
    private restoringByUri = new Map<string, Set<symbol>>();
    private lastMetadataRevision = 0;
    private contentCache = new Map<string, string>();
    // Unpersisted cold snapshots keep a lossless backing copy outside the decoded LRU.
    private compressedCheckpoints = new Map<string, Buffer>();
    private checkpointCompressionQueue = new Map<UndoNode, { tree: UndoTree; uri: string; content: string; epoch: number }>();
    private checkpointCompressionTask: Promise<void> | undefined;
    private contentCacheBytes = 0;
    private contentCacheMaxBytes = 20480 * 1024;
    private memoryCheckpointThresholdBytes = 32 * 1024;
    private emptyHash: string | undefined;
    contentResolver: ((hash: string) => string) | undefined;
    asyncContentResolver: ((hash: string) => Promise<string>) | undefined;
    private _paused = false;
    onRefresh: (() => void) | undefined;
    debugLog: ((msg: string) => void) | undefined;
    onCheckpointLoadStart: (() => void) | undefined;
    isTracked: ((uri: vscode.Uri) => boolean) | undefined;

    constructor() {
        this.autosaveTimer = setInterval(() => this.autosave(), this.autosaveIntervalMs);
        this.unrefAutosaveTimer();
    }

    get paused(): boolean {
        return this._paused;
    }

    set paused(value: boolean) {
        const next = value === true;
        if (next === this._paused) {
            return;
        }
        this._paused = next;
        // Changes made while tracking is paused are deliberately ignored. Any
        // pre-pause diffs therefore no longer describe the document on resume.
        this.diffBuffer.clear();
        for (const uri of this.trees.keys()) {
            this.forceFullSnapshotUris.add(uri);
        }
    }

    private unrefAutosaveTimer(): void {
        (this.autosaveTimer as unknown as { unref?: () => void } | undefined)?.unref?.();
    }

    private beginRestoring(uri: string): symbol {
        const token = Symbol(uri);
        const active = this.restoringByUri.get(uri) ?? new Set<symbol>();
        active.add(token);
        this.restoringByUri.set(uri, active);
        return token;
    }

    private endRestoring(uri: string, token: symbol): void {
        const active = this.restoringByUri.get(uri);
        if (!active) { return; }
        active.delete(token);
        if (active.size === 0) {
            this.restoringByUri.delete(uri);
        }
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
        const compressed = this.compressedCheckpoints.get(contentHash);
        if (compressed) {
            const content = inflateRawSync(compressed).toString('utf16le');
            this.setCachedContent(contentHash, content);
            return content;
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
        const compressed = this.compressedCheckpoints.get(contentHash);
        if (compressed) {
            content = (await inflateCheckpoint(compressed)).toString('utf16le');
        } else if (this.asyncContentResolver) {
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
        // Capture storage before loading a checkpoint. Compaction can replace
        // delta storage and remove its ancestors while the load is pending.
        const path: UndoNodeStorage[] = [];
        const visited = new Set<number>();
        let id: number | undefined = targetId;

        while (id !== undefined) {
            if (visited.has(id)) { break; }
            visited.add(id);
            const node = tree.nodes.get(id);
            if (!node) { return ''; }
            path.push(node.storage);
            if (node.storage.kind !== 'delta') { break; }
            id = node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }

        let content = '';
        const diffs: Diff[][] = [];
        for (const storage of path.reverse()) {
            if (storage.kind === 'full') {
                content = storage.content;
            } else if (storage.kind === 'checkpoint') {
                content = await this.getOrLoadContentAsync(storage.contentHash);
            } else {
                for (const event of storage.diffs) { diffs.push(event); }
            }
        }
        return this.applyDiffs(content, diffs);
    }

    private setCachedContent(hash: string, content: string, retainUnpersisted = false) {
        const existing = this.contentCache.get(hash);
        if (existing !== undefined) {
            this.contentCache.delete(hash);
            this.contentCacheBytes = Math.max(0, this.contentCacheBytes - Buffer.byteLength(existing, 'utf8'));
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > this.contentCacheMaxBytes && !retainUnpersisted) { return; }
        this.evictCache(bytes);
        this.contentCache.set(hash, content);
        this.contentCacheBytes += bytes;
    }

    getCheckpointContent(hash: string): string {
        return this.getOrLoadContent(hash);
    }

    async getCheckpointContentAsync(hash: string): Promise<string> {
        const compressed = this.compressedCheckpoints.get(hash);
        // Persistence reads many cold snapshots once; avoid filling the decoded
        // navigation cache with each of them.
        if (compressed) { return (await inflateCheckpoint(compressed)).toString('utf16le'); }
        return this.getOrLoadContentAsync(hash);
    }

    private evictCache(incoming: number) {
        const protectedHashes = this.getPendingCheckpointHashes();
        while (this.contentCacheBytes + incoming > this.contentCacheMaxBytes && this.contentCache.size > 0) {
            const oldest = Array.from(this.contentCache.keys()).find((hash) =>
                !protectedHashes.has(hash) || this.compressedCheckpoints.has(hash));
            if (oldest === undefined) {
                // Pending in-memory checkpoints are the sole copy of their
                // content. Temporarily exceeding the cache cap is safer than
                // making the history unrecoverable; persistence will unpin it.
                break;
            }
            this.contentCacheBytes -= Buffer.byteLength(this.contentCache.get(oldest)!, 'utf8');
            this.contentCache.delete(oldest);
        }
    }

    private getPendingCheckpointHashes(): Set<string> {
        const hashes = new Set<string>();
        for (const pending of this.pendingCheckpointGenerations.values()) {
            for (const hash of pending.keys()) {
                hashes.add(hash);
            }
        }
        return hashes;
    }

    private trackPendingCheckpoint(uri: string, hash: string, generation: number): void {
        const pending = this.pendingCheckpointGenerations.get(uri) ?? new Map<string, number>();
        pending.set(hash, Math.max(pending.get(hash) ?? 0, generation));
        this.pendingCheckpointGenerations.set(uri, pending);
    }

    markCheckpointPersisted(hashes: Iterable<string>): void {
        const persisted = new Set(hashes);
        for (const [uri, pending] of this.pendingCheckpointGenerations) {
            for (const hash of persisted) {
                pending.delete(hash);
            }
            if (pending.size === 0) {
                this.pendingCheckpointGenerations.delete(uri);
            }
        }
        this.releasePersistedCompressedCheckpoints(persisted);
        this.evictCache(0);
    }

    markCheckpointPersistedForUri(uri: string, hashes: Iterable<string>): void {
        const persisted = new Set(hashes);
        const pending = this.pendingCheckpointGenerations.get(uri);
        if (!pending) {
            return;
        }
        for (const hash of persisted) {
            pending.delete(hash);
        }
        if (pending.size === 0) {
            this.pendingCheckpointGenerations.delete(uri);
        }
        this.releasePersistedCompressedCheckpoints(persisted);
        this.evictCache(0);
    }

    private releasePersistedCompressedCheckpoints(hashes: Iterable<string>): void {
        // Only an explicit persistence acknowledgement allows dropping backing
        // bytes. Clearing a dirty flag alone does not prove that a blob exists.
        if (!this.contentResolver) { return; }
        const pending = this.getPendingCheckpointHashes();
        for (const hash of hashes) {
            if (!pending.has(hash)) { this.compressedCheckpoints.delete(hash); }
        }
    }

    private pruneCompressedCheckpoints(): void {
        for (const [node, job] of this.checkpointCompressionQueue) {
            if (this.trees.get(job.uri) !== job.tree || job.tree.nodes.get(node.id) !== node) {
                this.checkpointCompressionQueue.delete(node);
            }
        }
        if (this.compressedCheckpoints.size === 0) { return; }
        // An in-flight export may still refer to a removed node. Retain its
        // backing until the corresponding pending generation is acknowledged.
        const referenced = this.getPendingCheckpointHashes();
        for (const tree of this.trees.values()) {
            for (const node of tree.nodes.values()) {
                if (node.storage.kind === 'checkpoint') { referenced.add(node.storage.contentHash); }
            }
        }
        for (const hash of this.compressedCheckpoints.keys()) {
            if (!referenced.has(hash)) { this.compressedCheckpoints.delete(hash); }
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
        // 0 disables autosave.
        if (ms > 0) {
            this.autosaveTimer = setInterval(() => this.autosave(), this.autosaveIntervalMs);
            this.unrefAutosaveTimer();
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
                tree.hashMap.set(root.hash, root.id);
                Object.assign(root, this.computeSizeMetrics(initialContent));
            }
        }
        this.lastAccessAt.set(key, Date.now());
        return this.trees.get(key)!;
    }

    hasTree(uri: vscode.Uri): boolean {
        return this.trees.has(uri.toString());
    }

    peekTree(uri: vscode.Uri): UndoTree | undefined {
        return this.trees.get(uri.toString());
    }

    markDirty(uri: vscode.Uri): void {
        this.markDirtyKey(uri.toString());
    }

    private markDirtyKey(uri: string): number {
        const generation = (this.mutationGenerations.get(uri) ?? 0) + 1;
        this.mutationGenerations.set(uri, generation);
        this.dirtyTrees.add(uri);
        return generation;
    }

    private nextMetadataRevision(): number {
        const revision = Math.max(Date.now(), this.lastMetadataRevision + 1);
        this.lastMetadataRevision = revision;
        return revision;
    }

    private observeMetadataRevisions(tree: UndoTree): void {
        for (const node of tree.nodes.values()) {
            this.lastMetadataRevision = Math.max(
                this.lastMetadataRevision,
                node.noteUpdatedAt ?? 0,
                node.pinnedUpdatedAt ?? 0
            );
        }
    }

    private markTreeDirty(tree: UndoTree): number | undefined {
        this.pruneCompressedCheckpoints();
        for (const [uri, residentTree] of this.trees) {
            if (residentTree === tree) {
                return this.markDirtyKey(uri);
            }
        }
        return undefined;
    }

    getDirtyUris(): Set<string> {
        return new Set(this.dirtyTrees);
    }

    getDirtyGenerations(uris?: Iterable<string>): Map<string, number> {
        const requested = uris === undefined ? this.dirtyTrees : new Set(uris);
        const result = new Map<string, number>();
        for (const uri of requested) {
            if (this.dirtyTrees.has(uri)) {
                result.set(uri, this.mutationGenerations.get(uri) ?? 0);
            }
        }
        return result;
    }

    clearDirtyIfGeneration(uri: string, generation: number): boolean {
        if (!this.dirtyTrees.has(uri) || this.mutationGenerations.get(uri) !== generation) {
            return false;
        }
        this.dirtyTrees.delete(uri);
        const pending = this.pendingCheckpointGenerations.get(uri);
        if (pending) {
            for (const [hash, checkpointGeneration] of pending) {
                if (checkpointGeneration <= generation) {
                    pending.delete(hash);
                }
            }
            if (pending.size === 0) {
                this.pendingCheckpointGenerations.delete(uri);
            }
        }
        this.pruneCompressedCheckpoints();
        this.evictCache(0);
        return true;
    }

    clearDirty(uris: Iterable<string>): void {
        for (const u of uris) {
            this.dirtyTrees.delete(u);
            this.pendingCheckpointGenerations.delete(u);
        }
        this.evictCache(0);
    }

    getResidentUris(): string[] {
        return Array.from(this.trees.keys());
    }

    getLastAccessAt(uri: vscode.Uri): number | undefined {
        return this.lastAccessAt.get(uri.toString());
    }

    hasPendingDiffs(uri: vscode.Uri): boolean {
        const diffs = this.diffBuffer.get(uri.toString());
        return (this.pendingSaves.get(uri.toString()) ?? 0) > 0 || !!diffs && diffs.length > 0;
    }

    resetAll(): void {
        this.managerEpoch++;
        this.pendingSaves.clear();
        this.pendingSaveRecords.clear();
        this.checkpointCompressionQueue.clear();
        this.trees.clear();
        this.diffBuffer.clear();
        this.forceFullSnapshotUris.clear();
        this.restoringByUri.clear();
        this.dirtyTrees.clear();
        this.mutationGenerations.clear();
        this.pendingCheckpointGenerations.clear();
        this.lastAccessAt.clear();
        this.jumpSuppressedHashes.clear();
        this.contentCache.clear();
        this.compressedCheckpoints.clear();
        this.contentCacheBytes = 0;
        this.lastMetadataRevision = 0;
        this.nextId = 1;
        this.onRefresh?.();
    }

    unloadTree(uri: vscode.Uri): void {
        const key = uri.toString();
        this.trees.delete(key);
        this.diffBuffer.delete(key);
        this.forceFullSnapshotUris.delete(key);
        this.dirtyTrees.delete(key);
        this.pendingCheckpointGenerations.delete(key);
        this.pruneCompressedCheckpoints();
        this.lastAccessAt.delete(key);
        this.jumpSuppressedHashes.delete(key);
        this.evictCache(0);
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
        if (this.forceFullSnapshotUris.delete(oldKey)) {
            this.forceFullSnapshotUris.add(newKey);
        }

        if (this.dirtyTrees.has(oldKey)) {
            this.dirtyTrees.delete(oldKey);
            this.dirtyTrees.add(newKey);
        }

        const oldGeneration = this.mutationGenerations.get(oldKey);
        if (oldGeneration !== undefined) {
            this.mutationGenerations.set(
                newKey,
                Math.max(oldGeneration, this.mutationGenerations.get(newKey) ?? 0) + 1
            );
            this.mutationGenerations.delete(oldKey);
        }

        const oldPendingCheckpoints = this.pendingCheckpointGenerations.get(oldKey);
        if (oldPendingCheckpoints) {
            const newPendingCheckpoints = this.pendingCheckpointGenerations.get(newKey) ?? new Map<string, number>();
            for (const [hash, generation] of oldPendingCheckpoints) {
                newPendingCheckpoints.set(hash, Math.max(generation, newPendingCheckpoints.get(hash) ?? 0));
            }
            this.pendingCheckpointGenerations.set(newKey, newPendingCheckpoints);
            this.pendingCheckpointGenerations.delete(oldKey);
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
        if (e.contentChanges.length === 0 || this.paused) {
            return;
        }
        const key = e.document.uri.toString();
        if ((this.restoringByUri.get(key)?.size ?? 0) > 0) {
            return;
        }
        if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
            this.followNativeHistory(e);
            return;
        }
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

    private followNativeHistory(e: vscode.TextDocumentChangeEvent): void {
        const key = e.document.uri.toString();
        const tree = this.trees.get(key);
        // A document awaiting its initial lazy load has no reliable baseline.
        // Keep buffering its changes; the load/save pipeline will reconcile it.
        if (!tree) {
            const buffer = this.diffBuffer.get(key) ?? [];
            buffer.push(e.contentChanges.map(c => ({
                offset: c.rangeOffset, removeLength: c.rangeLength, inserted: c.text,
            })));
            this.diffBuffer.set(key, buffer);
            return;
        }

        // Finish captured saves first when their tree is already resident.
        // This restores the baseline of edits buffered after the capture.
        try {
            for (const record of [...this.pendingSaveRecords.get(key) ?? []]) { record(); }

            // Invalidate both in-flight jumps and captured saves' logical cursor.
            // A save captured before this event must retain its original parent
            // and must not advance the live cursor when it eventually completes.
            this.jumpGenerations.set(tree, (this.jumpGenerations.get(tree) ?? 0) + 1);
            const diffs = this.diffBuffer.get(key);
            if (diffs?.length && !this.forceFullSnapshotUris.has(key) && !this.pendingSaves.has(key)) {
                // The event document already contains the result of Undo/Redo.
                // Recover the pre-event text from the recorded baseline and edits,
                // without keeping another full document copy on every keystroke.
                const before = this.applyDiffs(this.reconstructContent(tree, tree.currentId), diffs);
                this.syncDocumentState(e.document.uri, before, 'edit', true, diffs);
            }
            this.diffBuffer.delete(key);
            this.jumpSuppressedHashes.delete(key);
            const content = e.document.getText();
            const matchingId = tree.hashMap.get(this.hashContent(content));
            if (matchingId !== undefined && tree.nodes.has(matchingId)) {
                tree.currentId = matchingId;
            } else {
                // Native undo groups need not coincide with save checkpoints.
                // Keep an independently reconstructible state when no node matches.
                this.syncDocumentState(e.document.uri, content,
                    e.reason === vscode.TextDocumentChangeReason.Undo ? 'undo' : 'redo', true);
            }
            this.markDirtyKey(key);
            this.onRefresh?.();
        } catch (error) {
            // A pending save may fail before the normal invalidation below.
            // Cancel in-flight jumps and prevent later captured saves from
            // moving the live cursor back to a pre-Undo state.
            this.jumpGenerations.set(tree, (this.jumpGenerations.get(tree) ?? 0) + 1);
            // The buffered edits no longer describe the document after this
            // Undo/Redo. Never use them as the basis of a later delta.
            this.diffBuffer.delete(key);
            this.jumpSuppressedHashes.delete(key);
            this.forceFullSnapshotUris.add(key);
            this.debugLog?.(`[native history] failed to follow change: ${String(error)}`);
        }
    }

    invalidateTrackingBaseline(uri: vscode.Uri): void {
        const key = uri.toString();
        // A captured opening snapshot can still be loading when tracking stops.
        this.diffBuffer.delete(key);
        this.forceFullSnapshotUris.add(key);
    }

    invalidateTrackingBaselines(): void {
        for (const key of this.trees.keys()) {
            this.diffBuffer.delete(key);
            this.forceFullSnapshotUris.add(key);
        }
    }

    captureSave(document: vscode.TextDocument) {
        if (this.paused) { return undefined; }
        const key = document.uri.toString();
        const content = document.getText();
        const frozenDocument = { uri: document.uri, getText: () => content } as vscode.TextDocument;
        const diffs = this.diffBuffer.get(key) ?? [];
        const forceFull = this.forceFullSnapshotUris.delete(key) || this.pendingSaves.has(key);
        const resident = this.trees.get(key);
        const baselineHash = resident?.nodes.get(resident.currentId)?.hash;
        const baselineId = resident?.currentId;
        const jumpGeneration = resident ? this.jumpGenerations.get(resident) ?? 0 : 0;
        const capturedDuringRestore = (this.restoringByUri.get(key)?.size ?? 0) > 0;
        const timestamp = Date.now();
        this.diffBuffer.delete(key);
        const epoch = this.managerEpoch;
        this.pendingSaves.set(key, (this.pendingSaves.get(key) ?? 0) + 1);
        let consumed = false;
        let recorded = false;
        const dispose = () => {
            if (consumed) { return; }
            consumed = true;
            const records = this.pendingSaveRecords.get(key);
            records?.delete(save.record);
            if (records?.size === 0) { this.pendingSaveRecords.delete(key); }
            if (epoch !== this.managerEpoch) { return; }
            // A cancelled save detached edits that later changes depend on.
            if (!recorded) { this.forceFullSnapshotUris.add(key); }
            const count = (this.pendingSaves.get(key) ?? 1) - 1;
            if (count > 0) { this.pendingSaves.set(key, count); }
            else { this.pendingSaves.delete(key); }
        };
        const save = {
            document: frozenDocument,
            record: () => {
                if (consumed) { return; }
                try {
                    if (epoch === this.managerEpoch) {
                        const tree = this.trees.get(key);
                        const baselineChanged = tree?.nodes.get(tree.currentId)?.hash !== baselineHash;
                        // Retain the save as history without moving the live
                        // cursor or consuming edits based on a later jump.
                        const preserveCurrent = !!tree && (
                            (this.jumpGenerations.get(tree) ?? 0) !== jumpGeneration
                            || (capturedDuringRestore && document.getText() !== content)
                        );
                        this.addNode(frozenDocument, 'save', {
                            diffs, forceFull: forceFull || baselineChanged || preserveCurrent, timestamp,
                            preserveCurrent,
                            parentId: preserveCurrent && tree === resident && baselineId !== undefined && tree?.nodes.has(baselineId)
                                ? baselineId : undefined,
                        });
                        recorded = true;
                    }
                } finally { dispose(); }
            },
            dispose,
        };
        const records = this.pendingSaveRecords.get(key) ?? new Set<() => void>();
        records.add(save.record);
        this.pendingSaveRecords.set(key, records);
        return save;
    }

    onDidSaveTextDocument(document: vscode.TextDocument) {
        this.captureSave(document)?.record();
    }

    onDidCloseTextDocument(document: vscode.TextDocument) {
        const key = document.uri.toString();
        this.diffBuffer.delete(key);
        if (!this.trees.has(key)) { this.forceFullSnapshotUris.delete(key); }
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
        if (this.pendingSaves.has(editor.document.uri.toString())) { return; }
        this.addNode(editor.document, 'auto');
    }

    private addNode(document: vscode.TextDocument, label: string, captured?: { diffs: Diff[][]; forceFull: boolean; timestamp: number; preserveCurrent?: boolean; parentId?: number }) {
        const content = document.getText();
        const hash = this.hashContent(content);
        const tree = this.getTree(document.uri);
        const key = document.uri.toString();
        const diffs = captured?.diffs ?? this.diffBuffer.get(key) ?? [];
        const forceFull = captured?.forceFull ?? this.forceFullSnapshotUris.has(key);
        if (!captured) {
            this.diffBuffer.delete(key);
            this.forceFullSnapshotUris.delete(key);
        }
        const currentNode = tree.nodes.get(captured?.parentId ?? tree.currentId)!;
        const suppressedHash = captured?.preserveCurrent ? undefined : this.jumpSuppressedHashes.get(key);

        if (suppressedHash === hash && diffs.length === 0) {
            return;
        }
        if (suppressedHash && suppressedHash !== hash) {
            this.jumpSuppressedHashes.delete(key);
        }

        if (currentNode.hash === hash) {
            if (!captured?.preserveCurrent) { this.jumpSuppressedHashes.delete(key); }
            return;
        }

        // DAG convergence: reuse an existing node with identical content.
        const existingId = tree.hashMap.get(hash);
        if (existingId !== undefined && tree.nodes.has(existingId)) {
            if (!captured?.preserveCurrent) { tree.currentId = existingId; }
            this.markDirtyKey(key);
            this.onRefresh?.();
            return;
        }

        const isCurrentEmptyRoot =
            currentNode.parents.length === 0 &&
            currentNode.children.length === 0 &&
            currentNode.storage.kind === 'full' &&
            currentNode.storage.content === '';

        if (isCurrentEmptyRoot && !captured?.preserveCurrent) {
            tree.hashMap.delete(currentNode.hash);
            currentNode.storage = { kind: 'full', content };
            currentNode.hash = hash;
            tree.hashMap.set(hash, currentNode.id);
            Object.assign(currentNode, this.computeSizeMetrics(content));
            tree.currentId = currentNode.id;
            this.jumpSuppressedHashes.delete(key);
            this.markDirtyKey(key);
            this.onRefresh?.();
            return;
        }

        const storage: UndoNodeStorage = forceFull || this.shouldStoreFull(diffs, content.length)
            ? { kind: 'full', content }
            : { kind: 'delta', diffs };

        const newId = this.nextId++;
        const node: UndoNode = {
            id: newId,
            parents: [currentNode.id],
            children: [],
            timestamp: captured?.timestamp ?? Date.now(),
            label,
            hash,
            storage,
            ...this.computeSizeMetrics(content),
        };
        currentNode.children.push(newId);
        tree.nodes.set(newId, node);
        tree.hashMap.set(hash, newId);
        if (!captured?.preserveCurrent) { tree.currentId = newId; }

        const generation = this.markDirtyKey(key);

        if (currentNode.children.length >= 2) {
            const currentContent = this.reconstructContent(tree, currentNode.id);
            this.upgradeStorage(tree, currentNode.id, currentContent, key, generation);
        } else if (currentNode.storage.kind === 'full' && currentNode.storage.content.length >= MIN_COMPRESSED_SNAPSHOT_CHARS) {
            this.upgradeStorage(tree, currentNode.id, currentNode.storage.content, key, generation);
        }

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

    private upgradeStorage(
        tree: UndoTree,
        nodeId: number,
        content: string,
        uri?: string,
        generation?: number
    ) {
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        const contentHash = checkpointHash(content, node.hash);
        if (this.shouldUseCheckpointForMemory(content, nodeId, tree)) {
            if (content.length >= MIN_COMPRESSED_SNAPSHOT_CHARS) {
                if (content.length > 1024 * 1024 && uri !== undefined) {
                    // Large/incompressible snapshots must not block the extension
                    // host while zlib works. Keep the full node until its backing
                    // buffer is ready; one worker bounds temporary allocations.
                    node.storage = { kind: 'full', content };
                    this.checkpointCompressionQueue.set(node, { tree, uri, content, epoch: this.managerEpoch });
                    this.checkpointCompressionTask ??= this.compressQueuedCheckpoints().finally(() => {
                        this.checkpointCompressionTask = undefined;
                    });
                    return;
                }
                // UTF-16 preserves even unpaired surrogate code units exactly.
                this.compressedCheckpoints.set(contentHash, deflateRawSync(Buffer.from(content, 'utf16le'), { level: 1 }));
            } else {
                this.setCachedContent(contentHash, content, true);
            }
            node.storage = { kind: 'checkpoint', contentHash };
            if (uri !== undefined && generation !== undefined) {
                this.trackPendingCheckpoint(uri, contentHash, generation);
            }
            return;
        }
        node.storage = { kind: 'full', content };
    }

    private async compressQueuedCheckpoints(): Promise<void> {
        while (this.checkpointCompressionQueue.size > 0) {
            const [node, job] = this.checkpointCompressionQueue.entries().next().value!;
            this.checkpointCompressionQueue.delete(node);
            try {
                const buffer = await deflateCheckpoint(Buffer.from(job.content, 'utf16le'), { level: 1 });
                if (this.managerEpoch !== job.epoch || this.trees.get(job.uri) !== job.tree
                    || job.tree.nodes.get(node.id) !== node || node.storage.kind !== 'full'
                    || node.storage.content !== job.content || node.id === job.tree.currentId) { continue; }
                const contentHash = checkpointHash(job.content, node.hash);
                this.compressedCheckpoints.set(contentHash, buffer);
                node.storage = { kind: 'checkpoint', contentHash };
                // A persist may have completed while compression was running.
                // Give the representation change its own dirty generation.
                this.trackPendingCheckpoint(job.uri, contentHash, this.markDirtyKey(job.uri));
                this.onRefresh?.();
            } catch (error) {
                // The original full snapshot is still authoritative on failure.
                this.debugLog?.(`[checkpoint] background compression failed: ${String(error)}`);
            }
        }
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
            path.push(id);
            const node = tree.nodes.get(id);
            if (!node || node.storage.kind === 'full' || node.storage.kind === 'checkpoint') {
                break;
            }
            id = node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }

        let content = '';
        const diffs: Diff[][] = [];
        for (const nodeId of path.reverse()) {
            const node = tree.nodes.get(nodeId);
            if (!node) {
                break;
            }
            if (node.storage.kind === 'full') {
                content = node.storage.content;
            } else if (node.storage.kind === 'checkpoint') {
                content = this.getOrLoadContent(node.storage.contentHash);
            } else {
                for (const event of node.storage.diffs) { diffs.push(event); }
            }
        }
        return this.applyDiffs(content, diffs);
    }

    private applyDiffs(content: string, diffs: Diff[][]): string {
        return applyHistoryDiffs(content, diffs);
    }

    private hashContent(content: string): string {
        return hashContent(content);
    }

    private computeSizeMetrics(content: string): { lineCount: number; byteCount: number } {
        let lineCount = content === '' ? 0 : 1;
        let offset = -1;
        while ((offset = content.indexOf('\n', offset + 1)) !== -1) { lineCount++; }
        return {
            lineCount,
            byteCount: Buffer.byteLength(content, 'utf8'),
        };
    }

    async undo(target: vscode.TextEditor | vscode.TextDocument | undefined = vscode.window.activeTextEditor) {
        if (!target) {
            return;
        }
        const document = this.getEditTargetDocument(target);
        const uriStr = document.uri.toString();
        const requestEpoch = this.managerEpoch;
        await this.enqueueJump(uriStr, async () => {
            if (this.managerEpoch !== requestEpoch) { return; }
            const tree = this.getTree(document.uri);
            const current = tree.nodes.get(tree.currentId);
            if (!current || current.parents.length === 0) { return; }
            const targetId = current.parents[current.parents.length - 1];
            await this.performJumpToNode(targetId, target, tree);
        });
    }

    async redo(target: vscode.TextEditor | vscode.TextDocument | undefined = vscode.window.activeTextEditor) {
        if (!target) {
            return;
        }
        const document = this.getEditTargetDocument(target);
        const uriStr = document.uri.toString();
        const requestEpoch = this.managerEpoch;
        await this.enqueueJump(uriStr, async () => {
            if (this.managerEpoch !== requestEpoch) { return; }
            const tree = this.getTree(document.uri);
            const current = tree.nodes.get(tree.currentId);
            if (!current || current.children.length === 0) { return; }
            const targetId = current.children[current.children.length - 1];
            await this.performJumpToNode(targetId, target, tree);
        });
    }

    async jumpToNode(
        nodeId: number,
        editor: vscode.TextEditor,
        tree?: UndoTree
    ) {
        const uriStr = editor.document.uri.toString();
        const requestEpoch = this.managerEpoch;
        const requestedTree = tree ?? this.getTree(editor.document.uri);
        await this.enqueueJump(uriStr, async () => {
            if (this.managerEpoch !== requestEpoch) { return; }
            await this.performJumpToNode(nodeId, editor, requestedTree);
        });
    }

    private enqueueJump(uri: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.jumpQueues.get(uri) ?? Promise.resolve();
        const result = previous.then(operation);
        const tail = result.then(
            () => undefined,
            () => undefined
        );
        this.jumpQueues.set(uri, tail);
        return result.finally(() => {
            if (this.jumpQueues.get(uri) === tail) {
                this.jumpQueues.delete(uri);
            }
        });
    }

    private async performJumpToNode(
        nodeId: number,
        target: vscode.TextEditor | vscode.TextDocument,
        tree?: UndoTree
    ): Promise<void> {
        const document = this.getEditTargetDocument(target);
        const t = tree ?? this.getTree(document.uri);
        const uriStr = document.uri.toString();
        const operationEpoch = this.managerEpoch;
        const node = t.nodes.get(nodeId);
        if (!node) {
            return;
        }
        if (this.managerEpoch !== operationEpoch || this.trees.get(uriStr) !== t) {
            return;
        }
        const jumpGeneration = (this.jumpGenerations.get(t) ?? 0) + 1;
        this.jumpGenerations.set(t, jumpGeneration);
        this.debugLog?.(`[jumpToNode] nodeId=${nodeId} storage=${node.storage.kind}`);
        const content = await this.reconstructContentAsync(t, nodeId);
        if (
            this.jumpGenerations.get(t) !== jumpGeneration
            || this.managerEpoch !== operationEpoch
            || this.trees.get(uriStr) !== t
            || t.nodes.get(nodeId) !== node
        ) {
            return;
        }
        const previousCurrentId = t.currentId;

        // Move the logical cursor before mutating the editor so any immediate
        // save/autosave is recorded as a branch from the selected node.
        t.currentId = nodeId;

        const restoreToken = this.beginRestoring(uriStr);
        try {
            const before = document.getText();
            const replacement = Math.max(before.length, content.length) >= 256 * 1024
                ? minimalTextEdit(before, content)
                : { offset: 0, removeLength: before.length, inserted: content };
            const range = new vscode.Range(
                document.positionAt(replacement.offset),
                document.positionAt(replacement.offset + replacement.removeLength)
            );
            const applied = this.isTextEditorTarget(target)
                ? await target.edit((eb) => eb.replace(range, replacement.inserted))
                : await this.applyDocumentEdit(document, range, replacement.inserted);
            if (!applied) {
                if (this.jumpGenerations.get(t) === jumpGeneration && t.currentId === nodeId) {
                    t.currentId = previousCurrentId;
                }
                return;
            }
        } catch (error) {
            if (this.jumpGenerations.get(t) === jumpGeneration && t.currentId === nodeId) {
                t.currentId = previousCurrentId;
            }
            throw error;
        } finally {
            this.endRestoring(uriStr, restoreToken);
        }

        if (this.managerEpoch !== operationEpoch) {
            // Reset/import replaced the resident history while the edit was in
            // flight. The edit cannot be undone here, so reconcile the fresh
            // tree to the document that actually won instead of finalizing the
            // obsolete tree or suppression hash.
            this.syncDocumentState(document.uri, document.getText(), 'jump');
            return;
        }
        if (this.trees.get(uriStr) !== t) {
            // The same URI can also be replaced without a full manager reset
            // (for example by importTree). Reconcile that replacement just as
            // we do for an epoch change after an already-applied editor edit.
            this.syncDocumentState(document.uri, document.getText(), 'jump');
            return;
        }

        // A newer jump may have completed while this editor edit was pending.
        // Do not let the stale completion replace its suppression hash or mark
        // the wrong logical selection as the finalized jump.
        if (this.jumpGenerations.get(t) !== jumpGeneration) {
            return;
        }

        // A save may have been recorded while the editor edit was awaiting
        // completion. Finalize the cursor against the contents that actually
        // won, without discarding the saved checkpoint or a real user branch.
        if (t.currentId !== nodeId) {
            const actualContent = document.getText();
            if (actualContent === content) {
                t.currentId = nodeId;
            } else {
                this.syncDocumentState(document.uri, actualContent, 'jump');
            }
        }
        this.diffBuffer.delete(uriStr);
        this.jumpSuppressedHashes.set(uriStr, t.nodes.get(t.currentId)!.hash);
        this.markDirtyKey(uriStr);
        this.onRefresh?.();
    }

    private getEditTargetDocument(target: vscode.TextEditor | vscode.TextDocument): vscode.TextDocument {
        return 'document' in target ? target.document : target;
    }

    private isTextEditorTarget(target: vscode.TextEditor | vscode.TextDocument): target is vscode.TextEditor {
        return 'document' in target && typeof target.edit === 'function';
    }

    private async applyDocumentEdit(
        document: vscode.TextDocument,
        range: vscode.Range,
        content: string
    ): Promise<boolean> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, content);
        return vscode.workspace.applyEdit(edit);
    }

    compact(tree: UndoTree): number {
        let removed = 0;
        while (true) {
            const candidates = Array.from(tree.nodes.values())
                .filter((node) => this.isCompressible(tree, node))
                .map((node) => node.id);
            if (candidates.length === 0) {
                break;
            }
            let passRemoved = 0;
            for (const nodeId of candidates) {
                const node = tree.nodes.get(nodeId);
                if (!node || !this.isCompressible(tree, node)) {
                    continue;
                }
                this.removeNode(tree, node);
                removed++;
                passRemoved++;
            }
            if (passRemoved === 0) {
                break;
            }
        }
        if (removed > 0) {
            if (this.markTreeDirty(tree) !== undefined) {
                this.onRefresh?.();
            }
        }
        return removed;
    }

    compactWithOverrides(tree: UndoTree, overrides: Map<number, 'remove' | 'keep'>): CompactApplyResult {
        let removed = 0;
        while (true) {
            const candidates = Array.from(tree.nodes.values())
                .filter((node) => {
                    if (overrides.get(node.id) === 'keep') {
                        return false;
                    }
                    if (overrides.get(node.id) === 'remove') {
                        return this.canManuallyRemove(tree, node);
                    }
                    return this.isCompressible(tree, node);
                })
                .map((node) => node.id);
            if (candidates.length === 0) {
                break;
            }
            let passRemoved = 0;
            for (const nodeId of candidates) {
                const node = tree.nodes.get(nodeId);
                if (!node) {
                    continue;
                }
                if (overrides.get(node.id) === 'keep') {
                    continue;
                }
                if (overrides.get(node.id) === 'remove' && this.canManuallyRemove(tree, node)) {
                    this.removeNode(tree, node);
                    removed++;
                    passRemoved++;
                    continue;
                }
                if (overrides.get(node.id) !== 'remove' && this.isCompressible(tree, node)) {
                    this.removeNode(tree, node);
                    removed++;
                    passRemoved++;
                }
            }
            if (passRemoved === 0) {
                break;
            }
        }
        const skipped = Array.from(overrides.entries()).filter(([id, action]) =>
            action === 'remove' && tree.nodes.has(id) && !this.canManuallyRemove(tree, tree.nodes.get(id)!)
        ).length;
        if (removed > 0) {
            if (this.markTreeDirty(tree) !== undefined) {
                this.onRefresh?.();
            }
        }
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

    exportState(uris: Iterable<string> = this.trees.keys()): SerializedUndoTreeState {
        const trees: Record<string, SerializedUndoTree> = {};
        for (const key of uris) {
            const tree = this.trees.get(key);
            if (!tree) { continue; }
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
                    ...(node.noteUpdatedAt !== undefined ? { noteUpdatedAt: node.noteUpdatedAt } : {}),
                    ...(node.pinned !== undefined ? { pinned: node.pinned } : {}),
                    ...(node.pinnedUpdatedAt !== undefined ? { pinnedUpdatedAt: node.pinnedUpdatedAt } : {}),
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
            if (typeof candidate.contentHash !== 'string' || !isValidContentHash(candidate.contentHash)) {
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
        if (candidate.noteUpdatedAt !== undefined) {
            if (typeof candidate.noteUpdatedAt !== 'number' || !Number.isFinite(candidate.noteUpdatedAt) || candidate.noteUpdatedAt < 0) {
                throw new Error('Invalid note update timestamp');
            }
            result.noteUpdatedAt = candidate.noteUpdatedAt;
        }
        if (candidate.pinned !== undefined) {
            if (typeof candidate.pinned !== 'boolean') {
                throw new Error('Invalid pinned flag');
            }
            result.pinned = candidate.pinned;
        }
        if (candidate.pinnedUpdatedAt !== undefined) {
            if (typeof candidate.pinnedUpdatedAt !== 'number' || !Number.isFinite(candidate.pinnedUpdatedAt) || candidate.pinnedUpdatedAt < 0) {
                throw new Error('Invalid pin update timestamp');
            }
            result.pinnedUpdatedAt = candidate.pinnedUpdatedAt;
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

        const visited = new Set<number>([rootId]);
        const active = new Set<number>([rootId]);
        const stack: Array<{ nodeId: number; childIndex: number }> = [{ nodeId: rootId, childIndex: 0 }];

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const node = nodes.get(frame.nodeId);
            const children = node?.children ?? [];
            if (frame.childIndex >= children.length) {
                active.delete(frame.nodeId);
                stack.pop();
                continue;
            }

            const childId = children[frame.childIndex++];
            if (active.has(childId)) {
                return true;
            }
            if (visited.has(childId)) {
                continue;
            }
            visited.add(childId);
            active.add(childId);
            stack.push({ nodeId: childId, childIndex: 0 });
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
        this.managerEpoch++;
        this.pendingSaves.clear();
        this.pendingSaveRecords.clear();
        this.checkpointCompressionQueue.clear();
        this.trees.clear();
        this.diffBuffer.clear();
        this.forceFullSnapshotUris.clear();
        this.restoringByUri.clear();
        this.dirtyTrees.clear();
        this.mutationGenerations.clear();
        this.pendingCheckpointGenerations.clear();
        this.lastAccessAt.clear();
        this.lastMetadataRevision = 0;
        this.evictCache(0);

        this.nextId = Math.max(1, state.nextId);
        for (const [key, tree] of Object.entries(state.trees)) {
            const importedTree = this.deserializeTree(tree);
            this.nextId = nextIdAfterNodes(importedTree.nodes.values(), this.nextId);
            this.trees.set(key, importedTree);
            this.observeMetadataRevisions(importedTree);
            this.lastAccessAt.set(key, Date.now());
        }
        this.pruneCompressedCheckpoints();

        this.onRefresh?.();
    }

    importTree(uri: string, tree: SerializedUndoTree, nextId?: number) {
        const importedTree = this.deserializeTree(tree);
        this.trees.set(uri, importedTree);
        this.pruneCompressedCheckpoints();
        this.observeMetadataRevisions(importedTree);
        this.lastAccessAt.set(uri, Date.now());

        const hint = typeof nextId === 'number' && Number.isFinite(nextId) ? nextId : 1;
        this.nextId = nextIdAfterNodes(importedTree.nodes.values(), Math.max(this.nextId, hint));
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
        const key = uri.toString();
        const tree = this.trees.get(key);
        if (!tree) {
            return;
        }
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        const trimmed = note.trim();
        const nextNote = trimmed || undefined;
        if (node.note === nextNote && nextNote !== undefined) {
            return;
        }
        node.note = nextNote;
        node.noteUpdatedAt = this.nextMetadataRevision();
        this.markDirtyKey(key);
        this.onRefresh?.();
    }

    setPinned(uri: vscode.Uri, nodeId: number, pinned: boolean): void {
        const key = uri.toString();
        const tree = this.trees.get(key);
        if (!tree) {
            return;
        }
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        const nextPinned = pinned || undefined;
        if (node.pinned === nextPinned && nextPinned !== undefined) {
            return;
        }
        node.pinned = nextPinned;
        node.pinnedUpdatedAt = this.nextMetadataRevision();
        this.markDirtyKey(key);
        this.onRefresh?.();
    }

    togglePinned(uri: vscode.Uri, nodeId: number): void {
        const key = uri.toString();
        const tree = this.trees.get(key);
        if (!tree) {
            return;
        }
        const node = tree.nodes.get(nodeId);
        if (!node) {
            return;
        }
        node.pinned = !node.pinned || undefined;
        node.pinnedUpdatedAt = this.nextMetadataRevision();
        this.markDirtyKey(key);
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

    syncLoadedDocumentState(uri: vscode.Uri, content: string, fromCapturedSnapshot = false): UndoTree {
        const key = uri.toString();
        // A live document already includes changes received during loading.
        // Captured open/save snapshots predate the changes still in the buffer.
        if (!fromCapturedSnapshot && this.diffBuffer.delete(key)) {
            this.forceFullSnapshotUris.add(key);
        }
        return this.syncDocumentState(uri, content, 'restore', false, undefined, fromCapturedSnapshot);
    }

    syncDocumentState(
        uri: vscode.Uri,
        content: string,
        label = 'restore',
        preserveRoot = false,
        diffs?: Diff[][],
        preserveBufferedChanges = false,
    ): UndoTree {
        const key = uri.toString();
        if (this.pendingSaves.has(key)) { this.forceFullSnapshotUris.add(key); }
        const tree = preserveRoot ? this.trees.get(key) ?? this.getTree(uri, content) : this.getTree(uri, content);
        const currentContent = this.reconstructContent(tree, tree.currentId);
        if (currentContent === content) {
            return tree;
        }

        const reusableId = this.findReusableNodeForContent(tree, content);
        if (reusableId !== undefined) {
            if (tree.currentId !== reusableId) {
                tree.currentId = reusableId;
                this.markDirtyKey(key);
            }
            if (!preserveBufferedChanges) { this.diffBuffer.delete(key); }
            this.onRefresh?.();
            return tree;
        }

        const currentNode = tree.nodes.get(tree.currentId)!;
        const newId = this.nextId++;
        const node: UndoNode = {
            id: newId,
            parents: [tree.currentId],
            children: [],
            timestamp: Date.now(),
            label,
            hash: this.hashContent(content),
            storage: diffs && !this.shouldStoreFull(diffs, content.length)
                ? { kind: 'delta', diffs } : { kind: 'full', content },
            ...this.computeSizeMetrics(content),
        };

        currentNode.children.push(newId);
        tree.nodes.set(newId, node);
        tree.hashMap.set(node.hash, newId);
        tree.currentId = newId;
        const generation = this.markDirtyKey(key);
        if (currentNode.children.length >= 2) {
            this.upgradeStorage(tree, currentNode.id, currentContent, key, generation);
        } else if (currentNode.storage.kind === 'full' && currentNode.storage.content.length >= MIN_COMPRESSED_SNAPSHOT_CHARS) {
            this.upgradeStorage(tree, currentNode.id, currentNode.storage.content, key, generation);
        }
        if (!preserveBufferedChanges) { this.diffBuffer.delete(key); }
        this.onRefresh?.();
        return tree;
    }

    private findReusableNodeForContent(tree: UndoTree, content: string): number | undefined {
        const hash = this.hashContent(content);
        const candidateId = tree.hashMap.get(hash);
        if (candidateId === undefined) {
            return undefined;
        }
        const candidate = tree.nodes.get(candidateId);
        if (!candidate) {
            return undefined;
        }
        // Reopening a file can return to a saved ancestor while the persisted
        // cursor is at an unsaved autosave/undo state. Reuse that ancestor and
        // retain its future instead of appending the same restore repeatedly.
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
        const toDelete = this.collectHardCompactNodeIds(tree, maxAgeDays);
        this.deleteHardCompactNodes(tree, toDelete);
        return toDelete.size;
    }

    hardCompactWithOverrides(tree: UndoTree, maxAgeDays: number, overrides: Map<number, 'remove' | 'keep'>): CompactApplyResult {
        const toDelete = this.collectHardCompactNodeIds(tree, maxAgeDays, overrides);
        const skipped = Array.from(overrides.entries()).filter(([id, action]) =>
            action === 'remove' && tree.nodes.has(id) && !toDelete.has(id)
        ).length;
        this.deleteHardCompactNodes(tree, toDelete);
        return { removed: toDelete.size, skipped };
    }

    private deleteHardCompactNodes(tree: UndoTree, toDelete: Set<number>): void {
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
            if (this.markTreeDirty(tree) !== undefined) {
                this.onRefresh?.();
            }
        }
    }

    previewHardCompact(tree: UndoTree, maxAgeDays: number): number {
        return this.hardCompact(this.cloneTree(tree), maxAgeDays);
    }

    previewHardCompactDetailed(tree: UndoTree, maxAgeDays: number): CompactPreviewResult {
        const context = this.getHardCompactContext(tree);
        const removableIds = this.collectHardCompactNodeIds(tree, maxAgeDays, undefined, context);
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
                protectedItems.push(this.toCompactPreviewItem(tree, node, this.getHardCompactProtectReason(tree, node, maxAgeDays, context)));
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

    private getHardCompactContext(tree: UndoTree) {
        const latestNodeId = this.getLatestNodeId(tree);
        const currentAncestors = this.collectCurrentAncestors(tree);
        const latestAncestors = new Set<number>();
        let latestAncestorId: number | undefined = latestNodeId;
        while (latestAncestorId !== undefined) {
            if (latestAncestors.has(latestAncestorId)) { break; }
            latestAncestors.add(latestAncestorId);
            const node = tree.nodes.get(latestAncestorId);
            latestAncestorId = node && node.parents.length > 0 ? node.parents[node.parents.length - 1] : undefined;
        }
        const hasNotedAncestor = this.collectNotedAncestors(tree);
        const hasPinnedAncestor = this.collectPinnedAncestors(tree);
        return { now: Date.now(), latestNodeId, currentAncestors, latestAncestors, hasNotedAncestor, hasPinnedAncestor };
    }

    private collectHardCompactNodeIds(
        tree: UndoTree, maxAgeDays: number, overrides?: Map<number, 'remove' | 'keep'>,
        context = this.getHardCompactContext(tree)
    ): Set<number> {
        const thresholdMs = maxAgeDays * 86_400_000;
        const { now, latestNodeId, currentAncestors, latestAncestors, hasNotedAncestor, hasPinnedAncestor } = context;
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

        // Deleting an expired parent as a subtree must not bypass retention for
        // a newer descendant. Keep the ancestor chain of every in-window node;
        // the node itself remains manually removable when explicitly selected.
        const recentDescendantAncestors = new Set<number>();
        for (const node of tree.nodes.values()) {
            if ((now - node.timestamp) > thresholdMs) { continue; }
            const visited = new Set<number>();
            let ancestorId: number | undefined = node.parents.length > 0
                ? node.parents[node.parents.length - 1]
                : undefined;
            while (ancestorId !== undefined) {
                if (visited.has(ancestorId) || recentDescendantAncestors.has(ancestorId)) { break; }
                visited.add(ancestorId);
                recentDescendantAncestors.add(ancestorId);
                const ancestor = tree.nodes.get(ancestorId);
                ancestorId = ancestor && ancestor.parents.length > 0
                    ? ancestor.parents[ancestor.parents.length - 1]
                    : undefined;
            }
        }

        const toDelete = new Set<number>();
        const visited = new Set<number>();
        const traversal: number[] = [tree.rootId];

        while (traversal.length > 0) {
            const nodeId = traversal.pop()!;
            if (visited.has(nodeId)) { continue; }
            visited.add(nodeId);
            const node = tree.nodes.get(nodeId);
            if (!node) { continue; }

            const isProtected = nodeId === tree.rootId
                || currentAncestors.has(nodeId)
                || nodeId === latestNodeId
                || latestAncestors.has(nodeId)
                || hasNotedAncestor.has(nodeId)
                || hasPinnedAncestor.has(nodeId)
                || keptAncestors.has(nodeId)
                || recentDescendantAncestors.has(nodeId);
            const forceRemove = overrides?.get(nodeId) === 'remove' && !isProtected;
            const isExpired = (now - node.timestamp) > thresholdMs;

            if (forceRemove || (isExpired && !isProtected)) {
                const subtree: number[] = [nodeId];
                const subtreeVisited = new Set<number>();
                while (subtree.length > 0) {
                    const descendantId = subtree.pop()!;
                    if (subtreeVisited.has(descendantId)) { continue; }
                    subtreeVisited.add(descendantId);
                    const descendant = tree.nodes.get(descendantId);
                    if (!descendant) { continue; }
                    toDelete.add(descendantId);
                    subtree.push(...descendant.children);
                }
                continue;
            }

            traversal.push(...node.children);
        }
        return toDelete;
    }

    private getHardCompactProtectReason(
        tree: UndoTree, node: UndoNode, maxAgeDays: number,
        context: ReturnType<UndoTreeManager['getHardCompactContext']>
    ): string {
        const thresholdMs = maxAgeDays * 86_400_000;
        const { now, latestNodeId, currentAncestors, latestAncestors, hasNotedAncestor, hasPinnedAncestor } = context;
        const ageMs = now - node.timestamp;
        if (node.id === tree.currentId) {
            return 'current node';
        }
        if (node.id === latestNodeId) {
            return 'latest node';
        }
        if (latestAncestors.has(node.id)) {
            return 'ancestor of latest node';
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
        this.managerEpoch++;
        this.pendingSaves.clear();
        this.pendingSaveRecords.clear();
        this.checkpointCompressionQueue.clear();
        this.compressedCheckpoints.clear();
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
        }
        this.trees.clear();
        this.diffBuffer.clear();
        this.forceFullSnapshotUris.clear();
        this.restoringByUri.clear();
        this.dirtyTrees.clear();
        this.mutationGenerations.clear();
        this.pendingCheckpointGenerations.clear();
        this.lastAccessAt.clear();
        this.jumpSuppressedHashes.clear();
        this.contentCache.clear();
        this.contentCacheBytes = 0;
    }
}
