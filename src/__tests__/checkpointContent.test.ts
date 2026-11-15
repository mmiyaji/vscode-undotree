import { createHash } from 'crypto';
import { checkpointHash, decodeCheckpointContent, encodeCheckpointContent, hashContent } from '../checkpointContent';

describe('checkpoint text encoding', () => {
    it.each(['', '日本語😀', '\ud800', '\udfff', 'a\ud800b\udc00'])('round trips %p', content => {
        expect(decodeCheckpointContent(encodeCheckpointContent(content))).toBe(content);
    });

    it('reads legacy UTF-8 and preserves hashes for well-formed text', () => {
        const content = '旧形式😀';
        expect(decodeCheckpointContent(Buffer.from(content))).toBe(content);
        expect(hashContent(content)).toBe(createHash('sha1').update(content).digest('hex'));
    });

    it('distinguishes replacement characters and isolated surrogates, including legacy node hashes', () => {
        expect(new Set(['\ufffd', '\ud800', '\ud801', '\udc00'].map(hashContent)).size).toBe(4);
        expect(checkpointHash('\ud800', hashContent('\ufffd'))).toBe(hashContent('\ud800'));
    });

    it('rejects a truncated UTF-16 payload', () => {
        const encoded = encodeCheckpointContent('\ud800');
        expect(() => decodeCheckpointContent(encoded.subarray(0, encoded.length - 1))).toThrow();
    });
});
