package com.rjgehan.notes.vaults;

import com.rjgehan.notes.NotesappApplication;

import org.springframework.boot.autoconfigure.AutoConfigurationExcludeFilter;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.TypeExcludeFilter;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * The source of an extra vault's application context (DESIGN §5.39): the same components and auto-configuration as
 * {@link NotesappApplication}, without the {@link ServerWide} beans. Deliberately not a {@code @Configuration}, so the
 * main application's component scan never picks it up.
 */
@EnableAutoConfiguration
@ComponentScan(basePackageClasses = NotesappApplication.class,
		excludeFilters = { @ComponentScan.Filter(type = FilterType.ANNOTATION, classes = ServerWide.class),
				@ComponentScan.Filter(type = FilterType.CUSTOM, classes = TypeExcludeFilter.class),
				@ComponentScan.Filter(type = FilterType.CUSTOM, classes = AutoConfigurationExcludeFilter.class) })
@ConfigurationPropertiesScan(basePackageClasses = NotesappApplication.class)
@EnableScheduling
final class VaultApplication {

	private VaultApplication() {
	}

}
