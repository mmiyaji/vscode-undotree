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
    const UndoTreeProvider = loadProvider();
    const provider = new UndoTreeProvider({}, {});
    const nodes = Array.from({ length: 10001 }, (_, id) => ({
        id, parents: id ? [id - 1] : [], children: id < 10000 ? [id + 1] : [],
        timestamp: new Date('2026-09-20T12:00:00+09:00').getTime() + id * 60000,
        label: id ? 'save' : 'initial', storage: { kind: 'delta' },
        formattedTime: '12:00:00', lineCount: 10, byteCount: 100, isEmpty: false,
        ...(id === 100 ? { note: 'Release approved 日本語 <tag>', pinned: true } : {}),
        ...(id === 9000 ? { note: 'Review complete', pinned: true } : {}),
    }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'undotree-priority-ui-'));
    const htmlPath = path.join(root, 'view.html');
    fs.writeFileSync(htmlPath, provider.buildHtml(nodes, 10000, false, 'navigate', 'time',
        'yyyy-MM-dd HH:mm:ss', 'lines', 'parent', false, 'blue', 'tree', '', '', 'file:///ui-test.md', 0));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 300, height: 600 }, timezoneId: 'Asia/Tokyo' });
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
        await page.addInitScript(() => {
            window.messages = [];
            window.acquireVsCodeApi = () => ({ postMessage(message) { window.messages.push(message); }, getState() {}, setState() {} });
        });
        await page.goto(pathToFileURL(htmlPath).toString());
        const check = async (name, fn) => { await fn(); console.log(`PASS: ${name}`); };
        const openSearch = async () => {
            if (!(await page.locator('#history-search').isVisible())) { await page.locator('#btn-search').click(); }
        };
        await check('10,001 histories retain bounded DOM rendering', async () => {
            assert.equal(await page.evaluate(() => nodeIds.length), 10001);
            assert.ok(await page.locator('.node').count() < 150);
        });
        await check('Tab leaves a toolbar button and Enter invokes that button', async () => {
            await page.locator('#btn-undo').focus();
            await page.keyboard.press('Tab');
            assert.notEqual(await page.evaluate(() => document.activeElement.id), 'btn-undo');
            await page.locator('#btn-pause').focus();
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'togglePause');
            assert.equal(await page.evaluate(() => window.messages.some(message => message.command === 'jumpToNode')), false);
        });
        await check('tree keyboard navigation remains available across virtual rows', async () => {
            await page.locator('#tree').focus();
            await page.keyboard.press('Home');
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 0);
            await page.keyboard.press('End');
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 10000);
            await page.keyboard.press('ArrowUp');
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 9999);
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'jumpToNode');
            assert.equal(await page.evaluate(() => window.messages.at(-1).nodeId), 9999);
        });
        await check('modified editor shortcuts are not interpreted as history shortcuts', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('#tree').dispatchEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true });
            await page.locator('#tree').dispatchEvent('keydown', { key: 'u', metaKey: true, bubbles: true });
            await page.locator('#tree').dispatchEvent('keydown', { key: 'r', altKey: true, bubbles: true });
            assert.equal(await page.evaluate(() => window.messages.length), before);
        });
        await check('virtual scroll does not strand keyboard focus on the body', async () => {
            await page.evaluate(() => window.scrollTo(0, 22 * 5000));
            await page.waitForFunction(() => nodeEls[5000]?.isConnected);
            assert.equal(await page.evaluate(() => document.getElementById('tree').contains(document.activeElement)), true);
            await page.keyboard.press('ArrowUp');
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 9998);
        });
        await check('metadata search returns matching histories without thousands of ancestors', async () => {
            await openSearch();
            await page.locator('#history-search').fill('日本語');
            await page.waitForFunction(() => nodeIds.length === 1 && nodeIds[0] === 100);
            assert.equal(await page.locator('.node').count(), 1);
            assert.ok((await page.locator('.node').innerText()).includes('Release approved 日本語 <tag>'));
            assert.equal(await page.locator('.node tag').count(), 0, 'notes remain escaped');
            assert.equal(await page.locator('.node[tabindex="0"]').count(), 1, 'filtered results are reachable by Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'history-search');
            await page.locator('#history-search').fill('Review complete');
            await page.waitForFunction(() => nodeIds.length === 1 && nodeIds[0] === 9000);
        });
        await check('empty search and pin filtering are explicit and do not alter the document', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('#history-search').fill('no-such-history');
            await page.waitForFunction(() => nodeIds.length === 0);
            assert.ok((await page.locator('#filter-status').innerText()).length > 0);
            await page.locator('#history-search').fill('');
            await page.locator('#pinned-only').check();
            await page.waitForFunction(() => nodeIds.length === 2);
            assert.deepEqual(await page.evaluate(() => nodeIds), [100, 9000]);
            assert.equal(await page.evaluate(() => window.messages.length), before);
        });
        await check('show current clears filters and moves focus without restoring content', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('#show-current').click();
            await page.waitForFunction(() => nodeIds.length === 10001);
            assert.equal(await page.locator('#history-search').inputValue(), '');
            assert.equal(await page.locator('#pinned-only').isChecked(), false);
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 10000);
            assert.equal(await page.evaluate(() => window.messages.length), before);
            assert.equal(await page.locator('.node.current .current-badge').innerText(), 'Current');
        });
        await check('date metadata is searchable with the configured time-only display', async () => {
            await openSearch();
            const day = new Date(nodes[100].timestamp).toISOString().slice(0, 10);
            await page.locator('#history-search').fill(day);
            await page.waitForFunction(() => nodeIds.length > 0 && nodeIds.length < 10001);
            assert.ok((await page.evaluate(() => nodeIds)).includes(100));
        });
        await check('local midnight histories are searchable by their local date', async () => {
            await page.locator('#history-search').fill('2026-09-21');
            await page.waitForFunction(() => nodeIds.includes(800));
            assert.equal(new Date(nodes[800].timestamp).toISOString().slice(0, 10), '2026-09-20', 'fixture crosses the UTC date boundary');
        });
        await check('refresh preserves search input focus, value and caret', async () => {
            await page.locator('#history-search').fill('Review');
            await page.waitForFunction(() => nodeIds.length === 1);
            await page.locator('#history-search').evaluate(input => input.setSelectionRange(2, 2));
            await page.evaluate(() => renderState({ view: 'tree', nodes, currentId, mode, timeFormat, timeFormatCustom,
                nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId, paused: false }));
            assert.equal(await page.evaluate(() => document.activeElement.id), 'history-search');
            assert.equal(await page.locator('#history-search').inputValue(), 'Review');
            assert.equal(await page.locator('#history-search').evaluate(input => input.selectionStart), 2);
            assert.deepEqual(await page.evaluate(() => nodeIds), [9000]);
        });
        await check('show current in diff mode does not open another diff', async () => {
            await page.evaluate(() => renderState({ view: 'tree', nodes, currentId, mode: 'diff', timeFormat, timeFormatCustom,
                nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId, paused: false }));
            assert.ok((await page.locator('#diff-base-label').innerText()).includes('Review complete'), 'comparison names the selected note');
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('#show-current').click();
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 10000);
            assert.equal(await page.evaluate(() => window.messages.length), before);
        });
        await check('pair comparison describes both versions and an unselected base correctly', async () => {
            await page.locator('#btn-diff-pair').click();
            assert.equal(await page.locator('#diff-base-label').innerText(), await page.evaluate(() => i18n.pairDiffNeedsBase));
            await page.evaluate(() => { setDiffBaseNode(100); setFocused(nodeIds.indexOf(9000), true); });
            const label = await page.locator('#diff-base-label').innerText();
            assert.ok(label.includes('Release approved 日本語 <tag>'));
            assert.ok(label.includes('Review complete'));
            assert.equal(await page.evaluate(() => window.messages.at(-1).leftNodeId), 100);
            assert.equal(await page.evaluate(() => window.messages.at(-1).rightNodeId), 9000);
        });
        await check('a normal refresh preserves the displayed comparison target', async () => {
            await page.evaluate(() => {
                setDiffCompareMode('current');
                setFocused(nodeIds.indexOf(9000), true);
            });
            await page.evaluate(() => renderState({ view: 'tree', nodes, currentId, mode, timeFormat, timeFormatCustom,
                nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId, paused: false }));
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 9000);
            assert.ok((await page.locator('#diff-base-label').innerText()).includes('Review complete'));
            await page.evaluate(() => renderState({ view: 'tree', nodes, currentId: 9999, mode, timeFormat, timeFormatCustom,
                nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId, paused: false }));
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 9999, 'actual history navigation follows the new current node');
        });
        await check('a 180px-high sidebar keeps keyboard-selected rows visible', async () => {
            await page.setViewportSize({ width: 300, height: 180 });
            await page.locator('#tree').focus();
            await page.keyboard.press('Home');
            const first = await page.locator('.node.focused').boundingBox();
            assert.ok(first && first.y >= 0 && first.y + first.height <= 181, 'first focused row must fit');
            assert.equal(await page.locator('.node.focused').evaluate(el => {
                const rect = el.getBoundingClientRect();
                return el.contains(document.elementFromPoint(Math.min(rect.right - 1, 150), rect.top + rect.height / 2));
            }), true, 'sticky controls must not cover the focused row');
            await page.keyboard.press('End');
            const last = await page.locator('.node.focused').boundingBox();
            assert.ok(last && last.y >= 0 && last.y + last.height <= 181, 'last focused row must fit');
            assert.ok(await page.locator('.node').count() < 150);
        });
        assert.deepEqual(errors, [], 'renderer has no uncaught exceptions');
        console.log(`UI regression artifacts: ${root}`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
