const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
    const root = process.env.UNDOTREE_TRACKING_ROOT;
    assert.ok(root, 'Run through scripts/run-vscode-tracking.mjs');
    const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const storage = path.join(root, 'user-data', 'User', 'globalStorage', 'mmiyaji.vscode-undotree', 'undo-trees');
    const results = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const command = name => vscode.commands.executeCommand(`undotree.${name}`);
    const config = () => vscode.workspace.getConfiguration('undotree');
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
        await fs.writeFile(file, 'initial\n');
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        await sleep(300);
        assert.ok(await editor.edit(edit => edit.insert(doc.positionAt(doc.getText().length), 'edited\n')));
        assert.ok(await doc.save());
        await sleep(300);
        return editor;
    }
    async function isPersisted(editor) {
        await command('savePersistedState');
        const manifest = JSON.parse(await fs.readFile(path.join(storage, 'manifest.json'), 'utf8'));
        return manifest.trees.some(entry => entry.uri === editor.document.uri.toString());
    }
    async function expectTracked(name, expected) {
        const editor = await open(name);
        assert.equal(await isPersisted(editor), expected, name);
        return editor;
    }
    async function update(key, value) {
        await config().update(key, value, vscode.ConfigurationTarget.Workspace);
        await sleep(250);
    }

    await run('default code, extensionless files, and dotfiles record history', async () => {
        for (const name of ['defaults/app.ts', 'defaults/component.tsx', 'defaults/main.py', 'defaults/settings.yaml', 'defaults/Dockerfile', 'defaults/.gitignore']) {
            await expectTracked(name, true);
        }
    });
    await run('generated dependencies and minified files are excluded by default', async () => {
        for (const name of ['node_modules/pkg/index.js', 'nested/node_modules/pkg/index.ts', 'generated/app.min.js', 'package-lock.json']) {
            await expectTracked(name, false);
        }
    });
    await run('text data is included and known binary extensions are excluded by default', async () => {
        await expectTracked('defaults/data.csv', true);
        await expectTracked('defaults/output.log', true);
        await expectTracked('defaults/image.png', false);
    });
    await run('virtual text documents are not recorded even with a supported extension', async () => {
        const registration = vscode.workspace.registerTextDocumentContentProvider('tracking-test', {
            provideTextDocumentContent: () => 'virtual text\n',
        });
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('tracking-test:/virtual.ts'));
            const editor = await vscode.window.showTextDocument(doc);
            await sleep(300);
            assert.equal(await isPersisted(editor), false);
        } finally {
            registration.dispose();
        }
    });
    await run('existing explicit extension list does not gain code or filename defaults', async () => {
        await update('enabledExtensions', ['.md']);
        await expectTracked('custom/note.md', true);
        await expectTracked('custom/main.ts', false);
        await expectTracked('custom/Dockerfile', false);
    });
    await run('enabling a suppressed default filename adds only that name', async () => {
        await expectTracked('custom-toggle/Dockerfile', false);
        await command('toggleTracking');
        await sleep(250);
        assert.deepEqual(config().get('enabledFileNames'), ['Dockerfile']);
        await expectTracked('custom-toggle-after/Dockerfile', true);
        await expectTracked('custom-toggle-after/Makefile', false);
        await update('enabledFileNames', undefined);
    });
    await run('empty extension list disables tracking until filenames are explicitly enabled', async () => {
        await update('enabledExtensions', []);
        await expectTracked('empty/note.md', false);
        await expectTracked('empty/Dockerfile', false);
        await update('enabledFileNames', ['Makefile']);
        await expectTracked('empty/Makefile', true);
    });
    await run('filename toggle enables and disables extensionless files without enabling all extensionless files', async () => {
        await expectTracked('toggle/OWNFILE', false);
        await command('toggleTracking');
        await sleep(250);
        assert.ok(config().get('enabledFileNames').includes('OWNFILE'));
        await expectTracked('toggle-enabled/OWNFILE', true);
        await expectTracked('toggle-enabled/UNRELATED', false);
        const doc = await vscode.workspace.openTextDocument(path.join(workspace, 'toggle-enabled/OWNFILE'));
        await vscode.window.showTextDocument(doc);
        await command('toggleTracking');
        await sleep(250);
        assert.ok(!config().get('enabledFileNames').some(value => value.toLowerCase() === 'ownfile'));
        await expectTracked('toggle-disabled/OWNFILE', false);
    });
    await run('path exclusions preserve basename patterns and distinguish root from nested directories', async () => {
        await update('enabledExtensions', ['.ts']);
        await update('excludePatterns', ['generated/**', '**/cache/**', '*.min.*']);
        await expectTracked('generated/test.ts', false);
        await expectTracked('nested/generated/test.ts', true);
        await expectTracked('cache/test.ts', false);
        await expectTracked('nested/cache/test.ts', false);
        await expectTracked('nested/test.min.ts', false);
        await expectTracked('nested/source.ts', true);
    });
    await run('explicit empty exclusions permit generated files when their extension is enabled', async () => {
        await update('excludePatterns', []);
        await expectTracked('node_modules/explicit/test.ts', true);
    });
    await run('first extension toggle preserves default filename tracking', async () => {
        await update('enabledExtensions', undefined);
        await update('enabledFileNames', undefined);
        await update('excludePatterns', undefined);
        await expectTracked('first-toggle/source.js', true);
        await command('toggleTracking');
        await sleep(250);
        assert.ok(config().get('excludePatterns').includes('*.js'));
        await expectTracked('first-toggle-after/source.js', false);
        await expectTracked('first-toggle-after/Dockerfile', true);
        await expectTracked('first-toggle-after/.gitignore', true);
    });
    await run('each workspace folder uses its own tracking settings', async () => {
        const other = vscode.workspace.workspaceFolders[1];
        assert.ok(other, 'The runner must create a multi-root workspace');
        const otherConfig = vscode.workspace.getConfiguration('undotree', other.uri);
        await otherConfig.update('enabledExtensions', ['.py'], vscode.ConfigurationTarget.WorkspaceFolder);
        await otherConfig.update('enabledFileNames', [], vscode.ConfigurationTarget.WorkspaceFolder);
        await otherConfig.update('excludePatterns', [], vscode.ConfigurationTarget.WorkspaceFolder);
        await sleep(300);
        await expectTracked('../other-workspace/main.ts', false);
        await expectTracked('../other-workspace/main.py', true);
        await expectTracked('../other-workspace/Dockerfile', false);
        await expectTracked('multi-root/main.ts', true);
    });
    if (results.some(result => !result.passed)) {
        throw new Error('Tracking integration checks failed; see results.json');
    }
};
