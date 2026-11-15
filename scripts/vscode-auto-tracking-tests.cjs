const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const vscode = require('vscode');

exports.run = async function () {
    const root = process.env.UNDOTREE_TRACKING_ROOT;
    assert.ok(root, 'Run npm run test:e2e:tracking:auto');
    const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const storage = path.join(root, 'user-data', 'User', 'globalStorage', 'mmiyaji.vscode-undotree', 'undo-trees');
    const extension = vscode.extensions.getExtension('mmiyaji.vscode-undotree');
    await extension.activate();
    const results = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const config = () => vscode.workspace.getConfiguration('undotree');
    const summarize = value => ({ length: value.length, preview: value.slice(0, 70) });

    async function record(name, operation) {
        try { results.push({ name, passed: true, ...await operation() }); }
        catch (error) { results.push({ name, passed: false, error: String(error.stack || error) }); }
        await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    }
    async function update(key, value, resource) {
        await vscode.workspace.getConfiguration('undotree', resource).update(key, value,
            resource ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
        await sleep(100);
    }
    async function manifest() {
        try { return JSON.parse(await fs.readFile(path.join(storage, 'manifest.json'), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') { return { trees: [] }; } throw error; }
    }
    async function snapshot(document) {
        const entry = (await manifest()).trees.find(item => item.uri === document.uri.toString());
        if (!entry) { return undefined; }
        const buffer = await fs.readFile(path.join(storage, entry.file));
        return JSON.parse((buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer).toString('utf8')).tree;
    }
    async function contentAt(tree, id) {
        const node = tree.nodes.find(item => item.id === id);
        assert.ok(node, `Missing node ${id}`);
        if (node.storage.kind === 'full') { return node.storage.content; }
        if (node.storage.kind === 'checkpoint') {
            const raw = await fs.readFile(path.join(storage, 'content', node.storage.contentHash));
            const buffer = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
            return buffer.subarray(0, 4).equals(Buffer.from([0xff, 0x55, 0x54, 0x31]))
                ? buffer.subarray(4).toString('utf16le') : buffer.toString('utf8');
        }
        let content = await contentAt(tree, node.parents.at(-1));
        for (const event of node.storage.diffs) {
            for (const diff of [...event].sort((a, b) => b.offset - a.offset)) {
                content = content.slice(0, diff.offset) + diff.inserted + content.slice(diff.offset + diff.removeLength);
            }
        }
        return content;
    }
    async function waitForContent(document, expected) {
        const deadline = Date.now() + 12_000;
        let tree;
        do {
            tree = await snapshot(document);
            if (tree && await contentAt(tree, tree.currentId) === expected) { return tree; }
            await sleep(100);
        } while (Date.now() < deadline);
        throw new Error(`Automatic persistence did not contain latest content: ${document.uri}`);
    }
    async function open(name, initial) {
        const file = path.join(workspace, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, initial);
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        return { document, editor };
    }
    async function append(opened, text, save = true) {
        assert.ok(await opened.editor.edit(edit => edit.insert(opened.document.positionAt(opened.document.getText().length), text)));
        if (save) { assert.ok(await opened.document.save()); }
    }
    async function replace(opened, text) {
        assert.ok(await opened.editor.edit(edit => edit.replace(new vscode.Range(
            opened.document.positionAt(0), opened.document.positionAt(opened.document.getText().length)), text)));
        assert.ok(await opened.document.save());
    }
    async function batch(cases) {
        const opened = [];
        for (const test of cases) {
            try {
                const item = await open(test.file, test.content ?? 'initial\n');
                await append(item, '\nfirst\n');
                const first = item.document.getText();
                await append(item, '\nsecond\n');
                opened.push({ ...test, ...item, first, latest: item.document.getText() });
            } catch (error) {
                // Binary files that VS Code refuses to decode cannot reach the
                // extension. Distinguish this from an extension-level exclusion.
                if (test.binaryBytes && /binary|バイナリ/i.test(String(error))) {
                    await record(test.file, async () => ({ expected: false, persisted: false, outcome: 'VS Code rejected binary text document' }));
                } else { await record(test.file, async () => { throw error; }); }
            }
        }
        // A tracked sentinel proves the real debounce has written the batch.
        // Never call Save Persisted State or the internal persistence flush.
        const barrier = await open(`barriers/${results.length}.unknown`, 'barrier\n');
        await append(barrier, 'saved\n');
        await sleep(1300);
        await waitForContent(barrier.document, barrier.document.getText());
        for (const item of opened) {
            await record(item.file, async () => {
                const tree = await snapshot(item.document);
                assert.equal(!!tree, item.expected, item.file);
                if (tree) {
                    assert.equal(await contentAt(tree, tree.currentId), item.latest, 'Latest saved content differs');
                    const contents = await Promise.all(tree.nodes.map(node => contentAt(tree, node.id)));
                    assert.ok(contents.includes(item.first), 'Intermediate save missing');
                }
                return { expected: item.expected, persisted: !!tree, content: summarize(item.latest), nodes: tree?.nodes.length ?? 0 };
            });
        }
    }

    await record('default modes are auto without explicit extension/name lists', async () => {
        assert.equal(config().get('trackingMode'), 'auto');
        assert.equal(config().get('persistenceMode'), 'auto');
        for (const key of ['enabledExtensions', 'enabledFileNames']) {
            const inspected = config().inspect(key);
            assert.equal(inspected.globalValue, undefined);
            assert.equal(inspected.workspaceValue, undefined);
        }
        return { trackingMode: 'auto', persistenceMode: 'auto' };
    });

    await batch([
        ...['code.ts', 'notes.md', 'data.csv', 'output.log', 'app.custom-lang', 'SCRATCH', '.customrc', 'Dockerfile', '.gitignore']
            .map(file => ({ file: `defaults/${file}`, expected: true })),
        { file: 'contents/japanese.unknown', content: '日本語のダミーテキストです。\n設定と履歴を確認します。\n', expected: true },
        { file: 'contents/emoji.unknown', content: '😀🌳📝👨‍👩‍👧‍👦\n', expected: true },
        { file: 'contents/crlf.unknown', content: 'first\r\nsecond\r\n', expected: true },
        { file: 'contents/whitespace.unknown', content: '\t \n\r\n\f', expected: true },
        { file: 'contents/empty.unknown', content: '', expected: true },
        { file: 'contents/utf16.unknown', content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日本語 UTF-16\r\n', 'utf16le')]), expected: true },
        // Include an LF so Windows does not choose CRLF for the appended edits.
        { file: 'sizes/exact-limit.unknown', content: 'a'.repeat(1_000_000 - 16) + '\n', expected: true },
        { file: 'sizes/over-limit.unknown', content: 'a'.repeat(1_000_001), expected: false },
        { file: 'sizes/five-mib.unknown', content: 'a'.repeat(5 * 1024 * 1024), expected: false },
        ...['.env', '.env.local', '.env.example', 'private.key', 'certificate.pem', 'package-lock.json']
            .map(file => ({ file: `excluded/${file}`, content: 'DUMMY_VALUE=not-a-real-secret\n', expected: false })),
        ...['node_modules/pkg/index.custom', 'dist/bundle.custom', 'app.min.js', 'data.map']
            .map(file => ({ file, expected: false })),
        ...['image.png', 'document.pdf', 'archive.zip', 'database.sqlite']
            .map(file => ({ file: `binary/${file}`, content: 'Plain text with a known binary suffix\n', expected: false })),
        { file: 'binary/nul.unknown', content: Buffer.from('header\0payload\0'), expected: false, binaryBytes: true },
        { file: 'binary/controls.unknown', content: '\x01\x02\x03payload\n', expected: false, binaryBytes: true },
    ]);

    await record('untracked edits are resynchronized after crossing the size limit and shrinking', async () => {
        const item = await open('transitions/size.unknown', 'small\n');
        await append(item, 'saved\n');
        const tracked = item.document.getText();
        await waitForContent(item.document, tracked);
        await replace(item, 'b'.repeat(1_000_001));
        await sleep(1300);
        const ignored = await snapshot(item.document);
        assert.equal(await contentAt(ignored, ignored.currentId), tracked);
        await replace(item, 'resumed after an ignored large edit\n');
        await append(item, 'small delta\n');
        const tree = await waitForContent(item.document, item.document.getText());
        assert.equal(await contentAt(tree, tree.currentId), item.document.getText());
        return { oversizedSaveIgnored: true, resumedContentMatches: true };
    });

    await record('large-file override is document-local and ends when the file closes', async () => {
        const item = await open('overrides/large.unknown', 'a'.repeat(1_000_001));
        await vscode.commands.executeCommand('undotree.trackLargeFileForSession');
        await append(item, 'explicitly enabled\n');
        const saved = item.document.getText();
        await waitForContent(item.document, saved);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await sleep(100);
        assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
            tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === item.document.uri.toString())),
        'Override test tab must really close');
        const documentRetainedAfterTabClose = !item.document.isClosed;
        const reopened = await vscode.workspace.openTextDocument(item.document.uri);
        const editor = await vscode.window.showTextDocument(reopened);
        await append({ document: reopened, editor }, 'not tracked after reopen\n');
        await sleep(1300);
        const tree = await snapshot(reopened);
        assert.equal(await contentAt(tree, tree.currentId), saved);
        return { overrideSaved: true, reopenedOversizedSaveIgnored: true, documentRetainedAfterTabClose };
    });

    await record('periodic checkpoints also automatically persist unsaved text', async () => {
        await update('autosaveInterval', 1);
        try {
            const item = await open('periodic/unsaved.unknown', 'disk contents\n');
            await append(item, 'unsaved checkpoint\n', false);
            assert.equal(item.document.isDirty, true);
            const tree = await waitForContent(item.document, item.document.getText());
            assert.ok(tree.nodes.some(node => node.label === 'auto'));
            assert.equal(await fs.readFile(item.document.uri.fsPath, 'utf8'), 'disk contents\n');
            return { unsavedTextPersisted: true, diskFileUnchanged: true };
        } finally { await update('autosaveInterval', 0); }
    });

    // Keep the sentinel's .unknown suffix eligible in the explicit list.
    await update('enabledExtensions', ['.md', '.unknown']);
    await batch([
        { file: 'explicit/note.md', expected: true },
        { file: 'explicit/script.ts', expected: false },
        { file: 'explicit/data.csv', expected: false },
        { file: 'explicit/Dockerfile', expected: false },
        { file: 'explicit/Makefile', expected: false },
    ]);
    await update('enabledFileNames', ['Dockerfile']);
    await batch([
        { file: 'explicit-name/Dockerfile', expected: true },
        { file: 'explicit-name/Makefile', expected: false },
    ]);
    await update('enabledExtensions', undefined);
    await update('enabledFileNames', undefined);
    const defaultExclusions = config().get('excludePatterns');
    await update('excludePatterns', defaultExclusions.filter(pattern => pattern !== '.env' && pattern !== '.env.*'));
    await batch([
        ...['.env', '.env.local', '.env.example'].map(file => ({ file: `opt-in/${file}`, content: 'DUMMY_ONLY=example\n', expected: true })),
        { file: 'opt-in/private.key', expected: false },
    ]);
    await update('excludePatterns', undefined);
    const other = vscode.workspace.workspaceFolders[1].uri;
    await update('enabledExtensions', ['.py'], other);
    await update('enabledFileNames', [], other);
    await batch([
        { file: '../other-workspace/main.py', expected: true },
        { file: '../other-workspace/main.ts', expected: false },
        { file: '../other-workspace/Dockerfile', expected: false },
        { file: 'multi-root/unknown.custom', expected: true },
    ]);
    if (results.some(result => !result.passed)) { throw new Error('Automatic tracking integration checks failed; see results.json'); }
};
