// The grid's theme from the app's CSS variables (DESIGN §6.17, §6.21.5). Glide Data Grid draws on a
// canvas, which cannot read var(): the values are resolved once per theme and read again when
// `data-theme` changes (the toggle, or the system theme while the preference is `system`).
import type { Theme } from '@glideapps/glide-data-grid';
import { useEffect, useState } from 'react';
import { isCoarsePointer } from '../../features/platform';

export interface SheetTheme {
  touch: boolean;
  grid: Partial<Theme>;
  /** Colour of error results (`#DIV/0!`). */
  error: string;
  /** Font size of cells in px; bold rows and frozen cells use it too. */
  fontSize: number;
}

function read(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

export function sheetTheme(touch: boolean): SheetTheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => read(s, name, fallback);
  const accent = v('--interactive-accent', '#8a5cf5');
  const fontSize = touch ? 15 : 13;
  return {
    touch,
    error: v('--text-error', '#fb464c'),
    fontSize,
    grid: {
      accentColor: accent,
      accentFg: v('--text-on-accent', '#ffffff'),
      accentLight: v('--background-modifier-active-hover', 'rgba(138, 92, 245, 0.16)'),
      textDark: v('--text-normal', '#dadada'),
      textMedium: v('--text-muted', '#a3a3a3'),
      textLight: v('--text-faint', '#6e6e6e'),
      textBubble: v('--text-normal', '#dadada'),
      bgIconHeader: v('--text-muted', '#a3a3a3'),
      fgIconHeader: v('--background-primary', '#1e1e1e'),
      textHeader: v('--text-muted', '#a3a3a3'),
      textHeaderSelected: v('--text-on-accent', '#ffffff'),
      bgCell: v('--background-primary', '#1e1e1e'),
      bgCellMedium: v('--background-primary-alt', '#242424'),
      bgHeader: v('--background-secondary', '#262626'),
      bgHeaderHasFocus: v('--background-modifier-border', '#363636'),
      bgHeaderHovered: v('--background-secondary-alt', '#2b2b2b'),
      bgBubble: v('--background-secondary-alt', '#2b2b2b'),
      bgBubbleSelected: v('--background-primary', '#1e1e1e'),
      bgSearchResult: v('--text-highlight-bg', 'rgba(255, 208, 0, 0.32)'),
      borderColor: v('--background-modifier-border', '#363636'),
      horizontalBorderColor: v('--background-modifier-border', '#363636'),
      headerBottomBorderColor: v('--background-modifier-border-hover', '#474747'),
      drilldownBorder: 'rgba(0, 0, 0, 0)',
      linkColor: v('--link', '#a68af9'),
      resizeIndicatorColor: accent,
      fontFamily: v('--font-interface', 'system-ui, sans-serif'),
      baseFontStyle: `${fontSize}px`,
      headerFontStyle: '500 12px',
      markerFontStyle: '12px',
      // 16 px or more keeps iOS from zooming into the cell editor.
      editorFontSize: touch ? '16px' : `${fontSize}px`,
      cellHorizontalPadding: 6,
      cellVerticalPadding: 3,
    },
  };
}

/** The theme, kept current across theme switches. */
export function useSheetTheme(touch: boolean): SheetTheme {
  const [theme, setTheme] = useState(() => sheetTheme(touch));
  if (theme.touch !== touch) setTheme(sheetTheme(touch));
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(sheetTheme(touch)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [touch]);
  return theme;
}

/** True on touch-first devices (`pointer: coarse`), where cells are edited in the formula bar. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(pointer: coarse)');
    const onChange = () => setCoarse(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return coarse;
}
