import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomBytes } from 'crypto';
import { gzipSync } from 'zlib';
import { __test__ } from '../extension';
import type { SerializedUndoTree } from '../undoTreeManager';

jest.mock('vscode');

const hash = (text: string) => createHash('sha1').update(text).digest('hex');
const fileName = (uri: string) => `${hash(uri)}.json`;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function tree(content: string, id: number): SerializedUndoTree {
    const nodes: SerializedUndoTree['nodes'] = [
        { id: 0, parents: [], children: [id], timestamp: 1, label: 'initial', hash: hash('root'), storage: { kind: 'full', content: 'root' } },
        { id, parents: [0], children: [], timestamp: id + 1, label: 'save', hash: hash(content), storage: { kind: 'full', content } },
    ];
    return { rootId: 0, currentId: id, nodes, hashMap: nodes.map(node => [node.hash, node.id]) };
}

describe('persistence with accumulated histories', () => {
    jest.setTimeout(60_000);

    it.each([0, 100, 1000])('saves one active file with %i closed histories without decoding them', async count => {
        const vscode = require('vscode');
        vscode.workspace.getConfiguration.mockImplementation(() => ({ get: (key: string) => ({
            persistenceMode: 'auto', compressionThresholdKB: 100, checkpointThresholdKB: 1000,
        } as Record<string, unknown>)[key] }));
        __test__.setManagerForTest(undefined);
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'undotree-scaling-'));
        const directory = path.join(root, 'undo-trees');
        const contentDirectory = path.join(directory, 'content');
        await fs.mkdir(contentDirectory, { recursive: true });
        const activeUri = 'file:///active.md';
        const closed = Array.from({ length: count }, (_, index) => {
            const uri = `file:///archive/file-${index}.md`;
            return { uri, file: fileName(uri) };
        });
        const active = { uri: activeUri, file: fileName(activeUri) };
        const originalManifest = { version: 1, savedAt: Date.now(), nextId: 2, paused: false, trees: [active, ...closed] };
        // Setup is outside timing. Mix plain and compressed real tree files;
        // old content blobs model files retained after compaction.
        const archive = tree(randomBytes(24 * 1024).toString('base64'), 1);
        const archivePayload = JSON.stringify({ uri: 'archive', tree: archive });
        const compressed = gzipSync(Buffer.from(archivePayload));
        try {
            for (let start = 0; start < closed.length; start += 32) {
                await Promise.all(closed.slice(start, start + 32).map((entry, offset) =>
                    fs.writeFile(path.join(directory, entry.file), (start + offset) % 2 === 0 ? compressed : archivePayload)));
            }
            const blobNames = Array.from({ length: count * 3 }, (_, index) => hash(`retained-${index}`));
            for (let start = 0; start < blobNames.length; start += 32) {
                await Promise.all(blobNames.slice(start, start + 32).map(name => fs.writeFile(path.join(contentDirectory, name), 'retained')));
            }
            const archiveNames = new Set(closed.map(entry => entry.file));
            const disk = require('fs').promises as typeof fs;
            const read = disk.readFile.bind(disk);
            let coldReads = 0;
            const spy = jest.spyOn(disk, 'readFile').mockImplementation(((file: any, ...args: any[]) => {
                if (archiveNames.has(path.basename(String(file)))) { coldReads++; }
                return (read as any)(file, ...args);
            }) as any);
            const timings: number[] = [];
            try {
                for (let repeat = 0; repeat < 5; repeat++) {
                    // Reset only the tiny active tree and manifest between samples.
                    await fs.writeFile(path.join(directory, active.file), JSON.stringify({ uri: activeUri, tree: tree('previous', 1) }));
                    const manifestJson = JSON.stringify(originalManifest);
                    await fs.writeFile(path.join(directory, 'manifest.json'), manifestJson);
                    await fs.writeFile(path.join(directory, 'manifest.json.bak'), manifestJson);
                    const state = { nextId: 3, trees: { [activeUri]: tree('updated', 2) } };
                    const start = performance.now();
                    const result = await __test__.persistStateToDisk({ globalStorageUri: { fsPath: root } } as any,
                        state, false, new Set([activeUri]));
                    timings.push(performance.now() - start);
                    expect(result.writtenCount).toBe(1);
                    expect(result.persistedUris.length).toBe(count + 1);
                    expect((await __test__.loadPersistedTreeFromDisk({ globalStorageUri: { fsPath: root } } as any,
                        { toString: () => activeUri } as any))!.tree.nodes.some(node => node.hash === hash('updated'))).toBe(true);
                }
            } finally { spy.mockRestore(); }
            expect((await fs.readdir(contentDirectory)).sort()).toEqual(blobNames.sort());
            console.log(JSON.stringify({ closedHistories: count, retainedBlobs: count * 3, samples: timings.length,
                medianMs: +median(timings).toFixed(1), maxMs: +Math.max(...timings).toFixed(1), coldTreeReads: coldReads }));
            expect(coldReads).toBe(0);
            expect(Math.max(...timings)).toBeLessThan(5000);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
});
