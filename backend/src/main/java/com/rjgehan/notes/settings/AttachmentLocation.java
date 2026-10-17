package com.rjgehan.notes.settings;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code settings.files.attachmentLocation}: where pasted and dropped attachments go (API.md §5). */
public enum AttachmentLocation {

	@JsonProperty("root") ROOT,
	@JsonProperty("folder") FOLDER,
	@JsonProperty("current") CURRENT,
	@JsonProperty("subfolder") SUBFOLDER

}
