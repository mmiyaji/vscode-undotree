import * as vscode from 'vscode';
import {
    DEFAULT_ENABLED_EXTENSIONS, DEFAULT_ENABLED_FILE_NAMES, DEFAULT_EXCLUDE_PATTERNS,
    DEFAULT_MAX_TRACKED_FILE_CHARS, getTrackingStatus, looksBinary, TrackingSettings, TrackingStatus,
} from './tracking';

export function readTrackingSettings(config: vscode.WorkspaceConfiguration): TrackingSettings {
    const explicit = (key: string) => {
        const value = config.inspect?.<unknown>(key);
        return !!value && (value.globalValue !== undefined || value.workspaceValue !== undefined || value.workspaceFolderValue !== undefined);
    };
    const array = (key: string, fallback: string[]) => {
        const value = config.get<string[]>(key, fallback);
        return Array.isArray(value) ? value : fallback;
    };
    const mode = config.get<string>('trackingMode', 'auto');
    const limit = config.get<number>('maxTrackedFileChars', DEFAULT_MAX_TRACKED_FILE_CHARS);
    return {
        trackingMode: mode === 'text' || mode === 'listed' ? mode : 'auto',
        maxTrackedFileChars: typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_MAX_TRACKED_FILE_CHARS,
        enabledExtensions: array('enabledExtensions', DEFAULT_ENABLED_EXTENSIONS),
        enabledFileNames: array('enabledFileNames', DEFAULT_ENABLED_FILE_NAMES),
        excludePatterns: array('excludePatterns', DEFAULT_EXCLUDE_PATTERNS),
        extensionsExplicit: explicit('enabledExtensions'), fileNamesExplicit: explicit('enabledFileNames'),
    };
}

const metadata = new WeakMap<vscode.TextDocument, { version: number; characterCount: number; binary?: boolean }>();
const largeFileOverrides = new WeakSet<vscode.TextDocument>();

export function allowLargeDocumentForSession(document: vscode.TextDocument): void {
    largeFileOverrides.add(document);
}

export function forgetDocumentTracking(document: vscode.TextDocument): void {
    largeFileOverrides.delete(document);
    metadata.delete(document);
}

export function forgetClosedDocumentTracking(documents: readonly vscode.TextDocument[], closedUris: ReadonlySet<string>, openUris: ReadonlySet<string>): vscode.TextDocument[] {
    const closed = documents.filter(document => closedUris.has(document.uri.toString()) && !openUris.has(document.uri.toString()));
    closed.forEach(forgetDocumentTracking);
    return closed;
}

export function evaluateDocumentTracking(document: vscode.TextDocument, relativePath: string, settings: TrackingSettings): TrackingStatus {
    const input = {
        scheme: document.uri.scheme,
        fileName: document.uri.fsPath || document.fileName || document.uri.toString(),
        relativePath,
    };
    // Reject excluded paths and known binaries without reading document text.
    const preflight = getTrackingStatus(input, settings);
    if (!preflight.tracked) { return preflight; }
    let cached = metadata.get(document);
    if (!cached || typeof document.version !== 'number' || cached.version !== document.version) {
        const characterCount = typeof document.offsetAt === 'function' && typeof document.positionAt === 'function'
            ? document.offsetAt(document.positionAt(Number.MAX_SAFE_INTEGER))
            : document.getText().length;
        cached = { version: document.version, characterCount };
        metadata.set(document, cached);
    }
    const limit = settings.maxTrackedFileChars ?? DEFAULT_MAX_TRACKED_FILE_CHARS;
    if (limit > 0 && cached.characterCount > limit && !largeFileOverrides.has(document)) {
        return { ...preflight, tracked: false, reason: 'size', matchedBy: '' };
    }
    if (cached.binary === undefined) {
        let sample: string;
        if (document.positionAt) {
            const headEnd = Math.min(cached.characterCount, 2048);
            const tailStart = Math.max(headEnd, cached.characterCount - 2048);
            sample = document.getText(new vscode.Range(document.positionAt(0), document.positionAt(headEnd)))
                + document.getText(new vscode.Range(document.positionAt(tailStart), document.positionAt(cached.characterCount)));
        } else { sample = document.getText().slice(0, 4096); }
        cached.binary = looksBinary(sample);
    }
    return cached.binary ? { ...preflight, tracked: false, reason: 'binary', matchedBy: '' } : preflight;
}
