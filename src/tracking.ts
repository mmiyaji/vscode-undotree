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

export interface TrackingSettings {
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
}

export type TrackingStatus = { tracked: boolean; reason: '' | 'extension' | 'excludePattern' | 'scheme'; extension: string; fileName: string; matchedBy: '' | 'fileName' | 'extension' };

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
