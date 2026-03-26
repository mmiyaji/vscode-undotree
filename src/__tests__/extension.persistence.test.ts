import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SerializedUndoTree } from '../undoTreeManager';

jest.mock('vscode');

function makeTree(nodes: SerializedUndoTree['nodes'], currentId: number, rootId = 0): SerializedUndoTree {
    return {
        nodes,
        currentId,
        rootId,
        hashMap: nodes.map((node) => [node.hash, node.id]),
    };
}

describe('persisted storage integration', () => {
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
});
