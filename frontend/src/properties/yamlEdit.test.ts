import { describe, expect, it } from 'vitest';
import { addProperty, moveProperty, PropertyEditError, readProperties, removeProperty, renameProperty, serializeProperty, setValue, yamlKey } from './yamlEdit';

const YAML = ['# a comment', 'title:   "Plan"   # why', 'status: open', 'tags:', '  - a   # first', '  - b', '', '# before due', 'due: 2026-10-21', ''].join('\n');

describe('properties/yamlEdit', () => {
  it('reads the properties with their lines', () => {
    const { entries, error } = readProperties(YAML);
    expect(error).toBeNull();
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ['title', 'Plan'],
      ['status', 'open'],
      ['tags', ['a', 'b']],
      ['due', '2026-10-21'],
    ]);
    expect(YAML.slice(entries[2].from, entries[2].to)).toBe('tags:\n  - a   # first\n  - b\n');
    expect(YAML.slice(entries[0].keyFrom, entries[0].keyTo)).toBe('title');
  });

  it('reports YAML it cannot edit', () => {
    expect(readProperties('a: [\n').error).not.toBeNull();
    expect(readProperties('- a\n').error).toMatch(/not a list of properties/);
    expect(readProperties('{a: 1}\n').error).toMatch(/flow style/);
    expect(readProperties('').entries).toEqual([]);
    expect(() => setValue('a: [\n', 'a', 1)).toThrow(PropertyEditError);
  });

  it('changes only the lines of the property it sets', () => {
    expect(setValue(YAML, 'status', 'done')).toBe(YAML.replace('status: open', 'status: done'));
    expect(setValue(YAML, 'tags', ['a', 'c d'])).toBe(YAML.replace('tags:\n  - a   # first\n  - b\n', 'tags:\n  - a\n  - c d\n'));
    expect(setValue(YAML, 'STATUS', null)).toBe(YAML.replace('status: open', 'status:'));
    expect(setValue(YAML, 'due', '2026-11-01')).toBe(YAML.replace('due: 2026-10-21', 'due: 2026-11-01'));
    // Untouched lines are byte for byte the same, comments included.
    const changed = setValue(YAML, 'title', 'Other');
    expect(changed).toBe(YAML.replace('title:   "Plan"   # why', 'title: Other'));
  });

  it('quotes what would read back differently', () => {
    expect(serializeProperty('n', '123')).toBe('n: "123"\n');
    expect(serializeProperty('b', 'true')).toBe('b: "true"\n');
    expect(serializeProperty('l', '[[Note]]')).toBe('l: "[[Note]]"\n');
    expect(serializeProperty('c', 'a: b')).toBe('c: "a: b"\n');
    expect(serializeProperty('x', 4.5)).toBe('x: 4.5\n');
    expect(serializeProperty('x', false)).toBe('x: false\n');
    expect(serializeProperty('due date', '2026-10-21')).toBe('due date: 2026-10-21\n');
    expect(yamlKey('a: b')).toBe('"a: b"');
    expect(yamlKey('null')).toBe('"null"');
    expect(yamlKey('2026')).toBe('"2026"');
  });

  it('adds, removes and keeps CRLF', () => {
    const crlf = 'a: 1\r\nb: 2\r\n';
    expect(addProperty(crlf, 'c', 'x')).toBe('a: 1\r\nb: 2\r\nc: x\r\n');
    expect(addProperty(crlf, 'c', 'x', 0)).toBe('c: x\r\na: 1\r\nb: 2\r\n');
    expect(() => addProperty(crlf, 'A', 'x')).toThrow(/already has/);
    expect(removeProperty(crlf, 'a')).toBe('b: 2\r\n');
    expect(addProperty('', 'first', null)).toBe('first:\n');
    expect(removeProperty(YAML, 'tags')).toBe(YAML.replace('tags:\n  - a   # first\n  - b\n', ''));
  });

  it('renames only the key', () => {
    expect(renameProperty(YAML, 'status', 'state')).toBe(YAML.replace('status: open', 'state: open'));
    expect(renameProperty('"due date": 1\n', 'due date', 'due: at')).toBe('"due: at": 1\n');
    expect(() => renameProperty(YAML, 'status', 'Title')).toThrow(/already has/);
    expect(() => renameProperty(YAML, 'nope', 'x')).toThrow(PropertyEditError);
    expect(renameProperty(YAML, 'status', 'Status')).toBe(YAML.replace('status: open', 'Status: open'));
  });

  it('moves a property with its lines', () => {
    const moved = moveProperty(YAML, 'due', 0);
    expect(readProperties(moved).entries.map((e) => e.key)).toEqual(['due', 'title', 'status', 'tags']);
    expect(moved).toBe(['# a comment', 'due: 2026-10-21', 'title:   "Plan"   # why', 'status: open', 'tags:', '  - a   # first', '  - b', '', '# before due', ''].join('\n'));
    const last = moveProperty(YAML, 'title', 3);
    expect(readProperties(last).entries.map((e) => e.key)).toEqual(['status', 'tags', 'due', 'title']);
    expect(moveProperty(moveProperty(YAML, 'status', 2), 'status', 1)).toBe(YAML);
  });
});
