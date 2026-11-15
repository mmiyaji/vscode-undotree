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
            window.viewState = JSON.parse(sessionStorage.getItem('viewState') || '{}');
            window.acquireVsCodeApi = () => ({ postMessage(message) { window.messages.push(message); }, getState() { return window.viewState; }, setState(state) { window.viewState = state; sessionStorage.setItem('viewState', JSON.stringify(state)); } });
        });
        await page.goto(pathToFileURL(htmlPath).toString());
        const check = async (name, fn) => { await fn(); console.log(`PASS: ${name}`); };
        const toolbarAction = async id => {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            if (!(await page.locator(id).isVisible())) { await page.locator('#btn-more').click(); }
            await page.locator(id).click();
        };
        const openSearch = async () => {
            if (!(await page.locator('#history-search').isVisible())) { await toolbarAction('#btn-search'); }
        };
        await check('10,001 histories retain bounded DOM rendering', async () => {
            assert.equal(await page.evaluate(() => nodeIds.length), 10001);
            assert.ok(await page.locator('.node').count() < 150);
            assert.equal(await page.locator('.graph').first().evaluate(el => el.getBoundingClientRect().width), 14, 'a linear history does not reserve unused branch lanes');
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
        await check('default history labels are searchable and Escape clears filters without editing', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('#history-search').fill('save');
            await page.waitForFunction(() => nodeIds.length === 10000);
            await page.locator('#pinned-only').check();
            await page.waitForFunction(() => nodeIds.length === 2);
            await page.locator('#history-search').focus();
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => nodeIds.length === 10001);
            assert.equal(await page.locator('#history-search').isVisible(), false);
            assert.equal(await page.locator('#history-search').inputValue(), '');
            assert.equal(await page.locator('#pinned-only').isChecked(), false);
            assert.equal(await page.evaluate(() => document.getElementById('tree').contains(document.activeElement)), true);
            assert.equal(await page.evaluate(() => window.messages.length), before);
            await openSearch();
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
            await toolbarAction('#show-current');
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
            await toolbarAction('#show-current');
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
        await page.setViewportSize({ width: 620, height: 600 });
        const fixture = Array.from({ length: 1201 }, (_, id) => ({
            id, parents: id ? [id === 601 ? 0 : id - 1] : [],
            children: id === 0 ? [1, 601] : id === 600 || id === 1200 ? [] : [id + 1],
            timestamp: Date.now() + id, label: `save ${id}`, storage: { kind: 'delta' },
            lineCount: 10 + id, byteCount: 100 + id, formattedTime: '12:00:00',
            ...(id === 400 ? { note: 'Hidden target', pinned: true } : {}),
        }));
        async function renderFixture(uri = 'file:///collapse-test.md', selected = 1200) {
            await page.evaluate(({ fixture, uri, selected }) => renderState({
                view: 'tree', nodes: fixture, currentId: selected, sourceUri: uri, rootId: 0,
                mode: 'navigate', timeFormat: 'time', timeFormatCustom: '', nodeSizeMetric: 'lines',
                nodeSizeMetricBase: 'parent', showStorageKind: false, colorTheme: 'auto', paused: false,
            }), { fixture, uri, selected });
        }
        await renderFixture();
        await check('collapsing removes descendants from the virtual list without changing content', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await page.evaluate(() => setFocused(nodeIds.indexOf(1), true, true));
            await page.locator('[data-node-id="1"] .branch-toggle').click();
            assert.equal(await page.locator('.node[data-node-id="1"]').getAttribute('aria-expanded'), 'false');
            assert.equal(await page.evaluate(() => nodeIds.length), 602);
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            assert.equal(await page.locator('#tree').evaluate(el => el.classList.contains('virtual-tree')), true);
            assert.ok(await page.locator('.node').count() < 150);
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 1);
            assert.equal(await page.evaluate(() => window.messages.length), before);
            assert.equal(await page.locator('.node[data-node-id="1"] .collapsed-mark').innerText(), '599 hidden states');
            const disclosureX = await page.locator('.node[data-node-id="1"] .branch-toggle').evaluate(button => {
                const rect = button.getBoundingClientRect();
                return rect.left + rect.width / 2 - button.closest('.graph').getBoundingClientRect().left;
            });
            assert.equal(disclosureX, 6, 'disclosure replaces the node dot in its lane under the webview CSP');
            assert.equal(await page.locator('.node[data-node-id="0"] .branch-toggle').count(), 0, 'fork parent does not collapse all branches together');
        });
        await check('virtualization uses visible rows and arrows expand or collapse before navigating', async () => {
            await page.evaluate(() => setFocused(nodeIds.indexOf(601), true, true));
            await page.keyboard.press('ArrowLeft');
            assert.deepEqual(await page.evaluate(() => nodeIds), [0, 1, 601]);
            assert.equal(await page.locator('#tree').evaluate(el => el.classList.contains('virtual-tree')), false);
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.evaluate(() => nodeIds.length), 602);
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 601);
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 602);
            await page.keyboard.press('ArrowLeft');
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 601);
            assert.equal(await page.evaluate(() => nodeIds.length), 602, 'linear edits do not collapse');
            assert.equal(await page.locator('.node[data-node-id="602"] .branch-toggle').count(), 0);
            await page.keyboard.press('ArrowLeft');
            assert.deepEqual(await page.evaluate(() => nodeIds), [0, 1, 601]);
        });
        await check('search and pins find hidden descendants and restore the collapsed tree afterwards', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await openSearch();
            await page.locator('#history-search').fill('Hidden target');
            assert.deepEqual(await page.evaluate(() => nodeIds), [400]);
            assert.equal(await page.locator('.branch-toggle').count(), 0);
            await renderFixture();
            assert.equal(await page.evaluate(() => collapsedBranches().has(1)), true, 'a refresh of filtered results must not unfold their ancestors');
            await page.locator('#history-search').fill('');
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            await page.locator('#pinned-only').check();
            assert.deepEqual(await page.evaluate(() => nodeIds), [400]);
            await page.locator('#pinned-only').uncheck();
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            assert.equal(await page.evaluate(() => window.messages.length), before);
        });
        await check('Current reveals only its ancestors and never restores file contents', async () => {
            const before = await page.evaluate(() => window.messages.length);
            assert.ok((await page.locator('#current-indicator').innerText()).includes('collapsed'));
            await toolbarAction('#show-current');
            assert.equal(await page.evaluate(() => nodeIds.includes(currentId)), true);
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 1200);
            assert.equal(await page.evaluate(() => window.messages.length), before);
        });
        await check('refresh and file switches retain independent collapsed branches', async () => {
            await renderFixture();
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            await renderFixture('file:///other-collapse.md');
            assert.equal(await page.evaluate(() => nodeIds.length), 1201);
            await renderFixture();
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            assert.ok(await page.evaluate(() => window.viewState.collapsedBranches.some(([uri, ids]) => uri === sourceUri && ids.includes(1))));
        });
        await check('history navigation into a hidden branch opens its path', async () => {
            await renderFixture('file:///collapse-test.md', 400);
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), true);
            assert.equal(await page.evaluate(() => nodeIds[focusedIndex]), 400);
            assert.equal(await page.locator('.node.current').getAttribute('data-node-id'), '400');
        });
        await check('pinned shortcuts reveal collapsed ancestors before jumping', async () => {
            await page.evaluate(() => toggleBranch(1));
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('.pinned-link').click();
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), true);
            assert.equal(await page.evaluate(() => window.messages.length), before + 1);
            assert.equal(await page.evaluate(() => window.messages.at(-1).nodeId), 400);
        });
        await check('connectors span exactly one row and screenshots show expanded and collapsed forks', async () => {
            await page.evaluate(() => { toggleBranch(1); toggleBranch(601); setFocused(0, true, true); });
            const row = page.locator('.node[data-node-id="1"]');
            assert.equal(await row.evaluate(el => el.getBoundingClientRect().height), 22);
            assert.equal(await row.locator('.graph-segment').first().evaluate(el => el.getBoundingClientRect().height), 22);
            await page.screenshot({ path: path.join(root, 'collapsed-branches.png') });
            await page.locator('[data-node-id="1"] .branch-toggle').click();
            await page.screenshot({ path: path.join(root, 'expanded-branch.png') });
        });
        await check('webview recreation restores per-file folding state', async () => {
            await page.evaluate(() => toggleBranch(1));
            await page.reload();
            await renderFixture();
            assert.equal(await page.evaluate(() => nodeIds.includes(400)), false);
            assert.equal(await page.evaluate(() => nodeIds.includes(currentId)), true);
        });
        await check('graph width and label alignment remain fixed across branches, filters and current', async () => {
            await page.evaluate(() => { setFocused(nodeIds.indexOf(1200), true, true); });
            const geometry = await page.locator('.node').evaluateAll(rows => rows.map(row => ({
                graphWidth: row.querySelector('.graph').getBoundingClientRect().width,
                labelX: row.querySelector('.node-label').getBoundingClientRect().left,
            })));
            assert.ok(geometry.every(row => row.graphWidth === 24));
            assert.ok(geometry.every(row => Math.abs(row.labelX - geometry[0].labelX) < 0.1));
            const badgeGap = await page.locator('.node.current').evaluate(row =>
                row.querySelector('.current-badge').getBoundingClientRect().left - row.querySelector('.node-label').getBoundingClientRect().right);
            assert.ok(badgeGap >= 0 && badgeGap <= 5, 'Current follows the label without a disclosure placeholder');
            await openSearch();
            await page.locator('#history-search').fill('Hidden target');
            assert.equal(await page.locator('.node-label').evaluate(el => el.getBoundingClientRect().left), geometry[0].labelX);
            await toolbarAction('#show-current');
        });
        await check('wide forks keep bounded graph geometry and valid folding', async () => {
            const wide = Array.from({ length: 1501 }, (_, id) => ({
                id, parents: id ? [0] : [], children: id ? [] : Array.from({ length: 1500 }, (_, i) => i + 1),
                timestamp: id, label: 'save', lineCount: id, byteCount: id, storage: { kind: 'full' },
            }));
            await page.evaluate(wide => renderState({ view: 'tree', nodes: wide, currentId: 1500,
                sourceUri: 'file:///wide.md', rootId: 0, mode: 'navigate', nodeSizeMetric: 'lines', colorTheme: 'auto', paused: false }), wide);
            assert.equal(await page.evaluate(() => nodeIds.length), 1501);
            assert.ok(await page.locator('.node').count() < 150);
            assert.equal(await page.locator('.branch-toggle').count(), 0, 'leaf branches have nothing to fold');
            assert.ok(await page.locator('.graph-dot').evaluateAll(dots => dots.every(dot => Number(dot.getAttribute('cx')) <= 36)));
        });
        await check('compact dark sidebar matches the selected fixed-lane direction', async () => {
            await page.setViewportSize({ width: 340, height: 560 });
            await page.evaluate(() => {
                const theme = {
                    '--vscode-font-family': 'Segoe UI, sans-serif', '--vscode-sideBar-background': '#181818',
                    '--vscode-foreground': '#cccccc', '--vscode-editorLineNumber-foreground': '#858585',
                    '--vscode-button-background': '#007acc', '--vscode-button-foreground': '#ffffff',
                    '--vscode-list-activeSelectionBackground': '#094771', '--vscode-list-activeSelectionForeground': '#ffffff',
                    '--vscode-list-hoverBackground': '#2a2d2e', '--vscode-descriptionForeground': '#999999',
                };
                for (const [name, value] of Object.entries(theme)) { document.documentElement.style.setProperty(name, value); }
                document.body.style.background = '#181818'; document.body.style.color = '#cccccc';
                const compact = Array.from({ length: 19 }, (_, id) => ({
                    id, parents: id ? [id === 12 ? 6 : id - 1] : [],
                    children: id === 6 ? [7, 12] : id === 11 || id === 18 ? [] : [id + 1],
                    timestamp: id, label: id === 0 ? 'initial' : id === 18 ? 'auto' : 'save',
                    lineCount: 13 + id, byteCount: 100 + id, formattedTime: '20:54:' + String(id).padStart(2, '0'),
                    storage: { kind: 'delta' },
                }));
                renderState({ view: 'tree', nodes: compact, currentId: 18, sourceUri: 'file:///compact.md',
                    rootId: 0, mode: 'navigate', timeFormat: 'time', nodeSizeMetric: 'lines',
                    nodeSizeMetricBase: 'parent', colorTheme: 'blue', paused: false });
                toggleBranch(7);
                setFocused(nodeIds.indexOf(18), false, true);
                window.scrollTo(0, 0);
            });
            assert.equal(await page.locator('.branch-toggle').count(), 2);
            assert.equal(await page.locator('.node.current .node-label').innerText(), 'auto');
            await page.screenshot({ path: path.join(root, 'fixed-graph-dark.png'), fullPage: true });
        });
        await check('narrow toolbar covers scrolled headers and blocks clicks through its background', async () => {
            for (const width of [220, 280, 340]) {
                await page.setViewportSize({ width, height: 180 });
                await page.evaluate(() => { syncStickyOffsets(); window.scrollTo(10000, 45); });
                const leaked = await page.evaluate(() => {
                    const height = document.querySelector('.actions').offsetHeight;
                    const leaks = [];
                    for (let x = 2; x < innerWidth - 16; x += 4) {
                        for (let y = 2; y < height; y += 4) {
                            const element = document.elementFromPoint(x, y);
                            if (element?.closest('.tree-header, .node')) { leaks.push({ x, y }); }
                        }
                    }
                    return leaks;
                });
                assert.deepEqual(leaked, [], `no history content should show through the toolbar at ${width}px`);
            }
            await page.setViewportSize({ width: 220, height: 180 });
            await page.evaluate(() => window.scrollTo(10000, 45));
            const before = await page.evaluate(() => window.messages.length);
            await toolbarAction('#btn-settings');
            assert.equal(await page.evaluate(() => window.messages.length), before + 1);
            assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'showMenu');
            await page.screenshot({ path: path.join(root, 'narrow-toolbar-fixed.png') });
        });
        await check('deep forks cap their width and keep labels aligned when collapsed', async () => {
            const deep = Array.from({ length: 601 }, (_, id) => ({
                id, parents: id ? [id % 2 ? id - 1 : id - 2] : [],
                children: id % 2 === 0 && id < 600 ? [id + 1, id + 2] : [],
                timestamp: id, label: 'save', lineCount: id, storage: { kind: 'full' },
            }));
            await page.evaluate(deep => renderState({ view: 'tree', nodes: deep, currentId: 600,
                sourceUri: 'file:///deep.md', rootId: 0, mode: 'navigate', nodeSizeMetric: 'lines', colorTheme: 'blue', paused: false }), deep);
            const before = await page.locator('.node-label').first().evaluate(el => el.getBoundingClientRect().left + scrollX);
            assert.equal(await page.locator('.graph').first().evaluate(el => el.getBoundingClientRect().width), 44);
            assert.ok(await page.locator('.node').count() < 150);
            await page.evaluate(() => toggleBranch(2));
            assert.deepEqual(await page.evaluate(() => nodeIds), [0, 1, 2]);
            assert.ok(await page.locator('.node-label').evaluateAll((els, x) => els.every(el => el.getBoundingClientRect().left + scrollX === x), before));
            assert.equal(await page.locator('.graph').first().evaluate(el => el.getBoundingClientRect().width), 44, 'folding does not shrink the lane column');
            await toolbarAction('#show-current');
            assert.equal(await page.evaluate(() => nodeIds.length), 601);
            assert.equal(await page.locator('.node.current .node-label').evaluate(el => el.getBoundingClientRect().left + scrollX), before);
        });
        await check('narrow headers retain Undo, Redo and Diff and overflow secondary controls', async () => {
            await page.setViewportSize({ width: 180, height: 300 });
            await page.evaluate(() => { syncStickyOffsets(); window.scrollTo(0, 0); });
            for (const id of ['btn-undo', 'btn-redo', 'btn-mode', 'btn-more']) {
                assert.equal(await page.locator('.actions #' + id).isVisible(), true);
                const rect = await page.locator('#' + id).boundingBox();
                assert.ok(rect.x >= 0 && rect.x + rect.width <= 180, id + ' fits');
            }
            assert.equal(await page.locator('#btn-mode').innerText(), 'Diff');
            const before = await page.evaluate(() => window.messages.length);
            await page.locator('#btn-mode').click();
            assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'toggleMode');
            await page.locator('#btn-more').focus();
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.locator('#btn-more').getAttribute('aria-expanded'), 'true');
            assert.equal(await page.evaluate(() => document.activeElement.parentElement.id), 'toolbar-overflow');
            await page.keyboard.press('End');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-settings');
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-more');
            assert.equal(await page.locator('#toolbar-overflow').isVisible(), false);
            assert.equal(await page.evaluate(() => window.messages.length), before + 1);
            await toolbarAction('#btn-search');
            assert.equal(await page.locator('#history-search').isVisible(), true);
            await toolbarAction('#show-current');
            await toolbarAction('#btn-pause');
            assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'togglePause');
            await page.locator('#btn-more').click();
            await page.screenshot({ path: path.join(root, 'overflow-menu.png') });
            await page.setViewportSize({ width: 620, height: 600 });
            await page.evaluate(() => syncStickyOffsets());
            assert.equal(await page.locator('#btn-more').isVisible(), true);
            assert.equal(await page.locator('.actions #show-current').count(), 0, 'reveal current is not a toolbar action even when wide');
            await page.locator('#btn-more').click();
            assert.equal(await page.locator('#show-current .menu-label').innerText(), 'Reveal current history');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.actions #btn-settings').isVisible(), true);
        });
        await check('smart timestamps distinguish yesterday, retain exact hover text and update without content edits', async () => {
            const before = await page.evaluate(() => window.messages.length);
            await page.evaluate(() => {
                const today = new Date();
                const dates = [today, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 14, 32), new Date(today.getFullYear() - 1, 3, 5)];
                const smartNodes = dates.map((date, id) => ({ id, timestamp: date.getTime(), label: 'save',
                    parents: id ? [id - 1] : [], children: id < 2 ? [id + 1] : [], storage: { kind: 'full' },
                    formattedTime: 'stale', lineCount: 1 }));
                renderState({ view: 'tree', nodes: smartNodes, currentId: 2, sourceUri: 'file:///smart-time.md',
                    rootId: 0, mode: 'navigate', timeFormat: 'smart', nodeSizeMetric: 'none', colorTheme: 'blue', paused: false });
                refreshSmartTimes(true);
            });
            assert.match(await page.locator('.node[data-node-id="0"] .time').innerText(), /^\d{2}:\d{2}$/);
            assert.equal(await page.locator('.node[data-node-id="1"] .time').innerText(), 'Yesterday 14:32');
            assert.match(await page.locator('.node[data-node-id="2"] .time').innerText(), /^\d{4}\/04\/05$/);
            assert.ok((await page.locator('.node[data-node-id="1"] .time').getAttribute('title')).length > 12);
            assert.equal(await page.evaluate(() => window.messages.length), before);
        });
        assert.deepEqual(errors, [], 'renderer has no uncaught exceptions');
        console.log(`UI regression artifacts: ${root}`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
