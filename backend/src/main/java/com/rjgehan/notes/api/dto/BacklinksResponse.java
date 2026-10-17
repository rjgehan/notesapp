package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/** {@code unlinked} is null unless it was asked for. */
public record BacklinksResponse(String path, List<BacklinkGroup> linked, @Nullable List<BacklinkGroup> unlinked) {
}
