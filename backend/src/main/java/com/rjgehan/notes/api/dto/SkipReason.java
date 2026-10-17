package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum SkipReason {

	/** The on-disk name contains {@code \} or a control character. */
	@JsonProperty("unsafe-name") UNSAFE_NAME,

	/** Another on-disk name normalizes to the same NFC path. */
	@JsonProperty("nfc-shadowed") NFC_SHADOWED

}
