'use strict';

const CONTENT_HASH_PATTERN = /^[0-9a-f]{8,40}$/;

export function isValidContentHash(value: string): boolean {
    return CONTENT_HASH_PATTERN.test(value);
}
