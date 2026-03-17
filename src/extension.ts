'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
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
        statusBarItem.text = `$(debug-pause) Undo Tree: PAUSED`;
        statusBarItem.tooltip = 'Undo Tree is paused. Click to resume.';
        statusBarItem.command = 'undotree.toggleTracking';
        statusBarItem.show();
        return;
    }
    const ext = path.extname(editor.document.fileName).toLowerCase() || '(none)';
    const enabled = getEnabledExtensions();
    const excluded = isExcluded(editor.document);
    const tracked = !excluded && enabled.map(e => e.toLowerCase()).includes(ext);
    statusBarItem.text = tracked ? `$(history) Undo Tree: ON` : `$(circle-slash) Undo Tree: OFF`;
    statusBarItem.tooltip = [
        tracked ? `Tracking ${ext}. Click to disable.` : `Not tracking ${ext}. Click to enable.`,
        `Enabled: ${enabled.join(', ') || '(none)'}`,
        excluded ? `Excluded by pattern` : '',
    ].filter(Boolean).join('\n');
    statusBarItem.command = 'undotree.toggleTracking';
    statusBarItem.show();
}

export function activate(context: vscode.ExtensionContext) {
    manager = new UndoTreeManager();
    const provider = new UndoTreeProvider(context, manager);
    const contentProvider = new UndoTreeDocumentContentProvider();

    manager.onRefresh = () => provider.refresh();

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    updateStatusBar(vscode.window.activeTextEditor);

    context.subscriptions.push(
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

        vscode.commands.registerCommand('undotree.toggleTracking', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isUntitled) {
                return;
            }
            const ext = path.extname(editor.document.fileName).toLowerCase();
            if (!ext) {
                vscode.window.showWarningMessage('Cannot determine file extension.');
                return;
            }
            const config = vscode.workspace.getConfiguration('undotree');
            const current = config.get<string[]>('enabledExtensions', ['.txt', '.md']);
            const idx = current.map((e) => e.toLowerCase()).indexOf(ext);
            let updated: string[];
            if (idx === -1) {
                updated = [...current, ext];
                vscode.window.showInformationMessage(`Undo Tree: enabled for ${ext}`);
            } else {
                updated = current.filter((_, i) => i !== idx);
                vscode.window.showInformationMessage(`Undo Tree: disabled for ${ext}`);
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
            const currentContent = manager.reconstructContent(tree, tree.currentId);

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
                `Undo Tree: ${targetLabel} ↔ ${currentLabel}`
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
            vscode.window.showInformationMessage(`Undo Tree: compacted ${removed} node(s)`);
        }),

        vscode.commands.registerCommand('undotree.togglePause', () => {
            if (!manager) {
                return;
            }
            manager.paused = !manager.paused;
            provider.refresh();
            updateStatusBar(vscode.window.activeTextEditor);
            vscode.window.showInformationMessage(
                manager.paused ? 'Undo Tree: paused' : 'Undo Tree: resumed'
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

        vscode.window.onDidChangeActiveTextEditor((e) => {
            manager?.onDidChangeActiveEditor(e);
            provider.refresh();
            updateStatusBar(e);
        }),

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration('undotree.enabledExtensions') ||
                e.affectsConfiguration('undotree.excludePatterns')
            ) {
                updateStatusBar(vscode.window.activeTextEditor);
                provider.refresh();
            }
        })
    );
}

export function deactivate() {
    manager?.dispose();
}
