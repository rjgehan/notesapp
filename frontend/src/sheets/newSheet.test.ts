import { describe, expect, it } from 'vitest';
import { newSheetFile, serializeSheet } from './format';
import { NEW_SHEET_TEXT } from './newSheet';

describe('NEW_SHEET_TEXT', () => {
  it('is the serialized new sheet (the descriptor creates sheets without loading the format)', () => {
    expect(NEW_SHEET_TEXT).toBe(serializeSheet(newSheetFile()));
  });
});
