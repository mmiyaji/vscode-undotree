import { DEFAULT_ENABLED_EXTENSIONS, DEFAULT_ENABLED_FILE_NAMES, DEFAULT_EXCLUDE_PATTERNS, getTrackingStatus, TrackingSettings } from '../tracking';
import * as fs from 'fs';
import * as path from 'path';

const baseSettings: TrackingSettings = {
    enabledExtensions: DEFAULT_ENABLED_EXTENSIONS,
    enabledFileNames: DEFAULT_ENABLED_FILE_NAMES,
    excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
};

function evaluate(fileName: string, settings = baseSettings, relativePath = fileName, scheme = 'file') {
    return getTrackingStatus({ scheme, fileName, relativePath }, settings);
}

describe('tracking defaults and overrides', () => {
    it('keeps runtime defaults aligned with the extension manifest', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        const properties = manifest.contributes.configuration[0].properties;
        expect(properties['undotree.enabledExtensions'].default).toEqual(DEFAULT_ENABLED_EXTENSIONS);
        expect(properties['undotree.enabledFileNames'].default).toEqual(DEFAULT_ENABLED_FILE_NAMES);
        expect(properties['undotree.excludePatterns'].default).toEqual(DEFAULT_EXCLUDE_PATTERNS);
        expect(properties['undotree.trackingMode'].default).toBe('auto');
        expect(properties['undotree.maxTrackedFileChars'].default).toBe(1_000_000);
    });

    it('tracks common source and documentation extensions by default', () => {
        expect(evaluate('src/app.ts').tracked).toBe(true);
        expect(evaluate('src/main.py').tracked).toBe(true);
        expect(evaluate('notes.mdx').tracked).toBe(true);
    });

    it.each(['data.csv', 'script.custom-language', 'scratch', '.customrc', 'notes.log', 'notebook.ipynb'])('tracks unknown text file %s by default', name => {
        expect(evaluate(name).matchedBy).toBe('text');
    });

    it('supports explicit text and listed modes and filename-only legacy settings', () => {
        expect(evaluate('notes.unknown', { ...baseSettings, trackingMode: 'listed' }).tracked).toBe(false);
        expect(evaluate('notes.unknown', { ...baseSettings, trackingMode: 'text', extensionsExplicit: true }).tracked).toBe(true);
        expect(evaluate('notes.unknown', { ...baseSettings, fileNamesExplicit: true }).tracked).toBe(false);
    });

    it.each(['picture.PNG', 'archive.zip', 'app.wasm', 'font.woff2', 'document.pdf', 'data.sqlite'])('rejects known binary %s even if explicitly listed', name => {
        expect(evaluate(name, { ...baseSettings, enabledFileNames: [name], fileNamesExplicit: true }).reason).toBe('binary');
    });

    it('rejects binary content samples but allows Unicode and normal whitespace', () => {
        const input = { scheme: 'file', fileName: 'text.custom' };
        expect(getTrackingStatus({ ...input, textSample: 'abc\0xyz' }, baseSettings).reason).toBe('binary');
        expect(getTrackingStatus({ ...input, textSample: '\u0001\u0002data' }, baseSettings).reason).toBe('binary');
        expect(getTrackingStatus({ ...input, textSample: '日本語😀\t\r\n\ud800' }, baseSettings).tracked).toBe(true);
    });

    it('enforces the size limit in every mode, permits its boundary and supports opting out', () => {
        for (const trackingMode of ['auto', 'text', 'listed'] as const) {
            const input = { scheme: 'file', fileName: 'notes.md' };
            const settings = { ...baseSettings, trackingMode };
            expect(getTrackingStatus({ ...input, characterCount: 1_000_000 }, settings).tracked).toBe(true);
            expect(getTrackingStatus({ ...input, characterCount: 1_000_001 }, settings).reason).toBe('size');
            expect(getTrackingStatus({ ...input, characterCount: 1_000_001 }, { ...settings, maxTrackedFileChars: 0 }).tracked).toBe(true);
        }
    });

    it('tracks exact extensionless names and dotfiles case insensitively', () => {
        expect(evaluate('Dockerfile').tracked).toBe(true);
        expect(evaluate('makefile').tracked).toBe(true);
        expect(evaluate('.GITIGNORE').tracked).toBe(true);
        expect(evaluate('Taskfile').tracked).toBe(true);
    });

    it('keeps explicit extension lists authoritative and allows explicit filename opt-in', () => {
        const custom = { ...baseSettings, enabledExtensions: ['.md'], extensionsExplicit: true };
        expect(evaluate('Dockerfile', custom).tracked).toBe(false);
        expect(evaluate('README.md', custom).tracked).toBe(true);
        expect(evaluate('Dockerfile', { ...custom, enabledFileNames: ['Dockerfile'], fileNamesExplicit: true }).tracked).toBe(true);
    });

    it('respects an empty explicit extension list unless a filename is enabled', () => {
        const empty = { ...baseSettings, enabledExtensions: [], extensionsExplicit: true };
        expect(evaluate('thing.ts', empty).tracked).toBe(false);
        expect(evaluate('Dockerfile', empty).tracked).toBe(false);
        expect(evaluate('Dockerfile', { ...empty, enabledFileNames: ['Dockerfile'], fileNamesExplicit: true }).tracked).toBe(true);
    });

    it('lets exclusions win and supports rooted, nested, and Windows-style paths', () => {
        const settings = { ...baseSettings, excludePatterns: ['generated/**', '**/cache/**', '**\\vendor\\**'] };
        expect(evaluate('app.ts', settings, 'generated/app.ts').reason).toBe('excludePattern');
        expect(evaluate('app.ts', settings, 'src/generated/app.ts').tracked).toBe(true);
        expect(evaluate('app.ts', settings, 'src/a/cache/app.ts').reason).toBe('excludePattern');
        expect(evaluate('app.ts', settings, 'src/vendor/pkg/app.ts').reason).toBe('excludePattern');
    });

    it('preserves slashless basename exclusions and never tracks virtual documents', () => {
        expect(evaluate('secret.txt', { ...baseSettings, excludePatterns: ['secret.*'] }, 'src/secret.txt').reason).toBe('excludePattern');
        expect(evaluate('notes.md', baseSettings, 'notes.md', 'untitled').reason).toBe('scheme');
        expect(evaluate('notes.md', baseSettings, 'notes.md', 'git').tracked).toBe(false);
    });

    it('includes conservative generated, lock, and private-key defaults', () => {
        expect(DEFAULT_EXCLUDE_PATTERNS).toContain('**/node_modules/**');
        expect(DEFAULT_EXCLUDE_PATTERNS).toContain('*.min.*');
        expect(evaluate('private.key').reason).toBe('excludePattern');
        expect(evaluate('pnpm-lock.yaml').reason).toBe('excludePattern');
    });
});
