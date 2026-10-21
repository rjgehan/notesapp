package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** A file changed by a commit or over a period (API.md §14.6). {@code renamedFrom} is set for a rename. */
public record TimelineFile(String path, ChangeType change, @Nullable String renamedFrom) {
}
