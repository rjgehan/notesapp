package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code StatusDetails.runtime.aotCache} (API.md §6.5): the JVM's AOT cache (JEP 483), as the JVM reports it. */
public enum AotCacheState {

	/** The JVM was started with {@code -XX:AOTCache} and uses it. */
	@JsonProperty("in-use") IN_USE,

	/** The JVM was started with {@code -XX:AOTCache} but could not use it (missing, or made by another JVM). */
	@JsonProperty("not-used") NOT_USED,

	/** No AOT cache was given (outside the image, or a JVM older than 25). */
	@JsonProperty("off") OFF,

	/** The JVM does not say. */
	@JsonProperty("unknown") UNKNOWN

}
