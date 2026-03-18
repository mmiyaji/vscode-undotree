'use strict';

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UndoTreeProvider } from './undoTreeProvider';
import { UndoTreeManager } from './undoTreeManager';

// バーチャルドキュメント（差分表示用）
class UndoTreeDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private contents = new Map<number, string>();
    private counter = 0;

    prepare(content: string, ext: string): vscode.Uri {
        const id = this.counter++;
        this.contents.set(id, content);
        // 拡張子をURIに含めることでVS Codeが言語を正しく認識する
        return vscode.Uri.parse(`undotree:///node_${id}${ext}`);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const match = uri.path.match(/\/node_(\d+)/);
        const id = match ? parseInt(match[1]) : -1;
        return this.contents.get(id) ?? '';
    }
}

let manager: UndoTreeManager | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const PERSIST_DEBOUNCE_MS = 1000;

type PersistedManifest = {
    version: number;
    savedAt: number;
    nextId: number;
    paused: boolean;
    trees: Array<{ uri: string; file: string }>;
};

function makeTreeFileName(uri: string): string {
    return `${crypto.createHash('sha1').update(uri).digest('hex')}.json`;
}

async function persistStateToDisk(
    context: vscode.ExtensionContext,
    state: ReturnType<UndoTreeManager['exportState']>,
    paused: boolean
) {
    const rootDir = context.globalStorageUri.fsPath;
    const treesDir = path.join(rootDir, 'undo-trees');
    await fs.mkdir(treesDir, { recursive: true });

    const entries = Object.entries(state.trees);
    const manifest: PersistedManifest = {
        version: 1,
        savedAt: Date.now(),
        nextId: state.nextId,
        paused,
        trees: entries.map(([uri]) => ({
            uri,
            file: makeTreeFileName(uri),
        })),
    };

    await Promise.all(entries.map(async ([uri, tree]) => {
        const filePath = path.join(treesDir, makeTreeFileName(uri));
        await fs.writeFile(
            filePath,
            JSON.stringify({ uri, tree }, null, 2),
            'utf8'
        );
    }));

    const expectedFiles = new Set(manifest.trees.map((entry) => entry.file));
    expectedFiles.add('manifest.json');
    const existingFiles = await fs.readdir(treesDir, { withFileTypes: true });
    await Promise.all(existingFiles
        .filter((entry) => entry.isFile() && !expectedFiles.has(entry.name))
        .map((entry) => fs.unlink(path.join(treesDir, entry.name))));

    await fs.writeFile(
        path.join(treesDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
    );

    return {
        rootDir,
        treesDir,
        treeCount: entries.length,
    };
}

async function readPersistedManifest(
    context: vscode.ExtensionContext
): Promise<{
    nextId: number;
    paused: boolean;
    trees: Array<{ uri: string; file: string }>;
} | undefined> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    const manifestPath = path.join(treesDir, 'manifest.json');

    try {
        const manifestRaw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw) as Partial<PersistedManifest>;
        if (!Array.isArray(manifest.trees)) {
            return undefined;
        }

        return {
            nextId: typeof manifest.nextId === 'number' ? manifest.nextId : 1,
            paused: manifest.paused === true,
            trees: manifest.trees,
        };
    } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

async function loadPersistedTreeFromDisk(
    context: vscode.ExtensionContext,
    uri: vscode.Uri
): Promise<{
    nextId: number;
    tree: NonNullable<ReturnType<UndoTreeManager['exportState']>['trees'][string]>;
} | undefined> {
    const manifest = await readPersistedManifest(context);
    if (!manifest) {
        return undefined;
    }

    const entry = manifest.trees.find((treeEntry) => treeEntry.uri === uri.toString());
    if (!entry) {
        return undefined;
    }

    const treePath = path.join(context.globalStorageUri.fsPath, 'undo-trees', entry.file);
    try {
        const raw = await fs.readFile(treePath, 'utf8');
        const parsed = JSON.parse(raw) as {
            tree?: ReturnType<UndoTreeManager['exportState']>['trees'][string];
        };
        if (!parsed.tree) {
            return undefined;
        }

        return {
            nextId: manifest.nextId,
            tree: parsed.tree,
        };
    } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

async function ensureTreeLoaded(
    context: vscode.ExtensionContext,
    treeManager: UndoTreeManager,
    document: vscode.TextDocument
) {
    if (!treeManager.hasTree(document.uri)) {
        const persisted = await loadPersistedTreeFromDisk(context, document.uri);
        if (persisted) {
            treeManager.importTree(document.uri.toString(), persisted.tree, persisted.nextId);
            treeManager.reconcileCurrentNode(document.uri, document.getText());
            return;
        }
    }

    treeManager.syncDocumentState(document.uri, document.getText());
}

async function restoreTreeForDocument(
    context: vscode.ExtensionContext,
    treeManager: UndoTreeManager,
    document: vscode.TextDocument
): Promise<boolean> {
    const persisted = await loadPersistedTreeFromDisk(context, document.uri);
    if (!persisted) {
        return false;
    }

    treeManager.importTree(document.uri.toString(), persisted.tree, persisted.nextId);
    treeManager.reconcileCurrentNode(document.uri, document.getText());
    return true;
}

function getEnabledExtensions(): string[] {
    const value = vscode.workspace
        .getConfiguration('undotree')
        .get<string[]>('enabledExtensions');
    return Array.isArray(value) ? value : ['.txt', '.md'];
}

function getExcludePatterns(): string[] {
    const value = vscode.workspace
        .getConfiguration('undotree')
        .get<string[]>('excludePatterns');
    return Array.isArray(value) ? value : [];
}

function getPersistenceMode(): 'manual' | 'auto' {
    const value = vscode.workspace
        .getConfiguration('undotree')
        .get<string>('persistenceMode');
    return value === 'auto' ? 'auto' : 'manual';
}

function getAutosaveIntervalMs(): number {
    const seconds = vscode.workspace
        .getConfiguration('undotree')
        .get<number>('autosaveInterval');
    if (typeof seconds !== 'number') {
        return 30_000;
    }
    if (seconds === 0) {
        return 0; // 無効
    }
    return Math.max(5, seconds) * 1000;
}

function schedulePersistState(context: vscode.ExtensionContext) {
    if (!manager || getPersistenceMode() !== 'auto') {
        return;
    }

    if (persistTimer) {
        clearTimeout(persistTimer);
    }

    persistTimer = setTimeout(() => {
        void persistStateToDisk(context, manager!.exportState(), manager!.paused);
        persistTimer = undefined;
    }, PERSIST_DEBOUNCE_MS);
}

function matchesGlob(filename: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(filename);
}

function isExcluded(document: vscode.TextDocument): boolean {
    const basename = path.basename(document.fileName);
    return getExcludePatterns().some((p) => matchesGlob(basename, p));
}

function isTracked(document: vscode.TextDocument): boolean {
    if (isExcluded(document)) {
        return false;
    }
    const ext = path.extname(document.fileName).toLowerCase();
    return getEnabledExtensions().map((e) => e.toLowerCase()).includes(ext);
}

function updateStatusBar(editor: vscode.TextEditor | undefined) {
    if (!statusBarItem || !manager) {
        return;
    }
    if (!editor || editor.document.isUntitled) {
        statusBarItem.hide();
        return;
    }
    if (manager.paused) {
        statusBarItem.text = vscode.l10n.t('$(debug-pause) Undo Tree: PAUSED');
        statusBarItem.tooltip = vscode.l10n.t('Undo Tree is paused. Click to resume.');
        statusBarItem.command = 'undotree.togglePause';
        statusBarItem.show();
        return;
    }
    const ext = path.extname(editor.document.fileName).toLowerCase() || '(none)';
    const enabled = getEnabledExtensions();
    const excluded = isExcluded(editor.document);
    const tracked = !excluded && enabled.map(e => e.toLowerCase()).includes(ext);
    statusBarItem.text = tracked
        ? vscode.l10n.t('$(history) Undo Tree: ON')
        : vscode.l10n.t('$(circle-slash) Undo Tree: OFF');
    statusBarItem.tooltip = [
        tracked
            ? vscode.l10n.t('Tracking {0}. Click to disable.', ext)
            : vscode.l10n.t('Not tracking {0}. Click to enable.', ext),
        vscode.l10n.t('Enabled: {0}', enabled.join(', ') || '(none)'),
        excluded ? vscode.l10n.t('Excluded by pattern') : '',
    ].filter(Boolean).join('\n');
    statusBarItem.command = 'undotree.toggleTracking';
    statusBarItem.show();
}

export async function activate(context: vscode.ExtensionContext) {
    manager = new UndoTreeManager();
    const provider = new UndoTreeProvider(context, manager);
    const contentProvider = new UndoTreeDocumentContentProvider();
    const persistedManifest = await readPersistedManifest(context);

    manager.paused = persistedManifest?.paused === true;
    manager.setAutosaveInterval(getAutosaveIntervalMs());

    manager.onRefresh = () => {
        provider.refresh();
        schedulePersistState(context);
    };


    // 既に開いているエディタのツリーを実際のコンテンツで初期化
    if (vscode.window.activeTextEditor && isTracked(vscode.window.activeTextEditor.document)) {
        const ed = vscode.window.activeTextEditor;
        await ensureTreeLoaded(context, manager, ed.document);
    }

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    updateStatusBar(vscode.window.activeTextEditor);

    context.subscriptions.push(
        new vscode.Disposable(() => {
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = undefined;
            }
        }),

        statusBarItem,

        vscode.workspace.registerTextDocumentContentProvider('undotree', contentProvider),

        vscode.window.registerWebviewViewProvider('undotree.treeView', provider),

        vscode.commands.registerCommand('undotree.show', () => {
            vscode.commands.executeCommand('undotree.treeView.focus');
        }),

        vscode.commands.registerCommand('undotree.undo', () => {
            manager?.undo();
        }),

        vscode.commands.registerCommand('undotree.redo', () => {
            manager?.redo();
        }),

        vscode.commands.registerCommand('undotree.savePersistedState', async () => {
            if (!manager) {
                return;
            }
            const state = manager.exportState();
            const result = await persistStateToDisk(context, state, manager.paused);
            vscode.window.showInformationMessage(
                vscode.l10n.t('Undo Tree: saved {0} tree(s) to {1}', result.treeCount, result.treesDir)
            );
        }),

        vscode.commands.registerCommand('undotree.restorePersistedState', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !manager) {
                return;
            }
            if (!isTracked(editor.document)) {
                vscode.window.showWarningMessage(vscode.l10n.t('Undo Tree: current file is not tracked.'));
                return;
            }

            const restored = await restoreTreeForDocument(context, manager, editor.document);
            if (!restored) {
                vscode.window.showInformationMessage(vscode.l10n.t('Undo Tree: no persisted state found for the current file.'));
                return;
            }

            provider.refresh();
            vscode.window.showInformationMessage(vscode.l10n.t('Undo Tree: restored persisted state for the current file.'));
        }),

        vscode.commands.registerCommand('undotree.showMenu', async () => {
            const editor = vscode.window.activeTextEditor;
            const isCurrentTracked = !!editor && isTracked(editor.document);
            const items: Array<{
                label: string;
                description?: string;
                command?: string;
            }> = [
                {
                    label: vscode.l10n.t('$(gear) Open Settings'),
                    description: vscode.l10n.t('Open Undo Tree extension settings'),
                    command: 'workbench.action.openSettings',
                },
                {
                    label: vscode.l10n.t('$(save) Save Persisted State'),
                    description: vscode.l10n.t('Write tracked histories to extension storage'),
                    command: 'undotree.savePersistedState',
                },
                {
                    label: getPersistenceMode() === 'auto'
                        ? vscode.l10n.t('$(sync-ignored) Auto Persist: On')
                        : vscode.l10n.t('$(sync) Auto Persist: Off'),
                    description: vscode.l10n.t('Open settings to change persistent save mode'),
                    command: 'workbench.action.openSettings',
                },
                {
                    label: vscode.l10n.t('$(history) Restore Persisted State'),
                    description: vscode.l10n.t('Reload saved history for the current file'),
                    command: isCurrentTracked ? 'undotree.restorePersistedState' : undefined,
                },
                {
                    label: vscode.l10n.t('$(archive) Compact History'),
                    description: vscode.l10n.t('Remove compressible intermediate nodes'),
                    command: isCurrentTracked ? 'undotree.compact' : undefined,
                },
                {
                    label: manager?.paused
                        ? vscode.l10n.t('$(debug-start) Resume Tracking')
                        : vscode.l10n.t('$(debug-pause) Pause Tracking'),
                    description: vscode.l10n.t('Temporarily disable or resume history capture'),
                    command: 'undotree.togglePause',
                },
                {
                    label: vscode.l10n.t('$(symbol-file) Toggle Tracking for This Extension'),
                    description: vscode.l10n.t('Enable or disable tracking for the current file extension'),
                    command: editor ? 'undotree.toggleTracking' : undefined,
                },
            ];

            const picked = await vscode.window.showQuickPick(
                items.filter((item) => item.command),
                {
                    title: vscode.l10n.t('Undo Tree'),
                    placeHolder: vscode.l10n.t('Choose an action'),
                }
            );
            if (!picked?.command) {
                return;
            }

            if (picked.command === 'workbench.action.openSettings') {
                await vscode.commands.executeCommand(picked.command, 'undotree');
                return;
            }

            await vscode.commands.executeCommand(picked.command);
        }),

        vscode.commands.registerCommand('undotree.toggleTracking', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isUntitled) {
                return;
            }
            const ext = path.extname(editor.document.fileName).toLowerCase();
            if (!ext) {
                vscode.window.showWarningMessage(vscode.l10n.t('Cannot determine file extension.'));
                return;
            }
            const config = vscode.workspace.getConfiguration('undotree');
            const current = config.get<string[]>('enabledExtensions', ['.txt', '.md']);
            const idx = current.map((e) => e.toLowerCase()).indexOf(ext);
            let updated: string[];
            if (idx === -1) {
                updated = [...current, ext];
                vscode.window.showInformationMessage(vscode.l10n.t('Undo Tree: enabled for {0}', ext));
            } else {
                updated = current.filter((_, i) => i !== idx);
                vscode.window.showInformationMessage(vscode.l10n.t('Undo Tree: disabled for {0}', ext));
            }
            await config.update('enabledExtensions', updated, vscode.ConfigurationTarget.Global);
            updateStatusBar(editor);
        }),

        vscode.commands.registerCommand('undotree.diffWithNode', async (targetNodeId: number) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !manager) {
                return;
            }
            const tree = manager.getTree(editor.document.uri);
            const ext = path.extname(editor.document.fileName) || '.txt';

            const targetContent = manager.reconstructContent(tree, targetNodeId);
            const currentContent = editor.document.getText();

            const targetNode = tree.nodes.get(targetNodeId);
            const currentNode = tree.nodes.get(tree.currentId);
            const targetLabel = targetNode ? `node${targetNodeId} (${targetNode.label})` : `node${targetNodeId}`;
            const currentLabel = currentNode ? `current (${currentNode.label})` : 'current';

            const targetUri = contentProvider.prepare(targetContent, ext);
            const currentUri = contentProvider.prepare(currentContent, ext);

            await vscode.commands.executeCommand(
                'vscode.diff',
                targetUri,
                currentUri,
                vscode.l10n.t('Undo Tree: {0} \u2194 {1}', targetLabel, currentLabel)
            );
        }),

        vscode.commands.registerCommand('undotree.compact', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !manager) {
                return;
            }
            const tree = manager.getTree(editor.document.uri);
            const removed = manager.compact(tree);
            provider.refresh();
            vscode.window.showInformationMessage(vscode.l10n.t('Undo Tree: compacted {0} node(s)', removed));
        }),

        vscode.commands.registerCommand('undotree.togglePause', () => {
            if (!manager) {
                return;
            }
            manager.paused = !manager.paused;
            provider.refresh();
            schedulePersistState(context);
            updateStatusBar(vscode.window.activeTextEditor);
            vscode.window.showInformationMessage(
                manager.paused ? vscode.l10n.t('Undo Tree: paused') : vscode.l10n.t('Undo Tree: resumed')
            );
        }),

        vscode.workspace.onDidChangeTextDocument((e) => {
            if (isTracked(e.document)) {
                manager?.onDidChangeTextDocument(e);
            }
        }),

        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (isTracked(doc)) {
                manager?.onDidSaveTextDocument(doc);
            }
        }),

        vscode.workspace.onDidCloseTextDocument((doc) => {
            manager?.onDidCloseTextDocument(doc);
        }),

        vscode.workspace.onDidOpenTextDocument((doc) => {
            void (async () => {
                if (isTracked(doc) && manager) {
                    await ensureTreeLoaded(context, manager, doc);
                }
            })();
        }),

        vscode.window.onDidChangeActiveTextEditor((e) => {
            void (async () => {
                if (e && isTracked(e.document) && manager) {
                    await ensureTreeLoaded(context, manager, e.document);
                }
            })();
            manager?.onDidChangeActiveEditor(e);
            provider.refresh();
            updateStatusBar(e);
        }),

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration('undotree.enabledExtensions') ||
                e.affectsConfiguration('undotree.excludePatterns') ||
                e.affectsConfiguration('undotree.persistenceMode') ||
                e.affectsConfiguration('undotree.autosaveInterval') ||
                e.affectsConfiguration('undotree.timeFormat') ||
                e.affectsConfiguration('undotree.timeFormatCustom') ||
                e.affectsConfiguration('undotree.nodeMarkerStyle')
            ) {
                if (e.affectsConfiguration('undotree.persistenceMode')) {
                    schedulePersistState(context);
                }
                if (e.affectsConfiguration('undotree.autosaveInterval')) {
                    manager?.setAutosaveInterval(getAutosaveIntervalMs());
                }
                updateStatusBar(vscode.window.activeTextEditor);
                provider.refresh();
            }
        })
    );
}

export function deactivate() {
    manager?.dispose();
}
