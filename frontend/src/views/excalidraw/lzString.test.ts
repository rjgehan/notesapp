import { compressToBase64, decompressFromBase64 as lzDecompress } from 'lz-string';
import { describe, expect, it } from 'vitest';
import { lzBomb as bomb } from '../../test/drawings';
import { decompressFromBase64 } from './lzString';

const LIMIT = 16 * 1024 * 1024;

describe('bounded lz-string decompression', () => {
  it('decodes what lz-string encodes, exactly as lz-string does', () => {
    let random = '';
    for (let i = 0; i < 3000; i++) random += String.fromCharCode(32 + ((i * 7919) % 500));
    const samples = ['a', 'Hello, World!', 'ünïcödé ✓ 𝄞 漢字', JSON.stringify({ type: 'excalidraw', elements: Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, x: i * 1.5 })) }), random];
    for (const s of samples) {
      const encoded = compressToBase64(s);
      expect(decompressFromBase64(encoded, LIMIT)).toBe(s);
      // The plugin's line breaks between chunks are ignored.
      expect(decompressFromBase64(encoded.replace(/(.{256})/g, '$1\n\n'), LIMIT)).toBe(s);
      for (const cut of [3, 10, Math.floor(encoded.length / 2)]) expect(decompressFromBase64(encoded.slice(0, cut), LIMIT)).toBe(lzDecompress(encoded.slice(0, cut)));
    }
    expect(decompressFromBase64('', LIMIT)).toBeNull();
    expect(decompressFromBase64('  \n', LIMIT)).toBeNull();
  });

  it('stops at the bound instead of expanding crafted input quadratically', () => {
    const small = bomb(100);
    expect(lzDecompress(small)).toBe('a'.repeat(5151));
    expect(decompressFromBase64(small, LIMIT)).toBe('a'.repeat(5151));
    expect(decompressFromBase64(small, 5150)).toBeNull();
    // About 13 KB that lz-string would expand to 18 million characters.
    const started = performance.now();
    expect(decompressFromBase64(bomb(6000), LIMIT)).toBeNull();
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
