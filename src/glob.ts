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
    return new RegExp(`^${source}$`, 'i').test(filename);
}
