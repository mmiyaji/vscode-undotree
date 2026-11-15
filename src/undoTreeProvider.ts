'use strict';

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { format as formatDate } from 'date-fns';
import { UndoNode, UndoTreeManager } from './undoTreeManager';
import { t as tr } from './runtimeL10n';
import { TrackingStatus } from './tracking';
import { evaluateDocumentTracking, readTrackingSettings } from './documentTracking';

// The webview only needs presentation metadata, never document contents or diffs.
type DisplayNode = Pick<UndoNode, 'id' | 'parents' | 'children' | 'timestamp' | 'label'
    | 'note' | 'pinned' | 'lineCount' | 'byteCount'> & {
    storage: { kind: UndoNode['storage']['kind'] };
    formattedTime: string;
    isEmpty: boolean;
};

type NotTrackedReason = TrackingStatus['reason'];

function getNonce(): string {
    return randomBytes(16).toString('hex');
}

function serializeForInlineScript(value: unknown): string {
    return (JSON.stringify(value) ?? 'null')
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export class UndoTreeProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private mode: 'navigate' | 'diff' = 'navigate';
    private lastEditor?: vscode.TextEditor;
    private lastEditorUri?: string;
    private lastDocumentUri?: string;
    private contextUri?: string;
    private loadingRequest?: { uri: string; token: number };
    private loadingToken = 0;
    private webviewInitialized = false;

    setActiveEditor(editor: vscode.TextEditor | undefined) {
        const nextContextEditor = editor && this.isSidebarContextDocument(editor.document) ? editor : undefined;
        const nextContextUri = nextContextEditor?.document.uri.toString();
        if (this.mode === 'diff' && this.lastEditorUri && nextContextUri && nextContextUri !== this.lastEditorUri) {
            this.mode = 'navigate';
        }
        if (nextContextEditor) {
            this.rememberDocument(nextContextEditor.document);
            this.lastEditor = nextContextEditor;
            this.lastEditorUri = nextContextUri;
        }
    }

    rememberDocument(document: vscode.TextDocument | undefined) {
        if (document && this.isSidebarContextDocument(document)) {
            this.contextUri = document.uri.toString();
            this.lastDocumentUri = this.contextUri;
        }
    }

    captureWindowContext() {
        const active = vscode.window.activeTextEditor;
        if (active && this.isSidebarContextDocument(active.document)) {
            this.setActiveEditor(active);
            return;
        }
        const activeTabUri = this.getActiveTabUri();
        if (activeTabUri) {
            const visibleForActiveTab = (vscode.window.visibleTextEditors ?? []).find(
                (editor) =>
                    this.isSidebarContextDocument(editor.document) &&
                    editor.document.uri.toString() === activeTabUri
            );
            if (visibleForActiveTab) {
                this.setActiveEditor(visibleForActiveTab);
                return;
            }
            const tabDocument = (vscode.workspace.textDocuments ?? []).find(
                (document) =>
                    this.isSidebarContextDocument(document) &&
                    document.uri.toString() === activeTabUri
            );
            if (tabDocument) {
                this.rememberDocument(tabDocument);
                return;
            }
        }
        const visible = vscode.window.visibleTextEditors?.find((editor) => this.isSidebarContextDocument(editor.document));
        if (visible) {
            this.setActiveEditor(visible);
            return;
        }
        const lastTrackedDocument = [...(vscode.workspace.textDocuments ?? [])]
            .reverse()
            .find((document) => this.isSidebarContextDocument(document));
        if (lastTrackedDocument) {
            this.rememberDocument(lastTrackedDocument);
        }
    }

    showCheckpointLoading() {
        this.view?.webview.postMessage({ command: 'showJumpLoading' });
    }

    resetShell() {
        this.webviewInitialized = false;
        this.render();
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
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                return;
            }
            this.captureWindowContext();
            this.render();
        });
        this.render();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'undo': {
                        const sourceUri = typeof message.sourceUri === 'string' && message.sourceUri
                            ? message.sourceUri
                            : undefined;
                        const contextTarget = this.getContextEditTarget(sourceUri);
                        if (contextTarget) {
                            await this.manager.undo(contextTarget);
                        } else if (!sourceUri) {
                            await this.manager.undo();
                        }
                        break;
                    }
                    case 'redo': {
                        const sourceUri = typeof message.sourceUri === 'string' && message.sourceUri
                            ? message.sourceUri
                            : undefined;
                        const contextTarget = this.getContextEditTarget(sourceUri);
                        if (contextTarget) {
                            await this.manager.redo(contextTarget);
                        } else if (!sourceUri) {
                            await this.manager.redo();
                        }
                        break;
                    }
                    case 'jumpToNode': {
                        const sourceUri = typeof message.sourceUri === 'string' ? message.sourceUri : '';
                        const contextEditor = sourceUri ? this.getContextEditor(sourceUri) : undefined;
                        if (contextEditor && typeof message.nodeId === 'number') {
                            await this.manager.jumpToNode(message.nodeId, contextEditor);
                            if (message.focusEditor) {
                                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                            }
                        }
                        break;
                    }
                    case 'togglePause':
                        await vscode.commands.executeCommand('undotree.togglePause');
                        break;
                    case 'showMenu':
                        await vscode.commands.executeCommand('undotree.showMenu');
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mmiyaji.vscode-undotree');
                        break;
                    case 'trackLargeFile':
                        await vscode.commands.executeCommand('undotree.trackLargeFileForSession');
                        break;
                    case 'openSizeSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'undotree.maxTrackedFileChars');
                        break;
                    case 'openExcludeSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'undotree.excludePatterns');
                        break;
                    case 'openDisplaySettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mmiyaji.vscode-undotree undotree.timeFormat');
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
                        const sourceUri = typeof message.sourceUri === 'string' ? message.sourceUri : undefined;
                        const contextEditor = this.getContextEditor(sourceUri);
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
                        const sourceUri = typeof message.sourceUri === 'string' ? message.sourceUri : undefined;
                        const contextEditor = this.getContextEditor(sourceUri);
                        if (typeof message.nodeId !== 'number' || !contextEditor) {
                            break;
                        }
                        this.manager.togglePinned(contextEditor.document.uri, message.nodeId);
                        break;
                    }
                }
            } catch (error) {
                this.manager.debugLog?.(`[provider] webview message failed: ${String(error)}`);
                void vscode.window.showErrorMessage(tr('Undo Tree: an action failed. See Output for details.'));
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
        const document = this.getContextDocument();
        const isLoadingCurrentEditor = !!document &&
            this.loadingRequest?.uri === document.uri.toString();
        const timeFormat = this.getTimeFormat();
        const timeFormatCustom = this.getTimeFormatCustom();
        const nodeSizeMetric = this.getNodeSizeMetric();
        const nodeSizeMetricBase = this.getNodeSizeMetricBase();
        const showStorageKind = this.getShowStorageKind();
        const colorTheme = this.getColorTheme();
        const state = this.getRenderState(
            document,
            isLoadingCurrentEditor,
            timeFormat,
            timeFormatCustom,
            nodeSizeMetric,
            nodeSizeMetricBase,
            showStorageKind,
            colorTheme
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
                state.colorTheme,
                state.view,
                state.notTrackedExt,
                state.notTrackedReason,
                state.sourceUri,
                state.rootId
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
        document: vscode.TextDocument | undefined,
        isLoadingCurrentEditor: boolean,
        timeFormat: 'none' | 'time' | 'dateTime' | 'relative' | 'custom',
        timeFormatCustom: string,
        nodeSizeMetric: 'none' | 'lines' | 'bytes',
        nodeSizeMetricBase: 'current' | 'initial' | 'parent',
        showStorageKind: boolean,
        colorTheme: 'auto' | 'blue' | 'neutral' | 'green' | 'amber' | 'teal' | 'violet' | 'rose' | 'red'
    ) {
        const residentTree = document ? this.manager.peekTree(document.uri) : undefined;
        if (isLoadingCurrentEditor || (document && !residentTree && this.getTrackingStatus(document).tracked)) {
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
                colorTheme,
                notTrackedExt: '',
                notTrackedReason: '' as NotTrackedReason,
                sourceUri: '',
                rootId: 0,
            };
        }
        if (!document) {
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
                colorTheme,
                notTrackedExt: '',
                notTrackedReason: '' as NotTrackedReason,
                sourceUri: '',
                rootId: 0,
            };
        }
        const trackingStatus = this.getTrackingStatus(document);
        if (!trackingStatus.tracked) {
            const fileName = document.isUntitled ? '' : document.fileName.replace(/.*[\\/]/, '');
            const ext = trackingStatus.extension || fileName;
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
                colorTheme,
                notTrackedExt: ext,
                notTrackedReason: trackingStatus.reason,
                sourceUri: document.uri.toString(),
                rootId: 0,
            };
        }
        const tree = residentTree!;
        const displayNodes = Array.from(tree.nodes.values()).map((node) => ({
            id: node.id,
            parents: node.parents,
            children: node.children,
            timestamp: node.timestamp,
            label: node.label,
            note: node.note,
            pinned: node.pinned,
            lineCount: node.lineCount,
            byteCount: node.byteCount,
            storage: { kind: node.storage.kind },
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
            colorTheme,
            notTrackedExt: '',
            notTrackedReason: '' as NotTrackedReason,
            sourceUri: document.uri.toString(),
            rootId: tree.rootId,
        };
    }

    private getContextDocument(): vscode.TextDocument | undefined {
        const active = vscode.window.activeTextEditor;
        if (active && this.isSidebarContextDocument(active.document)) {
            this.rememberDocument(active.document);
            return active.document;
        }
        const activeTabUri = this.getActiveTabUri();
        if (activeTabUri) {
            const tabDoc = vscode.workspace.textDocuments.find((document) => document.uri.toString() === activeTabUri);
            if (tabDoc && this.isSidebarContextDocument(tabDoc)) {
                this.rememberDocument(tabDoc);
                return tabDoc;
            }
        }
        if (this.contextUri) {
            const rememberedDoc = vscode.workspace.textDocuments.find(
                (document) =>
                    this.isSidebarContextDocument(document) &&
                    document.uri.toString() === this.contextUri
            );
            if (rememberedDoc) {
                return rememberedDoc;
            }
        }
        const visibleEditors = vscode.window.visibleTextEditors ?? [];
        if (this.contextUri) {
            const matchingVisible = visibleEditors.find(
                (editor) =>
                    this.isSidebarContextDocument(editor.document) &&
                    editor.document.uri.toString() === this.contextUri
            );
            if (matchingVisible) {
                this.rememberDocument(matchingVisible.document);
                return matchingVisible.document;
            }
        }
        const visible = visibleEditors.find((editor) => this.isSidebarContextDocument(editor.document));
        if (visible) {
            this.rememberDocument(visible.document);
            return visible.document;
        }
        if (this.lastEditor && this.isSidebarContextDocument(this.lastEditor.document)) {
            this.rememberDocument(this.lastEditor.document);
            return this.lastEditor.document;
        }
        return active?.document;
    }

    private isContextEditor(editor: vscode.TextEditor | undefined, expectedUri?: string): editor is vscode.TextEditor {
        return !!editor
            && this.isSidebarContextDocument(editor.document)
            && (!expectedUri || editor.document.uri.toString() === expectedUri);
    }

    private getContextEditor(expectedUri?: string): vscode.TextEditor | undefined {
        const active = vscode.window.activeTextEditor;
        const visibleEditors = vscode.window.visibleTextEditors ?? [];
        if (expectedUri) {
            const exact = [active, this.lastEditor, ...visibleEditors].find((editor) =>
                this.isContextEditor(editor, expectedUri)
            );
            if (exact) {
                this.rememberDocument(exact.document);
                return exact;
            }
            return undefined;
        }
        if (active && this.isSidebarContextDocument(active.document)) {
            this.rememberDocument(active.document);
            return active;
        }
        const activeTabUri = this.getActiveTabUri();
        if (activeTabUri) {
            const matchingVisibleFromTab = (vscode.window.visibleTextEditors ?? []).find(
                (editor) =>
                    this.isSidebarContextDocument(editor.document) &&
                    editor.document.uri.toString() === activeTabUri
            );
            if (matchingVisibleFromTab) {
                this.rememberDocument(matchingVisibleFromTab.document);
                return matchingVisibleFromTab;
            }
        }
        if (this.contextUri) {
            const matchingVisible = visibleEditors.find(
                (editor) =>
                    this.isSidebarContextDocument(editor.document) &&
                    editor.document.uri.toString() === this.contextUri
            );
            if (matchingVisible) {
                this.rememberDocument(matchingVisible.document);
                return matchingVisible;
            }
        }
        if (this.lastEditor && this.isSidebarContextDocument(this.lastEditor.document)) {
            this.rememberDocument(this.lastEditor.document);
            return this.lastEditor;
        }
        const visible = visibleEditors.find((editor) => this.isSidebarContextDocument(editor.document));
        if (visible) {
            this.rememberDocument(visible.document);
            return visible;
        }
        return active;
    }

    private getContextEditTarget(expectedUri?: string): vscode.TextEditor | vscode.TextDocument | undefined {
        const contextEditor = this.getContextEditor(expectedUri);
        if (!expectedUri) {
            return contextEditor;
        }
        const visibleEditor = (vscode.window.visibleTextEditors ?? []).find(
            (editor) => this.isContextEditor(editor, expectedUri)
        );
        if (visibleEditor) {
            return visibleEditor;
        }
        return vscode.workspace.textDocuments.find(
            (document) => this.isSidebarContextDocument(document) && document.uri.toString() === expectedUri
        );
    }

    private getActiveTabUri(): string | undefined {
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const input = (activeTab as { input?: { uri?: vscode.Uri } } | undefined)?.input;
        return input?.uri?.toString();
    }

    private isSidebarContextDocument(document: vscode.TextDocument): boolean {
        const scheme = document.uri.scheme ?? document.uri.toString().split(':', 1)[0];
        return scheme === 'file' || document.isUntitled;
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

    private getNodeSizeMetricBase(): 'current' | 'initial' | 'parent' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('nodeSizeMetricBase');
        if (value === 'current' || value === 'initial' || value === 'parent') {
            return value;
        }
        return 'parent';
    }

    private getColorTheme(): 'auto' | 'blue' | 'neutral' | 'green' | 'amber' | 'teal' | 'violet' | 'rose' | 'red' {
        const value = vscode.workspace.getConfiguration('undotree').get<string>('colorTheme');
        if (
            value === 'auto' ||
            value === 'neutral' ||
            value === 'green' ||
            value === 'amber' ||
            value === 'teal' ||
            value === 'violet' ||
            value === 'rose' ||
            value === 'red'
        ) {
            return value;
        }
        return 'blue';
    }

    private isTrackedDocument(document: vscode.TextDocument): boolean {
        return this.getTrackingStatus(document).tracked;
    }

    private getTrackingStatus(document: vscode.TextDocument): TrackingStatus {
        const config = vscode.workspace.getConfiguration('undotree', document.uri);
        const folder = vscode.workspace.getWorkspaceFolder?.(document.uri);
        const documentPath = document.uri.fsPath || document.fileName || document.uri.toString();
        const relativePath = folder ? require('path').relative(folder.uri.fsPath, documentPath) : documentPath;
        return evaluateDocumentTracking(document, relativePath, readTrackingSettings(config));
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
            return tr('just now');
        }
        if (deltaSeconds < 60) {
            return tr('{0}s ago', deltaSeconds);
        }
        const deltaMinutes = Math.floor(deltaSeconds / 60);
        if (deltaMinutes < 60) {
            return tr('{0}m ago', deltaMinutes);
        }
        const deltaHours = Math.floor(deltaMinutes / 60);
        if (deltaHours < 24) {
            return tr('{0}h ago', deltaHours);
        }
        const deltaDays = Math.floor(deltaHours / 24);
        return tr('{0}d ago', deltaDays);
    }

    private buildNotTrackedHtml(ext: string, _fileName: string): string {
        const nonce = getNonce();
        const cspSource = this.getCspSource();
        const label = ext
            ? tr('Undo Tree: {0} is not tracked', ext)
            : tr('Undo Tree: this file is not tracked');
        const hint = ext
            ? tr('To enable tracking for {0} files, click the status bar item or open Settings.', ext)
            : tr('To enable tracking for this file, click the status bar item or open Settings.');
        const enableLabel = ext
            ? tr('Enable tracking for {0}', ext)
            : tr('Enable tracking for this file');
        const settingsLabel = tr('Open Settings');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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

    private getCspSource(): string {
        return this.view?.webview.cspSource ?? 'vscode-resource:';
    }

    private buildHtml(
        nodes: DisplayNode[] | null,
        currentId: number,
        paused: boolean,
        mode: 'navigate' | 'diff',
        timeFormat: 'none' | 'time' | 'dateTime' | 'relative' | 'custom',
        timeFormatCustom: string,
        nodeSizeMetric: 'none' | 'lines' | 'bytes',
        nodeSizeMetricBase: 'current' | 'initial' | 'parent',
        showStorageKind: boolean,
        colorTheme: 'auto' | 'blue' | 'neutral' | 'green' | 'amber' | 'teal' | 'violet' | 'rose' | 'red' = 'blue',
        initialView: 'loading' | 'empty' | 'notTracked' | 'tree' = nodes ? 'tree' : 'empty',
        initialNotTrackedExt = '',
        initialNotTrackedReason: NotTrackedReason = '',
        initialSourceUri = '',
        initialRootId = 0
    ): string {
        const nonce = getNonce();
        const cspSource = this.getCspSource();
        const nodesJson = serializeForInlineScript(nodes);
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; padding-top: 0; overflow-x: auto; }
  :root {
    --undotree-accent: #3794ff;
    --undotree-accent-strong: #4ca0ff;
    --undotree-accent-soft: rgba(55, 148, 255, 0.16);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 74%, #3794ff 10%);
    --undotree-current: rgba(9, 71, 113, 0.84);
    --undotree-latest: #4fc1ff;
    --undotree-label-opacity: 0.96;
    --undotree-note-opacity: 0.9;
    --undotree-pinned-opacity: 0.8;
  }
  body[data-color-theme="auto"] {
    --undotree-accent: var(--vscode-button-background, var(--vscode-focusBorder, #3794ff));
    --undotree-accent-strong: var(--vscode-button-hoverBackground, var(--vscode-focusBorder, #4ca0ff));
    --undotree-accent-soft: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 16%, transparent);
    --undotree-hover: var(--vscode-list-hoverBackground);
    --undotree-current: var(--vscode-list-activeSelectionBackground);
    --undotree-latest: var(--vscode-textLink-foreground, var(--vscode-charts-blue, #3794ff));
    --undotree-label-opacity: 0.96;
    --undotree-note-opacity: 0.9;
    --undotree-pinned-opacity: 0.8;
  }
  body.vscode-light[data-color-theme="auto"],
  body.vscode-high-contrast-light[data-color-theme="auto"] {
    --undotree-accent: var(--vscode-button-background, var(--vscode-focusBorder, #0b66d0));
    --undotree-accent-strong: var(--vscode-button-hoverBackground, var(--vscode-focusBorder, #0057b8));
    --undotree-accent-soft: color-mix(in srgb, var(--vscode-focusBorder, #0b66d0) 12%, transparent);
    --undotree-hover: var(--vscode-list-hoverBackground);
    --undotree-current: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 88%, white 12%);
    --undotree-latest: var(--vscode-textLink-foreground, var(--vscode-charts-blue, #0057b8));
    --undotree-label-opacity: 1;
    --undotree-note-opacity: 0.96;
    --undotree-pinned-opacity: 0.92;
  }
  body[data-color-theme="neutral"] {
    --undotree-accent: rgba(212, 212, 212, 0.55);
    --undotree-accent-strong: rgba(212, 212, 212, 0.78);
    --undotree-accent-soft: rgba(212, 212, 212, 0.10);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 86%, rgba(212, 212, 212, 0.16) 14%);
    --undotree-current: rgba(90, 90, 90, 0.30);
    --undotree-latest: rgba(212, 212, 212, 0.78);
  }
  body[data-color-theme="green"] {
    --undotree-accent: var(--vscode-charts-green, #89d185);
    --undotree-accent-strong: #98d993;
    --undotree-accent-soft: rgba(137, 209, 133, 0.16);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 76%, rgba(137, 209, 133, 0.18) 24%);
    --undotree-current: rgba(50, 85, 52, 0.38);
    --undotree-latest: var(--vscode-charts-green, #89d185);
  }
  body[data-color-theme="amber"] {
    --undotree-accent: var(--vscode-charts-yellow, #d7ba7d);
    --undotree-accent-strong: #dfc48d;
    --undotree-accent-soft: rgba(215, 186, 125, 0.18);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 76%, rgba(215, 186, 125, 0.20) 24%);
    --undotree-current: rgba(93, 77, 43, 0.42);
    --undotree-latest: var(--vscode-charts-yellow, #d7ba7d);
  }
  body[data-color-theme="teal"] {
    --undotree-accent: #4ec9b0;
    --undotree-accent-strong: #67d2bd;
    --undotree-accent-soft: rgba(78, 201, 176, 0.16);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 76%, rgba(78, 201, 176, 0.18) 24%);
    --undotree-current: rgba(36, 84, 76, 0.42);
    --undotree-latest: #4ec9b0;
  }
  body[data-color-theme="violet"] {
    --undotree-accent: #b392f0;
    --undotree-accent-strong: #bea1f2;
    --undotree-accent-soft: rgba(179, 146, 240, 0.16);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 76%, rgba(179, 146, 240, 0.18) 24%);
    --undotree-current: rgba(72, 56, 102, 0.42);
    --undotree-latest: #b392f0;
  }
  body[data-color-theme="rose"] {
    --undotree-accent: #f28bba;
    --undotree-accent-strong: #f49bc4;
    --undotree-accent-soft: rgba(242, 139, 186, 0.16);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 76%, rgba(242, 139, 186, 0.18) 24%);
    --undotree-current: rgba(106, 58, 78, 0.42);
    --undotree-latest: #f28bba;
  }
  body[data-color-theme="red"] {
    --undotree-accent: #e06c75;
    --undotree-accent-strong: #e58087;
    --undotree-accent-soft: rgba(224, 108, 117, 0.16);
    --undotree-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 76%, rgba(224, 108, 117, 0.18) 24%);
    --undotree-current: rgba(104, 49, 53, 0.42);
    --undotree-latest: #e06c75;
  }
  #tree { min-width: max-content; }
  #tree.plain-view { min-width: 0; }
  .node { display: flex; align-items: center; gap: 4px; padding: 2px 4px; cursor: pointer; border-radius: 3px; user-select: none; white-space: nowrap; }
  #tree.virtual-tree .node { height: 22px; box-sizing: border-box; }
  .node { scroll-margin-top: 42px; }
  .node:hover { background: var(--vscode-list-hoverBackground); }
  .node.current { background: var(--undotree-current); color: var(--vscode-list-activeSelectionForeground); }
  .node:hover:not(.current) { background: var(--undotree-hover); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--undotree-accent) 30%, transparent); }
  .node:hover:not(.current) .right-area { background: var(--undotree-hover); }
  .node.focused { outline: 1px solid var(--undotree-accent-strong); outline-offset: -1px; }
  .node.diff-target { background: var(--undotree-accent-soft); color: var(--vscode-foreground); }
  .node.diff-target .right-area { background: color-mix(in srgb, var(--undotree-accent-soft) 72%, var(--vscode-sideBar-background)); }
  .node.current.diff-target { box-shadow: inset 0 0 0 1px var(--undotree-accent-strong); }
  .diff-target-badge { font-size: 9px; color: var(--undotree-accent-strong); border: 1px solid currentColor; border-radius: 999px; padding: 0 4px; flex-shrink: 0; }
  .diff-base { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--undotree-accent-strong) 70%, transparent); }
  .diff-base-badge { font-size: 9px; color: var(--undotree-accent-strong); border: 1px solid currentColor; border-radius: 999px; padding: 0 4px; flex-shrink: 0; }
  .current-badge { font-size: 9px; color: var(--vscode-list-activeSelectionForeground); border: 1px solid currentColor; border-radius: 999px; padding: 0 4px; flex-shrink: 0; }
  .graph { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--vscode-editorLineNumber-foreground); }
  .graph svg.graph-segment { width: 12px; height: 14px; display: block; overflow: visible; }
  .storage { font-size: 9px; opacity: 0.5; border: 1px solid currentColor; border-radius: 2px; padding: 0 2px; flex-shrink: 0; }
  .label { opacity: var(--undotree-label-opacity); }
  .right-area { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; padding-left: 6px; position: sticky; right: 4px; background: var(--vscode-sideBar-background); }
  .metrics { display: inline-grid; grid-template-columns: var(--diff-col-width, auto) var(--total-col-width, auto) var(--time-col-width, auto); align-items: center; justify-content: end; justify-items: end; column-gap: 6px; flex: 0 0 auto; }
  .node.current .right-area { background: var(--undotree-current); }
  .time { opacity: 0.5; font-size: 10px; flex-shrink: 0; }
  .time.latest { opacity: 0.9; color: var(--undotree-latest); }
  .empty { opacity: 0.5; padding: 8px; }
  .actions { display: flex; flex-wrap: nowrap; gap: 3px; margin-bottom: 8px; align-items: center; position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 2; padding: 8px 0 4px; }
  .actions button { padding-left: 4px; padding-right: 4px; flex: 0 0 auto; }
  button { background: var(--undotree-accent); color: var(--vscode-button-foreground); border: none; padding: 3px 8px; cursor: pointer; border-radius: 2px; font-size: 11px; }
  button:hover { background: var(--undotree-accent-strong); }
  button:disabled { opacity: 0.4; cursor: default; }
  .btn-pause { margin-left: auto; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-pause:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-mode { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-mode:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-mode.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .icon-button { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; width: 26px; height: 24px; padding: 0; }
  .icon-button .icon-glyph { font-size: 12px; line-height: 1; pointer-events: none; }
  .btn-settings { background: transparent; color: var(--vscode-foreground); opacity: 0.6; padding: 3px 5px; }
  .btn-settings:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .paused-badge { font-size: 10px; opacity: 0.6; margin-left: 2px; }
  .diff-badge { font-size: 10px; color: var(--undotree-accent-strong); margin-left: 2px; }
  .diff-tools { display: none; align-items: center; gap: 4px; margin: 0 0 8px; position: sticky; top: 42px; z-index: 1; background: var(--vscode-sideBar-background); padding: 0 0 6px; }
  .diff-tools.visible { display: flex; flex-wrap: wrap; }
  .btn-compare { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-compare:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-compare.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .diff-base-label { font-size: 10px; opacity: 0.7; margin-left: 4px; flex: 1 1 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .history-tools { display: none; gap: 4px; align-items: center; margin: 0 0 6px; position: sticky; top: 42px; z-index: 1; background: var(--vscode-sideBar-background); padding: 2px 0 4px; }
  .history-tools.visible { display: flex; flex-wrap: wrap; }
  body[data-mode="diff"] .history-tools { top: 80px; }
  .history-search { min-width: 70px; width: 100%; box-sizing: border-box; flex: 1 1 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 4px; font: inherit; }
  .history-search::placeholder { color: var(--vscode-input-placeholderForeground); }
  .history-search:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .pinned-only-label { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; font-size: 10px; }
  .filter-status { flex: 1 1 100%; font-size: 10px; opacity: 0.75; }
  .current-indicator { font-size: 10px; color: var(--undotree-accent-strong); }
  .show-current { margin-left: auto; padding: 2px 5px; }
  .btn-search { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); min-width: 24px; padding: 2px 5px; }
  .mode-name { font-size: 10px; white-space: nowrap; }
  .node[role="treeitem"] { cursor: pointer; }
  .empty-badge { font-size: 9px; opacity: 0.45; font-style: italic; flex-shrink: 0; }
  .meta-col { text-align: right; font-size: 9px; opacity: 0.7; white-space: nowrap; justify-self: end; }
  .size-diff { flex-shrink: 0; }
  .size-total { flex-shrink: 0; }
  .meta-col.empty, .time.empty { visibility: hidden; }
  .size-diff.plus { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .size-diff.minus { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .tree-header { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; padding: 0 4px 6px; font-size: 10px; opacity: 0.55; white-space: nowrap; min-width: max-content; }
  .tree-header .label-col { min-width: max-content; flex: 0 0 auto; }
  .tree-header .right-area { background: var(--vscode-sideBar-background); position: sticky; right: 4px; padding-left: 6px; flex: 0 0 auto; white-space: nowrap; }
  .tree-header .metrics { flex: 0 0 auto; }
  .tree-header .size-diff, .tree-header .size-total, .tree-header .time { opacity: 0.7; }
  .time { text-align: right; white-space: nowrap; justify-self: end; }
  .note { font-weight: 600; opacity: var(--undotree-note-opacity); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex-shrink: 1; }
  .note-edit { opacity: 0; font-size: 10px; cursor: pointer; flex-shrink: 0; padding: 0 2px; }
  .node:hover .note-edit { opacity: 0.45; }
  .node:hover .note-edit:hover { opacity: 1; }
  .pinned-wrap { margin-bottom: 8px; }
  .pinned-title { font-size: 10px; opacity: 0.55; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .pinned-link { display:flex; align-items:center; gap:4px; padding:2px 4px; cursor:pointer; border-radius:3px; white-space:nowrap; }
  .pinned-link:hover { background: var(--vscode-list-hoverBackground); }
  .pinned-link .pin-mark { opacity: 0.85; width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-foreground); flex: 0 0 auto; cursor: pointer; }
  .pinned-link .pin-mark svg { width: 10px; height: 10px; display: block; }
  .pinned-link .pinned-label { opacity: var(--undotree-pinned-opacity); }
  .pinned-link .pin-mark:hover { opacity: 1; }
  .msg { opacity: 0.7; margin-bottom: 8px; white-space: normal; overflow-wrap: anywhere; }
  .hint { opacity: 0.45; font-size: 11px; margin-bottom: 12px; white-space: normal; overflow-wrap: anywhere; }
  .btn { display: block; margin-bottom: 6px; background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); font-size: 12px; cursor: pointer; text-decoration: underline; text-align: left; white-space: normal; overflow-wrap: anywhere; }
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
  .context-menu { position: fixed; display: none; min-width: 180px; max-width: min(240px, calc(100vw - 16px)); padding: 4px; border-radius: 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background))); box-shadow: 0 8px 28px rgba(0,0,0,0.28); z-index: 12; }
  .context-menu.visible { display: block; }
  .context-menu-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; opacity: 0.9; padding: 6px 8px 8px; margin: -4px -4px 4px; border-radius: 6px 6px 0 0; background: color-mix(in srgb, var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background))) 82%, var(--vscode-foreground) 8%); border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .context-menu-title-icon { opacity: 0.7; flex-shrink: 0; }
  .context-menu-item { width: 100%; display: flex; align-items: center; justify-content: flex-start; gap: 8px; background: transparent; color: var(--vscode-menu-foreground, var(--vscode-foreground)); text-align: left; border-radius: 4px; padding: 5px 8px; }
  .context-menu-item:hover:not(:disabled) { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
  .context-menu-item:disabled { opacity: 0.45; cursor: default; }
  .context-menu-sep { height: 1px; margin: 4px 0; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
</style>
</head>
<body data-color-theme="${colorTheme}">
<div class="actions">
  <button id="btn-undo">${tr('Undo')}</button>
  <button id="btn-redo">${tr('Redo')}</button>
  <button id="btn-search" class="btn-search" title="${tr('Search notes or dates')}" aria-label="${tr('Search notes or dates')}" aria-expanded="false">${tr('Search')}</button>
  <button id="show-current" class="show-current" title="${tr('Show current')}" aria-label="${tr('Show current')}">${tr('Current')}</button>
  <button class="btn-pause icon-button" id="btn-pause" title="${paused ? tr('Resume tracking') : tr('Pause tracking')}" aria-label="${paused ? tr('Resume tracking') : tr('Pause tracking')}">${paused ? '<span class="icon-glyph">&#9654;</span>' : '<span class="icon-glyph">&#10074;&#10074;</span>'}</button>
  <button class="btn-mode" id="btn-mode" title="${mode === 'navigate' ? tr('Switch to Diff mode') : tr('Switch to Navigate mode')}" aria-label="${mode === 'navigate' ? tr('Switch to Diff mode') : tr('Switch to Navigate mode')}">${mode === 'navigate' ? tr('Navigate') : tr('Diff')}</button>
  <button class="btn-settings icon-button" id="btn-settings" title="${tr('Open Undo Tree menu')}" aria-label="${tr('Open Undo Tree menu')}">&#9881;</button>
</div>
${paused ? `<div class="paused-badge">${tr('Tracking paused - history is frozen')}</div>` : ''}
<div id="diff-tools" class="diff-tools${mode === 'diff' ? ' visible' : ''}">
  <button class="btn-compare active" id="btn-diff-current">${tr('vs Current')}</button>
  <button class="btn-compare" id="btn-diff-pair">${tr('Pair Diff')}</button>
  <span class="diff-base-label" id="diff-base-label"></span>
</div>
${mode === 'diff' ? `<div class="diff-badge">${tr('Diff mode - select a node to compare, then use ↑/↓ to keep reviewing')}</div>` : ''}
<div id="history-tools" class="history-tools" hidden>
  <input id="history-search" class="history-search" type="search" placeholder="${tr('Search notes or dates')}" aria-label="${tr('Search notes or dates')}" />
  <label class="pinned-only-label"><input id="pinned-only" type="checkbox" />${tr('Pinned only')}</label>
  <span id="filter-status" class="filter-status" aria-live="polite"></span>
  <span id="current-indicator" class="current-indicator"></span>
</div>
<div id="pinned"></div>
<div id="tree" role="tree" tabindex="-1" aria-label="${tr('Undo history')}"></div>
<div id="help-overlay" class="help-overlay" aria-hidden="true">
  <div class="help-backdrop" id="help-backdrop"></div>
  <div class="help-card" role="dialog" aria-modal="true" aria-label="${tr('Undo Tree shortcuts')}">
    <button class="help-close" id="help-close" title="${tr('Close help')}">×</button>
    <div class="help-title">${tr('Undo Tree shortcuts')}</div>
    <div class="help-section">
      <div class="help-section-title">${tr('Navigation')}</div>
      <div class="shortcut-row"><span class="shortcut-key">↑ / ↓, j / k</span><span class="shortcut-desc">${tr('Move focus')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">Enter / Space</span><span class="shortcut-desc">${tr('Jump or preview diff')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">← / →</span><span class="shortcut-desc">${tr('Move to parent or child')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">Tab / Shift+Tab</span><span class="shortcut-desc">${tr('Move to the next or previous control')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">n / N</span><span class="shortcut-desc">${tr('Jump to next or previous noted node')}</span></div>
    </div>
    <div class="help-section">
      <div class="help-section-title">${tr('Actions')}</div>
      <div class="shortcut-row"><span class="shortcut-key">u / r</span><span class="shortcut-desc">${tr('Undo / Redo')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">d</span><span class="shortcut-desc">${tr('Toggle Diff mode')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">p</span><span class="shortcut-desc">${tr('Pause or resume tracking')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">b</span><span class="shortcut-desc">${tr('Set the focused node as the Pair Diff base')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">c</span><span class="shortcut-desc">${tr('Switch Pair Diff back to current comparison')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">?</span><span class="shortcut-desc">${tr('Toggle this help')}</span></div>
      <div class="shortcut-row"><span class="shortcut-key">Esc</span><span class="shortcut-desc">${tr('Close help or exit Diff mode')}</span></div>
    </div>
  </div>
</div>
<div id="context-menu" class="context-menu" aria-hidden="true"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let nodes = ${nodesJson};
  let currentId = ${currentId};
  let mode = ${serializeForInlineScript(mode)};
  let timeFormat = ${serializeForInlineScript(timeFormat)};
  let timeFormatCustom = ${serializeForInlineScript(timeFormatCustom)};
  let nodeSizeMetric = ${serializeForInlineScript(nodeSizeMetric)};
  let nodeSizeMetricBase = ${serializeForInlineScript(nodeSizeMetricBase)};
  let showStorageKind = ${serializeForInlineScript(showStorageKind)};
  let colorTheme = ${serializeForInlineScript(colorTheme)};
  let sourceUri = ${serializeForInlineScript(initialSourceUri)};
  let rootId = ${serializeForInlineScript(initialRootId)};
  let diffCompareMode = 'current';
  let diffBaseNodeId = null;
  let searchExpanded = false;
  const searchMetadataCache = new Map();
  const i18n = {
    noteDoubleClickToEdit: ${serializeForInlineScript(tr(' (double-click to edit)'))},
    noteAdd: ${serializeForInlineScript(tr('Add note'))},
    pinNode: ${serializeForInlineScript(tr('Pin node'))},
    unpinNode: ${serializeForInlineScript(tr('Unpin node'))},
    pinnedNodes: ${serializeForInlineScript(tr('Pinned'))},
    loading: ${serializeForInlineScript(tr('Loading...'))},
    textEditorsOnly: ${serializeForInlineScript(tr('Undo Tree is only available for text editors.'))},
    notTrackedWithExt: ${serializeForInlineScript(tr('Undo Tree: {0} is not tracked', '{ext}'))},
    notTrackedGeneric: ${serializeForInlineScript(tr('Undo Tree: this file is not tracked'))},
    notTrackedHintWithExt: ${serializeForInlineScript(tr('To enable tracking for {0} files, click the status bar item or open Settings.', '{ext}'))},
    notTrackedHintGeneric: ${serializeForInlineScript(tr('To enable tracking for this file, click the status bar item or open Settings.'))},
    enableTrackingWithExt: ${serializeForInlineScript(tr('Enable tracking for {0}', '{ext}'))},
    enableTrackingGeneric: ${serializeForInlineScript(tr('Enable tracking for this file'))},
    trackLargeFile: ${serializeForInlineScript(tr('Track this file until closed'))},
    largeFileWarning: ${serializeForInlineScript(tr('Large files can slow editing and persistence.'))},
    tooLarge: ${serializeForInlineScript(tr('Undo Tree: this file exceeds the tracking size limit'))},
    tooLargeHint: ${serializeForInlineScript(tr('Adjust undotree.maxTrackedFileChars to track larger text files.'))},
    binaryFile: ${serializeForInlineScript(tr('Binary files are not tracked.'))},
    excludedByPattern: ${serializeForInlineScript(tr('Undo Tree: this file is excluded by a pattern'))},
    excludedByPatternHint: ${serializeForInlineScript(tr('This file matches undotree.excludePatterns. Edit that setting to track it.'))},
    editExcludePatterns: ${serializeForInlineScript(tr('Edit exclude patterns'))},
    openSettings: ${serializeForInlineScript(tr('Open Settings'))},
    basePrefix: ${serializeForInlineScript(tr('Base: '))},
    pairDiffNeedsBase: ${serializeForInlineScript(tr('Select a base node first or press B.'))},
    contextJump: ${serializeForInlineScript(tr('Jump'))},
    contextDiffCurrent: ${serializeForInlineScript(tr('Compare with Current'))},
    contextSetBase: ${serializeForInlineScript(tr('Set Pair Diff Base'))},
    contextPin: ${serializeForInlineScript(tr('Pin'))},
    contextUnpin: ${serializeForInlineScript(tr('Unpin'))},
    contextEditNote: ${serializeForInlineScript(tr('Edit Note'))},
    contextDisplaySettings: ${serializeForInlineScript(tr('Display Settings'))},
    contextMenuFor: ${serializeForInlineScript(tr('Node: '))},
    titleClickDiff: ${serializeForInlineScript(tr('Click to compare with current'))},
    titleClickJump: ${serializeForInlineScript(tr('Click to jump to this node'))},
    badgeBase: ${serializeForInlineScript(tr('Base'))},
    badgeDiff: ${serializeForInlineScript(tr('Diff'))},
    headerNode: ${serializeForInlineScript(tr('Node'))},
    headerDiff: ${serializeForInlineScript(tr('Diff'))},
    headerLines: ${serializeForInlineScript(tr('Lines'))},
    headerSize: ${serializeForInlineScript(tr('Size'))},
    headerTime: ${serializeForInlineScript(tr('Time'))},
    current: ${serializeForInlineScript(tr('Current'))},
    currentHidden: ${serializeForInlineScript(tr('Current node is hidden by filters'))},
    noMatches: ${serializeForInlineScript(tr('No matching history nodes'))},
    matchingCount: ${serializeForInlineScript(tr('{0} matching nodes / {1} total'))},
    navigateMode: ${serializeForInlineScript(tr('History navigation mode'))},
    diffMode: ${serializeForInlineScript(tr('Diff comparison mode'))},
    leftCurrentComparison: ${serializeForInlineScript(tr('Left: {0} ↔ Right: current file, including unsaved changes'))},
    leftPairComparison: ${serializeForInlineScript(tr('Compare {0} ↔ {1}'))},
  };

  function replaceExt(template, ext) {
    return template.replace('{ext}', ext);
  }

  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }

  const undoButton = document.getElementById('btn-undo');
  if (undoButton) { undoButton.addEventListener('click', () => send('undo', { sourceUri })); }
  const redoButton = document.getElementById('btn-redo');
  if (redoButton) { redoButton.addEventListener('click', () => send('redo', { sourceUri })); }
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
  const historySearch = document.getElementById('history-search');
  const pinnedOnly = document.getElementById('pinned-only');
  if (historySearch) { historySearch.addEventListener('input', () => buildTree(nodes, currentId, rootId)); }
  if (pinnedOnly) { pinnedOnly.addEventListener('change', () => buildTree(nodes, currentId, rootId)); }
  const showCurrentButton = document.getElementById('show-current');
  if (showCurrentButton) {
    showCurrentButton.addEventListener('click', () => {
      if (historySearch) { historySearch.value = ''; }
      if (pinnedOnly) { pinnedOnly.checked = false; }
      searchExpanded = false;
      const panel = document.getElementById('history-tools');
      if (panel) {
        panel.hidden = true;
        panel.classList.remove('visible');
      }
      searchToggle?.setAttribute('aria-expanded', 'false');
      syncStickyOffsets();
      buildTree(nodes, currentId, rootId, currentId);
      const index = nodeIds.indexOf(currentId);
      if (index >= 0) { setFocused(index, true, true); }
    });
  }
  const searchToggle = document.getElementById('btn-search');
  if (searchToggle) {
    searchToggle.addEventListener('click', () => {
      searchExpanded = !searchExpanded;
      const panel = document.getElementById('history-tools');
      panel.hidden = !searchExpanded;
      panel.classList.toggle('visible', searchExpanded);
      searchToggle.setAttribute('aria-expanded', searchExpanded ? 'true' : 'false');
      syncStickyOffsets();
      if (searchExpanded) { historySearch?.focus(); }
    });
  }

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
    if (nodeSizeMetric === 'none') {
      return {
        diffHtml: '<span class="meta-col size-diff empty"></span>',
        totalHtml: '<span class="meta-col size-total empty"></span>',
      };
    }
    const val = nodeSizeMetric === 'lines' ? node.lineCount : node.byteCount;
    if (val === undefined || val === null) {
      return {
        diffHtml: '<span class="meta-col size-diff empty"></span>',
        totalHtml: '<span class="meta-col size-total empty"></span>',
      };
    }
    const totalStr = nodeSizeMetric === 'lines' ? fmtLines(val) : fmtBytes(val);
    const totalHtml = '<span class="meta-col size-total">' + totalStr + '</span>';
    // 蝓ｺ貅悶ヮ繝ｼ繝芽・霄ｫ or 蝓ｺ貅悶′蜿悶ｌ縺ｪ縺・ｴ蜷・ 邨ｶ蟇ｾ蛟､繧定｡ｨ遉ｺ
    if (!refNode || node.id === refNode.id) {
      return { diffHtml: '<span class="meta-col size-diff empty"></span>', totalHtml };
    }
    const ref = nodeSizeMetric === 'lines' ? refNode.lineCount : refNode.byteCount;
    if (ref === undefined || ref === null) {
      return { diffHtml: '<span class="meta-col size-diff empty"></span>', totalHtml };
    }
    const delta = val - ref;
    const cls = delta > 0 ? 'plus' : delta < 0 ? 'minus' : '';
    const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
    const diffValue = nodeSizeMetric === 'lines'
      ? fmtLines(Math.abs(delta))
      : (delta !== 0 ? fmtBytes(Math.abs(delta)) : '0 B');
    const diffHtml = '<span class="meta-col size-diff ' + cls + '">' + sign + diffValue + '</span>';
    return { diffHtml, totalHtml };
  }

  let focusedIndex = -1;
  let nodeEls = [];
  let nodeIds = [];
  let ensureNodeRendered = null;
  let updateVirtualRows = null;
  let scrollFrame = 0;
  function scheduleVirtualRows() {
    if (scrollFrame) { return; }
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (updateVirtualRows) { updateVirtualRows(); }
    });
  }
  window.addEventListener('scroll', scheduleVirtualRows, { passive: true });
  window.addEventListener('resize', scheduleVirtualRows);
  let treeMap = {};
  let contextMenuNodeId = null;

  function syncMetricColumnWidths() {
    const root = document.documentElement;
    if (!root) { return; }
    const measure = (selector) => {
      let max = 0;
      document.querySelectorAll(selector).forEach((el) => {
        const width = el instanceof HTMLElement ? Math.ceil(el.scrollWidth) : 0;
        if (width > max) { max = width; }
      });
      return max;
    };
    const diffWidth = measure('.size-diff');
    const totalWidth = measure('.size-total');
    const timeWidth = measure('.time');
    root.style.setProperty('--diff-col-width', diffWidth > 0 ? diffWidth + 'px' : 'auto');
    root.style.setProperty('--total-col-width', totalWidth > 0 ? totalWidth + 'px' : 'auto');
    root.style.setProperty('--time-col-width', timeWidth > 0 ? timeWidth + 'px' : 'auto');
  }

  function isHelpVisible() {
    return document.getElementById('help-overlay')?.classList.contains('visible') === true;
  }

  function setHelpVisible(visible) {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) { return; }
    overlay.classList.toggle('visible', visible);
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function hideContextMenu() {
    const menu = document.getElementById('context-menu');
    if (!menu) { return; }
    menu.classList.remove('visible');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = '';
    contextMenuNodeId = null;
  }

  function showContextMenu(nodeId, clientX, clientY) {
    const node = treeMap[nodeId];
    const menu = document.getElementById('context-menu');
    if (!node || !menu) { return; }
    contextMenuNodeId = nodeId;
    const canDiffWithCurrent = !!sourceUri && nodeId !== currentId;
    const pinLabel = node.pinned ? i18n.contextUnpin : i18n.contextPin;
    menu.innerHTML =
      '<div class="context-menu-title"><span class="context-menu-title-icon">&#9998;</span><span>' + escHtml(getNodeDisplayLabel(nodeId)) + '</span></div>' +
      '<button class="context-menu-item" data-action="jump">' + escHtml(i18n.contextJump) + '</button>' +
      '<button class="context-menu-item" data-action="diff-current"' + (canDiffWithCurrent ? '' : ' disabled') + '>' + escHtml(i18n.contextDiffCurrent) + '</button>' +
      '<button class="context-menu-item" data-action="set-base">' + escHtml(i18n.contextSetBase) + '</button>' +
      '<div class="context-menu-sep"></div>' +
      '<button class="context-menu-item" data-action="toggle-pin">' + escHtml(pinLabel) + '</button>' +
      '<button class="context-menu-item" data-action="edit-note">' + escHtml(i18n.contextEditNote) + '</button>' +
      '<button class="context-menu-item" data-action="display-settings">' + escHtml(i18n.contextDisplaySettings) + '</button>';
    menu.classList.add('visible');
    menu.setAttribute('aria-hidden', 'false');
    menu.style.left = '0px';
    menu.style.top = '0px';
    const padding = 8;
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 160;
    const left = Math.min(clientX, Math.max(padding, window.innerWidth - menuWidth - padding));
    const top = Math.min(clientY, Math.max(padding, window.innerHeight - menuHeight - padding));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
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
    baseLabel.setAttribute('aria-live', 'polite');
    currentButton.classList.toggle('active', diffCompareMode === 'current');
    pairButton.classList.toggle('active', diffCompareMode === 'pair');
    if (mode !== 'diff') {
      baseLabel.textContent = '';
      baseLabel.title = '';
      syncStickyOffsets();
      return;
    }
    if (diffCompareMode === 'pair') {
      if (diffBaseNodeId !== null && treeMap[diffBaseNodeId]) {
        baseLabel.textContent = i18n.basePrefix + getNodeDisplayLabel(diffBaseNodeId) + ' · ' + formatNodeDate(treeMap[diffBaseNodeId]);
      } else {
        baseLabel.textContent = i18n.pairDiffNeedsBase;
      }
      const current = focusedIndex >= 0 ? treeMap[nodeIds[focusedIndex]] : undefined;
      baseLabel.textContent = diffBaseNodeId !== null && current && current.id !== diffBaseNodeId
        ? i18n.leftPairComparison.replace('{0}', getNodeDisplayLabel(diffBaseNodeId) + ' · ' + formatNodeDate(treeMap[diffBaseNodeId])).replace('{1}', getNodeDisplayLabel(current.id) + ' · ' + formatNodeDate(current))
        : baseLabel.textContent;
      baseLabel.title = baseLabel.textContent;
      syncStickyOffsets();
      return;
    }
    const current = focusedIndex >= 0 ? treeMap[nodeIds[focusedIndex]] : undefined;
    baseLabel.textContent = current && current.id !== currentId
      ? i18n.leftCurrentComparison.replace('{0}', getNodeDisplayLabel(current.id) + ' · ' + formatNodeDate(current))
      : i18n.leftCurrentComparison.replace('{0}', i18n.current + ' · ' + (treeMap[currentId] ? formatNodeDate(treeMap[currentId]) : ''));
    baseLabel.title = baseLabel.textContent;
    syncStickyOffsets();
  }

  function formatNodeDate(node) {
    return node ? new Date(node.timestamp).toLocaleString() : '';
  }

  function syncStickyOffsets() {
    const actions = document.querySelector('.actions');
    const diffTools = document.getElementById('diff-tools');
    const historyTools = document.getElementById('history-tools');
    const actionsHeight = actions?.offsetHeight ?? 42;
    const diffHeight = diffTools?.classList.contains('visible') ? diffTools.offsetHeight + 6 : 0;
    if (diffTools) { diffTools.style.top = actionsHeight + 'px'; }
    if (historyTools) { historyTools.style.top = (actionsHeight + diffHeight) + 'px'; }
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

  function applyFocusStyles() {
    nodeEls.forEach((el, i) => {
      const isFocused = i === focusedIndex;
      const nodeId = nodeIds[i];
      el.tabIndex = isFocused ? 0 : -1;
      el.setAttribute('aria-selected', isFocused ? 'true' : 'false');
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
  }

  function setFocused(idx, focusNode = false, suppressPreview = false) {
    focusedIndex = idx;
    if (idx >= 0 && ensureNodeRendered) { ensureNodeRendered(idx); }
    applyFocusStyles();
    if (idx >= 0 && nodeEls[idx]) {
      const tools = document.getElementById('diff-tools');
      const actions = document.querySelector('.actions');
      const historyTools = document.getElementById('history-tools');
      const margin = (actions?.offsetHeight ?? 42) + (tools?.classList.contains('visible') ? tools.offsetHeight + 8 : 0) +
        (historyTools?.classList.contains('visible') ? historyTools.offsetHeight + 8 : 8);
      nodeEls[idx].style.scrollMarginTop = margin + 'px';
      nodeEls[idx].scrollIntoView({ block: 'nearest' });
      if (focusNode) { nodeEls[idx].focus(); }
    }
    renderDiffTools();
    if (!suppressPreview) { previewDiffForFocused(); }
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
    else { send('jumpToNode', { nodeId, sourceUri, focusEditor: true }); }
  }

  function moveToNoted(dir) {
    if (nodeIds.length === 0) { return; }
    const start = focusedIndex < 0 ? 0 : focusedIndex;
    for (let i = 1; i <= nodeIds.length; i++) {
      const idx = (start + i * dir + nodeIds.length * 10) % nodeIds.length;
      if (treeMap[nodeIds[idx]]?.note) { setFocused(idx, true); return; }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && contextMenuNodeId !== null) {
      e.preventDefault();
      hideContextMenu();
      return;
    } else if (e.key === 'Escape' && isHelpVisible()) {
      e.preventDefault();
      setHelpVisible(false);
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { return; }
    const tree = document.getElementById('tree');
    if (!tree || !tree.contains(e.target) || e.target.closest('button, input, textarea, select')) { return; }
    if (e.ctrlKey || e.metaKey || e.altKey) { return; }
    if (e.key === 'Escape' && mode === 'diff') {
      e.preventDefault(); send('toggleMode');
    } else if (e.key === '?') {
      e.preventDefault();
      setHelpVisible(!isHelpVisible());
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setFocused(Math.min(focusedIndex < 0 ? 0 : focusedIndex + 1, nodeIds.length - 1), true);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setFocused(Math.max(focusedIndex < 0 ? nodeIds.length - 1 : focusedIndex - 1, 0), true);
    } else if (e.key === 'Home') {
      e.preventDefault(); setFocused(0, true);
    } else if (e.key === 'End') {
      e.preventDefault(); setFocused(nodeIds.length - 1, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); jumpFocused();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (focusedIndex >= 0) {
        const node = treeMap[nodeIds[focusedIndex]];
        const parentId = node?.parents?.[node.parents.length - 1];
        const idx = parentId !== undefined ? nodeIds.indexOf(parentId) : -1;
        if (idx >= 0) { setFocused(idx, true); }
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (focusedIndex >= 0) {
        const node = treeMap[nodeIds[focusedIndex]];
        const childId = node?.children?.[node.children.length - 1];
        const idx = childId !== undefined ? nodeIds.indexOf(childId) : -1;
        if (idx >= 0) { setFocused(idx, true); }
      }
    } else if (e.key === 'u') {
      e.preventDefault(); send('undo', { sourceUri });
    } else if (e.key === 'r') {
      e.preventDefault(); send('redo', { sourceUri });
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
  document.addEventListener('click', (event) => {
    const menu = document.getElementById('context-menu');
    if (!menu) { return; }
    if (!menu.contains(event.target)) {
      hideContextMenu();
    }
  });
  document.addEventListener('scroll', () => hideContextMenu(), true);
  window.addEventListener('resize', () => hideContextMenu());
  const contextMenu = document.getElementById('context-menu');
  if (contextMenu) {
    contextMenu.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      if (!target || contextMenuNodeId === null) { return; }
      const nodeId = contextMenuNodeId;
      const action = target.getAttribute('data-action');
      hideContextMenu();
      if (action === 'jump') {
        send('jumpToNode', { nodeId, sourceUri });
      } else if (action === 'diff-current' && nodeId !== currentId && sourceUri) {
        send('diffWithNode', { nodeId, sourceUri });
      } else if (action === 'set-base') {
        setDiffBaseNode(nodeId);
      } else if (action === 'toggle-pin') {
        send('togglePin', { nodeId, sourceUri });
      } else if (action === 'edit-note') {
        send('editNote', { nodeId, sourceUri });
      } else if (action === 'display-settings') {
        send('openDisplaySettings');
      }
    });
  }

  function buildTree(nodes, currentId, nextRootId, preferredFocusId) {
    const treeContainer = document.getElementById('tree');
    const restoreTreeFocus = !!treeContainer && (treeContainer === document.activeElement || treeContainer.contains(document.activeElement));
    const focusedBeforeBuild = focusedIndex >= 0 ? nodeIds[focusedIndex] : undefined;
    ensureNodeRendered = null;
    updateVirtualRows = null;
    if (!nodes || nodes.length === 0) {
      nodeEls = [];
      nodeIds = [];
      treeMap = {};
      document.getElementById('tree').innerHTML = '<div class="empty">' + i18n.textEditorsOnly + '</div>';
      return;
    }
    rootId = typeof nextRootId === 'number' ? nextRootId : 0;

    const map = {};
    nodes.forEach((node) => { map[node.id] = node; });
    treeMap = map;
    if (searchMetadataCache.size > nodes.length) {
      for (const cachedId of searchMetadataCache.keys()) {
        if (!map[cachedId]) { searchMetadataCache.delete(cachedId); }
      }
    }
    const latestId = nodes.reduce((best, n) => n.timestamp > map[best].timestamp ? n.id : best, nodes[0].id);
    const pinnedContainer = document.getElementById('pinned');
    const container = document.getElementById('tree');
    const virtual = nodes.length > 500;
    const query = (document.getElementById('history-search')?.value ?? '').trim().toLocaleLowerCase();
    const onlyPinned = !!document.getElementById('pinned-only')?.checked;
    const filterActive = query.length > 0 || onlyPinned;
    const isMatch = (node) => {
      if (!query) { return !onlyPinned || !!node.pinned; }
      const signature = JSON.stringify([node.timestamp, node.note ?? '', node.formattedTime ?? '']);
      let cached = searchMetadataCache.get(node.id);
      if (!cached || cached.signature !== signature) {
        const date = new Date(node.timestamp);
        const localDate = String(date.getFullYear()).padStart(4, '0') + '-' +
          String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const localTime = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
        cached = {
          signature,
          text: [node.note ?? '', node.formattedTime ?? '', localDate, localDate + ' ' + localTime, date.toISOString()]
            .join(' ').toLocaleLowerCase(),
        };
        searchMetadataCache.set(node.id, cached);
      }
      return cached.text.includes(query) && (!onlyPinned || !!node.pinned);
    };
    const matchedCount = filterActive ? nodes.reduce((count, node) => count + (isMatch(node) ? 1 : 0), 0) : nodes.length;
    const filterStatus = document.getElementById('filter-status');
    if (filterStatus) {
      filterStatus.textContent = filterActive
        ? (matchedCount ? i18n.matchingCount.replace('{0}', String(matchedCount)).replace('{1}', String(nodes.length)) : i18n.noMatches)
        : '';
    }
    const currentIndicator = document.getElementById('current-indicator');
    if (currentIndicator) {
      const currentVisible = !filterActive || (map[currentId] && isMatch(map[currentId]));
      currentIndicator.textContent = currentVisible
        ? (mode === 'diff' ? i18n.diffMode : i18n.navigateMode) + ' · ' + i18n.current
        : i18n.currentHidden;
      currentIndicator.setAttribute('aria-live', 'polite');
    }
    container.classList.toggle('virtual-tree', virtual);
    container.classList.remove('plain-view');
    pinnedContainer.innerHTML = '';
    container.innerHTML = '';
    nodeEls = [];
    nodeIds = [];

    const cur = map[currentId];
    document.getElementById('btn-undo').disabled = !cur || cur.parents.length === 0;
    document.getElementById('btn-redo').disabled = !cur || cur.children.length === 0;

    if (nodeSizeMetric !== 'none' || nodes.some((node) => node.formattedTime)) {
        const header = document.createElement('div');
        header.className = 'tree-header';
        header.innerHTML =
          '<span class="label-col">' + escHtml(i18n.headerNode) + '</span>' +
          '<span class="right-area"><span class="metrics">' +
          (nodeSizeMetric !== 'none' ? '<span class="meta-col size-diff">' + escHtml(i18n.headerDiff) + '</span>' : '<span class="meta-col size-diff empty"></span>') +
          (nodeSizeMetric !== 'none' ? '<span class="meta-col size-total">' + escHtml(nodeSizeMetric === 'lines' ? i18n.headerLines : i18n.headerSize) + '</span>' : '<span class="meta-col size-total empty"></span>') +
          (nodes.some((node) => node.formattedTime) ? '<span class="time">' + escHtml(i18n.headerTime) + '</span>' : '<span class="time empty"></span>') +
          '</span></span>';
      container.appendChild(header);
    }

    const visitedNodes = new Set();

    const pinnedNodes = filterActive ? [] : nodes.filter((node) => node.id !== rootId && node.pinned);
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
            '<span class="pin-mark" data-node-id="' + node.id + '" title="' + escHtml(i18n.contextUnpin) + '" aria-label="' + escHtml(i18n.contextUnpin) + '"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 9.9 5.7l4.3.6-3.1 3 0.7 4.2L8 11.5l-3.8 2 0.7-4.2-3.1-3 4.3-.6L8 1.8Z" fill="currentColor"/></svg></span>' +
            '<span class="pinned-label">' + escHtml(node.note || node.label) + '</span>' +
            (node.formattedTime ? '<span class="right-area"><span class="metrics"><span class="meta-col size-diff empty"></span><span class="meta-col size-total empty"></span><span class="time">' + escHtml(node.formattedTime) + '</span></span></span>' : '');
          row.addEventListener('click', () => {
            const idx = nodeIds.indexOf(node.id);
            if (idx >= 0) { setFocused(idx); }
            if (mode !== 'diff') {
              send('jumpToNode', { nodeId: node.id, sourceUri });
            }
          });
          row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            const idx = nodeIds.indexOf(node.id);
            if (idx >= 0) { setFocused(idx); }
            showContextMenu(node.id, event.clientX, event.clientY);
          });
          const pinToggle = row.querySelector('.pin-mark');
          if (pinToggle) {
            pinToggle.addEventListener('click', (event) => {
              event.stopPropagation();
              send('togglePin', { nodeId: node.id, sourceUri });
            });
          }
          wrap.appendChild(row);
        });
      pinnedContainer.appendChild(wrap);
    }

    function renderSegment(kind) {
      switch (kind) {
        case 'pipe':
          return '<svg class="graph-segment" viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0 L6 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/></svg>';
        case 'tee':
          return '<svg class="graph-segment" viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0 L6 14 M6 7 L12 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/></svg>';
        case 'elbow':
          return '<svg class="graph-segment" viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0 L6 7 M6 7 L12 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/></svg>';
        default:
          return '<svg class="graph-segment" viewBox="0 0 12 14" aria-hidden="true"></svg>';
      }
    }

    const traversal = [{ id: rootId, prefixParts: [], isLast: false, parentChildCount: 0, level: 1 }];
    function renderNode(id, prefixParts, isLast, parentChildCount, index) {
      const node = map[id];
      if (!node) {
        return;
      }

      const isCurrent = node.id === currentId;
      const isRoot = id === rootId;
      const storageKind =
        node.storage?.kind === 'full' ? 'F' :
        node.storage?.kind === 'delta' ? 'D' :
        '';
      const isDirectBranchChild = !isRoot && parentChildCount > 1;
      const graphHtml = filterActive ? '' : prefixParts.map(renderSegment).join('') +
        (!isRoot ? renderSegment(isDirectBranchChild ? (isLast ? 'elbow' : 'tee') : (node.children.length === 1 ? 'tee' : 'elbow')) : '');

      const div = document.createElement('div');
      div.className = 'node' + (isCurrent ? ' current' : '');
      div.setAttribute('role', 'treeitem');
      div.setAttribute('aria-level', String(entries[index].level));
      div.setAttribute('aria-current', isCurrent ? 'location' : 'false');
      div.setAttribute('aria-label', [node.note || node.label, node.formattedTime, isCurrent ? i18n.current : ''].filter(Boolean).join(', '));
      div.title = mode === 'diff' ? i18n.titleClickDiff : i18n.titleClickJump;
      const noteHtml = node.note
        ? '<span class="note note-text" data-node-id="' + node.id + '" title="' + escHtml(node.note) + i18n.noteDoubleClickToEdit + '">' + escHtml(node.note) + '</span>' +
          '<span class="note-edit note-action" data-node-id="' + node.id + '" title="' + i18n.contextEditNote + '">&#9998;</span>'
        : '<span class="note-edit note-action" data-node-id="' + node.id + '" title="' + i18n.noteAdd + '">&#9998;</span>';
      const graphWrapHtml = graphHtml
        ? '<span class="graph">' + graphHtml + '</span>'
        : '';
      const parentId = node.parents?.length ? node.parents[node.parents.length - 1] : undefined;
      const refNode = nodeSizeMetricBase === 'current'
        ? ((isCurrent && node.id !== 0) ? node : map[currentId])
        : nodeSizeMetricBase === 'initial'
          ? map[nodes[0].id]
          : parentId !== undefined
            ? map[parentId]
            : null;
      const sizeParts = formatSizeDiff(node, refNode);
      const labelHtml = node.note ? '' : '<span class="label">' + escHtml(node.label) + '</span>';
      div.innerHTML =
        graphWrapHtml +
        (isCurrent ? '<span class="current-badge">' + escHtml(i18n.current) + '</span>' : '') +
        labelHtml +
        (mode === 'diff' && diffCompareMode === 'pair' && node.id === diffBaseNodeId ? '<span class="diff-base-badge">' + escHtml(i18n.badgeBase) + '</span>' : '') +
        (mode === 'diff' && ((diffCompareMode === 'current' && !isCurrent) || (diffCompareMode === 'pair' && node.id !== diffBaseNodeId)) ? '<span class="diff-target-badge">' + escHtml(i18n.badgeDiff) + '</span>' : '') +
        (node.isEmpty ? '<span class="empty-badge">(empty)</span>' : '') +
        noteHtml +
        (showStorageKind && storageKind ? '<span class="storage">' + storageKind + '</span>' : '') +
        '<span class="right-area"><span class="metrics">' + sizeParts.diffHtml + sizeParts.totalHtml + (node.formattedTime ? '<span class="time' + (node.id === latestId ? ' latest' : '') + '">' + escHtml(node.formattedTime) + '</span>' : '<span class="time empty"></span>') + '</span></span>';
      const noteAction = div.querySelector('.note-action');
      if (noteAction) {
        noteAction.addEventListener('click', (event) => {
          event.stopPropagation();
          send('editNote', { nodeId: node.id, sourceUri });
        });
      }
      const noteText = div.querySelector('.note-text');
      if (noteText) {
        noteText.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          send('editNote', { nodeId: node.id, sourceUri });
        });
      }
      div.addEventListener('click', () => {
        hideContextMenu();
        const idx = nodeIds.indexOf(node.id);
        if (idx >= 0) { setFocused(idx, true); }
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
            send('jumpToNode', { nodeId: node.id, sourceUri });
          }
        }
      });
      div.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const idx = nodeIds.indexOf(node.id);
        if (idx >= 0) { setFocused(idx); }
        showContextMenu(node.id, event.clientX, event.clientY);
      });
      nodeEls[index] = div;
      return div;
    }

        const entries = [];
        while (traversal.length > 0) {
          const entry = traversal.pop();
          if (visitedNodes.has(entry.id) || !map[entry.id]) { continue; }
          visitedNodes.add(entry.id);
          if (!filterActive || isMatch(map[entry.id])) {
            entries.push(filterActive ? { ...entry, prefixParts: [], level: 1 } : entry);
            nodeIds.push(entry.id);
          }
          const node = map[entry.id];
          const isRoot = entry.id === rootId;
          const isDirectBranchChild = !isRoot && entry.parentChildCount > 1;
          const isBranchParent = !isRoot && node.children.length > 1;
          const prefixParts = entry.prefixParts;
          const isLast = entry.isLast;
          const childPrefix = (isDirectBranchChild || isBranchParent)
            ? [...prefixParts, isLast ? 'blank' : 'pipe'] : prefixParts;
          for (let i = node.children.length - 1; i >= 0; i--) {
            traversal.push({ id: node.children[i], prefixParts: childPrefix,
              isLast: i === node.children.length - 1, parentChildCount: node.children.length, level: entry.level + 1 });
          }
        }
        if (entries.length === 0) {
          container.innerHTML = filterActive ? '<div class="empty">' + escHtml(i18n.noMatches) + '</div>' : '';
          nodeEls = [];
          nodeIds = [];
          setFocused(-1, false, true);
          return;
        }
        nodeEls = new Array(entries.length);
        const rows = document.createElement('div');
        container.appendChild(rows);
        let renderedStart = -1;
        let renderedEnd = -1;
        function renderRows(start, end) {
          if (start === renderedStart && end === renderedEnd) { return; }
          renderedStart = start;
          renderedEnd = end;
          nodeEls = new Array(entries.length);
          const fragment = document.createDocumentFragment();
          function spacer(height) {
            const div = document.createElement('div');
            div.style.height = height + 'px';
            div.setAttribute('aria-hidden', 'true');
            fragment.appendChild(div);
          }
          if (virtual) { spacer(start * 22); }
          for (let index = start; index < end; index++) {
            const entry = entries[index];
            fragment.appendChild(renderNode(entry.id, entry.prefixParts, entry.isLast, entry.parentChildCount, index));
          }
          if (virtual) { spacer((entries.length - end) * 22); }
          const focusedNodeWasActive = rows.contains(document.activeElement);
          rows.replaceChildren(fragment);
          applyFocusStyles();
          syncMetricColumnWidths();
          if (focusedNodeWasActive) {
            const focusedElement = nodeEls[focusedIndex];
            if (focusedElement) { focusedElement.focus(); }
            else { container.focus(); }
          }
        }
        if (virtual) {
          const count = () => Math.ceil(window.innerHeight / 22) + 40;
          ensureNodeRendered = (index) => {
            if (index >= renderedStart && index < renderedEnd) { return; }
            const start = Math.max(0, Math.min(index - 20, entries.length - count()));
            renderRows(start, Math.min(entries.length, start + count()));
          };
          updateVirtualRows = () => {
            const first = Math.floor(-rows.getBoundingClientRect().top / 22);
            const start = Math.max(0, Math.min(first - 20, entries.length - count()));
            renderRows(start, Math.min(entries.length, start + count()));
          };
          ensureNodeRendered(Math.max(0, nodeIds.indexOf(currentId)));
        } else {
          renderRows(0, entries.length);
        }

        const currentEl = container.querySelector('.node.current');
        if (currentEl) { currentEl.scrollIntoView({ block: 'nearest' }); }
      const focusId = preferredFocusId !== undefined && nodeIds.includes(preferredFocusId) ? preferredFocusId :
        preferredFocusId === undefined && focusedBeforeBuild !== undefined && nodeIds.includes(focusedBeforeBuild) ? focusedBeforeBuild :
        nodeIds.includes(currentId) ? currentId : nodeIds[0];
      setFocused(nodeIds.indexOf(focusId), restoreTreeFocus, true);
        renderDiffTools();
      }

  function renderNotTracked(ext, reason) {
    const treeEl = document.getElementById('tree');
    const pinnedEl = document.getElementById('pinned');
    if (pinnedEl) { pinnedEl.innerHTML = ''; }
    treeEl.classList.add('plain-view');
    if (reason === 'size' || reason === 'binary') {
      treeEl.innerHTML = '<div class="msg">' + escHtml(reason === 'size' ? i18n.tooLarge : i18n.binaryFile) + '</div>' +
        (reason === 'size' ? '<div class="hint">' + escHtml(i18n.largeFileWarning) + '</div><button class="btn" id="track-large-file-btn">' + escHtml(i18n.trackLargeFile) + '</button><div class="hint">' + escHtml(i18n.tooLargeHint) + '</div><button class="btn" id="open-size-settings-btn">' + escHtml(i18n.openSettings) + '</button>' : '');
      document.getElementById('track-large-file-btn')?.addEventListener('click', () => send('trackLargeFile'));
      document.getElementById('open-size-settings-btn')?.addEventListener('click', () => send('openSizeSettings'));
      nodeEls = []; nodeIds = []; treeMap = {};
      return;
    }
    if (reason === 'excludePattern') {
      treeEl.innerHTML =
        '<div class="msg">' + escHtml(i18n.excludedByPattern) + '</div>' +
        '<div class="hint">' + escHtml(i18n.excludedByPatternHint) + '</div>' +
        '<button class="btn" id="open-exclude-settings-btn">' + escHtml(i18n.editExcludePatterns) + '</button>';
      document.getElementById('open-exclude-settings-btn')?.addEventListener('click', () => send('openExcludeSettings'));
      nodeEls = [];
      nodeIds = [];
      treeMap = {};
      return;
    }
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
    ensureNodeRendered = null;
    updateVirtualRows = null;
    const previousSourceUri = sourceUri;
    const previousMode = mode;
    const previousCurrentId = currentId;
    const previousFocusedId = focusedIndex >= 0 ? nodeIds[focusedIndex] : undefined;
    const nextSourceUri = state.sourceUri || '';
    const keepFocusedNode = previousSourceUri === nextSourceUri && previousMode === state.mode &&
      previousCurrentId === state.currentId && previousFocusedId !== undefined;
    nodes = state.nodes;
    currentId = state.currentId;
    mode = state.mode;
    timeFormat = state.timeFormat;
    timeFormatCustom = state.timeFormatCustom;
    nodeSizeMetric = state.nodeSizeMetric;
    nodeSizeMetricBase = state.nodeSizeMetricBase;
    showStorageKind = state.showStorageKind;
    colorTheme = state.colorTheme || 'blue';
    if (sourceUri !== nextSourceUri) { searchMetadataCache.clear(); }
    sourceUri = nextSourceUri;
    rootId = typeof state.rootId === 'number' ? state.rootId : 0;
    document.body.setAttribute('data-color-theme', colorTheme);

    if (diffBaseNodeId !== null && !state.nodes?.some((node) => node.id === diffBaseNodeId)) {
      diffBaseNodeId = null;
      if (diffCompareMode === 'pair') {
        diffCompareMode = 'current';
      }
    }

    const pauseButton = document.querySelector('.btn-pause');
    const pauseTitle = state.paused ? ${serializeForInlineScript(tr('Resume tracking'))} : ${serializeForInlineScript(tr('Pause tracking'))};
    pauseButton.innerHTML = state.paused ? '<span class="icon-glyph">&#9654;</span>' : '<span class="icon-glyph">&#10074;&#10074;</span>';
    pauseButton.title = pauseTitle;
    pauseButton.setAttribute('aria-label', pauseTitle);

    const modeButton = document.querySelector('.btn-mode');
    const modeTitle = mode === 'navigate' ? ${serializeForInlineScript(tr('Switch to Diff mode'))} : ${serializeForInlineScript(tr('Switch to Navigate mode'))};
    modeButton.textContent = mode === 'navigate' ? ${serializeForInlineScript(tr('Navigate'))} : ${serializeForInlineScript(tr('Diff'))};
    modeButton.title = modeTitle;
    modeButton.setAttribute('aria-label', modeTitle);
    modeButton.setAttribute('aria-pressed', mode === 'diff' ? 'true' : 'false');
    modeButton.classList.toggle('active', mode === 'diff');
    document.body.setAttribute('data-mode', mode);

    let pausedBadge = document.querySelector('.paused-badge');
    if (state.paused) {
      if (!pausedBadge) {
        pausedBadge = document.createElement('div');
        pausedBadge.className = 'paused-badge';
        document.querySelector('.actions').insertAdjacentElement('afterend', pausedBadge);
      }
      pausedBadge.textContent = ${serializeForInlineScript(tr('Tracking paused - history is frozen'))};
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
      diffBadge.textContent = ${serializeForInlineScript(tr('Diff mode - select a node to compare, then use ↑/↓ to keep reviewing'))};
    } else if (diffBadge) {
      diffBadge.remove();
    }
    renderDiffTools();

    const overlay = document.getElementById('jump-overlay');
    if (overlay) { overlay.remove(); }
    const treeEl = document.getElementById('tree');
    if (treeEl) { treeEl.style.opacity = '1'; treeEl.style.pointerEvents = ''; }
    const historyTools = document.getElementById('history-tools');
    if (historyTools) {
      const visible = state.view === 'tree' && searchExpanded;
      historyTools.hidden = !visible;
      historyTools.classList.toggle('visible', visible);
    }
    syncStickyOffsets();

    if (state.view === 'loading') {
      document.getElementById('pinned').innerHTML = '';
      document.getElementById('tree').innerHTML = '<div class="empty">' + i18n.loading + '</div>';
      nodeEls = [];
      nodeIds = [];
      treeMap = {};
      return;
    }
    if (state.view === 'notTracked') {
      renderNotTracked(state.notTrackedExt || '', state.notTrackedReason || 'extension');
      return;
    }
    buildTree(state.nodes, state.currentId, rootId, keepFocusedNode ? previousFocusedId : state.currentId);
  }

  renderState({
    view: ${serializeForInlineScript(initialView)},
    nodes,
    currentId,
    paused: ${serializeForInlineScript(paused)},
    mode,
    timeFormat,
    timeFormatCustom,
    nodeSizeMetric,
    nodeSizeMetricBase,
    showStorageKind,
    colorTheme,
    notTrackedExt: ${serializeForInlineScript(initialNotTrackedExt)},
    notTrackedReason: ${serializeForInlineScript(initialNotTrackedReason)},
    sourceUri,
    rootId
  });
</script>
</body>
</html>`;
    }
}
