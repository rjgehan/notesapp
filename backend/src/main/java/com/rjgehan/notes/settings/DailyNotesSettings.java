package com.rjgehan.notes.settings;

/** {@code settings.dailyNotes}; the daily note itself is computed in the browser (DESIGN §5.11). */
public record DailyNotesSettings(String format, String folder, String template, boolean openOnStartup) {
}
