package com.rjgehan.notes.api.dto;

import com.rjgehan.notes.settings.Settings;

/** {@code GET /api/settings}: {@code readOnly} when the file was written by a newer build or fails validation. */
public record SettingsResponse(Settings settings, String version, boolean readOnly) {
}
