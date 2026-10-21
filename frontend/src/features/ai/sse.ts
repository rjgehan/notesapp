// An incremental parser for the `text/event-stream` body of POST /api/ai/ask and /api/ai/summarize
// (API.md §24.5). EventSource only does GET, so the answer stream is read from fetch's body.

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Feeds chunks of a stream (in any split) and calls `onMessage` for each complete event. Follows
 * the SSE rules the app needs: `event:` and `data:` fields (several data lines joined by `\n`), an
 * optional space after the colon, comments (`:`) ignored, `\r\n` and `\r` line ends, and a blank
 * line that ends the event.
 */
export function createSseParser(onMessage: (message: SseMessage) => void): { feed(chunk: string): void; end(): void } {
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };

  const line = (text: string) => {
    if (text === '') {
      dispatch();
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A lone \r at the very end may be the first half of \r\n: wait for the next chunk.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    end() {
      if (buffer !== '') line(buffer);
      buffer = '';
      dispatch();
    },
  };
}
