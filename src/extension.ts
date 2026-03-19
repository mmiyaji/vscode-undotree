'use strict';

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { gzip as gzipCb, gunzip as gunzipCb, gunzipSync } from 'zlib';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);
import { UndoTreeProvider } from './undoTreeProvider';
import { CompactPreviewItem, CompactPreviewResult, UndoTreeManager } from './undoTreeManager';

// バーチャルドキュメント（差分表示用）
export class UndoTreeDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private contents = new Map<string, string>();
    private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private readonly maxEntries = 24;

    readonly onDidChange = this.onDidChangeEmitter.event;

    prepare(content: string, ext: string, key?: string): vscode.Uri {
        const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
        const id = key ?? `node_${this.contents.size}`;
        const uri = vscode.Uri.parse(`undotree:/${encodeURIComponent(id)}${normalizedExt}`);
        if (this.contents.has(uri.toString())) {
            this.contents.delete(uri.toString());
        }
        this.contents.set(uri.toString(), content);
        while (this.contents.size > this.maxEntries) {
            const oldest = this.contents.keys().next().value;
            if (!oldest) {
                break;
            }
            this.contents.delete(oldest);
        }
        this.onDidChangeEmitter.fire(uri);
        return uri;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const key = uri.toString();
        const content = this.contents.get(key) ?? '';
        if (this.contents.has(key)) {
            this.contents.delete(key);
            this.contents.set(key, content);
        }
        return content;
    }

    releaseByPrefix(prefix: string): void {
        for (const key of Array.from(this.contents.keys())) {
            if (key.includes(encodeURIComponent(prefix))) {
                this.contents.delete(key);
            }
        }
    }

    clear(): void {
        this.contents.clear();
    }
}

let manager: UndoTreeManager | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let statusBarEditor: vscode.TextEditor | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const PERSIST_DEBOUNCE_MS = 1000;
let compactPreviewPanel: vscode.WebviewPanel | undefined;
let compactPreviewOverrides = new Map<number, 'remove' | 'keep'>();
let compactPreviewTargetUri: string | undefined;

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

function escHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatPreviewTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString('sv-SE').replace('T', ' ');
}

function formatPreviewCount(value: number): string {
    return new Intl.NumberFormat().format(value);
}

function formatPreviewBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    const maximumFractionDigits = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)} ${units[unitIndex]}`;
}

function formatPreviewMetrics(item: CompactPreviewItem): string {
    const parts = [
        formatPreviewTimestamp(item.timestamp),
        item.storageKind.toUpperCase(),
    ];
    if (typeof item.lineCount === 'number') {
        parts.push(`${formatPreviewCount(item.lineCount)} L`);
    }
    if (typeof item.byteCount === 'number') {
        parts.push(formatPreviewBytes(item.byteCount));
    }
    if (item.note) {
        parts.push(escHtml(item.note));
    }
    return parts.join(' · ');
}

function buildCompactPreviewHtml(
    fileName: string,
    mode: 'compact' | 'hard',
    result: CompactPreviewResult,
    hardDays: number,
    overrides: Map<number, 'remove' | 'keep'>,
    activeTab: 'removable' | 'protected' | 'all'
): string {
    const t = vscode.l10n.t;
    const localizeReason = (reason: string) => t(reason);
    const title = mode === 'compact' ? t('Compact Preview') : t('Hard Compact Preview');
    const summarizeReasons = (items: CompactPreviewResult['removable']) => Object.entries(
        items.reduce<Record<string, number>>((acc, item) => {
            acc[item.reason] = (acc[item.reason] ?? 0) + 1;
            return acc;
        }, {})
    );
    const removableReasonChips = summarizeReasons(result.removable)
        .map(([reason, count]) => `<span class="chip chip-remove">${escHtml(localizeReason(reason))} · ${count}</span>`)
        .join('');
    const protectedReasonChips = summarizeReasons(result.protected)
        .map(([reason, count]) => `<span class="chip chip-keep">${escHtml(localizeReason(reason))} · ${count}</span>`)
        .join('');
    const removableRows = result.removable.length === 0
        ? `<div class="empty">${t('No removable nodes.')}</div>`
        : result.removable.map((item) => `
            <div class="row removable">
              <div class="row-main">
                <div class="row-title">#${item.id} ${escHtml(item.label)}</div>
                <div class="row-meta">${formatPreviewMetrics(item)}</div>
              </div>
              <span class="reason remove">${escHtml(localizeReason(item.reason))}</span>
            </div>
        `).join('');
    const protectedRows = result.protected.length === 0
        ? `<div class="empty">${t('No protected nodes.')}</div>`
        : result.protected.map((item) => `
            <div class="row">
              <div class="row-main">
                <div class="row-title">#${item.id} ${escHtml(item.label)}</div>
                <div class="row-meta">${formatPreviewMetrics(item)}</div>
              </div>
              <span class="reason keep">${escHtml(localizeReason(item.reason))}</span>
            </div>
        `).join('');
    const allRows = result.all.length === 0
        ? `<div class="empty">${t('No nodes.')}</div>`
        : (() => {
            const byId = new Map(result.all.map((item) => [item.id, item]));
            const renderTreeRow = (item: CompactPreviewItem, prefix: string[], isLast: boolean): string => {
                const effectiveStatus = overrides.get(item.id) ?? item.status;
                const isManual = overrides.has(item.id);
                const statusLabel = isManual
                    ? (effectiveStatus === 'remove' ? t('manual remove') : t('manual keep'))
                    : (effectiveStatus === 'remove' ? t('auto remove') : t('auto keep'));
                const removeDisabled = item.manualRemoveAllowed ? '' : 'disabled';
                const manualHint = item.manualRemoveAllowed
                    ? ''
                    : `<div class="row-hint">${t('Manual remove unavailable: {0}', escHtml(localizeReason(item.manualRemoveReason ?? 'unsupported node shape')))}</div>`;
                const connectors = prefix.map((part) => `<span class="tree-seg">${part}</span>`).join('')
                    + `<span class="tree-seg">${isLast ? '└─' : '├─'}</span>`;
                const childIds = item.children.filter((id) => byId.has(id));
                const row = `
            <div class="row ${effectiveStatus === 'remove' ? 'removable' : ''}">
              <div class="row-main">
                <div class="row-title"><span class="tree-prefix">${connectors}</span>#${item.id} ${escHtml(item.label)}</div>
                <div class="row-meta">${formatPreviewMetrics(item)}</div>
                ${manualHint}
              </div>
              <div class="row-actions">
                <span class="reason ${effectiveStatus === 'remove' ? 'remove' : 'keep'}${isManual ? ' manual' : ''}">${statusLabel}</span>
                <button class="mini secondary" onclick="send('overrideKeep', ${item.id})">${t('Keep')}</button>
                <button class="mini" onclick="send('overrideRemove', ${item.id})" ${removeDisabled}>${t('Remove')}</button>
                <button class="mini secondary" onclick="send('clearOverride', ${item.id})">${t('Auto')}</button>
              </div>
            </div>`;
                const nextPrefix = [...prefix, isLast ? '&nbsp;&nbsp;&nbsp;' : '│&nbsp; '];
                return row + childIds.map((childId, index) =>
                    renderTreeRow(byId.get(childId)!, nextPrefix, index === childIds.length - 1)
                ).join('');
            };
            const roots = result.all.filter((item) => item.parents.length === 0 || !byId.has(item.parents[item.parents.length - 1]));
            return roots.map((item, index) => renderTreeRow(item, [], index === roots.length - 1)).join('');
        })();
    const hardHint = mode === 'hard'
        ? `<div class="hint">${t('Retention window: {0}', hardDays > 0 ? t('{0} day(s)', hardDays) : t('disabled'))}</div>`
        : '';
    const hardActionDisabled = mode === 'hard' && hardDays <= 0 ? 'disabled' : '';
    const removableTabActive = activeTab === 'removable';
    const protectedTabActive = activeTab === 'protected';
    const allTabActive = activeTab === 'all';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  .header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
  .title { font-size: 16px; font-weight: 600; }
  .subtitle { opacity: 0.7; font-size: 12px; margin-top: 4px; }
  .hint { margin-top: 6px; font-size: 12px; opacity: 0.75; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 6px 10px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.active { outline: 1px solid var(--vscode-focusBorder); }
  button:disabled { opacity: 0.5; cursor: default; }
  .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
  .reason-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .chip { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid currentColor; opacity: 0.9; display: inline-flex; align-items: center; justify-content: center; line-height: 1.2; min-height: 28px; box-sizing: border-box; }
  .chip-remove { color: var(--vscode-errorForeground); }
  .chip-keep { color: var(--vscode-focusBorder); }
  .card { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent); }
  .card-label { font-size: 11px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }
  .card-value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 12px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .section { margin-top: 18px; }
  .section h2 { font-size: 13px; margin: 0 0 8px; }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
  .row.removable { border-color: color-mix(in srgb, var(--vscode-errorForeground) 30%, var(--vscode-panel-border)); }
  .row-main { min-width: 0; }
  .row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .row-title { font-size: 12px; font-weight: 600; }
  .tree-prefix { display: inline-flex; color: var(--vscode-editorLineNumber-foreground); margin-right: 4px; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
  .tree-seg { width: 18px; display: inline-block; text-align: center; }
  .row-meta { font-size: 11px; opacity: 0.7; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-hint { font-size: 11px; opacity: 0.8; color: var(--vscode-descriptionForeground); margin-top: 5px; }
  .reason { flex-shrink: 0; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
  .reason.remove { color: var(--vscode-errorForeground); }
  .reason.keep { color: var(--vscode-focusBorder); }
  .reason.manual { font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; }
  .mini { padding: 3px 8px; font-size: 11px; }
  .empty { padding: 10px 0; opacity: 0.6; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${title}</div>
      <div class="subtitle">${escHtml(fileName)}</div>
      ${hardHint}
    </div>
  </div>
  <div class="actions">
    <button class="${mode === 'compact' ? 'active' : 'secondary'}" onclick="send('showCompact')">${t('Compact')}</button>
    <button class="${mode === 'hard' ? 'active' : 'secondary'}" onclick="send('showHard')" ${hardActionDisabled}>${t('Hard Compact')}</button>
    <button class="secondary" onclick="send('refresh')">${t('Refresh')}</button>
    <button onclick="send('runCompact')">${t('Run Compact')}</button>
    <button onclick="send('runHard')" ${hardActionDisabled}>${t('Run Hard Compact')}</button>
    ${mode === 'hard' && hardDays <= 0 ? `<button class="secondary" onclick="send('openSettings')">${t('Open Settings')}</button>` : ''}
  </div>
  <div class="summary">
    <div class="card">
      <div class="card-label">${t('Would Remove')}</div>
      <div class="card-value">${result.removable.length}</div>
    </div>
    <div class="card">
      <div class="card-label">${t('Kept')}</div>
      <div class="card-value">${result.protected.length}</div>
    </div>
  </div>
  <div class="section">
    <h2>${t('Reason Summary')}</h2>
    <div class="reason-summary">
      ${removableReasonChips || `<span class="empty">${t('No removable reasons.')}</span>`}
      ${protectedReasonChips || `<span class="empty">${t('No protected reasons.')}</span>`}
    </div>
  </div>
  <div class="tabs">
    <button id="tab-removable" class="${removableTabActive ? 'active' : 'secondary'}" onclick="showTab('removable')">${t('Removable')}</button>
    <button id="tab-protected" class="${protectedTabActive ? 'active' : 'secondary'}" onclick="showTab('protected')">${t('Protected')}</button>
    <button id="tab-all" class="${allTabActive ? 'active' : 'secondary'}" onclick="showTab('all')">${t('All')}</button>
  </div>
  <div id="panel-removable" class="tab-panel ${removableTabActive ? 'active' : ''}">
    <div class="section">
      <h2>${t('Removable Nodes')}</h2>
      <div class="list">${removableRows}</div>
    </div>
  </div>
  <div id="panel-protected" class="tab-panel ${protectedTabActive ? 'active' : ''}">
    <div class="section">
      <h2>${t('Protected Nodes')}</h2>
      <div class="list">${protectedRows}</div>
    </div>
  </div>
  <div id="panel-all" class="tab-panel ${allTabActive ? 'active' : ''}">
    <div class="section">
      <h2>${t('All Nodes')}</h2>
      <div class="list">${allRows}</div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function send(command, nodeId, tab) { vscode.postMessage({ command, nodeId, tab }); }
    function showTab(tab) {
      send('setTab', undefined, tab);
    }
  </script>
</body>
</html>`;
}

function getPersistedContentHashes(
    tree: NonNullable<ReturnType<UndoTreeManager['exportState']>['trees'][string]>,
    checkpointThreshold: number
): Set<string> {
    const totalFullBytes = tree.nodes.reduce((sum, node) => {
        if (node.storage.kind === 'full') {
            return sum + (node.byteCount ?? Buffer.byteLength(node.storage.content, 'utf8'));
        }
        return sum;
    }, 0);

    if (totalFullBytes < checkpointThreshold) {
        return new Set<string>();
    }

    return new Set(
        tree.nodes
            .filter((node) => node.storage.kind === 'full' && node.storage.content !== '')
            .map((node) => node.hash)
    );
}

async function readPersistedContentHashesFromTreeFile(
    treesDir: string,
    fileName: string
): Promise<Set<string>> {
    const treePath = path.join(treesDir, fileName);
    const buf = await fs.readFile(treePath);
    const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
    const raw = isGzip ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
    const parsed = JSON.parse(raw) as {
        tree?: NonNullable<ReturnType<UndoTreeManager['exportState']>['trees'][string]>;
    };
    const nodes = parsed.tree?.nodes ?? [];
    return new Set(
        nodes
            .filter((node): node is typeof node & { storage: { kind: 'checkpoint'; contentHash: string } } =>
                node.storage.kind === 'checkpoint')
            .map((node) => node.storage.contentHash)
    );
}

async function persistStateToDisk(
    context: vscode.ExtensionContext,
    state: ReturnType<UndoTreeManager['exportState']>,
    paused: boolean,
    dirtyUris?: Set<string>  // undefined = 全ツリーを保存（手動保存時）
) {
    const rootDir = context.globalStorageUri.fsPath;
    const treesDir = path.join(rootDir, 'undo-trees');
    const contentDir = path.join(treesDir, 'content');
    await fs.mkdir(contentDir, { recursive: true });

    const compressionThreshold = getCompressionThresholdBytes();
    const checkpointThreshold = getCheckpointThresholdBytes();
    const allEntries = Object.entries(state.trees);
    const referencedContentHashes = new Set<string>();

    // dirty なエントリのみ書き込む（undefined は全件）
    const writeEntries = dirtyUris
        ? allEntries.filter(([uri]) => dirtyUris.has(uri))
        : allEntries;

    // メモリにないツリーを既存 manifest から保持（上書き保存で消えないようにする）
    const existingManifest = await readPersistedManifest(context);
    const inMemoryUris = new Set(allEntries.map(([uri]) => uri));
    const preservedEntries = (existingManifest?.trees ?? []).filter(e => !inMemoryUris.has(e.uri));

    const manifest: PersistedManifest = {
        version: 1,
        savedAt: Date.now(),
        nextId: state.nextId,
        paused,
        trees: [
            ...allEntries.map(([uri]) => ({ uri, file: makeTreeFileName(uri) })),
            ...preservedEntries,
        ],
    };

    for (const [, tree] of allEntries) {
        for (const hash of getPersistedContentHashes(tree, checkpointThreshold)) {
            referencedContentHashes.add(hash);
        }
    }

    let canPruneContentFiles = true;
    await Promise.all(preservedEntries.map(async (entry) => {
        try {
            for (const hash of await readPersistedContentHashesFromTreeFile(treesDir, entry.file)) {
                referencedContentHashes.add(hash);
            }
        } catch {
            canPruneContentFiles = false;
        }
    }));

    await Promise.all(writeEntries.map(async ([uri, tree]) => {
        const contentHashes = getPersistedContentHashes(tree, checkpointThreshold);
        const useCheckpoint = contentHashes.size > 0;
        const totalFullBytes = tree.nodes.reduce((sum, node) => {
            if (node.storage.kind === 'full') {
                return sum + (node.byteCount ?? Buffer.byteLength(node.storage.content, 'utf8'));
            }
            return sum;
        }, 0);
        const useCompression = useCheckpoint || totalFullBytes >= compressionThreshold;

        // チェックポイントモード: fullコンテンツを別ファイルに分離
        const serializedNodes = useCheckpoint
            ? tree.nodes.map((node) => {
                if (node.storage.kind !== 'full' || node.storage.content === '') {
                    return node;
                }
                return { ...node, storage: { kind: 'checkpoint' as const, contentHash: node.hash } };
            })
            : tree.nodes;

        // コンテンツファイルの書き込み（既存ならスキップ、gzip圧縮）
        if (useCheckpoint) {
            await Promise.all(tree.nodes
                .filter((n) => n.storage.kind === 'full' && n.storage.content !== '')
                .map(async (n) => {
                    const full = n.storage as { kind: 'full'; content: string };
                    const filePath = path.join(contentDir, n.hash);
                    try {
                        await fs.access(filePath);
                    } catch {
                        const compressed = await gzip(Buffer.from(full.content, 'utf8'));
                        await fs.writeFile(filePath, compressed);
                    }
                })
            );
        }

        const json = JSON.stringify({ uri, tree: { ...tree, nodes: serializedNodes } }, null, 2);
        const filePath = path.join(treesDir, makeTreeFileName(uri));

        if (useCompression) {
            const compressed = await gzip(Buffer.from(json, 'utf8'));
            await fs.writeFile(filePath, compressed);
        } else {
            await fs.writeFile(filePath, json, 'utf8');
        }
    }));

    // マニフェストにないツリーファイルのみ削除（保存済みツリーは保持）
    const expectedFiles = new Set(manifest.trees.map((entry) => entry.file));
    expectedFiles.add('manifest.json');
    expectedFiles.add('content'); // サブディレクトリは除外しない
    const existingFiles = await fs.readdir(treesDir, { withFileTypes: true });
    await Promise.all(existingFiles
        .filter((entry) => entry.isFile() && !expectedFiles.has(entry.name))
        .map((entry) => fs.unlink(path.join(treesDir, entry.name))));

    await fs.writeFile(
        path.join(treesDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
    );

    if (canPruneContentFiles) {
        const existingContentFiles = await fs.readdir(contentDir, { withFileTypes: true });
        await Promise.all(existingContentFiles
            .filter((entry) => entry.isFile() && !referencedContentHashes.has(entry.name))
            .map((entry) => fs.unlink(path.join(contentDir, entry.name))));
    }

    return {
        rootDir,
        treesDir,
        treeCount: allEntries.length,
        writtenCount: writeEntries.length,
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
        const buf = await fs.readFile(treePath);
        // gzipマジックバイトで自動判別
        const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
        const raw = isGzip ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
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
        let persisted;
        try {
            persisted = await loadPersistedTreeFromDisk(context, document.uri);
        } catch {
            // ファイル読み込み失敗は無視して新規ツリーで継続
        }
        if (persisted) {
            treeManager.importTree(document.uri.toString(), persisted.tree, persisted.nextId);
            treeManager.syncDocumentState(document.uri, document.getText());
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
    treeManager.syncDocumentState(document.uri, document.getText());
    return true;
}

async function removePersistedState(context: vscode.ExtensionContext) {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.rm(treesDir, { recursive: true, force: true });
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

function getCompressionThresholdBytes(): number {
    const kb = vscode.workspace.getConfiguration('undotree').get<number>('compressionThresholdKB');
    return (typeof kb === 'number' && kb >= 0 ? kb : 100) * 1024;
}

function getCheckpointThresholdBytes(): number {
    const kb = vscode.workspace.getConfiguration('undotree').get<number>('checkpointThresholdKB');
    return (typeof kb === 'number' && kb >= 0 ? kb : 1000) * 1024;
}

function getContentCacheMaxBytes(): number {
    const kb = vscode.workspace.getConfiguration('undotree').get<number>('contentCacheMaxKB');
    return (typeof kb === 'number' && kb > 0 ? kb : 20480) * 1024;
}

function getHardCompactAfterDays(): number {
    const days = vscode.workspace.getConfiguration('undotree').get<number>('hardCompactAfterDays');
    return typeof days === 'number' && days >= 1 ? days : 0;
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

    const dirtyUris = manager!.getDirtyUris();
    persistTimer = setTimeout(() => {
        void persistStateToDisk(context, manager!.exportState(), manager!.paused, dirtyUris)
            .then(() => {
                manager?.clearDirty(dirtyUris);
            })
            .catch(() => {})
            .finally(() => {
                persistTimer = undefined;
            });
    }, PERSIST_DEBOUNCE_MS);
}

async function flushPersistState(context: vscode.ExtensionContext) {
    if (!manager || getPersistenceMode() !== 'auto') {
        return;
    }

    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
    }

    const dirtyUris = manager.getDirtyUris();
    if (dirtyUris.size === 0) {
        return;
    }

    await persistStateToDisk(context, manager.exportState(), manager.paused, dirtyUris);
    manager.clearDirty(dirtyUris);
}

async function flushPersistedUri(context: vscode.ExtensionContext, uri: vscode.Uri) {
    if (!manager || getPersistenceMode() !== 'auto') {
        return;
    }

    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
    }

    const dirtyUris = manager.getDirtyUris();
    if (dirtyUris.has(uri.toString())) {
        await persistStateToDisk(context, manager.exportState(), manager.paused, new Set([uri.toString()]));
        manager.clearDirty([uri.toString()]);
    }
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

function describeEditor(editor: vscode.TextEditor | undefined): string {
    if (!editor) {
        return 'none';
    }
    const { document } = editor;
    return JSON.stringify({
        scheme: document.uri.scheme,
        uri: document.uri.toString(),
        fileName: document.fileName,
        isUntitled: document.isUntitled,
    });
}

function updateStatusBar(editor: vscode.TextEditor | undefined) {
    if (!statusBarItem || !manager) {
        return;
    }
    const isRealFileEditor = !!editor &&
        !editor.document.isUntitled &&
        editor.document.uri.scheme === 'file';
    if (isRealFileEditor) {
        statusBarEditor = editor;
    }
    const targetEditor = isRealFileEditor ? editor : statusBarEditor;
    manager.debugLog?.(
        `[statusBar] input=${describeEditor(editor)} target=${describeEditor(targetEditor)} realFile=${isRealFileEditor}`
    );
    if (!targetEditor || targetEditor.document.isUntitled || targetEditor.document.uri.scheme !== 'file') {
        manager.debugLog?.('[statusBar] hiding item because no real file editor is available');
        statusBarItem.hide();
        return;
    }
    if (manager.paused) {
        statusBarItem.text = vscode.l10n.t('$(debug-pause) Undo Tree: PAUSED');
        statusBarItem.tooltip = vscode.l10n.t('Undo Tree is paused. Click to resume.');
        statusBarItem.command = 'undotree.togglePause';
        manager.debugLog?.('[statusBar] showing paused state');
        statusBarItem.show();
        return;
    }
    const ext = path.extname(targetEditor.document.fileName).toLowerCase() || '(none)';
    const enabled = getEnabledExtensions();
    const excluded = isExcluded(targetEditor.document);
    const tracked = !excluded && enabled.map(e => e.toLowerCase()).includes(ext);
    manager.debugLog?.(
        `[statusBar] computed tracked=${tracked} ext=${ext} excluded=${excluded} enabled=${enabled.join(',')}`
    );
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

function getTrackedContextEditor(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
    const candidate = editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file'
        ? editor
        : statusBarEditor;
    if (!candidate || candidate.document.isUntitled || candidate.document.uri.scheme !== 'file') {
        return undefined;
    }
    return candidate;
}

function getCompactPreviewContextEditor(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
    if (compactPreviewTargetUri) {
        const visible = vscode.window.visibleTextEditors.find((candidate) =>
            candidate.document.uri.toString() === compactPreviewTargetUri &&
            !candidate.document.isUntitled &&
            candidate.document.uri.scheme === 'file'
        );
        if (visible) {
            return visible;
        }
        const openDoc = vscode.workspace.textDocuments.find((candidate) =>
            candidate.uri.toString() === compactPreviewTargetUri &&
            !candidate.isUntitled &&
            candidate.uri.scheme === 'file'
        );
        if (openDoc) {
            return {
                document: openDoc,
                viewColumn: vscode.window.activeTextEditor?.viewColumn,
            } as vscode.TextEditor;
        }
    }
    return getTrackedContextEditor(editor);
}

function getDiffKeyBase(uri: vscode.Uri): string {
    return `diff-${crypto.createHash('sha1').update(uri.toString()).digest('hex')}`;
}

export async function activate(context: vscode.ExtensionContext) {
    manager = new UndoTreeManager();
    const provider = new UndoTreeProvider(context, manager);
    const contentProvider = new UndoTreeDocumentContentProvider();
    const persistedManifest = await readPersistedManifest(context);
    let compactPreviewMode: 'compact' | 'hard' = 'compact';
    let compactPreviewTab: 'removable' | 'protected' | 'all' = 'all';

    const outputChannel = vscode.window.createOutputChannel('Undo Tree');
    context.subscriptions.push(outputChannel);
    manager.debugLog = (msg) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);

    manager.paused = persistedManifest?.paused === true;
    manager.setAutosaveInterval(getAutosaveIntervalMs());
    manager.setContentCacheMax(getContentCacheMaxBytes());

    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    manager.contentResolver = (hash) => {
        try {
            const buf = readFileSync(path.join(treesDir, 'content', hash));
            const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
            return isGzip ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        } catch {
            return '';
        }
    };
    manager.asyncContentResolver = async (hash) => {
        try {
            const buf = await fs.readFile(path.join(treesDir, 'content', hash));
            const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
            return isGzip ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
        } catch {
            return '';
        }
    };

    manager.onRefresh = () => {
        provider.refresh();
        schedulePersistState(context);
        if (compactPreviewPanel) {
            void renderCompactPreviewPanel();
        }
    };
    manager.onCheckpointLoadStart = () => {
        provider.showCheckpointLoading();
    };
    manager.isTracked = (uri) => {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        return doc ? isTracked(doc) : false;
    };

    // 既に開いているエディタのツリーを実際のコンテンツで初期化
    if (vscode.window.activeTextEditor && isTracked(vscode.window.activeTextEditor.document)) {
        const ed = vscode.window.activeTextEditor;
        provider.setActiveEditor(ed);
        try {
            await ensureTreeLoaded(context, manager, ed.document);
        } catch {
            // ロード失敗は無視して新規ツリーで継続
        }
    }

    const renderCompactPreviewPanel = async () => {
        if (!compactPreviewPanel || !manager) {
            return;
        }
        const editor = getCompactPreviewContextEditor(vscode.window.activeTextEditor);
        if (!editor || !isTracked(editor.document)) {
            compactPreviewPanel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);opacity:0.7;">${vscode.l10n.t('Undo Tree preview is only available for tracked text files.')}</body></html>`;
            return;
        }
        await ensureTreeLoaded(context, manager, editor.document).catch(() => {});
        const tree = manager.getTree(editor.document.uri, editor.document.getText());
        const days = getHardCompactAfterDays();
        const result = compactPreviewMode === 'hard'
            ? manager.previewHardCompactDetailed(tree, days)
            : manager.previewCompactDetailed(tree);
        compactPreviewPanel.title = compactPreviewMode === 'hard'
            ? vscode.l10n.t('Undo Tree Hard Compact Preview')
            : vscode.l10n.t('Undo Tree Compact Preview');
        compactPreviewPanel.webview.html = buildCompactPreviewHtml(
            path.basename(editor.document.fileName) || editor.document.uri.toString(),
            compactPreviewMode,
            result,
            days,
            compactPreviewOverrides,
            compactPreviewTab
        );
    };

    const showCompactPreviewPanel = async (mode: 'compact' | 'hard') => {
        const sourceEditor = getTrackedContextEditor(vscode.window.activeTextEditor);
        if (sourceEditor) {
            compactPreviewTargetUri = sourceEditor.document.uri.toString();
        }
        compactPreviewMode = mode;
        compactPreviewOverrides.clear();
        compactPreviewTab = 'all';
        if (!compactPreviewPanel) {
            compactPreviewPanel = vscode.window.createWebviewPanel(
                'undotreeCompactPreview',
                vscode.l10n.t('Undo Tree Compact Preview'),
                vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            compactPreviewPanel.onDidDispose(() => {
                compactPreviewPanel = undefined;
                compactPreviewTargetUri = undefined;
            });
            compactPreviewPanel.webview.onDidReceiveMessage(async (message) => {
                switch (message.command) {
                    case 'showCompact':
                        compactPreviewMode = 'compact';
                        break;
                    case 'showHard':
                        compactPreviewMode = 'hard';
                        break;
                    case 'refresh':
                        break;
                    case 'setTab':
                        if (message.tab === 'removable' || message.tab === 'protected' || message.tab === 'all') {
                            compactPreviewTab = message.tab;
                        }
                        break;
                    case 'overrideKeep':
                        if (typeof message.nodeId === 'number') {
                            compactPreviewOverrides.set(message.nodeId, 'keep');
                        }
                        break;
                    case 'overrideRemove':
                        if (typeof message.nodeId === 'number') {
                            compactPreviewOverrides.set(message.nodeId, 'remove');
                        }
                        break;
                    case 'clearOverride':
                        if (typeof message.nodeId === 'number') {
                            compactPreviewOverrides.delete(message.nodeId);
                        }
                        break;
                    case 'runCompact':
                        await vscode.commands.executeCommand('undotree.compact');
                        break;
                    case 'runHard':
                        await vscode.commands.executeCommand('undotree.hardCompact');
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'undotree.hardCompactAfterDays');
                        return;
                    default:
                        return;
                }
                await renderCompactPreviewPanel();
            });
        } else {
            compactPreviewPanel.reveal(undefined, true);
        }
        await renderCompactPreviewPanel();
    };

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

        vscode.commands.registerCommand('undotree.resetAllState', async () => {
            if (!manager) {
                return;
            }

            const resetLabel = vscode.l10n.t('Reset');
            const confirmed = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Undo Tree: delete all in-memory and persisted history for this workspace? This only resets Undo Tree history and does not roll back the current file contents. This cannot be undone.'
                ),
                { modal: true },
                resetLabel
            );
            if (confirmed !== resetLabel) {
                return;
            }

            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = undefined;
            }

            compactPreviewOverrides.clear();
            compactPreviewTargetUri = undefined;
            contentProvider.clear();
            if (compactPreviewPanel) {
                compactPreviewPanel.dispose();
                compactPreviewPanel = undefined;
            }

            await removePersistedState(context);
            manager.resetAll();
            manager.paused = false;

            const editor = vscode.window.activeTextEditor;
            if (editor && isTracked(editor.document)) {
                manager.getTree(editor.document.uri, editor.document.getText());
            }

            provider.refresh();
            updateStatusBar(vscode.window.activeTextEditor);
            vscode.window.showInformationMessage(vscode.l10n.t('Undo Tree: all history has been reset.'));
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
                    label: vscode.l10n.t('$(trash) Reset Undo Tree State'),
                    description: vscode.l10n.t('Delete all in-memory and persisted Undo Tree history for this workspace'),
                    command: 'undotree.resetAllState',
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
                    label: vscode.l10n.t('$(eye) Compact History Preview'),
                    description: vscode.l10n.t('Open the compact preview with removable and protected nodes'),
                    command: isCurrentTracked ? 'undotree.compactDryRun' : undefined,
                },
                {
                    label: vscode.l10n.t('$(eye) Hard Compact Preview'),
                    description: vscode.l10n.t('Open the hard compact preview with retention details'),
                    command: isCurrentTracked ? 'undotree.hardCompactDryRun' : undefined,
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
            const diffKeyBase = getDiffKeyBase(editor.document.uri);

            const targetContent = manager.reconstructContent(tree, targetNodeId);
            const currentContent = editor.document.getText();

            const targetNode = tree.nodes.get(targetNodeId);
            const currentNode = tree.nodes.get(tree.currentId);
            const targetLabel = targetNode ? `node${targetNodeId} (${targetNode.label})` : `node${targetNodeId}`;
            const currentLabel = currentNode ? `current (${currentNode.label})` : 'current';

            const targetUri = contentProvider.prepare(targetContent, ext, `${diffKeyBase}-target`);
            const currentUri = contentProvider.prepare(currentContent, ext, `${diffKeyBase}-current`);

            await vscode.commands.executeCommand(
                'vscode.diff',
                targetUri,
                currentUri,
                vscode.l10n.t('Undo Tree Diff: {0}', path.basename(editor.document.fileName)),
                {
                    preview: true,
                    preserveFocus: true,
                    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active,
                }
            );
        }),

        vscode.commands.registerCommand('undotree.compact', async () => {
            const editor = getCompactPreviewContextEditor(vscode.window.activeTextEditor);
            if (!editor || !manager) {
                return;
            }
            const tree = manager.getTree(editor.document.uri);
            const { removed, skipped } = compactPreviewOverrides.size > 0
                ? manager.compactWithOverrides(tree, compactPreviewOverrides)
                : { removed: manager.compact(tree), skipped: 0 };
            if (removed > 0) {
                manager.markDirty(editor.document.uri);
            }
            compactPreviewOverrides.clear();
            provider.refresh();
            if (removed > 0) {
                try {
                    await flushPersistState(context);
                } catch {
                    vscode.window.showWarningMessage(vscode.l10n.t('Undo Tree: compact succeeded, but persisted state could not be updated.'));
                }
            }
            vscode.window.showInformationMessage(
                skipped > 0
                    ? vscode.l10n.t('Undo Tree: compacted {0} node(s), skipped {1} marked node(s)', removed, skipped)
                    : vscode.l10n.t('Undo Tree: compacted {0} node(s)', removed)
            );
        }),

        vscode.commands.registerCommand('undotree.compactDryRun', () => {
            const editor = getCompactPreviewContextEditor(vscode.window.activeTextEditor);
            if (!editor || !manager) {
                return;
            }
            void showCompactPreviewPanel('compact');
        }),

        vscode.commands.registerCommand('undotree.hardCompact', async () => {
            const editor = getTrackedContextEditor(vscode.window.activeTextEditor);
            if (!editor || !manager) {
                return;
            }
            const days = getHardCompactAfterDays();
            if (days <= 0) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Undo Tree: set undotree.hardCompactAfterDays (≥ 1) to use this command')
                );
                return;
            }
            const deleteLabel = vscode.l10n.t('Delete');
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t('Undo Tree: delete nodes older than {0} day(s)? This cannot be undone.', days),
                { modal: true },
                deleteLabel
            );
            if (confirm !== deleteLabel) {
                return;
            }
            const tree = manager.getTree(editor.document.uri);
            const { removed, skipped } = compactPreviewOverrides.size > 0
                ? manager.hardCompactWithOverrides(tree, days, compactPreviewOverrides)
                : { removed: manager.hardCompact(tree, days), skipped: 0 };
            if (removed > 0) {
                manager.markDirty(editor.document.uri);
            }
            compactPreviewOverrides.clear();
            provider.refresh();
            if (removed > 0) {
                try {
                    await flushPersistState(context);
                } catch {
                    vscode.window.showWarningMessage(vscode.l10n.t('Undo Tree: hard compact succeeded, but persisted state could not be updated.'));
                }
            }
            vscode.window.showInformationMessage(
                skipped > 0
                    ? vscode.l10n.t('Undo Tree: hard compacted {0} node(s) older than {1} day(s), skipped {2} marked node(s)', removed, days, skipped)
                    : vscode.l10n.t('Undo Tree: hard compacted {0} node(s) older than {1} day(s)', removed, days)
            );
        }),

        vscode.commands.registerCommand('undotree.hardCompactDryRun', () => {
            const editor = getTrackedContextEditor(vscode.window.activeTextEditor);
            if (!editor || !manager) {
                return;
            }
            const days = getHardCompactAfterDays();
            if (days <= 0) {
                void showCompactPreviewPanel('hard');
            } else {
                void showCompactPreviewPanel('hard');
            }
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
            contentProvider.releaseByPrefix(getDiffKeyBase(doc.uri));
            void (async () => {
                if (!manager || !isTracked(doc)) {
                    return;
                }
                if (getPersistenceMode() !== 'auto' || !manager.hasTree(doc.uri)) {
                    return;
                }
                try {
                    await flushPersistedUri(context, doc.uri);
                    manager.unloadTree(doc.uri);
                } catch {
                    // Keep the in-memory tree if persisting fails.
                }
            })();
        }),

        vscode.workspace.onDidOpenTextDocument((doc) => {
            void (async () => {
                if (isTracked(doc) && manager) {
                    await ensureTreeLoaded(context, manager, doc);
                }
            })();
        }),

        vscode.window.onDidChangeActiveTextEditor((e) => {
            manager?.debugLog?.(`[activeEditor] changed to ${describeEditor(e)}`);
            provider.setActiveEditor(e);
            manager?.onDidChangeActiveEditor(e);
            updateStatusBar(e);
            if (compactPreviewPanel) {
                void renderCompactPreviewPanel();
            }
            if (e && isTracked(e.document) && manager && !manager.hasTree(e.document.uri)) {
                // 未ロードのファイル: ローディング表示してから非同期ロード
                const loadingToken = provider.beginLoading(e.document.uri);
                provider.refresh();
                void ensureTreeLoaded(context, manager, e.document)
                    .catch(() => {/* ロード失敗は無視 */})
                    .finally(() => {
                        if (provider.endLoading(e.document.uri, loadingToken)) {
                            provider.refresh();
                        }
                    });
            } else {
                if (e && isTracked(e.document) && manager) {
                    void ensureTreeLoaded(context, manager, e.document).catch(() => {});
                }
                provider.refresh();
            }
        }),

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration('undotree.enabledExtensions') ||
                e.affectsConfiguration('undotree.excludePatterns') ||
                e.affectsConfiguration('undotree.persistenceMode') ||
                e.affectsConfiguration('undotree.autosaveInterval') ||
                e.affectsConfiguration('undotree.timeFormat') ||
                e.affectsConfiguration('undotree.timeFormatCustom') ||
                e.affectsConfiguration('undotree.showStorageKind') ||
                e.affectsConfiguration('undotree.nodeSizeMetric') ||
                e.affectsConfiguration('undotree.nodeSizeMetricBase') ||
                e.affectsConfiguration('undotree.compressionThresholdKB') ||
                e.affectsConfiguration('undotree.checkpointThresholdKB') ||
                e.affectsConfiguration('undotree.contentCacheMaxKB')
            ) {
                if (e.affectsConfiguration('undotree.persistenceMode')) {
                    schedulePersistState(context);
                }
                if (e.affectsConfiguration('undotree.autosaveInterval')) {
                    manager?.setAutosaveInterval(getAutosaveIntervalMs());
                }
                if (e.affectsConfiguration('undotree.contentCacheMaxKB')) {
                    manager?.setContentCacheMax(getContentCacheMaxBytes());
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
