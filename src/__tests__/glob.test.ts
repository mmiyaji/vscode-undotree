import { matchesGlob, matchesPathGlob } from '../glob';

describe('matchesGlob', () => {
    it('treats ? as a one-character glob wildcard', () => {
        expect(matchesGlob('aconfig.txt', '?config.txt')).toBe(true);
        expect(matchesGlob('😀config.txt', '?config.txt')).toBe(true);
        expect(matchesGlob('abconfig.txt', '?config.txt')).toBe(false);
        expect(matchesGlob('😀xconfig.txt', '?config.txt')).toBe(false);
        expect(() => matchesGlob('aconfig.txt', '?config.txt')).not.toThrow();
    });

    it('escapes regexp metacharacters that are not glob wildcards', () => {
        expect(matchesGlob('app.config.txt', 'app.config.txt')).toBe(true);
        expect(matchesGlob('appXconfig.txt', 'app.config.txt')).toBe(false);
    });

    it('matches path globs with segment wildcards and ** directory wildcards', () => {
        expect(matchesPathGlob('generated/app.ts', 'generated/**')).toBe(true);
        expect(matchesPathGlob('src/generated/app.ts', 'generated/**')).toBe(false);
        expect(matchesPathGlob('src/a/cache/app.ts', '**/cache/**')).toBe(true);
        expect(matchesPathGlob('src/app.ts', '**/src/*.ts')).toBe(true);
        expect(matchesPathGlob('src/deep/app.ts', 'src/*.ts')).toBe(false);
        expect(matchesPathGlob('src\\cache\\app.ts', '**/cache/**')).toBe(true);
    });
});
