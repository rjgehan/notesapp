package com.rjgehan.notes.api.dto;

import java.util.Map;

/** Keys are the targets exactly as sent. */
public record ResolveResponse(Map<String, ResolvedLink> resolved) {
}
