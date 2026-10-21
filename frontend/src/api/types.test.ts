import { describe, expect, it } from 'vitest';
import apiDoc from '../../../docs/API.md?raw';
import typesSource from './types.ts?raw';
import { TASK_EVENT_NAMES, VAULT_EVENT_NAMES, type TaskEventMap } from './types';

/** The TypeScript block of API.md §17, which types.ts copies verbatim. */
function section17(doc: string): string {
  const lines = doc.replace(/\r\n/g, '\n').split('\n');
  const heading = lines.findIndex((line) => line.startsWith('## 17. TypeScript definitions'));
  const open = lines.findIndex((line, i) => i > heading && line === '```ts');
  const close = lines.findIndex((line, i) => i > open && line === '```');
  return lines.slice(open + 1, close).join('\n') + '\n';
}

describe('api/types', () => {
  it('is a verbatim copy of API.md §17', () => {
    expect(typesSource.replace(/\r\n/g, '\n')).toBe(section17(apiDoc));
  });

  it('names every task event once, apart from the vault events', () => {
    const map: Record<keyof TaskEventMap, true> = {
      'task.created': true,
      'task.changed': true,
      'task.deleted': true,
      'list.changed': true,
    };
    expect([...TASK_EVENT_NAMES].sort()).toEqual(Object.keys(map).sort());
    expect(TASK_EVENT_NAMES.filter((name) => (VAULT_EVENT_NAMES as readonly string[]).includes(name))).toEqual([]);
  });
});
