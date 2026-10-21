import { describe, expect, it } from 'vitest';
import { FrontmatterError, getProperty, setProperty, yamlScalar } from './frontmatterEdit';

const NOTE = '---\ntitle: Morning workout # shown\ncolor: "#4CAF50"\nentries:\n  - 2026-10-19\n  - 2026-10-20\nschedule: mon, wed, fri\n---\nWhy I do it.\n';

describe('setProperty', () => {
  it('replaces a block list and keeps every other byte', () => {
    const out = setProperty(NOTE, 'entries', ['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(out).toBe(NOTE.replace('  - 2026-10-20\n', '  - 2026-10-20\n  - 2026-10-21\n'));
  });

  it('turns a flow list or an empty value into a block list', () => {
    expect(setProperty('---\nentries: []\n---\n', 'entries', ['2026-10-21'])).toBe('---\nentries:\n  - 2026-10-21\n---\n');
    expect(setProperty('---\nentries:\nx: 1\n---\n', 'entries', ['2026-10-21'])).toBe('---\nentries:\n  - 2026-10-21\nx: 1\n---\n');
    expect(setProperty('---\nentries: [a, b]\n---\nbody', 'entries', [])).toBe('---\nentries: []\n---\nbody');
  });

  it('sets scalars, matching the key case-insensitively', () => {
    expect(setProperty('---\nExercise: true\nmood: 3\n---\n', 'exercise', false)).toBe('---\nExercise: false\nmood: 3\n---\n');
    expect(setProperty(NOTE, 'schedule', 'daily')).toBe(NOTE.replace('schedule: mon, wed, fri', 'schedule: daily'));
    expect(setProperty(NOTE, 'color', '#ff0000')).toBe(NOTE.replace('"#4CAF50"', '"#ff0000"'));
  });

  it('appends a missing property and removes one', () => {
    expect(setProperty(NOTE, 'maxGap', 1)).toBe(NOTE.replace('---\nWhy', 'maxGap: 1\n---\nWhy'));
    expect(setProperty(NOTE, 'entries', null)).toBe(NOTE.replace('entries:\n  - 2026-10-19\n  - 2026-10-20\n', ''));
    expect(setProperty(NOTE, 'missing', null)).toBe(NOTE);
  });

  it('adds frontmatter to a note without', () => {
    expect(setProperty('Ran 5 km.\n', 'exercise', true)).toBe('---\nexercise: true\n---\nRan 5 km.\n');
    expect(setProperty('Text', 'exercise', null)).toBe('Text');
    expect(setProperty('---\n---\nBody', 'exercise', true)).toBe('---\nexercise: true\n---\nBody');
  });

  it('keeps a trailing comment line before the next key', () => {
    const text = '---\nentries:\n  - 2026-10-19\n# the schedule\nschedule: daily\n---\n';
    expect(setProperty(text, 'entries', ['2026-10-19', '2026-10-21'])).toBe('---\nentries:\n  - 2026-10-19\n  - 2026-10-21\n# the schedule\nschedule: daily\n---\n');
  });

  it('refuses broken frontmatter rather than rewriting it', () => {
    expect(() => setProperty('---\na: [\n---\n', 'x', true)).toThrow(FrontmatterError);
    expect(() => setProperty('---\n- a\n- b\n---\n', 'x', true)).toThrow(FrontmatterError);
  });

  it('reads values back', () => {
    expect(getProperty(NOTE, 'ENTRIES')).toEqual(['2026-10-19', '2026-10-20']);
    expect(getProperty(NOTE, 'nothing')).toBeUndefined();
    expect(getProperty('no frontmatter', 'x')).toBeUndefined();
  });

  it('quotes scalars only when needed', () => {
    expect(yamlScalar('2026-10-21')).toBe('2026-10-21');
    expect(yamlScalar('true')).toBe('"true"');
    expect(yamlScalar('#abc')).toBe('"#abc"');
    expect(yamlScalar(3)).toBe('3');
  });
});
