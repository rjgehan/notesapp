package com.rjgehan.notes.identity;

import java.util.List;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * Reads the {@code Tailscale-User-*} headers set by {@code tailscale serve} and applies the identity allowlist
 * (DESIGN §5.13). Without a login, the configured default identity is used only when {@code allow-default} is on (the
 * dev profile).
 */
@Component
public class IdentityResolver {

	public static final String LOGIN_HEADER = "Tailscale-User-Login";

	public static final String NAME_HEADER = "Tailscale-User-Name";

	public static final String PICTURE_HEADER = "Tailscale-User-Profile-Pic";

	private final NotesProperties.Identity properties;

	public IdentityResolver(NotesProperties properties) {
		this.properties = properties.identity();
	}

	/** The admitted identity, or null when the request must be refused with {@code 403 identity-not-allowed}. */
	public @Nullable Identity resolve(HttpServletRequest request) {
		return resolve(request.getHeader(LOGIN_HEADER), request.getHeader(NAME_HEADER),
				request.getHeader(PICTURE_HEADER));
	}

	public @Nullable Identity resolve(@Nullable String login, @Nullable String name, @Nullable String picture) {
		String trimmedLogin = (login != null) ? login.strip() : "";
		if (trimmedLogin.isEmpty()) {
			if (!this.properties.allowDefault()) {
				return null;
			}
			return new Identity(this.properties.defaultLogin(), this.properties.defaultName(), null,
					Identity.Source.DEFAULT);
		}
		List<String> allowed = this.properties.allowedLogins();
		if (!allowed.isEmpty() && allowed.stream().noneMatch((entry) -> entry.strip().equalsIgnoreCase(trimmedLogin))) {
			return null;
		}
		String decodedName = (name != null) ? Rfc2047.decode(name).strip() : "";
		String pictureUrl = (picture != null && !picture.isBlank()) ? picture.strip() : null;
		return new Identity(trimmedLogin, decodedName.isEmpty() ? trimmedLogin : decodedName, pictureUrl,
				Identity.Source.TAILSCALE);
	}

}
