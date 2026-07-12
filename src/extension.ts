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
import { CompactPreviewItem, CompactPreviewResult, SerializedUndoTree, UndoTreeManager, mergeSerializedTrees } from './undoTreeManager';
import { initializeRuntimeL10n, t as tr } from './runtimeL10n';
import { isValidContentHash } from './contentHash';
import { matchesGlob } from './glob';

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
const PERSIST_LOCK_RETRY_MS = 50;
const PERSIST_LOCK_TIMEOUT_MS = 10_000;
const PERSIST_LOCK_HEARTBEAT_MS = 5_000;
let persistWriteQueue: Promise<void> = Promise.resolve();
let compactPreviewPanel: vscode.WebviewPanel | undefined;
let diagnosticsPanel: vscode.WebviewPanel | undefined;
let compactPreviewOverrides = new Map<number, 'remove' | 'keep'>();
let compactPreviewTargetUri: string | undefined;
const EXTENSION_ID = 'mmiyaji.vscode-undotree';
const EXTENSION_SETTINGS_QUERY = `@ext:${EXTENSION_ID}`;
const MULTI_WINDOW_LOCK_HEARTBEAT_MS = 10_000;
const MULTI_WINDOW_LOCK_TTL_MS = 30_000;
const IDLE_TREE_UNLOAD_MS = 15 * 60_000;
const multiWindowSessionId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
let multiWindowLockTimer: ReturnType<typeof setInterval> | undefined;
const multiWindowLockUris = new Set<string>();
const multiWindowWarnedUris = new Set<string>();
let multiWindowLockWriteWarningShown = false;
const persistedUris = new Set<string>();
const knownPersistedTreeRevisions = new Map<string, string>();
const knownPersistedDestructiveGenerations = new Map<string, number>();
const pendingRenameOldUris = new Set<string>();
const persistRootMismatchWarnedUris = new Set<string>();
const destructivePersistGenerations = new Map<string, number>();
const destructivePersistChanges = new Map<string, DestructivePersistChange>();
const documentLifecycleGenerations = new Map<string, number>();
const documentTaskQueues = new Map<string, Promise<void>>();
const treeLoadPromises = new Map<string, Promise<void>>();
let documentTaskEpoch = 0;
let resetInProgress = false;
let storageEpochRebaseInProgress = false;
let windowStorageEpoch: number | undefined;
let windowStorageEpochLoad: Promise<number> | undefined;
const staleDestructiveGenerationWarnedUris = new Set<string>();
let autoPersistFailureCount = 0;
let autoPersistWarningShown = false;
let deactivateHandler: (() => Promise<void>) | undefined;

function getSettingSearchQuery(settingId?: string): string {
    return settingId ? `${EXTENSION_SETTINGS_QUERY} ${settingId}` : EXTENSION_SETTINGS_QUERY;
}

function getWebviewNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function buildWebviewCspMeta(nonce: string): string {
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">`;
}

function buildWebviewMessageHtml(message: string): string {
    const nonce = getWebviewNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
${buildWebviewCspMeta(nonce)}
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); opacity: 0.7; }
</style>
</head>
<body>${escHtml(message)}</body>
</html>`;
}

type PersistedManifest = {
    version: number;
    savedAt: number;
    nextId: number;
    paused: boolean;
    trees: Array<{ uri: string; file: string }>;
};

type ManifestReadResult = {
    status: 'ok' | 'backup' | 'missing' | 'invalid';
    manifest?: {
        nextId: number;
        paused: boolean;
        trees: Array<{ uri: string; file: string }>;
    };
};

type PersistOptions = {
    /** Only these resident trees are written. Omit to write every eligible resident tree. */
    dirtyUris?: ReadonlySet<string>;
    /** These trees are authoritative snapshots (used by destructive compaction). */
    replaceUris?: ReadonlySet<string>;
    /** Disk revision observed before compaction, used for destructive CAS. */
    destructiveChanges?: ReadonlyMap<string, DestructivePersistChange>;
    /** Per-window destructive generation captured when the request was created. */
    expectedDestructiveGenerations?: ReadonlyMap<string, number>;
};

type DestructivePersistChange = {
    baseRevision: string | null;
};

class StorageEpochMismatchError extends Error {
    constructor(readonly currentEpoch: number) {
        super(`Undo Tree storage epoch changed to ${currentEpoch}`);
        this.name = 'StorageEpochMismatchError';
    }
}

type DiagnosticsSnapshot = {
    manifestStatus: ManifestReadResult['status'];
    storageDir: string;
    manifestPath: string;
    backupManifestPath: string;
    manifestExists: boolean;
    backupExists: boolean;
    manifestTreeCount: number;
    treeFileCount: number;
    contentFileCount: number;
    orphanTreeFileCount: number | null;
    orphanContentFileCount: number | null;
    orphanTreeFiles: string[];
    orphanContentFiles: string[];
    validation: {
        status: 'ok' | 'warning' | 'error';
        checkedTreeFiles: number;
        missingTreeFiles: string[];
        unreadableTreeFiles: string[];
        missingContentHashes: string[];
    };
    locks: {
        enabled: boolean;
        sessionId: string;
        total: number;
        live: number;
        stale: number;
        owned: number;
        items: Array<{
            uri: string;
            sessionId: string;
            workspace: string;
            updatedAt: number;
            ageMs: number;
            isOwned: boolean;
            isLive: boolean;
        }>;
    };
};

type MultiWindowLockRecord = {
    sessionId: string;
    uri: string;
    updatedAt: number;
    workspace: string;
};

async function notifyManifestReadStatus(
    context: vscode.ExtensionContext,
    status: ManifestReadResult['status'],
    outputChannel: vscode.OutputChannel
) {
    const hasUnmanifestedTrees = status === 'missing' &&
        await hasUnmanifestedPersistedTreeFiles(context);
    if (status === 'ok' || (status === 'missing' && !hasUnmanifestedTrees)) {
        return;
    }

    const openStorageLabel = tr('Open Storage Folder');
    const resetLabel = tr('Reset All State');
    const openOutputLabel = tr('Open Output');

    if (status === 'backup') {
        outputChannel.appendLine('[manifest] primary manifest.json could not be used; fell back to manifest.json.bak. Pruning is disabled for this save cycle to protect persisted history.');
        const picked = await vscode.window.showWarningMessage(
            tr('Undo Tree recovered persisted history from manifest.json.bak. Automatic pruning is temporarily disabled to protect existing data.'),
            openStorageLabel,
            openOutputLabel
        );
        if (picked === openStorageLabel) {
            await openStorageFolder(context);
        } else if (picked === openOutputLabel) {
            outputChannel.show(true);
        }
        return;
    }

    autoPersistWarningShown = true;
    outputChannel.appendLine(
        status === 'missing'
            ? '[manifest] manifest files are missing while persisted tree files remain. Saving and pruning are blocked to avoid overwriting recoverable data.'
            : '[manifest] manifest.json and manifest.json.bak could not be read. Persisted history was not loaded, and pruning is disabled to avoid deleting orphaned data.'
    );
    const picked = await vscode.window.showWarningMessage(
        tr('Undo Tree could not read persisted history metadata. Existing persisted files will be left untouched to avoid data loss. You can inspect the storage folder or run Reset All State if you want to discard broken metadata.'),
        { modal: true },
        openStorageLabel,
        resetLabel,
        openOutputLabel
    );
    if (picked === openStorageLabel) {
        await openStorageFolder(context);
    } else if (picked === resetLabel) {
        await vscode.commands.executeCommand('undotree.resetAllState');
    } else if (picked === openOutputLabel) {
        outputChannel.show(true);
    }
}

async function hasUnmanifestedPersistedTreeFiles(
    context: vscode.ExtensionContext
): Promise<boolean> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    const entries = await fs.readdir(treesDir, { withFileTypes: true })
        .catch(() => [] as import('fs').Dirent[]);
    return entries.some((entry) => entry.isFile() &&
        entry.name !== 'manifest.json' &&
        entry.name !== 'manifest.json.bak');
}

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

function formatRelativeDurationShort(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        return `${totalHours}h`;
    }
    const totalDays = Math.floor(totalHours / 24);
    return `${totalDays}d`;
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

function readCheckpointContentBuffer(contentPath: string): Buffer {
    const buf = readFileSync(contentPath);
    const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
    return isGzip ? gunzipSync(buf) : buf;
}

function getDiagnosticsEnabled(context: vscode.ExtensionContext): boolean {
    return context.extensionMode === vscode.ExtensionMode.Development
        || getEnableDiagnostics();
}

async function updateDiagnosticsContext(context: vscode.ExtensionContext): Promise<void> {
    const enabled = getDiagnosticsEnabled(context);
    await vscode.commands.executeCommand('setContext', 'undotree.diagnosticsEnabled', enabled);
    if (!enabled && diagnosticsPanel) {
        diagnosticsPanel.dispose();
        diagnosticsPanel = undefined;
    }
}

async function collectDiagnosticsSnapshot(context: vscode.ExtensionContext): Promise<DiagnosticsSnapshot> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    const contentDir = path.join(treesDir, 'content');
    const locksDir = getMultiWindowLocksDir(context);
    const manifestPath = path.join(treesDir, 'manifest.json');
    const backupManifestPath = path.join(treesDir, 'manifest.json.bak');
    const manifestResult = await readPersistedManifest(context);

    const treeEntries = await fs.readdir(treesDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
    const contentEntries = await fs.readdir(contentDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
    const lockEntries = await fs.readdir(locksDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);

    const treeFiles = treeEntries
        .filter((entry) => entry.isFile() && entry.name !== 'manifest.json' && entry.name !== 'manifest.json.bak')
        .map((entry) => entry.name)
        .sort();
    const contentFiles = contentEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();

    let orphanTreeFiles: string[] = [];
    let orphanContentFiles: string[] = [];
    let orphanTreeFileCount: number | null = null;
    let orphanContentFileCount: number | null = null;
    const missingTreeFiles: string[] = [];
    const unreadableTreeFiles: string[] = [];
    const missingContentHashes = new Set<string>();
    let checkedTreeFiles = 0;
    const lockItems: DiagnosticsSnapshot['locks']['items'] = [];
    const now = Date.now();

    if (manifestResult.manifest) {
        const referencedTreeFiles = new Set(manifestResult.manifest.trees.map((entry) => entry.file));
        orphanTreeFiles = treeFiles.filter((fileName) => !referencedTreeFiles.has(fileName));
        orphanTreeFileCount = orphanTreeFiles.length;

        const referencedContentHashes = new Set<string>();
        let canResolveContentOrphans = true;
        for (const entry of manifestResult.manifest.trees) {
            const treePath = path.join(treesDir, entry.file);
            try {
                await fs.access(treePath);
            } catch {
                missingTreeFiles.push(entry.file);
                canResolveContentOrphans = false;
                continue;
            }
            try {
                checkedTreeFiles++;
                for (const hash of await readPersistedContentHashesFromTreeFile(treesDir, entry.file)) {
                    referencedContentHashes.add(hash);
                    const contentPath = path.join(contentDir, hash);
                    try {
                        await fs.access(contentPath);
                    } catch {
                        missingContentHashes.add(hash);
                    }
                }
            } catch {
                unreadableTreeFiles.push(entry.file);
                canResolveContentOrphans = false;
            }
        }
        if (canResolveContentOrphans) {
            orphanContentFiles = contentFiles.filter((fileName) => !referencedContentHashes.has(fileName));
            orphanContentFileCount = orphanContentFiles.length;
        }
    }

    const exists = async (filePath: string) => {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    };

    for (const entry of lockEntries.filter((item) => item.isFile() && item.name.endsWith('.json'))) {
        try {
            const raw = await fs.readFile(path.join(locksDir, entry.name), 'utf8');
            const parsed = JSON.parse(raw) as Partial<MultiWindowLockRecord>;
            if (typeof parsed.uri !== 'string' || typeof parsed.sessionId !== 'string' || typeof parsed.updatedAt !== 'number') {
                continue;
            }
            const ageMs = now - parsed.updatedAt;
            lockItems.push({
                uri: parsed.uri,
                sessionId: parsed.sessionId,
                workspace: typeof parsed.workspace === 'string' ? parsed.workspace : '',
                updatedAt: parsed.updatedAt,
                ageMs,
                isOwned: parsed.sessionId === multiWindowSessionId,
                isLive: ageMs <= MULTI_WINDOW_LOCK_TTL_MS,
            });
        } catch {
            // Ignore unreadable lock files in the diagnostics snapshot.
        }
    }
    lockItems.sort((a, b) => a.uri.localeCompare(b.uri));

    return {
        manifestStatus: manifestResult.status,
        storageDir: treesDir,
        manifestPath,
        backupManifestPath,
        manifestExists: await exists(manifestPath),
        backupExists: await exists(backupManifestPath),
        manifestTreeCount: manifestResult.manifest?.trees.length ?? 0,
        treeFileCount: treeFiles.length,
        contentFileCount: contentFiles.length,
        orphanTreeFileCount,
        orphanContentFileCount,
        orphanTreeFiles,
        orphanContentFiles,
        validation: {
            status: missingTreeFiles.length > 0 || unreadableTreeFiles.length > 0 || missingContentHashes.size > 0
                ? (missingTreeFiles.length > 0 || unreadableTreeFiles.length > 0 ? 'error' : 'warning')
                : 'ok',
            checkedTreeFiles,
            missingTreeFiles,
            unreadableTreeFiles,
            missingContentHashes: Array.from(missingContentHashes).sort(),
        },
        locks: {
            enabled: getPersistenceMode() === 'auto' && getWarnOnMultiWindowConflict(),
            sessionId: multiWindowSessionId,
            total: lockItems.length,
            live: lockItems.filter((item) => item.isLive).length,
            stale: lockItems.filter((item) => !item.isLive).length,
            owned: lockItems.filter((item) => item.isOwned).length,
            items: lockItems,
        },
    };
}

function buildDiagnosticsHtml(snapshot: DiagnosticsSnapshot): string {
    const t = vscode.l10n.t;
    const nonce = getWebviewNonce();
    const manifestStateClass = snapshot.manifestStatus === 'invalid'
        ? 'danger'
        : snapshot.manifestStatus === 'backup'
            ? 'warn'
            : 'ok';
    const renderCount = (value: number | null) => value == null ? t('unknown') : formatPreviewCount(value);
    const renderList = (items: string[], emptyText: string) => items.length === 0
        ? `<div class="empty">${escHtml(emptyText)}</div>`
        : `<ul>${items.slice(0, 20).map((item) => `<li>${escHtml(item)}</li>`).join('')}</ul>${items.length > 20 ? `<div class="hint">${t('{0} more...', items.length - 20)}</div>` : ''}`;
    const renderLockList = (items: DiagnosticsSnapshot['locks']['items']) => items.length === 0
        ? `<div class="empty">${escHtml(t('No lock files detected.'))}</div>`
        : `<ul>${items.slice(0, 20).map((item) => {
            const flags = [
                item.isOwned ? t('owned') : t('foreign'),
                item.isLive ? t('live') : t('stale'),
                formatRelativeDurationShort(item.ageMs),
            ].join(' · ');
            return `<li><strong>${escHtml(item.uri)}</strong><br><span class="hint">${escHtml(flags)} · ${escHtml(item.workspace || '-')}</span></li>`;
        }).join('')}</ul>${items.length > 20 ? `<div class="hint">${t('{0} more...', items.length - 20)}</div>` : ''}`;
    const validationClass = snapshot.validation.status === 'error'
        ? 'danger'
        : snapshot.validation.status === 'warning'
            ? 'warn'
            : 'ok';
    const lockClass = snapshot.locks.enabled ? 'ok' : 'warn';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${buildWebviewCspMeta(nonce)}
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h1, h2 { font-weight: 600; margin: 0 0 12px; }
    h1 { font-size: 16px; }
    h2 { font-size: 13px; margin-top: 20px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 12px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
    }
    .label { opacity: 0.7; font-size: 12px; margin-bottom: 4px; }
    .value { font-size: 14px; word-break: break-all; }
    .card-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
    .card-actions button { padding: 4px 10px; font-size: 12px; }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .pill.ok { color: var(--vscode-testing-iconPassed); }
    .pill.warn { color: var(--vscode-testing-iconQueued); }
    .pill.danger { color: var(--vscode-errorForeground); }
    .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    ul { margin: 0; padding-left: 18px; }
    li { margin-bottom: 4px; }
    .hint, .empty { opacity: 0.7; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${t('Undo Tree Diagnostics')}</h1>
  <div class="pill ${manifestStateClass}">${t('Manifest status')}: ${escHtml(snapshot.manifestStatus)}</div>
  <div class="toolbar">
    <button data-command="refresh">${t('Refresh')}</button>
    <button data-command="validate">${t('Validate Persisted Storage')}</button>
    <button data-command="pruneOrphans">${t('Prune Orphan Files')}</button>
    <button data-command="rebuildManifest">${t('Rebuild Manifest')}</button>
    <button class="secondary" data-command="showOutput">${t('Open Output')}</button>
    <button class="secondary" data-command="simulateBackup">${t('Simulate backup fallback')}</button>
    <button class="secondary" data-command="simulateInvalid">${t('Simulate invalid manifest')}</button>
    <button class="secondary" data-command="resetAll">${t('Reset All State')}</button>
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">${t('Storage folder')}</div>
      <div class="value">${escHtml(snapshot.storageDir)}</div>
      <div class="card-actions"><button class="secondary" data-command="openStorage">${t('Open Folder')}</button></div>
    </div>
    <div class="card">
      <div class="label">${t('manifest.json')}</div>
      <div class="value">${escHtml(snapshot.manifestExists ? snapshot.manifestPath : t('missing'))}</div>
      <div class="card-actions"><button class="secondary" data-command="openStorage">${t('Open Folder')}</button></div>
    </div>
    <div class="card">
      <div class="label">${t('manifest.json.bak')}</div>
      <div class="value">${escHtml(snapshot.backupExists ? snapshot.backupManifestPath : t('missing'))}</div>
      <div class="card-actions"><button class="secondary" data-command="openStorage">${t('Open Folder')}</button></div>
    </div>
    <div class="card"><div class="label">${t('Manifest tree entries')}</div><div class="value">${formatPreviewCount(snapshot.manifestTreeCount)}</div></div>
    <div class="card"><div class="label">${t('Persisted tree files')}</div><div class="value">${formatPreviewCount(snapshot.treeFileCount)}</div></div>
    <div class="card"><div class="label">${t('Persisted content files')}</div><div class="value">${formatPreviewCount(snapshot.contentFileCount)}</div></div>
    <div class="card"><div class="label">${t('Orphan tree files')}</div><div class="value">${renderCount(snapshot.orphanTreeFileCount)}</div></div>
    <div class="card"><div class="label">${t('Orphan content files')}</div><div class="value">${renderCount(snapshot.orphanContentFileCount)}</div></div>
  </div>

  <h2>${t('Multi-window Locks')}</h2>
  <div class="pill ${lockClass}">${t('Lock warnings')}: ${snapshot.locks.enabled ? t('enabled') : t('disabled')}</div>
  <div class="grid">
    <div class="card"><div class="label">${t('Current session')}</div><div class="value">${escHtml(snapshot.locks.sessionId)}</div></div>
    <div class="card"><div class="label">${t('Total locks')}</div><div class="value">${formatPreviewCount(snapshot.locks.total)}</div></div>
    <div class="card"><div class="label">${t('Live locks')}</div><div class="value">${formatPreviewCount(snapshot.locks.live)}</div></div>
    <div class="card"><div class="label">${t('Stale locks')}</div><div class="value">${formatPreviewCount(snapshot.locks.stale)}</div></div>
    <div class="card"><div class="label">${t('Owned locks')}</div><div class="value">${formatPreviewCount(snapshot.locks.owned)}</div></div>
  </div>

  <h2>${t('Validation')}</h2>
  <div class="pill ${validationClass}">${t('Validation status')}: ${escHtml(snapshot.validation.status)}</div>
  <div class="grid">
    <div class="card"><div class="label">${t('Checked tree files')}</div><div class="value">${formatPreviewCount(snapshot.validation.checkedTreeFiles)}</div></div>
    <div class="card"><div class="label">${t('Missing tree files')}</div><div class="value">${formatPreviewCount(snapshot.validation.missingTreeFiles.length)}</div></div>
    <div class="card"><div class="label">${t('Unreadable tree files')}</div><div class="value">${formatPreviewCount(snapshot.validation.unreadableTreeFiles.length)}</div></div>
    <div class="card"><div class="label">${t('Missing content hashes')}</div><div class="value">${formatPreviewCount(snapshot.validation.missingContentHashes.length)}</div></div>
  </div>

  <div class="columns">
    <div>
      <h2>${t('Lock Files')}</h2>
      ${renderLockList(snapshot.locks.items)}
    </div>
  </div>
  <div class="columns">
    <div>
      <h2>${t('Orphan Tree Files')}</h2>
      ${renderList(snapshot.orphanTreeFiles, t('No orphan tree files detected.'))}
    </div>
    <div>
      <h2>${t('Orphan Content Files')}</h2>
      ${renderList(snapshot.orphanContentFiles, t('No orphan content files detected.'))}
    </div>
  </div>
  <div class="columns">
    <div>
      <h2>${t('Missing Tree Files')}</h2>
      ${renderList(snapshot.validation.missingTreeFiles, t('No missing tree files detected.'))}
    </div>
    <div>
      <h2>${t('Unreadable Tree Files')}</h2>
      ${renderList(snapshot.validation.unreadableTreeFiles, t('No unreadable tree files detected.'))}
    </div>
  </div>
  <div>
    <h2>${t('Missing Content Hashes')}</h2>
    ${renderList(snapshot.validation.missingContentHashes, t('No missing content hashes detected.'))}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ command: button.dataset.command });
      });
    });
  </script>
</body>
</html>`;
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
    const nonce = getWebviewNonce();
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
                <button class="mini secondary" data-command="overrideKeep" data-node-id="${item.id}">${t('Keep')}</button>
                <button class="mini" data-command="overrideRemove" data-node-id="${item.id}" ${removeDisabled}>${t('Remove')}</button>
                <button class="mini secondary" data-command="clearOverride" data-node-id="${item.id}">${t('Auto')}</button>
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
${buildWebviewCspMeta(nonce)}
<style nonce="${nonce}">
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
    <button class="${mode === 'compact' ? 'active' : 'secondary'}" data-command="showCompact">${t('Compact')}</button>
    <button class="${mode === 'hard' ? 'active' : 'secondary'}" data-command="showHard" ${hardActionDisabled}>${t('Hard Compact')}</button>
    <button class="secondary" data-command="refresh">${t('Refresh')}</button>
    <button data-command="runCompact">${t('Run Compact')}</button>
    <button data-command="runHard" ${hardActionDisabled}>${t('Run Hard Compact')}</button>
    ${mode === 'hard' && hardDays <= 0 ? `<button class="secondary" data-command="openSettings">${t('Open Settings')}</button>` : ''}
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
    <button id="tab-removable" class="${removableTabActive ? 'active' : 'secondary'}" data-tab="removable">${t('Removable')}</button>
    <button id="tab-protected" class="${protectedTabActive ? 'active' : 'secondary'}" data-tab="protected">${t('Protected')}</button>
    <button id="tab-all" class="${allTabActive ? 'active' : 'secondary'}" data-tab="all">${t('All')}</button>
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(command, nodeId, tab) { vscode.postMessage({ command, nodeId, tab }); }
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        const nodeId = button.dataset.nodeId === undefined ? undefined : Number(button.dataset.nodeId);
        send(button.dataset.command, Number.isFinite(nodeId) ? nodeId : undefined);
      });
    });
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => send('setTab', undefined, button.dataset.tab));
    });
  </script>
</body>
</html>`;
}

function getPersistedContentHashes(
    tree: NonNullable<ReturnType<UndoTreeManager['exportState']>['trees'][string]>,
    checkpointThreshold: number
): Set<string> {
    const hashes = new Set(
        tree.nodes
            .filter((node): node is typeof node & { storage: { kind: 'checkpoint'; contentHash: string } } =>
                node.storage.kind === 'checkpoint')
            .map((node) => requireValidContentHash(node.storage.contentHash))
    );
    const totalFullBytes = tree.nodes.reduce((sum, node) => {
        if (node.storage.kind === 'full') {
            return sum + (node.byteCount ?? Buffer.byteLength(node.storage.content, 'utf8'));
        }
        return sum;
    }, 0);

    if (totalFullBytes < checkpointThreshold) {
        return hashes;
    }

    tree.nodes
        .filter((node) => node.storage.kind === 'full' && node.storage.content !== '')
        .forEach((node) => hashes.add(requireValidContentHash(node.hash)));
    return hashes;
}

function getSerializedRootHash(tree: SerializedUndoTree): string | undefined {
    return tree.nodes.find((node) => node.id === tree.rootId)?.hash;
}

function getSerializedTreeRevision(tree: SerializedUndoTree): string {
    const canonical = {
        rootId: tree.rootId,
        currentId: tree.currentId,
        nodes: [...tree.nodes]
            .sort((a, b) => a.id - b.id)
            .map((node) => [
                node.id,
                [...node.parents].sort((a, b) => a - b),
                [...node.children].sort((a, b) => a - b),
                node.timestamp,
                node.label,
                node.hash,
                node.lineCount ?? null,
                node.byteCount ?? null,
                node.note ?? null,
                node.noteUpdatedAt ?? null,
                node.pinned ?? null,
                node.pinnedUpdatedAt ?? null,
            ]),
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function writeGenerationConflictSnapshot(
    treesDir: string,
    uri: string,
    tree: SerializedUndoTree,
    nextId: number,
    expectedGeneration: number,
    actualGeneration: number,
    actualTreeRevision: string
): Promise<{ filePath: string; checkpointHashes: Set<string> }> {
    const contentDir = path.join(treesDir, 'content');
    const checkpointHashes = new Set<string>();
    const nodes = await Promise.all(tree.nodes.map(async (node) => {
        if (node.storage.kind !== 'checkpoint') {
            return { ...node, parents: [...node.parents], children: [...node.children] };
        }
        const hash = requireValidContentHash(node.storage.contentHash);
        checkpointHashes.add(hash);
        let content: string | undefined;
        try {
            content = manager?.getCheckpointContent(hash);
        } catch {
            // Fall through to the durable content blob.
        }
        if (content === undefined) {
            const buffer = await readFileWithWriteBackupFallback(path.join(contentDir, hash));
            const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
            content = isGzip ? (await gunzip(buffer)).toString('utf8') : buffer.toString('utf8');
        }
        const mainContentPath = path.join(contentDir, hash);
        try {
            await fs.access(mainContentPath);
        } catch {
            await writeFileSafely(mainContentPath, await gzip(Buffer.from(content, 'utf8')));
        }
        return {
            ...node,
            parents: [...node.parents],
            children: [...node.children],
            storage: { kind: 'full' as const, content },
        };
    }));
    const conflictDir = path.join(treesDir, 'conflicts');
    const fileName = `${crypto.createHash('sha1').update(uri).digest('hex')}-${multiWindowSessionId}.json.gz`;
    const filePath = path.join(conflictDir, fileName);
    const payload = JSON.stringify({
        version: 1,
        uri,
        sessionId: multiWindowSessionId,
        savedAt: Date.now(),
        expectedDestructiveGeneration: expectedGeneration,
        actualDestructiveGeneration: actualGeneration,
        actualTreeRevision,
        nextId,
        tree: { ...tree, nodes },
    }, null, 2);
    await writeFileSafely(filePath, await gzip(Buffer.from(payload, 'utf8')));
    return { filePath, checkpointHashes };
}

function findSerializedFullContentByHash(tree: SerializedUndoTree, hash: string): string | undefined {
    for (const node of tree.nodes) {
        if (node.hash === hash && node.storage.kind === 'full') {
            return node.storage.content;
        }
    }
    return undefined;
}

function requireValidContentHash(hash: string): string {
    if (!isValidContentHash(hash)) {
        throw new Error(`Invalid checkpoint content hash: ${hash}`);
    }
    return hash;
}

async function readPersistedContentHashesFromTreeFile(
    treesDir: string,
    fileName: string
): Promise<Set<string>> {
    const treePath = path.join(treesDir, fileName);
    const buf = await readFileWithWriteBackupFallback(treePath);
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
            .map((node) => requireValidContentHash(node.storage.contentHash))
    );
}

async function readFileWithWriteBackupFallback(filePath: string): Promise<Buffer> {
    try {
        return await fs.readFile(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw error;
        }
        // writeFileSafely temporarily renames the previous file while replacing
        // it. Readers do not take the writer lock, so use that verified previous
        // generation instead of treating the tree as absent/fresh.
        try {
            return await fs.readFile(`${filePath}.bak-write`);
        } catch (backupError: unknown) {
            if ((backupError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                throw backupError;
            }
            // The writer may have installed the new primary and removed the
            // backup between our two reads. Retry the primary once.
            return fs.readFile(filePath);
        }
    }
}

async function writeFileSafely(
    filePath: string,
    data: string | Buffer,
    encoding?: BufferEncoding
): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const backupPath = `${filePath}.bak-write`;
    const hasEncoding = typeof data === 'string' && encoding;

    try {
        if (hasEncoding) {
            await fs.writeFile(tempPath, data, encoding);
        } else {
            await fs.writeFile(tempPath, data);
        }

        await fs.rm(backupPath, { force: true }).catch(() => undefined);
        let movedOriginal = false;
        try {
            await fs.rename(filePath, backupPath);
            movedOriginal = true;
        } catch (error: unknown) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code !== 'ENOENT') {
                throw error;
            }
        }

        try {
            await fs.rename(tempPath, filePath);
            if (movedOriginal) {
                await fs.rm(backupPath, { force: true }).catch(() => undefined);
            }
        } catch (error) {
            if (movedOriginal) {
                await fs.rename(backupPath, filePath).catch(() => undefined);
            }
            throw error;
        }
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

function getStorageEpochPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, '.undo-trees.epoch');
}

type StorageEpochRecord = {
    epoch: number;
    state: 'resetting' | 'committed';
};

async function readStorageEpochRecord(context: vscode.ExtensionContext): Promise<StorageEpochRecord> {
    try {
        const raw = (await readFileWithWriteBackupFallback(getStorageEpochPath(context))).toString('utf8');
        const trimmed = raw.trim();
        // Accept the short-lived numeric format written by earlier builds as a
        // committed epoch, then migrate on the next reset.
        if (/^\d+$/.test(trimmed)) {
            return { epoch: Number(trimmed), state: 'committed' };
        }
        const parsed = JSON.parse(trimmed) as Partial<StorageEpochRecord>;
        if (
            !Number.isSafeInteger(parsed.epoch) ||
            (parsed.epoch as number) < 0 ||
            (parsed.state !== 'resetting' && parsed.state !== 'committed')
        ) {
            throw new Error('Invalid Undo Tree storage epoch');
        }
        return { epoch: parsed.epoch as number, state: parsed.state };
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return { epoch: 0, state: 'committed' };
        }
        throw error;
    }
}

async function writeStorageEpochRecord(
    context: vscode.ExtensionContext,
    record: StorageEpochRecord
): Promise<void> {
    await writeFileSafely(getStorageEpochPath(context), JSON.stringify(record), 'utf8');
}

async function recoverStorageEpochUnderLock(context: vscode.ExtensionContext): Promise<number> {
    const record = await readStorageEpochRecord(context);
    if (record.state === 'resetting') {
        await removePersistedState(context);
        await writeStorageEpochRecord(context, { epoch: record.epoch, state: 'committed' });
    }
    return record.epoch;
}

async function ensureWindowStorageEpoch(context: vscode.ExtensionContext): Promise<number> {
    if (windowStorageEpoch === undefined) {
        windowStorageEpochLoad ??= withPersistStorageLock(
            context,
            () => recoverStorageEpochUnderLock(context)
        );
        const load = windowStorageEpochLoad;
        try {
            windowStorageEpoch = await load;
        } finally {
            if (windowStorageEpochLoad === load) {
                windowStorageEpochLoad = undefined;
            }
        }
    }
    return windowStorageEpoch;
}

async function resetStorageUnderLock(context: vscode.ExtensionContext): Promise<number> {
    const nextEpoch = (await recoverStorageEpochUnderLock(context)) + 1;
    await writeStorageEpochRecord(context, { epoch: nextEpoch, state: 'resetting' });
    await removePersistedState(context);
    await writeStorageEpochRecord(context, { epoch: nextEpoch, state: 'committed' });
    return nextEpoch;
}

function rebaseManagerForStorageEpoch(currentEpoch: number): void {
    windowStorageEpoch = currentEpoch;
    windowStorageEpochLoad = undefined;
    documentTaskEpoch++;
    documentLifecycleGenerations.clear();
    knownPersistedTreeRevisions.clear();
    knownPersistedDestructiveGenerations.clear();
    persistedUris.clear();
    destructivePersistGenerations.clear();
    destructivePersistChanges.clear();
    staleDestructiveGenerationWarnedUris.clear();
    if (!manager) {
        return;
    }

    storageEpochRebaseInProgress = true;
    try {
        manager.resetAll();
        manager.paused = false;
        for (const document of vscode.workspace.textDocuments) {
            if (isTracked(document)) {
                manager.getTree(document.uri, document.getText());
            }
        }
    } finally {
        storageEpochRebaseInProgress = false;
    }
}

type PersistLockRecord = {
    owner?: string;
    pid?: number;
    createdAt?: number;
};

type PersistLockSnapshot = {
    raw: string;
    record?: PersistLockRecord;
    stat: Awaited<ReturnType<typeof fs.stat>>;
};

async function readPersistLockSnapshot(filePath: string): Promise<PersistLockSnapshot | undefined> {
    try {
        const [raw, stat] = await Promise.all([
            fs.readFile(filePath, 'utf8'),
            fs.stat(filePath),
        ]);
        let record: PersistLockRecord | undefined;
        try {
            record = JSON.parse(raw) as PersistLockRecord;
        } catch {
            // Invalid records are recoverable only after a grace period.
        }
        return { raw, record, stat };
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

function isPersistLockOwnerAlive(record: PersistLockRecord | undefined): boolean | undefined {
    if (!Number.isSafeInteger(record?.pid) || (record?.pid as number) <= 0) {
        return undefined;
    }
    try {
        process.kill(record!.pid!, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
    }
}

function canRecoverPersistLock(snapshot: PersistLockSnapshot): boolean {
    const ownerAlive = isPersistLockOwnerAlive(snapshot.record);
    // An ownerless/partial record can be the short interval between exclusive
    // creation and writing the claim. Its age cannot prove that the creator is
    // gone (the process or machine may have been suspended), so fail closed.
    // A recorded PID that the OS confirms is gone is the only safe recovery.
    return ownerAlive === false;
}

function isSamePersistLockSnapshot(
    initial: PersistLockSnapshot,
    current: PersistLockSnapshot
): boolean {
    const initialOwner = initial.record?.owner;
    if (typeof initialOwner === 'string' && initialOwner.length > 0) {
        return current.record?.owner === initialOwner;
    }
    // Invalid records have no owner token. Compare both their bytes and stable
    // file identity so a newly-created lock with the same partial bytes is not
    // removed by an older recovery attempt.
    return current.raw === initial.raw &&
        current.stat.size === initial.stat.size &&
        current.stat.birthtimeMs === initial.stat.birthtimeMs &&
        current.stat.ino === initial.stat.ino;
}

async function tryRecoverPersistLock(filePath: string): Promise<boolean> {
    const initial = await readPersistLockSnapshot(filePath);
    if (!initial) {
        return true;
    }
    if (!canRecoverPersistLock(initial)) {
        return false;
    }

    // Re-read immediately before deletion. Another process may have replaced
    // the stale file while we were probing its PID or waiting on I/O.
    const current = await readPersistLockSnapshot(filePath);
    if (!current) {
        return true;
    }
    if (!isSamePersistLockSnapshot(initial, current)) {
        return false;
    }
    try {
        await fs.unlink(filePath);
        return true;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return true;
        }
        throw error;
    }
}

async function releaseOwnedPersistLock(filePath: string, owner: string): Promise<void> {
    try {
        const snapshot = await readPersistLockSnapshot(filePath);
        if (snapshot?.record?.owner === owner) {
            await fs.unlink(filePath).catch(() => undefined);
        }
    } catch {
        // A stale-lock recovery or process shutdown may already have removed it.
    }
}

async function withPersistStorageLock<T>(
    context: vscode.ExtensionContext,
    operation: () => Promise<T>
): Promise<T> {
    const rootDir = context.globalStorageUri.fsPath;
    await fs.mkdir(rootDir, { recursive: true });
    const lockPath = path.join(rootDir, '.undo-trees.persist.lock');
    const recoveryLockPath = `${lockPath}.recovery`;
    const owner = `${multiWindowSessionId}:${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + PERSIST_LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    while (!handle) {
        try {
            handle = await fs.open(lockPath, 'wx');
            try {
                await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: Date.now() }), 'utf8');
            } catch (writeError) {
                await handle.close().catch(() => undefined);
                handle = undefined;
                await fs.unlink(lockPath).catch(() => undefined);
                throw writeError;
            }
        } catch (error: unknown) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code !== 'EEXIST') {
                throw error;
            }
            let recoveryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
            const recoveryOwner = `${owner}:recovery`;
            try {
                recoveryHandle = await fs.open(recoveryLockPath, 'wx');
                try {
                    await recoveryHandle.writeFile(JSON.stringify({
                        owner: recoveryOwner,
                        pid: process.pid,
                        createdAt: Date.now(),
                    }), 'utf8');
                } catch (writeError) {
                    await recoveryHandle.close().catch(() => undefined);
                    recoveryHandle = undefined;
                    await fs.unlink(recoveryLockPath).catch(() => undefined);
                    throw writeError;
                }
            } catch (recoveryError: unknown) {
                if ((recoveryError as NodeJS.ErrnoException)?.code !== 'EEXIST') {
                    throw recoveryError;
                }
                if (await tryRecoverPersistLock(recoveryLockPath)) {
                    continue;
                }
            }
            if (recoveryHandle) {
                let recovered = false;
                try {
                    recovered = await tryRecoverPersistLock(lockPath);
                } finally {
                    await recoveryHandle.close().catch(() => undefined);
                    await releaseOwnedPersistLock(recoveryLockPath, recoveryOwner);
                }
                if (recovered) {
                    continue;
                }
            }
            if (Date.now() >= deadline) {
                throw new Error('Timed out waiting for Undo Tree persistence lock');
            }
            await new Promise((resolve) => setTimeout(resolve, PERSIST_LOCK_RETRY_MS));
        }
    }

    const heartbeat = setInterval(() => {
        void handle?.utimes(new Date(), new Date()).catch(() => undefined);
    }, PERSIST_LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
        return await operation();
    } finally {
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        await releaseOwnedPersistLock(lockPath, owner);
    }
}

async function withPersistStorageEpochLock<T>(
    context: vscode.ExtensionContext,
    operation: () => Promise<T>
): Promise<T> {
    const expectedEpoch = await ensureWindowStorageEpoch(context);
    return withPersistStorageLock(context, async () => {
        const currentEpoch = await recoverStorageEpochUnderLock(context);
        if (currentEpoch !== expectedEpoch) {
            throw new StorageEpochMismatchError(currentEpoch);
        }
        return operation();
    });
}

async function persistStateToDiskUnderLock(
    context: vscode.ExtensionContext,
    state: ReturnType<UndoTreeManager['exportState']>,
    paused: boolean,
    options: PersistOptions = {}
) {
    const dirtyUris = options.dirtyUris;
    const replaceUris = options.replaceUris ?? new Set<string>();
    const destructiveChanges = options.destructiveChanges ?? new Map<string, DestructivePersistChange>();
    const expectedDestructiveGenerations = options.expectedDestructiveGenerations ?? new Map<string, number>();
    const rootDir = context.globalStorageUri.fsPath;
    const treesDir = path.join(rootDir, 'undo-trees');
    const contentDir = path.join(treesDir, 'content');
    await fs.mkdir(contentDir, { recursive: true });

    const compressionThreshold = getCompressionThresholdBytes();
    const checkpointThreshold = getCheckpointThresholdBytes();
    const allEntries = Object.entries(state.trees);
    const referencedContentHashes = new Set<string>();
    const persistedContentHashesByUri = new Map<string, Set<string>>();

    // メモリにないツリーを既存 manifest から保持（上書き保存で消えないようにする）
    const existingManifestResult = await readPersistedManifest(context);
    const existingManifest = existingManifestResult.manifest;
    const hasUnmanifestedTreeFiles = existingManifestResult.status === 'missing' &&
        await hasUnmanifestedPersistedTreeFiles(context);
    if (existingManifestResult.status === 'invalid' || hasUnmanifestedTreeFiles) {
        return {
            rootDir,
            treesDir,
            treeCount: allEntries.length,
            writtenCount: 0,
            persistedUris: Array.from(persistedUris),
            persistedContentHashesByUri: new Map<string, Set<string>>(),
            persistedTreeRevisionsByUri: new Map<string, string>(),
            snapshotCompatibleUris: new Set<string>(),
            persistedDestructiveGenerationsByUri: new Map<string, number>(),
            staleDestructiveGenerationUris: new Set<string>(),
            conflictPersistedPathsByUri: new Map<string, string>(),
            unpersistedUris: new Set(dirtyUris ?? allEntries.map(([uri]) => uri)),
            manifestInvalid: true as const,
        };
    }
    const existingUris = new Set((existingManifest?.trees ?? []).map((entry) => entry.uri));
    const persistedEntries = allEntries.filter(([uri, tree]) =>
        existingUris.has(uri) || tree.nodes.length > 1
    );

    // dirty なエントリのみ書き込む（undefined は persist 対象の全件）
    const writeEntries = dirtyUris
        ? persistedEntries.filter(([uri]) => dirtyUris.has(uri))
        : persistedEntries;

    const inMemoryUris = new Set(allEntries.map(([uri]) => uri));
    const preservedEntries = (existingManifest?.trees ?? []).filter(e => !inMemoryUris.has(e.uri));

    const preparedWriteEntries: Array<[string, NonNullable<ReturnType<UndoTreeManager['exportState']>['trees'][string]>]> = [];
    const skippedDestructiveUris = new Set<string>();
    // nextId is storage-global. Even a request that skips every tree because of
    // a generation conflict must never roll it back below the durable manifest.
    let persistedNextId = Math.max(state.nextId, existingManifest?.nextId ?? 1);
    const unpersistedUris = new Set<string>();
    const persistedTreeRevisionsByUri = new Map<string, string>();
    const snapshotCompatibleUris = new Set<string>();
    const persistedDestructiveGenerationsByUri = new Map<string, number>();
    const staleDestructiveGenerationUris = new Set<string>();
    const conflictPersistedPathsByUri = new Map<string, string>();
    const persistOutcomes: Array<{ uri: string; action: 'written' | 'merged' | 'replaced' | 'preserved-existing'; nodes: number; details?: string }> = [];
    for (const [uri, tree] of writeEntries) {
        let treeToWrite = tree;
        let action: 'written' | 'merged' | 'replaced' | 'preserved-existing' = 'written';
        let details: string | undefined;
        const expectedDestructiveGeneration = expectedDestructiveGenerations.get(uri) ?? 0;
        let destructiveGenerationToWrite = expectedDestructiveGeneration;
        const destructiveChange = destructiveChanges.get(uri);
        if (destructiveChange && !existingUris.has(uri) && destructiveChange.baseRevision !== null) {
            unpersistedUris.add(uri);
            skippedDestructiveUris.add(uri);
            persistOutcomes.push({
                uri,
                action: 'preserved-existing',
                nodes: 0,
                details: `destructive-revision-missing expected=${destructiveChange.baseRevision}`,
            });
            continue;
        }
        if (existingUris.has(uri)) {
            try {
                const existing = await loadPersistedTreeFromDisk(context, vscode.Uri.parse(uri));
                if (!existing?.tree) {
                    unpersistedUris.add(uri);
                    persistOutcomes.push({
                        uri,
                        action: 'preserved-existing',
                        nodes: 0,
                        details: 'validation-failed existing-tree-missing',
                    });
                    continue;
                }
                if (existing?.tree) {
                    const existingRootHash = getSerializedRootHash(existing.tree);
                    const incomingRootHash = getSerializedRootHash(tree);
                    const existingRevision = getSerializedTreeRevision(existing.tree);
                    destructiveGenerationToWrite = existing.destructiveGeneration;
                    if (expectedDestructiveGeneration !== existing.destructiveGeneration) {
                        unpersistedUris.add(uri);
                        staleDestructiveGenerationUris.add(uri);
                        persistedDestructiveGenerationsByUri.set(uri, existing.destructiveGeneration);
                        const conflict = await writeGenerationConflictSnapshot(
                            treesDir,
                            uri,
                            tree,
                            state.nextId,
                            expectedDestructiveGeneration,
                            existing.destructiveGeneration,
                            existingRevision
                        );
                        conflictPersistedPathsByUri.set(uri, conflict.filePath);
                        persistedContentHashesByUri.set(uri, conflict.checkpointHashes);
                        persistOutcomes.push({
                            uri,
                            action: 'preserved-existing',
                            nodes: existing.tree.nodes.length,
                            details: `stale-destructive-generation expected=${expectedDestructiveGeneration} actual=${existing.destructiveGeneration}`,
                        });
                        continue;
                    } else if (destructiveChange && destructiveChange.baseRevision === existingRevision) {
                        treeToWrite = tree;
                        destructiveGenerationToWrite = existing.destructiveGeneration + 1;
                        persistedNextId = Math.max(persistedNextId, existing.nextId);
                        action = 'replaced';
                        details = `existingNodes=${existing.tree.nodes.length} incomingNodes=${tree.nodes.length} revision=${existingRevision}`;
                        persistRootMismatchWarnedUris.delete(uri);
                        manager?.debugLog?.(
                            `[persist-merge] uri=${uri} mode=replace-cas existingNodes=${existing.tree.nodes.length} incomingNodes=${tree.nodes.length} revision=${existingRevision}`
                        );
                    } else if (destructiveChange) {
                        if (existingRootHash && incomingRootHash && existingRootHash === incomingRootHash) {
                            // The resident tree is stale. Abandon only the destructive
                            // deletion and fall back to the normal additive merge so
                            // both windows' branches remain durable and the URI does
                            // not stay permanently dirty/resident.
                            const merged = mergeSerializedTrees(
                                existing.tree,
                                tree,
                                Math.max(existing.nextId, state.nextId)
                            );
                            treeToWrite = merged.tree;
                            persistedNextId = Math.max(persistedNextId, merged.nextId);
                            action = 'merged';
                            details = `destructive-cas-abandoned expected=${destructiveChange.baseRevision ?? 'missing'} actual=${existingRevision}`;
                            manager?.debugLog?.(
                                `[persist-merge] uri=${uri} mode=merge reason=destructive-cas-abandoned expected=${destructiveChange.baseRevision ?? 'missing'} actual=${existingRevision}`
                            );
                            if (!persistRootMismatchWarnedUris.has(uri)) {
                                persistRootMismatchWarnedUris.add(uri);
                                void vscode.window.showWarningMessage(
                                    tr('Undo Tree: compact was not applied because saved history changed in another window. Both histories were merged; reload before compacting again.')
                                );
                            }
                        } else {
                            treeToWrite = existing.tree;
                            unpersistedUris.add(uri);
                            persistedNextId = Math.max(persistedNextId, existing.nextId);
                            action = 'preserved-existing';
                            details = `destructive-root-mismatch existingRoot=${existingRootHash ?? 'missing'} incomingRoot=${incomingRootHash ?? 'missing'}`;
                        }
                    } else if (replaceUris.has(uri)) {
                        treeToWrite = tree;
                        destructiveGenerationToWrite = existing.destructiveGeneration + 1;
                        persistedNextId = Math.max(persistedNextId, existing.nextId);
                        action = 'replaced';
                        details = `existingNodes=${existing.tree.nodes.length} incomingNodes=${tree.nodes.length}`;
                        persistRootMismatchWarnedUris.delete(uri);
                        manager?.debugLog?.(
                            `[persist-merge] uri=${uri} mode=replace existingNodes=${existing.tree.nodes.length} incomingNodes=${tree.nodes.length}`
                        );
                    } else if (existingRootHash && incomingRootHash && existingRootHash === incomingRootHash) {
                        const merged = mergeSerializedTrees(existing.tree, tree, Math.max(existing.nextId, state.nextId));
                        treeToWrite = merged.tree;
                        persistedNextId = Math.max(persistedNextId, merged.nextId);
                        action = 'merged';
                        details = `existingNodes=${existing.tree.nodes.length} incomingNodes=${tree.nodes.length}`;
                        persistRootMismatchWarnedUris.delete(uri);
                        manager?.debugLog?.(
                            `[persist-merge] uri=${uri} mode=merged existingNodes=${existing.tree.nodes.length} incomingNodes=${tree.nodes.length} mergedNodes=${treeToWrite.nodes.length}`
                        );
                    } else {
                        treeToWrite = existing.tree;
                        unpersistedUris.add(uri);
                        persistedNextId = Math.max(persistedNextId, existing.nextId);
                        action = 'preserved-existing';
                        details = `existingRoot=${existingRootHash ?? 'missing'} incomingRoot=${incomingRootHash ?? 'missing'}`;
                        manager?.debugLog?.(
                            `[persist-merge] uri=${uri} mode=preserve-existing reason=root-mismatch existingRoot=${existingRootHash ?? 'missing'} incomingRoot=${incomingRootHash ?? 'missing'}`
                        );
                        if (!persistRootMismatchWarnedUris.has(uri)) {
                            persistRootMismatchWarnedUris.add(uri);
                            void vscode.window.showWarningMessage(
                                tr('Undo Tree: saved history for this file was not overwritten because the in-memory tree does not share the same root. Existing persisted history was kept. See Output for details.')
                            );
                        }
                    }
                }
            } catch (error) {
                manager?.debugLog?.(
                    `[persist-merge] uri=${uri} mode=skip-existing reason=load-failed error=${String(error)}`
                );
                unpersistedUris.add(uri);
                persistOutcomes.push({
                    uri,
                    action: 'preserved-existing',
                    nodes: 0,
                    details: `validation-failed error=${String(error)}`,
                });
                continue;
            }
        }
        if (!existingUris.has(uri) && (destructiveChange || replaceUris.has(uri))) {
            destructiveGenerationToWrite = expectedDestructiveGeneration + 1;
        }
        preparedWriteEntries.push([uri, treeToWrite]);
        persistedDestructiveGenerationsByUri.set(uri, destructiveGenerationToWrite);
        persistOutcomes.push({ uri, action, nodes: treeToWrite.nodes.length, ...(details ? { details } : {}) });
        for (const hash of getPersistedContentHashes(treeToWrite, checkpointThreshold)) {
            referencedContentHashes.add(hash);
        }
    }

    for (const [uri, tree] of preparedWriteEntries) {
        const revision = getSerializedTreeRevision(tree);
        persistedTreeRevisionsByUri.set(uri, revision);
        const incoming = state.trees[uri];
        if (incoming && getSerializedTreeRevision(incoming) === revision && !unpersistedUris.has(uri)) {
            snapshotCompatibleUris.add(uri);
        }
    }

    const manifest: PersistedManifest = {
        version: 1,
        savedAt: Date.now(),
        nextId: persistedNextId,
        paused,
        trees: [
            ...persistedEntries
                .filter(([uri]) => !skippedDestructiveUris.has(uri))
                .map(([uri]) => ({ uri, file: makeTreeFileName(uri) })),
            ...preservedEntries,
        ],
    };

    let canPruneTreeFiles = existingManifestResult.status !== 'backup';
    let canPruneContentFiles = existingManifestResult.status !== 'backup';
    const writtenUris = new Set(preparedWriteEntries.map(([uri]) => uri));
    const diskBackedFinalEntries = manifest.trees.filter((entry) => !writtenUris.has(entry.uri));
    await Promise.all(diskBackedFinalEntries.map(async (entry) => {
        try {
            for (const hash of await readPersistedContentHashesFromTreeFile(treesDir, entry.file)) {
                referencedContentHashes.add(hash);
            }
        } catch {
            canPruneContentFiles = false;
        }
    }));

    await Promise.all(preparedWriteEntries.map(async ([uri, tree]) => {
        const contentHashes = getPersistedContentHashes(tree, checkpointThreshold);
        persistedContentHashesByUri.set(uri, new Set(contentHashes));
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
            await Promise.all(Array.from(contentHashes).map(async (hash) => {
                const filePath = path.join(contentDir, hash);
                try {
                    await fs.access(filePath);
                } catch {
                    const content =
                        findSerializedFullContentByHash(tree, hash) ??
                        manager?.getCheckpointContent(hash);
                    if (content === undefined) {
                        throw new Error(`Missing checkpoint content for hash ${hash}`);
                    }
                    const compressed = await gzip(Buffer.from(content, 'utf8'));
                    await writeFileSafely(filePath, compressed);
                }
            }));
        }

        const json = JSON.stringify({
            uri,
            destructiveGeneration: persistedDestructiveGenerationsByUri.get(uri) ?? 0,
            tree: { ...tree, nodes: serializedNodes },
        }, null, 2);
        const filePath = path.join(treesDir, makeTreeFileName(uri));

        if (useCompression) {
            const compressed = await gzip(Buffer.from(json, 'utf8'));
            await writeFileSafely(filePath, compressed);
        } else {
            await writeFileSafely(filePath, json, 'utf8');
        }
    }));

    const manifestJson = JSON.stringify(manifest, null, 2);
    await writeFileSafely(path.join(treesDir, 'manifest.json'), manifestJson, 'utf8');
    await writeFileSafely(path.join(treesDir, 'manifest.json.bak'), manifestJson, 'utf8');

    // マニフェストにないツリーファイルのみ削除（保存済みツリーは保持）
    if (canPruneTreeFiles) {
        const expectedFiles = new Set(manifest.trees.map((entry) => entry.file));
        expectedFiles.add('manifest.json');
        expectedFiles.add('manifest.json.bak');
        expectedFiles.add('content'); // サブディレクトリは除外しない
        const existingFiles = await fs.readdir(treesDir, { withFileTypes: true });
        await Promise.all(existingFiles
            .filter((entry) => entry.isFile() && !expectedFiles.has(entry.name))
            .map((entry) => fs.unlink(path.join(treesDir, entry.name))));
    }

    // Content blobs are intentionally not pruned during automatic/manual saves.
    // Another window may still hold a checkpoint that was removed from the main
    // tree by compaction. Diagnostics > Prune Orphan Files remains the explicit,
    // coordinated cleanup path once no window needs those recovery blobs.
    void canPruneContentFiles;

    manager?.debugLog?.(
        `[persist] treeCount=${allEntries.length} persistedCount=${persistedEntries.length} writtenCount=${writeEntries.length} paused=${paused}`
    );
    for (const outcome of persistOutcomes) {
        manager?.debugLog?.(
            `[persist-summary] uri=${outcome.uri} action=${outcome.action} nodes=${outcome.nodes}${outcome.details ? ` ${outcome.details}` : ''}`
        );
    }
    for (const [uri, tree] of preparedWriteEntries) {
        manager?.debugLog?.(
            `[persist] uri=${uri} nodes=${tree.nodes.length} currentId=${tree.currentId} rootId=${tree.rootId}`
        );
    }

    return {
        rootDir,
        treesDir,
        treeCount: allEntries.length,
        writtenCount: writeEntries.length,
        persistedUris: manifest.trees.map((entry) => entry.uri),
        persistedContentHashesByUri,
        persistedTreeRevisionsByUri,
        snapshotCompatibleUris,
        persistedDestructiveGenerationsByUri,
        staleDestructiveGenerationUris,
        conflictPersistedPathsByUri,
        unpersistedUris,
    };
}

async function persistStateToDiskNow(
    context: vscode.ExtensionContext,
    state: ReturnType<UndoTreeManager['exportState']>,
    paused: boolean,
    expectedEpoch: number,
    options: PersistOptions = {}
) {
    return withPersistStorageLock(context, async () => {
        const currentEpoch = await recoverStorageEpochUnderLock(context);
        if (currentEpoch !== expectedEpoch) {
            throw new StorageEpochMismatchError(currentEpoch);
        }
        return persistStateToDiskUnderLock(context, state, paused, options);
    });
}

/**
 * Serialize every persisted-state mutation in invocation order. The queue is
 * deliberately kept alive after a failed write so a transient failure cannot
 * prevent later close/deactivate/manual saves from running.
 */
function enqueuePersistOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = persistWriteQueue.then(operation, operation);
    persistWriteQueue = queued.then(() => undefined, () => undefined);
    return queued;
}

async function persistStateToDisk(
    context: vscode.ExtensionContext,
    state: ReturnType<UndoTreeManager['exportState']>,
    paused: boolean,
    dirtyUris?: Set<string>,
    replaceUris?: Set<string>,
    destructiveChanges?: Map<string, DestructivePersistChange>
) {
    const requestEpoch = await ensureWindowStorageEpoch(context);
    const expectedDestructiveGenerations = new Map(
        Object.keys(state.trees).map((uri) => [
            uri,
            knownPersistedDestructiveGenerations.get(uri) ?? 0,
        ])
    );
    const options: PersistOptions = {
        ...(dirtyUris ? { dirtyUris: new Set(dirtyUris) } : {}),
        ...(replaceUris ? { replaceUris: new Set(replaceUris) } : {}),
        ...(destructiveChanges ? {
            destructiveChanges: new Map(Array.from(destructiveChanges, ([uri, change]) => [
                uri,
                { ...change },
            ])),
        } : {}),
        expectedDestructiveGenerations,
    };
    try {
        return await enqueuePersistOperation(() =>
            persistStateToDiskNow(context, state, paused, requestEpoch, options)
        );
    } catch (error) {
        if (!(error instanceof StorageEpochMismatchError)) {
            throw error;
        }
        if (windowStorageEpoch !== error.currentEpoch) {
            rebaseManagerForStorageEpoch(error.currentEpoch);
        }
        return {
            rootDir: context.globalStorageUri.fsPath,
            treesDir: path.join(context.globalStorageUri.fsPath, 'undo-trees'),
            treeCount: Object.keys(state.trees).length,
            writtenCount: 0,
            persistedUris: [] as string[],
            persistedContentHashesByUri: new Map<string, Set<string>>(),
            persistedTreeRevisionsByUri: new Map<string, string>(),
            snapshotCompatibleUris: new Set<string>(),
            persistedDestructiveGenerationsByUri: new Map<string, number>(),
            staleDestructiveGenerationUris: new Set<string>(),
            conflictPersistedPathsByUri: new Map<string, string>(),
            unpersistedUris: new Set(Object.keys(state.trees)),
            skippedForStorageEpoch: true as const,
        };
    }
}

function syncPersistedUris(uris: Iterable<string>): void {
    persistedUris.clear();
    for (const uri of uris) {
        persistedUris.add(uri);
    }
}

async function readPersistedManifest(
    context: vscode.ExtensionContext
): Promise<ManifestReadResult> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    const readOne = async (fileName: string): Promise<ManifestReadResult['manifest'] | undefined> => {
        const manifestPath = path.join(treesDir, fileName);
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
    };

    try {
        const primary = await readOne('manifest.json');
        if (primary) {
            return { status: 'ok', manifest: primary };
        }
        const backup = await readOne('manifest.json.bak');
        if (backup) {
            return { status: 'backup', manifest: backup };
        }
        return { status: 'missing' };
    } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === 'ENOENT') {
            const backup = await readOne('manifest.json.bak');
            if (backup) {
                return { status: 'backup', manifest: backup };
            }
            return { status: 'missing' };
        }
        try {
            const backup = await readOne('manifest.json.bak');
            if (backup) {
                return { status: 'backup', manifest: backup };
            }
        } catch {
            // Ignore backup parse/read errors and treat the manifest as invalid.
        }
        return { status: 'invalid' };
    }
}

async function loadPersistedTreeFromDisk(
    context: vscode.ExtensionContext,
    uri: vscode.Uri
): Promise<{
    nextId: number;
    destructiveGeneration: number;
    tree: NonNullable<ReturnType<UndoTreeManager['exportState']>['trees'][string]>;
} | undefined> {
    const manifestResult = await readPersistedManifest(context);
    const manifest = manifestResult.manifest;
    if (!manifest) {
        return undefined;
    }

    const entry = manifest.trees.find((treeEntry) => treeEntry.uri === uri.toString());
    if (!entry) {
        return undefined;
    }

    const treePath = path.join(context.globalStorageUri.fsPath, 'undo-trees', entry.file);
    try {
        const buf = await readFileWithWriteBackupFallback(treePath);
        // gzipマジックバイトで自動判別
        const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
        const raw = isGzip ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
        const parsed = JSON.parse(raw) as {
            tree?: ReturnType<UndoTreeManager['exportState']>['trees'][string];
            destructiveGeneration?: number;
        };
        if (!parsed.tree) {
            return undefined;
        }

        manager?.debugLog?.(
            `[load] uri=${uri.toString()} file=${entry.file} nodes=${parsed.tree.nodes.length} currentId=${parsed.tree.currentId} rootId=${parsed.tree.rootId}`
        );

        return {
            nextId: manifest.nextId,
            destructiveGeneration: Number.isSafeInteger(parsed.destructiveGeneration) &&
                (parsed.destructiveGeneration as number) >= 0
                ? parsed.destructiveGeneration as number
                : 0,
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

async function ensureTreeLoadedOnce(
    context: vscode.ExtensionContext,
    treeManager: UndoTreeManager,
    document: vscode.TextDocument,
    expectedTaskEpoch: number
) {
    if (!treeManager.hasTree(document.uri)) {
        let persisted;
        try {
            persisted = await loadPersistedTreeFromDisk(context, document.uri);
        } catch (error) {
            knownPersistedTreeRevisions.delete(document.uri.toString());
            knownPersistedDestructiveGenerations.delete(document.uri.toString());
            treeManager.debugLog?.(
                `[ensureTreeLoaded] uri=${document.uri.toString()} source=persisted-load-failed error=${String(error)}`
            );
            void vscode.window.showWarningMessage(
                tr('Undo Tree: saved history could not be read. A new tree was not created to avoid overwriting recoverable data.')
            );
            return;
        }
        if (persisted) {
            if (
                expectedTaskEpoch !== documentTaskEpoch ||
                resetInProgress ||
                storageEpochRebaseInProgress ||
                manager !== treeManager
            ) {
                return;
            }
            const beforeSyncNodeCount = persisted.tree.nodes.length;
            try {
                treeManager.importTree(document.uri.toString(), persisted.tree, persisted.nextId);
                const syncedTree = treeManager.syncDocumentState(document.uri, document.getText());
                knownPersistedTreeRevisions.set(
                    document.uri.toString(),
                    getSerializedTreeRevision(persisted.tree)
                );
                knownPersistedDestructiveGenerations.set(
                    document.uri.toString(),
                    persisted.destructiveGeneration
                );
                treeManager.debugLog?.(
                    `[ensureTreeLoaded] uri=${document.uri.toString()} source=persisted beforeNodes=${beforeSyncNodeCount} afterNodes=${syncedTree.nodes.size} currentId=${syncedTree.currentId}`
                );
                return;
            } catch (error) {
                knownPersistedTreeRevisions.delete(document.uri.toString());
                knownPersistedDestructiveGenerations.delete(document.uri.toString());
                treeManager.debugLog?.(
                    `[ensureTreeLoaded] uri=${document.uri.toString()} source=persisted-import-failed error=${String(error)}`
                );
            }
        }
        knownPersistedTreeRevisions.delete(document.uri.toString());
        knownPersistedDestructiveGenerations.delete(document.uri.toString());
    }

    if (
        expectedTaskEpoch !== documentTaskEpoch ||
        resetInProgress ||
        storageEpochRebaseInProgress ||
        manager !== treeManager
    ) {
        return;
    }

    const syncedTree = treeManager.syncDocumentState(document.uri, document.getText());
    treeManager.debugLog?.(
        `[ensureTreeLoaded] uri=${document.uri.toString()} source=fresh beforeNodes=${treeManager.hasTree(document.uri) ? syncedTree.nodes.size : 0} afterNodes=${syncedTree.nodes.size} currentId=${syncedTree.currentId}`
    );
}

async function ensureTreeLoaded(
    context: vscode.ExtensionContext,
    treeManager: UndoTreeManager,
    document: vscode.TextDocument
): Promise<void> {
    const key = document.uri.toString();
    const pending = treeLoadPromises.get(key);
    if (pending) {
        await pending;
        return;
    }

    const expectedTaskEpoch = documentTaskEpoch;
    const load = ensureTreeLoadedOnce(context, treeManager, document, expectedTaskEpoch);
    treeLoadPromises.set(key, load);
    try {
        await load;
    } finally {
        if (treeLoadPromises.get(key) === load) {
            treeLoadPromises.delete(key);
        }
    }
}

function bumpDocumentLifecycle(uri: vscode.Uri): number {
    const key = uri.toString();
    const generation = (documentLifecycleGenerations.get(key) ?? 0) + 1;
    documentLifecycleGenerations.set(key, generation);
    return generation;
}

function enqueueDocumentTask(uri: vscode.Uri, operation: () => Promise<void>): Promise<void> {
    const key = uri.toString();
    const taskEpoch = documentTaskEpoch;
    const previous = documentTaskQueues.get(key) ?? Promise.resolve();
    const runIfCurrent = async () => {
        if (resetInProgress || taskEpoch !== documentTaskEpoch) {
            return;
        }
        await operation();
    };
    const queued = previous.then(runIfCurrent, runIfCurrent);
    const settled = queued.catch((error) => {
        manager?.debugLog?.(`[document-task] uri=${key} failed: ${String(error)}`);
    });
    documentTaskQueues.set(key, settled);
    void settled.finally(() => {
        if (documentTaskQueues.get(key) === settled) {
            documentTaskQueues.delete(key);
        }
    });
    return settled;
}

async function drainDocumentTasks(): Promise<void> {
    // Re-read the maps after each pass. Tasks already running when reset starts
    // are allowed to settle; newly queued tasks carry a stale/reset epoch and
    // become no-ops, but still need to leave the queue cleanly.
    while (documentTaskQueues.size > 0 || treeLoadPromises.size > 0) {
        await Promise.all([
            ...Array.from(documentTaskQueues.values()),
            ...Array.from(treeLoadPromises.values()),
        ]);
    }
}

function canUnloadTreeAfterFlush(
    treeManager: UndoTreeManager,
    currentManager: UndoTreeManager | undefined,
    uri: vscode.Uri,
    closeGeneration: number,
    currentLifecycleGeneration: number | undefined
): boolean {
    return currentManager === treeManager &&
        currentLifecycleGeneration === closeGeneration &&
        !treeManager.getDirtyUris().has(uri.toString());
}

async function restoreTreeForDocument(
    context: vscode.ExtensionContext,
    treeManager: UndoTreeManager,
    document: vscode.TextDocument
): Promise<boolean> {
    const expectedTaskEpoch = documentTaskEpoch;
    const persisted = await loadPersistedTreeFromDisk(context, document.uri);
    if (!persisted) {
        return false;
    }
    if (
        expectedTaskEpoch !== documentTaskEpoch ||
        resetInProgress ||
        storageEpochRebaseInProgress ||
        manager !== treeManager
    ) {
        return false;
    }

    const beforeSyncNodeCount = persisted.tree.nodes.length;
    try {
        treeManager.importTree(document.uri.toString(), persisted.tree, persisted.nextId);
        treeManager.clearDirty([document.uri.toString()]);
        destructivePersistGenerations.delete(document.uri.toString());
        destructivePersistChanges.delete(document.uri.toString());
        staleDestructiveGenerationWarnedUris.delete(document.uri.toString());
        const syncedTree = treeManager.syncDocumentState(document.uri, document.getText());
        knownPersistedTreeRevisions.set(
            document.uri.toString(),
            getSerializedTreeRevision(persisted.tree)
        );
        knownPersistedDestructiveGenerations.set(
            document.uri.toString(),
            persisted.destructiveGeneration
        );
        treeManager.debugLog?.(
            `[restore] uri=${document.uri.toString()} beforeNodes=${beforeSyncNodeCount} afterNodes=${syncedTree.nodes.size} currentId=${syncedTree.currentId}`
        );
        return true;
    } catch (error) {
        knownPersistedTreeRevisions.delete(document.uri.toString());
        knownPersistedDestructiveGenerations.delete(document.uri.toString());
        treeManager.debugLog?.(
            `[restore] uri=${document.uri.toString()} source=persisted-import-failed error=${String(error)}`
        );
        void vscode.window.showWarningMessage(
            tr('Undo Tree: saved history for this file could not be restored. A new tree will be created from the current document.')
        );
        return false;
    }
}

async function removePersistedState(context: vscode.ExtensionContext) {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.rm(treesDir, { recursive: true, force: true });
}

async function migratePersistedTreeForRename(
    context: vscode.ExtensionContext,
    oldUri: vscode.Uri,
    newUri: vscode.Uri
): Promise<boolean> {
    const oldUriStr = oldUri.toString();
    const newUriStr = newUri.toString();
    if (oldUriStr === newUriStr) {
        return false;
    }

    const manifestResult = await readPersistedManifest(context);
    const manifest = manifestResult.manifest;
    if (!manifest) {
        return false;
    }

    const entry = manifest.trees.find((treeEntry) => treeEntry.uri === oldUriStr);
    if (!entry) {
        return false;
    }

    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.mkdir(treesDir, { recursive: true });

    const oldFile = entry.file;
    const newFile = makeTreeFileName(newUriStr);
    const oldPath = path.join(treesDir, oldFile);
    const newPath = path.join(treesDir, newFile);

    if (oldFile !== newFile) {
        try {
            await fs.access(oldPath);
            const buffer = await fs.readFile(oldPath);
            await writeFileSafely(newPath, buffer);
            await fs.rm(oldPath, { force: true });
        } catch {
            // persisted file migration is best-effort; manifest is still updated below
        }
    }

    entry.uri = newUriStr;
    entry.file = newFile;
    const rawManifest = JSON.stringify(
        {
            version: 1,
            savedAt: Date.now(),
            nextId: manifest.nextId,
            paused: manifest.paused,
            trees: manifest.trees,
        } satisfies PersistedManifest,
        null,
        2
    );
    await writeFileSafely(path.join(treesDir, 'manifest.json'), rawManifest, 'utf8');
    await writeFileSafely(path.join(treesDir, 'manifest.json.bak'), rawManifest, 'utf8');
    syncPersistedUris(manifest.trees.map((treeEntry) => treeEntry.uri));
    return true;
}

async function openStorageFolder(context: vscode.ExtensionContext): Promise<void> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.mkdir(treesDir, { recursive: true });
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(treesDir));
}

function getMultiWindowLocksDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'undo-trees', 'locks');
}

function makeMultiWindowLockPath(context: vscode.ExtensionContext, uri: string): string {
    const fileName = `${crypto.createHash('sha1').update(uri).digest('hex')}.json`;
    return path.join(getMultiWindowLocksDir(context), fileName);
}

async function readMultiWindowLock(context: vscode.ExtensionContext, uri: string): Promise<MultiWindowLockRecord | undefined> {
    try {
        const raw = await fs.readFile(makeMultiWindowLockPath(context, uri), 'utf8');
        const parsed = JSON.parse(raw) as Partial<MultiWindowLockRecord>;
        if (typeof parsed.sessionId !== 'string' || typeof parsed.uri !== 'string' || typeof parsed.updatedAt !== 'number') {
            return undefined;
        }
        return {
            sessionId: parsed.sessionId,
            uri: parsed.uri,
            updatedAt: parsed.updatedAt,
            workspace: typeof parsed.workspace === 'string' ? parsed.workspace : '',
        };
    } catch {
        return undefined;
    }
}

async function writeMultiWindowLock(
    context: vscode.ExtensionContext,
    uri: string,
    outputChannel: vscode.OutputChannel
): Promise<boolean> {
    try {
        const locksDir = getMultiWindowLocksDir(context);
        await fs.mkdir(locksDir, { recursive: true });
        const record: MultiWindowLockRecord = {
            sessionId: multiWindowSessionId,
            uri,
            updatedAt: Date.now(),
            workspace: vscode.workspace.name ?? '',
        };
        await fs.writeFile(makeMultiWindowLockPath(context, uri), JSON.stringify(record, null, 2), 'utf8');
        return true;
    } catch (error) {
        outputChannel.appendLine(`[multi-window-lock] failed to write lock for ${uri}: ${String(error)}`);
        if (!multiWindowLockWriteWarningShown) {
            multiWindowLockWriteWarningShown = true;
            void vscode.window.showWarningMessage(
                tr('Undo Tree could not acquire a multi-window lock. Concurrent auto persistence may overwrite another window.')
            );
        }
        return false;
    }
}

async function releaseMultiWindowLock(context: vscode.ExtensionContext, uri: string): Promise<void> {
    const lock = await readMultiWindowLock(context, uri);
    if (lock?.sessionId !== multiWindowSessionId) {
        return;
    }
    await fs.unlink(makeMultiWindowLockPath(context, uri)).catch(() => {});
}

async function acquireMultiWindowLock(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    if (getPersistenceMode() !== 'auto' || !getWarnOnMultiWindowConflict()) {
        return;
    }
    const uri = document.uri.toString();
    const existing = await readMultiWindowLock(context, uri);
    const now = Date.now();
    const lockIsLive = !!existing
        && existing.sessionId !== multiWindowSessionId
        && now - existing.updatedAt <= MULTI_WINDOW_LOCK_TTL_MS;

    if (lockIsLive && !multiWindowWarnedUris.has(uri)) {
        multiWindowWarnedUris.add(uri);
        outputChannel.appendLine(`[multi-window-lock] detected live lock for ${uri} by session ${existing.sessionId}`);
        void vscode.window.showWarningMessage(
            tr('Undo Tree detected that this file is active in another VS Code window. Concurrent auto persistence may overwrite persisted history.')
        );
    }

    const written = await writeMultiWindowLock(context, uri, outputChannel);
    if (written) {
        multiWindowLockUris.add(uri);
    }
}

function getDesiredMultiWindowLockUris(): Set<string> {
    return new Set(
        vscode.workspace.textDocuments
            .filter((document) => !document.isUntitled && document.uri.scheme === 'file' && isTracked(document))
            .map((document) => document.uri.toString())
    );
}

async function refreshMultiWindowLocks(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<void> {
    if (getPersistenceMode() !== 'auto' || !getWarnOnMultiWindowConflict()) {
        return;
    }

    const desiredUris = getDesiredMultiWindowLockUris();

    for (const uri of Array.from(multiWindowLockUris)) {
        if (!desiredUris.has(uri)) {
            await releaseMultiWindowLock(context, uri);
            multiWindowLockUris.delete(uri);
        }
    }

    for (const uri of Array.from(desiredUris)) {
        const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri);
        if (!document) {
            continue;
        }
        await acquireMultiWindowLock(context, document, outputChannel);
    }
}

async function releaseAllMultiWindowLocks(context: vscode.ExtensionContext): Promise<void> {
    for (const uri of Array.from(multiWindowLockUris)) {
        await releaseMultiWindowLock(context, uri);
    }
    multiWindowLockUris.clear();
    multiWindowWarnedUris.clear();
}

function getIdleUnloadCandidateUris(activeEditor: vscode.TextEditor | undefined): vscode.Uri[] {
    if (!manager || getPersistenceMode() !== 'auto') {
        return [];
    }
    const treeManager = manager;
    const activeUri = activeEditor?.document.uri.toString();
    const dirtyUris = treeManager.getDirtyUris();
    const now = Date.now();
    return treeManager.getResidentUris()
        .filter((uri) =>
            persistedUris.has(uri) &&
            uri !== activeUri &&
            !dirtyUris.has(uri)
        )
        .map((uri) => vscode.Uri.parse(uri))
        .filter((uri) => !treeManager.hasPendingDiffs(uri))
        .filter((uri) => {
            const lastAccessAt = treeManager.getLastAccessAt(uri);
            return typeof lastAccessAt === 'number' && now - lastAccessAt >= IDLE_TREE_UNLOAD_MS;
        });
}

function unloadIdleResidentTrees(activeEditor: vscode.TextEditor | undefined): void {
    if (!manager) {
        return;
    }
    const treeManager = manager;
    const now = Date.now();
    for (const uri of getIdleUnloadCandidateUris(activeEditor)) {
        const lastAccessAt = treeManager.getLastAccessAt(uri);
        const idleMs = typeof lastAccessAt === 'number' ? now - lastAccessAt : IDLE_TREE_UNLOAD_MS;
        treeManager.debugLog?.(`[idle-unload] uri=${uri.toString()} idleMs=${idleMs} persisted=true dirty=false pendingDiff=false`);
        treeManager.unloadTree(uri);
    }
}

async function simulateManifestBackupFallback(
    context: vscode.ExtensionContext,
    paused: boolean
): Promise<void> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.mkdir(treesDir, { recursive: true });
    const manifestPath = path.join(treesDir, 'manifest.json');
    const backupPath = path.join(treesDir, 'manifest.json.bak');
    const current = await readPersistedManifest(context);
    const fallbackManifest: PersistedManifest = current.manifest
        ? {
            version: 1,
            savedAt: Date.now(),
            nextId: current.manifest.nextId,
            paused: current.manifest.paused,
            trees: current.manifest.trees,
        }
        : {
            version: 1,
            savedAt: Date.now(),
            nextId: manager?.exportState().nextId ?? 1,
            paused,
            trees: [],
        };
    const raw = JSON.stringify(fallbackManifest, null, 2);
    await writeFileSafely(backupPath, raw, 'utf8');
    await writeFileSafely(manifestPath, '{', 'utf8');
}

async function simulateManifestInvalid(context: vscode.ExtensionContext): Promise<void> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.mkdir(treesDir, { recursive: true });
    await Promise.all([
        writeFileSafely(path.join(treesDir, 'manifest.json'), '{', 'utf8'),
        writeFileSafely(path.join(treesDir, 'manifest.json.bak'), '{', 'utf8'),
    ]);
}

async function pruneOrphanPersistedFiles(context: vscode.ExtensionContext): Promise<{
    treeFiles: number;
    contentFiles: number;
    contentSkippedForLiveWindow: boolean;
}> {
    const snapshot = await collectDiagnosticsSnapshot(context);
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    const contentDir = path.join(treesDir, 'content');

    // The lock file is URI-scoped (not session-scoped), so a heartbeat from this
    // window can overwrite another live owner's record. Treat any live lock,
    // including an apparently owned one, as a reason to leave content blobs.
    const hasLiveWindow = snapshot.locks.items.some((item) => item.isLive);
    await Promise.all(snapshot.orphanTreeFiles.map((fileName) => fs.unlink(path.join(treesDir, fileName)).catch(() => {})));
    if (!hasLiveWindow) {
        await Promise.all(snapshot.orphanContentFiles.map((fileName) => fs.unlink(path.join(contentDir, fileName)).catch(() => {})));
    }

    return {
        treeFiles: snapshot.orphanTreeFiles.length,
        contentFiles: hasLiveWindow ? 0 : snapshot.orphanContentFiles.length,
        contentSkippedForLiveWindow: hasLiveWindow,
    };
}

async function rebuildPersistedManifestFromTreeFiles(
    context: vscode.ExtensionContext,
    paused: boolean
): Promise<{ rebuilt: number }> {
    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    await fs.mkdir(treesDir, { recursive: true });
    const entries = await fs.readdir(treesDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
    const treeFiles = entries
        .filter((entry) => entry.isFile() && entry.name !== 'manifest.json' && entry.name !== 'manifest.json.bak')
        .map((entry) => entry.name)
        .sort();

    const trees: PersistedManifest['trees'] = [];
    let nextId = 1;

    for (const fileName of treeFiles) {
        const treePath = path.join(treesDir, fileName);
        try {
            const buf = await readFileWithWriteBackupFallback(treePath);
            const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
            const raw = isGzip ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
            const parsed = JSON.parse(raw) as {
                uri?: string;
                tree?: {
                    nodes?: Array<{ id?: number }>;
                };
            };
            if (typeof parsed.uri !== 'string') {
                continue;
            }
            trees.push({ uri: parsed.uri, file: fileName });
            const nodeMax = Array.isArray(parsed.tree?.nodes)
                ? parsed.tree!.nodes.reduce((max, node) => Math.max(max, typeof node.id === 'number' ? node.id : 0), 0)
                : 0;
            nextId = Math.max(nextId, nodeMax + 1);
        } catch {
            // Skip unreadable tree files; validation view will still report them.
        }
    }

    const manifest: PersistedManifest = {
        version: 1,
        savedAt: Date.now(),
        nextId,
        paused,
        trees,
    };
    const raw = JSON.stringify(manifest, null, 2);
    await writeFileSafely(path.join(treesDir, 'manifest.json'), raw, 'utf8');
    await writeFileSafely(path.join(treesDir, 'manifest.json.bak'), raw, 'utf8');

    return { rebuilt: trees.length };
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

function getWarnOnMultiWindowConflict(): boolean {
    return vscode.workspace
        .getConfiguration('undotree')
        .get<boolean>('warnOnMultiWindowConflict', true);
}

function getEnableDiagnostics(): boolean {
    return vscode.workspace
        .getConfiguration('undotree')
        .get<boolean>('enableDiagnostics', false);
}

function getCompressionThresholdBytes(): number {
    const kb = vscode.workspace.getConfiguration('undotree').get<number>('compressionThresholdKB');
    return (typeof kb === 'number' && kb >= 0 ? kb : 100) * 1024;
}

function getCheckpointThresholdBytes(): number {
    const kb = vscode.workspace.getConfiguration('undotree').get<number>('checkpointThresholdKB');
    return (typeof kb === 'number' && kb >= 0 ? kb : 1000) * 1024;
}

function getMemoryCheckpointThresholdBytes(): number {
    const kb = vscode.workspace.getConfiguration('undotree').get<number>('memoryCheckpointThresholdKB');
    return (typeof kb === 'number' && kb >= 0 ? kb : 32) * 1024;
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

type PersistRequestSnapshot = {
    manager: UndoTreeManager;
    state: ReturnType<UndoTreeManager['exportState']>;
    dirtyUris: Set<string>;
    dirtyGenerations: Map<string, number>;
    replaceGenerations: Map<string, number>;
    destructiveChanges: Map<string, DestructivePersistChange>;
};

function markDestructivePersist(uri: vscode.Uri, change: DestructivePersistChange): void {
    const key = uri.toString();
    destructivePersistGenerations.set(key, (destructivePersistGenerations.get(key) ?? 0) + 1);
    destructivePersistChanges.set(key, { ...change });
}

async function captureDestructiveBaseRevision(
    _context: vscode.ExtensionContext,
    uri: vscode.Uri
): Promise<string | null> {
    // Wait for this window's writes, then use only a revision known to match the
    // resident tree. Reading disk here would incorrectly bless another window's
    // new branch while this window still holds stale memory.
    await persistWriteQueue;
    await Promise.resolve();
    return knownPersistedTreeRevisions.get(uri.toString()) ?? null;
}

function capturePersistRequest(
    treeManager: UndoTreeManager,
    dirtyUris = treeManager.getDirtyUris()
): PersistRequestSnapshot {
    const state = treeManager.exportState();
    const dirtyGenerations = treeManager.getDirtyGenerations(dirtyUris);
    const replaceGenerations = new Map<string, number>();
    const destructiveChanges = new Map<string, DestructivePersistChange>();
    for (const uri of dirtyUris) {
        const generation = destructivePersistGenerations.get(uri);
        if (generation !== undefined) {
            replaceGenerations.set(uri, generation);
        }
        const change = destructivePersistChanges.get(uri);
        if (change) {
            destructiveChanges.set(uri, { ...change });
        }
    }
    return {
        manager: treeManager,
        state,
        dirtyUris: new Set(dirtyUris),
        dirtyGenerations,
        replaceGenerations,
        destructiveChanges,
    };
}

function captureFullPersistRequest(treeManager: UndoTreeManager): PersistRequestSnapshot {
    const request = capturePersistRequest(treeManager);
    for (const [uri, generation] of destructivePersistGenerations) {
        if (request.state.trees[uri]) {
            request.replaceGenerations.set(uri, generation);
            const change = destructivePersistChanges.get(uri);
            if (change) {
                request.destructiveChanges.set(uri, { ...change });
            }
        }
    }
    return request;
}

function finishPersistRequest(
    request: PersistRequestSnapshot,
    persistedContentHashesByUri: ReadonlyMap<string, ReadonlySet<string>>,
    persistedTreeRevisionsByUri: ReadonlyMap<string, string>,
    snapshotCompatibleUris: ReadonlySet<string>,
    persistedDestructiveGenerationsByUri: ReadonlyMap<string, number>,
    conflictPersistedPathsByUri: ReadonlyMap<string, string>,
    unpersistedUris: ReadonlySet<string>
): void {
    // A save can take long enough for another node/note to be created for the
    // same URI. Clear only the exact mutation generation that reached disk.
    if (!resetInProgress && manager === request.manager) {
        for (const [uri, hashes] of persistedContentHashesByUri) {
            if (!unpersistedUris.has(uri) || conflictPersistedPathsByUri.has(uri)) {
                request.manager.markCheckpointPersistedForUri(uri, hashes);
            }
        }
        for (const [uri, revision] of persistedTreeRevisionsByUri) {
            if (snapshotCompatibleUris.has(uri)) {
                knownPersistedTreeRevisions.set(uri, revision);
            } else {
                knownPersistedTreeRevisions.delete(uri);
            }
        }
        for (const uri of unpersistedUris) {
            knownPersistedTreeRevisions.delete(uri);
        }
        for (const [uri, generation] of persistedDestructiveGenerationsByUri) {
            if (!unpersistedUris.has(uri)) {
                knownPersistedDestructiveGenerations.set(uri, generation);
            }
        }
        for (const [uri, generation] of request.dirtyGenerations) {
            if (!unpersistedUris.has(uri) || conflictPersistedPathsByUri.has(uri)) {
                request.manager.clearDirtyIfGeneration(uri, generation);
            }
        }
        for (const [uri, generation] of request.replaceGenerations) {
            if (
                (!unpersistedUris.has(uri) || conflictPersistedPathsByUri.has(uri)) &&
                destructivePersistGenerations.get(uri) === generation
            ) {
                destructivePersistGenerations.delete(uri);
                destructivePersistChanges.delete(uri);
            }
        }
    }
}

async function rebaseStaleDestructiveGenerationUris(
    context: vscode.ExtensionContext,
    request: PersistRequestSnapshot,
    staleUris: ReadonlySet<string>,
    _persistedGenerations: ReadonlyMap<string, number>,
    conflictPaths: ReadonlyMap<string, string>
): Promise<void> {
    if (manager !== request.manager) {
        return;
    }
    for (const uri of staleUris) {
        if (!staleDestructiveGenerationWarnedUris.has(uri)) {
            staleDestructiveGenerationWarnedUris.add(uri);
            const conflictPath = conflictPaths.get(uri) ?? path.join(
                context.globalStorageUri.fsPath,
                'undo-trees',
                'conflicts'
            );
            const openStorageLabel = tr('Open Storage Folder');
            void Promise.resolve(vscode.window.showWarningMessage(
                tr('Undo Tree: saved history was compacted in another window. The saved history was left unchanged, and a full recovery snapshot was saved to {0}. It is not restored automatically.', conflictPath),
                openStorageLabel
            )).then(async (picked) => {
                if (picked === openStorageLabel) {
                    await openStorageFolder(context);
                }
            });
        }
    }
}

function schedulePersistState(context: vscode.ExtensionContext) {
    if (resetInProgress || storageEpochRebaseInProgress || !manager || getPersistenceMode() !== 'auto') {
        return;
    }

    if (persistTimer) {
        clearTimeout(persistTimer);
    }

    persistTimer = setTimeout(() => {
        persistTimer = undefined;
        const treeManager = manager;
        if (!treeManager) {
            return;
        }
        const request = capturePersistRequest(treeManager);
        void persistStateToDisk(
            context,
            request.state,
            treeManager.paused,
            request.dirtyUris,
            new Set(request.replaceGenerations.keys()),
            request.destructiveChanges
        )
            .then(async (result) => {
                syncPersistedUris(result.persistedUris);
                finishPersistRequest(
                    request,
                    result.persistedContentHashesByUri,
                    result.persistedTreeRevisionsByUri,
                    result.snapshotCompatibleUris,
                    result.persistedDestructiveGenerationsByUri,
                    result.conflictPersistedPathsByUri,
                    result.unpersistedUris
                );
                await rebaseStaleDestructiveGenerationUris(
                    context,
                    request,
                    result.staleDestructiveGenerationUris,
                    result.persistedDestructiveGenerationsByUri,
                    result.conflictPersistedPathsByUri
                );
                if ('manifestInvalid' in result) {
                    manager?.debugLog?.('[persist] auto save blocked because persisted manifest metadata is missing or unreadable');
                    if (!autoPersistWarningShown) {
                        autoPersistWarningShown = true;
                        const openStorageLabel = tr('Open Storage Folder');
                        const openDiagnosticsLabel = tr('Open Diagnostics');
                        void vscode.window.showWarningMessage(
                            tr('Undo Tree: automatic history persistence is blocked because the storage manifest is missing or unreadable while history files remain. Existing files were left untouched.'),
                            openStorageLabel,
                            openDiagnosticsLabel
                        ).then(async (picked) => {
                            if (picked === openStorageLabel) {
                                await openStorageFolder(context);
                            } else if (picked === openDiagnosticsLabel) {
                                await vscode.commands.executeCommand('undotree.openDiagnostics');
                            }
                        });
                    }
                    return;
                }
                autoPersistFailureCount = 0;
                autoPersistWarningShown = false;
            })
            .catch((error) => {
                autoPersistFailureCount++;
                manager?.debugLog?.(`[persist] auto save failed for ${request.dirtyUris.size} dirty URI(s): ${String(error)}`);
                if (autoPersistFailureCount >= 3 && !autoPersistWarningShown) {
                    autoPersistWarningShown = true;
                    void vscode.window.showWarningMessage(
                        tr('Undo Tree: automatic history persistence has failed repeatedly. See Output for details.')
                    );
                }
            })
            .finally(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
}

async function flushPersistState(context: vscode.ExtensionContext) {
    if (resetInProgress || !manager || getPersistenceMode() !== 'auto') {
        return;
    }

    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
    }

    const request = capturePersistRequest(manager);
    const result = await persistStateToDisk(
        context,
        request.state,
        manager.paused,
        request.dirtyUris,
        new Set(request.replaceGenerations.keys()),
        request.destructiveChanges
    );
    syncPersistedUris(result.persistedUris);
    finishPersistRequest(
        request,
        result.persistedContentHashesByUri,
        result.persistedTreeRevisionsByUri,
        result.snapshotCompatibleUris,
        result.persistedDestructiveGenerationsByUri,
        result.conflictPersistedPathsByUri,
        result.unpersistedUris
    );
    await rebaseStaleDestructiveGenerationUris(
        context,
        request,
        result.staleDestructiveGenerationUris,
        result.persistedDestructiveGenerationsByUri,
        result.conflictPersistedPathsByUri
    );
}

async function flushPersistedUri(context: vscode.ExtensionContext, uri: vscode.Uri, force = false): Promise<boolean> {
    if (resetInProgress || !manager || (!force && getPersistenceMode() !== 'auto')) {
        return false;
    }

    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
    }

    const key = uri.toString();
    const dirtyUris = manager.getDirtyUris();
    let didPersist = !dirtyUris.has(key);
    if (dirtyUris.has(key)) {
        const request = capturePersistRequest(manager, new Set([key]));
        const result = await persistStateToDisk(
            context,
            request.state,
            manager.paused,
            request.dirtyUris,
            new Set(request.replaceGenerations.keys()),
            request.destructiveChanges
        );
        syncPersistedUris(result.persistedUris);
        finishPersistRequest(
            request,
            result.persistedContentHashesByUri,
            result.persistedTreeRevisionsByUri,
            result.snapshotCompatibleUris,
            result.persistedDestructiveGenerationsByUri,
            result.conflictPersistedPathsByUri,
            result.unpersistedUris
        );
        await rebaseStaleDestructiveGenerationUris(
            context,
            request,
            result.staleDestructiveGenerationUris,
            result.persistedDestructiveGenerationsByUri,
            result.conflictPersistedPathsByUri
        );
        didPersist = !result.unpersistedUris.has(key);
    }
    if (manager.getDirtyUris().size > 0) {
        schedulePersistState(context);
    }
    return didPersist;
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
        statusBarItem.text = tr('$(debug-pause) Undo Tree: PAUSED');
        statusBarItem.tooltip = tr('Undo Tree is paused. Click to resume.');
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
        ? tr('$(history) Undo Tree: ON')
        : tr('$(circle-slash) Undo Tree: OFF');
    statusBarItem.tooltip = [
        excluded
            ? tr('Excluded by pattern. Click to edit exclude patterns.')
            : tracked
            ? tr('Tracking {0}. Click to disable.', ext)
            : tr('Not tracking {0}. Click to enable.', ext),
        tr('Enabled: {0}', enabled.join(', ') || '(none)'),
    ].filter(Boolean).join('\n');
    statusBarItem.command = excluded
        ? {
            command: 'workbench.action.openSettings',
            title: tr('Open Exclude Settings'),
            arguments: [getSettingSearchQuery('undotree.excludePatterns')],
        }
        : 'undotree.toggleTracking';
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
        // A preview action must never silently switch to whatever editor became
        // active after the preview was opened. If its target was closed, require
        // the user to reopen/refresh the preview instead of compacting another file.
        return undefined;
    }
    return getTrackedContextEditor(editor);
}

function getDiffKeyBase(uri: vscode.Uri): string {
    return `diff-${crypto.createHash('sha1').update(uri.toString()).digest('hex')}`;
}

async function resolveTrackedDocumentContext(sourceUri?: string): Promise<{ document: vscode.TextDocument; viewColumn?: vscode.ViewColumn } | undefined> {
    if (sourceUri) {
        const visible = vscode.window.visibleTextEditors.find((candidate) =>
            candidate.document.uri.toString() === sourceUri &&
            !candidate.document.isUntitled &&
            candidate.document.uri.scheme === 'file' &&
            isTracked(candidate.document)
        );
        if (visible) {
            return { document: visible.document, viewColumn: visible.viewColumn };
        }
        const openDocument = vscode.workspace.textDocuments.find((candidate) =>
            candidate.uri.toString() === sourceUri &&
            !candidate.isUntitled &&
            candidate.uri.scheme === 'file' &&
            isTracked(candidate)
        );
        if (openDocument) {
            return { document: openDocument, viewColumn: vscode.window.activeTextEditor?.viewColumn };
        }
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));
            if (!document.isUntitled && document.uri.scheme === 'file' && isTracked(document)) {
                return { document, viewColumn: vscode.window.activeTextEditor?.viewColumn };
            }
        } catch {
            // Fall back to the current tracked context below.
        }
    }

    const fallbackEditor = getTrackedContextEditor(vscode.window.activeTextEditor);
    if (!fallbackEditor || !isTracked(fallbackEditor.document)) {
        return undefined;
    }
    return { document: fallbackEditor.document, viewColumn: fallbackEditor.viewColumn };
}

export async function activate(context: vscode.ExtensionContext) {
    initializeRuntimeL10n(context);
    windowStorageEpoch = await withPersistStorageLock(
        context,
        () => recoverStorageEpochUnderLock(context)
    );
    windowStorageEpochLoad = undefined;
    documentTaskEpoch++;
    resetInProgress = false;
    destructivePersistGenerations.clear();
    destructivePersistChanges.clear();
    knownPersistedTreeRevisions.clear();
    knownPersistedDestructiveGenerations.clear();
    documentLifecycleGenerations.clear();
    documentTaskQueues.clear();
    treeLoadPromises.clear();
    manager = new UndoTreeManager();
    const provider = new UndoTreeProvider(context, manager);
    const contentProvider = new UndoTreeDocumentContentProvider();
    const persistedManifest = await readPersistedManifest(context);
    let compactPreviewMode: 'compact' | 'hard' = 'compact';
    let compactPreviewTab: 'removable' | 'protected' | 'all' = 'all';

    const outputChannel = vscode.window.createOutputChannel('Undo Tree');
    context.subscriptions.push(outputChannel);
    manager.debugLog = (msg) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    await updateDiagnosticsContext(context);
    syncPersistedUris(persistedManifest.manifest?.trees.map((entry) => entry.uri) ?? []);
    if (multiWindowLockTimer) {
        clearInterval(multiWindowLockTimer);
    }
    multiWindowLockTimer = setInterval(() => {
        void refreshMultiWindowLocks(context, outputChannel);
        unloadIdleResidentTrees(vscode.window.activeTextEditor);
    }, MULTI_WINDOW_LOCK_HEARTBEAT_MS);

    manager.paused = persistedManifest.manifest?.paused === true;
    manager.setAutosaveInterval(getAutosaveIntervalMs());
    manager.setContentCacheMax(getContentCacheMaxBytes());
    manager.setMemoryCheckpointThreshold(getMemoryCheckpointThresholdBytes());

    const treesDir = path.join(context.globalStorageUri.fsPath, 'undo-trees');
    manager.contentResolver = (hash) => {
        const contentPath = path.join(treesDir, 'content', requireValidContentHash(hash));
        try {
            return readCheckpointContentBuffer(contentPath).toString('utf8');
        } catch (error) {
            throw new Error(`Failed to load checkpoint content ${hash}: ${String(error)}`);
        }
    };
    manager.asyncContentResolver = async (hash) => {
        const contentPath = path.join(treesDir, 'content', requireValidContentHash(hash));
        try {
            const buf = await fs.readFile(contentPath);
            const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
            return isGzip ? (await gunzip(buf)).toString('utf8') : buf.toString('utf8');
        } catch (error) {
            throw new Error(`Failed to load checkpoint content ${hash}: ${String(error)}`);
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
        provider.rememberDocument(ed.document);
        provider.setActiveEditor(ed);
        try {
            await ensureTreeLoaded(context, manager, ed.document);
            await acquireMultiWindowLock(context, ed.document, outputChannel);
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
            compactPreviewPanel.webview.html = buildWebviewMessageHtml(
                tr('Undo Tree preview is only available for tracked text files.')
            );
            return;
        }
        await ensureTreeLoaded(context, manager, editor.document).catch(() => {});
        const tree = manager.getTree(editor.document.uri, editor.document.getText());
        const days = getHardCompactAfterDays();
        const result = compactPreviewMode === 'hard'
            ? manager.previewHardCompactDetailed(tree, days)
            : manager.previewCompactDetailed(tree);
        compactPreviewPanel.title = compactPreviewMode === 'hard'
            ? tr('Undo Tree Hard Compact Preview')
            : tr('Undo Tree Compact Preview');
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
                tr('Undo Tree Compact Preview'),
                vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            compactPreviewPanel.onDidDispose(() => {
                compactPreviewPanel = undefined;
                compactPreviewTargetUri = undefined;
            });
            compactPreviewPanel.webview.onDidReceiveMessage(async (message) => {
                try {
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
                            await vscode.commands.executeCommand('workbench.action.openSettings', getSettingSearchQuery('undotree.hardCompactAfterDays'));
                            return;
                        default:
                            return;
                        }
                    await renderCompactPreviewPanel();
                } catch (error) {
                    outputChannel.appendLine(`[compact-preview] command failed: ${String(error)}`);
                    void vscode.window.showErrorMessage(tr('Undo Tree: compact preview action failed. See Output for details.'));
                }
            });
        } else {
            compactPreviewPanel.reveal(undefined, true);
        }
        await renderCompactPreviewPanel();
    };

    const renderDiagnosticsPanel = async () => {
        if (!diagnosticsPanel) {
            return;
        }
        const snapshot = await collectDiagnosticsSnapshot(context);
        diagnosticsPanel.webview.html = buildDiagnosticsHtml(snapshot);
    };

    const showDiagnosticsPanel = async () => {
        if (!getDiagnosticsEnabled(context)) {
            vscode.window.showInformationMessage(tr('Undo Tree diagnostics are disabled. Enable undotree.enableDiagnostics to use this panel.'));
            return;
        }
        if (!diagnosticsPanel) {
            diagnosticsPanel = vscode.window.createWebviewPanel(
                'undotreeDiagnostics',
                tr('Undo Tree Diagnostics'),
                vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            diagnosticsPanel.onDidDispose(() => {
                diagnosticsPanel = undefined;
            });
            diagnosticsPanel.webview.onDidReceiveMessage(async (message) => {
                try {
                    switch (message.command) {
                        case 'refresh':
                        case 'validate':
                            break;
                        case 'pruneOrphans': {
                            const result = await enqueuePersistOperation(() =>
                                withPersistStorageEpochLock(context, () => pruneOrphanPersistedFiles(context))
                            );
                            vscode.window.showInformationMessage(
                                tr('Undo Tree: pruned {0} orphan tree file(s) and {1} orphan content file(s).', result.treeFiles, result.contentFiles)
                            );
                            if (result.contentSkippedForLiveWindow) {
                                vscode.window.showWarningMessage(
                                    tr('Undo Tree: orphan content blobs were not pruned because another window is actively using persisted history.')
                                );
                            }
                            break;
                        }
                        case 'rebuildManifest': {
                            const result = await enqueuePersistOperation(() =>
                                withPersistStorageEpochLock(
                                    context,
                                    () => rebuildPersistedManifestFromTreeFiles(context, manager?.paused === true)
                                )
                            );
                            syncPersistedUris((await readPersistedManifest(context)).manifest?.trees.map((entry) => entry.uri) ?? []);
                            vscode.window.showInformationMessage(
                                tr('Undo Tree: rebuilt manifest from {0} persisted tree file(s).', result.rebuilt)
                            );
                            break;
                        }
                        case 'openStorage':
                            await openStorageFolder(context);
                            break;
                        case 'showOutput':
                            outputChannel.show(true);
                            break;
                        case 'simulateBackup':
                            await enqueuePersistOperation(() =>
                                withPersistStorageEpochLock(
                                    context,
                                    () => simulateManifestBackupFallback(context, manager?.paused === true)
                                )
                            );
                            await notifyManifestReadStatus(context, 'backup', outputChannel);
                            break;
                        case 'simulateInvalid':
                            await enqueuePersistOperation(() =>
                                withPersistStorageEpochLock(context, () => simulateManifestInvalid(context))
                            );
                            await notifyManifestReadStatus(context, 'invalid', outputChannel);
                            break;
                        case 'resetAll':
                            await vscode.commands.executeCommand('undotree.resetAllState');
                            break;
                        default:
                            return;
                    }
                    await renderDiagnosticsPanel();
                } catch (error) {
                    outputChannel.appendLine(`[diagnostics] command failed: ${String(error)}`);
                    void vscode.window.showErrorMessage(tr('Undo Tree: diagnostics action failed. See Output for details.'));
                }
            });
        } else {
            diagnosticsPanel.reveal(undefined, true);
        }
        await renderDiagnosticsPanel();
    };

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    updateStatusBar(vscode.window.activeTextEditor);

    context.subscriptions.push(
        new vscode.Disposable(() => {
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = undefined;
            }
            if (multiWindowLockTimer) {
                clearInterval(multiWindowLockTimer);
                multiWindowLockTimer = undefined;
            }
            void releaseAllMultiWindowLocks(context);
        }),

        statusBarItem,

        vscode.workspace.registerTextDocumentContentProvider('undotree', contentProvider),

        vscode.window.registerWebviewViewProvider('undotree.treeView', provider),

        vscode.commands.registerCommand('undotree.show', () => {
            provider.captureWindowContext();
            provider.refresh();
            vscode.commands.executeCommand('undotree.treeView.focus');
            setTimeout(() => {
                provider.captureWindowContext();
                provider.refresh();
            }, 75);
            setTimeout(() => {
                provider.captureWindowContext();
                provider.refresh();
            }, 250);
        }),

        vscode.commands.registerCommand('undotree.undo', () => {
            manager?.undo();
        }),

        vscode.commands.registerCommand('undotree.redo', () => {
            manager?.redo();
        }),

        vscode.commands.registerCommand('undotree.savePersistedState', async () => {
            if (resetInProgress || !manager) {
                return;
            }
            const request = captureFullPersistRequest(manager);
            const result = await persistStateToDisk(
                context,
                request.state,
                manager.paused,
                undefined,
                new Set(request.replaceGenerations.keys()),
                request.destructiveChanges
            );
            syncPersistedUris(result.persistedUris);
            finishPersistRequest(
                request,
                result.persistedContentHashesByUri,
                result.persistedTreeRevisionsByUri,
                result.snapshotCompatibleUris,
                result.persistedDestructiveGenerationsByUri,
                result.conflictPersistedPathsByUri,
                result.unpersistedUris
            );
            await rebaseStaleDestructiveGenerationUris(
                context,
                request,
                result.staleDestructiveGenerationUris,
                result.persistedDestructiveGenerationsByUri,
                result.conflictPersistedPathsByUri
            );
            if ('skippedForStorageEpoch' in result) {
                vscode.window.showWarningMessage(
                    tr('Undo Tree: persisted history was reset in another window. Stale history was discarded and open documents were rebased.')
                );
                return;
            }
            if ('manifestInvalid' in result) {
                vscode.window.showWarningMessage(
                    tr('Undo Tree: persisted history was not saved because its manifest is missing or unreadable while history files remain. Existing files were left untouched.')
                );
                return;
            }
            vscode.window.showInformationMessage(
                tr('Undo Tree: saved {0} tree(s) to {1}', result.treeCount, result.treesDir)
            );
        }),

        vscode.commands.registerCommand('undotree.openDiagnostics', async () => {
            await showDiagnosticsPanel();
        }),

        vscode.commands.registerCommand('undotree.resetAllState', async () => {
            if (resetInProgress || !manager) {
                return;
            }
            const treeManager = manager;

            const resetLabel = tr('Reset');
            const confirmed = await vscode.window.showWarningMessage(
                tr(
                    'Undo Tree: delete all in-memory and persisted history for this workspace? This only resets Undo Tree history and does not roll back the current file contents. This cannot be undone.'
                ),
                { modal: true },
                resetLabel
            );
            if (confirmed !== resetLabel) {
                return;
            }

            resetInProgress = true;
            documentTaskEpoch++;
            try {
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
                if (diagnosticsPanel) {
                    diagnosticsPanel.dispose();
                    diagnosticsPanel = undefined;
                }

                // Let tasks that were already running settle. Queued old tasks
                // and tasks arriving during reset are invalidated by the epoch.
                await drainDocumentTasks();

                treeManager.resetAll();
                treeManager.paused = false;
                destructivePersistGenerations.clear();
                destructivePersistChanges.clear();
                staleDestructiveGenerationWarnedUris.clear();
                knownPersistedTreeRevisions.clear();
                knownPersistedDestructiveGenerations.clear();
                pendingRenameOldUris.clear();
                documentLifecycleGenerations.clear();

                await releaseAllMultiWindowLocks(context);
                multiWindowWarnedUris.clear();
                // Removal is queued behind every persistence operation that
                // started before reset, making deletion the final disk mutation.
                await enqueuePersistOperation(() =>
                    withPersistStorageLock(context, async () => {
                        windowStorageEpoch = await resetStorageUnderLock(context);
                        windowStorageEpochLoad = undefined;
                    })
                );
                syncPersistedUris([]);

                // Drop any no-op events received while deletion was in flight,
                // then rebuild memory exclusively from documents that are open
                // now. No pre-reset disk tree can survive this boundary.
                await drainDocumentTasks();
                treeManager.resetAll();
                treeManager.paused = false;
                knownPersistedTreeRevisions.clear();
                knownPersistedDestructiveGenerations.clear();
                documentLifecycleGenerations.clear();
                pendingRenameOldUris.clear();
                for (const document of vscode.workspace.textDocuments) {
                    if (isTracked(document)) {
                        provider.rememberDocument(document);
                        treeManager.getTree(document.uri, document.getText());
                    }
                }
            } finally {
                // Invalidate tasks queued during reset even if disk deletion
                // failed, then reopen the gate for fresh post-reset events.
                documentTaskEpoch++;
                resetInProgress = false;
            }

            provider.refresh();
            updateStatusBar(vscode.window.activeTextEditor);
            vscode.window.showInformationMessage(tr('Undo Tree: all history has been reset.'));
        }),

        vscode.commands.registerCommand('undotree.restorePersistedState', async () => {
            const editor = vscode.window.activeTextEditor;
            if (resetInProgress || !editor || !manager) {
                return;
            }
            if (!isTracked(editor.document)) {
                vscode.window.showWarningMessage(tr('Undo Tree: current file is not tracked.'));
                return;
            }

            const restored = await restoreTreeForDocument(context, manager, editor.document);
            if (!restored) {
                vscode.window.showInformationMessage(tr('Undo Tree: no persisted state found for the current file.'));
                return;
            }

            provider.refresh();
            vscode.window.showInformationMessage(tr('Undo Tree: restored persisted state for the current file.'));
        }),

        vscode.commands.registerCommand('undotree.showMenu', async () => {
            const editor = vscode.window.activeTextEditor;
            const isCurrentTracked = !!editor && isTracked(editor.document);
            const items: Array<{
                label: string;
                description?: string;
                command?: string;
                settingId?: string;
            }> = [
                {
                    label: tr('$(gear) Open Settings'),
                    description: tr('Open Undo Tree extension settings'),
                    command: 'workbench.action.openSettings',
                },
                {
                    label: tr('$(save) Save Persisted State'),
                    description: tr('Write tracked histories to extension storage'),
                    command: 'undotree.savePersistedState',
                },
                {
                    label: tr('$(trash) Reset Undo Tree State'),
                    description: tr('Delete all in-memory and persisted Undo Tree history for this workspace'),
                    command: 'undotree.resetAllState',
                },
                {
                    label: getPersistenceMode() === 'auto'
                        ? tr('$(sync-ignored) Auto Persist: On')
                        : tr('$(sync) Auto Persist: Off'),
                    description: tr('Open settings to change persistent save mode'),
                    command: 'workbench.action.openSettings',
                    settingId: 'undotree.persistenceMode',
                },
                {
                    label: tr('$(history) Restore Persisted State'),
                    description: tr('Reload saved history for the current file'),
                    command: isCurrentTracked ? 'undotree.restorePersistedState' : undefined,
                },
                {
                    label: tr('$(archive) Compact History'),
                    description: tr('Remove compressible intermediate nodes'),
                    command: isCurrentTracked ? 'undotree.compact' : undefined,
                },
                {
                    label: tr('$(eye) Compact History Preview'),
                    description: tr('Open the compact preview with removable and protected nodes'),
                    command: isCurrentTracked ? 'undotree.compactDryRun' : undefined,
                },
                {
                    label: tr('$(eye) Hard Compact Preview'),
                    description: tr('Open the hard compact preview with retention details'),
                    command: isCurrentTracked ? 'undotree.hardCompactDryRun' : undefined,
                },
                {
                    label: manager?.paused
                        ? tr('$(debug-start) Resume Tracking')
                        : tr('$(debug-pause) Pause Tracking'),
                    description: tr('Temporarily disable or resume history capture'),
                    command: 'undotree.togglePause',
                },
                {
                    label: tr('$(symbol-file) Toggle Tracking for This Extension'),
                    description: tr('Enable or disable tracking for the current file extension'),
                    command: editor ? 'undotree.toggleTracking' : undefined,
                },
                {
                    label: tr('$(tools) Open Diagnostics'),
                    description: tr('Inspect persisted storage, manifest state, and orphan files'),
                    command: getDiagnosticsEnabled(context) ? 'undotree.openDiagnostics' : undefined,
                },
            ];

            const picked = await vscode.window.showQuickPick(
                items.filter((item) => item.command),
                {
                    title: tr('Undo Tree'),
                    placeHolder: tr('Choose an action'),
                }
            );
            if (!picked?.command) {
                return;
            }

            if (picked.command === 'workbench.action.openSettings') {
                const query = picked.settingId
                    ? getSettingSearchQuery(picked.settingId)
                    : getSettingSearchQuery();
                await vscode.commands.executeCommand(picked.command, query);
                return;
            }

            await vscode.commands.executeCommand(picked.command);
        }),

        vscode.commands.registerCommand('undotree.toggleTracking', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isUntitled) {
                return;
            }
            if (isExcluded(editor.document)) {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    getSettingSearchQuery('undotree.excludePatterns')
                );
                return;
            }
            const ext = path.extname(editor.document.fileName).toLowerCase();
            if (!ext) {
                vscode.window.showWarningMessage(tr('Cannot determine file extension.'));
                return;
            }
            const config = vscode.workspace.getConfiguration('undotree', editor.document.uri);
            const current = config.get<string[]>('enabledExtensions', ['.txt', '.md']);
            const idx = current.map((e) => e.toLowerCase()).indexOf(ext);
            let updated: string[];
            if (idx === -1) {
                updated = [...current, ext];
                vscode.window.showInformationMessage(tr('Undo Tree: enabled for {0}', ext));
            } else {
                updated = current.filter((_, i) => i !== idx);
                vscode.window.showInformationMessage(tr('Undo Tree: disabled for {0}', ext));
            }
            const inspected = config.inspect?.<string[]>('enabledExtensions');
            const target = inspected?.workspaceFolderValue !== undefined
                ? vscode.ConfigurationTarget.WorkspaceFolder
                : inspected?.workspaceValue !== undefined
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;
            await config.update('enabledExtensions', updated, target);
            updateStatusBar(editor);
        }),

        vscode.commands.registerCommand('undotree.diffWithNode', async (targetNodeId: number, sourceUri?: string) => {
            if (!manager) {
                return;
            }
            const contextDocument = await resolveTrackedDocumentContext(sourceUri);
            if (!contextDocument) {
                return;
            }
            const tree = manager.getTree(contextDocument.document.uri);
            const ext = path.extname(contextDocument.document.fileName) || '.txt';
            const diffKeyBase = getDiffKeyBase(contextDocument.document.uri);

            const targetContent = manager.reconstructContent(tree, targetNodeId);
            const currentContent = contextDocument.document.getText();

            const targetUri = contentProvider.prepare(targetContent, ext, `${diffKeyBase}-target`);
            const currentUri = contentProvider.prepare(currentContent, ext, `${diffKeyBase}-current`);

            await vscode.commands.executeCommand(
                'vscode.diff',
                targetUri,
                currentUri,
                tr('Undo Tree Diff: {0}', path.basename(contextDocument.document.fileName)),
                {
                    preview: true,
                    preserveFocus: false,
                    viewColumn: contextDocument.viewColumn ?? vscode.ViewColumn.Active,
                }
            );
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        }),

        vscode.commands.registerCommand('undotree.diffBetweenNodes', async (leftNodeId: number, rightNodeId: number, sourceUri?: string) => {
            if (!manager || leftNodeId === rightNodeId) {
                return;
            }
            const contextDocument = await resolveTrackedDocumentContext(sourceUri);
            if (!contextDocument) {
                return;
            }
            const tree = manager.getTree(contextDocument.document.uri);
            const ext = path.extname(contextDocument.document.fileName) || '.txt';
            const diffKeyBase = getDiffKeyBase(contextDocument.document.uri);
            const leftContent = manager.reconstructContent(tree, leftNodeId);
            const rightContent = manager.reconstructContent(tree, rightNodeId);
            const leftUri = contentProvider.prepare(leftContent, ext, `${diffKeyBase}-left`);
            const rightUri = contentProvider.prepare(rightContent, ext, `${diffKeyBase}-right`);

            await vscode.commands.executeCommand(
                'vscode.diff',
                leftUri,
                rightUri,
                tr('Undo Tree Diff: {0}', path.basename(contextDocument.document.fileName)),
                {
                    preview: true,
                    preserveFocus: false,
                    viewColumn: contextDocument.viewColumn ?? vscode.ViewColumn.Active,
                }
            );
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        }),

        vscode.commands.registerCommand('undotree.compact', async () => {
            const editor = getCompactPreviewContextEditor(vscode.window.activeTextEditor);
            if (resetInProgress || !editor || !manager) {
                return;
            }
            const baseRevision = await captureDestructiveBaseRevision(context, editor.document.uri);
            const tree = manager.getTree(editor.document.uri);
            const { removed, skipped } = compactPreviewOverrides.size > 0
                ? manager.compactWithOverrides(tree, compactPreviewOverrides)
                : { removed: manager.compact(tree), skipped: 0 };
            if (removed > 0) {
                markDestructivePersist(editor.document.uri, { baseRevision });
            }
            compactPreviewOverrides.clear();
            provider.refresh();
            if (removed > 0) {
                try {
                    await flushPersistedUri(
                        context,
                        editor.document.uri,
                        persistedUris.has(editor.document.uri.toString())
                    );
                } catch {
                    vscode.window.showWarningMessage(tr('Undo Tree: compact succeeded, but persisted state could not be updated.'));
                }
            }
            vscode.window.showInformationMessage(
                skipped > 0
                    ? tr('Undo Tree: compacted {0} node(s), skipped {1} marked node(s)', removed, skipped)
                    : tr('Undo Tree: compacted {0} node(s)', removed)
            );
        }),

        vscode.commands.registerCommand('undotree.compactDryRun', () => {
            const editor = getCompactPreviewContextEditor(vscode.window.activeTextEditor);
            if (resetInProgress || !editor || !manager) {
                return;
            }
            void showCompactPreviewPanel('compact');
        }),

        vscode.commands.registerCommand('undotree.hardCompact', async () => {
            const editor = getCompactPreviewContextEditor(vscode.window.activeTextEditor);
            if (resetInProgress || !editor || !manager) {
                return;
            }
            const days = getHardCompactAfterDays();
            if (days <= 0) {
                vscode.window.showWarningMessage(
                    tr('Undo Tree: set undotree.hardCompactAfterDays (≥ 1) to use this command')
                );
                return;
            }
            const deleteLabel = tr('Delete');
            const confirm = await vscode.window.showWarningMessage(
                tr('Undo Tree: delete nodes older than {0} day(s)? This cannot be undone.', days),
                { modal: true },
                deleteLabel
            );
            if (confirm !== deleteLabel) {
                return;
            }
            const baseRevision = await captureDestructiveBaseRevision(context, editor.document.uri);
            const tree = manager.getTree(editor.document.uri);
            const { removed, skipped } = compactPreviewOverrides.size > 0
                ? manager.hardCompactWithOverrides(tree, days, compactPreviewOverrides)
                : { removed: manager.hardCompact(tree, days), skipped: 0 };
            if (removed > 0) {
                markDestructivePersist(editor.document.uri, { baseRevision });
            }
            compactPreviewOverrides.clear();
            provider.refresh();
            if (removed > 0) {
                try {
                    await flushPersistedUri(
                        context,
                        editor.document.uri,
                        persistedUris.has(editor.document.uri.toString())
                    );
                } catch {
                    vscode.window.showWarningMessage(tr('Undo Tree: hard compact succeeded, but persisted state could not be updated.'));
                }
            }
            vscode.window.showInformationMessage(
                skipped > 0
                    ? tr('Undo Tree: hard compacted {0} node(s) older than {1} day(s), skipped {2} marked node(s)', removed, days, skipped)
                    : tr('Undo Tree: hard compacted {0} node(s) older than {1} day(s)', removed, days)
            );
        }),

        vscode.commands.registerCommand('undotree.hardCompactDryRun', () => {
            const editor = getTrackedContextEditor(vscode.window.activeTextEditor);
            if (resetInProgress || !editor || !manager) {
                return;
            }
            void showCompactPreviewPanel('hard');
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
                manager.paused ? tr('Undo Tree: paused') : tr('Undo Tree: resumed')
            );
        }),

        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!resetInProgress && isTracked(e.document)) {
                manager?.onDidChangeTextDocument(e);
            }
        }),

        vscode.workspace.onDidSaveTextDocument((doc) => {
            const treeManager = manager;
            const saveTaskEpoch = documentTaskEpoch;
            if (!resetInProgress && isTracked(doc) && treeManager) {
                void enqueueDocumentTask(doc.uri, async () => {
                    if (manager !== treeManager) {
                        return;
                    }
                    // Save All can include background documents whose persisted
                    // tree has not been lazily loaded yet. Load first so saving
                    // cannot replace it with a fresh one-node tree.
                    await ensureTreeLoaded(context, treeManager, doc);
                    if (manager === treeManager && saveTaskEpoch === documentTaskEpoch) {
                        treeManager.onDidSaveTextDocument(doc);
                    }
                });
            }
        }),

        vscode.workspace.onWillRenameFiles((event) => {
            if (resetInProgress) {
                return;
            }
            for (const file of event.files) {
                pendingRenameOldUris.add(file.oldUri.toString());
                manager?.debugLog?.(`[willRenameFiles] old=${file.oldUri.toString()} new=${file.newUri.toString()}`);
            }
        }),

        vscode.workspace.onDidCloseTextDocument((doc) => {
            const treeManager = manager;
            const closeGeneration = bumpDocumentLifecycle(doc.uri);
            treeManager?.debugLog?.(`[closeTextDocument] uri=${doc.uri.toString()} tracked=${isTracked(doc)} hasTree=${treeManager.hasTree(doc.uri)}`);
            contentProvider.releaseByPrefix(getDiffKeyBase(doc.uri));
            multiWindowLockUris.delete(doc.uri.toString());
            multiWindowWarnedUris.delete(doc.uri.toString());
            void releaseMultiWindowLock(context, doc.uri.toString());
            void enqueueDocumentTask(doc.uri, async () => {
                if (!treeManager || manager !== treeManager) {
                    return;
                }
                treeManager.onDidCloseTextDocument(doc);
                if (!isTracked(doc)) {
                    return;
                }
                if (pendingRenameOldUris.has(doc.uri.toString())) {
                    treeManager.debugLog?.(`[closeTextDocument] skip-unload pendingRename uri=${doc.uri.toString()}`);
                    return;
                }
                if (getPersistenceMode() !== 'auto' || !treeManager.hasTree(doc.uri)) {
                    return;
                }
                try {
                    await flushPersistedUri(context, doc.uri);
                    if (canUnloadTreeAfterFlush(
                        treeManager,
                        manager,
                        doc.uri,
                        closeGeneration,
                        documentLifecycleGenerations.get(doc.uri.toString())
                    )) {
                        treeManager.unloadTree(doc.uri);
                    } else if (treeManager.getDirtyUris().has(doc.uri.toString())) {
                        treeManager.debugLog?.(
                            `[closeTextDocument] keep-resident uri=${doc.uri.toString()} reason=dirty-after-flush`
                        );
                    }
                } catch {
                    // Keep the in-memory tree if persisting fails.
                }
            });
        }),

        vscode.workspace.onDidOpenTextDocument((doc) => {
            const treeManager = manager;
            const openTaskEpoch = documentTaskEpoch;
            const openGeneration = bumpDocumentLifecycle(doc.uri);
            treeManager?.debugLog?.(`[openTextDocument] uri=${doc.uri.toString()} tracked=${isTracked(doc)} hasTree=${treeManager.hasTree(doc.uri)}`);
            if (resetInProgress) {
                return;
            }
            void enqueueDocumentTask(doc.uri, async () => {
                if (
                    isTracked(doc) &&
                    treeManager &&
                    manager === treeManager &&
                    documentLifecycleGenerations.get(doc.uri.toString()) === openGeneration
                ) {
                    provider.rememberDocument(doc);
                    await ensureTreeLoaded(context, treeManager, doc);
                    if (openTaskEpoch !== documentTaskEpoch || manager !== treeManager) {
                        return;
                    }
                    await acquireMultiWindowLock(context, doc, outputChannel);
                    provider.captureWindowContext();
                    provider.refresh();
                }
            });
        }),

        vscode.window.onDidChangeActiveTextEditor((e) => {
            manager?.debugLog?.(`[activeEditor] changed to ${describeEditor(e)}`);
            provider.setActiveEditor(e);
            manager?.onDidChangeActiveEditor(e);
            updateStatusBar(e);
            if (compactPreviewPanel) {
                void renderCompactPreviewPanel();
            }
            if (resetInProgress) {
                provider.refresh();
                return;
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
                e.affectsConfiguration('undotree.warnOnMultiWindowConflict') ||
                e.affectsConfiguration('undotree.language') ||
                e.affectsConfiguration('undotree.autosaveInterval') ||
                e.affectsConfiguration('undotree.timeFormat') ||
                e.affectsConfiguration('undotree.timeFormatCustom') ||
                e.affectsConfiguration('undotree.showStorageKind') ||
                e.affectsConfiguration('undotree.nodeSizeMetric') ||
                e.affectsConfiguration('undotree.nodeSizeMetricBase') ||
                e.affectsConfiguration('undotree.hardCompactAfterDays') ||
                e.affectsConfiguration('undotree.colorTheme') ||
                e.affectsConfiguration('undotree.enableDiagnostics') ||
                e.affectsConfiguration('undotree.compressionThresholdKB') ||
                e.affectsConfiguration('undotree.checkpointThresholdKB') ||
                e.affectsConfiguration('undotree.memoryCheckpointThresholdKB') ||
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
                if (e.affectsConfiguration('undotree.memoryCheckpointThresholdKB')) {
                    manager?.setMemoryCheckpointThreshold(getMemoryCheckpointThresholdBytes());
                }
                if (e.affectsConfiguration('undotree.enableDiagnostics')) {
                    void updateDiagnosticsContext(context);
                }
                if (e.affectsConfiguration('undotree.hardCompactAfterDays') && compactPreviewPanel) {
                    void renderCompactPreviewPanel();
                }
                if (
                    e.affectsConfiguration('undotree.language') ||
                    e.affectsConfiguration('undotree.colorTheme')
                ) {
                    provider.resetShell();
                }
                if (e.affectsConfiguration('undotree.persistenceMode') || e.affectsConfiguration('undotree.warnOnMultiWindowConflict')) {
                    if (getPersistenceMode() !== 'auto' || !getWarnOnMultiWindowConflict()) {
                        void releaseAllMultiWindowLocks(context);
                    } else {
                        for (const doc of vscode.workspace.textDocuments) {
                            if (isTracked(doc)) {
                                void acquireMultiWindowLock(context, doc, outputChannel);
                            }
                        }
                    }
                }
                unloadIdleResidentTrees(vscode.window.activeTextEditor);
                updateStatusBar(vscode.window.activeTextEditor);
                if (
                    !e.affectsConfiguration('undotree.language') &&
                    !e.affectsConfiguration('undotree.colorTheme')
                ) {
                    provider.refresh();
                }
                if (diagnosticsPanel) {
                    void renderDiagnosticsPanel();
                }
            }
        }),

        vscode.workspace.onDidRenameFiles((event) => {
            if (resetInProgress) {
                for (const file of event.files) {
                    pendingRenameOldUris.delete(file.oldUri.toString());
                }
                return;
            }
            if (!manager) {
                return;
            }
            void (async () => {
                manager?.debugLog?.(`[renameFiles] count=${event.files.length} activeBefore=${vscode.window.activeTextEditor?.document.uri.toString() ?? 'none'}`);
                for (const file of event.files) {
                    manager?.debugLog?.(`[renameFiles] old=${file.oldUri.toString()} new=${file.newUri.toString()} oldHasTree=${manager?.hasTree(file.oldUri) === true} newHasTree=${manager?.hasTree(file.newUri) === true}`);
                    manager?.renameTree(file.oldUri, file.newUri);
                    persistedUris.delete(file.oldUri.toString());
                    if (await enqueuePersistOperation(() =>
                        withPersistStorageEpochLock(
                            context,
                            () => migratePersistedTreeForRename(context, file.oldUri, file.newUri)
                        )
                    )) {
                        persistedUris.add(file.newUri.toString());
                        const knownRevision = knownPersistedTreeRevisions.get(file.oldUri.toString());
                        const knownDestructiveGeneration = knownPersistedDestructiveGenerations.get(file.oldUri.toString());
                        knownPersistedTreeRevisions.delete(file.oldUri.toString());
                        knownPersistedDestructiveGenerations.delete(file.oldUri.toString());
                        if (knownRevision) {
                            knownPersistedTreeRevisions.set(file.newUri.toString(), knownRevision);
                        }
                        if (knownDestructiveGeneration !== undefined) {
                            knownPersistedDestructiveGenerations.set(file.newUri.toString(), knownDestructiveGeneration);
                        }
                    }
                    pendingRenameOldUris.delete(file.oldUri.toString());
                    manager?.debugLog?.(`[renameFiles] afterRename oldHasTree=${manager?.hasTree(file.oldUri) === true} newHasTree=${manager?.hasTree(file.newUri) === true}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
                for (const file of event.files) {
                    const renamedDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === file.newUri.toString());
                    manager?.debugLog?.(`[renameFiles] postTick new=${file.newUri.toString()} docFound=${!!renamedDoc} activeAfterTick=${vscode.window.activeTextEditor?.document.uri.toString() ?? 'none'}`);
                    if (renamedDoc && isTracked(renamedDoc)) {
                        await ensureTreeLoaded(context, manager, renamedDoc).catch(() => {});
                        await acquireMultiWindowLock(context, renamedDoc, outputChannel).catch(() => {});
                        manager?.debugLog?.(`[renameFiles] ensured new=${file.newUri.toString()} hasTree=${manager?.hasTree(file.newUri) === true}`);
                    }
                }
                const activeEditor = vscode.window.activeTextEditor;
                provider.setActiveEditor(activeEditor);
                manager?.debugLog?.(`[renameFiles] refresh activeFinal=${activeEditor?.document.uri.toString() ?? 'none'} activeHasTree=${activeEditor ? manager?.hasTree(activeEditor.document.uri) === true : false}`);
                provider.refresh();
                updateStatusBar(activeEditor);
            })();
        })
    );

    deactivateHandler = async () => {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = undefined;
        }
        if (multiWindowLockTimer) {
            clearInterval(multiWindowLockTimer);
            multiWindowLockTimer = undefined;
        }
        try {
            await Promise.all(Array.from(documentTaskQueues.values()));
            await Promise.all(Array.from(treeLoadPromises.values()));
            await flushPersistState(context);
            await persistWriteQueue;
        } catch (error) {
            outputChannel.appendLine(`[deactivate] failed to flush persisted state: ${String(error)}`);
        }
        await releaseAllMultiWindowLocks(context);
        manager?.dispose();
    };

    await notifyManifestReadStatus(context, persistedManifest.status, outputChannel);
}

export async function deactivate() {
    await deactivateHandler?.();
}

export const __test__ = {
    persistStateToDisk,
    enqueuePersistOperation,
    withPersistStorageLock,
    simulateExternalStorageReset: (context: vscode.ExtensionContext) =>
        withPersistStorageLock(context, async () => {
            await resetStorageUnderLock(context);
        }),
    simulateInterruptedStorageReset: (context: vscode.ExtensionContext) =>
        withPersistStorageLock(context, async () => {
            const nextEpoch = (await recoverStorageEpochUnderLock(context)) + 1;
            await writeStorageEpochRecord(context, { epoch: nextEpoch, state: 'resetting' });
        }),
    loadPersistedTreeFromDisk,
    readPersistedManifest,
    getSerializedTreeRevision,
    getCompactPreviewContextEditor,
    canUnloadTreeAfterFlush,
    enqueueDocumentTask,
    drainDocumentTasks,
    rebaseStaleDestructiveGenerationUris,
    setManagerForTest: (value: UndoTreeManager | undefined) => {
        manager = value;
    },
    beginResetTaskEpoch: () => {
        resetInProgress = true;
        documentTaskEpoch++;
    },
    endResetTaskEpoch: () => {
        documentTaskEpoch++;
        resetInProgress = false;
    },
    setCompactPreviewTargetUri: (uri: string | undefined) => {
        compactPreviewTargetUri = uri;
    },
};
