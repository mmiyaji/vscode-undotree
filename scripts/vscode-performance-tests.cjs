const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const vscode = require('vscode');
const assert = require('node:assert/strict');

exports.run = async () => {
    const root = process.env.UNDOTREE_PERF_ROOT;
    const fixtures = process.env.UNDOTREE_PERF_FIXTURES;
    // Finish activation against empty storage before staging fixtures, so the
    // startup metadata check cannot observe partially copied tree files.
    await vscode.extensions.getExtension('mmiyaji.vscode-undotree').activate();
    const { results: scenarios } = JSON.parse(await fs.readFile(path.join(fixtures, 'metrics.json'), 'utf8'));
    const storage = path.join(root, 'user-data', 'User', 'globalStorage', 'mmiyaji.vscode-undotree', 'undo-trees');
    await fs.mkdir(path.join(storage, 'content'), { recursive: true });
    const entries = [];
    let nextId = 1;
    for (const scenario of scenarios) {
        const source = path.join(fixtures, scenario.name, 'storage', 'undo-trees');
        const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
        nextId = Math.max(nextId, manifest.nextId);
        const buffer = await fs.readFile(path.join(source, manifest.trees[0].file));
        const payload = JSON.parse((buffer[0] === 0x1f ? gunzipSync(buffer) : buffer).toString());
        const uri = vscode.Uri.file(path.join(fixtures, scenario.name, 'file.md')).toString();
        payload.uri = uri;
        const file = crypto.createHash('sha1').update(uri).digest('hex') + '.json';
        await fs.writeFile(path.join(storage, file), JSON.stringify(payload));
        const sourceContent = path.join(source, 'content');
        const hasContentDirectory = await fs.stat(sourceContent).then(stat => stat.isDirectory()).catch(error => {
            if (error.code === 'ENOENT') { return false; }
            throw error;
        });
        if (hasContentDirectory) {
            await fs.cp(sourceContent, path.join(storage, 'content'), { recursive: true });
        }
        entries.push({ uri, file });
    }
    await fs.writeFile(path.join(storage, 'manifest.json'), JSON.stringify({ version: 1, savedAt: Date.now(), nextId, paused: false, trees: entries }));
    const results = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const timed = async operation => { const start = performance.now(); await operation(); return performance.now() - start; };
    let maxLag = 0, previous = performance.now();
    const heartbeat = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - previous - 10); previous = now; }, 10);
    try {
        for (const scenario of scenarios) {
            try {
            maxLag = 0;
            const uri = vscode.Uri.file(path.join(fixtures, scenario.name, 'file.md'));
            let document, editor;
            const openMs = await timed(async () => { document = await vscode.workspace.openTextDocument(uri); editor = await vscode.window.showTextDocument(document); });
            await vscode.commands.executeCommand('undotree.show');
            await sleep(2500);
            const openingMaxLagMs = maxLag;
            // Keep the source editor active for the extension commands.
            editor = await vscode.window.showTextDocument(document);
            const original = document.getText();
            maxLag = 0;
            const undoMs = await timed(() => vscode.commands.executeCommand('undotree.undo'));
            assert.notEqual(document.getText(), original, 'Undo must actually change the file');
            await sleep(60);
            const undoMaxLagMs = maxLag;
            maxLag = 0;
            const redoMs = await timed(() => vscode.commands.executeCommand('undotree.redo'));
            assert.equal(document.getText(), original, 'Redo must restore every character');
            await sleep(60);
            const redoMaxLagMs = maxLag;
            maxLag = 0;
            const persistMs = await timed(() => vscode.commands.executeCommand('undotree.savePersistedState'));
            await sleep(60);
            const result = { name: scenario.name, vscode: vscode.version, openMs, openingMaxLagMs, undoMs, undoMaxLagMs,
                redoMs, redoMaxLagMs, persistMs, persistMaxLagMs: maxLag,
                extensionHostHeapMiB: process.memoryUsage().heapUsed / 1048576 };
            results.push(result);
            await fs.writeFile(path.join(root, 'metrics.json'), JSON.stringify(results, null, 2));
            await document.save();
            if (scenario.name === '1KiB-10000-deltas' && process.env.UNDOTREE_PERF_HOLD_MS) {
                await sleep(Number(process.env.UNDOTREE_PERF_HOLD_MS));
            }
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            } catch (error) {
                results.push({ name: scenario.name, vscode: vscode.version, error: String(error) });
                await fs.writeFile(path.join(root, 'metrics.json'), JSON.stringify(results, null, 2));
            }
        }
        await sleep(2000);
        const unexpected = results.filter(result => result.error && !(result.name === '50MiB-100-deltas'
            && result.error.includes('Files above 50MB cannot be synchronized with extensions')));
        if (unexpected.length) { throw new Error(`Native performance assertions failed: ${JSON.stringify(unexpected)}`); }
    } finally { clearInterval(heartbeat); }
};
