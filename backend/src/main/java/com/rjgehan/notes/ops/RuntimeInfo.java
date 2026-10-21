package com.rjgehan.notes.ops;

import java.lang.management.ManagementFactory;
import java.util.function.Function;

import com.rjgehan.notes.api.dto.AotCacheState;
import com.rjgehan.notes.api.dto.StatusDetails;
import com.sun.management.HotSpotDiagnosticMXBean;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * The JVM the app runs on, for the status page: version, vendor, heap, and whether it started from the image's AOT
 * cache (DESIGN §7.1). The JVM has no API for the cache; its flags tell: {@code -XX:AOTCache} names the cache (JDK
 * 24 and later), and {@code UseSharedSpaces} stays on only when the JVM could map it, since a JVM given a cache it
 * cannot use runs without any archive.
 */
@Component
public class RuntimeInfo {

	private final AotCacheState aotCache;

	public RuntimeInfo() {
		this.aotCache = aotCacheState(RuntimeInfo::vmOption);
	}

	public StatusDetails.RuntimeStatus status() {
		Runtime runtime = Runtime.getRuntime();
		return new StatusDetails.RuntimeStatus(Runtime.version().toString(), System.getProperty("java.vendor", ""),
				this.aotCache,
				runtime.totalMemory() - runtime.freeMemory(), runtime.maxMemory(), runtime.availableProcessors());
	}

	/** The state from two VM flags; {@code option} returns a flag's value, or null when the JVM has no such flag. */
	static AotCacheState aotCacheState(Function<String, @Nullable String> option) {
		String cache = option.apply("AOTCache");
		if (cache == null || cache.isEmpty()) {
			return AotCacheState.OFF;
		}
		String shared = option.apply("UseSharedSpaces");
		if (shared == null) {
			return AotCacheState.UNKNOWN;
		}
		return Boolean.parseBoolean(shared) ? AotCacheState.IN_USE : AotCacheState.NOT_USED;
	}

	private static @Nullable String vmOption(String name) {
		try {
			HotSpotDiagnosticMXBean bean = ManagementFactory.getPlatformMXBean(HotSpotDiagnosticMXBean.class);
			return (bean != null) ? bean.getVMOption(name).getValue() : null;
		}
		catch (IllegalArgumentException | UnsupportedOperationException ex) {
			return null;
		}
	}

}
