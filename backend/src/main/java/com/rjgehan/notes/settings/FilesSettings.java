package com.rjgehan.notes.settings;

import java.util.List;

import com.rjgehan.notes.vault.PathNames;

/** {@code settings.files} (API.md §5). */
public record FilesSettings(NewNoteLocation newNoteLocation, String newNoteFolder, LinkFormat newLinkFormat,
		boolean useWikilinks, AttachmentLocation attachmentLocation, String attachmentFolder,
		String attachmentSubfolder, boolean autoUpdateLinks, List<String> excludedPaths) {

	public FilesSettings {
		excludedPaths = List.copyOf(excludedPaths);
	}

	/**
	 * True when {@code path} matches one of {@code excludedPaths} (API.md §5, §12.1), compared case-insensitively: an
	 * entry is a file path, which excludes that file, or a folder path, which excludes everything under it. Prefixes
	 * end at a segment boundary, so {@code Archive} excludes {@code Archive/Old.md} but not {@code Archived.md}.
	 * Excluded notes never appear in search results or unlinked mentions.
	 */
	public boolean isExcluded(String path) {
		if (this.excludedPaths.isEmpty()) {
			return false;
		}
		String lower = PathNames.lower(path);
		for (String excluded : this.excludedPaths) {
			String prefix = PathNames.lower(excluded);
			while (prefix.endsWith("/")) {
				prefix = prefix.substring(0, prefix.length() - 1);
			}
			if (!prefix.isEmpty() && (lower.equals(prefix) || lower.startsWith(prefix + "/"))) {
				return true;
			}
		}
		return false;
	}

}
