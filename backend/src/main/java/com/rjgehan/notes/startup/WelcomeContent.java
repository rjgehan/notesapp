package com.rjgehan.notes.startup;

import java.io.IOException;
import java.io.InputStream;

import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/** The first-run note, {@code welcome/Welcome.md} on the classpath (DESIGN §7.8). */
@Component
public class WelcomeContent {

	static final String RESOURCE = "welcome/Welcome.md";

	/** The note's name in the vault root. */
	public static final String FILE_NAME = "Welcome.md";

	public byte[] bytes() throws IOException {
		try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
			return in.readAllBytes();
		}
	}

}
