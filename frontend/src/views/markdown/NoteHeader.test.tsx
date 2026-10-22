import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import { currentNoteMode } from '../../features/noteMode';
import { useUi } from '../../state/ui';
import { ModeToggle, SourceToggle } from './NoteHeader';

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [] });
  window.history.replaceState(null, '', '/n/Plan.md');
  useUi.setState({ noteModes: {}, editingNew: null });
});

afterEach(() => {
  queryClient.clear();
  useUi.setState({ noteModes: {}, editingNew: null });
});

describe('note mode controls (ROADMAP 10a)', () => {
  it('the lock toggle is a pressed/unpressed button that locks and unlocks the note', () => {
    const { rerender } = render(<ModeToggle mode="live" />);
    const lock = screen.getByRole('button', { name: 'Lock editing' });
    expect(lock).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(lock);
    expect(currentNoteMode()).toBe('locked');
    rerender(<ModeToggle mode="locked" />);
    expect(screen.getByRole('button', { name: 'Lock editing' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Lock editing' }));
    expect(currentNoteMode()).toBe('live');
  });

  it('from the reading view, the toggle goes back to editing', () => {
    useUi.setState({ noteModes: { 'Plan.md': 'read' } });
    render(<ModeToggle mode="read" />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to editing view' }));
    expect(currentNoteMode()).toBe('live');
  });

  it('the source toggle shows the Markdown source and back', () => {
    const { rerender } = render(<SourceToggle mode="live" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source mode' }));
    expect(currentNoteMode()).toBe('source');
    rerender(<SourceToggle mode="source" />);
    expect(screen.getByRole('button', { name: 'Source mode' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Source mode' }));
    expect(currentNoteMode()).toBe('live');
  });
});
