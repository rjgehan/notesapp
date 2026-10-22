package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code GET /api/vaults} (API.md §41.1): every vault, the default one first; {@code canCreate} as configured. */
public record VaultsResponse(List<VaultInfo> vaults, boolean canCreate) {
}
