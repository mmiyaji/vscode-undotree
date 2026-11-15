'use strict';

import { matchesGlob, matchesPathGlob } from './glob';

export const DEFAULT_ENABLED_EXTENSIONS = [
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro',
    '.py', '.pyw', '.go', '.rs', '.java', '.c', '.h', '.cc', '.hh', '.cpp', '.hpp', '.cxx', '.hxx', '.cs',
    '.rb', '.rake', '.php', '.swift', '.kt', '.kts', '.dart', '.lua', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
    '.r', '.jl', '.pl', '.pm', '.scala', '.sc', '.clj', '.cljs', '.cljc', '.edn', '.ex', '.exs', '.erl', '.hrl', '.fs', '.fsx', '.fsi', '.hs',
    '.sql', '.graphql', '.gql', '.proto', '.tf', '.tfvars', '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cmake',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xml', '.xsd', '.xsl', '.xaml', '.svg',
    '.txt', '.md', '.mdx', '.rst', '.adoc', '.asciidoc', '.tex', '.org', '.properties', '.conf', '.config',
];

// Exact basenames only. Keep file extensions in enabledExtensions, where users can
// enable a whole class of files intentionally.
export const DEFAULT_ENABLED_FILE_NAMES = [
    'Dockerfile', 'Containerfile', 'Makefile', 'GNUmakefile', 'justfile', 'Taskfile',
    'README', 'LICENSE', 'COPYING', 'NOTICE', 'AUTHORS', 'CONTRIBUTING', 'CHANGELOG',
    '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.dockerignore',
    '.npmrc', '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions',
    '.bashrc', '.bash_profile', '.zshrc', '.profile', '.inputrc', '.npmignore',
];

export const DEFAULT_EXCLUDE_PATTERNS = [
    '**/.git/**', '**/.hg/**', '**/.svn/**', '**/node_modules/**', '**/bower_components/**',
    '**/vendor/**', '**/dist/**', '**/build/**', '**/out/**', '**/target/**', '**/coverage/**',
    '**/.next/**', '**/.nuxt/**', '**/.output/**', '**/.cache/**', '**/.turbo/**', '**/.venv/**', '**/venv/**',
    '*.min.*', '*.map', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'bun.lock', 'bun.lockb',
    '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
];

export const DEFAULT_MAX_TRACKED_FILE_CHARS = 1_000_000;
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tif', '.tiff', '.heic',
    '.pdf', '.zip', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.zst',
    '.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.a', '.lib', '.class', '.jar', '.wasm',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.webm', '.mov',
    '.sqlite', '.sqlite3', '.db', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.bin',
]);

export function usesTextTracking(settings: TrackingSettings): boolean {
    return settings.trackingMode === 'text' || (settings.trackingMode !== 'listed'
        && !settings.extensionsExplicit && !settings.fileNamesExplicit);
}

export function looksBinary(sample: string): boolean {
    let controls = 0;
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        if (code === 0) { return true; }
        if ((code < 32 && ![9, 10, 12, 13].includes(code)) || code === 127) { controls++; }
    }
    return controls > 0 && controls / sample.length > 0.01;
}

export interface TrackingSettings {
    trackingMode?: 'auto' | 'text' | 'listed';
    maxTrackedFileChars?: number;
    enabledExtensions: string[];
    enabledFileNames: string[];
    excludePatterns: string[];
    /** True when enabledExtensions has a user/workspace value, rather than only its manifest default. */
    extensionsExplicit?: boolean;
    /** True when enabledFileNames has a user/workspace value. */
    fileNamesExplicit?: boolean;
}

export interface TrackingInput {
    scheme: string;
    fileName: string;
    relativePath?: string;
    characterCount?: number;
    textSample?: string;
}

export type TrackingStatus = { tracked: boolean; reason: '' | 'extension' | 'excludePattern' | 'scheme' | 'binary' | 'size'; extension: string; fileName: string; matchedBy: '' | 'fileName' | 'extension' | 'text' };

export function getTrackingStatus(input: TrackingInput, settings: TrackingSettings): TrackingStatus {
    const fileName = basename(input.fileName);
    const extension = extensionOf(fileName);
    if (input.scheme !== 'file') {
        return { tracked: false, reason: 'scheme', extension, fileName, matchedBy: '' };
    }

    const relativePath = normalizePath(input.relativePath || fileName);
    if (settings.excludePatterns.some(pattern => matchesExcludePattern(input.fileName, relativePath, pattern))) {
        return { tracked: false, reason: 'excludePattern', extension, fileName, matchedBy: '' };
    }

    if (BINARY_EXTENSIONS.has(extension) || (input.textSample !== undefined && looksBinary(input.textSample))) {
        return { tracked: false, reason: 'binary', extension, fileName, matchedBy: '' };
    }
    const limit = settings.maxTrackedFileChars ?? DEFAULT_MAX_TRACKED_FILE_CHARS;
    if (limit > 0 && input.characterCount !== undefined && input.characterCount > limit) {
        return { tracked: false, reason: 'size', extension, fileName, matchedBy: '' };
    }
    if (usesTextTracking(settings)) {
        return { tracked: true, reason: '', extension, fileName, matchedBy: 'text' };
    }

    const filenameSettings = settings.fileNamesExplicit || !settings.extensionsExplicit
        ? settings.enabledFileNames
        : [];
    const filenameEnabled = filenameSettings.some(name => name.toLowerCase() === fileName.toLowerCase());
    const extensionEnabled = settings.enabledExtensions.some(value => normalizeExtension(value) === extension);
    const tracked = filenameEnabled || extensionEnabled;
    return { tracked, reason: tracked ? '' : 'extension', extension, fileName, matchedBy: filenameEnabled ? 'fileName' : extensionEnabled ? 'extension' : '' };
}

export function isExcluded(input: TrackingInput, patterns: string[]): boolean {
    const fileName = basename(input.fileName);
    const relativePath = normalizePath(input.relativePath || fileName);
    return patterns.some(pattern => matchesExcludePattern(input.fileName, relativePath, pattern));
}

function matchesExcludePattern(fileName: string, relativePath: string, rawPattern: string): boolean {
    const pattern = rawPattern.trim().replace(/\\/g, '/');
    if (!pattern) { return false; }
    if (!pattern.includes('/')) {
        // Preserve the historic basename-only meaning of slashless patterns.
        return matchesGlob(basename(fileName), pattern);
    }
    const rootedPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    return matchesPathGlob(relativePath, rootedPattern);
}

function basename(value: string): string {
    return value.replace(/\\/g, '/').split('/').pop() || value;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

function normalizeExtension(value: string): string {
    const lower = value.trim().toLowerCase();
    if (!lower) { return ''; }
    return lower.startsWith('.') ? lower : `.${lower}`;
}
