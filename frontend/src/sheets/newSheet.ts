// A new spreadsheet's text (DESIGN §6.21): `serializeSheet(newSheetFile())`, written out so the
// always-loaded descriptor (views/sheet/register.ts) creates spreadsheets without the format's
// code (newSheet.test.ts keeps the two equal).
export const NEW_SHEET_TEXT = `{
  "type": "notesapp-sheet",
  "version": 1,
  "engine": "hyperformula@3.4.0",
  "sheets": [
    {
      "id": "s1",
      "name": "Sheet1",
      "cells": {},
      "cols": {},
      "rows": {},
      "frozen": { "rows": 0, "cols": 0 }
    }
  ],
  "named": {}
}
`;
