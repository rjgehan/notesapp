import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from './sse';

function parse(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const parser = createSseParser((m) => out.push(m));
  for (const c of chunks) parser.feed(c);
  parser.end();
  return out;
}

describe('createSseParser (API.md §24.5)', () => {
  it('reads named events with JSON data', () => {
    expect(parse(['event:start\ndata:{"model":"m"}\n\nevent: delta\ndata: {"text":"Hi"}\n\n'])).toEqual([
      { event: 'start', data: '{"model":"m"}' },
      { event: 'delta', data: '{"text":"Hi"}' },
    ]);
  });

  it('handles any split, CRLF line ends and a CR split from its LF', () => {
    const text = 'event:delta\r\ndata:{"text":"a"}\r\n\r\nevent:done\r\ndata:{}\r\n\r\n';
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 3) chunks.push(text.slice(i, i + 3));
    expect(parse(chunks)).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'done', data: '{}' },
    ]);
    expect(parse(['event:x\r', '\ndata:1\r', '\n\r', '\n'])).toEqual([{ event: 'x', data: '1' }]);
  });

  it('joins data lines and ignores comments and unknown fields', () => {
    expect(parse([': keepalive\n', 'id: 3\nevent:delta\ndata:line one\ndata:line two\nretry: 10\n\n'])).toEqual([{ event: 'delta', data: 'line one\nline two' }]);
  });

  it('dispatches a last event without its blank line at the end', () => {
    expect(parse(['event:done\ndata:{}'])).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('drops events without data, and names nameless ones "message"', () => {
    expect(parse(['event:empty\n\ndata:x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });
});
