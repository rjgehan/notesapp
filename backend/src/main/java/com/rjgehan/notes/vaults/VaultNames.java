package com.rjgehan.notes.vaults;

import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

/**
 * Vault names (API.md §41): 1 to 32 lowercase letters, digits and dashes, starting and ending with a letter or digit.
 * A name is a folder under {@code notes.vaults.dir} and a URL segment ({@code /v/<name>/}), so it never needs
 * escaping, cannot be {@code .} or {@code ..}, and cannot differ from another only by case.
 */
public final class VaultNames {

	public static final int MAX_LENGTH = 32;

	private static final Pattern NAME = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?");

	private VaultNames() {
	}

	public static boolean isValid(@Nullable String name) {
		return name != null && NAME.matcher(name).matches();
	}

	/** The app's URL prefix of a vault: empty for the default vault, {@code /v/<name>} otherwise. */
	public static String urlPrefix(String name, boolean isDefault) {
		return isDefault ? "" : "/v/" + name;
	}

}
