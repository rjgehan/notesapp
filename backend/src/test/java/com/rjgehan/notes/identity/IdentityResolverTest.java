package com.rjgehan.notes.identity;

import java.nio.file.Path;
import java.util.Map;

import com.rjgehan.notes.support.TestProperties;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class IdentityResolverTest {

	private static IdentityResolver resolver(Map<String, String> properties) {
		return new IdentityResolver(TestProperties.forVault(Path.of("vault"), properties));
	}

	@Test
	void tailscaleHeadersBecomeTheIdentity() {
		Identity identity = resolver(Map.of()).resolve("rjgehan@github", "=?utf-8?q?Ren=C3=A9?=",
				"https://avatars.example/u/1");
		assertThat(identity).isEqualTo(new Identity("rjgehan@github", "René", "https://avatars.example/u/1",
				Identity.Source.TAILSCALE));
	}

	@Test
	void emptyProfilePictureBecomesNullAndMissingNameFallsBackToLogin() {
		Identity identity = resolver(Map.of()).resolve("someone@github", null, "");
		assertThat(identity.profilePicUrl()).isNull();
		assertThat(identity.name()).isEqualTo("someone@github");
	}

	@Test
	void missingLoginIsRefusedUnlessDefaultsAreAllowed() {
		assertThat(resolver(Map.of()).resolve(null, null, null)).isNull();
		assertThat(resolver(Map.of()).resolve("  ", null, null)).isNull();
		Identity fallback = resolver(Map.of("notes.identity.allow-default", "true")).resolve(null, null, null);
		assertThat(fallback).isEqualTo(new Identity("owner@notes", "Owner", null, Identity.Source.DEFAULT));
	}

	@Test
	void loginsOutsideTheAllowlistAreRefused() {
		IdentityResolver resolver = resolver(Map.of("notes.identity.allowed-logins", "rjgehan@github"));
		assertThat(resolver.resolve("rjgehan@github", "R", null)).isNotNull();
		assertThat(resolver.resolve("RJGehan@GitHub", "R", null)).isNotNull();
		assertThat(resolver.resolve("intruder@github", "I", null)).isNull();
	}

}
