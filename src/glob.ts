'use strict';

const REGEXP_SPECIAL_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

export function matchesGlob(filename: string, pattern: string): boolean {
    let source = '';
    for (const char of pattern) {
        if (char === '*') {
            source += '.*';
        } else if (char === '?') {
            source += '.';
        } else if (REGEXP_SPECIAL_CHARS.has(char)) {
            source += `\\${char}`;
        } else {
            source += char;
        }
    }
    // Unicode mode makes `?` consume one code point rather than one UTF-16
    // code unit, so a single emoji behaves like a single glob character.
    return new RegExp(`^${source}$`, 'iu').test(filename);
}
