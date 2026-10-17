package com.rjgehan.notes.api.dto;

import java.util.List;

public record TemplatesResponse(String folder, List<TemplateEntry> templates) {
}
