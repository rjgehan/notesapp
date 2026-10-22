import { describe, expect, it } from 'vitest';
import {
  decodePayload,
  findSections,
  formatSection,
  FormatError,
  parseEncryptedFile,
  sectionAt,
  sectionStartingAt,
  serializeEncryptedFile,
  stripSections,
  validHint,
} from './meld';

const B64 = 'QUJDREVGR0hJSktMTU5PUA==';

describe('Meld Encrypt formats (item 27)', () => {
  it('finds hidden and visible sections, with and without a hint', () => {
    const text = `a %%🔐β 💡pet name💡${B64} 🔐%% b 🔐β ${B64} 🔐 c %%🔐α ${B64} 🔐%% d %%🔐 ${B64} 🔐%%`;
    const found = findSections(text);
    expect(found.map((s) => [s.version, s.hint, s.visible, s.base64])).toEqual([
      [2, 'pet name', false, B64],
      [2, '', true, B64],
      [1, '', false, B64],
      [0, '', false, B64],
    ]);
    for (const s of found) expect(text.slice(s.from, s.to)).toBe(s.text);
    expect(stripSections(text)).toBe('a [encrypted] b [encrypted] c [encrypted] d [encrypted]');
  });

  it('formats new sections exactly as the plugin does', () => {
    expect(formatSection(B64, '')).toBe(`%%🔐β ${B64} 🔐%%`);
    expect(formatSection(B64, 'hint')).toBe(`%%🔐β 💡hint💡${B64} 🔐%%`);
    expect(formatSection(B64, '', true)).toBe(`🔐β ${B64} 🔐`);
    const s = findSections(`x ${formatSection(B64, 'h')} y`)[0];
    expect(s).toMatchObject({ version: 2, hint: 'h', base64: B64, visible: false });
  });

  it('never spans lines and ignores plain lock emoji', () => {
    expect(findSections(`%%🔐β ${B64}\n${B64} 🔐%%`)).toEqual([]);
    expect(findSections('My 🔐 safe 🔐 words')).toEqual([]);
    expect(stripSections('no sections')).toBe('no sections');
  });

  it('locates a section at a position and at its exact start', () => {
    const text = `before ${formatSection(B64, '')} after`;
    expect(sectionAt(text, 10)?.base64).toBe(B64);
    expect(sectionAt(text, 2)).toBeNull();
    expect(sectionStartingAt(text, 7)?.text).toBe(formatSection(B64, ''));
    expect(sectionStartingAt(text, 8)).toBeNull();
  });

  it('reads and writes .mdenc files in the plugin’s JSON layout', () => {
    const text = serializeEncryptedFile({ version: '2.0', hint: 'h', encodedData: B64 });
    expect(text).toBe(`{\n  "version": "2.0",\n  "hint": "h",\n  "encodedData": "${B64}"\n}`);
    expect(parseEncryptedFile(text)).toEqual({ version: '2.0', hint: 'h', encodedData: B64 });
    expect(parseEncryptedFile('')).toEqual({ version: '2.0', hint: '', encodedData: '' });
    expect(() => parseEncryptedFile('# not json')).toThrow(FormatError);
    expect(() => parseEncryptedFile('{"version":"3.0","encodedData":""}')).toThrow(/3\.0/);
  });

  it('splits payloads into iv, salt and data and refuses damaged ones', () => {
    const bytes = new Uint8Array(48).map((_, i) => i);
    const b64 = btoa(String.fromCharCode(...bytes));
    const v2 = decodePayload(b64, 2);
    expect([...v2.iv]).toEqual([...bytes.slice(0, 16)]);
    expect([...v2.salt]).toEqual([...bytes.slice(16, 32)]);
    expect(v2.data).toHaveLength(16);
    const v1 = decodePayload(b64, 1);
    expect(v1.data).toHaveLength(32);
    expect(new TextDecoder().decode(v1.salt)).toBe('XHWnDAT6ehMVY2zD');
    expect(() => decodePayload('AAAA', 2)).toThrow(/too short/);
    expect(() => decodePayload('!!!', 2)).toThrow(FormatError);
  });

  it('validates hints', () => {
    expect(validHint('fine')).toBeNull();
    expect(validHint('a💡b')).not.toBeNull();
    expect(validHint('two\nlines')).not.toBeNull();
  });
});
