import { createHash } from 'crypto';

// Legacy payloads are UTF-8, which cannot start with 0xff.
const marker = Buffer.from([0xff, 0x55, 0x54, 0x31]);

export function hasUnpairedSurrogate(content: string): boolean {
    for (let i = 0; i < content.length; i++) {
        const unit = content.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = content.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) { return true; }
        } else if (unit >= 0xdc00 && unit <= 0xdfff) { return true; }
    }
    return false;
}

export function encodeCheckpointContent(content: string): Buffer {
    return hasUnpairedSurrogate(content)
        ? Buffer.concat([marker, Buffer.from(content, 'utf16le')])
        : Buffer.from(content, 'utf8');
}

export function decodeCheckpointContent(buffer: Buffer): string {
    if (!buffer.subarray(0, marker.length).equals(marker)) { return buffer.toString('utf8'); }
    if ((buffer.length - marker.length) % 2 !== 0) { throw new Error('Invalid UTF-16 checkpoint payload'); }
    return buffer.subarray(marker.length).toString('utf16le');
}

export function hashContent(content: string): string {
    return createHash('sha1').update(encodeCheckpointContent(content)).digest('hex');
}

export function checkpointHash(content: string, legacyHash: string): string {
    return hasUnpairedSurrogate(content) ? hashContent(content) : legacyHash;
}
