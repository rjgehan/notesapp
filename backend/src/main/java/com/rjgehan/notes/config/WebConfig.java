package com.rjgehan.notes.config;

import java.time.Duration;
import java.util.List;

import com.rjgehan.notes.identity.IdentityArgumentResolver;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Registers the API guard on {@code /api/**}, the immutable {@code /assets/**} handler for the hashed bundles, and the
 * {@code Identity} argument resolver. Boot's default {@code /**} static handler keeps serving root files with
 * {@code no-cache}.
 */
@Configuration(proxyBeanMethods = false)
public class WebConfig implements WebMvcConfigurer {

	private final ApiGuardInterceptor apiGuard;

	private final IdentityArgumentResolver identityArgumentResolver;

	public WebConfig(ApiGuardInterceptor apiGuard, IdentityArgumentResolver identityArgumentResolver) {
		this.apiGuard = apiGuard;
		this.identityArgumentResolver = identityArgumentResolver;
	}

	@Override
	public void addInterceptors(InterceptorRegistry registry) {
		registry.addInterceptor(this.apiGuard).addPathPatterns("/api/**");
	}

	@Override
	public void addResourceHandlers(ResourceHandlerRegistry registry) {
		registry.addResourceHandler("/assets/**")
			.addResourceLocations("classpath:/static/assets/")
			.setCacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePublic().immutable());
	}

	@Override
	public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
		resolvers.add(this.identityArgumentResolver);
	}

}
