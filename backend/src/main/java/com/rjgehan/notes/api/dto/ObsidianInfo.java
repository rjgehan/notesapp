package com.rjgehan.notes.api.dto;

import java.util.List;

/**
 * What NotesApp found in the vault's {@code .obsidian/} folder: whether it exists, the configuration files it read,
 * and the ones it could not read (never anything else; the folder is never written).
 */
public record ObsidianInfo(boolean found, List<String> configFiles, List<String> problems) {

	public ObsidianInfo {
		configFiles = List.copyOf(configFiles);
		problems = List.copyOf(problems);
	}

}
