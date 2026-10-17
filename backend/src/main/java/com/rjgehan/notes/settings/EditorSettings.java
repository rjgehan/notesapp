package com.rjgehan.notes.settings;

/** {@code settings.editor}: UI preferences that apply on every device. */
public record EditorSettings(EditorMode defaultMode, boolean readableLineLength, boolean strictLineBreaks) {
}
