const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const { chromium } = require('playwright');

function loadExtension() {
    const vscode = {
        workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
        env: { language: 'en' },
        l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) },
    };
    const cache = new Map();
    function load(filename) {
        filename = path.resolve(__dirname, '../src', filename);
        if (cache.has(filename)) return cache.get(filename).exports;
        const mod = new Module(filename, module);
        mod.filename = filename;
        mod.paths = Module._nodeModulePaths(path.dirname(filename));
        cache.set(filename, mod);
        const original = mod.require.bind(mod);
        mod.require = name => name === 'vscode' ? vscode : name.startsWith('./')
            ? load(path.join(path.dirname(filename), name + '.ts')) : original(name);
        mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        }).outputText, filename);
        return mod.exports;
    }
    return { ...load('extension.ts').__test__, setLanguage(language) {
        vscode.env.language = language;
        load('runtimeL10n.ts').initializeRuntimeL10n({ extensionUri: { fsPath: path.resolve(__dirname, '..') } });
    } };
}

const healthy = {
    manifestStatus: 'ok', storageDir: 'C:/Users/developer/AppData/Roaming/Code/User/globalStorage/mmiyaji.vscode-undotree/undo-trees',
    manifestPath: 'C:/storage/undo-trees/manifest.json', backupManifestPath: 'C:/storage/undo-trees/manifest.json.bak',
    manifestExists: true, backupExists: true, manifestTreeCount: 28, treeFileCount: 28, contentFileCount: 164,
    orphanTreeFileCount: 0, orphanContentFileCount: 0, orphanTreeFiles: [], orphanContentFiles: [],
    validation: { status: 'ok', checkedTreeFiles: 28, missingTreeFiles: [], unreadableTreeFiles: [], missingContentHashes: [] },
    locks: { enabled: true, sessionId: 'local-session', total: 0, live: 0, stale: 0, owned: 0, items: [] },
};
const warnings = {
    ...healthy, manifestStatus: 'backup', orphanTreeFileCount: 2, orphanContentFileCount: null,
    orphanTreeFiles: ['unreferenced-a.json', 'unreferenced-b.json'],
    validation: { ...healthy.validation, status: 'error', missingTreeFiles: ['missing-history.json'], unreadableTreeFiles: ['damaged-history.json'] },
    locks: { ...healthy.locks, total: 1, live: 1, items: [{ uri: 'file:///project/src/extension.ts', sessionId: 'other-session', workspace: 'project', ageMs: 5000, updatedAt: Date.now() - 5000, isOwned: false, isLive: true }] },
};

async function main() {
    const { buildDiagnosticsHtml, setLanguage } = loadExtension();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'undotree-diagnostics-ui-'));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.addInitScript(() => {
            if (sessionStorage.getItem('resetNext')) {
                sessionStorage.removeItem('state');
                sessionStorage.removeItem('resetNext');
            }
            window.messages = [];
            window.acquireVsCodeApi = () => ({ postMessage: m => window.messages.push(m), getState: () => JSON.parse(sessionStorage.getItem('state') || '{}'), setState: s => sessionStorage.setItem('state', JSON.stringify(s)) });
        });
        async function render(name, snapshot, width = 1180, resetState = false) {
            fs.writeFileSync(path.join(root, name + '.html'), buildDiagnosticsHtml(snapshot));
            await page.setViewportSize({ width, height: 860 });
            if (resetState) {
                await page.evaluate(() => {
                    if (typeof frame !== 'undefined' && frame) { cancelAnimationFrame(frame); }
                    sessionStorage.clear();
                    sessionStorage.setItem('resetNext', '1');
                });
            }
            await page.goto(pathToFileURL(path.join(root, name + '.html')).toString());
            await page.evaluate(theme => {
                const style = document.createElement('style');
                style.nonce = document.querySelector('style').nonce;
                style.textContent = theme;
                document.head.appendChild(style);
            }, `:root { --vscode-font-family: 'Segoe UI', sans-serif; --vscode-foreground: #ccc; --vscode-descriptionForeground: #999; --vscode-editor-background: #1e1e1e; --vscode-sideBar-background: #181818; --vscode-panel-border: #3a3a3a; --vscode-focusBorder: #007fd4; --vscode-button-background: #007acc; --vscode-button-foreground: white; --vscode-button-secondaryBackground: #333; --vscode-button-secondaryForeground: #ccc; --vscode-testing-iconPassed: #89d185; --vscode-testing-iconQueued: #cca700; --vscode-errorForeground: #f48771; --vscode-textLink-foreground: #4daafc; } body { background: #1e1e1e; }`);
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        await render('warnings', warnings);
        await page.screenshot({ path: path.join(root, 'warnings.png'), fullPage: true });
        if (process.argv.includes('--capture-only')) { console.log(root); return; }
        const check = async (name, fn) => { await fn(); console.log('PASS: ' + name); };
        const complete = async message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', {
            data: { command: 'diagnosticsActionComplete', message },
        })), message);
        await check('repair, cleanup and developer actions live beside their relevant information', async () => {
            assert.equal(await page.locator('#integrity [data-command="validate"]').count(), 1);
            assert.equal(await page.locator('#integrity [data-command="rebuildManifest"]').count(), 1);
            assert.equal(await page.locator('#storage [data-command="openStorage"]').count(), 1);
            assert.equal(await page.locator('#storage [data-command="pruneOrphans"]').count(), 1);
            assert.equal(await page.locator('[data-command="openStorage"]').count(), 1);
            assert.equal(await page.locator('[data-command="simulateInvalid"]').isVisible(), false);
            assert.equal(await page.locator('[data-command="resetAll"]').isVisible(), false);
        });
        await check('warnings expose affected files and disable cleanup until references are trustworthy', async () => {
            assert.equal(await page.locator('.health.error').count(), 1);
            assert.equal(await page.locator('#missing-trees').getAttribute('open'), '');
            assert.ok((await page.locator('#missing-trees').innerText()).includes('missing-history.json'));
            assert.equal(await page.locator('[data-command="pruneOrphans"]').isDisabled(), true);
            await page.locator('#orphan-content summary').click();
            assert.ok((await page.locator('#orphan-content').innerText()).includes('Unavailable'));
            assert.ok((await page.locator('#windows').innerText()).includes('other windows'));
        });
        await check('navigation follows scroll, anchor clicks, page bottom and responsive layout', async () => {
            await page.setViewportSize({ width: 1180, height: 400 });
            for (const id of ['integrity', 'storage', 'windows']) {
                await page.evaluate(id => window.scrollTo(0, document.getElementById(id).offsetTop - 20), id);
                await page.waitForFunction(id => document.querySelector('nav a[aria-current="location"]')?.hash === '#' + id, id);
                assert.equal(await page.locator('nav [aria-current]').count(), 1);
            }
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            await page.waitForFunction(() => document.querySelector('nav a[aria-current="location"]')?.hash === '#advanced');
            await page.locator('nav a[href="#integrity"]').click();
            await page.waitForFunction(() => document.querySelector('nav a[aria-current="location"]')?.hash === '#integrity');
            await page.setViewportSize({ width: 640, height: 400 });
            await page.evaluate(() => window.scrollTo(0, document.getElementById('storage').offsetTop - 20));
            await page.waitForFunction(() => document.querySelector('nav a[aria-current="location"]')?.hash === '#storage');
            await page.setViewportSize({ width: 1180, height: 860 });
            await page.evaluate(() => window.scrollTo(0, 0));
        });
        await check('actions dispatch exactly once while busy, then preserve disabled safeguards', async () => {
            await page.locator('[data-command="validate"]').click();
            assert.deepEqual(await page.evaluate(() => window.messages), [{ command: 'validate' }]);
            assert.equal(await page.locator('body').getAttribute('aria-busy'), 'true');
            await page.locator('[data-command="validate"]').evaluate(button => button.click());
            assert.equal(await page.evaluate(() => window.messages.length), 1);
            await complete('Action failed. Open Output for details.');
            assert.equal(await page.locator('[data-command="validate"]').isEnabled(), true);
            assert.equal(await page.locator('[data-command="pruneOrphans"]').isDisabled(), true);
            assert.ok((await page.locator('#action-status').innerText()).includes('Action failed'));
        });
        await check('refresh restores scroll and expanded sections', async () => {
            await page.locator('#failure-simulation summary').click();
            await page.locator('[data-command="simulateBackup"]').scrollIntoViewIfNeeded();
            await page.locator('[data-command="simulateBackup"]').click();
            assert.equal(await page.evaluate(() => window.messages.at(-1).command), 'simulateBackup');
            const scroll = await page.evaluate(() => scrollY);
            await page.reload();
            await page.waitForFunction(() => document.getElementById('failure-simulation').open);
            await page.waitForFunction(expected => Math.abs(scrollY - expected) < 4, scroll, { timeout: 3000 });
        });
        await render('healthy', healthy);
        await check('healthy and empty storage have distinct states without unnecessary cleanup', async () => {
            assert.ok((await page.locator('.health').innerText()).includes('healthy'));
            assert.equal(await page.locator('[data-command="pruneOrphans"]').isDisabled(), true);
            await page.screenshot({ path: path.join(root, 'healthy.png'), fullPage: true });
            await render('empty', { ...healthy, manifestStatus: 'missing', manifestExists: false, backupExists: false,
                manifestTreeCount: 0, treeFileCount: 0, contentFileCount: 0, orphanTreeFileCount: null, orphanContentFileCount: null,
                validation: { ...healthy.validation, checkedTreeFiles: 0 } });
            assert.ok((await page.locator('.health').innerText()).includes('No saved history yet'));
            assert.equal(await page.locator('.health.error').count(), 0);
        });
        await check('only orphan trees can be cleaned while content is retained', async () => {
            await render('content-only', { ...healthy, orphanContentFileCount: 1, orphanContentFiles: ['orphan-content-hash'] });
            assert.equal(await page.locator('[data-command="pruneOrphans"]').isDisabled(), true);
            await render('cleanup', { ...healthy, orphanTreeFileCount: 1, orphanTreeFiles: ['orphan.json'], orphanContentFileCount: 1, orphanContentFiles: ['orphan-content-hash'] });
            await page.locator('[data-command="pruneOrphans"]').click();
            assert.deepEqual(await page.evaluate(() => window.messages), [{ command: 'pruneOrphans' }]);
            await complete('');
        });
        await check('desktop and 320px layouts fit long paths and file names', async () => {
            for (const width of [1180, 640, 320]) {
                await render('responsive-' + width, { ...warnings,
                    storageDir: 'C:/' + 'long-directory/'.repeat(35),
                    validation: { ...warnings.validation, missingTreeFiles: ['<script>bad()</script>' + 'a'.repeat(160) + '.json'] },
                }, width);
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow at ' + width);
                assert.equal(await page.locator('#missing-trees script').count(), 0);
                assert.ok((await page.locator('#missing-trees').innerText()).includes('<script>bad()</script>'));
            }
            await page.screenshot({ path: path.join(root, 'narrow.png'), fullPage: true });
        });
        await check('Japanese diagnostics use the extension localization and retain the same layout', async () => {
            setLanguage('ja');
            await render('japanese', warnings, 1180, true);
            assert.equal(await page.locator('h1').innerText(), '診断');
            assert.equal(await page.locator('#storage-title').innerText(), '保存領域');
            assert.equal(await page.locator('[data-command="simulateInvalid"]').isVisible(), false);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: path.join(root, 'japanese.png'), fullPage: true });
        });
        assert.deepEqual(errors, []);
        console.log(`Diagnostics UI artifacts: ${root}`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
