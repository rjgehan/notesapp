package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/** Reordering lists or sections: {@code ids}, in this order, right after {@code after} (null: first). */
public record ReorderRequest(@Nullable List<String> ids, @Nullable String after) {
}
