import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TextSetting } from './SettingsPage';

function Folder({ onValue }: { onValue(v: string): void }) {
  const [value, setValue] = useState('');
  return (
    <TextSetting
      label="Daily note folder"
      value={value}
      disabled={false}
      trim
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe('TextSetting (FE-5, ux)', () => {
  it('keeps a typed space between words, and the setting receives the trimmed value', () => {
    const values: string[] = [];
    render(<Folder onValue={(v) => values.push(v)} />);
    const input = screen.getByLabelText<HTMLInputElement>('Daily note folder');
    // Key by key, each keystroke appending to what the field shows.
    for (const ch of 'Daily Notes ') fireEvent.change(input, { target: { value: input.value + ch } });
    expect(input.value).toBe('Daily Notes ');
    expect(values.at(-1)).toBe('Daily Notes');
  });
});
