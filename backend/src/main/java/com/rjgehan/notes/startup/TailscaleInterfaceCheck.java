package com.rjgehan.notes.startup;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Collections;
import java.util.List;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;

/**
 * Refuses to start when no kernel-mode Tailscale interface is visible (DESIGN §5.13). Userspace tailscaled forwards
 * every tailnet port to loopback, which would expose port 8080 and forgeable identity headers; kernel mode creates a
 * {@code tailscale*} interface or an address in {@code 100.64.0.0/10}.
 */
@Component
public class TailscaleInterfaceCheck {

	private static final Logger logger = LoggerFactory.getLogger(TailscaleInterfaceCheck.class);

	private final NotesProperties.Security security;

	public TailscaleInterfaceCheck(NotesProperties properties) {
		this.security = properties.security();
	}

	public void check() {
		if (!this.security.requireTailscaleInterface()) {
			return;
		}
		String found = findTailscaleInterface();
		if (found != null) {
			logger.info("Kernel-mode Tailscale interface found: {}", found);
			return;
		}
		if (this.security.allowUserspaceTailscale()) {
			logger.warn("No kernel-mode Tailscale interface is visible; continuing because "
					+ "notes.security.allow-userspace-tailscale=true");
			return;
		}
		logger.error("No kernel-mode Tailscale interface is visible (TS_USERSPACE must be false). Refusing to start, "
				+ "because userspace mode would expose port 8080 to every tailnet peer.");
		throw new IllegalStateException("No kernel-mode Tailscale interface found");
	}

	private static @Nullable String findTailscaleInterface() {
		List<NetworkInterface> interfaces;
		try {
			interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
		}
		catch (SocketException ex) {
			return null;
		}
		for (NetworkInterface candidate : interfaces) {
			if (candidate.getName().startsWith("tailscale")) {
				return candidate.getName();
			}
			for (InetAddress address : Collections.list(candidate.getInetAddresses())) {
				if (isCgnat(address)) {
					return candidate.getName() + " (" + address.getHostAddress() + ")";
				}
			}
		}
		return null;
	}

	/** True for addresses in Tailscale's range, 100.64.0.0/10. */
	static boolean isCgnat(InetAddress address) {
		if (!(address instanceof Inet4Address)) {
			return false;
		}
		byte[] bytes = address.getAddress();
		return (bytes[0] & 0xFF) == 100 && (bytes[1] & 0xC0) == 64;
	}

}
