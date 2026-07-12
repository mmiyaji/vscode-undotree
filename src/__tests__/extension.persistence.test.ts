import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { gunzipSync } from 'zlib';
import type { SerializedUndoTree } from '../undoTreeManager';
import { UndoTreeManager } from '../undoTreeManager';

jest.mock('vscode');

function makeTree(nodes: SerializedUndoTree['nodes'], currentId: number, rootId = 0): SerializedUndoTree {
    return {
        nodes,
        currentId,
        rootId,
        hashMap: nodes.map((node) => [node.hash, node.id]),
    };
}

function hash(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex');
}

describe('persisted storage integration', () => {
    jest.setTimeout(15_000);

    let tempDir: string;

    beforeEach(async () => {
        jest.resetModules();
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'undotree-persist-'));
        const vscode = require('vscode');
        vscode.window.showWarningMessage.mockReset();
        vscode.workspace.getConfiguration.mockImplementation(() => ({
            get: jest.fn((key: string) => {
                const defaults: Record<string, unknown> = {
                    compressionThresholdKB: 100,
                    checkpointThresholdKB: 1000,
                    persistenceMode: 'manual',
                };
                return defaults[key];
            }),
        }));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('merges persisted and in-memory trees when they share the same root (manual -> auto/save path)', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///merge.md';

        const persisted = makeTree([
            {
                id: 0, parents: [], children: [1, 2], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'persisted-a',
                storage: { kind: 'full', content: 'persisted A' }, lineCount: 1, byteCount: 11,
            },
            {
                id: 2, parents: [0], children: [], timestamp: 3, label: 'save', hash: 'persisted-b',
                storage: { kind: 'full', content: 'persisted B' }, lineCount: 1, byteCount: 11,
            },
        ], 2);

        await extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: persisted },
        }, false);

        const incoming = makeTree([
            {
                id: 0, parents: [], children: [1, 3], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 4, label: 'save', hash: 'persisted-a',
                storage: { kind: 'full', content: 'persisted A' }, lineCount: 1, byteCount: 11,
            },
            {
                id: 3, parents: [0], children: [], timestamp: 5, label: 'save', hash: 'memory-c',
                storage: { kind: 'full', content: 'memory C' }, lineCount: 1, byteCount: 8,
            },
        ], 3);

        await extension.__test__.persistStateToDisk(context, {
            nextId: 4,
            trees: { [uri]: incoming },
        }, false);

        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 1, 2, 3]);
        expect(loaded?.tree.nodes.find((node) => node.id === 0)?.children).toEqual(expect.arrayContaining([1, 2, 3]));
        expect(loaded?.tree.currentId).toBe(3);
    });

    it('keeps existing persisted history and warns when roots do not match', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const vscode = require('vscode');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///mismatch.md';

        const persisted = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-a',
                storage: { kind: 'full', content: 'root a' }, lineCount: 1, byteCount: 6,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'persisted-a',
                storage: { kind: 'full', content: 'persisted A' }, lineCount: 1, byteCount: 11,
            },
        ], 1);

        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: persisted },
        }, false);

        const incoming = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-b',
                storage: { kind: 'full', content: 'root b' }, lineCount: 1, byteCount: 6,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'incoming-b',
                storage: { kind: 'full', content: 'incoming B' }, lineCount: 1, byteCount: 10,
            },
        ], 1);

        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: incoming },
        }, false);

        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.find((node) => node.id === 0)?.hash).toBe('root-a');
        expect(loaded?.tree.nodes.find((node) => node.id === 1)?.hash).toBe('persisted-a');
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });

    it('rejects checkpoint content hashes that are not hex file names', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///bad-checkpoint.md';

        const tree = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: '01234567',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'checkpoint', hash: '89abcdef',
                storage: { kind: 'checkpoint', contentHash: '..\\..\\outside' }, lineCount: 1, byteCount: 8,
            },
        ], 1);

        await expect(extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false)).rejects.toThrow('Invalid checkpoint content hash');
    });

    it('keeps checkpoint blobs referenced by clean resident trees during a partial save', async () => {
        const vscode = require('vscode');
        vscode.workspace.getConfiguration.mockImplementation(() => ({
            get: jest.fn((key: string) => ({
                compressionThresholdKB: 100,
                checkpointThresholdKB: 0,
                persistenceMode: 'auto',
            } as Record<string, unknown>)[key]),
        }));
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uriA = 'file:///a.md';
        const uriB = 'file:///b.md';
        const rootA = 'root-a';
        const savedA = 'saved-a';
        const rootB = 'root-b';
        const savedB = 'saved-b';
        const treeA = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: hash(rootA),
                storage: { kind: 'full', content: rootA }, lineCount: 1, byteCount: rootA.length,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: hash(savedA),
                storage: { kind: 'full', content: savedA }, lineCount: 1, byteCount: savedA.length,
            },
        ], 1);
        const treeB = makeTree([
            {
                id: 2, parents: [], children: [3], timestamp: 1, label: 'initial', hash: hash(rootB),
                storage: { kind: 'full', content: rootB }, lineCount: 1, byteCount: rootB.length,
            },
            {
                id: 3, parents: [2], children: [], timestamp: 2, label: 'save', hash: hash(savedB),
                storage: { kind: 'full', content: savedB }, lineCount: 1, byteCount: savedB.length,
            },
        ], 3, 2);

        await extension.__test__.persistStateToDisk(context, {
            nextId: 4,
            trees: { [uriA]: treeA, [uriB]: treeB },
        }, false);

        const newerA = makeTree([
            ...treeA.nodes.map((node) => ({ ...node, parents: [...node.parents], children: [...node.children] })),
            {
                id: 4, parents: [1], children: [], timestamp: 3, label: 'save', hash: hash('newer-a'),
                storage: { kind: 'full' as const, content: 'newer-a' }, lineCount: 1, byteCount: 7,
            },
        ], 4);
        newerA.nodes.find((node) => node.id === 1)!.children = [4];
        newerA.hashMap = newerA.nodes.map((node) => [node.hash, node.id]);

        await extension.__test__.persistStateToDisk(context, {
            nextId: 5,
            trees: { [uriA]: newerA, [uriB]: treeB },
        }, false, new Set([uriA]));

        const contentDir = path.join(tempDir, 'undo-trees', 'content');
        await expect(fs.access(path.join(contentDir, hash(rootB)))).resolves.toBeUndefined();
        await expect(fs.access(path.join(contentDir, hash(savedB)))).resolves.toBeUndefined();
        const loadedB = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uriB } as any);
        expect(loadedB?.tree.nodes).toHaveLength(2);
    });

    it('serializes overlapping saves so the newer invocation is the final snapshot', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///serialized.md';
        const older = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'older',
                storage: { kind: 'full', content: 'older' }, lineCount: 1, byteCount: 5,
            },
        ], 1);
        const newer = makeTree([
            ...older.nodes.map((node) => ({ ...node, parents: [...node.parents], children: [...node.children] })),
            {
                id: 2, parents: [1], children: [], timestamp: 3, label: 'save', hash: 'newer',
                storage: { kind: 'full' as const, content: 'newer' }, lineCount: 1, byteCount: 5,
            },
        ], 2);
        newer.nodes.find((node) => node.id === 1)!.children = [2];
        newer.hashMap = newer.nodes.map((node) => [node.hash, node.id]);

        const olderSave = extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: older },
        }, false);
        const newerSave = extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: newer },
        }, false);
        await Promise.all([olderSave, newerSave]);

        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 1, 2]);
        expect(loaded?.tree.currentId).toBe(2);
    });

    it('uses an authoritative replacement for explicitly destructive saves', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///compact.md';
        const original = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [2], timestamp: 2, label: 'save', hash: 'middle',
                storage: { kind: 'full', content: 'middle' }, lineCount: 1, byteCount: 6,
            },
            {
                id: 2, parents: [1], children: [], timestamp: 3, label: 'save', hash: 'latest',
                storage: { kind: 'full', content: 'latest' }, lineCount: 1, byteCount: 6,
            },
        ], 2);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: original },
        }, false);

        const compacted = makeTree([
            { ...original.nodes[0], children: [2] },
            { ...original.nodes[2], parents: [0] },
        ], 2);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: compacted },
        }, false, undefined, new Set([uri]), new Map([
            [uri, { baseRevision: extension.__test__.getSerializedTreeRevision(original) }],
        ]));

        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 2]);
        expect(loaded?.tree.nodes[0].children).toEqual([2]);
    });

    it('abandons stale destructive deletion and preserves a concurrently added branch', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///compact-conflict.md';
        const base = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [2], timestamp: 2, label: 'save', hash: 'middle',
                storage: { kind: 'full', content: 'middle' }, lineCount: 1, byteCount: 6,
            },
            {
                id: 2, parents: [1], children: [], timestamp: 3, label: 'save', hash: 'latest',
                storage: { kind: 'full', content: 'latest' }, lineCount: 1, byteCount: 6,
            },
        ], 2);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: base },
        }, false);
        const staleBaseRevision = extension.__test__.getSerializedTreeRevision(base);

        const concurrent = makeTree([
            ...base.nodes.map((node) => ({ ...node, parents: [...node.parents], children: [...node.children] })),
            {
                id: 3, parents: [1], children: [], timestamp: 4, label: 'save', hash: 'concurrent',
                storage: {
                    kind: 'delta' as const,
                    diffs: [[{ offset: 6, removeLength: 0, inserted: '!' }]],
                },
                lineCount: 1, byteCount: 7,
            },
        ], 3);
        concurrent.nodes.find((node) => node.id === 1)!.children = [2, 3];
        concurrent.hashMap = concurrent.nodes.map((node) => [node.hash, node.id]);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 4,
            trees: { [uri]: concurrent },
        }, false);

        const staleCompacted = makeTree([
            { ...base.nodes[0], children: [2] },
            { ...base.nodes[2], parents: [0] },
        ], 2);
        const result = await extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: staleCompacted },
        }, false, undefined, new Set([uri]), new Map([
            [uri, { baseRevision: staleBaseRevision }],
        ]));

        expect(result.unpersistedUris.has(uri)).toBe(false);
        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 1, 2, 3]);
        expect(loaded?.tree.nodes.find((node) => node.id === 3)?.parents).toEqual([1]);
        const manager = new UndoTreeManager();
        manager.importTree(uri, loaded!.tree, loaded!.nextId);
        expect(manager.reconstructContent(manager.getTree({ toString: () => uri } as any), 3)).toBe('middle!');
        manager.dispose();
    });

    it('does not resurrect compacted nodes and writes a durable recovery snapshot for stale history', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const vscode = require('vscode');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///generation-conflict.md';
        const base = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [2], timestamp: 2, label: 'save', hash: 'middle',
                storage: { kind: 'full', content: 'middle' }, lineCount: 1, byteCount: 6,
            },
            {
                id: 2, parents: [1], children: [], timestamp: 3, label: 'save', hash: 'latest',
                storage: { kind: 'full', content: 'latest' }, lineCount: 1, byteCount: 6,
            },
        ], 2);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 3,
            trees: { [uri]: base },
        }, false);

        const staleWriter = makeTree([
            ...base.nodes.map((node) => ({ ...node, parents: [...node.parents], children: [...node.children] })),
            {
                id: 3, parents: [2], children: [], timestamp: 4, label: 'save', hash: 'branch-current',
                storage: { kind: 'full' as const, content: 'branch-current' }, lineCount: 1, byteCount: 14,
            },
        ], 3);
        staleWriter.nodes.find((node) => node.id === 2)!.children = [3];
        staleWriter.hashMap = staleWriter.nodes.map((node) => [node.hash, node.id]);

        const compacted = makeTree([
            { ...base.nodes[0], children: [2] },
            { ...base.nodes[2], parents: [0] },
        ], 2);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 50,
            trees: { [uri]: compacted },
        }, false, undefined, new Set([uri]), new Map([
            [uri, { baseRevision: extension.__test__.getSerializedTreeRevision(base) }],
        ]));

        const staleResult = await extension.__test__.persistStateToDisk(context, {
            nextId: 4,
            trees: { [uri]: staleWriter },
        }, false);
        expect(staleResult.staleDestructiveGenerationUris.has(uri)).toBe(true);
        let loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.destructiveGeneration).toBe(1);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 2]);
        const manifestAfterConflict = await extension.__test__.readPersistedManifest(context);
        expect(manifestAfterConflict.manifest?.nextId).toBe(50);

        const conflictPath = staleResult.conflictPersistedPathsByUri.get(uri);
        expect(conflictPath).toBeDefined();
        const conflictPayload = JSON.parse(
            gunzipSync(await fs.readFile(conflictPath!)).toString('utf8')
        ) as {
            uri: string;
            actualTreeRevision: string;
            tree: SerializedUndoTree;
        };
        expect(conflictPayload.uri).toBe(uri);
        expect(conflictPayload.actualTreeRevision).toBe(
            extension.__test__.getSerializedTreeRevision(compacted)
        );
        expect(conflictPayload.tree.nodes.map((node) => node.id)).toEqual([0, 1, 2, 3]);
        expect(conflictPayload.tree.nodes.every((node) => node.storage.kind === 'full')).toBe(true);

        const latestLocal = makeTree([
            ...staleWriter.nodes.map((node) => ({
                ...node,
                parents: [...node.parents],
                children: [...node.children],
            })),
            {
                id: 4, parents: [3], children: [], timestamp: 5, label: 'save', hash: 'branch-newest',
                storage: { kind: 'full' as const, content: 'branch-newest' }, lineCount: 1, byteCount: 13,
            },
        ], 4);
        latestLocal.nodes.find((node) => node.id === 3)!.children = [4];
        latestLocal.hashMap = latestLocal.nodes.map((node) => [node.hash, node.id]);
        const latestConflictResult = await extension.__test__.persistStateToDisk(context, {
            nextId: 5,
            trees: { [uri]: latestLocal },
        }, false);
        expect(latestConflictResult.conflictPersistedPathsByUri.get(uri)).toBe(conflictPath);
        const latestConflictPayload = JSON.parse(
            gunzipSync(await fs.readFile(conflictPath!)).toString('utf8')
        ) as { tree: SerializedUndoTree };
        expect(latestConflictPayload.tree.nodes.map((node) => node.id)).toEqual([0, 1, 2, 3, 4]);
        expect(latestConflictPayload.tree.nodes.find((node) => node.id === 4)?.storage).toEqual({
            kind: 'full',
            content: 'branch-newest',
        });
        expect((await extension.__test__.readPersistedManifest(context)).manifest?.nextId).toBe(50);

        const staleManager = new UndoTreeManager();
        staleManager.importTree(uri, latestLocal, 5);
        staleManager.markDirty({ toString: () => uri } as any);
        const document = {
            uri: { toString: () => uri },
            fileName: 'generation-conflict.md',
            isUntitled: false,
            getText: () => 'branch-newest',
        };
        vscode.workspace.textDocuments = [document];
        extension.__test__.setManagerForTest(staleManager);
        await extension.__test__.rebaseStaleDestructiveGenerationUris(
            context,
            { manager: staleManager } as any,
            latestConflictResult.staleDestructiveGenerationUris,
            latestConflictResult.persistedDestructiveGenerationsByUri,
            latestConflictResult.conflictPersistedPathsByUri
        );
        const retained = staleManager.getTree(document.uri as any);
        expect(retained.nodes.has(1)).toBe(true);
        expect(retained.nodes.has(3)).toBe(true);
        expect(retained.nodes.has(4)).toBe(true);
        expect(staleManager.reconstructContent(retained, retained.currentId)).toBe('branch-newest');
        expect(staleManager.getDirtyUris().has(uri)).toBe(true);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining(conflictPath!),
            'Open Storage Folder'
        );

        extension.__test__.setManagerForTest(undefined);
        vscode.workspace.textDocuments = [];
        staleManager.dispose();
        loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 2]);
    });

    it('fails closed when a destructive CAS cannot load the existing tree file', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///compact-missing.md';
        const base = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'saved',
                storage: { kind: 'full', content: 'saved' }, lineCount: 1, byteCount: 5,
            },
        ], 1);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: base },
        }, false);
        const manifest = await extension.__test__.readPersistedManifest(context);
        const file = manifest.manifest?.trees.find((entry) => entry.uri === uri)?.file;
        expect(file).toBeDefined();
        await fs.rm(path.join(tempDir, 'undo-trees', file!), { force: true });

        const result = await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: base },
        }, false, undefined, new Set([uri]), new Map([
            [uri, { baseRevision: extension.__test__.getSerializedTreeRevision(base) }],
        ]));

        expect(result.unpersistedUris.has(uri)).toBe(true);
        await expect(fs.access(path.join(tempDir, 'undo-trees', file!))).rejects.toBeDefined();
    });

    it('persists note clearing and unpinning while retaining additive branch merge', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///metadata.md';
        const noted = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'saved',
                storage: { kind: 'full', content: 'saved' }, lineCount: 1, byteCount: 5,
                note: 'keep this', noteUpdatedAt: 10, pinned: true, pinnedUpdatedAt: 10,
            },
        ], 1);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: noted },
        }, false);

        const cleared = makeTree(noted.nodes.map((node) => {
            const clone = { ...node, parents: [...node.parents], children: [...node.children] };
            delete clone.note;
            delete clone.pinned;
            if (clone.id === 1) {
                clone.noteUpdatedAt = 20;
                clone.pinnedUpdatedAt = 20;
            }
            return clone;
        }), 1);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: cleared },
        }, false);

        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.find((node) => node.id === 1)?.note).toBeUndefined();
        expect(loaded?.tree.nodes.find((node) => node.id === 1)?.pinned).toBeUndefined();
    });

    it('serializes storage mutations with the shared filesystem lock', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const events: string[] = [];
        let releaseFirst!: () => void;
        let signalFirstStarted!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            signalFirstStarted = resolve;
        });

        const first = extension.__test__.withPersistStorageLock(context, async () => {
            events.push('first:start');
            signalFirstStarted();
            await firstGate;
            events.push('first:end');
        });
        await firstStarted;
        const second = extension.__test__.withPersistStorageLock(context, async () => {
            events.push('second');
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(events).toEqual(['first:start']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second']);
    });

    it('recovers a dead-owner lock with only one storage mutation active at a time', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const lockPath = path.join(tempDir, '.undo-trees.persist.lock');
        await fs.writeFile(lockPath, JSON.stringify({
            owner: 'dead-test-owner',
            pid: 999_999,
            createdAt: Date.now() - 5_000,
        }));
        const old = new Date(Date.now() - 5_000);
        await fs.utimes(lockPath, old, old);
        let active = 0;
        let maxActive = 0;
        const operation = () => extension.__test__.withPersistStorageLock(context, async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 25));
            active--;
        });

        await Promise.all([operation(), operation()]);
        expect(maxActive).toBe(1);
        await expect(fs.access(lockPath)).rejects.toBeDefined();
    });

    it('loads the previous tree generation during the atomic replace rename gap', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///rename-gap.md';
        const tree = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'saved',
                storage: { kind: 'full', content: 'saved' }, lineCount: 1, byteCount: 5,
            },
        ], 1);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false);
        const manifest = await extension.__test__.readPersistedManifest(context);
        const file = manifest.manifest?.trees.find((entry) => entry.uri === uri)?.file;
        expect(file).toBeDefined();
        const treePath = path.join(tempDir, 'undo-trees', file!);
        await fs.rename(treePath, `${treePath}.bak-write`);

        const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, { toString: () => uri } as any);
        expect(loaded?.tree.nodes.map((node) => node.id)).toEqual([0, 1]);
    });

    it('does not let a stale window recreate history after another window resets storage', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///epoch-reset.md';
        const tree = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'saved',
                storage: { kind: 'full', content: 'saved' }, lineCount: 1, byteCount: 5,
            },
        ], 1);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false);

        await extension.__test__.simulateExternalStorageReset(context);
        const staleWriteOne = extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false);
        const staleWriteTwo = extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false);
        const [staleResultOne, staleResultTwo] = await Promise.all([staleWriteOne, staleWriteTwo]);

        expect('skippedForStorageEpoch' in staleResultOne).toBe(true);
        expect('skippedForStorageEpoch' in staleResultTwo).toBe(true);
        expect((await extension.__test__.readPersistedManifest(context)).manifest).toBeUndefined();
        await expect(fs.access(path.join(tempDir, 'undo-trees'))).rejects.toBeDefined();
    });

    it('finishes an interrupted reset before accepting another persistence request', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = 'file:///interrupted-reset.md';
        const tree = makeTree([
            {
                id: 0, parents: [], children: [1], timestamp: 1, label: 'initial', hash: 'root-hash',
                storage: { kind: 'full', content: 'root' }, lineCount: 1, byteCount: 4,
            },
            {
                id: 1, parents: [0], children: [], timestamp: 2, label: 'save', hash: 'saved',
                storage: { kind: 'full', content: 'saved' }, lineCount: 1, byteCount: 5,
            },
        ], 1);
        await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false);
        await extension.__test__.simulateInterruptedStorageReset(context);
        // The old tree still exists at this simulated crash point.
        expect((await extension.__test__.readPersistedManifest(context)).manifest).toBeDefined();

        const result = await extension.__test__.persistStateToDisk(context, {
            nextId: 2,
            trees: { [uri]: tree },
        }, false);
        expect('skippedForStorageEpoch' in result).toBe(true);
        expect((await extension.__test__.readPersistedManifest(context)).manifest).toBeUndefined();
    });
});
