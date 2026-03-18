'use strict';

import * as vscode from 'vscode';
import { format as formatDate } from 'date-fns';
import { UndoTreeManager } from './undoTreeManager';

type DisplayNode = ReturnType<UndoTreeManager['getTree']>['nodes'] extends Map<number, infer T>
    ? T & { formattedTime: string }
    : never;

export class UndoTreeProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private mode: 'navigate' | 'diff' = 'navigate';

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
                    }
                    break;
                case 'togglePause':
                    await vscode.commands.executeCommand('undotree.togglePause');
                    break;
                case 'showMenu':
                    await vscode.commands.executeCommand('undotree.showMenu');
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
        const timeFormat = this.getTimeFormat();
        const timeFormatCustom = this.getTimeFormatCustom();
        const nodeMarkerStyle = this.getNodeMarkerStyle();
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.view.webview.html = this.buildHtml(null, -1, this.manager.paused, this.mode, timeFormat, timeFormatCustom, nodeMarkerStyle);
            return;
        }
        const tree = this.manager.getTree(editor.document.uri, editor.document.getText());
        const displayNodes = Array.from(tree.nodes.values()).map((node) => ({
            ...node,
            formattedTime: this.formatTimestamp(node.timestamp, timeFormat, timeFormatCustom),
        }));
        this.view.webview.html = this.buildHtml(
            displayNodes,
            tree.currentId,
            this.manager.paused,
            this.mode,
            timeFormat,
            timeFormatCustom,
            nodeMarkerStyle
        );
    }

    private getTimeFormat(): 'time' | 'dateTime' | 'custom' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('timeFormat');
        if (value === 'dateTime' || value === 'custom') {
            return value;
        }
        return 'time';
    }

    private getTimeFormatCustom(): string {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('timeFormatCustom');
        return value && value.trim() ? value : 'yyyy-MM-dd HH:mm:ss';
    }

    private getNodeMarkerStyle(): 'none' | 'simple' | 'semantic' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('nodeMarkerStyle');
        if (value === 'none' || value === 'simple' || value === 'semantic') {
            return value;
        }
        return 'semantic';
    }

    private formatTimestamp(
        timestamp: number,
        timeFormat: 'time' | 'dateTime' | 'custom',
        timeFormatCustom: string
    ): string {
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

    private buildHtml(
        nodes: DisplayNode[] | null,
        currentId: number,
        paused: boolean,
        mode: 'navigate' | 'diff',
        timeFormat: 'time' | 'dateTime' | 'custom',
        timeFormatCustom: string,
        nodeMarkerStyle: 'none' | 'simple' | 'semantic'
    ): string {
        const nodesJson = nodes ? JSON.stringify(nodes) : 'null';
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; }
  .node { display: flex; align-items: center; gap: 4px; padding: 2px 4px; cursor: pointer; border-radius: 3px; user-select: none; white-space: nowrap; }
  .node:hover { background: var(--vscode-list-hoverBackground); }
  .node.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .graph { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--vscode-editorLineNumber-foreground); }
  .graph svg { width: 12px; height: 14px; display: block; overflow: visible; }
  .dot { width: 12px; height: 12px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-foreground); }
  .dot svg { width: 12px; height: 12px; display: block; }
  .storage { font-size: 9px; opacity: 0.5; border: 1px solid currentColor; border-radius: 2px; padding: 0 2px; flex-shrink: 0; }
  .label { opacity: 0.8; overflow: hidden; text-overflow: ellipsis; }
  .time { opacity: 0.5; font-size: 10px; margin-left: auto; padding-left: 6px; flex-shrink: 0; }
  .empty { opacity: 0.5; padding: 8px; }
  .actions { display: flex; gap: 4px; margin-bottom: 8px; align-items: center; }
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
</style>
</head>
<body>
<div class="actions">
  <button id="btn-undo" onclick="send('undo')">Undo</button>
  <button id="btn-redo" onclick="send('redo')">Redo</button>
  <button class="btn-pause" onclick="send('togglePause')" title="${paused ? 'Resume tracking' : 'Pause tracking'}">${paused ? 'Resume' : 'Pause'}</button>
  <button class="btn-mode${mode === 'diff' ? ' active' : ''}" onclick="send('toggleMode')" title="${mode === 'navigate' ? 'Switch to Diff mode' : 'Switch to Navigate mode'}">${mode === 'navigate' ? 'Diff' : 'Nav'}</button>
  <button class="btn-settings" onclick="send('showMenu')" title="Open Undo Tree menu">&#9881;</button>
</div>
${paused ? '<div class="paused-badge">Tracking paused - history is frozen</div>' : ''}
${mode === 'diff' ? '<div class="diff-badge">Diff mode - click node to compare with current</div>' : ''}
<div id="tree"></div>
<script>
  const vscode = acquireVsCodeApi();
  const nodes = ${nodesJson};
  const currentId = ${currentId};
  const mode = ${JSON.stringify(mode)};
  const timeFormat = ${JSON.stringify(timeFormat)};
  const timeFormatCustom = ${JSON.stringify(timeFormatCustom)};
  const nodeMarkerStyle = ${JSON.stringify(nodeMarkerStyle)};

  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }

  function buildTree(nodes, currentId) {
    if (!nodes) {
      document.getElementById('tree').innerHTML = '<div class="empty">No active editor</div>';
      return;
    }

    const map = {};
    nodes.forEach((node) => { map[node.id] = node; });
    const container = document.getElementById('tree');
    container.innerHTML = '';

    const cur = map[currentId];
    const latestLeafId = nodes
      .filter((node) => node.children.length === 0)
      .sort((a, b) => b.timestamp - a.timestamp)[0]?.id ?? -1;
    document.getElementById('btn-undo').disabled = !cur || cur.parents.length === 0;
    document.getElementById('btn-redo').disabled = !cur || cur.children.length === 0;

    const visitedNodes = new Set();

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

    function renderMarker(kind) {
      switch (kind) {
        case 'none':
          return '<svg viewBox="0 0 12 12" aria-hidden="true"></svg>';
        case 'current':
          return '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="var(--vscode-focusBorder)" stroke="var(--vscode-focusBorder)" stroke-width="1.5" /></svg>';
        case 'root':
          return '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.9" /></svg>';
        case 'branch':
          return '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 L10.5 6 L6 10.5 L1.5 6 Z" fill="currentColor" opacity="0.85" /></svg>';
        case 'latest':
          return '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.1" fill="currentColor" opacity="0.8" /></svg>';
        default:
          return '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3.2" fill="currentColor" opacity="0.45" /></svg>';
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
      const isBranchPoint = node.children.length > 1;
      const isLatestLeaf = node.children.length === 0 && node.id === latestLeafId;
      const storageKind =
        node.storage?.kind === 'full' ? 'F' :
        node.storage?.kind === 'delta' ? 'D' :
        '';
      const isDirectBranchChild = !isRoot && parentChildCount > 1;
      const graphHtml = prefixParts.map(renderSegment).join('') +
        (isDirectBranchChild ? renderSegment(isLast ? 'elbow' : 'tee') : '');

      const markerKind = nodeMarkerStyle === 'none'
        ? 'none'
        : nodeMarkerStyle === 'semantic'
          ? (isCurrent ? 'current'
            : isRoot ? 'root'
            : isBranchPoint ? 'branch'
            : isLatestLeaf ? 'latest'
            : 'normal')
          : (isCurrent ? 'current' : 'normal');
      const markerHtml = markerKind === 'none'
        ? ''
        : '<span class="dot dot-svg">' + renderMarker(markerKind) + '</span>';

      const div = document.createElement('div');
      div.className = 'node' + (isCurrent ? ' current' : '');
      div.title = mode === 'diff' ? 'Click to compare with current' : 'Click to jump to this node';
      div.innerHTML =
        (graphHtml ? '<span class="graph">' + graphHtml + '</span>' : '') +
        markerHtml +
        '<span class="label">' + node.label + '</span>' +
        (storageKind ? '<span class="storage">' + storageKind + '</span>' : '') +
        '<span class="time">' + node.formattedTime + '</span>';
      div.addEventListener('click', () => {
        if (!isCurrent) {
          if (mode === 'diff') {
            send('diffWithNode', { nodeId: node.id });
          } else {
            send('jumpToNode', { nodeId: node.id });
          }
        }
      });
      container.appendChild(div);

      const childPrefix = isDirectBranchChild
        ? [...prefixParts, isLast ? 'blank' : 'pipe']
        : prefixParts;

      node.children.forEach((cid, i) => {
        renderNode(cid, childPrefix, i === node.children.length - 1, node.children.length);
      });
    }

    renderNode(0, [], false, 0);
  }

  buildTree(nodes, currentId);
</script>
</body>
</html>`;
    }
}
