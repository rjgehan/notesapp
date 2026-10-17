package com.rjgehan.notes.api.dto;

import java.util.List;

import jakarta.validation.constraints.NotNull;

import org.jspecify.annotations.Nullable;

/** Each target is the target part of a link only, without subpath or display. */
public record ResolveRequest(@NotNull String source, @NotNull List<@Nullable String> targets) {
}
