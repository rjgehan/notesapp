package com.rjgehan.notes.vaults;

import com.rjgehan.notes.config.NotesProperties;

import org.springframework.stereotype.Component;

/**
 * The vault this application context serves (DESIGN §5.39): the default vault in the main application, or the extra
 * vault an extra context was started for. Links the server hands out (reminder notifications) carry its URL prefix.
 */
@Component
public class CurrentVault {

	private final String name;

	private final boolean isDefault;

	public CurrentVault(NotesProperties properties) {
		this.name = properties.vaults().currentName();
		this.isDefault = properties.vaults().isDefault();
	}

	public String name() {
		return this.name;
	}

	public boolean isDefault() {
		return this.isDefault;
	}

	/** Empty for the default vault, {@code /v/<name>} otherwise; app paths such as {@code /x/tasks} follow it. */
	public String urlPrefix() {
		return VaultNames.urlPrefix(this.name, this.isDefault);
	}

	/** An app path ({@code /x/...}, {@code /n/...}) as this vault's URL. */
	public String appUrl(String path) {
		return urlPrefix() + path;
	}

}
