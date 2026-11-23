// Isolated, reproducible stress measurements. No user files or profiles are used.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const MiB = 1024 * 1024;
const scenarios = [
    { name: '1MiB-1000-deltas', bytes: MiB, count: 1000 },
    { name: '10MiB-500-deltas', bytes: 10 * MiB, count: 500 },
    { name: '20MiB-100-deltas', bytes: 20 * MiB, count: 100 },
    { name: '50MiB-100-deltas', bytes: 50 * MiB, count: 100 },
    { name: '1KiB-10000-deltas', bytes: 1024, count: 10000 },
    { name: '1MiB-100-full', bytes: MiB, count: 100, full: true },
];

function loadSources(vscode) {
    const cache = new Map();
    return function load(filename) {
        filename = path.resolve(__dirname, '..', 'src', filename);
        if (cache.has(filename)) { return cache.get(filename).exports; }
        const mod = new Module(filename, module);
        mod.filename = filename;
        mod.paths = Module._nodeModulePaths(path.dirname(filename));
        cache.set(filename, mod);
        const realRequire = mod.require.bind(mod);
        mod.require = name => name === 'vscode' ? vscode : name.startsWith('./')
            ? load(path.join(path.dirname(filename), `${name}.ts`)) : realRequire(name);
        mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        }).outputText, filename);
        return mod.exports;
    };
}
function timed(fn) { const t = performance.now(); const value = fn(); return { ms: performance.now() - t, value }; }
async function timedAsync(fn) { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, value }; }
function percentile(values, fraction) { return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]; }
function memory() { global.gc?.(); return process.memoryUsage().heapUsed / MiB; }

async function measure(root, scenario) {
    const directory = path.join(root, scenario.name);
    await fsp.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'file.md');
    const uri = { scheme: 'file', toString: () => pathToFileURL(file).toString() };
    const config = {
        trackingMode: 'listed', maxTrackedFileChars: 0, enabledExtensions: ['.md'], excludePatterns: [],
        persistenceMode: 'manual', compressionThresholdKB: 100, checkpointThresholdKB: 1000,
    };
    const vscode = {
        workspace: {
            textDocuments: [],
            getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback, inspect: () => undefined }),
        },
        TextDocumentChangeReason: { Undo: 1, Redo: 2 },
        window: { showWarningMessage: () => Promise.resolve(), visibleTextEditors: [], tabGroups: { activeTabGroup: {} } },
        env: { language: 'en' }, l10n: { t: text => text },
        EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
        Uri: { parse: value => ({ toString: () => value }) },
    };
    const load = loadSources(vscode);
    const { UndoTreeManager } = load('undoTreeManager.ts');
    const { UndoTreeProvider } = load('undoTreeProvider.ts');
    const extension = load('extension.ts');
    const baselineHeap = memory();
    const manager = new UndoTreeManager();
    manager.setAutosaveInterval(0);
    extension.__test__.setManagerForTest(manager);
    const line = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n';
    let content = line.repeat(Math.ceil(scenario.bytes / line.length)).slice(0, scenario.bytes);
    const document = { uri, fileName: file, getText: () => content, isUntitled: false };
    const initial = timed(() => manager.getTree(uri, content));
    const saveTimes = [];
    for (let index = 0; index < scenario.count; index++) {
        const offset = Math.floor(content.length / 2);
        const inserted = `${index.toString(36)}|`;
        if (scenario.full) {
            content = `${index.toString().padStart(8, '0')}${line.repeat(Math.ceil(scenario.bytes / line.length)).slice(8, scenario.bytes)}`;
        } else {
            content = content.slice(0, offset) + inserted + content.slice(offset);
            manager.onDidChangeTextDocument({ document, contentChanges: [{ rangeOffset: offset, rangeLength: 0, text: inserted }] });
        }
        saveTimes.push(timed(() => manager.onDidSaveTextDocument(document)).ms);
    }
    const residentHeapMiB = memory() - baselineHeap;
    const tree = manager.getTree(uri);
    const reconstruct = timed(() => manager.reconstructContent(tree, tree.currentId));
    if (reconstruct.value !== content) { throw new Error('Content reconstruction failed'); }
    const reconstructAsync = await timedAsync(() => manager.reconstructContentAsync(tree, tree.currentId));
    if (reconstructAsync.value !== content) { throw new Error('Async content reconstruction failed'); }
    const provider = new UndoTreeProvider({}, manager);
    const display = timed(() => provider.getRenderState(document, false, 'time', 'yyyy-MM-dd HH:mm:ss', 'lines', 'parent', false, 'blue'));
    if (display.value.nodes.length !== tree.nodes.size) { throw new Error('Display state omitted history nodes'); }
    const payload = timed(() => JSON.stringify(display.value));
    const html = timed(() => provider.buildHtml(display.value.nodes, tree.currentId, false, 'navigate', 'time', 'yyyy-MM-dd HH:mm:ss', 'lines', 'parent', false, 'blue', 'tree', '', '', uri.toString(), tree.rootId));
    await fsp.writeFile(path.join(directory, 'view.html'), html.value);
    await fsp.writeFile(file, content);
    const exported = timed(() => manager.exportState());
    const context = { globalStorageUri: { fsPath: path.join(directory, 'storage') } };
    const persisted = await timedAsync(() => extension.__test__.persistStateToDisk(context, exported.value, false));
    const repersisted = await timedAsync(() => extension.__test__.persistStateToDisk(context, exported.value, false));
    const preview = timed(() => manager.previewHardCompactDetailed(tree, 30));
    const result = {
        ...scenario, uri: uri.toString(), nodeCount: tree.nodes.size,
        initialMs: initial.ms, saveP50Ms: percentile(saveTimes, .5), saveP95Ms: percentile(saveTimes, .95), saveMaxMs: Math.max(...saveTimes),
        residentHeapMiB, reconstructMs: reconstruct.ms, reconstructAsyncMs: reconstructAsync.ms,
        retainedFullTextMiB: [...tree.nodes.values()].reduce((sum, node) => sum + (node.storage.kind === 'full' ? Buffer.byteLength(node.storage.content) : 0), 0) / MiB,
        compressedCheckpointMiB: [...manager.compressedCheckpoints.values()].reduce((sum, buffer) => sum + buffer.length, 0) / MiB,
        decodedCacheMiB: manager.contentCacheBytes / MiB,
        displayStateMs: display.ms, payloadMiB: Buffer.byteLength(payload.value) / MiB, payloadStringifyMs: payload.ms,
        htmlMs: html.ms, exportMs: exported.ms, persistMs: persisted.ms, repersistMs: repersisted.ms,
        hardCompactPreviewMs: preview.ms,
    };
    await fsp.writeFile(path.join(directory, 'metrics.json'), JSON.stringify(result, null, 2));
    manager.dispose();
    return result;
}

async function main() {
    if (process.argv[2] === '--child') {
        console.log(JSON.stringify(await measure(process.argv[3], JSON.parse(process.argv[4]))));
        return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'undotree-performance-'));
    console.log(`Performance artifacts: ${root}`);
    const results = [];
    for (const scenario of scenarios) {
        const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', root, JSON.stringify(scenario)], {
            encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024,
        });
        if (child.status !== 0) { throw new Error(`${scenario.name}: ${child.stderr || child.error}`); }
        const result = JSON.parse(child.stdout);
        results.push(result);
        console.log(JSON.stringify(result));
        await fsp.writeFile(path.join(root, 'metrics.json'), JSON.stringify({ node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, results }, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
