package com.rjgehan.notes.api;

import java.util.List;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.TemplateEntry;
import com.rjgehan.notes.api.dto.TemplatesResponse;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.PathNames;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/templates} (API.md §15.4): the notes under {@code settings.templates.folder}, recursively, sorted by
 * path. Templates are rendered on the client.
 */
@RestController
public class TemplateController {

	private final VaultIndex index;

	private final SettingsService settings;

	public TemplateController(VaultIndex index, SettingsService settings) {
		this.index = index;
		this.settings = settings;
	}

	@GetMapping("/api/templates")
	TemplatesResponse templates() {
		String folder = this.settings.current().templates().folder();
		String real = this.index.folderIgnoreCase(folder);
		List<TemplateEntry> templates = (real == null) ? List.of()
				: this.index.filesUnder(real)
					.stream()
					.filter((file) -> file.kind() == FileKind.NOTE)
					.map((file) -> new TemplateEntry(file.path(), PathNames.basenameOf(PathNames.nameOf(file.path()))))
					.toList();
		return new TemplatesResponse(folder, templates);
	}

}
