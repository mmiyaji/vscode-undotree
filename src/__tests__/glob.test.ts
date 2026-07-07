import { matchesGlob } from '../glob';

describe('matchesGlob', () => {
    it('treats ? as a one-character glob wildcard', () => {
        expect(matchesGlob('aconfig.txt', '?config.txt')).toBe(true);
        expect(matchesGlob('abconfig.txt', '?config.txt')).toBe(false);
        expect(() => matchesGlob('aconfig.txt', '?config.txt')).not.toThrow();
    });

    it('escapes regexp metacharacters that are not glob wildcards', () => {
        expect(matchesGlob('app.config.txt', 'app.config.txt')).toBe(true);
        expect(matchesGlob('appXconfig.txt', 'app.config.txt')).toBe(false);
    });
});
