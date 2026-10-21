import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerCommand } from '../../features/commands';
import { effectiveHotkey, hotkeyOverrides } from '../../features/hotkeyPrefs';
import { isApple } from '../../features/platform';
import { HotkeysSection } from './HotkeysSection';

const mod = isApple ? { metaKey: true } : { ctrlKey: true };
const alpha = { id: 'zz.alpha', name: 'ZZ Alpha command', hotkey: 'Mod-Alt-1', run: () => {} };
const beta = { id: 'zz.beta', name: 'ZZ Beta command', run: () => {} };

beforeEach(() => {
  registerCommand(alpha);
  registerCommand(beta);
});

const row = (name: string) => screen.getByText(name).closest('li')!;

describe('HotkeysSection', () => {
  it('lists commands with their keys and filters them', () => {
    render(<HotkeysSection />);
    fireEvent.change(screen.getByLabelText('Filter commands'), { target: { value: 'zz' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(within(row('ZZ Beta command')).getByText('No key')).toBeInTheDocument();
    expect(within(row('ZZ Alpha command')).queryByText('No key')).toBeNull();
  });

  it('records a new key, and a key in use can be taken over', () => {
    render(<HotkeysSection />);
    fireEvent.change(screen.getByLabelText('Filter commands'), { target: { value: 'zz' } });
    fireEvent.click(screen.getByLabelText('Change the key of ZZ Beta command'));
    const recorder = screen.getByRole('button', { name: /Press the new key for ZZ Beta command/ });
    fireEvent.keyDown(recorder, { key: '1', code: 'Digit1', altKey: true, ...mod });
    expect(within(row('ZZ Beta command')).getByRole('alert')).toHaveTextContent('is used by “ZZ Alpha command”');
    expect(effectiveHotkey(beta)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use it here instead' }));
    expect(effectiveHotkey(beta)).toBe('Mod-Alt-1');
    expect(effectiveHotkey(alpha)).toBeNull();
    expect(within(row('ZZ Beta command')).getByText('Default: no key')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Reset the key of ZZ Alpha command'));
    expect(effectiveHotkey(alpha)).toBe('Mod-Alt-1');
  });

  it('refuses keys the browser needs, and Escape cancels', () => {
    render(<HotkeysSection />);
    fireEvent.change(screen.getByLabelText('Filter commands'), { target: { value: 'zz' } });
    fireEvent.click(screen.getByLabelText('Change the key of ZZ Beta command'));
    fireEvent.keyDown(screen.getByRole('button', { name: /Press the new key/ }), { key: 't', code: 'KeyT', ...mod });
    expect(within(row('ZZ Beta command')).getByText(/cannot be used: the browser opens a new tab/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: /Press the new key/ }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /Press the new key/ })).toBeNull();
    expect(hotkeyOverrides()).toEqual({});
  });

  it('removes a key', () => {
    render(<HotkeysSection />);
    fireEvent.change(screen.getByLabelText('Filter commands'), { target: { value: 'zz alpha' } });
    fireEvent.click(screen.getByLabelText('Remove the key of ZZ Alpha command'));
    expect(effectiveHotkey(alpha)).toBeNull();
    expect(hotkeyOverrides()).toEqual({ 'zz.alpha': null });
  });
});
