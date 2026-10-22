import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PropertiesEditor } from './PropertiesEditor';

const setPropertyType = vi.fn(async () => {});

vi.mock('../api', () => ({
  usePropertyTypes: () => ({ data: { types: { rating: 'number', due: 'date' }, version: null, source: null } }),
  useVaultProperties: () => ({ data: { properties: [{ name: 'owner', count: 3, type: null, inferred: 'text' }] } }),
  usePropertyValues: () => ({ data: { name: 'x', values: [] } }),
  setPropertyType: (...args: unknown[]) => setPropertyType(...(args as [])),
  refreshAfterOwnEdit: () => {},
}));

vi.mock('../../api/hooks', () => ({
  useTags: () => ({ data: { tags: [{ tag: 'work', count: 1, total: 1 }] } }),
  useTree: () => ({ data: undefined }),
  currentTree: () => ({ notes: [], links: new Map() }),
  currentSettings: () => ({ files: { newLinkFormat: 'shortest' } }),
}));

const YAML = '# keep\ntitle: Plan  # why\nrating: 4\ndone: false\ntags:\n  - a\ndue: 2026-10-21\n';

let yaml = YAML;

/** The editor over `yaml`, shown again after each edit as the note's widget is. */
function Harness() {
  const [shown, setShown] = useState(yaml);
  return (
    <PropertiesEditor
      yaml={shown}
      sourcePath="Note.md"
      onEdit={null}
      onChange={(edit) => {
        yaml = edit(yaml);
        setShown(yaml);
        return true;
      }}
    />
  );
}

beforeEach(() => {
  yaml = YAML;
  try {
    localStorage.removeItem('notesapp:propertiesCollapsed');
  } catch {
    // jsdom storage
  }
});

afterEach(() => vi.clearAllMocks());

describe('PropertiesEditor', () => {
  it('shows each property with the editor of its type', () => {
    render(<Harness />);
    expect(screen.getByLabelText('title')).toHaveProperty('value', 'Plan');
    expect(screen.getByLabelText('rating')).toHaveProperty('value', '4');
    expect(screen.getByLabelText('done')).toHaveProperty('checked', false);
    expect(screen.getByLabelText('due')).toHaveProperty('type', 'date');
    expect(screen.getByText('#a')).toBeTruthy();
    expect(screen.getByLabelText('Add to tags')).toBeTruthy();
  });

  it('commits each edit as a change of that property only', () => {
    render(<Harness />);
    const title = screen.getByLabelText('title');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Launch' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(yaml).toBe(YAML.replace('title: Plan  # why', 'title: Launch'));

    fireEvent.click(screen.getByLabelText('done'));
    expect(yaml).toContain('done: true\n');

    const rating = screen.getByLabelText('rating');
    fireEvent.change(rating, { target: { value: 'many' } });
    fireEvent.blur(rating);
    expect(yaml).toContain('rating: 4\n');
    fireEvent.change(rating, { target: { value: '4.5' } });
    fireEvent.blur(rating);
    expect(yaml).toContain('rating: 4.5\n');

    const tags = screen.getByLabelText('Add to tags');
    fireEvent.change(tags, { target: { value: '#b,' } });
    expect(yaml).toContain('tags:\n  - a\n  - b\n');
    fireEvent.click(screen.getByLabelText('Remove a'));
    expect(yaml).toContain('tags:\n  - b\n');
    expect(yaml.startsWith('# keep\n')).toBe(true);
  });

  it('renames a property in the note and adds new ones', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('title'));
    const name = screen.getByLabelText('New name for title');
    fireEvent.change(name, { target: { value: 'headline' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(yaml).toContain('headline: Plan  # why\n');

    fireEvent.click(screen.getByText('Add property'));
    const input = screen.getByLabelText('New property name');
    fireEvent.change(input, { target: { value: 'owner' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(yaml.endsWith('owner:\n')).toBe(true);
  });

  it('shows a value that does not fit its type as written', () => {
    yaml = 'due: soon\n';
    render(<Harness />);
    expect(screen.getByText('soon').closest('.property-mismatch')).toBeTruthy();
  });

  it('reports YAML it cannot edit', () => {
    yaml = '{a: 1}\n';
    render(<Harness />);
    expect(screen.getByRole('note').textContent).toMatch(/flow style/);
  });

  it('the row menu moves a property', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('rating: Number. Property menu'));
    const item = await screen.findByText('Move up');
    act(() => item.click());
    expect(yaml.indexOf('rating:')).toBeLessThan(yaml.indexOf('title:'));
  });
});
