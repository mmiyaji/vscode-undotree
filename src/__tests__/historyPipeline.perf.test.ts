import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { UndoTreeManager } from '../undoTreeManager';
import { decodeCheckpointContent, encodeCheckpointContent, hashContent } from '../checkpointContent';

jest.mock('vscode');

const unzip = promisify(gunzip);
const MiB = 1024 * 1024;
const uri = { toString: () => 'file:///pipeline.md' } as any;
const document = (content: string) => ({ uri, getText: () => content, isUntitled: false } as any);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const managers: UndoTreeManager[] = [];
function createManager() {
    const manager = new UndoTreeManager();
    managers.push(manager);
    return manager;
}

// heapUsed includes JS strings; external includes Buffer/zlib allocations.
// This is sampled process growth, not an isolated allocator or RSS measurement.
async function measure<T>(run: () => Promise<T>) {
    const used = () => {
        const memory = process.memoryUsage();
        return memory.heapUsed + memory.external;
    };
    const baseline = used();
    let peak = baseline;
    let last = performance.now();
    let maxGapMs = 0;
    const sample = () => {
        peak = Math.max(peak, used());
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
    };
    const timer = setInterval(sample, 5);
    const start = performance.now();
    try {
        const result = await run();
        sample();
        return { result, ms: performance.now() - start, growthMiB: (peak - baseline) / MiB, maxGapMs };
    } finally { clearInterval(timer); }
}

function report(name: string, stats: { ms: number; growthMiB: number; maxGapMs: number }) {
    console.log(`${name}: ${stats.ms.toFixed(1)}ms, sampled growth ${stats.growthMiB.toFixed(1)}MiB, max heartbeat gap ${stats.maxGapMs.toFixed(1)}ms`);
}

afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
});

describe('history pipeline performance', () => {
    jest.setTimeout(30_000);

    it('retains 40 queued 1MiB saves while loading is blocked, then drains them within 5s', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const manager = createManager();
        manager.setMemoryCheckpointThreshold(64 * MiB);
        manager.setContentCacheMax(0);
        const base = randomBytes(768 * 1024).toString('base64');
        manager.onDidSaveTextDocument(document(base));
        const snapshots: NonNullable<ReturnType<UndoTreeManager['captureSave']>>[] = [];
        let release!: () => void;
        const loading = new Promise<void>(resolve => { release = resolve; });
        void extension.__test__.enqueueDocumentTask(uri, () => loading);
        let content = base;
        const stats = await measure(async () => {
            for (let i = 0; i < 40; i++) {
                content += String.fromCharCode(65 + i);
                manager.onDidChangeTextDocument({ document: document(content), contentChanges: [
                    { rangeOffset: content.length - 1, rangeLength: 0, text: content.slice(-1) },
                ] } as any);
                const snapshot = manager.captureSave(document(content))!;
                snapshots.push(snapshot);
                void extension.__test__.enqueueDocumentTask(uri, async () => snapshot.record());
                if (i % 5 === 0) { await tick(); }
            }
            expect(manager.getTree(uri).nodes.size).toBe(1);
            expect(manager.hasPendingDiffs(uri)).toBe(true);
            release();
            await extension.__test__.drainDocumentTasks();
            const tree = manager.getTree(uri);
            expect(tree.nodes.size).toBe(41);
            for (const [index, node] of [...tree.nodes.values()].entries()) {
                expect(manager.reconstructContent(tree, node.id)).toBe(base + Array.from({ length: index }, (_, i) => String.fromCharCode(65 + i)).join(''));
            }
            expect(manager.hasPendingDiffs(uri)).toBe(false);
        });
        snapshots.forEach(snapshot => snapshot.dispose());
        report('40 queued saves', stats);
        expect(stats.ms).toBeLessThan(5000);
        expect(stats.growthMiB).toBeLessThan(192);
    });

    it.each([
        ['Japanese', '日本語の履歴\n'],
        ['emoji', '😀🌳📝\n'],
        ['isolated surrogates', 'a\ud800b\udc00\n'],
    ])('hashes and round trips 5Mi UTF-16 units of %s within 1s per sample', async (name, seed) => {
        const content = seed.repeat(Math.ceil(5 * MiB / seed.length));
        const expected = hashContent(content);
        encodeCheckpointContent(content); // Warm up outside the measured samples.
        const timings: number[] = [];
        const stats = await measure(async () => {
            for (let i = 0; i < 5; i++) {
                const start = performance.now();
                const encoded = encodeCheckpointContent(content);
                expect(hashContent(content)).toBe(expected);
                expect(decodeCheckpointContent(encoded)).toBe(content);
                timings.push(performance.now() - start);
                await tick();
            }
        });
        report(`Unicode ${name}, 5 samples`, stats);
        expect(Math.max(...timings)).toBeLessThan(1000);
        expect(stats.growthMiB).toBeLessThan(192);
    });

    it('allows editing and heartbeat progress while compressing eight incompressible large snapshots', async () => {
        const manager = createManager();
        manager.setContentCacheMax(0);
        const contents = Array.from({ length: 8 }, () => randomBytes(MiB).toString('base64'));
        let heartbeats = 0;
        const heartbeat = setInterval(() => { heartbeats++; }, 1);
        const stats = await measure(async () => {
            try {
                manager.onDidSaveTextDocument(document(contents[0]));
                manager.onDidSaveTextDocument(document(contents[1]));
                // The root remains full; the third save makes the first
                // non-root snapshot eligible for background compression.
                manager.onDidSaveTextDocument(document(contents[2]));
                const worker = (manager as any).checkpointCompressionTask as Promise<void> | undefined;
                expect(worker).toBeDefined();
                for (const content of contents.slice(3)) {
                    await tick();
                    manager.onDidSaveTextDocument(document(content));
                }
                await (manager as any).checkpointCompressionTask;
                expect(heartbeats).toBeGreaterThan(0);
                const tree = manager.getTree(uri);
                expect([...tree.nodes.values()].filter(node => node.storage.kind === 'checkpoint').length).toBe(6);
                for (const [index, id] of [...tree.nodes.keys()].entries()) {
                    expect(await manager.reconstructContentAsync(tree, id)).toBe(contents[index]);
                }
            } finally { clearInterval(heartbeat); }
        });
        report('background compression and editing', stats);
        expect(stats.ms).toBeLessThan(10_000);
        expect(stats.maxGapMs).toBeLessThan(500);
        expect(stats.growthMiB).toBeLessThan(192);
    });

    it('persists and cold-reloads 24 incompressible checkpoints within 10s with bounded decode concurrency', async () => {
        const extension = require('../extension') as typeof import('../extension');
        const vscode = require('vscode');
        vscode.workspace.getConfiguration.mockImplementation(() => ({ get: (key: string) => ({
            compressionThresholdKB: 128, checkpointThresholdKB: 128, persistenceMode: 'manual',
        } as Record<string, unknown>)[key] }));
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'undotree-perf-'));
        const manager = createManager();
        manager.setContentCacheMax(0);
        const contents = Array.from({ length: 24 }, () => randomBytes(288 * 1024).toString('base64'));
        contents.forEach(content => manager.onDidSaveTextDocument(document(content)));
        let active = 0;
        let peak = 0;
        const resolve = manager.getCheckpointContentAsync.bind(manager);
        const spy = jest.spyOn(manager, 'getCheckpointContentAsync').mockImplementation(async hash => {
            peak = Math.max(peak, ++active);
            try { return await resolve(hash); } finally { active--; }
        });
        extension.__test__.setManagerForTest(manager);
        try {
            const stats = await measure(async () => {
                const context = { globalStorageUri: { fsPath: tempDir } } as any;
                await extension.__test__.persistStateToDisk(context, manager.exportState(), false);
                expect(peak).toBeGreaterThan(1);
                expect(peak).toBeLessThanOrEqual(4);
                const files = await fs.readdir(path.join(tempDir, 'undo-trees', 'content'));
                expect(files.length).toBe(24);
                const loaded = await extension.__test__.loadPersistedTreeFromDisk(context, uri);
                const restored = createManager();
                restored.setContentCacheMax(0);
                let reads = 0;
                restored.asyncContentResolver = async hash => {
                    reads++;
                    return decodeCheckpointContent(await unzip(await fs.readFile(path.join(tempDir, 'undo-trees', 'content', hash))));
                };
                restored.importTree(uri.toString(), loaded!.tree);
                const tree = restored.getTree(uri);
                for (const [index, id] of [...tree.nodes.keys()].entries()) {
                    expect(await restored.reconstructContentAsync(tree, id)).toBe(contents[index]);
                }
                expect(reads).toBe(24);
            });
            report('24 checkpoint disk round trips', stats);
            expect(stats.ms).toBeLessThan(10_000);
            expect(stats.growthMiB).toBeLessThan(192);
            expect(stats.maxGapMs).toBeLessThan(500);
        } finally {
            spy.mockRestore();
            extension.__test__.setManagerForTest(undefined);
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
