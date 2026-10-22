package com.rjgehan.notes.api.dto;

/**
 * One vault (API.md §38.1): its name, whether it is the default vault, the state of its context ({@code starting},
 * {@code ready} or {@code failed}) and the app URL it opens at ({@code /} or {@code /v/<name>/}).
 */
public record VaultInfo(String name, boolean isDefault, String state, String url) {
}
