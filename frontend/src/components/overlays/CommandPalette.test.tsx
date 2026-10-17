import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommand, runCommand } from '../../features/commands';
import { useUi } from '../../state/ui';
import { CommandPalette } from './CommandPalette';

const ran: string[] = [];

beforeEach(() => {
  ran.length = 0;
  localStorage.clear();
  useUi.setState({ overlay: 'palette' });
  for (const [id, name, hotkey] of [
    ['test.alpha', 'Alpha action', 'Mod-Alt-1'],
    ['test.beta', 'Beta action', undefined],
    ['test.gamma', 'Gamma action', undefined],
  ] as const) {
    registerCommand({ id, name, hotkey, run: () => void ran.push(id) });
  }
  registerCommand({ id: 'test.hidden', name: 'Hidden action', when: () => false, run: () => void ran.push('test.hidden') });
});

const labels = () => screen.getAllByRole('option').map((o) => o.querySelector('.picker-item-label')?.textContent);

describe('CommandPalette', () => {
  it('lists available commands with their hotkeys and hides inactive ones', () => {
    render(<CommandPalette />);
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveFocus();
    expect(labels()).toEqual(expect.arrayContaining(['Alpha action', 'Beta action', 'Gamma action']));
    expect(labels()).not.toContain('Hidden action');
    const alpha = screen.getAllByRole('option').find((o) => o.textContent?.includes('Alpha action'))!;
    expect(alpha.querySelector('kbd')?.textContent).toMatch(/1$/);
  });

  it('puts recently used commands first', () => {
    runCommand('test.gamma', { activePath: null });
    runCommand('test.beta', { activePath: null });
    ran.length = 0;
    render(<CommandPalette />);
    expect(labels().slice(0, 2)).toEqual(['Beta action', 'Gamma action']);
  });

  it('filters fuzzily and runs the selected command, closing the palette', () => {
    const spy = vi.fn();
    registerCommand({ id: 'test.delta', name: 'Delta: open something', run: spy });
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'dlt opn' } });
    expect(labels()[0]).toBe('Delta: open something');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(spy).toHaveBeenCalledWith({ activePath: null });
    expect(useUi.getState().overlay).toBeNull();
  });
});
