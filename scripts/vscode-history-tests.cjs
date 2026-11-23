const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const vscode = require('vscode');

exports.run = async function () {
    const root = process.env.UNDOTREE_E2E_ROOT;
    assert.ok(root, 'Run through scripts/run-vscode-history.mjs');
    const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const storage = path.join(root, 'user-data', 'User', 'globalStorage', 'mmiyaji.vscode-undotree', 'undo-trees');
    const restarting = process.env.UNDOTREE_E2E_PHASE === 'restart';
    const results = restarting ? JSON.parse(await fs.readFile(path.join(root, 'results.json'), 'utf8')) : [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const command = name => vscode.commands.executeCommand(`undotree.${name}`);
    const config = vscode.workspace.getConfiguration('undotree');
    const base = 'abcdefghij'.repeat(10);
    const largeVersion = index => `${index}:` + '0123456789あ😀\r\n'.repeat(40_000);
    await vscode.extensions.getExtension('mmiyaji.vscode-undotree').activate();

    async function run(name, operation) {
        try {
            await operation();
            results.push({ name, passed: true });
        } catch (error) {
            results.push({ name, passed: false, error: String(error.stack || error) });
        }
        await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    }
    async function open(name) {
        const file = path.join(workspace, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, base);
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document);
        await sleep(500);
        return editor;
    }
    async function append(editor, text, save = true) {
        assert.ok(await editor.edit(edit => edit.insert(editor.document.positionAt(editor.document.getText().length), text)));
        if (save) { assert.ok(await editor.document.save()); }
        await sleep(300);
    }
    async function snapshot(uri) {
        await command('savePersistedState');
        const manifest = JSON.parse(await fs.readFile(path.join(storage, 'manifest.json'), 'utf8'));
        const entry = manifest.trees.find(entry => entry.uri === uri.toString());
        if (!entry) { return undefined; }
        const buffer = await fs.readFile(path.join(storage, entry.file));
        const payload = JSON.parse((buffer[0] === 0x1f ? gunzipSync(buffer) : buffer).toString());
        assert.equal(payload.uri, uri.toString(), 'tree recovery metadata must follow its renamed URI');
        return payload.tree;
    }

    if (restarting) {
        await run('restart and repeated reopen select the saved ancestor without duplicate restores', async () => {
            const expected = JSON.parse(await fs.readFile(path.join(root, 'saved-ancestor.json'), 'utf8'));
            const uri = vscode.Uri.parse(expected.uri);
            for (let round = 0; round < 2; round++) {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                assert.equal(doc.getText(), base + 'saved');
                const tree = await snapshot(uri);
                assert.equal(tree.currentId, expected.savedId);
                assert.deepEqual(tree.nodes.map(n => n.hash), expected.hashes);
                assert.equal(tree.nodes.some(n => n.label === 'restore'), false);
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await sleep(500);
            }
        });
        await run('saved histories and renamed descendants survive a VS Code restart', async () => {
            const expected = JSON.parse(await fs.readFile(path.join(root, 'expected.json'), 'utf8'));
            for (const item of expected) {
                const uri = vscode.Uri.parse(item.uri);
                const document = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(document);
                await sleep(500);
                assert.equal(document.getText(), item.content);
                const tree = await snapshot(uri);
                assert.deepEqual(tree.nodes.map(node => node.hash), item.hashes);
            }
        });
        await run('compressed full history restores earlier contents after restart', async () => {
            const document = await vscode.workspace.openTextDocument(path.join(workspace, 'large-full.md'));
            await vscode.window.showTextDocument(document);
            await sleep(500);
            await command('undo');
            assert.equal(document.getText(), largeVersion(2));
            await command('undo');
            assert.equal(document.getText(), largeVersion(1));
            await command('redo');
            await command('redo');
            assert.equal(document.getText(), largeVersion(3));
        });
        await command('show');
        await sleep(Number(process.env.UNDOTREE_E2E_HOLD_MS || 2000));
        if (results.some(result => !result.passed)) { throw new Error('Restart checks failed; see results.json'); }
        return;
    }

    await run('native undo and redo preserve an unsaved future and a saved branch', async () => {
        const editor = await open('native-history.md');
        await append(editor, 'B', false);
        await vscode.commands.executeCommand('undo');
        assert.equal(editor.document.getText(), base);
        await vscode.commands.executeCommand('redo');
        assert.equal(editor.document.getText(), base + 'B');
        await vscode.commands.executeCommand('undo');
        await append(editor, 'C');
        const tree = await snapshot(editor.document.uri);
        assert.equal(tree.nodes.length, 3);
        assert.equal(tree.nodes.find(n => n.id === tree.rootId).children.length, 2);
        assert.ok(tree.nodes.some(n => n.label === 'edit'));
        assert.equal(tree.nodes.find(n => n.id === tree.currentId).label, 'save');
    });
    await run('ordinary saves retain delta nodes', async () => {
        const editor = await open('saves.md');
        for (let i = 0; i < 4; i++) { await append(editor, 'x'); }
        await command('show');
        const tree = await snapshot(editor.document.uri);
        assert.equal(tree.nodes.filter(node => node.storage.kind === 'delta' && node.label === 'save').length, 4);
    });
    await run('compact removes linear delta nodes and preserves restored content', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(workspace, 'saves.md'));
        await vscode.window.showTextDocument(document);
        await command('compact');
        const tree = await snapshot(document.uri);
        assert.ok(tree.nodes.length < 5);
        await command('undo');
        await command('redo');
        assert.equal(document.getText(), `${base}xxxx`);
    });
    await run('saving and switching editors while paused does not record history', async () => {
        const editor = await open('paused.md');
        await append(editor, '1');
        const before = await snapshot(editor.document.uri);
        await command('togglePause');
        try {
            await append(editor, 'paused');
            await open('other.md');
            await vscode.window.showTextDocument(editor.document);
            await sleep(300);
            const after = await snapshot(editor.document.uri);
            assert.equal(after.nodes.length, before.nodes.length);
        } finally { await command('togglePause'); }
    });
    await run('resume followed by autosave restores all edits', async () => {
        const editor = await open('resume.md');
        await command('togglePause');
        assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'X')));
        await command('togglePause');
        await append(editor, 'Y', false);
        await config.update('autosaveInterval', 5, vscode.ConfigurationTarget.Global);
        await sleep(5600);
        await config.update('autosaveInterval', 0, vscode.ConfigurationTarget.Global);
        await command('undo');
        await sleep(300);
        assert.equal(editor.document.getText(), base);
        await command('redo');
        await sleep(300);
        assert.equal(editor.document.getText(), `X${base}Y`);
    });
    await run('persisted unsaved auto state survives discarding the edited file', async () => {
        await config.update('persistenceMode', 'auto', vscode.ConfigurationTarget.Global);
        const editor = await open('reopen-saved-ancestor.md');
        await append(editor, 'saved');
        const uri = editor.document.uri;
        const saved = await snapshot(uri);
        await append(editor, 'unsaved', false);
        await config.update('autosaveInterval', 5, vscode.ConfigurationTarget.Global);
        await sleep(5600);
        await config.update('autosaveInterval', 0, vscode.ConfigurationTarget.Global);
        const withAuto = await snapshot(uri);
        assert.equal(withAuto.nodes.length, saved.nodes.length + 1);
        assert.equal(withAuto.nodes.find(n => n.id === withAuto.currentId).label, 'auto');
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await sleep(500);
        assert.equal(await fs.readFile(uri.fsPath, 'utf8'), base + 'saved');
        // A closed VS Code model can remain resident. The restart phase forces
        // a real load of the persisted auto cursor against the saved ancestor.
        await fs.writeFile(path.join(root, 'saved-ancestor.json'), JSON.stringify({
            uri: uri.toString(), savedId: saved.currentId, hashes: withAuto.nodes.map(n => n.hash),
        }));
    });
    await run('folder rename preserves open and closed descendant histories', async () => {
        await config.update('persistenceMode', 'auto', vscode.ConfigurationTarget.Global);
        const closed = await open('before/nested/closed.md');
        await append(closed, 'closed-history');
        const closedUri = closed.document.uri;
        const closedTree = await snapshot(closedUri);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await sleep(500);
        const editor = await open('before/open.md');
        await append(editor, 'open-history');
        const oldUri = editor.document.uri;
        const oldTree = await snapshot(oldUri);
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(vscode.Uri.file(path.join(workspace, 'before')), vscode.Uri.file(path.join(workspace, 'after')));
        assert.ok(await vscode.workspace.applyEdit(edit));
        await sleep(1500);
        const renamedUri = vscode.Uri.file(path.join(workspace, 'after/open.md'));
        const renamed = await vscode.workspace.openTextDocument(renamedUri);
        await vscode.window.showTextDocument(renamed);
        await sleep(500);
        const tree = await snapshot(renamedUri);
        assert.ok(tree, 'renamed open file must retain a persisted tree');
        assert.deepEqual(tree.nodes.map(node => node.hash), oldTree.nodes.map(node => node.hash));
        const closedRenamedUri = vscode.Uri.file(path.join(workspace, 'after/nested/closed.md'));
        const closedAfter = await snapshot(closedRenamedUri);
        assert.ok(closedAfter, 'closed descendant must also migrate');
        assert.deepEqual(closedAfter.nodes.map(node => node.hash), closedTree.nodes.map(node => node.hash));
        assert.equal(await snapshot(oldUri), undefined);
        assert.equal(await snapshot(closedUri), undefined);
        await command('undo');
        await sleep(300);
        assert.equal(renamed.getText(), base);
    });
    await run('external changes to a closed file remain restorable after saving', async () => {
        await config.update('persistenceMode', 'manual', vscode.ConfigurationTarget.Global);
        const editor = await open('reopen.md');
        await append(editor, 'saved');
        const uri = editor.document.uri;
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await sleep(500);
        await fs.writeFile(uri.fsPath, `external-${base}`);
        const reopened = await vscode.workspace.openTextDocument(uri);
        const nextEditor = await vscode.window.showTextDocument(reopened);
        await sleep(500);
        assert.equal(reopened.getText(), `external-${base}`);
        await append(nextEditor, '!');
        await command('undo');
        // VS Code may retain the closed model and deliver a change event, or
        // dispose it and deliver a new open event. Either way Undo must move
        // away and Redo must reconstruct the entire externally changed text.
        assert.notEqual(reopened.getText(), `external-${base}!`);
        await command('redo');
        assert.equal(reopened.getText(), `external-${base}!`);
    });
    await run('large full snapshots survive cache eviction, persistence, and navigation', async () => {
        await config.update('persistenceMode', 'manual', vscode.ConfigurationTarget.Global);
        await config.update('contentCacheMaxKB', 0, vscode.ConfigurationTarget.Global);
        const editor = await open('large-full.md');
        for (let index = 0; index < 4; index++) {
            assert.ok(await editor.edit(edit => edit.replace(new vscode.Range(
                editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)
            ), largeVersion(index))));
            assert.ok(await editor.document.save());
            await sleep(200);
        }
        await command('undo');
        assert.equal(editor.document.getText(), largeVersion(2));
        await command('undo');
        assert.equal(editor.document.getText(), largeVersion(1));
        await command('redo');
        await command('redo');
        assert.equal(editor.document.getText(), largeVersion(3));
        const tree = await snapshot(editor.document.uri);
        assert.ok(tree.nodes.filter(node => node.storage.kind === 'checkpoint').length >= 2);
    });
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    await sleep(500);
    const expected = [];
    for (const name of ['native-history.md', 'saves.md', 'resume.md', 'after/open.md', 'after/nested/closed.md', 'reopen.md', 'large-full.md']) {
        const uri = vscode.Uri.file(path.join(workspace, name));
        const tree = await snapshot(uri);
        if (tree) {
            expected.push({ uri: uri.toString(), hashes: tree.nodes.map(node => node.hash), content: await fs.readFile(uri.fsPath, 'utf8') });
        }
    }
    await fs.writeFile(path.join(root, 'expected.json'), JSON.stringify(expected, null, 2));
    await command('show');
    await sleep(1000);
    if (results.some(result => !result.passed)) { throw new Error('History integration checks failed; see results.json'); }
};
