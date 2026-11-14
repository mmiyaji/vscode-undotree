const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

async function main() {
    const root = process.argv[2];
    if (!root) { throw new Error('Pass the artifact directory from benchmark-history.cjs'); }
    const { results: scenarios } = JSON.parse(await fs.readFile(path.join(root, 'metrics.json'), 'utf8'));
    const results = [];
    for (const scenario of scenarios) {
        const browser = await chromium.launch({ channel: 'msedge', headless: true });
        try {
            const page = await browser.newPage({ viewport: { width: 340, height: 900 } });
            const errors = [];
            page.on('pageerror', error => errors.push(String(error)));
            await page.addInitScript(() => {
                window.messages = [];
                window.acquireVsCodeApi = () => ({ postMessage(value) { window.messages.push(value); }, getState() {}, setState() {} });
            });
            const start = performance.now();
            await page.goto(pathToFileURL(path.join(root, scenario.name, 'view.html')).toString(), { timeout: 45_000 });
            const loadMs = performance.now() - start;
            const renderedNodes = await page.locator('.node').count();
            const refreshMs = [];
            if (errors.length === 0) {
                for (let repeat = 0; repeat < 3; repeat++) {
                    refreshMs.push(await page.evaluate(() => {
                        const start = performance.now();
                        renderState({ view: 'tree', nodes, currentId, mode, timeFormat, timeFormatCustom,
                            nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId, paused: false });
                        return performance.now() - start;
                    }));
                }
                assert.equal(await page.evaluate(() => nodeIds.length), scenario.nodeCount, 'all history nodes remain navigable');
                assert.ok(renderedNodes <= 500, 'DOM size must remain bounded');
                await page.locator('#tree').focus();
                for (const [key, index] of [['Home', 0], ['ArrowDown', 1], ['End', scenario.nodeCount - 1], ['ArrowUp', scenario.nodeCount - 2]]) {
                    await page.keyboard.press(key);
                    assert.equal(await page.evaluate(() => focusedIndex), index);
                    assert.ok(await page.evaluate(() => nodeEls[focusedIndex]?.isConnected), 'focused node is rendered');
                    assert.equal(await page.locator('.node.focused').count(), 1);
                }
                await page.keyboard.press('Enter');
                assert.equal(await page.evaluate(() => window.messages.at(-1).nodeId),
                    await page.evaluate(() => nodeIds[focusedIndex]), 'keyboard activation sends the selected node');
                if (scenario.nodeCount > 500) {
                    await page.evaluate(() => window.scrollTo(0, 22 * Math.floor(nodeIds.length / 2)));
                    await page.waitForFunction(() => nodeEls[Math.floor(nodeIds.length / 2)]?.isConnected);
                }
            }
            const result = { name: scenario.name, browser: browser.version(), expectedNodes: scenario.nodeCount,
                renderedNodes, loadMs, refreshMs, errors };
            results.push(result);
            console.log(JSON.stringify(result));
            await fs.writeFile(path.join(root, 'renderer-metrics.json'), JSON.stringify(results, null, 2));
            assert.deepEqual(errors, [], 'no renderer exceptions');
            if (scenario.nodeCount > 10_000) {
                await page.evaluate(() => renderState({ view: 'tree',
                    nodes: nodes.map((node, index) => index === 1 ? { ...node, pinned: true, note: '日本語 <note>' } : node),
                    currentId, mode, timeFormat, timeFormatCustom, nodeSizeMetric, nodeSizeMetricBase,
                    showStorageKind, colorTheme, sourceUri, rootId, paused: false }));
                await page.locator('.pinned-link').click();
                assert.equal(await page.evaluate(() => focusedIndex), 1);
                assert.equal(await page.locator('.node.focused .note-text').innerText(), '日本語 <note>');
                assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'jumpToNode');
                await page.evaluate(() => renderState({ view: 'tree', nodes, currentId, mode: 'diff', timeFormat,
                    timeFormatCustom, nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId, paused: false }));
                await page.locator('#btn-diff-pair').click();
                await page.locator('#tree').focus();
                await page.keyboard.press('Home');
                await page.keyboard.press('ArrowDown');
                await page.keyboard.press('b');
                await page.keyboard.press('End');
                assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'diffBetweenNodes');
                assert.equal(await page.evaluate(() => window.messages.at(-1).leftNodeId), await page.evaluate(() => nodeIds[1]));
                assert.equal(await page.evaluate(() => window.messages.at(-1).rightNodeId), await page.evaluate(() => nodeIds.at(-1)));
                await page.setViewportSize({ width: 340, height: 180 });
                await page.keyboard.press('Home');
                assert.ok(await page.evaluate(() => nodeEls[focusedIndex].getBoundingClientRect().top
                    >= document.getElementById('diff-tools').getBoundingClientRect().bottom), 'focus remains visible below sticky tools in a short sidebar');
                await page.keyboard.press('End');
                assert.ok(await page.evaluate(() => nodeEls[focusedIndex].getBoundingClientRect().bottom <= window.innerHeight));
                await page.evaluate(() => {
                    const entries = [
                        { id: 41, parents: [], children: [42, 45] },
                        { id: 42, parents: [41], children: [43, 44] },
                        { id: 43, parents: [42], children: [] },
                        { id: 44, parents: [42], children: [] },
                        { id: 45, parents: [41], children: [] },
                    ].map(node => ({ ...node, timestamp: node.id, label: String(node.id), storage: { kind: 'full' } }));
                    renderState({ view: 'tree', nodes: entries, currentId: 44, mode: 'navigate', timeFormat,
                        timeFormatCustom, nodeSizeMetric, nodeSizeMetricBase, showStorageKind, colorTheme, sourceUri, rootId: 41 });
                });
                assert.deepEqual(await page.evaluate(() => nodeIds), [41, 42, 43, 44, 45]);
                assert.equal(await page.locator('.node').count(), 5);
                assert.equal(await page.locator('.node').first().locator('.graph').count(), 0, 'non-zero root has no connector');
                assert.deepEqual(errors, [], 'pin, diff and branch interactions must not throw');
            }
        } finally { await browser.close(); }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
