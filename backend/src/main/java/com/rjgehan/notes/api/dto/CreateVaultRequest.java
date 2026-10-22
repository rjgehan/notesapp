package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code POST /api/vaults} (API.md §38.2). */
public record CreateVaultRequest(@Nullable String name) {
}
