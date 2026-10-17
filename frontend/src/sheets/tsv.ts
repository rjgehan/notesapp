// Tab-separated values, the plain-text clipboard format of Google Sheets, Excel and LibreOffice
// (DESIGN §6.21.6). A field with a tab, a line break or a double quote is quoted, with the quote
// doubled inside, as those programs write and read it.

function quoteField(field: string): string {
  return /[\t\n\r"]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Rows of fields as TSV, one row per line. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(quoteField).join('\t')).join('\n');
}

/**
 * Rows of fields from TSV. CRLF and LF both end a row; a final line break does not add an empty
 * row. A quote that opens a field starts a quoted field (tabs and line breaks inside it are
 * text); a quote anywhere else is an ordinary character.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && field === '') {
      // A quoted field, if it closes before the next separator.
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += text[j];
        j++;
      }
      const next = text[j];
      if (closed && (next === undefined || next === '\t' || next === '\n' || next === '\r')) {
        field = value;
        i = j;
        continue;
      }
    }
    if (ch === '\t') {
      endField();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
