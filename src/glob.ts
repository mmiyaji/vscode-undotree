'use strict';

const REGEXP_SPECIAL_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

function escapeGlobCharacter(char: string): string {
    return REGEXP_SPECIAL_CHARS.has(char) ? `\\${char}` : char;
}

const regexCache = new Map<string, RegExp>();

function cachedRegex(key: string, source: string): RegExp {
    const cached = regexCache.get(key);
    if (cached) { return cached; }
    const compiled = new RegExp(source, 'iu');
    if (regexCache.size >= 256) {
        const oldest = regexCache.keys().next().value;
        if (oldest !== undefined) { regexCache.delete(oldest); }
    }
    regexCache.set(key, compiled);
    return compiled;
}

export function matchesGlob(filename: string, pattern: string): boolean {
    const key = `basename:${pattern}`;
    const cached = regexCache.get(key);
    if (cached) { return cached.test(filename); }
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
    return cachedRegex(key, `^${source}$`).test(filename);
}

/** Match a normalized workspace-relative path. `*` and `?` stay within one
 * segment; a double star can cross directories and match zero directories. */
export function matchesPathGlob(relativePath: string, pattern: string): boolean {
    const input = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const key = `path:${normalizedPattern}`;
    const cached = regexCache.get(key);
    if (cached) { return cached.test(input); }
    let source = '';
    for (let i = 0; i < normalizedPattern.length; i++) {
        const char = normalizedPattern[i];
        if (char === '*' && normalizedPattern[i + 1] === '*') {
            i++;
            if (normalizedPattern[i + 1] === '/') {
                i++;
                source += '(?:.*/)?';
            } else {
                source += '.*';
            }
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += escapeGlobCharacter(char);
        }
    }
    return cachedRegex(key, `^${source}$`).test(input);
}
