'use strict';

import * as vscode from 'vscode';
import { UndoTreeManager } from './undoTreeManager';

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
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'undotree');
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
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.view.webview.html = this.buildHtml(null, -1, this.manager.paused, this.mode);
            return;
        }
        const tree = this.manager.getTree(editor.document.uri);
        this.view.webview.html = this.buildHtml(
            Array.from(tree.nodes.values()),
            tree.currentId,
            this.manager.paused,
            this.mode
        );
    }

    private buildHtml(nodes: ReturnType<typeof Array.from> | null, currentId: number, paused: boolean, mode: 'navigate' | 'diff'): string {
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
  .graph { font-family: monospace; font-size: 12px; color: var(--vscode-editorLineNumber-foreground); white-space: pre; flex-shrink: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-foreground); flex-shrink: 0; }
  .dot.current { background: var(--vscode-focusBorder); box-shadow: 0 0 0 2px var(--vscode-focusBorder); }
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
  .btn-settings { background: transparent; color: var(--vscode-foreground); opacity: 0.5; padding: 3px 5px; }
  .btn-settings:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .paused-badge { font-size: 10px; opacity: 0.6; margin-left: 2px; }
  .diff-badge { font-size: 10px; color: var(--vscode-focusBorder); margin-left: 2px; }
</style>
</head>
<body>
<div class="actions">
  <button id="btn-undo" onclick="send('undo')">↑ Undo</button>
  <button id="btn-redo" onclick="send('redo')">↓ Redo</button>
  <button class="btn-pause" onclick="send('togglePause')" title="${paused ? 'Resume tracking' : 'Pause tracking'}">${paused ? '▶ Resume' : '⏸ Pause'}</button>
  <button class="btn-mode${mode === 'diff' ? ' active' : ''}" onclick="send('toggleMode')" title="${mode === 'navigate' ? 'Switch to Diff mode' : 'Switch to Navigate mode'}">${mode === 'navigate' ? '⎇ Diff' : '⎇ Nav'}</button>
  <button class="btn-settings" onclick="send('openSettings')" title="Open Undo Tree settings">⚙</button>
</div>
${paused ? '<div class="paused-badge">⏸ Tracking paused — history is frozen</div>' : ''}
${mode === 'diff' ? '<div class="diff-badge">⎇ Diff mode — click node to compare with current</div>' : ''}
<div id="tree"></div>
<script>
  const vscode = acquireVsCodeApi();
  const nodes = ${nodesJson};
  const currentId = ${currentId};
  const mode = ${JSON.stringify(mode)};

  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0') + ':' + d.getSeconds().toString().padStart(2,'0');
  }

  function buildTree(nodes, currentId) {
    if (!nodes) {
      document.getElementById('tree').innerHTML = '<div class="empty">No active editor</div>';
      return;
    }
    const map = {};
    nodes.forEach(n => map[n.id] = n);
    const container = document.getElementById('tree');
    container.innerHTML = '';

    // undo/redoボタンの有効・無効を更新
    const cur = map[currentId];
    document.getElementById('btn-undo').disabled = !cur || cur.parents.length === 0;
    document.getElementById('btn-redo').disabled = !cur || cur.children.length === 0;

    const visitedNodes = new Set();

    // prefix: 親から引き継ぐ縦線部分 ("│  " or "   ")
    // connector: このノードの接続文字 ("├─" or "└─" or "")
    function renderNode(id, prefix, isLast) {
      if (visitedNodes.has(id)) return;
      visitedNodes.add(id);
      const node = map[id];
      if (!node) return;
      const isCurrent = node.id === currentId;
      const storageKind = node.storage?.kind === 'full' ? 'F' : node.storage?.kind === 'delta' ? 'D' : '';

      const isRoot = (prefix === '' && id === 0);
      const connector = isRoot ? '' : (isLast ? '└─' : '├─');
      const graphText = prefix + connector;

      const div = document.createElement('div');
      div.className = 'node' + (isCurrent ? ' current' : '');
      div.title = 'クリックしてこのノードにジャンプ';
      div.innerHTML =
        (graphText ? \`<span class="graph">\${graphText}</span>\` : '') +
        \`<span class="dot\${isCurrent ? ' current' : ''}"></span>\` +
        \`<span class="label">\${node.label}</span>\` +
        (storageKind ? \`<span class="storage">\${storageKind}</span>\` : '') +
        \`<span class="time">\${formatTime(node.timestamp)}</span>\`;
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

      // 子ノードへ渡すprefixを計算
      const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
      const children = node.children;
      children.forEach((childId, i) => {
        renderNode(childId, childPrefix, i === children.length - 1);
      });
    }
    renderNode(0, '', true);
  }

  buildTree(nodes, currentId);
</script>
</body>
</html>`;
    }
}
