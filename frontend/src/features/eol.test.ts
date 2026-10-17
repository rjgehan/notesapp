import { describe, expect, it } from 'vitest';
import { detectEol, docToServerOffset, fromLf, serverToDocOffset, toLf } from './eol';

describe('eol', () => {
  it('detects CRLF only when every line break is CRLF', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\r\nb\n')).toBe('lf');
    expect(detectEol('no breaks')).toBe('lf');
    expect(detectEol('\n')).toBe('lf');
    expect(detectEol('\r\n')).toBe('crlf');
  });

  it('round-trips CRLF text', () => {
    const crlf = '# T\r\n\r\n- [ ] x\r\n';
    expect(fromLf(toLf(crlf), 'crlf')).toBe(crlf);
  });

  it('keeps a lone CR', () => {
    expect(toLf('a\rb\r\nc')).toBe('a\rb\nc');
  });

  it('maps server offsets to document offsets', () => {
    const server = 'ab\r\ncd\r\nef';
    const doc = toLf(server);
    const at = server.indexOf('ef');
    expect(serverToDocOffset(doc, at, 'crlf')).toBe(doc.indexOf('ef'));
    expect(serverToDocOffset(doc, server.indexOf('cd'), 'crlf')).toBe(doc.indexOf('cd'));
    expect(serverToDocOffset(doc, 3, 'crlf')).toBe(2); // between \r and \n → start of the break
    expect(serverToDocOffset(doc, at, 'lf')).toBe(at);
  });

  it('maps document offsets to server offsets', () => {
    const server = 'ab\r\ncd\r\nef';
    const doc = toLf(server);
    expect(docToServerOffset(doc, doc.indexOf('ef'), 'crlf')).toBe(server.indexOf('ef'));
    expect(docToServerOffset(doc, 2, 'crlf')).toBe(2);
  });
});
