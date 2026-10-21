// Loads PDF.js for a view or an embed (pdfLib.ts), once `enabled`; `retry` loads again after a failure
// (a lost connection, or a chunk a deploy replaced).
import { useEffect, useState } from 'react';
import { loadPdfLib, type PdfLib } from './pdfLib';

export function usePdfLib(enabled = true): { lib: PdfLib | null; error: string | null; retry(): void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ lib: PdfLib | null; error: string | null }>({ lib: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadPdfLib().then(
      (lib) => {
        if (live) setState({ lib, error: null });
      },
      (e: unknown) => {
        if (live) setState({ lib: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, attempt]);
  return {
    ...state,
    retry: () => {
      setState({ lib: null, error: null });
      setAttempt((n) => n + 1);
    },
  };
}
