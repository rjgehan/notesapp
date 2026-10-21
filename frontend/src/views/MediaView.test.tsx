import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../api/types';
import MediaView from './MediaView';

function entry(path: string, kind: FileEntry['kind']): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name, extension: name.slice(name.lastIndexOf('.') + 1), kind, size: 10, mtime: '2026-10-21T10:00:00.000Z', version: null, aliases: [] };
}

describe('MediaView', () => {
  it('plays a WebM voice note in an audio player once its metadata shows no picture', () => {
    const e = entry('Attachments/Recording 20261021143005.webm', 'video');
    const { container } = render(<MediaView path={e.path} entry={e} mode="read" />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 0 });
    Object.defineProperty(video, 'videoHeight', { value: 0 });
    fireEvent.loadedMetadata(video);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('audio')?.getAttribute('src')).toContain('Recording%2020261021143005.webm');
  });

  it('keeps videos with a picture, and plays audio files as audio', () => {
    const v = entry('Clips/Trip.mp4', 'video');
    const { container, unmount } = render(<MediaView path={v.path} entry={v} mode="read" />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 1280 });
    fireEvent.loadedMetadata(video);
    expect(container.querySelector('video')).toBe(video);
    unmount();
    const a = entry('Attachments/Memo.m4a', 'audio');
    expect(render(<MediaView path={a.path} entry={a} mode="read" />).container.querySelector('audio')).not.toBeNull();
  });
});
