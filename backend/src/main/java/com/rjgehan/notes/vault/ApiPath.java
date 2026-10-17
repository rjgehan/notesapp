package com.rjgehan.notes.vault;

/**
 * A validated vault path: {@code nfc} is the API form, {@code disk} the repo-relative on-disk form (they differ only
 * for files whose names are NFD on disk). Everything that touches the disk or git uses {@code disk}.
 */
public record ApiPath(String nfc, String disk) {

	public static ApiPath of(String path) {
		return new ApiPath(path, path);
	}

	public String name() {
		return PathNames.nameOf(this.nfc);
	}

	/** The NFC parent folder, {@code ""} for the root. */
	public String parent() {
		return PathNames.parentOf(this.nfc);
	}

	public String lower() {
		return PathNames.lower(this.nfc);
	}

	@Override
	public String toString() {
		return this.nfc;
	}

}
