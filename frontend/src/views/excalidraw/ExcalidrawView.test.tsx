import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEndpoints } from '../../api/endpoints';
import { createMockEndpoints } from '../../api/mock';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import { el, scene } from '../../test/drawings';
import type { FileEntry } from '../../api/types';
import type { SceneElement } from './format';
import { sourceFiles } from '../../test/sources';
import ExcalidrawView from './ExcalidrawView';

// ---------- Excalidraw, as far as the view uses it ----------

interface CapturedProps {
  initialData: { elements: SceneElement[]; appState: Record<string, unknown>; files: Record<string, unknown> };
  theme: string;
  viewModeEnabled: boolean;
  aiEnabled: boolean;
  validateEmbeddable: boolean;
  libraryReturnUrl: string;
  UIOptions: { canvasActions: Record<string, unknown> };
  generateIdForFile: (file: File) => Promise<string>;
  excalidrawAPI: (api: unknown) => void;
  onChange: (elements: SceneElement[], appState: Record<string, unknown>, files: Record<string, unknown>) => void;
}

const excalidraw = vi.hoisted(() => ({ props: null as CapturedProps | null, elements: [] as SceneElement[], mounts: 0 }));

vi.mock('@excalidraw/excalidraw', () => {
  function Excalidraw(props: CapturedProps & { children?: ReactNode }) {
    excalidraw.props = props;
    // Like Excalidraw's App constructor: one API per instance, handed over once.
    useState(() => {
      props.excalidrawAPI({
        getSceneElementsIncludingDeleted: () => excalidraw.elements,
        getAppState: () => ({ ...props.initialData.appState }),
        getFiles: () => ({}),
        updateScene: (s: { elements?: SceneElement[] }) => {
          if (s.elements) excalidraw.elements = [...s.elements];
        },
        addFiles: () => {},
      });
      return null;
    });
    useEffect(() => {
      excalidraw.mounts++;
      // Excalidraw reports the initial scene once it has loaded it.
      excalidraw.elements = props.initialData.elements.map((e) => ({ ...e }));
      props.onChange(excalidraw.elements, { ...props.initialData.appState }, {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="excalidraw" data-theme={props.theme} />;
  }
  const item = () => null;
  const MainMenu = Object.assign(({ children }: { children?: ReactNode }) => <>{children}</>, {
    Separator: item,
    DefaultItems: { SaveAsImage: item, Export: item, SearchMenu: item, Help: item, ClearCanvas: item, ChangeCanvasBackground: item },
  });
  return {
    Excalidraw,
    MainMenu,
    CaptureUpdateAction: { NEVER: 'NEVER' },
    hashElementsVersion: (elements: SceneElement[]) => elements.reduce((h, e) => h * 31 + e.version, 1),
    restoreElements: (elements: SceneElement[]) => elements.map((e) => ({ ...e })),
  };
});

function entry(path: string, kind: FileEntry['kind']): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name, extension: 'excalidraw', kind, size: 1, mtime: '2026-10-17T10:00:00.000Z', version: null, aliases: [] };
}

let vault: MockVault;

beforeEach(() => {
  vault = new MockVault(false);
  installEndpoints(createMockEndpoints(vault, { latency: 0, failures: [] }));
  excalidraw.props = null;
  excalidraw.mounts = 0;
  document.documentElement.setAttribute('data-theme', 'dark');
});

afterEach(() => {
  queryClient.clear();
});

function open(path: string, content: string) {
  vault.createFile({ path, content }, 'other-device-1');
  queryClient.setQueryData(queryKeys.tree(), vault.getTree());
  const e = entry(path, path.endsWith('.md') ? 'note' : 'text');
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/n/${path}`]}>
        <div className="workspace-scroll">
          <ExcalidrawView path={path} entry={e} mode="edit" />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExcalidrawView', () => {
  it('starts Excalidraw from the file, in the app theme, with the app owning files and outbound content', async () => {
    open('Plan.excalidraw', JSON.stringify(scene([el('a'), el('b')])));
    expect(await screen.findByTestId('excalidraw')).toHaveAttribute('data-theme', 'dark');
    const props = excalidraw.props!;
    expect(props.initialData.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(props.viewModeEnabled).toBe(false);
    expect(props.aiEnabled).toBe(false);
    expect(props.validateEmbeddable).toBe(false);
    expect(props.UIOptions.canvasActions).toMatchObject({ loadScene: false, saveToActiveFile: false });
    expect(props.generateIdForFile).toBeTypeOf('function');
    // "Browse libraries" would send the page address (the tailnet host and the drawing's path) to
    // libraries.excalidraw.com: it is hidden, and its return address names no path.
    const viewCss = (await sourceFiles('views/excalidraw/excalidraw.css'))['views/excalidraw/excalidraw.css'];
    expect(viewCss.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/\.excalidraw \.library-menu-browse-button\s*\{\s*display:\s*none\s*!important;\s*\}/);
    expect(props.libraryReturnUrl).toBe(`${window.location.origin}/`);

    // The theme follows the app's (also when it follows the OS).
    act(() => document.documentElement.setAttribute('data-theme', 'light'));
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toHaveAttribute('data-theme', 'light'));
    expect(excalidraw.mounts).toBe(1);
  });

  it('saves an edit to the vault', async () => {
    open('Plan.excalidraw', JSON.stringify(scene([el('a')])));
    await screen.findByTestId('excalidraw');
    const props = excalidraw.props!;
    act(() => {
      excalidraw.elements = [...excalidraw.elements, el('drawn')];
      props.onChange(excalidraw.elements, { ...props.initialData.appState }, {});
    });
    await waitFor(() => expect(JSON.parse(vault.readFile('Plan.excalidraw').content).elements.map((e: SceneElement) => e.id)).toEqual(['a', 'drawn']), { timeout: 3000 });
  });

  it('opens an unreadable drawing as text, so nothing in it is lost', async () => {
    open('Broken.excalidraw', '{"elements": [');
    expect(await screen.findByText(/This drawing could not be read/)).toBeInTheDocument();
    expect(screen.queryByTestId('excalidraw')).toBeNull();
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
  });
});
