'use strict';

import * as vscode from 'vscode';
import { format as formatDate } from 'date-fns';
import { UndoTreeManager } from './undoTreeManager';

type DisplayNode = ReturnType<UndoTreeManager['getTree']>['nodes'] extends Map<number, infer T>
    ? T & { formattedTime: string; isEmpty: boolean }
    : never;

export class UndoTreeProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private mode: 'navigate' | 'diff' = 'navigate';
    private lastEditor?: vscode.TextEditor;
    private lastEditorUri?: string;
    private loadingRequest?: { uri: string; token: number };
    private loadingToken = 0;

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
        webviewView.webview.options = { enableScripts: true };
        this.render();

        webviewView.webview.onDidReceiveMessage(async (message) => {
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
                        await vscode.commands.executeCommand('undotree.diffWithNode', message.nodeId);
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

        if (isLoadingCurrentEditor) {
            this.view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:var(--vscode-font-family);font-size:12px;padding:16px;color:var(--vscode-foreground);opacity:0.6;}</style>
</head><body>${vscode.l10n.t('Loading...')}</body></html>`;
            return;
        }
        const timeFormat = this.getTimeFormat();
        const timeFormatCustom = this.getTimeFormatCustom();
        const nodeSizeMetric = this.getNodeSizeMetric();
        const nodeSizeMetricBase = this.getNodeSizeMetricBase();
        const showStorageKind = this.getShowStorageKind();
        if (!editor) {
            this.view.webview.html = this.buildHtml(null, -1, this.manager.paused, this.mode, timeFormat, timeFormatCustom, nodeSizeMetric, nodeSizeMetricBase, showStorageKind);
            return;
        }
        if (!this.isTrackedDocument(editor.document)) {
            const fileName = editor.document.isUntitled ? '' : editor.document.fileName.replace(/.*[\\/]/, '');
            const ext = fileName.match(/\.[^.]+$/)?.[0] ?? '';
            this.view.webview.html = this.buildNotTrackedHtml(ext, fileName);
            return;
        }
        const tree = this.manager.getTree(editor.document.uri, editor.document.getText());
        const displayNodes = Array.from(tree.nodes.values()).map((node) => ({
            ...node,
            formattedTime: this.formatTimestamp(node.timestamp, timeFormat, timeFormatCustom),
            isEmpty: this.manager.isNodeEmpty(tree, node.id),
        }));
        this.view.webview.html = this.buildHtml(
            displayNodes,
            tree.currentId,
            this.manager.paused,
            this.mode,
            timeFormat,
            timeFormatCustom,
            nodeSizeMetric,
            nodeSizeMetricBase,
            showStorageKind
        );
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

    private getTimeFormat(): 'none' | 'time' | 'dateTime' | 'custom' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('timeFormat');
        if (value === 'none' || value === 'dateTime' || value === 'custom') {
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
        timeFormat: 'none' | 'time' | 'dateTime' | 'custom',
        timeFormatCustom: string
    ): string {
        if (timeFormat === 'none') { return ''; }
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

    private buildNotTrackedHtml(ext: string, _fileName: string): string {
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
<style>
body{font-family:var(--vscode-font-family);font-size:12px;padding:16px;color:var(--vscode-foreground);}
.msg{opacity:0.7;margin-bottom:8px;}
.hint{opacity:0.45;font-size:11px;margin-bottom:12px;}
.btn{display:block;margin-bottom:6px;background:none;border:none;padding:0;color:var(--vscode-textLink-foreground);font-size:12px;cursor:pointer;text-decoration:underline;text-align:left;}
.btn:hover{color:var(--vscode-textLink-activeForeground);}
</style>
</head><body>
<div class="msg">${label}</div>
<div class="hint">${hint}</div>
<button class="btn" onclick="acquireVsCodeApi().postMessage({command:'toggleTracking'})">${enableLabel}</button>
<button class="btn" onclick="acquireVsCodeApi().postMessage({command:'openSettings'})">${settingsLabel}</button>
</body></html>`;
    }

    private buildHtml(
        nodes: DisplayNode[] | null,
        currentId: number,
        paused: boolean,
        mode: 'navigate' | 'diff',
        timeFormat: 'none' | 'time' | 'dateTime' | 'custom',
        timeFormatCustom: string,
        nodeSizeMetric: 'none' | 'lines' | 'bytes',
        nodeSizeMetricBase: 'current' | 'initial',
        showStorageKind: boolean
    ): string {
        const nodesJson = nodes ? JSON.stringify(nodes) : 'null';
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
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
</style>
</head>
<body>
<div class="actions">
  <button id="btn-undo" onclick="send('undo')">${vscode.l10n.t('Undo')}</button>
  <button id="btn-redo" onclick="send('redo')">${vscode.l10n.t('Redo')}</button>
  <button class="btn-pause" onclick="send('togglePause')" title="${paused ? vscode.l10n.t('Resume tracking') : vscode.l10n.t('Pause tracking')}">${paused ? vscode.l10n.t('Resume') : vscode.l10n.t('Pause')}</button>
  <button class="btn-mode${mode === 'diff' ? ' active' : ''}" onclick="send('toggleMode')" title="${mode === 'navigate' ? vscode.l10n.t('Switch to Diff mode') : vscode.l10n.t('Switch to Navigate mode')}">${mode === 'navigate' ? vscode.l10n.t('Diff') : vscode.l10n.t('Nav')}</button>
  <button class="btn-settings" onclick="send('showMenu')" title="${vscode.l10n.t('Open Undo Tree menu')}">&#9881;</button>
</div>
${paused ? `<div class="paused-badge">${vscode.l10n.t('Tracking paused - history is frozen')}</div>` : ''}
${mode === 'diff' ? `<div class="diff-badge">${vscode.l10n.t('Diff mode - select a node to compare, then use ↑/↓ to keep reviewing')}</div>` : ''}
<div id="pinned"></div>
<div id="tree"></div>
<script>
  const vscode = acquireVsCodeApi();
  const nodes = ${nodesJson};
  const currentId = ${currentId};
  const mode = ${JSON.stringify(mode)};
  const timeFormat = ${JSON.stringify(timeFormat)};
  const timeFormatCustom = ${JSON.stringify(timeFormatCustom)};
  const nodeSizeMetric = ${JSON.stringify(nodeSizeMetric)};
  const nodeSizeMetricBase = ${JSON.stringify(nodeSizeMetricBase)};
  const showStorageKind = ${JSON.stringify(showStorageKind)};
  const i18n = {
    noteClickToEdit: ${JSON.stringify(vscode.l10n.t(' (click to edit)'))},
    noteAdd: ${JSON.stringify(vscode.l10n.t('Add note'))},
    pinNode: ${JSON.stringify(vscode.l10n.t('Pin node'))},
    unpinNode: ${JSON.stringify(vscode.l10n.t('Unpin node'))},
    pinnedNodes: ${JSON.stringify(vscode.l10n.t('Pinned'))},
  };

  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }

  window.addEventListener('message', (event) => {
    if (event.data?.command === 'showJumpLoading') {
      const treeEl = document.getElementById('tree');
      if (treeEl) { treeEl.style.opacity = '0.4'; treeEl.style.pointerEvents = 'none'; }
      if (!document.getElementById('jump-overlay')) {
        const ov = document.createElement('div');
        ov.id = 'jump-overlay';
        ov.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;opacity:0.7;pointer-events:none;';
        ov.textContent = ${JSON.stringify(vscode.l10n.t('Loading...'))};
        document.body.appendChild(ov);
      }
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

  function previewDiffForFocused() {
    if (mode !== 'diff' || focusedIndex < 0) { return; }
    const nodeId = nodeIds[focusedIndex];
    if (nodeId === undefined || nodeId === currentId) { return; }
    send('diffWithNode', { nodeId });
  }

  function setFocused(idx) {
    nodeEls.forEach((el, i) => {
      const isFocused = i === idx;
      const nodeId = nodeIds[i];
      el.classList.toggle('focused', isFocused);
      el.classList.toggle('diff-target', mode === 'diff' && isFocused && nodeId !== currentId);
    });
    focusedIndex = idx;
    if (idx >= 0 && nodeEls[idx]) { nodeEls[idx].scrollIntoView({ block: 'nearest' }); }
    previewDiffForFocused();
  }

  function jumpFocused() {
    if (focusedIndex < 0) { return; }
    const nodeId = nodeIds[focusedIndex];
    if (mode === 'diff') { send('diffWithNode', { nodeId }); }
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
    if (e.key === 'Escape' && mode === 'diff') {
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
      document.getElementById('tree').innerHTML = '<div class="empty">${vscode.l10n.t('Undo Tree is only available for text editors.')}</div>';
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
            (node.formattedTime ? '<span class="right-area"><span class="time">' + node.formattedTime + '</span></span>' : '');
          row.addEventListener('click', () => {
            const idx = nodeIds.indexOf(node.id);
            if (idx >= 0) { setFocused(idx); }
            if (mode === 'diff') {
              send('diffWithNode', { nodeId: node.id });
            } else {
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
        ? '<span class="note" title="' + escHtml(node.note) + i18n.noteClickToEdit + '" onclick="event.stopPropagation();send(\\'editNote\\',{nodeId:' + node.id + '})">' + escHtml(node.note) + '</span>'
        : '<span class="note-edit" title="' + i18n.noteAdd + '" onclick="event.stopPropagation();send(\\'editNote\\',{nodeId:' + node.id + '})">&#9998;</span>';
      const pinHtml = '<span class="pin-btn' + (node.pinned ? ' active' : '') + '" title="' + (node.pinned ? i18n.unpinNode : i18n.pinNode) + '" onclick="event.stopPropagation();send(\\'togglePin\\',{nodeId:' + node.id + '})">&#128204;</span>';
      const refNode = (nodeSizeMetricBase === 'current' && isCurrent && node.id !== 0)
        ? node
        : nodeSizeMetricBase === 'initial' ? map[nodes[0].id] : map[currentId];
      const sizeDiffHtml = formatSizeDiff(node, refNode);
      const labelHtml = node.note ? '' : '<span class="label">' + node.label + '</span>';
      div.innerHTML =
        (graphHtml ? '<span class="graph">' + graphHtml + '</span>' : '') +
        labelHtml +
        (mode === 'diff' && !isCurrent ? '<span class="diff-target-badge">Diff</span>' : '') +
        (node.isEmpty ? '<span class="empty-badge">(empty)</span>' : '') +
        noteHtml +
        (showStorageKind && storageKind ? '<span class="storage">' + storageKind + '</span>' : '') +
        '<span class="right-area">' + pinHtml + sizeDiffHtml + (node.formattedTime ? '<span class="time' + (node.id === latestId ? ' latest' : '') + '">' + node.formattedTime + '</span>' : '') + '</span>';
      div.addEventListener('click', () => {
        const idx = nodeIds.indexOf(node.id);
        if (idx >= 0) { setFocused(idx); }
        if (!isCurrent) {
          if (mode === 'diff') {
            send('diffWithNode', { nodeId: node.id });
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
  }

  buildTree(nodes, currentId);
</script>
</body>
</html>`;
    }
}
