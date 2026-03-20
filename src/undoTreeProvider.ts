'use strict';

import * as vscode from 'vscode';
import { format as formatDate } from 'date-fns';
import { UndoTreeManager } from './undoTreeManager';

type DisplayNode = ReturnType<UndoTreeManager['getTree']>['nodes'] extends Map<number, infer T>
    ? T & { formattedTime: string; isEmpty: boolean }
    : never;

function getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return nonce;
}

export class UndoTreeProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private mode: 'navigate' | 'diff' = 'navigate';
    private lastEditor?: vscode.TextEditor;
    private lastEditorUri?: string;
    private loadingRequest?: { uri: string; token: number };
    private loadingToken = 0;
    private webviewInitialized = false;

    setActiveEditor(editor: vscode.TextEditor | undefined) {
        const nextUri = editor?.document.uri.toString();
        if (this.mode === 'diff' && this.lastEditorUri && nextUri !== this.lastEditorUri) {
            this.mode = 'navigate';
        }
        if (editor) {
            this.lastEditor = editor;
        }
        this.lastEditorUri = nextUri;
    }

    showCheckpointLoading() {
        this.view?.webview.postMessage({ command: 'showJumpLoading' });
    }

    beginLoading(uri: vscode.Uri): number {
        const token = ++this.loadingToken;
        this.loadingRequest = { uri: uri.toString(), token };
        return token;
    }

    endLoading(uri: vscode.Uri, token: number): boolean {
        if (
            this.loadingRequest &&
            this.loadingRequest.uri === uri.toString() &&
            this.loadingRequest.token === token
        ) {
            this.loadingRequest = undefined;
            return true;
        }
        return false;
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly manager: UndoTreeManager
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        this.webviewInitialized = false;
        webviewView.webview.options = { enableScripts: true };
        this.render();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                const editor = vscode.window.activeTextEditor;
                switch (message.command) {
                    case 'undo':
                        await this.manager.undo();
                        break;
                    case 'redo':
                        await this.manager.redo();
                        break;
                    case 'jumpToNode':
                        if (editor && typeof message.nodeId === 'number') {
                            await this.manager.jumpToNode(message.nodeId, editor);
                            if (message.focusEditor) {
                                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                            }
                        }
                        break;
                    case 'togglePause':
                        await vscode.commands.executeCommand('undotree.togglePause');
                        break;
                    case 'showMenu':
                        await vscode.commands.executeCommand('undotree.showMenu');
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mmiyaji.vscode-undotree');
                        break;
                    case 'toggleTracking':
                        await vscode.commands.executeCommand('undotree.toggleTracking');
                        break;
                    case 'toggleMode':
                        this.mode = this.mode === 'navigate' ? 'diff' : 'navigate';
                        this.render();
                        break;
                    case 'diffWithNode':
                        if (typeof message.nodeId === 'number') {
                            await vscode.commands.executeCommand('undotree.diffWithNode', message.nodeId, message.sourceUri);
                        }
                        break;
                    case 'diffBetweenNodes':
                        if (
                            typeof message.leftNodeId === 'number' &&
                            typeof message.rightNodeId === 'number'
                        ) {
                            await vscode.commands.executeCommand(
                                'undotree.diffBetweenNodes',
                                message.leftNodeId,
                                message.rightNodeId,
                                message.sourceUri
                            );
                        }
                        break;
                    case 'editNote': {
                        const contextEditor = this.getContextEditor();
                        if (typeof message.nodeId !== 'number' || !contextEditor) {
                            break;
                        }
                        const tree = this.manager.getTree(contextEditor.document.uri);
                        const node = tree.nodes.get(message.nodeId);
                        const input = await vscode.window.showInputBox({
                            prompt: 'Node note (empty to clear)',
                            value: node?.note ?? '',
                            placeHolder: 'e.g. build passed',
                        });
                        if (input === undefined) {
                            break;
                        }
                        this.manager.setNote(contextEditor.document.uri, message.nodeId, input);
                        break;
                    }
                    case 'togglePin': {
                        const contextEditor = this.getContextEditor();
                        if (typeof message.nodeId !== 'number' || !contextEditor) {
                            break;
                        }
                        this.manager.togglePinned(contextEditor.document.uri, message.nodeId);
                        break;
                    }
                }
            } catch (error) {
                this.manager.debugLog?.(`[provider] webview message failed: ${String(error)}`);
                void vscode.window.showErrorMessage(vscode.l10n.t('Undo Tree: an action failed. See Output for details.'));
            }
        });
    }

    refresh() {
        if (this.view) {
            this.render();
        }
    }

    private render() {
        if (!this.view) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        const isLoadingCurrentEditor = !!editor &&
            this.loadingRequest?.uri === editor.document.uri.toString();
        const timeFormat = this.getTimeFormat();
        const timeFormatCustom = this.getTimeFormatCustom();
        const nodeSizeMetric = this.getNodeSizeMetric();
        const nodeSizeMetricBase = this.getNodeSizeMetricBase();
        const showStorageKind = this.getShowStorageKind();
        const state = this.getRenderState(
            editor,
            isLoadingCurrentEditor,
            timeFormat,
            timeFormatCustom,
            nodeSizeMetric,
            nodeSizeMetricBase,
            showStorageKind
        );

        if (!this.webviewInitialized) {
            this.view.webview.html = this.buildHtml(
                state.nodes,
                state.currentId,
                state.paused,
                state.mode,
                state.timeFormat,
                state.timeFormatCustom,
                state.nodeSizeMetric,
                state.nodeSizeMetricBase,
                state.showStorageKind,
                state.view,
                state.notTrackedExt,
                state.sourceUri
            );
            this.webviewInitialized = true;
            return;
        }

        void this.view.webview.postMessage({
            command: 'renderState',
            state,
        });
    }

    private getRenderState(
        editor: vscode.TextEditor | undefined,
        isLoadingCurrentEditor: boolean,
        timeFormat: 'none' | 'time' | 'dateTime' | 'relative' | 'custom',
        timeFormatCustom: string,
        nodeSizeMetric: 'none' | 'lines' | 'bytes',
        nodeSizeMetricBase: 'current' | 'initial',
        showStorageKind: boolean
    ) {
        if (isLoadingCurrentEditor) {
            return {
                view: 'loading' as const,
                nodes: null,
                currentId: -1,
                paused: this.manager.paused,
                mode: this.mode,
                timeFormat,
                timeFormatCustom,
                nodeSizeMetric,
                nodeSizeMetricBase,
                showStorageKind,
                notTrackedExt: '',
                sourceUri: '',
            };
        }
        if (!editor) {
            return {
                view: 'empty' as const,
                nodes: null,
                currentId: -1,
                paused: this.manager.paused,
                mode: this.mode,
                timeFormat,
                timeFormatCustom,
                nodeSizeMetric,
                nodeSizeMetricBase,
                showStorageKind,
                notTrackedExt: '',
                sourceUri: '',
            };
        }
        if (!this.isTrackedDocument(editor.document)) {
            const fileName = editor.document.isUntitled ? '' : editor.document.fileName.replace(/.*[\\/]/, '');
            const ext = fileName.match(/\.[^.]+$/)?.[0] ?? '';
            return {
                view: 'notTracked' as const,
                nodes: null,
                currentId: -1,
                paused: this.manager.paused,
                mode: this.mode,
                timeFormat,
                timeFormatCustom,
                nodeSizeMetric,
                nodeSizeMetricBase,
                showStorageKind,
                notTrackedExt: ext,
                sourceUri: editor.document.uri.toString(),
            };
        }
        const tree = this.manager.getTree(editor.document.uri, editor.document.getText());
        const displayNodes = Array.from(tree.nodes.values()).map((node) => ({
            ...node,
            formattedTime: this.formatTimestamp(node.timestamp, timeFormat, timeFormatCustom),
            isEmpty: this.manager.isNodeEmpty(tree, node.id),
        }));
        return {
            view: 'tree' as const,
            nodes: displayNodes,
            currentId: tree.currentId,
            paused: this.manager.paused,
            mode: this.mode,
            timeFormat,
            timeFormatCustom,
            nodeSizeMetric,
            nodeSizeMetricBase,
            showStorageKind,
            notTrackedExt: '',
            sourceUri: editor.document.uri.toString(),
        };
    }

    private getContextEditor(): vscode.TextEditor | undefined {
        const active = vscode.window.activeTextEditor;
        if (active && this.isTrackedDocument(active.document)) {
            return active;
        }
        if (this.lastEditor && this.isTrackedDocument(this.lastEditor.document)) {
            return this.lastEditor;
        }
        return active;
    }

    private getTimeFormat(): 'none' | 'time' | 'dateTime' | 'relative' | 'custom' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('timeFormat');
        if (value === 'none' || value === 'dateTime' || value === 'relative' || value === 'custom') {
            return value;
        }
        return 'time';
    }

    private getTimeFormatCustom(): string {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('timeFormatCustom');
        return value && value.trim() ? value : 'yyyy-MM-dd HH:mm:ss';
    }

    private getNodeSizeMetric(): 'none' | 'lines' | 'bytes' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('nodeSizeMetric');
        if (value === 'none' || value === 'lines' || value === 'bytes') {
            return value;
        }
        return 'lines';
    }

    private getShowStorageKind(): boolean {
        return vscode.workspace.getConfiguration('undotree').get<boolean>('showStorageKind') === true;
    }

    private getNodeSizeMetricBase(): 'current' | 'initial' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('nodeSizeMetricBase');
        return value === 'initial' ? 'initial' : 'current';
    }

    private getEnabledExtensions(): string[] {
        const value = vscode.workspace.getConfiguration('undotree').get<string[]>('enabledExtensions');
        return Array.isArray(value) ? value : ['.txt', '.md'];
    }

    private getExcludePatterns(): string[] {
        const value = vscode.workspace.getConfiguration('undotree').get<string[]>('excludePatterns');
        return Array.isArray(value) ? value : [];
    }

    private matchesGlob(filename: string, pattern: string): boolean {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`, 'i').test(filename);
    }

    private isTrackedDocument(document: vscode.TextDocument): boolean {
        const fileName = document.fileName.replace(/.*[\\/]/, '');
        if (this.getExcludePatterns().some((pattern) => this.matchesGlob(fileName, pattern))) {
            return false;
        }
        const ext = fileName.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
        return this.getEnabledExtensions().map((value) => value.toLowerCase()).includes(ext);
    }

    private formatTimestamp(
        timestamp: number,
        timeFormat: 'none' | 'time' | 'dateTime' | 'relative' | 'custom',
        timeFormatCustom: string
    ): string {
        if (timeFormat === 'none') { return ''; }
        if (timeFormat === 'relative') {
            return this.formatRelativeTimestamp(timestamp);
        }
        const pattern = timeFormat === 'time'
            ? 'HH:mm:ss'
            : timeFormat === 'dateTime'
                ? 'yyyy-MM-dd HH:mm:ss'
                : timeFormatCustom;

        try {
            return formatDate(new Date(timestamp), pattern);
        } catch {
            return formatDate(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss');
        }
    }

    private formatRelativeTimestamp(timestamp: number): string {
        const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        if (deltaSeconds < 5) {
            return vscode.l10n.t('just now');
        }
        if (deltaSeconds < 60) {
            return vscode.l10n.t('{0}s ago', deltaSeconds);
        }
        const deltaMinutes = Math.floor(deltaSeconds / 60);
        if (deltaMinutes < 60) {
            return vscode.l10n.t('{0}m ago', deltaMinutes);
        }
        const deltaHours = Math.floor(deltaMinutes / 60);
        if (deltaHours < 24) {
            return vscode.l10n.t('{0}h ago', deltaHours);
        }
        const deltaDays = Math.floor(deltaHours / 24);
        return vscode.l10n.t('{0}d ago', deltaDays);
    }

    private buildNotTrackedHtml(ext: string, _fileName: string): string {
        const nonce = getNonce();
        const label = ext
            ? vscode.l10n.t('Undo Tree: {0} is not tracked', ext)
            : vscode.l10n.t('Undo Tree: this file is not tracked');
        const hint = ext
            ? vscode.l10n.t('To enable tracking for {0} files, click the status bar item or open Settings.', ext)
            : vscode.l10n.t('To enable tracking for this file, click the status bar item or open Settings.');
        const enableLabel = ext
            ? vscode.l10n.t('Enable tracking for {0}', ext)
            : vscode.l10n.t('Enable tracking for this file');
        const settingsLabel = vscode.l10n.t('Open Settings');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view?.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);font-size:12px;padding:16px;color:var(--vscode-foreground);}
.msg{opacity:0.7;margin-bottom:8px;}
.hint{opacity:0.45;font-size:11px;margin-bottom:12px;}
.btn{display:block;margin-bottom:6px;background:none;border:none;padding:0;color:var(--vscode-textLink-foreground);font-size:12px;cursor:pointer;text-decoration:underline;text-align:left;}
.btn:hover{color:var(--vscode-textLink-activeForeground);}
</style>
</head><body>
<div class="msg">${label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</div>
<div class="hint">${hint.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</div>
<button class="btn" id="legacy-enable-tracking">${enableLabel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</button>
<button class="btn" id="legacy-open-settings">${settingsLabel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</button>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('legacy-enable-tracking')?.addEventListener('click', () => vscode.postMessage({command:'toggleTracking'}));
document.getElementById('legacy-open-settings')?.addEventListener('click', () => vscode.postMessage({command:'openSettings'}));
</script>
</body></html>`;
    }

    private buildHtml(
        nodes: DisplayNode[] | null,
        currentId: number,
        paused: boolean,
        mode: 'navigate' | 'diff',
        timeFormat: 'none' | 'time' | 'dateTime' | 'relative' | 'custom',
        timeFormatCustom: string,
        nodeSizeMetric: 'none' | 'lines' | 'bytes',
        nodeSizeMetricBase: 'current' | 'initial',
        showStorageKind: boolean,
        initialView: 'loading' | 'empty' | 'notTracked' | 'tree' = nodes ? 'tree' : 'empty',
        initialNotTrackedExt = '',
        initialSourceUri = ''
    ): string {
        const nonce = getNonce();
        const nodesJson = nodes ? JSON.stringify(nodes) : 'null';
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view?.webview.cspSource} data:; style-src ${this.view?.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; padding-top: 0; overflow-x: auto; }
  #tree { min-width: max-content; }
  .node { display: flex; align-items: center; gap: 4px; padding: 2px 4px; cursor: pointer; border-radius: 3px; user-select: none; white-space: nowrap; }
  .node:hover { background: var(--vscode-list-hoverBackground); }
  .node.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .node.focused { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .node.diff-target { background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent); color: var(--vscode-foreground); }
  .node.diff-target .right-area { background: color-mix(in srgb, var(--vscode-focusBorder) 16%, var(--vscode-sideBar-background)); }
  .node.current.diff-target { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  .diff-target-badge { font-size: 9px; color: var(--vscode-focusBorder); border: 1px solid currentColor; border-radius: 999px; padding: 0 4px; flex-shrink: 0; }
  .diff-base { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-editorInfo-foreground, var(--vscode-focusBorder)) 70%, transparent); }
  .diff-base-badge { font-size: 9px; color: var(--vscode-editorInfo-foreground, var(--vscode-focusBorder)); border: 1px solid currentColor; border-radius: 999px; padding: 0 4px; flex-shrink: 0; }
  .graph { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--vscode-editorLineNumber-foreground); }
  .graph svg { width: 12px; height: 14px; display: block; overflow: visible; }
  .storage { font-size: 9px; opacity: 0.5; border: 1px solid currentColor; border-radius: 2px; padding: 0 2px; flex-shrink: 0; }
  .label { opacity: 0.8; }
  .right-area { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; padding-left: 6px; position: sticky; right: 4px; background: var(--vscode-sideBar-background); }
  .node.current .right-area { background: var(--vscode-list-activeSelectionBackground); }
  .time { opacity: 0.5; font-size: 10px; flex-shrink: 0; }
  .time.latest { opacity: 0.9; color: var(--vscode-charts-green, #89d185); }
  .empty { opacity: 0.5; padding: 8px; }
  .actions { display: flex; gap: 4px; margin-bottom: 8px; align-items: center; position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; padding: 8px 0 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 8px; cursor: pointer; border-radius: 2px; font-size: 11px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.4; cursor: default; }
  .btn-pause { margin-left: auto; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-pause:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-mode { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-mode:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-mode.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-settings { background: transparent; color: var(--vscode-foreground); opacity: 0.6; padding: 3px 5px; }
  .btn-settings:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .paused-badge { font-size: 10px; opacity: 0.6; margin-left: 2px; }
  .diff-badge { font-size: 10px; color: var(--vscode-focusBorder); margin-left: 2px; }
  .diff-tools { display: none; align-items: center; gap: 4px; margin: 0 0 8px; position: sticky; top: 37px; z-index: 1; background: var(--vscode-sideBar-background); padding: 0 0 6px; }
  .diff-tools.visible { display: flex; flex-wrap: wrap; }
  .btn-compare { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-compare:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-compare.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .diff-base-label { font-size: 10px; opacity: 0.7; margin-left: 4px; }
  .empty-badge { font-size: 9px; opacity: 0.45; font-style: italic; flex-shrink: 0; }
  .size-diff { font-size: 9px; flex-shrink: 0; opacity: 0.7; }
  .size-diff.plus { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .size-diff.minus { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .note { font-style: italic; opacity: 0.55; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex-shrink: 1; }
  .note-edit { opacity: 0; font-size: 10px; cursor: pointer; flex-shrink: 0; padding: 0 2px; }
  .node:hover .note-edit { opacity: 0.45; }
  .node:hover .note-edit:hover { opacity: 1; }
  .pin-btn { opacity: 0; font-size: 10px; cursor: pointer; flex-shrink: 0; padding: 0 2px; margin-left: 6px; }
  .node:hover .pin-btn, .pin-btn.active { opacity: 0.85; }
  .pin-btn:hover { opacity: 1; }
  .pinned-wrap { margin-bottom: 8px; }
  .pinned-title { font-size: 10px; opacity: 0.55; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .pinned-link { display:flex; align-items:center; gap:4px; padding:2px 4px; cursor:pointer; border-radius:3px; white-space:nowrap; }
  .pinned-link:hover { background: var(--vscode-list-hoverBackground); }
  .pinned-link .pin-mark { opacity: 0.85; }
  .pinned-link .pinned-label { opacity: 0.8; }
  .msg { opacity: 0.7; margin-bottom: 8px; }
  .hint { opacity: 0.45; font-size: 11px; margin-bottom: 12px; }
  .btn { display: block; margin-bottom: 6px; background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); font-size: 12px; cursor: pointer; text-decoration: underline; text-align: left; }
  .btn:hover { color: var(--vscode-textLink-activeForeground); background: none; }
  .help-overlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 10; }
  .help-overlay.visible { display: flex; }
  .help-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.35); }
  .help-card { position: relative; width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border-radius: 6px; padding: 12px; box-shadow: 0 8px 28px rgba(0,0,0,0.28); }
  .help-close { position: absolute; top: 8px; right: 8px; background: transparent; color: var(--vscode-foreground); opacity: 0.7; padding: 2px 6px; }
  .help-close:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .help-title { font-size: 12px; font-weight: 600; margin-bottom: 10px; }
  .help-section { margin-top: 10px; }
  .help-section-title { font-size: 10px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .shortcut-row { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
  .shortcut-key { min-width: 88px; font-family: var(--vscode-editor-font-family, var(--vscode-font-family)); color: var(--vscode-textPreformat-foreground, var(--vscode-foreground)); }
  .shortcut-desc { opacity: 0.82; }
</style>
</head>
<body>
<div class="actions">
  <button id="btn-undo">${vscode.l10n.t('Undo')}</button>
  <button id="btn-redo">${vscode.l10n.t('Redo')}</button>
  <button class="btn-pause" id="btn-pause" title="${paused ? vscode.l10n.t('Resume tracking') : vscode.l10n.t('Pause tracking')}">${paused ? vscode.l10n.t('Resume') : vscode.l10n.t('Pause')}</button>
  <button class="btn-mode${mode === 'diff' ? ' active' : ''}" id="btn-mode" title="${mode === 'navigate' ? vscode.l10n.t('Switch to Diff mode') : vscode.l10n.t('Switch to Navigate mode')}">${mode === 'navigate' ? vscode.l10n.t('Diff') : vscode.l10n.t('Nav')}</button>
  <button class="btn-settings" id="btn-settings" title="${vscode.l10n.t('Open Undo Tree menu')}">&#9881;</button>
</div>
${paused ? `<div class="paused-badge">${vscode.l10n.t('Tracking paused - history is frozen')}</div>` : ''}
<div id="diff-tools" class="diff-tools${mode === 'diff' ? ' visible' : ''}">
  <button class="btn-compare active" id="btn-diff-current">${vscode.l10n.t('vs Current')}</button>
  <button class="btn-compare" id="btn-diff-pair">${vscode.l10n.t('Pair Diff')}</button>
  <span class="diff-base-label" id="diff-base-label"></span>
</div>
${mode === 'diff' ? `<div class="diff-badge">${vscode.l10n.t('Diff mode - select a node to compare, then use ↑/↓ to keep reviewing')}</div>` : ''}
<div id="pinned"></div>
<div id="tree"></div>
<div id="help-overlay" class="help-overlay" aria-hidden="true">
  <div class="help-backdrop" id="help-backdrop"></div>
  <div class="help-card" role="dialog" aria-modal="true" aria-label="${vscode.l10n.t('Undo Tree shortcuts')}">
    <button class="help-close" id="help-close" title="${vscode.l10n.t('Close help')}">×</button>
    <div class="help-title">${vscode.l10n.t('Undo Tree shortcuts')}</div>
    <div class="help-section">
      <div class="help-section-title">${vscode.l10n.t('Navigation')}</div>
      <div class="shortcut-row"><span class="shortcut-key">↑ / ↓, j / k</span><span class="shortcut-desc">${vscode.l10n.t('Move focus')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">Enter / Space</span><span class="shortcut-desc">${vscode.l10n.t('Jump or preview diff')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">← / →</span><span class="shortcut-desc">${vscode.l10n.t('Move to parent or child')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">Tab / Shift+Tab</span><span class="shortcut-desc">${vscode.l10n.t('Move across siblings')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">n / N</span><span class="shortcut-desc">${vscode.l10n.t('Jump to next or previous noted node')}</span></div>
    </div>
    <div class="help-section">
      <div class="help-section-title">${vscode.l10n.t('Actions')}</div>
      <div class="shortcut-row"><span class="shortcut-key">u / r</span><span class="shortcut-desc">${vscode.l10n.t('Undo / Redo')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">d</span><span class="shortcut-desc">${vscode.l10n.t('Toggle Diff mode')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">p</span><span class="shortcut-desc">${vscode.l10n.t('Pause or resume tracking')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">b</span><span class="shortcut-desc">${vscode.l10n.t('Set the focused node as the Pair Diff base')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">c</span><span class="shortcut-desc">${vscode.l10n.t('Switch Pair Diff back to current comparison')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">?</span><span class="shortcut-desc">${vscode.l10n.t('Toggle this help')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">Esc</span><span class="shortcut-desc">${vscode.l10n.t('Close help or exit Diff mode')}</span></div>
    </div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let nodes = ${nodesJson};
  let currentId = ${currentId};
  let mode = ${JSON.stringify(mode)};
  let timeFormat = ${JSON.stringify(timeFormat)};
  let timeFormatCustom = ${JSON.stringify(timeFormatCustom)};
  let nodeSizeMetric = ${JSON.stringify(nodeSizeMetric)};
  let nodeSizeMetricBase = ${JSON.stringify(nodeSizeMetricBase)};
  let showStorageKind = ${JSON.stringify(showStorageKind)};
  let sourceUri = ${JSON.stringify(initialSourceUri)};
  let diffCompareMode = 'current';
  let diffBaseNodeId = null;
  const i18n = {
    noteClickToEdit: ${JSON.stringify(vscode.l10n.t(' (click to edit)'))},
    noteAdd: ${JSON.stringify(vscode.l10n.t('Add note'))},
    pinNode: ${JSON.stringify(vscode.l10n.t('Pin node'))},
    unpinNode: ${JSON.stringify(vscode.l10n.t('Unpin node'))},
    pinnedNodes: ${JSON.stringify(vscode.l10n.t('Pinned'))},
    loading: ${JSON.stringify(vscode.l10n.t('Loading...'))},
    textEditorsOnly: ${JSON.stringify(vscode.l10n.t('Undo Tree is only available for text editors.'))},
    notTrackedWithExt: ${JSON.stringify(vscode.l10n.t('Undo Tree: {0} is not tracked', '{ext}'))},
    notTrackedGeneric: ${JSON.stringify(vscode.l10n.t('Undo Tree: this file is not tracked'))},
    notTrackedHintWithExt: ${JSON.stringify(vscode.l10n.t('To enable tracking for {0} files, click the status bar item or open Settings.', '{ext}'))},
    notTrackedHintGeneric: ${JSON.stringify(vscode.l10n.t('To enable tracking for this file, click the status bar item or open Settings.'))},
    enableTrackingWithExt: ${JSON.stringify(vscode.l10n.t('Enable tracking for {0}', '{ext}'))},
    enableTrackingGeneric: ${JSON.stringify(vscode.l10n.t('Enable tracking for this file'))},
    openSettings: ${JSON.stringify(vscode.l10n.t('Open Settings'))},
    basePrefix: ${JSON.stringify(vscode.l10n.t('Base: '))},
    pairDiffNeedsBase: ${JSON.stringify(vscode.l10n.t('Select a base node first with Set Base or B.'))},
  };

  function replaceExt(template, ext) {
    return template.replace('{ext}', ext);
  }

  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }

  const undoButton = document.getElementById('btn-undo');
  if (undoButton) { undoButton.addEventListener('click', () => send('undo')); }
  const redoButton = document.getElementById('btn-redo');
  if (redoButton) { redoButton.addEventListener('click', () => send('redo')); }
  const pauseButton = document.getElementById('btn-pause');
  if (pauseButton) { pauseButton.addEventListener('click', () => send('togglePause')); }
  const modeButton = document.getElementById('btn-mode');
  if (modeButton) { modeButton.addEventListener('click', () => send('toggleMode')); }
  const settingsButton = document.getElementById('btn-settings');
  if (settingsButton) { settingsButton.addEventListener('click', () => send('showMenu')); }
  const diffCurrentButton = document.getElementById('btn-diff-current');
  const diffPairButton = document.getElementById('btn-diff-pair');
  if (diffCurrentButton) { diffCurrentButton.addEventListener('click', () => setDiffCompareMode('current')); }
  if (diffPairButton) {
    diffPairButton.addEventListener('click', () => {
      setDiffCompareMode('pair');
    });
  }
  const helpBackdrop = document.getElementById('help-backdrop');
  if (helpBackdrop) { helpBackdrop.addEventListener('click', () => setHelpVisible(false)); }
  const helpClose = document.getElementById('help-close');
  if (helpClose) { helpClose.addEventListener('click', () => setHelpVisible(false)); }

  window.addEventListener('message', (event) => {
    if (event.data?.command === 'showJumpLoading') {
      const treeEl = document.getElementById('tree');
      if (treeEl) { treeEl.style.opacity = '0.4'; treeEl.style.pointerEvents = 'none'; }
      if (!document.getElementById('jump-overlay')) {
        const ov = document.createElement('div');
        ov.id = 'jump-overlay';
        ov.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;opacity:0.7;pointer-events:none;';
        ov.textContent = i18n.loading;
        document.body.appendChild(ov);
      }
    } else if (event.data?.command === 'renderState' && event.data.state) {
      renderState(event.data.state);
    }
  });
  function escHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function fmtLines(n) {
    return n.toLocaleString() + ' L';
  }
  function fmtBytes(b) {
    if (b >= 1024 * 1024) { return (b / (1024 * 1024)).toFixed(1) + ' MB'; }
    if (b >= 1024) { return (b / 1024).toFixed(1) + ' KB'; }
    return b + ' B';
  }
  function formatSizeDiff(node, refNode) {
    if (nodeSizeMetric === 'none') { return ''; }
    const val = nodeSizeMetric === 'lines' ? node.lineCount : node.byteCount;
    if (val === undefined || val === null) { return ''; }
    // 蝓ｺ貅悶ヮ繝ｼ繝芽・霄ｫ or 蝓ｺ貅悶′蜿悶ｌ縺ｪ縺・ｴ蜷・ 邨ｶ蟇ｾ蛟､繧定｡ｨ遉ｺ
    if (!refNode || node.id === refNode.id) {
      const str = nodeSizeMetric === 'lines' ? fmtLines(val) : fmtBytes(val);
      return '<span class="size-diff">' + str + '</span>';
    }
    const ref = nodeSizeMetric === 'lines' ? refNode.lineCount : refNode.byteCount;
    if (ref === undefined || ref === null) { return ''; }
    const delta = val - ref;
    const cls = delta > 0 ? 'plus' : delta < 0 ? 'minus' : '';
    const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
    if (nodeSizeMetric === 'lines') {
      return '<span class="size-diff ' + cls + '">' + sign + fmtLines(Math.abs(delta)) + '</span>';
    }
    const str = delta !== 0 ? fmtBytes(Math.abs(delta)) : '0 B';
    return '<span class="size-diff ' + cls + '">' + sign + str + '</span>';
  }

  let focusedIndex = -1;
  let nodeEls = [];
  let nodeIds = [];
  let treeMap = {};

  function isHelpVisible() {
    return document.getElementById('help-overlay')?.classList.contains('visible') === true;
  }

  function setHelpVisible(visible) {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) { return; }
    overlay.classList.toggle('visible', visible);
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function getNodeDisplayLabel(nodeId) {
    const node = treeMap[nodeId];
    if (!node) { return ''; }
    return node.note || node.label;
  }

  function renderDiffTools() {
    const tools = document.getElementById('diff-tools');
    const currentButton = document.getElementById('btn-diff-current');
    const pairButton = document.getElementById('btn-diff-pair');
    const baseLabel = document.getElementById('diff-base-label');
    if (!tools || !currentButton || !pairButton || !baseLabel) { return; }
    tools.classList.toggle('visible', mode === 'diff');
    currentButton.classList.toggle('active', diffCompareMode === 'current');
    pairButton.classList.toggle('active', diffCompareMode === 'pair');
    if (mode !== 'diff') {
      baseLabel.textContent = '';
      return;
    }
    if (diffCompareMode === 'pair') {
      if (diffBaseNodeId !== null && treeMap[diffBaseNodeId]) {
        baseLabel.textContent = i18n.basePrefix + getNodeDisplayLabel(diffBaseNodeId);
      } else {
        baseLabel.textContent = i18n.pairDiffNeedsBase;
      }
      return;
    }
    baseLabel.textContent = '';
  }

  function setDiffCompareMode(nextMode) {
    diffCompareMode = nextMode;
    if (nextMode === 'current') {
      diffBaseNodeId = null;
    }
    renderDiffTools();
    if (focusedIndex >= 0) {
      setFocused(focusedIndex);
    }
  }

  function setDiffBaseNode(nodeId) {
    if (nodeId === undefined || nodeId === null) { return; }
    diffBaseNodeId = nodeId;
    diffCompareMode = 'pair';
    renderDiffTools();
    if (focusedIndex >= 0) {
      setFocused(focusedIndex);
    }
  }

  function previewDiffForFocused() {
    if (mode !== 'diff' || focusedIndex < 0 || !sourceUri) { return; }
    const nodeId = nodeIds[focusedIndex];
    if (nodeId === undefined) { return; }
    if (diffCompareMode === 'pair') {
      if (diffBaseNodeId === null || nodeId === diffBaseNodeId) { return; }
      send('diffBetweenNodes', { leftNodeId: diffBaseNodeId, rightNodeId: nodeId, sourceUri });
      return;
    }
    if (nodeId === currentId) { return; }
    send('diffWithNode', { nodeId, sourceUri });
  }

  function setFocused(idx) {
    nodeEls.forEach((el, i) => {
      const isFocused = i === idx;
      const nodeId = nodeIds[i];
      el.classList.toggle('focused', isFocused);
      el.classList.toggle('diff-base', mode === 'diff' && diffCompareMode === 'pair' && nodeId === diffBaseNodeId);
      el.classList.toggle(
        'diff-target',
        mode === 'diff' &&
          isFocused &&
          (
            (diffCompareMode === 'current' && nodeId !== currentId) ||
            (diffCompareMode === 'pair' && diffBaseNodeId !== null && nodeId !== diffBaseNodeId)
          )
      );
    });
    focusedIndex = idx;
    if (idx >= 0 && nodeEls[idx]) { nodeEls[idx].scrollIntoView({ block: 'nearest' }); }
    previewDiffForFocused();
  }

  function jumpFocused() {
    if (focusedIndex < 0) { return; }
    const nodeId = nodeIds[focusedIndex];
    if (mode === 'diff') {
      if (diffCompareMode === 'pair') {
        if (diffBaseNodeId === null || nodeId === diffBaseNodeId) {
          setDiffBaseNode(nodeId);
        } else {
          send('diffBetweenNodes', { leftNodeId: diffBaseNodeId, rightNodeId: nodeId, sourceUri });
        }
      } else {
        send('diffWithNode', { nodeId, sourceUri });
      }
    }
    else { send('jumpToNode', { nodeId, focusEditor: true }); }
  }

  function moveSibling(dir) {
    if (focusedIndex < 0) { return; }
    const node = treeMap[nodeIds[focusedIndex]];
    if (!node || node.parents.length === 0) { return; }
    const siblings = treeMap[node.parents[node.parents.length - 1]]?.children ?? [];
    if (siblings.length <= 1) { return; }
    const sibIdx = siblings.indexOf(node.id);
    const nextId = siblings[(sibIdx + dir + siblings.length) % siblings.length];
    const next = nodeIds.indexOf(nextId);
    if (next >= 0) { setFocused(next); }
  }

  function moveToNoted(dir) {
    if (nodeIds.length === 0) { return; }
    const start = focusedIndex < 0 ? 0 : focusedIndex;
    for (let i = 1; i <= nodeIds.length; i++) {
      const idx = (start + i * dir + nodeIds.length * 10) % nodeIds.length;
      if (treeMap[nodeIds[idx]]?.note) { setFocused(idx); return; }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { return; }
    if (e.key === '?') {
      e.preventDefault();
      setHelpVisible(!isHelpVisible());
    } else if (e.key === 'Escape' && isHelpVisible()) {
      e.preventDefault();
      setHelpVisible(false);
    } else if (e.key === 'Escape' && mode === 'diff') {
      e.preventDefault(); send('toggleMode');
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setFocused(Math.min(focusedIndex < 0 ? 0 : focusedIndex + 1, nodeEls.length - 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setFocused(Math.max(focusedIndex < 0 ? nodeEls.length - 1 : focusedIndex - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault(); setFocused(0);
    } else if (e.key === 'End') {
      e.preventDefault(); setFocused(nodeEls.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); jumpFocused();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (focusedIndex >= 0) {
        const node = treeMap[nodeIds[focusedIndex]];
        const parentId = node?.parents?.[node.parents.length - 1];
        const idx = parentId !== undefined ? nodeIds.indexOf(parentId) : -1;
        if (idx >= 0) { setFocused(idx); }
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (focusedIndex >= 0) {
        const node = treeMap[nodeIds[focusedIndex]];
        const childId = node?.children?.[node.children.length - 1];
        const idx = childId !== undefined ? nodeIds.indexOf(childId) : -1;
        if (idx >= 0) { setFocused(idx); }
      }
    } else if (e.key === 'Tab') {
      e.preventDefault(); moveSibling(e.shiftKey ? -1 : 1);
    } else if (e.key === 'u') {
      e.preventDefault(); send('undo');
    } else if (e.key === 'r') {
      e.preventDefault(); send('redo');
    } else if (e.key === 'd') {
      e.preventDefault(); send('toggleMode');
    } else if (e.key === 'b') {
      e.preventDefault();
      if (focusedIndex >= 0) { setDiffBaseNode(nodeIds[focusedIndex]); }
    } else if (e.key === 'c') {
      e.preventDefault(); setDiffCompareMode('current');
    } else if (e.key === 'p') {
      e.preventDefault(); send('togglePause');
    } else if (e.key === 'n') {
      e.preventDefault(); moveToNoted(1);
    } else if (e.key === 'N') {
      e.preventDefault(); moveToNoted(-1);
    }
  });

  function buildTree(nodes, currentId) {
    if (!nodes) {
      document.getElementById('tree').innerHTML = '<div class="empty">' + i18n.textEditorsOnly + '</div>';
      return;
    }

    const map = {};
    nodes.forEach((node) => { map[node.id] = node; });
    treeMap = map;
    const latestId = nodes.reduce((best, n) => n.timestamp > map[best].timestamp ? n.id : best, nodes[0].id);
    const pinnedContainer = document.getElementById('pinned');
    const container = document.getElementById('tree');
    pinnedContainer.innerHTML = '';
    container.innerHTML = '';
    nodeEls = [];
    nodeIds = [];

    const cur = map[currentId];
    document.getElementById('btn-undo').disabled = !cur || cur.parents.length === 0;
    document.getElementById('btn-redo').disabled = !cur || cur.children.length === 0;

    const visitedNodes = new Set();

    const pinnedNodes = nodes.filter((node) => node.id !== 0 && node.pinned);
    if (pinnedNodes.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'pinned-wrap';
      wrap.innerHTML = '<div class="pinned-title">' + i18n.pinnedNodes + '</div>';
      pinnedNodes
        .sort((a, b) => b.timestamp - a.timestamp)
        .forEach((node) => {
          const row = document.createElement('div');
          row.className = 'pinned-link';
          row.innerHTML =
            '<span class="pin-mark">&#128204;</span>' +
            '<span class="pinned-label">' + escHtml(node.note || node.label) + '</span>' +
            (node.formattedTime ? '<span class="right-area"><span class="time">' + escHtml(node.formattedTime) + '</span></span>' : '');
          row.addEventListener('click', () => {
            const idx = nodeIds.indexOf(node.id);
            if (idx >= 0) { setFocused(idx); }
            if (mode !== 'diff') {
              send('jumpToNode', { nodeId: node.id });
            }
          });
          wrap.appendChild(row);
        });
      pinnedContainer.appendChild(wrap);
    }

    function renderSegment(kind) {
      switch (kind) {
        case 'pipe':
          return '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0 L6 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/></svg>';
        case 'tee':
          return '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0 L6 14 M6 7 L12 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/></svg>';
        case 'elbow':
          return '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0 L6 7 M6 7 L12 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/></svg>';
        default:
          return '<svg viewBox="0 0 12 14" aria-hidden="true"></svg>';
      }
    }

    function renderNode(id, prefixParts, isLast, parentChildCount) {
      if (visitedNodes.has(id)) {
        return;
      }
      visitedNodes.add(id);

      const node = map[id];
      if (!node) {
        return;
      }

      const isCurrent = node.id === currentId;
      const isRoot = id === 0;
      const storageKind =
        node.storage?.kind === 'full' ? 'F' :
        node.storage?.kind === 'delta' ? 'D' :
        '';
      const isDirectBranchChild = !isRoot && parentChildCount > 1;
      const graphHtml = prefixParts.map(renderSegment).join('') +
        (!isRoot ? renderSegment(isDirectBranchChild ? (isLast ? 'elbow' : 'tee') : (node.children.length === 1 ? 'tee' : 'elbow')) : '');

      const div = document.createElement('div');
      div.className = 'node' + (isCurrent ? ' current' : '');
      div.title = mode === 'diff' ? 'Click to compare with current' : 'Click to jump to this node';
      const noteHtml = node.note
        ? '<span class="note note-action" data-node-id="' + node.id + '" title="' + escHtml(node.note) + i18n.noteClickToEdit + '">' + escHtml(node.note) + '</span>'
        : '<span class="note-edit note-action" data-node-id="' + node.id + '" title="' + i18n.noteAdd + '">&#9998;</span>';
      const pinHtml = '<span class="pin-btn pin-action' + (node.pinned ? ' active' : '') + '" data-node-id="' + node.id + '" title="' + (node.pinned ? i18n.unpinNode : i18n.pinNode) + '">&#128204;</span>';
      const refNode = (nodeSizeMetricBase === 'current' && isCurrent && node.id !== 0)
        ? node
        : nodeSizeMetricBase === 'initial' ? map[nodes[0].id] : map[currentId];
      const sizeDiffHtml = formatSizeDiff(node, refNode);
      const labelHtml = node.note ? '' : '<span class="label">' + escHtml(node.label) + '</span>';
      div.innerHTML =
        (graphHtml ? '<span class="graph">' + graphHtml + '</span>' : '') +
        labelHtml +
        (mode === 'diff' && diffCompareMode === 'pair' && node.id === diffBaseNodeId ? '<span class="diff-base-badge">Base</span>' : '') +
        (mode === 'diff' && ((diffCompareMode === 'current' && !isCurrent) || (diffCompareMode === 'pair' && node.id !== diffBaseNodeId)) ? '<span class="diff-target-badge">Diff</span>' : '') +
        (node.isEmpty ? '<span class="empty-badge">(empty)</span>' : '') +
        noteHtml +
        (showStorageKind && storageKind ? '<span class="storage">' + storageKind + '</span>' : '') +
        '<span class="right-area">' + pinHtml + sizeDiffHtml + (node.formattedTime ? '<span class="time' + (node.id === latestId ? ' latest' : '') + '">' + escHtml(node.formattedTime) + '</span>' : '') + '</span>';
      const noteAction = div.querySelector('.note-action');
      if (noteAction) {
        noteAction.addEventListener('click', (event) => {
          event.stopPropagation();
          send('editNote', { nodeId: node.id });
        });
      }
      const pinAction = div.querySelector('.pin-action');
      if (pinAction) {
        pinAction.addEventListener('click', (event) => {
          event.stopPropagation();
          send('togglePin', { nodeId: node.id });
        });
      }
      div.addEventListener('click', () => {
        const idx = nodeIds.indexOf(node.id);
        if (idx >= 0) { setFocused(idx); }
        if (!isCurrent) {
          if (mode === 'diff') {
            if (diffCompareMode === 'pair' && diffBaseNodeId === null) {
              setDiffBaseNode(node.id);
            } else if (diffCompareMode === 'pair' && diffBaseNodeId !== node.id) {
              send('diffBetweenNodes', { leftNodeId: diffBaseNodeId, rightNodeId: node.id, sourceUri });
            } else {
              send('diffWithNode', { nodeId: node.id, sourceUri });
            }
          } else {
            send('jumpToNode', { nodeId: node.id });
          }
        }
      });
      nodeEls.push(div);
      nodeIds.push(node.id);
      container.appendChild(div);

      const isBranchParent = !isRoot && node.children.length > 1;
      const childPrefix = (isDirectBranchChild || isBranchParent)
        ? [...prefixParts, isLast ? 'blank' : 'pipe']
        : prefixParts;

      node.children.forEach((cid, i) => {
        renderNode(cid, childPrefix, i === node.children.length - 1, node.children.length);
      });
    }

    renderNode(0, [], false, 0);

    const currentEl = container.querySelector('.node.current');
    if (currentEl) { currentEl.scrollIntoView({ block: 'nearest' }); }
    setFocused(nodeIds.indexOf(currentId));
    renderDiffTools();
  }

  function renderNotTracked(ext) {
    const treeEl = document.getElementById('tree');
    const pinnedEl = document.getElementById('pinned');
    if (pinnedEl) { pinnedEl.innerHTML = ''; }
    treeEl.innerHTML =
      '<div class="msg">' + escHtml(ext ? replaceExt(i18n.notTrackedWithExt, ext) : i18n.notTrackedGeneric) + '</div>' +
      '<div class="hint">' + escHtml(ext ? replaceExt(i18n.notTrackedHintWithExt, ext) : i18n.notTrackedHintGeneric) + '</div>' +
      '<button class="btn" id="enable-tracking-btn">' + escHtml(ext ? replaceExt(i18n.enableTrackingWithExt, ext) : i18n.enableTrackingGeneric) + '</button>' +
      '<button class="btn" id="open-settings-btn">' + escHtml(i18n.openSettings) + '</button>';
    const enableTrackingButton = document.getElementById('enable-tracking-btn');
    if (enableTrackingButton) {
      enableTrackingButton.addEventListener('click', () => send('toggleTracking'));
    }
    const openSettingsButton = document.getElementById('open-settings-btn');
    if (openSettingsButton) {
      openSettingsButton.addEventListener('click', () => send('openSettings'));
    }
    nodeEls = [];
    nodeIds = [];
    treeMap = {};
  }

  function renderState(state) {
    nodes = state.nodes;
    currentId = state.currentId;
    mode = state.mode;
    timeFormat = state.timeFormat;
    timeFormatCustom = state.timeFormatCustom;
    nodeSizeMetric = state.nodeSizeMetric;
    nodeSizeMetricBase = state.nodeSizeMetricBase;
    showStorageKind = state.showStorageKind;
    sourceUri = state.sourceUri || '';

    if (diffBaseNodeId !== null && !state.nodes?.some((node) => node.id === diffBaseNodeId)) {
      diffBaseNodeId = null;
      if (diffCompareMode === 'pair') {
        diffCompareMode = 'current';
      }
    }

    document.querySelector('.btn-pause').textContent = state.paused ? ${JSON.stringify(vscode.l10n.t('Resume'))} : ${JSON.stringify(vscode.l10n.t('Pause'))};
    document.querySelector('.btn-pause').title = state.paused ? ${JSON.stringify(vscode.l10n.t('Resume tracking'))} : ${JSON.stringify(vscode.l10n.t('Pause tracking'))};
    document.querySelector('.btn-mode').textContent = mode === 'navigate' ? ${JSON.stringify(vscode.l10n.t('Diff'))} : ${JSON.stringify(vscode.l10n.t('Nav'))};
    document.querySelector('.btn-mode').title = mode === 'navigate' ? ${JSON.stringify(vscode.l10n.t('Switch to Diff mode'))} : ${JSON.stringify(vscode.l10n.t('Switch to Navigate mode'))};
    document.querySelector('.btn-mode').classList.toggle('active', mode === 'diff');

    let pausedBadge = document.querySelector('.paused-badge');
    if (state.paused) {
      if (!pausedBadge) {
        pausedBadge = document.createElement('div');
        pausedBadge.className = 'paused-badge';
        document.querySelector('.actions').insertAdjacentElement('afterend', pausedBadge);
      }
      pausedBadge.textContent = ${JSON.stringify(vscode.l10n.t('Tracking paused - history is frozen'))};
    } else if (pausedBadge) {
      pausedBadge.remove();
    }

    let diffBadge = document.querySelector('.diff-badge');
    if (mode === 'diff') {
      if (!diffBadge) {
        diffBadge = document.createElement('div');
        diffBadge.className = 'diff-badge';
        const anchor = document.querySelector('.paused-badge');
        if (anchor) {
          anchor.insertAdjacentElement('afterend', diffBadge);
        } else {
          document.querySelector('.actions').insertAdjacentElement('afterend', diffBadge);
        }
      }
      diffBadge.textContent = ${JSON.stringify(vscode.l10n.t('Diff mode - select a node to compare, then use ↑/↓ to keep reviewing'))};
    } else if (diffBadge) {
      diffBadge.remove();
    }
    renderDiffTools();

    const overlay = document.getElementById('jump-overlay');
    if (overlay) { overlay.remove(); }
    const treeEl = document.getElementById('tree');
    if (treeEl) { treeEl.style.opacity = '1'; treeEl.style.pointerEvents = ''; }

    if (state.view === 'loading') {
      document.getElementById('pinned').innerHTML = '';
      document.getElementById('tree').innerHTML = '<div class="empty">' + i18n.loading + '</div>';
      nodeEls = [];
      nodeIds = [];
      treeMap = {};
      return;
    }
    if (state.view === 'notTracked') {
      renderNotTracked(state.notTrackedExt || '');
      return;
    }
    buildTree(state.nodes, state.currentId);
  }

  renderState({
    view: ${JSON.stringify(initialView)},
    nodes,
    currentId,
    paused: ${JSON.stringify(paused)},
    mode,
    timeFormat,
    timeFormatCustom,
    nodeSizeMetric,
    nodeSizeMetricBase,
    showStorageKind,
    notTrackedExt: ${JSON.stringify(initialNotTrackedExt)},
    sourceUri
  });
</script>
</body>
</html>`;
    }
}
