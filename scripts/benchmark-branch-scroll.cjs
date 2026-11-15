// Exercise the actual generated webview in a browser; no document contents are loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const { chromium } = require('playwright');

function loadProvider() {
    const vscode = {
        workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
        env: { language: 'en' },
        l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => String(args[index] ?? '')) },
    };
    const cache = new Map();
    function load(filename) {
        filename = path.resolve(__dirname, '../src', filename);
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
    }
    return load('undoTreeProvider.ts').UndoTreeProvider;
}

async function main() {
    const provider = new (loadProvider())({}, {});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'undotree-scroll-perf-'));
    const htmlPath = path.join(root, 'view.html');
    fs.writeFileSync(htmlPath, provider.buildHtml([], 0, false, 'navigate', 'time', '', 'none', 'parent', false, 'blue', 'tree', '', '', 'file:///performance.md', 0));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 340, height: 600 } });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} }); });
        await page.goto(pathToFileURL(htmlPath).toString());
        for (const size of [10001, 50001]) {
            const fixture = Array.from({ length: size }, (_, id) => ({
                id, parents: id ? [Math.floor((id - 1) / 3)] : [],
                children: [id * 3 + 1, id * 3 + 2, id * 3 + 3].filter(child => child < size),
                timestamp: 1700000000000 + id, label: 'save', formattedTime: '12:00',
                lineCount: id, byteCount: id, storage: { kind: 'full' },
            }));
            const metrics = await page.evaluate(async fixture => {
                const samples = [];
                let maxDom = 0;
                const start = performance.now();
                renderState({ view: 'tree', nodes: fixture, currentId: 0, rootId: 0, mode: 'navigate',
                    timeFormat: 'time', nodeSizeMetric: 'lines', nodeSizeMetricBase: 'parent',
                    sourceUri: 'file:///branches-' + fixture.length, colorTheme: 'blue', paused: false });
                const renderMs = performance.now() - start;
                const count = nodeIds.length;
                for (let i = 0; i <= 100; i++) {
                    const index = Math.min(count - 1, Math.floor((count - 1) * i / 100));
                    const t = performance.now();
                    window.scrollTo(0, document.querySelector('#tree').offsetTop + index * 22);
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    samples.push(performance.now() - t);
                    maxDom = Math.max(maxDom, document.querySelectorAll('.node').length);
                    if (!nodeEls[index]?.isConnected) throw new Error('Target row not rendered: ' + index);
                }
                samples.sort((a, b) => a - b);
                return { nodes: count, branchPoints: fixture.filter(n => n.children.length > 1).length,
                    renderMs, scrollMedianMs: samples[Math.floor(samples.length / 2)],
                    scrollP95Ms: samples[Math.floor(samples.length * .95)], scrollMaxMs: samples.at(-1),
                    maxRenderedRows: maxDom, scrollSteps: samples.length };
            }, fixture);
            assert.equal(metrics.nodes, size);
            assert.ok(metrics.maxRenderedRows < 150);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify(metrics));
        }
        console.log('Browser ' + browser.version() + ', 340x600, headless Edge; scroll timing includes two animation frames.');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });