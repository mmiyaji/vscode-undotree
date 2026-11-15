import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { gunzip } from 'zlib';
import { UndoTreeManager } from '../undoTreeManager';
import { decodeCheckpointContent } from '../checkpointContent';
import { __test__ } from '../extension';

jest.mock('vscode');

const unzip = promisify(gunzip);
const MiB = 1024 * 1024;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Mode = 'manual' | 'auto';
type Sample = { ms: number; growthMiB: number; maxGapMs: number; diskBytes: number };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function diskBytes(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        total += entry.isDirectory() ? await diskBytes(target) : (await fs.stat(target)).size;
    }
    return total;
}

describe('manual versus automatic persistence performance', () => {
    jest.setTimeout(60_000);

    async function run(mode: Mode, initial: string): Promise<Sample> {
        const vscode = require('vscode');
        vscode.workspace.getConfiguration.mockImplementation(() => ({ get: (key: string) => ({
            persistenceMode: mode, compressionThresholdKB: 100, checkpointThresholdKB: 1000,
        } as Record<string, unknown>)[key] }));
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'undotree-mode-perf-'));
        const context = { globalStorageUri: { fsPath: tempDir } } as any;
        const uri = { toString: () => 'file:///mode-comparison.md' } as any;
        const manager = new UndoTreeManager();
        manager.setContentCacheMax(0);
        let content = initial;
        const doc = { uri, getText: () => content, isUntitled: false } as any;
        __test__.setManagerForTest(manager);
        // Use the production refresh -> debounce -> flush path in both modes.
        manager.onRefresh = () => __test__.schedulePersistState(context);
        const used = () => {
            const memory = process.memoryUsage();
            return memory.heapUsed + memory.external;
        };
        const before = used();
        let peak = before;
        let last = performance.now();
        let maxGapMs = 0;
        const sample = () => {
            peak = Math.max(peak, used());
            const now = performance.now();
            maxGapMs = Math.max(maxGapMs, now - last);
            last = now;
        };
        const timer = setInterval(sample, 5);
        try {
            const start = performance.now();
            manager.onDidSaveTextDocument(doc);
            for (let batch = 0; batch < 3; batch++) {
                for (let edit = 0; edit < 10; edit++) {
                    const text = `\nedit ${batch}:${edit}`;
                    const offset = content.length;
                    content += text;
                    manager.onDidChangeTextDocument({ document: doc, contentChanges: [
                        { rangeOffset: offset, rangeLength: 0, text },
                    ] } as any);
                    manager.onDidSaveTextDocument(doc);
                    await tick();
                }
                // End each burst using the production close/shutdown flush.
                // Exclude the fixed 1s debounce wait from processing time.
                await __test__.flushPersistState(context);
                sample();
            }
            const ms = performance.now() - start;
            sample();
            clearInterval(timer);
            const tree = manager.getTree(uri);
            expect(tree.nodes.size).toBe(31);
            expect(manager.reconstructContent(tree, tree.currentId)).toBe(content);
            if (mode === 'manual') {
                expect(await fs.readdir(tempDir)).toEqual([]);
                expect(manager.getDirtyUris().has(uri.toString())).toBe(true);
            } else {
                expect(manager.getDirtyUris().size).toBe(0);
                const loaded = await __test__.loadPersistedTreeFromDisk(context, uri);
                expect(loaded!.tree.nodes).toHaveLength(31);
                const restored = new UndoTreeManager();
                try {
                    restored.setContentCacheMax(0);
                    restored.asyncContentResolver = async hash => decodeCheckpointContent(await unzip(
                        await fs.readFile(path.join(tempDir, 'undo-trees', 'content', hash))));
                    restored.importTree(uri.toString(), loaded!.tree);
                    const reloaded = restored.getTree(uri);
                    expect(await restored.reconstructContentAsync(reloaded, reloaded.currentId)).toBe(content);
                } finally { restored.dispose(); }
            }
            return { ms, growthMiB: Math.max(0, peak - before) / MiB, maxGapMs, diskBytes: await diskBytes(tempDir) };
        } finally {
            clearInterval(timer);
            // Also cancel any scheduled write if an assertion or write failed.
            manager.onRefresh = undefined;
            try { await __test__.flushPersistState(context); }
            finally {
                __test__.setManagerForTest(undefined);
                manager.dispose();
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        }
    }

    it.each([100 * 1024, MiB, 5 * MiB])('compares 30 edits and three flushes for a %i-byte document over five paired runs', async bytes => {
        const initial = randomBytes(Math.ceil(bytes * 3 / 4)).toString('base64').slice(0, bytes);
        // Warm both paths before collecting results; all samples use new directories.
        await run('manual', initial.slice(0, 1024));
        await run('auto', initial.slice(0, 1024));
        const samples: Record<Mode, Sample[]> = { manual: [], auto: [] };
        for (let repeat = 0; repeat < 5; repeat++) {
            const order: Mode[] = repeat % 2 === 0 ? ['manual', 'auto'] : ['auto', 'manual'];
            for (const mode of order) { samples[mode].push(await run(mode, initial)); }
        }
        for (const mode of ['manual', 'auto'] as const) {
            const values = samples[mode];
            console.log(JSON.stringify({
                bytes, mode, runs: values.length,
                medianMs: +median(values.map(value => value.ms)).toFixed(1),
                minMs: +Math.min(...values.map(value => value.ms)).toFixed(1),
                maxMs: +Math.max(...values.map(value => value.ms)).toFixed(1),
                medianGrowthMiB: +median(values.map(value => value.growthMiB)).toFixed(1),
                maxGapMs: +Math.max(...values.map(value => value.maxGapMs)).toFixed(1),
                diskMiB: +(values[0].diskBytes / MiB).toFixed(3),
            }));
            expect(Math.max(...values.map(value => value.ms))).toBeLessThan(10_000);
            expect(Math.max(...values.map(value => value.growthMiB))).toBeLessThan(192);
            expect(Math.max(...values.map(value => value.maxGapMs))).toBeLessThan(500);
        }
    });
});
