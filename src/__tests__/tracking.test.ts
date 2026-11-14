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
    });

    it('tracks common source and documentation extensions by default', () => {
        expect(evaluate('src/app.ts').tracked).toBe(true);
        expect(evaluate('src/main.py').tracked).toBe(true);
        expect(evaluate('notes.mdx').tracked).toBe(true);
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
