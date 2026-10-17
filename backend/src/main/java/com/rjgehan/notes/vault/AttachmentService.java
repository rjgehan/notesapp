package com.rjgehan.notes.vault;

import java.io.IOException;
import java.io.InputStream;

import com.rjgehan.notes.api.dto.AttachmentResult;
import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.api.dto.WriteResult;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.SettingsService;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * Pasted and dropped attachments (API.md §9.3): the server picks the folder from the settings and the source note,
 * sanitizes the name instead of rejecting it, de-duplicates it case-insensitively, streams the body like any raw
 * upload, and returns the link text and the embed to insert.
 */
@Service
public class AttachmentService {

	private final VaultPaths paths;

	private final NameRules nameRules;

	private final FileService files;

	private final VaultIndex index;

	private final SettingsService settings;

	public AttachmentService(VaultPaths paths, NameRules nameRules, FileService files, VaultIndex index,
			SettingsService settings) {
		this.paths = paths;
		this.nameRules = nameRules;
		this.files = files;
		this.index = index;
		this.settings = settings;
	}

	/**
	 * Stores the attachment. Without {@code source}, the folder and the link text are computed as if the source note
	 * were at the vault root.
	 */
	public AttachmentResult upload(String name, @Nullable String source, InputStream body, long contentLength,
			Identity identity, @Nullable String origin) throws IOException {
		String sourcePath = (source != null) ? this.paths.normalize(source) : "";
		FilesSettings config = this.settings.current().files();
		String folder = folderFor(config, sourcePath);
		String target = PathNames.join(folder, this.nameRules.sanitizeAttachmentName(name));
		WriteResult written = this.files
			.upload(target, FileService.UploadConflict.RENAME, body, contentLength, identity, origin)
			.result();
		FileEntry file = written.file();
		String linkText = this.index.linkText(file.path(), sourcePath, config.newLinkFormat(), LinkStyle.WIKI);
		String markdown = config.useWikilinks() ? "![[" + linkText + "]]"
				: "![](" + this.index.linkText(file.path(), sourcePath, config.newLinkFormat(), LinkStyle.MARKDOWN)
						+ ")";
		return new AttachmentResult(file, written.created(), written.createdFolders(), linkText, markdown);
	}

	/** The folder for {@code settings.files.attachmentLocation} (API.md §5); {@code ""} is the vault root. */
	static String folderFor(FilesSettings config, String sourcePath) {
		String sourceFolder = PathNames.parentOf(sourcePath);
		return switch (config.attachmentLocation()) {
			case ROOT -> "";
			case FOLDER -> config.attachmentFolder();
			case CURRENT -> sourceFolder;
			case SUBFOLDER -> PathNames.join(sourceFolder, config.attachmentSubfolder());
		};
	}

}
