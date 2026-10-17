package com.rjgehan.notes.config;

import java.nio.file.Path;

import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.convert.converter.Converter;

/**
 * Binds {@code notes.*} file-system paths such as {@code notes.vault-dir} as plain paths, relative to the working
 * directory. Spring's default conversion first treats the text as a resource location, and in a web application a
 * relative location like the dev profile's {@code ../dev-vault} becomes an invalid servlet-context path.
 */
@Configuration(proxyBeanMethods = false)
public class PathBindingConfig {

	@Bean
	@ConfigurationPropertiesBinding
	static StringToPathConverter stringToPathConverter() {
		return new StringToPathConverter();
	}

	static final class StringToPathConverter implements Converter<String, Path> {

		@Override
		public Path convert(String source) {
			return Path.of(source);
		}

	}

}
